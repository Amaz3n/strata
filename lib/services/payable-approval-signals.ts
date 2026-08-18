import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"

import {
  billScheduleFingerprint,
  crosscheckBillAgainstSchedule,
  readBillScheduleAssessment,
  type BillScheduleAssessment,
  type ScheduleWindowForCostCode,
} from "@/lib/financials/bill-schedule-crosscheck"
import {
  comparableSampleSize,
  evaluateEvenFlowCostCode,
  evenFlowFingerprint,
  EVEN_FLOW_MIN_SAMPLE,
  readEvenFlowAssessment,
  type EvenFlowComparableCost,
  type EvenFlowCostCodeClaim,
  type EvenFlowPriceAssessment,
} from "@/lib/financials/even-flow-price-anomaly"
import { getProjectPosture, isProductionProjectPosture } from "@/lib/product-tier"
import { requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * Two approval-time signals that Arc can produce and a stack of disconnected
 * tools cannot, because Arc holds the bill, the cost code, the lot, the plan and
 * the schedule on one record:
 *
 *   1. EVEN-FLOW PRICE ANOMALY — what this lot is billed for a trade against
 *      what every other lot of the same house plan was billed for it.
 *   2. BILL VS SCHEDULE — whether the work the invoice bills for is on the
 *      calendar yet.
 *
 * Both are CHECKABLE CLAIMS for a human approver: a statement with the
 * arithmetic printed beside it. Neither changes a bill's status, blocks a
 * payment, or creates a hold — this module writes nothing but its own cached
 * assessment onto the bill's metadata.
 *
 * WHEN THIS RUNS: on demand, for the one payable an approver has open, from
 * `assessSelectedPayableSignalsAction`. That is far cheaper than computing at
 * approval-review load, which would fan these queries out across every bill in
 * a queue that is routinely hundreds long to serve claims for the one bill
 * anybody actually reads. Re-running is nearly free: an unchanged bill against
 * unchanged comparables short-circuits on the stored fingerprints.
 */

/** Hard bounds. Nothing here scans unbounded history. */
const BILL_LINE_LIMIT = 200
/** Cost codes on one bill worth comparing. Beyond this the bill is a summary, not a trade cost. */
const COST_CODE_LIMIT = 20
/**
 * Sibling lots of the same plan read for comparables, per scope. The community
 * and the org-wide plan are read separately so a plan used across six
 * communities cannot crowd this lot's own community out of the sample. A median
 * over this many lots is already far past the point of diminishing returns —
 * the cap bounds the query, and every claim states the sample it actually used.
 */
const COMPARABLE_LOT_LIMIT = 120
/** Ceiling on the combined comparable set, which bounds the `in` filter below. */
const COMPARABLE_PROJECT_LIMIT = 200
/** Job-cost rows read across those lots. */
const COMPARABLE_ENTRY_LIMIT = 5_000
const SCHEDULE_ITEM_LIMIT = 500

export interface PayableApprovalSignals {
  evenFlow: EvenFlowPriceAssessment | null
  schedule: BillScheduleAssessment | null
}

export interface PayableApprovalSignalsResult extends PayableApprovalSignals {
  /** False when both fingerprints matched and the stored assessments were reused. */
  recomputed: boolean
  /**
   * The payable's `updated_at` after this assessment. Caching the signals is a
   * write, so it moves the optimistic-concurrency token an open workspace is
   * holding; returning it lets the client re-sync instead of failing the next
   * save with a conflict it did not cause.
   */
  updatedAt: string | null
}

interface SubjectCost {
  costCodeId: string
  costCodeLabel: string
  amountCents: number
}

interface BillLineRow {
  cost_code_id: string | null
  quantity: number | null
  unit_cost_cents: number | null
  project_id: string | null
  cost_code: { code: string | null; name: string | null } | null
}

interface JobCostEntryRow {
  project_id: string | null
  cost_code_id: string | null
  cost_cents: number | null
}

interface ScheduleItemRow {
  id: string
  name: string | null
  start_date: string | null
  cost_code_id: string | null
}

function costCodeLabel(costCode: { code: string | null; name: string | null } | null): string {
  const code = costCode?.code?.trim()
  const name = costCode?.name?.trim()
  if (code && name) return `${code} ${name}`
  return name || code || "Uncoded"
}

/**
 * This bill's cost per cost code, for this bill's own project. Lines allocated
 * away to another project belong to that project's lot, not this one.
 */
function subjectCostsByCostCode(rows: BillLineRow[], billProjectId: string): SubjectCost[] {
  const byCostCode = new Map<string, SubjectCost>()
  for (const row of rows) {
    if (!row.cost_code_id) continue
    if ((row.project_id ?? billProjectId) !== billProjectId) continue
    const amountCents = Math.round(Number(row.unit_cost_cents ?? 0) * Number(row.quantity ?? 1))
    const existing = byCostCode.get(row.cost_code_id)
    if (existing) {
      existing.amountCents += amountCents
    } else {
      byCostCode.set(row.cost_code_id, {
        costCodeId: row.cost_code_id,
        costCodeLabel: costCodeLabel(row.cost_code),
        amountCents,
      })
    }
  }
  return Array.from(byCostCode.values()).slice(0, COST_CODE_LIMIT)
}

interface EvenFlowInputs {
  housePlanId: string
  housePlanLabel: string
  communityLabel: string
  comparableLotCount: number
  /** Every comparable data point, tagged with the lot's community for scoping. */
  comparables: Array<EvenFlowComparableCost & { costCodeId: string; sameCommunity: boolean }>
}

/**
 * Load the comparable lots for this bill's plan and their costs for the cost
 * codes on this bill. Returns null when the data model does not support the
 * comparison at all — a custom home with no lot, or a lot with no plan.
 */
async function loadEvenFlowInputs(
  supabase: SupabaseClient,
  orgId: string,
  projectId: string,
  costCodeIds: string[],
): Promise<EvenFlowInputs | null> {
  const { data: lotRow } = await supabase
    .from("lots")
    .select("id, community_id, house_plan_id")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .maybeSingle()

  const housePlanId = typeof lotRow?.house_plan_id === "string" ? lotRow.house_plan_id : null
  // No lot, or a lot with no plan: there is no repeated build to compare
  // against, so there is nothing to say.
  if (!lotRow || !housePlanId) return null
  const communityId = typeof lotRow.community_id === "string" ? lotRow.community_id : null

  const siblingLotQuery = () =>
    supabase
      .from("lots")
      .select("project_id, community_id")
      .eq("org_id", orgId)
      .eq("house_plan_id", housePlanId)
      .neq("project_id", projectId)
      .not("project_id", "is", null)
      .limit(COMPARABLE_LOT_LIMIT)

  const [{ data: planRow }, { data: communityRow }, { data: communityLotRows }, { data: planLotRows }] =
    await Promise.all([
      supabase.from("house_plans").select("code, name").eq("org_id", orgId).eq("id", housePlanId).maybeSingle(),
      communityId
        ? supabase.from("communities").select("name").eq("org_id", orgId).eq("id", communityId).maybeSingle()
        : Promise.resolve({ data: null }),
      // This lot's own community first, as its own bounded read, so the tighter
      // baseline is never lost to a plan that is built in six communities.
      communityId ? siblingLotQuery().eq("community_id", communityId) : Promise.resolve({ data: [] }),
      siblingLotQuery(),
    ])

  const communityByProjectId = new Map<string, string | null>()
  for (const rows of [communityLotRows, planLotRows]) {
    for (const sibling of (rows ?? []) as Array<{ project_id: string | null; community_id: string | null }>) {
      if (!sibling.project_id) continue
      if (communityByProjectId.size >= COMPARABLE_PROJECT_LIMIT && !communityByProjectId.has(sibling.project_id)) continue
      communityByProjectId.set(sibling.project_id, sibling.community_id)
    }
  }
  const comparableProjectIds = Array.from(communityByProjectId.keys())
  if (comparableProjectIds.length === 0) return null

  // The unified actuals ledger, restricted to vendor-bill lines so the baseline
  // is what vendors actually billed for this trade — like for like with the
  // payable being approved.
  const { data: entryRows } = await supabase
    .from("job_cost_entries")
    .select("project_id, cost_code_id, cost_cents")
    .eq("org_id", orgId)
    .eq("source_type", "vendor_bill_line")
    .neq("status", "voided")
    .in("project_id", comparableProjectIds)
    .in("cost_code_id", costCodeIds)
    .limit(COMPARABLE_ENTRY_LIMIT)

  const planCode = typeof planRow?.code === "string" ? planRow.code.trim() : ""
  const planName = typeof planRow?.name === "string" ? planRow.name.trim() : ""
  const communityName = typeof communityRow?.name === "string" ? communityRow.name.trim() : ""

  return {
    housePlanId,
    housePlanLabel: planCode ? `Plan ${planCode}` : planName || "this plan",
    communityLabel: communityName || "this community",
    comparableLotCount: comparableProjectIds.length,
    comparables: ((entryRows ?? []) as JobCostEntryRow[]).flatMap((row) => {
      if (!row.project_id || !row.cost_code_id) return []
      return [
        {
          projectId: row.project_id,
          costCodeId: row.cost_code_id,
          amountCents: Math.round(Number(row.cost_cents ?? 0)),
          sameCommunity: communityId !== null && communityByProjectId.get(row.project_id) === communityId,
        },
      ]
    }),
  }
}

/**
 * Claims per cost code, preferring the tighter baseline. Same community first —
 * the same subs, the same season, the same site conditions — and only when that
 * sample is too thin does it widen to the plan across the whole org.
 */
function buildEvenFlowClaims(inputs: EvenFlowInputs, subjectCosts: SubjectCost[]): EvenFlowCostCodeClaim[] {
  const claims: EvenFlowCostCodeClaim[] = []
  for (const subject of subjectCosts) {
    const forCostCode = inputs.comparables.filter((comparable) => comparable.costCodeId === subject.costCodeId)
    const withinCommunity = forCostCode.filter((comparable) => comparable.sameCommunity)
    const useCommunity = comparableSampleSize(withinCommunity) >= EVEN_FLOW_MIN_SAMPLE

    const claim = evaluateEvenFlowCostCode({
      costCodeId: subject.costCodeId,
      costCodeLabel: subject.costCodeLabel,
      subjectAmountCents: subject.amountCents,
      comparables: useCommunity ? withinCommunity : forCostCode,
      scope: useCommunity ? "community" : "plan",
      scopeLabel: useCommunity ? inputs.communityLabel : "every community",
      housePlanLabel: inputs.housePlanLabel,
    })
    if (claim) claims.push(claim)
  }
  return claims
}

/**
 * Schedule windows for the cost codes on this bill.
 *
 * `schedule_items.cost_code_id` is the only modelled link between the schedule
 * and money in this schema — `trade` and `phase` are free text with no key, and
 * guessing across them would produce confident nonsense. Projects whose
 * schedule carries no cost codes simply return nothing.
 */
async function loadScheduleWindows(
  supabase: SupabaseClient,
  orgId: string,
  projectId: string,
  subjectCosts: SubjectCost[],
): Promise<ScheduleWindowForCostCode[]> {
  const labelByCostCodeId = new Map(subjectCosts.map((cost) => [cost.costCodeId, cost.costCodeLabel]))
  const { data: itemRows } = await supabase
    .from("schedule_items")
    .select("id, name, start_date, cost_code_id")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .in("cost_code_id", Array.from(labelByCostCodeId.keys()))
    .not("start_date", "is", null)
    .order("start_date", { ascending: true })
    .limit(SCHEDULE_ITEM_LIMIT)

  return ((itemRows ?? []) as ScheduleItemRow[]).flatMap((row) => {
    if (!row.cost_code_id || !row.start_date) return []
    return [
      {
        costCodeId: row.cost_code_id,
        costCodeLabel: labelByCostCodeId.get(row.cost_code_id) ?? "This trade",
        scheduleItemId: row.id,
        scheduleItemName: row.name?.trim() || labelByCostCodeId.get(row.cost_code_id) || "this work",
        startDate: row.start_date,
      },
    ]
  })
}

/**
 * Compute both approval-time signals for one payable and cache them onto the
 * bill's metadata. Nothing else about the bill is touched.
 */
export async function assessPayableApprovalSignals(
  billId: string,
  options: { force?: boolean; orgId?: string } = {},
): Promise<PayableApprovalSignalsResult> {
  const context = await requireOrgContext(options.orgId)
  const supabase = createServiceSupabaseClient()

  const { data: billRow, error: billError } = await supabase
    .from("vendor_bills")
    .select("id, project_id, bill_date, metadata, updated_at, project:projects(property_type)")
    .eq("org_id", context.orgId)
    .eq("id", billId)
    .maybeSingle()
  if (billError) throw new Error(`Unable to load the payable: ${billError.message}`)
  if (!billRow) throw new Error("Payable not found")

  const projectId = typeof billRow.project_id === "string" ? billRow.project_id : null
  if (!projectId) return { evenFlow: null, schedule: null, recomputed: false, updatedAt: billRow.updated_at }

  await requireAuthorization({
    permission: "bill.read",
    userId: context.userId,
    orgId: context.orgId,
    projectId,
    supabase,
    resourceType: "vendor_bill",
    resourceId: billId,
  })

  const existingMetadata = (billRow.metadata ?? {}) as Record<string, unknown>
  const storedEvenFlow = readEvenFlowAssessment(existingMetadata)
  const storedSchedule = readBillScheduleAssessment(existingMetadata)

  const { data: lineRows } = await supabase
    .from("bill_lines")
    .select("cost_code_id, quantity, unit_cost_cents, project_id, cost_code:cost_codes(code, name)")
    .eq("org_id", context.orgId)
    .eq("bill_id", billId)
    .order("sort_order", { ascending: true })
    .limit(BILL_LINE_LIMIT)

  const subjectCosts = subjectCostsByCostCode((lineRows ?? []) as unknown as BillLineRow[], projectId)
  // An uncoded bill has nothing to compare and nothing to place on a calendar.
  if (subjectCosts.length === 0) return { evenFlow: null, schedule: null, recomputed: false, updatedAt: billRow.updated_at }

  const costCodeIds = subjectCosts.map((cost) => cost.costCodeId)
  const posture = getProjectPosture(
    (billRow.project as { property_type?: string | null } | null)?.property_type ?? null,
    context.productTier,
  )
  const billDate = typeof billRow.bill_date === "string" ? billRow.bill_date : null

  const [evenFlowInputs, scheduleWindows] = await Promise.all([
    // Even-flow only means anything where a plan is repeated across lots, which
    // is the production posture. Routed through the posture choke point so a
    // mixed org's custom homes are never asked the question.
    isProductionProjectPosture(posture)
      ? loadEvenFlowInputs(supabase, context.orgId, projectId, costCodeIds)
      : Promise.resolve(null),
    billDate ? loadScheduleWindows(supabase, context.orgId, projectId, subjectCosts) : Promise.resolve([]),
  ])

  const now = new Date().toISOString()

  let evenFlow: EvenFlowPriceAssessment | null = null
  if (evenFlowInputs) {
    const fingerprint = evenFlowFingerprint({
      housePlanId: evenFlowInputs.housePlanId,
      subjectCosts,
      comparables: evenFlowInputs.comparables,
    })
    evenFlow =
      !options.force && storedEvenFlow?.fingerprint === fingerprint
        ? storedEvenFlow
        : {
            version: 1,
            fingerprint,
            assessedAt: now,
            housePlanLabel: evenFlowInputs.housePlanLabel,
            comparableLotCount: evenFlowInputs.comparableLotCount,
            claims: buildEvenFlowClaims(evenFlowInputs, subjectCosts),
          }
  }

  let schedule: BillScheduleAssessment | null = null
  if (billDate && scheduleWindows.length > 0) {
    const fingerprint = billScheduleFingerprint({ billDate, windows: scheduleWindows })
    schedule =
      !options.force && storedSchedule?.fingerprint === fingerprint
        ? storedSchedule
        : {
            version: 1,
            fingerprint,
            assessedAt: now,
            billDate,
            checkedCostCodeCount: new Set(scheduleWindows.map((window) => window.costCodeId)).size,
            findings: crosscheckBillAgainstSchedule({ billDate, windows: scheduleWindows }),
          }
  }

  const unchanged = evenFlow === storedEvenFlow && schedule === storedSchedule
  if (unchanged) return { evenFlow, schedule, recomputed: false, updatedAt: billRow.updated_at }

  // Rebuild the metadata explicitly so an assessment that no longer applies —
  // a project retyped away from production, a schedule that lost its coding —
  // is cleared rather than left behind to be rendered as current.
  const nextMetadata: Record<string, unknown> = { ...existingMetadata }
  if (evenFlow) nextMetadata.even_flow_price = evenFlow
  else delete nextMetadata.even_flow_price
  if (schedule) nextMetadata.bill_schedule = schedule
  else delete nextMetadata.bill_schedule

  // Guarded on the token this assessment was computed against. `metadata` is a
  // whole-object write, so an unguarded update would clobber a coding or
  // approval edit that landed while these comparables were being read — and
  // this is a cache, not a decision, so losing the race means recomputing on
  // the next open rather than overwriting somebody's work.
  const { data: written, error: updateError } = await supabase
    .from("vendor_bills")
    .update({ metadata: nextMetadata })
    .eq("org_id", context.orgId)
    .eq("id", billId)
    .eq("updated_at", billRow.updated_at)
    .select("updated_at")
    .maybeSingle()
  if (updateError) throw new Error(`Unable to record the approval signals: ${updateError.message}`)
  if (!written) return { evenFlow, schedule, recomputed: true, updatedAt: null }

  await recordEvent({
    orgId: context.orgId,
    eventType: "payable_approval_signals_assessed",
    entityType: "vendor_bill",
    entityId: billId,
    payload: {
      project_id: projectId,
      posture,
      cost_code_count: subjectCosts.length,
      even_flow_claim_count: evenFlow?.claims.length ?? 0,
      even_flow_comparable_lots: evenFlow?.comparableLotCount ?? 0,
      schedule_finding_count: schedule?.findings.length ?? 0,
      schedule_checked_cost_codes: schedule?.checkedCostCodeCount ?? 0,
    },
  })

  return { evenFlow, schedule, recomputed: true, updatedAt: written.updated_at }
}
