import "server-only"

import { z } from "zod"

import { getPaymentRailProvider } from "@/lib/integrations/payments/payment-rail-registry"
import type { ProviderActivity } from "@/lib/integrations/payments/payment-rail-provider"
import { mapWithConcurrency } from "@/lib/payments/concurrency"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import {
  openPaymentOperationsIncident,
  resolvePaymentOperationsIncident,
} from "@/lib/services/ops-watchdog"
import { requirePermission } from "@/lib/services/permissions"
import {
  hasStalePaymentState,
  loadStalePaymentState,
  STALE_PAYMENT_STATE_HOURS,
  STALE_PAYMENT_STATE_INCIDENT_CODE,
} from "@/lib/services/payment-stale-state"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/** Provider round-trips in flight while reconciling one org's period. */
const SETTLEMENT_CONCURRENCY = 8
/**
 * How long a payment may sit mid-flight before it is an exception rather than a
 * settlement window.
 *
 * The rail's own worst case is a five-business-day debit plus a two-day payout,
 * so anything past four days without reaching a terminal state has stopped
 * moving for a reason nobody has looked at. Production had a run `processing`
 * and its disbursement frozen at `transfer_pending` for six days with no sweep,
 * no alert and no exception — the money had left the builder and never reached
 * the vendor, and the only reason anyone found out was a manual audit.
 */
/** Page size for exhaustive stale-state and exception scans. */
const RECONCILIATION_PAGE_SIZE = 500
/** Upper bound on orgs examined per tick; the time budget is the real limit. */
const RECONCILIATION_ORG_SWEEP_LIMIT = 500
/** Leaves headroom under the route's 300s maxDuration for the final writes. */
const DEFAULT_RECONCILIATION_BUDGET_MS = 240_000
/** Postgres unique violation. A losing race, not a failure. */
const UNIQUE_VIOLATION = "23505"

/**
 * The closed UTC day a reconciliation covers.
 *
 * One convention, used by the cron and by the "Reconcile last 24 hours" button
 * alike. They used to disagree — the button took a rolling window ending *now*,
 * the cron a midnight-aligned closed period — so the same table held two kinds
 * of period that could not be compared to each other, and a manual click could
 * never collide with (or supersede) the cron's run for the same day. A closed
 * period is also the only kind that can be idempotent: "the last 24 hours" is a
 * different window every second.
 */
export function dailyReconciliationPeriod(now = new Date()) {
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const periodStart = new Date(periodEnd.getTime() - 24 * 60 * 60 * 1000)
  return { period_start: periodStart.toISOString(), period_end: periodEnd.toISOString() }
}

const reconciliationInputSchema = z.object({
  period_start: z.string().datetime(),
  period_end: z.string().datetime(),
}).superRefine((value, context) => {
  const start = new Date(value.period_start)
  const end = new Date(value.period_end)
  if (end <= start) context.addIssue({ code: z.ZodIssueCode.custom, path: ["period_end"], message: "Period end must be after period start" })
  if (end.getTime() - start.getTime() > 31 * 24 * 60 * 60 * 1000) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["period_end"], message: "A reconciliation period cannot exceed 31 days" })
  }
})

export interface PaymentReconciliationSummary {
  id: string
  provider: string
  periodStart: string
  periodEnd: string
  status: string
  expectedCents: number
  providerCents: number
  differenceCents: number
  exceptionCount: number
  createdAt: string
}

export interface PaymentReconciliationException {
  id: string
  runId: string
  disbursementId: string | null
  status: string
  providerReference: string | null
  expectedCents: number
  providerCents: number
  differenceCents: number
  createdAt: string
}

async function loadAllDisbursementsForPeriod(orgId: string, provider: string, periodStart: string, periodEnd: string) {
  const supabase = createServiceSupabaseClient()
  const rows: Array<Record<string, unknown>> = []
  const pageSize = 500
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase.from("disbursements")
      .select("id,provider_payment_id,provider_transfer_id,provider_payout_id,status,amount_cents,processor_fee_cents,actual_processor_fee_cents,platform_fee_cents")
      .eq("org_id", orgId).eq("provider", provider).gte("created_at", periodStart).lt("created_at", periodEnd)
      .order("created_at", { ascending: true }).order("id", { ascending: true })
      .range(from, from + pageSize - 1)
    if (error) throw new Error(`Unable to load disbursements for reconciliation: ${error.message}`)
    rows.push(...(data ?? []))
    if ((data ?? []).length < pageSize) break
  }
  return rows
}

/**
 * The provider customers Arc opened for this org's bank accounts.
 *
 * This is the discovery key for debits: every AP payment intent and every Arc
 * fee debit is drawn on one of these customers, and the customer id is the
 * provider's own record of whose bank was touched — not something Arc wrote onto
 * its own object and could therefore fail to write.
 */
