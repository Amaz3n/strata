import "server-only"

import { cache } from "react"

import {
  buildWeek,
  rankDecisions,
  scoreProjects,
  type ControlTowerRollup,
  type RankedDecision,
  type ScoredProject,
  type WeekAhead,
} from "@/lib/control-tower/model"
import { getComplianceHeldPayablesByCompanyWithClient } from "@/lib/services/compliance-documents"
import { requireOrgContext } from "@/lib/services/context"
import { getDivisionScopedProjectIds } from "@/lib/services/authorization"
import { hasAnyPermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * The custom-builder control tower, in one database round trip.
 *
 * `control_tower_rollup` answers the whole desk — every active job's position,
 * the org money rollup, the decision candidates and the week's field plan — so
 * this service resolves scope, calls it once, and hands the payload to the pure
 * ranking in `lib/control-tower/model.ts`. It replaces roughly thirty
 * PostgREST calls arranged four deep, where nothing painted until the slowest
 * chain finished.
 *
 * Two reads travel beside it, both genuinely separate questions:
 * vendor-compliance review pressure (org-wide, not per project) and, only when
 * the week actually contains a double-booked person, that person's name.
 */

/** Rows past this stop being a scannable portfolio and start being a report. */
export const PORTFOLIO_ROW_CAP = 40

export interface ComplianceLoad {
  /** Certificates waiting on a decision, org-wide. */
  reviews: number
  /** Payables the compliance hold is provably stopping. */
  heldCents: number
  /** True when the scan hit a cap, so `heldCents` is a floor, not a total. */
  heldTruncated: boolean
}

export interface ControlTowerDesk {
  today: string
  /** Money is composed away for roles that cannot read it, never zeroed. */
  money: {
    outstandingArCents: number
    overdueArCents: number
    collectedRatio: number
    arAging: ControlTowerRollup["money"]["invoice_rollup"]["ar_aging"]
    unpaidBillsCents: number
    unpaidBillsCount: number
    pendingBillsCents: number
    pendingBillsCount: number
    readyToBillCents: number
    readyToBillProjects: number
    overdueInvoices: ControlTowerRollup["overdue_invoices"]
    wip: ControlTowerRollup["wip"]
  } | null
  counts: ControlTowerRollup["counts"]
  projectsByStatus: Record<string, number>
  /** Every active job, worst first. Capped for render; `projectTotal` is the truth. */
  projects: ScoredProject[]
  projectTotal: number
  decisions: RankedDecision[]
  decisionTotal: number
  week: WeekAhead
  compliance: ComplianceLoad | null
}

const MONEY_PERMISSIONS = ["invoice.read", "bill.read", "budget.read", "report.read"]

export const getControlTowerDesk = cache(async (orgId?: string): Promise<ControlTowerDesk> => {
  const context = await requireOrgContext(orgId)
  const { orgId: resolvedOrgId, userId } = context

  // A division-scoped membership sees its divisions' jobs and no others. `null`
  // is "the whole org" and is what an unscoped role gets — the rollup treats
  // the two differently, so this must never be flattened to an empty list.
  const [scopedProjectIds, canSeeMoney] = await Promise.all([
    getDivisionScopedProjectIds({ orgId: resolvedOrgId, userId }),
    hasAnyPermission(MONEY_PERMISSIONS, context).catch(() => false),
  ])

  const service = createServiceSupabaseClient()
  const [rollupResult, compliance] = await Promise.all([
    service.rpc("control_tower_rollup", {
      p_org_id: resolvedOrgId,
      p_project_ids: scopedProjectIds,
      p_today: localDateKey(new Date()),
      p_window_days: 7,
    }),
    canSeeMoney ? loadComplianceLoad(context) : Promise.resolve(null),
  ])

  // The desk is a set of aggregates about money and schedule. A failed read is
  // not a zero, and a control tower confidently reporting "nothing is wrong"
  // over a query that never ran is the one failure mode worth crashing for.
  if (rollupResult.error) {
    throw new Error(`Failed to load the control tower: ${rollupResult.error.message}`)
  }
  const rollup = rollupResult.data as ControlTowerRollup | null
  if (!rollup) throw new Error("The control tower rollup returned no payload.")

  const scored = scoreProjects(rollup.projects).sort(
    (a, b) => b.health.score - a.health.score || a.name.localeCompare(b.name),
  )

  const week = buildWeek(rollup, await resolveAssigneeNames(rollup))
  const invoices = rollup.money.invoice_rollup

  return {
    today: rollup.today,
    money: canSeeMoney
      ? {
          outstandingArCents: Math.max(0, invoices.total_invoiced - invoices.total_collected),
          overdueArCents: invoices.total_overdue,
          collectedRatio:
            invoices.total_invoiced > 0 ? invoices.total_collected / invoices.total_invoiced : 0,
          arAging: invoices.ar_aging,
          unpaidBillsCents: rollup.money.unpaid_bills_cents,
          unpaidBillsCount: rollup.money.unpaid_bills_count,
          pendingBillsCents: rollup.money.pending_bills_cents,
          pendingBillsCount: rollup.money.pending_bills_count,
          readyToBillCents: rollup.money.ready_to_bill_cents,
          readyToBillProjects: rollup.money.ready_to_bill_projects,
          overdueInvoices: rollup.overdue_invoices,
          wip: rollup.wip,
        }
      : null,
    counts: rollup.counts,
    projectsByStatus: rollup.projects_by_status,
    projects: scored.slice(0, PORTFOLIO_ROW_CAP),
    projectTotal: scored.length,
    decisions: rankDecisions(rollup.decisions, rollup.today),
    decisionTotal: rollup.decisions.length,
    week,
    compliance,
  }
})

/**
 * Vendor compliance, as money rather than as a document count.
 *
 * An unreviewed certificate reads to the payment gate exactly like a
 * non-compliant vendor, so these belong with the other blockers. The held
 * figure comes from the same scan the review queue ranks by — the desk and the
 * queue it links to cannot be allowed to state different numbers. Best-effort:
 * this decorates a band, and a failure reports `truncated` rather than a bare
 * zero, so "not counted" never renders as "nothing held".
 */
async function loadComplianceLoad(
  context: Awaited<ReturnType<typeof requireOrgContext>>,
): Promise<ComplianceLoad | null> {
  const { data, error } = await context.supabase
    .from("compliance_documents")
    .select("company_id")
    .eq("org_id", context.orgId)
    .eq("status", "pending_review")
    .is("revoked_at", null)
    .is("superseded_by_id", null)
  if (error) return null

  const rows = data ?? []
  if (rows.length === 0) return { reviews: 0, heldCents: 0, heldTruncated: false }

  const companyIds = Array.from(
    new Set(rows.map((row: { company_id: string }) => row.company_id).filter(Boolean)),
  )
  const held = await getComplianceHeldPayablesByCompanyWithClient(
    context.supabase,
    context.orgId,
    companyIds,
  ).catch(() => null)

  return {
    reviews: rows.length,
    heldCents: held?.totalCents ?? 0,
    heldTruncated: held ? held.truncated : true,
  }
}

/**
 * Names for the people the week has double-booked.
 *
 * Only runs when the collision scan actually found one, which is rare — an
 * unconditional roster load would put a round trip on every render of a desk
 * whose whole point is that it takes one.
 */
async function resolveAssigneeNames(rollup: ControlTowerRollup): Promise<Map<string, string>> {
  const ids = Array.from(
    new Set(
      rollup.lookahead.days.flatMap((day) =>
        (day.assignee_overlaps ?? []).map((overlap) => overlap.assignee),
      ),
    ),
  )
  if (ids.length === 0) return new Map()

  const { data } = await createServiceSupabaseClient()
    .from("app_users")
    .select("id, full_name")
    .in("id", ids)
  const names = new Map<string, string>()
  for (const row of (data ?? []) as Array<{ id: string; full_name: string | null }>) {
    if (row.full_name) names.set(row.id, row.full_name)
  }
  return names
}

/** Local calendar day, not UTC: "today" on this desk is the reader's today. */
function localDateKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-")
}
