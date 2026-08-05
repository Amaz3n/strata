import "server-only"

import { z } from "zod"

import { getPaymentRailProvider } from "@/lib/integrations/payments/payment-rail-registry"
import { mapWithConcurrency } from "@/lib/payments/concurrency"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/** Provider round-trips in flight while reconciling one org's period. */
const SETTLEMENT_CONCURRENCY = 8
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
      .select("id,provider_payment_id,status,amount_cents,processor_fee_cents,actual_processor_fee_cents,platform_fee_cents")
      .eq("org_id", orgId).eq("provider", provider).gte("created_at", periodStart).lt("created_at", periodEnd)
      .order("created_at", { ascending: true }).order("id", { ascending: true })
      .range(from, from + pageSize - 1)
    if (error) throw new Error(`Unable to load disbursements for reconciliation: ${error.message}`)
    rows.push(...(data ?? []))
    if ((data ?? []).length < pageSize) break
  }
  return rows
}

async function performPaymentReconciliation(input: { period_start: string; period_end: string }, orgId: string, actorId?: string) {
  const parsed = reconciliationInputSchema.parse(input)
  const supabase = createServiceSupabaseClient()
  const providerKey = "stripe"
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
    const disbursements = await loadAllDisbursementsForPeriod(orgId, providerKey, parsed.period_start, parsed.period_end)

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
    await supabase.from("payment_rail_policies").update({ last_reconciled_at: new Date().toISOString() }).eq("org_id", orgId)
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
    .order("last_reconciled_at", { ascending: true, nullsFirst: true })
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
    } finally {
      // This is also a scheduler cursor. Advancing it on failure prevents one
      // broken org from starving every org behind it.
      await supabase.from("payment_rail_policies").update({ last_reconciled_at: new Date().toISOString() }).eq("org_id", policy.org_id)
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

export async function resolvePaymentReconciliationItem(input: { itemId: string; note: string }, orgId?: string) {
  const parsed = z.object({ itemId: z.string().uuid(), note: z.string().trim().min(8).max(1000) }).parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("payment.reconcile", context)
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase.from("payment_reconciliation_items").update({
    status: "resolved",
    resolution_note: parsed.note,
    resolved_by: context.userId,
    resolved_at: new Date().toISOString(),
  }).eq("id", parsed.itemId).eq("org_id", context.orgId).neq("status", "matched").select("id,reconciliation_run_id").maybeSingle()
  if (error || !data) throw new Error(`Unable to resolve reconciliation exception: ${error?.message ?? "Item was not found"}`)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "payment_reconciliation_item", entityId: data.id, after: { status: "resolved", resolution_note: parsed.note } })
  return data
}