async function loadFundingProviderCustomerIds(orgId: string, provider: string) {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase.from("org_funding_sources")
    .select("provider_customer_id")
    .eq("org_id", orgId)
    .eq("provider", provider)
    .not("provider_customer_id", "is", null)
  if (error) throw new Error(`Unable to load funding customers for reconciliation: ${error.message}`)
  return [...new Set((data ?? []).flatMap((row) => typeof row.provider_customer_id === "string" && row.provider_customer_id.length > 0 ? [row.provider_customer_id] : []))]
}

async function loadRecipientProviderAccountIds(orgId: string, provider: string) {
  const supabase = createServiceSupabaseClient()
  const { data: relationships, error } = await supabase.from("vendor_payment_relationships")
    .select("recipient_account_id")
    .eq("org_id", orgId)
    .not("recipient_account_id", "is", null)
  if (error) throw new Error(`Unable to load recipient accounts for reconciliation: ${error.message}`)
  const recipientIds = [...new Set((relationships ?? []).map((row) => row.recipient_account_id).filter(Boolean))]
  if (recipientIds.length === 0) return []
  const { data: recipients, error: recipientError } = await supabase.from("payment_recipient_accounts")
    .select("provider_account_id")
    .eq("provider", provider)
    .in("id", recipientIds)
  if (recipientError) throw new Error(`Unable to load provider recipient accounts: ${recipientError.message}`)
  return [...new Set((recipients ?? []).flatMap((row) => typeof row.provider_account_id === "string" && row.provider_account_id.length > 0 ? [row.provider_account_id] : []))]
}

async function loadDisbursementsByProviderActivity(orgId: string, provider: string, activity: ProviderActivity[]) {
  const supabase = createServiceSupabaseClient()
  const paymentIds = [...new Set(activity.filter((row) => row.kind === "payment").map((row) => row.providerReference))]
  const transferIds = [...new Set(activity.flatMap((row) => row.kind === "transfer"
    ? [row.providerReference]
    : row.kind === "payout"
      ? row.linkedReferences
      : []))]
  const payoutIds = [...new Set(activity.filter((row) => row.kind === "payout").map((row) => row.providerReference))]
  const select = "id,provider_payment_id,provider_transfer_id,provider_payout_id,status,amount_cents,processor_fee_cents,actual_processor_fee_cents,platform_fee_cents"
  const queryReferences = async (field: "provider_payment_id" | "provider_transfer_id" | "provider_payout_id", references: string[]) => {
    const chunks: string[][] = []
    for (let index = 0; index < references.length; index += 200) chunks.push(references.slice(index, index + 200))
    return mapWithConcurrency(chunks, 4, async (chunk) => await supabase.from("disbursements").select(select).eq("org_id", orgId).eq("provider", provider).in(field, chunk))
  }
  const results = (await Promise.all([
    queryReferences("provider_payment_id", paymentIds),
    queryReferences("provider_transfer_id", transferIds),
    queryReferences("provider_payout_id", payoutIds),
  ])).flat()
  const rows = new Map<string, Record<string, unknown>>()
  for (const result of results) {
    if (result.error) throw new Error(`Unable to match provider activity to Arc disbursements: ${result.error.message}`)
    for (const row of result.data ?? []) rows.set(String(row.id), row)
  }
  return [...rows.values()]
}

async function loadFeeChargesByProviderActivity(orgId: string, provider: string, activity: ProviderActivity[]) {
  const references = [...new Set(activity.filter((row) => row.kind === "fee_payment").map((row) => row.providerReference))]
  if (references.length === 0) return []
  const supabase = createServiceSupabaseClient()
  const chunks: string[][] = []
  for (let index = 0; index < references.length; index += 200) chunks.push(references.slice(index, index + 200))
  const results = await mapWithConcurrency(chunks, 4, async (chunk) => await supabase.from("payment_run_fee_charges")
    .select("id,run_id,provider_payment_id,status,amount_cents")
    .eq("org_id", orgId)
    .eq("provider", provider)
    .in("provider_payment_id", chunk))
  const rows = []
  for (const result of results) {
    if (result.error) throw new Error(`Unable to match provider activity to Arc fee charges: ${result.error.message}`)
    rows.push(...(result.data ?? []))
  }
  return rows
}

/**
 * Payments that stopped moving, raised as exceptions on this reconciliation run.
 *
 * Deliberately not scoped to the reconciliation period: a disbursement stuck for
 * six days falls out of a one-day window on day two, which is exactly how one
 * sat unnoticed. It uses the existing exception machinery rather than a parallel
 * one, so a stuck payment lands in the same Ops queue, with the same resolve
 * flow, as every other discrepancy. `timing_difference` is the honest status —
 * the provider and Arc do not disagree about the amount, the money simply has
 * not arrived — and `provider_reference` names the state and its age so the row
 * is actionable without opening anything.
 */
