import "server-only"
import { waiverCoverage } from "@/lib/lien-waivers/coverage"

import {
  planWaiverChase,
  readLastWaiverChase,
  type WaiverChaseFacts,
  type WaiverChasePlan,
} from "@/lib/payments/waiver-chase-policy"
import { enqueueOutboxJob } from "@/lib/services/outbox"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * The daily sweep that keeps asking for lien waivers.
 *
 * It runs for every active org from the compliance autopilot, which already
 * exists to chase the documents that gate payment. Everything it decides comes
 * from `lib/payments/waiver-chase-policy.ts`, which is pure; this file only
 * gathers facts and enqueues.
 *
 * It also covers the case no event hook could: a payable that reached `paid`
 * through ANY path — a payment run, a manual record, an accounting import —
 * still owes an unconditional waiver, and asking here means there is one place
 * that notices rather than one hook per payment path.
 */

export const WAIVER_CHASE_JOB_TYPE = "chase_vendor_bill_waiver"

/** Payables older than this stop being chased; the record is closed by then. */
const CHASE_HORIZON_DAYS = 120
/** A ceiling so one very large org cannot starve the sweep. */
const BILL_SCAN_LIMIT = 2000

interface SweepMetrics {
  orgsConsidered: number
  billsConsidered: number
  chasesEnqueued: number
  signatureChases: number
  unconditionalChases: number
}

type BillRow = {
  id: string
  project_id: string | null
  company_id: string | null
  status: string
  total_cents: number
  paid_cents: number | null
  retainage_cents: number | null
  retainage_released_cents: number | null
  paid_at: string | null
  lien_waiver_status: string | null
  metadata: Record<string, unknown> | null
  commitment: { company_id: string | null } | Array<{ company_id: string | null }> | null
}

function relationOne<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null)
}

/** Chase one org. Exported so a single org can be swept from an ops action. */
export async function sweepOrgWaiverChases(orgId: string, nowIso: string): Promise<SweepMetrics> {
  const metrics: SweepMetrics = {
    orgsConsidered: 1,
    billsConsidered: 0,
    chasesEnqueued: 0,
    signatureChases: 0,
    unconditionalChases: 0,
  }
  const supabase = createServiceSupabaseClient()

  const [{ data: rules }, { data: waiverProjects }] = await Promise.all([
    supabase.from("compliance_rules").select("require_lien_waiver").eq("org_id", orgId).maybeSingle(),
    supabase.from("projects").select("id").eq("org_id", orgId).eq("require_subtier_waivers", true),
  ])
  const orgRequiresWaivers = rules?.require_lien_waiver === true
  const subtierProjectIds = new Set((waiverProjects ?? []).map((row) => String(row.id)))
  // Nothing on this org asks for a waiver, so nothing to chase.
  if (!orgRequiresWaivers && subtierProjectIds.size === 0) return metrics

  const horizon = new Date(Date.parse(nowIso) - CHASE_HORIZON_DAYS * 86_400_000).toISOString().slice(0, 10)
  const { data: bills, error } = await supabase
    .from("vendor_bills")
    .select("id, project_id, company_id, status, total_cents, paid_cents, retainage_cents, retainage_released_cents, paid_at, lien_waiver_status, metadata, commitment:commitments(company_id)")
    .eq("org_id", orgId)
    .not("project_id", "is", null)
    .in("status", ["approved", "partial", "paid"])
    .gte("bill_date", horizon)
    .limit(BILL_SCAN_LIMIT)
  if (error) throw new Error(`Unable to scan payables for waiver chases: ${error.message}`)

  const candidates = (bills ?? []) as BillRow[]
  metrics.billsConsidered = candidates.length
  if (candidates.length === 0) return metrics

  // One read for every vendor's email and one for every signed waiver, rather
  // than a query per payable.
  const companyIds = [
    ...new Set(
      candidates
        .map((bill) => bill.company_id ?? relationOne(bill.commitment)?.company_id ?? null)
        .filter((id): id is string => Boolean(id)),
    ),
  ]
  const billIds = candidates.map((bill) => bill.id)
  const [{ data: companies }, { data: waivers }] = await Promise.all([
    companyIds.length > 0
      ? supabase.from("companies").select("id, email").eq("org_id", orgId).in("id", companyIds)
      : Promise.resolve({ data: [] as Array<{ id: string; email: string | null }> }),
    supabase
      .from("lien_waivers")
      .select("id,bill_id,waiver_type,status,amount_cents,through_date,signed_at,signed_file_id,document_file_id,metadata")
      .eq("org_id", orgId)
      .eq("status", "signed")
      .in("bill_id", billIds),
  ])
  const emailByCompany = new Map((companies ?? []).map((row) => [String(row.id), row.email]))

  const plans: WaiverChasePlan[] = []
  for (const bill of candidates) {
    const projectId = bill.project_id
    if (!projectId) continue
    const companyId = bill.company_id ?? relationOne(bill.commitment)?.company_id ?? null
    const metadata = (bill.metadata ?? {}) as Record<string, unknown>
    const coverage=waiverCoverage(bill,(waivers??[]).filter(w=>w.bill_id===bill.id),true)
    const facts: WaiverChaseFacts = {
      billId: bill.id,
      projectId,
      waiverRequired: orgRequiresWaivers || subtierProjectIds.has(projectId),
      waiverReceived: Boolean(coverage.conditionalId)||coverage.outstandingCents===0,
      paidInFull: bill.status === "paid" || Number(bill.paid_cents ?? 0) >= Number(bill.total_cents ?? 0),
      paidAt: bill.paid_at,
      hasUnconditional: Boolean(coverage.unconditionalId),
      hasVendorEmail: Boolean(companyId && emailByCompany.get(companyId)),
      lastChase: readLastWaiverChase(metadata),
    }
    const plan = planWaiverChase(facts, nowIso)
    if (plan) plans.push(plan)
  }

  for (const plan of plans) {
    const result = await enqueueOutboxJob({
      orgId,
      jobType: WAIVER_CHASE_JOB_TYPE,
      payload: { bill_id: plan.billId, project_id: plan.projectId, waiver_kind: plan.kind, attempt: plan.attempt },
      // One live chase per payable. A second one for the same bill waits until
      // the first has been sent, which is also what stops a slow cron run from
      // mailing the same vendor twice.
      dedupeByPayloadKeys: ["bill_id"],
    })
    if (!result.enqueued) continue
    metrics.chasesEnqueued += 1
    if (plan.kind === "signature") metrics.signatureChases += 1
    else metrics.unconditionalChases += 1
  }

  return metrics
}

export async function sweepWaiverChases(nowIso = new Date().toISOString()): Promise<SweepMetrics> {
  const supabase = createServiceSupabaseClient()
  const { data: orgs } = await supabase.from("orgs").select("id").eq("status", "active")
  const totals: SweepMetrics = {
    orgsConsidered: 0,
    billsConsidered: 0,
    chasesEnqueued: 0,
    signatureChases: 0,
    unconditionalChases: 0,
  }
  for (const org of orgs ?? []) {
    try {
      const metrics = await sweepOrgWaiverChases(String(org.id), nowIso)
      totals.orgsConsidered += metrics.orgsConsidered
      totals.billsConsidered += metrics.billsConsidered
      totals.chasesEnqueued += metrics.chasesEnqueued
      totals.signatureChases += metrics.signatureChases
      totals.unconditionalChases += metrics.unconditionalChases
    } catch (error) {
      // One org's bad data must not stop every other org's chases.
      console.error("[waiver-chase] org sweep failed", org.id, error)
    }
  }
  return totals
}
