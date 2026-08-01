import "server-only"

import { z } from "zod"

import { getPaymentRailProvider } from "@/lib/integrations/payments/payment-rail-registry"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

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
    const { data: disbursements, error } = await supabase.from("disbursements")
      .select("id,provider_payment_id,status,amount_cents,processor_fee_cents,platform_fee_cents")
      .eq("org_id", orgId)
      .eq("provider", providerKey)
      .gte("created_at", parsed.period_start)
      .lt("created_at", parsed.period_end)
      .limit(1000)
    if (error) throw new Error(`Unable to load disbursements for reconciliation: ${error.message}`)

    let expectedCents = 0
    let providerCents = 0
    let exceptionCount = 0
    for (const disbursement of disbursements ?? []) {
      const expectedDebit = Number(disbursement.amount_cents) + Number(disbursement.processor_fee_cents) + Number(disbursement.platform_fee_cents)
      expectedCents += expectedDebit
      if (!disbursement.provider_payment_id) {
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
      const settlement = await provider.retrieveSettlement({ providerPaymentId: disbursement.provider_payment_id })
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

      const expectedProcessorFee = Number(disbursement.processor_fee_cents)
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

export async function runScheduledPaymentReconciliations(now = new Date()) {
  const supabase = createServiceSupabaseClient()
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const periodStart = new Date(periodEnd.getTime() - 24 * 60 * 60 * 1000)
  const { data: policies, error } = await supabase.from("payment_rail_policies")
    .select("org_id")
    .eq("enabled", true)
    .order("updated_at", { ascending: true })
    .limit(20)
  if (error) throw new Error(`Unable to load organizations for payment reconciliation: ${error.message}`)
  const results: Array<{ orgId: string; status: string; error?: string }> = []
  for (const policy of policies ?? []) {
    try {
      const result = await performPaymentReconciliation({ period_start: periodStart.toISOString(), period_end: periodEnd.toISOString() }, policy.org_id)
      results.push({ orgId: policy.org_id, status: result.status })
    } catch (caught) {
      results.push({ orgId: policy.org_id, status: "failed", error: caught instanceof Error ? caught.message : String(caught) })
    }
  }
  return results
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