async function flagStalePaymentStates(reconciliationRunId: string, orgId: string): Promise<number> {
  const supabase = createServiceSupabaseClient()
  // The scan itself is shared with the hourly watchdog, which runs it across
  // every organization whether or not reconciliation is enabled. This caller
  // owns the exception ROWS; the watchdog owns raising the incident when
  // reconciliation is not running at all.
  const staleState = await loadStalePaymentState({ orgId })
  const staleDisbursements = staleState.disbursements
  const staleRuns = staleState.runs

  const orgHasStaleState = hasStalePaymentState(staleState)
  const rows = [
    ...staleDisbursements.map((disbursement) => ({
      disbursement_id: disbursement.id as string | null,
      expected_cents: Number(disbursement.amount_cents),
      provider_reference: `stale:disbursement:${disbursement.id}:${disbursement.status}`,
    })),
    ...staleRuns.map((run) => ({
      disbursement_id: null,
      expected_cents: Number(run.total_debit_cents),
      provider_reference: `stale:payment_run:${run.id}:${run.status}`,
    })),
  ]
  const currentReferences = new Set(rows.map((row) => row.provider_reference))
  const recoveredIds: string[] = []
  for (let from = 0; ; from += RECONCILIATION_PAGE_SIZE) {
    const { data, error } = await supabase.from("payment_reconciliation_items")
      .select("id,provider_reference")
      .eq("org_id", orgId)
      .eq("status", "timing_difference")
      .like("provider_reference", "stale:%")
      .order("id", { ascending: true })
      .range(from, from + RECONCILIATION_PAGE_SIZE - 1)
    if (error) throw new Error(`Unable to inspect stale payment exception recovery: ${error.message}`)
    recoveredIds.push(...(data ?? []).filter((row) => !currentReferences.has(String(row.provider_reference))).map((row) => row.id))
    if ((data ?? []).length < RECONCILIATION_PAGE_SIZE) break
  }
  if (recoveredIds.length > 0) {
    const resolvedAt = new Date().toISOString()
    for (let index = 0; index < recoveredIds.length; index += 200) {
      const { error } = await supabase.from("payment_reconciliation_items").update({
        status: "resolved",
        resolution_note: "The payment state advanced and is no longer stale.",
        resolution_reference: `reconciliation_run:${reconciliationRunId}`,
        resolution_evidence: { source: "reconciliation", verified_at: resolvedAt, corrective_action: "Automatically closed after provider state recovery" },
        resolved_at: resolvedAt,
      }).in("id", recoveredIds.slice(index, index + 200))
      if (error) throw new Error(`Unable to close recovered stale payment exceptions: ${error.message}`)
    }
  }
  if (!orgHasStaleState) {
    await resolvePaymentOperationsIncident({ orgId, code: STALE_PAYMENT_STATE_INCIDENT_CODE })
    return 0
  }

  const references = rows.map((row) => row.provider_reference)
  const existingReferences = new Set<string>()
  for (let index = 0; index < references.length; index += 200) {
    const { data, error } = await supabase.from("payment_reconciliation_items")
      .select("provider_reference")
      .eq("org_id", orgId)
      .not("status", "in", "(matched,resolved)")
      .in("provider_reference", references.slice(index, index + 200))
    if (error) throw new Error(`Unable to inspect existing stale payment exceptions: ${error.message}`)
    for (const row of data ?? []) if (row.provider_reference) existingReferences.add(row.provider_reference)
  }
  const newRows = rows.filter((row) => !existingReferences.has(row.provider_reference))
  for (let index = 0; index < newRows.length; index += 200) {
    const { error } = await supabase.from("payment_reconciliation_items").insert(
      newRows.slice(index, index + 200).map((row) => ({
        reconciliation_run_id: reconciliationRunId,
        org_id: orgId,
        disbursement_id: row.disbursement_id,
        provider_reference: row.provider_reference,
        expected_cents: row.expected_cents,
        provider_cents: 0,
        difference_cents: -row.expected_cents,
        status: "timing_difference",
      })),
    )
    if (error) throw new Error(`Unable to record stale payment exceptions: ${error.message}`)
  }

  // Loud, not logged — but loud once. The exception ROWS were already deduped by
  // provider reference; the EVENT was not, so a disbursement stuck for a week
  // emailed every reconciler seven times and the fix for exactly this (the
  // incident table) was never wired to this path. It is now: one alert when the
  // org first goes stale, one more each day it stays that way, and silence in
  // between.
  const detail = `${rows.length} vendor payment(s) have been in a non-terminal state for more than ${STALE_PAYMENT_STATE_HOURS} hours.`
  const shouldNotify = await openPaymentOperationsIncident({
    orgId,
    code: STALE_PAYMENT_STATE_INCIDENT_CODE,
    detail,
  })
  if (shouldNotify) {
    await recordEvent({
      orgId,
      eventType: "payment_operations_alert",
      entityType: "payment_reconciliation_run",
      entityId: reconciliationRunId,
      payload: {
        reason: "stale_payment_state",
        stale_disbursements: staleDisbursements.length,
        stale_runs: staleRuns.length,
        threshold_hours: STALE_PAYMENT_STATE_HOURS,
      },
    })
  }
  return rows.length
}

