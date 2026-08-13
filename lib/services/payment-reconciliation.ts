import "server-only"

import { z } from "zod"

import { getPaymentRailProvider } from "@/lib/integrations/payments/payment-rail-registry"
import type { ProviderActivity } from "@/lib/integrations/payments/payment-rail-provider"
import { mapWithConcurrency } from "@/lib/payments/concurrency"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"
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
const STALE_PAYMENT_STATE_HOURS = 96
/** Non-terminal disbursement states. Anything here is still owed to someone. */
const NON_TERMINAL_DISBURSEMENT_STATUSES = [
  "created",
  "submitted",
  "debit_pending",
  "funds_available",
  "transfer_pending",
  "payout_pending",
]
/** Non-terminal run states. `draft`/`pending_approval` wait on people, not on money. */
const NON_TERMINAL_RUN_STATUSES = ["processing", "partially_failed"]
/** Page size for exhaustive stale-state and exception scans. */
const RECONCILIATION_PAGE_SIZE = 500
/** Upper bound on orgs examined per tick; the time budget is the real limit. */
const RECONCILIATION_ORG_SWEEP_LIMIT = 500
/** Leaves headroom under the route's 300s maxDuration for the final writes. */
const DEFAULT_RECONCILIATION_BUDGET_MS = 240_000

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
  return [...new Set((recipients ?? []).map((row) => String(row.provider_account_id)).filter(Boolean))]
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
  const cutoff = new Date(Date.now() - STALE_PAYMENT_STATE_HOURS * 60 * 60 * 1000).toISOString()
  const staleDisbursements: Array<{ id: string; run_id: string; status: string; amount_cents: number; provider_payment_id: string | null; created_at: string }> = []
  const staleRuns: Array<{ id: string; status: string; total_debit_cents: number; processing_started_at: string | null; created_at: string }> = []
  for (let from = 0; ; from += RECONCILIATION_PAGE_SIZE) {
    const { data, error } = await supabase.from("disbursements")
      .select("id,run_id,status,amount_cents,provider_payment_id,created_at")
      .eq("org_id", orgId)
      .in("status", NON_TERMINAL_DISBURSEMENT_STATUSES)
      .lte("created_at", cutoff)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + RECONCILIATION_PAGE_SIZE - 1)
    if (error) throw new Error(`Unable to load stale disbursements: ${error.message}`)
    staleDisbursements.push(...(data ?? []))
    if ((data ?? []).length < RECONCILIATION_PAGE_SIZE) break
  }
  for (let from = 0; ; from += RECONCILIATION_PAGE_SIZE) {
    const { data, error } = await supabase.from("payment_runs")
      .select("id,status,total_debit_cents,processing_started_at,created_at")
      .eq("org_id", orgId)
      .in("status", NON_TERMINAL_RUN_STATUSES)
      .lte("created_at", cutoff)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + RECONCILIATION_PAGE_SIZE - 1)
    if (error) throw new Error(`Unable to load stale payment runs: ${error.message}`)
    staleRuns.push(...(data ?? []))
    if ((data ?? []).length < RECONCILIATION_PAGE_SIZE) break
  }

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
  if (rows.length === 0) return 0

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

  // Loud, not logged. A payment that stopped moving is the worst intermediate
  // state on this rail, and the reconciliation summary alone does not page
  // anyone — this event does.
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
  const { data: run, error: runError } = await supabase.from("payment_reconciliation_runs").insert({
    org_id: orgId,
    provider: providerKey,
    period_start: parsed.period_start,
    period_end: parsed.period_end,
    status: "running",
    started_at: new Date().toISOString(),
  }).select("id").single()
  if (runError || !run) throw new Error(`Unable to start payment reconciliation: ${runError?.message}`)

  try {
    // Pull the provider's ledger independently before looking up Arc rows. A
    // reconciliation that starts from Arc's own IDs can only prove that known
    // rows still exist; it cannot discover an unrecorded debit or transfer.
    const recipientProviderAccountIds = await loadRecipientProviderAccountIds(orgId, providerKey)
    const allProviderActivity = await provider.listActivity({
      periodStart: parsed.period_start,
      periodEnd: parsed.period_end,
      recipientProviderAccountIds,
    })
    const directlyOwnedActivity = allProviderActivity.filter((row) =>
      row.kind === "payout" || row.metadata.org_id === orgId,
    )
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
    const providerActivity = directlyOwnedActivity.filter((row) => row.kind !== "payout"
      || localPayoutIds.has(row.providerReference)
      || row.linkedReferences.some((reference) => localTransferIds.has(reference)))

    // Settlement retrieval is one provider round-trip per disbursement and was
    // serial, so a busy day's reconciliation took as long as the sum of every
    // call. Fan out under a bound: unbounded parallelism would trip rate limits
    // and turn a slow run into a failed one.
    const settlements = await mapWithConcurrency(
      disbursements,
      SETTLEMENT_CONCURRENCY,
      (disbursement) => disbursement.provider_payment_id
        ? provider.retrieveSettlement({ providerPaymentId: String(disbursement.provider_payment_id) })
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
        await supabase.from("payment_reconciliation_items").insert({
          reconciliation_run_id: run.id,
          org_id: orgId,
          disbursement_id: disbursement.id,
          expected_cents: expectedDebit,
          provider_cents: 0,
          difference_cents: -expectedDebit,
          status: "missing_provider",
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
      const { error: itemError } = await supabase.from("payment_reconciliation_items").insert({
        reconciliation_run_id: run.id,
        org_id: orgId,
        disbursement_id: disbursement.id,
        provider_reference: disbursement.provider_payment_id,
        expected_cents: expectedDebit,
        provider_cents: settlement.debitAmountCents,
        difference_cents: differenceCents,
        status,
      })
      if (itemError) throw new Error(`Unable to record reconciliation item: ${itemError.message}`)

      // Arc's own cost check, not the builder's. The processor fee comes out of
      // the platform balance, so a mismatch here is Arc being charged something
      // other than what it recorded — worth an exception, but it never moved the
      // builder's money.
      const expectedProcessorFee = Number(disbursement.actual_processor_fee_cents ?? disbursement.processor_fee_cents)
      if (settlement.processorFeeCents != null && settlement.processorFeeCents !== expectedProcessorFee) {
        exceptionCount += 1
        const processorDifference = settlement.processorFeeCents - expectedProcessorFee
        const { error: feeError } = await supabase.from("payment_reconciliation_items").insert({
          reconciliation_run_id: run.id,
          org_id: orgId,
          disbursement_id: disbursement.id,
          provider_reference: `${disbursement.provider_payment_id}:processor_fee`,
          expected_cents: expectedProcessorFee,
          provider_cents: settlement.processorFeeCents,
          difference_cents: processorDifference,
          status: "amount_mismatch",
        })
        if (feeError) throw new Error(`Unable to record processor-fee reconciliation: ${feeError.message}`)
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
      (charge) => charge.provider_payment_id
        ? provider.retrieveSettlement({ providerPaymentId: String(charge.provider_payment_id) })
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
      const { error: feeItemError } = await supabase.from("payment_reconciliation_items").insert({
        reconciliation_run_id: run.id,
        org_id: orgId,
        disbursement_id: null,
        provider_reference: charge.provider_payment_id ? `${charge.provider_payment_id}:fee_charge` : `fee_charge:${charge.id}`,
        expected_cents: expectedFeeCents,
        provider_cents: providerCollectedCents,
        difference_cents: providerCollectedCents - expectedFeeCents,
        status: feeStatus,
      })
      if (feeItemError) throw new Error(`Unable to record fee-charge reconciliation: ${feeItemError.message}`)
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
            : false
      if (missingInternal) {
        exceptionCount += 1
        if (activity.kind === "payment") providerCents += activity.amountCents
        const { error: missingInternalError } = await supabase.from("payment_reconciliation_items").insert({
          reconciliation_run_id: run.id,
          org_id: orgId,
          disbursement_id: null,
          provider_reference: `${activity.kind}:${activity.providerReference}`,
          expected_cents: 0,
          provider_cents: activity.amountCents,
          difference_cents: activity.amountCents,
          status: "missing_internal",
        })
        if (missingInternalError) throw new Error(`Unable to record provider-only activity: ${missingInternalError.message}`)
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
        const { error: transferError } = await supabase.from("payment_reconciliation_items").insert({
          reconciliation_run_id: run.id,
          org_id: orgId,
          disbursement_id: local.id,
          provider_reference: `transfer:${activity.providerReference}`,
          expected_cents: expected,
          provider_cents: activity.amountCents,
          difference_cents: difference,
          status: itemStatus,
        })
        if (transferError) throw new Error(`Unable to reconcile vendor transfer: ${transferError.message}`)
      }

      if (activity.kind === "payout") {
        for (const transferId of activity.linkedReferences.filter((reference) => localTransferIds.has(reference))) {
          const local = disbursements.find((row) => row.provider_transfer_id === transferId)
          if (!local) continue
          const payoutMatches = !local.provider_payout_id || local.provider_payout_id === activity.providerReference
          const itemStatus = activity.status === "settled" && payoutMatches ? "matched" : "timing_difference"
          if (itemStatus !== "matched") exceptionCount += 1
          const expected = Number(local.amount_cents)
          const { error: payoutError } = await supabase.from("payment_reconciliation_items").insert({
            reconciliation_run_id: run.id,
            org_id: orgId,
            disbursement_id: local.id,
            provider_reference: `payout:${activity.providerReference}:transfer:${transferId}`,
            expected_cents: expected,
            provider_cents: itemStatus === "matched" ? expected : 0,
            difference_cents: itemStatus === "matched" ? 0 : -expected,
            status: itemStatus,
          })
          if (payoutError) throw new Error(`Unable to reconcile vendor payout: ${payoutError.message}`)
        }
      }
    }

    exceptionCount += await flagStalePaymentStates(run.id, orgId)
    await closeSupersededReconciliationExceptions(run.id, orgId)

    const differenceCents = providerCents - expectedCents
    const status = exceptionCount > 0 || differenceCents !== 0 ? "exceptions" : "balanced"
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
    await Promise.all([
      recordEvent({ orgId, actorId, eventType: "payment_reconciliation_completed", entityType: "payment_reconciliation_run", entityId: run.id, payload: { status, exception_count: exceptionCount, difference_cents: differenceCents } }),
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
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const periodStart = new Date(periodEnd.getTime() - 24 * 60 * 60 * 1000)
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
      const result = await performPaymentReconciliation({ period_start: periodStart.toISOString(), period_end: periodEnd.toISOString() }, policy.org_id)
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