async function closeSupersededReconciliationExceptions(reconciliationRunId: string, orgId: string) {
  const supabase = createServiceSupabaseClient()
  const { data: matched, error } = await supabase.from("payment_reconciliation_items")
    .select("provider_reference")
    .eq("reconciliation_run_id", reconciliationRunId)
    .eq("org_id", orgId)
    .eq("status", "matched")
    .not("provider_reference", "is", null)
  if (error) throw new Error(`Unable to inspect matched reconciliation items: ${error.message}`)
  const references = [...new Set((matched ?? []).map((row) => row.provider_reference).filter((value): value is string => Boolean(value)))]
  const resolvedAt = new Date().toISOString()
  for (let index = 0; index < references.length; index += 200) {
    const chunk = references.slice(index, index + 200)
    const { error: updateError } = await supabase.from("payment_reconciliation_items").update({
      status: "resolved",
      resolution_note: "A later provider-led reconciliation matched this exact provider reference.",
      resolution_reference: `reconciliation_run:${reconciliationRunId}`,
      resolution_evidence: { source: "reconciliation", verified_at: resolvedAt, corrective_action: "Automatically closed after an exact provider-reference match" },
      resolved_at: resolvedAt,
    }).eq("org_id", orgId)
      .neq("reconciliation_run_id", reconciliationRunId)
      .not("status", "in", "(matched,resolved)")
      .in("provider_reference", chunk)
    if (updateError) throw new Error(`Unable to close superseded reconciliation exceptions: ${updateError.message}`)
  }
}

async function resolveOrgPaymentProvider(orgId: string) {
  const supabase = createServiceSupabaseClient()
  const { data: funding } = await supabase.from("org_funding_sources")
    .select("provider")
    .eq("org_id", orgId)
    .eq("status", "active")
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (funding?.provider) return String(funding.provider)
  const { data: latest } = await supabase.from("disbursements")
    .select("provider")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  return String(latest?.provider ?? "stripe")
}

/**
 * Take (or re-take) the run for this org and period.
 *
 * A re-invoked cron, or a manual "Reconcile last 24 hours" click racing it,
 * inserted a second run for the same closed period and then produced a second
 * full set of exception items — the same defect the accounting spine fixed with
 * a daily uniqueness index in `20260807190000_reconciliation_run_daily_idempotency`,
 * whose comment already explains why reading before writing is not enough. The
 * matching index for payments is pending; this code is written so the conflict
 * is a normal outcome rather than a crash, before and after it lands.
 */
async function claimReconciliationRun(
  orgId: string,
  providerKey: string,
  period: { period_start: string; period_end: string },
): Promise<{ id: string }> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase.from("payment_reconciliation_runs").insert({
    org_id: orgId,
    provider: providerKey,
    period_start: period.period_start,
    period_end: period.period_end,
    status: "running",
    started_at: new Date().toISOString(),
  }).select("id").maybeSingle()
  if (!error && data) return { id: String(data.id) }
  if (error && (error as { code?: string }).code !== UNIQUE_VIOLATION) {
    throw new Error(`Unable to start payment reconciliation: ${error.message}`)
  }
  const { data: existing, error: existingError } = await supabase.from("payment_reconciliation_runs")
    .select("id")
    .eq("org_id", orgId)
    .eq("period_start", period.period_start)
    .eq("period_end", period.period_end)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle()
  if (existingError || !existing) {
    throw new Error(`Unable to start payment reconciliation: ${existingError?.message ?? "the conflicting run vanished"}`)
  }
  const { error: restartError } = await supabase.from("payment_reconciliation_runs")
    .update({ status: "running", started_at: new Date().toISOString(), failure_reason: null, completed_at: null })
    .eq("id", existing.id).eq("org_id", orgId)
  if (restartError) throw new Error(`Unable to restart payment reconciliation: ${restartError.message}`)
  return { id: String(existing.id) }
}

/**
 * Insert an exception item, treating a duplicate as done rather than as an error.
 *
 * Re-running a period re-derives the same findings. With the pending unique key
 * on (reconciliation_run_id, provider_reference) that is a no-op; without it the
 * conflict never fires and this behaves exactly as before.
 */
async function insertReconciliationItem(row: Record<string, unknown>) {
  const supabase = createServiceSupabaseClient()
  const { error } = await supabase.from("payment_reconciliation_items").insert(row)
  if (error && (error as { code?: string }).code !== UNIQUE_VIOLATION) {
    throw new Error(`Unable to record reconciliation item: ${error.message}`)
  }
}

async function performPaymentReconciliation(input: { period_start: string; period_end: string }, orgId: string, actorId?: string) {
  const parsed = reconciliationInputSchema.parse(input)
  const supabase = createServiceSupabaseClient()
  const attemptedAt = new Date().toISOString()
  const { error: attemptError } = await supabase.from("payment_rail_policies")
    .update({ last_reconciliation_attempt_at: attemptedAt })
    .eq("org_id", orgId)
  if (attemptError) throw new Error(`Unable to record reconciliation attempt: ${attemptError.message}`)
  const providerKey = await resolveOrgPaymentProvider(orgId)
  const provider = getPaymentRailProvider(providerKey)
  const run = await claimReconciliationRun(orgId, providerKey, parsed)

  try {
    // Pull the provider's ledger independently before looking up Arc rows. A
    // reconciliation that starts from Arc's own IDs can only prove that known
    // rows still exist; it cannot discover an unrecorded debit or transfer.
    //
    // What that independence is worth depends entirely on how the provider's
    // side is enumerated. It used to be enumerated by Arc's own
    // `arc_product` metadata and then narrowed again by Arc's own `org_id`
    // metadata, which meant the control could only ever rediscover movements Arc
    // had already labelled — the unlabelled debit was invisible by construction.
    // Discovery is now the provider's own identities: the funding customers Arc
    // opened for this org, and the connected accounts its vendors are paid into.
    // Metadata still runs, but only to hand a movement to the right tenant.
    //
    // Residual gap, stated plainly: money moved on the platform balance against a
    // customer Arc does not know, or with no customer at all, belongs to no
    // organization and cannot appear in an org-scoped queue. Catching that needs a
    // platform-level control over the whole Stripe account, which does not exist yet.
    const [recipientProviderAccountIds, fundingProviderCustomerIds] = await Promise.all([
      loadRecipientProviderAccountIds(orgId, providerKey),
      loadFundingProviderCustomerIds(orgId, providerKey),
    ])
    const directlyOwnedActivity = await provider.listActivity({
      orgId,
      periodStart: parsed.period_start,
      periodEnd: parsed.period_end,
      recipientProviderAccountIds,
      fundingProviderCustomerIds,
    })
    const [periodDisbursements, referencedDisbursements] = await Promise.all([
      loadAllDisbursementsForPeriod(orgId, providerKey, parsed.period_start, parsed.period_end),
      loadDisbursementsByProviderActivity(orgId, providerKey, directlyOwnedActivity),
    ])
    const disbursementMap = new Map<string, Record<string, unknown>>()
    for (const row of [...periodDisbursements, ...referencedDisbursements]) disbursementMap.set(String(row.id), row)
    const disbursements = [...disbursementMap.values()]
    const localPaymentIds = new Set(disbursements.map((row) => row.provider_payment_id).filter(Boolean).map(String))
    const localTransferIds = new Set(disbursements.map((row) => row.provider_transfer_id).filter(Boolean).map(String))
    const localPayoutIds = new Set(disbursements.map((row) => row.provider_payout_id).filter(Boolean).map(String))
    // Payouts used to be dropped here unless they already matched an Arc row,
    // which made "a payout Arc does not recognise" the one category of
    // provider-only money that could never become an exception. They stay, and
    // the classification below decides which of them Arc has to answer for.
    const providerActivity = directlyOwnedActivity

    // Settlement retrieval is one provider round-trip per disbursement and was
    // serial, so a busy day's reconciliation took as long as the sum of every
    // call. Fan out under a bound: unbounded parallelism would trip rate limits
    // and turn a slow run into a failed one.
    const settlements = await mapWithConcurrency(
      disbursements,
      SETTLEMENT_CONCURRENCY,
      (disbursement) => disbursement.provider_payment_id
        ? provider.retrieveSettlement({ providerPaymentId: disbursement.provider_payment_id as string })
        : Promise.resolve(null),
    )

    let expectedCents = 0
    let providerCents = 0
    let exceptionCount = 0
    for (const [index, disbursement] of disbursements.entries()) {
      // Fees ride their own per-run debit, never this one, so what Arc
      // expects the provider to have moved is the vendor amount alone.
      const expectedDebit = Number(disbursement.amount_cents)
      expectedCents += expectedDebit
      const settlement = settlements[index]
      if (!settlement) {
        exceptionCount += 1
        await insertReconciliationItem({
          reconciliation_run_id: run.id,
          org_id: orgId,
          disbursement_id: disbursement.id,
          // Always a reference, even when the disbursement never reached the
          // provider: it is what makes an item identifiable across re-runs.
          provider_reference: `disbursement:${disbursement.id}:unsubmitted`,
          expected_cents: expectedDebit,
          provider_cents: 0,
          difference_cents: -expectedDebit,
          status: disbursement.status === "created" ? "missing_provider" : "missing_provider_reference",
        })
        continue
      }
      providerCents += settlement.debitAmountCents
      const differenceCents = settlement.debitAmountCents - expectedDebit
      const status = !settlement.exists
        ? "missing_provider"
        : differenceCents !== 0
          ? "amount_mismatch"
          : settlement.status !== "settled"
            ? "timing_difference"
            : "matched"
      if (status !== "matched") exceptionCount += 1
      await insertReconciliationItem({
        reconciliation_run_id: run.id,
        org_id: orgId,
        disbursement_id: disbursement.id,
        provider_reference: disbursement.provider_payment_id as string,
        expected_cents: expectedDebit,
        provider_cents: settlement.debitAmountCents,
        difference_cents: differenceCents,
        status,
      })

      // Arc's own cost check, not the builder's. The processor fee comes out of
      // the platform balance, so a mismatch here is Arc being charged something
      // other than what it recorded — worth an exception, but it never moved the
      // builder's money.
      const expectedProcessorFee = Number(disbursement.actual_processor_fee_cents ?? disbursement.processor_fee_cents)
      if (settlement.processorFeeCents != null && settlement.processorFeeCents !== expectedProcessorFee) {
        exceptionCount += 1
        const processorDifference = settlement.processorFeeCents - expectedProcessorFee
        await insertReconciliationItem({
          reconciliation_run_id: run.id,
          org_id: orgId,
          disbursement_id: disbursement.id,
          provider_reference: `${disbursement.provider_payment_id}:processor_fee`,
          expected_cents: expectedProcessorFee,
          provider_cents: settlement.processorFeeCents,
          difference_cents: processorDifference,
          status: "amount_mismatch",
        })
      }
    }

    // Arc's own per-run fee debits. A fee charge sitting in `failed` is a
    // standing receivable, and until it was walked here nothing counted it —
    // disbursement reconciliation only ever saw the vendors' money. The run
    // totals stay vendor-only (that is what `expected_cents` means); fee
    // discrepancies surface as their own exception items.
    const { data: periodFeeCharges, error: feeChargesError } = await supabase.from("payment_run_fee_charges")
      .select("id,run_id,provider_payment_id,status,amount_cents")
      .eq("org_id", orgId).eq("provider", providerKey)
      .gte("created_at", parsed.period_start).lt("created_at", parsed.period_end)
    if (feeChargesError) throw new Error(`Unable to load fee charges for reconciliation: ${feeChargesError.message}`)
    const referencedFeeCharges = await loadFeeChargesByProviderActivity(orgId, providerKey, providerActivity)
    const feeChargeMap = new Map<string, Record<string, unknown>>()
    for (const row of [...(periodFeeCharges ?? []), ...referencedFeeCharges]) feeChargeMap.set(String(row.id), row)
    const feeCharges = [...feeChargeMap.values()]
    const localFeePaymentIds = new Set(feeCharges.map((row) => row.provider_payment_id).filter(Boolean).map(String))
    const feeSettlements = await mapWithConcurrency(
      feeCharges,
      SETTLEMENT_CONCURRENCY,
      (charge) => typeof charge.provider_payment_id === "string" && charge.provider_payment_id.length > 0
        ? provider.retrieveSettlement({ providerPaymentId: charge.provider_payment_id })
        : Promise.resolve(null),
    )
    for (const [index, charge] of feeCharges.entries()) {
      const expectedFeeCents = Number(charge.amount_cents)
      const settlement = feeSettlements[index]
      const arcCollectedCents = charge.status === "succeeded" ? expectedFeeCents : 0
      const providerCollectedCents = settlement?.exists && settlement.status === "settled" ? settlement.debitAmountCents : 0
      const feeStatus = !settlement || !settlement.exists
        // Never collected at the provider — an uncollected fee is a receivable
        // someone chases, whether the charge failed or was never submitted.
        ? "missing_provider"
        : providerCollectedCents !== arcCollectedCents
          ? settlement.status === "pending" ? "timing_difference" : "amount_mismatch"
          : "matched"
      if (feeStatus !== "matched") exceptionCount += 1
      await insertReconciliationItem({
        reconciliation_run_id: run.id,
        org_id: orgId,
        disbursement_id: null,
        provider_reference: charge.provider_payment_id ? `${charge.provider_payment_id}:fee_charge` : `fee_charge:${charge.id}`,
        expected_cents: expectedFeeCents,
        provider_cents: providerCollectedCents,
        difference_cents: providerCollectedCents - expectedFeeCents,
        status: feeStatus,
      })
    }

    // Provider-originated rows with no Arc counterpart are the exception the
    // old algorithm was structurally incapable of seeing. Payments affect the
    // control total. Transfers and payouts are downstream movement of those
    // same dollars, so recording them again in the total would double count;
    // they still get an exception row with the exact provider reference.
    for (const activity of providerActivity) {
      const missingInternal = activity.kind === "payment"
        ? !localPaymentIds.has(activity.providerReference)
        : activity.kind === "fee_payment"
          ? !localFeePaymentIds.has(activity.providerReference)
          : activity.kind === "transfer"
            ? !localTransferIds.has(activity.providerReference)
            // A payout Arc neither created nor funded: money left a vendor
            // account this builder pays into, and no Arc transfer or payout id
            // accounts for it. A payout that bundles another builder's transfers
            // is not this — it has linked transfers, they simply are not ours.
            : activity.kind === "payout"
              ? !localPayoutIds.has(activity.providerReference)
                && !activity.linkedReferences.some((reference) => localTransferIds.has(reference))
                && activity.linkedReferences.length === 0
              // Rail fees, adjustments, reserves and payout reversals: Arc never
              // records these, so every one of them is by definition unmatched.
              : true
      if (missingInternal) {
        exceptionCount += 1
        if (activity.kind === "payment") providerCents += activity.amountCents
        await insertReconciliationItem({
          reconciliation_run_id: run.id,
          org_id: orgId,
          disbursement_id: null,
          provider_reference: `${activity.activityType ?? activity.kind}:${activity.providerReference}`,
          expected_cents: 0,
          provider_cents: activity.amountCents,
          difference_cents: activity.amountCents,
          status: "missing_internal",
        })
        continue
      }

      if (activity.kind === "transfer") {
        const local = disbursements.find((row) => row.provider_transfer_id === activity.providerReference)
        if (!local) continue
        const expected = Number(local.amount_cents)
        const difference = activity.amountCents - expected
        const itemStatus = difference !== 0
          ? "amount_mismatch"
          : activity.status === "settled"
            ? "matched"
            : "timing_difference"
        if (itemStatus !== "matched") exceptionCount += 1
        await insertReconciliationItem({
          reconciliation_run_id: run.id,
          org_id: orgId,
          disbursement_id: local.id,
          provider_reference: `transfer:${activity.providerReference}`,
          expected_cents: expected,
          provider_cents: activity.amountCents,
          difference_cents: difference,
          status: itemStatus,
        })
      }

      if (activity.kind === "payout") {
        for (const transferId of activity.linkedReferences.filter((reference) => localTransferIds.has(reference))) {
          const local = disbursements.find((row) => row.provider_transfer_id === transferId)
          if (!local) continue
          const payoutMatches = !local.provider_payout_id || local.provider_payout_id === activity.providerReference
          const itemStatus = activity.status === "settled" && payoutMatches ? "matched" : "timing_difference"
          if (itemStatus !== "matched") exceptionCount += 1
          const expected = Number(local.amount_cents)
          await insertReconciliationItem({
            reconciliation_run_id: run.id,
            org_id: orgId,
            disbursement_id: local.id,
            provider_reference: `payout:${activity.providerReference}:transfer:${transferId}`,
            expected_cents: expected,
            provider_cents: itemStatus === "matched" ? expected : 0,
            difference_cents: itemStatus === "matched" ? 0 : -expected,
            status: itemStatus,
          })
        }
      }
    }

    exceptionCount += await flagStalePaymentStates(run.id, orgId)
    await closeSupersededReconciliationExceptions(run.id, orgId)

    const differenceCents = providerCents - expectedCents
    const status = exceptionCount > 0 || differenceCents !== 0 ? "exceptions" : "balanced"
    const { data: previousRun } = await supabase.from("payment_reconciliation_runs")
      .select("status")
      .eq("org_id", orgId)
      .neq("id", run.id)
      .in("status", ["balanced", "exceptions"])
      .order("period_end", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    const { error: completeError } = await supabase.from("payment_reconciliation_runs").update({
      status,
      expected_cents: expectedCents,
      provider_cents: providerCents,
      difference_cents: differenceCents,
      completed_at: new Date().toISOString(),
    }).eq("id", run.id).eq("org_id", orgId)
    if (completeError) throw new Error(`Unable to complete payment reconciliation: ${completeError.message}`)
    const { error: watermarkError } = await supabase.from("payment_rail_policies")
      .update({ last_reconciled_at: new Date().toISOString() })
      .eq("org_id", orgId)
    if (watermarkError) throw new Error(`Unable to record successful reconciliation: ${watermarkError.message}`)
    // A healthy rail is quiet. This fired on every completion, so a builder whose
    // payments were perfectly balanced got a daily email saying nothing happened
    // — the fastest way to teach a reconciler to filter the one message that
    // matters. Exceptions are always worth saying; so is the transition back to
    // balanced, because "it cleared" is news. Balanced after balanced is not.
    const worthSaying = status === "exceptions" || previousRun?.status !== status
    // The audit row is unconditional: it is the evidence the control ran, which
    // is a different question from whether anyone needs to be told.
    await Promise.all([
      ...(worthSaying
        ? [recordEvent({ orgId, actorId, eventType: "payment_reconciliation_completed", entityType: "payment_reconciliation_run", entityId: run.id, payload: { status, exception_count: exceptionCount, difference_cents: differenceCents } })]
        : []),
      recordAudit({ orgId, actorId, action: "insert", entityType: "payment_reconciliation_run", entityId: run.id, after: { status, expected_cents: expectedCents, provider_cents: providerCents, difference_cents: differenceCents }, source: actorId ? "app" : "cron" }),
    ])
    return { id: run.id, status, expectedCents, providerCents, differenceCents, exceptionCount }
  } catch (error) {
    await supabase.from("payment_reconciliation_runs").update({
      status: "failed",
      failure_reason: error instanceof Error ? error.message : String(error),
      completed_at: new Date().toISOString(),
    }).eq("id", run.id).eq("org_id", orgId)
    throw error
  }
}

export async function runPaymentReconciliation(input: { period_start: string; period_end: string }, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("payment.reconcile", context)
  return performPaymentReconciliation(input, context.orgId, context.userId)
}

export async function runScheduledPaymentReconciliations(now = new Date(), options: { deadlineMs?: number } = {}) {
  const supabase = createServiceSupabaseClient()
  const period = dailyReconciliationPeriod(now)
  // Time-budgeted rather than org-capped. A fixed cap of 20 silently turned
  // "daily reconciliation" into every-other-day at 21 enabled customers, and the
  // number nobody would notice changing is exactly the number that breaks the
  // control. The budget bounds the request instead, and any org left over is
  // reported rather than dropped.
  const deadline = Date.now() + (options.deadlineMs ?? DEFAULT_RECONCILIATION_BUDGET_MS)
  const { data: policies, error } = await supabase.from("payment_rail_policies")
    .select("org_id")
    .eq("enabled", true)
    .order("last_reconciliation_attempt_at", { ascending: true, nullsFirst: true })
    .limit(RECONCILIATION_ORG_SWEEP_LIMIT)
  if (error) throw new Error(`Unable to load organizations for payment reconciliation: ${error.message}`)
  const results: Array<{ orgId: string; status: string; error?: string }> = []
  const deferred: string[] = []
  for (const policy of policies ?? []) {
    if (Date.now() >= deadline) {
      // Cursor untouched, so these are first in line on the next tick.
      deferred.push(policy.org_id)
      continue
    }
    try {
      const result = await performPaymentReconciliation(period, policy.org_id)
      results.push({ orgId: policy.org_id, status: result.status })
    } catch (caught) {
      results.push({ orgId: policy.org_id, status: "failed", error: caught instanceof Error ? caught.message : String(caught) })
    }
  }
  // Reported, never silent — truncation that says nothing reads as "everything
  // reconciled". The authoritative alarm is not this list though: the watchdog
  // checks `last_reconciled_at` staleness directly, so an org falls out of
  // reconciliation loudly even if this sweep never ran at all.
  return { results, deferred }
}

export async function listPaymentReconciliations(orgId?: string): Promise<PaymentReconciliationSummary[]> {
  const context = await requireOrgContext(orgId)
  await requirePermission("payment.reconcile", context)
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase.from("payment_reconciliation_runs")
    .select("id,provider,period_start,period_end,status,expected_cents,provider_cents,difference_cents,created_at,items:payment_reconciliation_items(id,status)")
    .eq("org_id", context.orgId)
    .order("created_at", { ascending: false })
    .limit(100)
  if (error) throw new Error(`Unable to list payment reconciliations: ${error.message}`)
  return (data ?? []).map((row) => ({
    id: row.id,
    provider: row.provider,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    status: row.status,
    expectedCents: Number(row.expected_cents),
    providerCents: Number(row.provider_cents),
    differenceCents: Number(row.difference_cents),
    exceptionCount: (row.items ?? []).filter((item) => item.status !== "matched" && item.status !== "resolved").length,
    createdAt: row.created_at,
  }))
}

export async function listOpenPaymentReconciliationExceptions(orgId?: string): Promise<PaymentReconciliationException[]> {
  const context = await requireOrgContext(orgId)
  await requirePermission("payment.reconcile", context)
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase.from("payment_reconciliation_items")
    .select("id,reconciliation_run_id,disbursement_id,status,provider_reference,expected_cents,provider_cents,difference_cents,created_at")
    .eq("org_id", context.orgId).not("status", "in", "(matched,resolved)")
    .order("created_at", { ascending: false }).limit(200)
  if (error) throw new Error(`Unable to list payment exceptions: ${error.message}`)
  return (data ?? []).map((row) => ({ id: row.id, runId: row.reconciliation_run_id, disbursementId: row.disbursement_id, status: row.status, providerReference: row.provider_reference, expectedCents: Number(row.expected_cents), providerCents: Number(row.provider_cents), differenceCents: Number(row.difference_cents), createdAt: row.created_at }))
}

export async function resolvePaymentReconciliationItem(input: {
  itemId: string
  note: string
  reference: string
  evidenceSource: "provider" | "bank" | "accounting" | "ledger" | "other"
}, orgId?: string) {
  const parsed = z.object({
    itemId: z.string().uuid(),
    note: z.string().trim().min(20).max(1000),
    reference: z.string().trim().min(3).max(200),
    evidenceSource: z.enum(["provider", "bank", "accounting", "ledger", "other"]),
  }).parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("payment.reconcile", context)
  const supabase = createServiceSupabaseClient()
  const resolvedAt = new Date().toISOString()
  const { data, error } = await supabase.from("payment_reconciliation_items").update({
    status: "resolved",
    resolution_note: parsed.note,
    resolution_reference: parsed.reference,
    resolution_evidence: {
      source: parsed.evidenceSource,
      verified_at: resolvedAt,
      corrective_action: parsed.note,
    },
    resolved_by: context.userId,
    resolved_at: resolvedAt,
  }).eq("id", parsed.itemId).eq("org_id", context.orgId).neq("status", "matched").select("id,reconciliation_run_id").maybeSingle()
  if (error || !data) throw new Error(`Unable to resolve reconciliation exception: ${error?.message ?? "Item was not found"}`)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "payment_reconciliation_item", entityId: data.id, after: { status: "resolved", resolution_note: parsed.note, resolution_reference: parsed.reference, resolution_evidence_source: parsed.evidenceSource } })
  return data
}
