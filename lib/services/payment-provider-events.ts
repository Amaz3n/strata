import "server-only"

import Stripe from "stripe"

import { getPaymentRailProvider } from "@/lib/integrations/payments/payment-rail-registry"
import { retrieveStripeChargeWithBalanceTransaction } from "@/lib/integrations/payments/stripe"
import { assertDisbursementTransition, type DisbursementStatus } from "@/lib/payments/payment-domain"
import { enqueueBillPaymentSync } from "@/lib/services/accounting-sync"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import {
  postDisbursementPaidLedger,
  postDisbursementReturnLedger,
} from "@/lib/services/payment-ledger"
import { syncVendorRecipient } from "@/lib/services/payment-rail-setup"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

const FORWARD_PATH: DisbursementStatus[] = [
  "created",
  "submitted",
  "debit_pending",
  "funds_available",
  "transfer_pending",
  "payout_pending",
  "paid",
]

async function recordProviderEvent(input: {
  provider: string
  providerEventId: string
  providerAccountId?: string | null
  orgId?: string | null
  disbursementId?: string | null
  eventType: string
  eventCreatedAt?: string | null
  payload: Record<string, unknown>
}) {
  const supabase = createServiceSupabaseClient()
  const { data: existing } = await supabase.from("payment_provider_events").select("id").eq("provider", input.provider).eq("provider_event_id", input.providerEventId).maybeSingle()
  if (existing) return { id: existing.id, duplicate: true }
  const { data, error } = await supabase.from("payment_provider_events").insert({
    provider: input.provider,
    provider_event_id: input.providerEventId,
    provider_account_id: input.providerAccountId ?? null,
    org_id: input.orgId ?? null,
    disbursement_id: input.disbursementId ?? null,
    event_type: input.eventType,
    event_created_at: input.eventCreatedAt ?? null,
    payload: input.payload,
  }).select("id").single()
  if (error || !data) throw new Error(`Unable to store provider event: ${error?.message}`)
  return { id: data.id, duplicate: false }
}

async function recordProcessingAttempt(input: { providerEventId: string; outcome: "processed" | "ignored" | "failed"; error?: string | null; startedAt: string }) {
  const supabase = createServiceSupabaseClient()
  const { count } = await supabase.from("payment_provider_event_attempts").select("id", { count: "exact", head: true }).eq("provider_event_id", input.providerEventId)
  const { error } = await supabase.from("payment_provider_event_attempts").insert({
    provider_event_id: input.providerEventId,
    attempt_number: (count ?? 0) + 1,
    outcome: input.outcome,
    processing_error: input.error ?? null,
    started_at: input.startedAt,
    completed_at: new Date().toISOString(),
  })
  if (error) throw new Error(`Unable to record provider event attempt: ${error.message}`)
}

async function providerEventCompleted(providerEventId: string) {
  const supabase = createServiceSupabaseClient()
  const { count } = await supabase.from("payment_provider_event_attempts")
    .select("id", { count: "exact", head: true })
    .eq("provider_event_id", providerEventId)
    .in("outcome", ["processed", "ignored"])
  return (count ?? 0) > 0
}

async function rollUpTerminalDisbursement(disbursement: Record<string, unknown>, target: "failed" | "returned" | "canceled", reason?: string) {
  const supabase = createServiceSupabaseClient()
  const orgId = String(disbursement.org_id)
  const runItemPayeeId = String(disbursement.run_item_payee_id)
  const runItemId = String(disbursement.run_item_id)
  const runId = String(disbursement.run_id)
  await supabase.from("payment_run_item_payees").update({ status: target }).eq("org_id", orgId).eq("id", runItemPayeeId)
  const { data: payees } = await supabase.from("payment_run_item_payees").select("status").eq("org_id", orgId).eq("run_item_id", runItemId)
  const payeeStatuses = (payees ?? []).map((payee) => payee.status)
  const itemStatus = payeeStatuses.every((status) => status === "paid")
    ? "paid"
    : payeeStatuses.some((status) => status === "paid")
      ? "partially_paid"
      : payeeStatuses.every((status) => ["failed", "returned", "canceled"].includes(status))
        ? target
        : "processing"
  await supabase.from("payment_run_items").update({ status: itemStatus, ...(reason ? { failure_reason: reason } : {}) }).eq("org_id", orgId).eq("id", runItemId)
  const { data: items } = await supabase.from("payment_run_items").select("status").eq("org_id", orgId).eq("run_id", runId)
  const itemStatuses = (items ?? []).map((item) => item.status)
  const runStatus = itemStatuses.every((status) => status === "paid")
    ? "paid"
    : itemStatuses.some((status) => ["paid", "partially_paid"].includes(status)) && itemStatuses.some((status) => ["failed", "returned", "canceled"].includes(status))
      ? "partially_failed"
      : itemStatuses.every((status) => ["failed", "returned", "canceled"].includes(status))
        ? "failed"
        : itemStatuses.some((status) => ["paid", "partially_paid"].includes(status))
          ? "partially_paid"
          : "processing"
  await supabase.from("payment_runs").update({
    status: runStatus,
    ...(["paid", "partially_failed", "failed"].includes(runStatus) ? { completed_at: new Date().toISOString() } : {}),
  }).eq("org_id", orgId).eq("id", runId)
}

async function advanceDisbursement(disbursementId: string, orgId: string, target: DisbursementStatus, patch: Record<string, unknown> = {}) {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase.from("disbursements").select("id,status").eq("org_id", orgId).eq("id", disbursementId).maybeSingle()
  if (error || !data) throw new Error("Disbursement was not found")
  const current = data.status as DisbursementStatus
  if (current === target) return data
  if (["failed", "returned", "reversed", "canceled"].includes(current)) return data
  const currentIndex = FORWARD_PATH.indexOf(current)
  const targetIndex = FORWARD_PATH.indexOf(target)
  if (targetIndex >= 0 && currentIndex >= targetIndex) return data
  const path = targetIndex >= 0 && currentIndex >= 0 ? FORWARD_PATH.slice(currentIndex + 1, targetIndex + 1) : [target]
  let from = current
  for (const next of path) {
    assertDisbursementTransition(from, next)
    const update = next === target ? { status: next, ...patch } : { status: next }
    const { error: updateError } = await supabase.from("disbursements").update(update).eq("org_id", orgId).eq("id", disbursementId).eq("status", from)
    if (updateError) throw new Error(`Unable to advance disbursement: ${updateError.message}`)
    from = next
  }
  return { id: disbursementId, status: target }
}

async function resolveDisbursementByPaymentId(providerPaymentId: string) {
  const supabase = createServiceSupabaseClient()
  const { data } = await supabase.from("disbursements").select("*").eq("provider", "stripe").eq("provider_payment_id", providerPaymentId).maybeSingle()
  return data
}

async function processDisbursementPaid(input: { disbursement: Record<string, unknown>; providerEventId: string; providerPayoutId: string; paidAt: string }) {
  const supabase = createServiceSupabaseClient()
  const disbursementId = String(input.disbursement.id)
  const orgId = String(input.disbursement.org_id)
  const { data, error } = await supabase.rpc("record_ap_payment_atomic", {
    p_org_id: orgId,
    p_disbursement_id: disbursementId,
    p_provider_payment_id: String(input.disbursement.provider_payment_id),
    p_provider_charge_id: input.disbursement.provider_charge_id ?? null,
    p_provider_transfer_id: input.disbursement.provider_transfer_id ?? null,
    p_provider_payout_id: input.providerPayoutId,
    p_provider_balance_transaction_id: input.disbursement.provider_balance_transaction_id ?? null,
    p_paid_at: input.paidAt,
  })
  if (error || !data) throw new Error(`Unable to record AP payment: ${error?.message}`)
  await postDisbursementPaidLedger({
    orgId,
    disbursementId,
    providerEventId: input.providerEventId,
    amountCents: Number(input.disbursement.amount_cents),
    currency: String(input.disbursement.currency),
    effectiveAt: input.paidAt,
  })
  const result = data as Record<string, unknown>
  if (typeof result.payment_id === "string" && !result.duplicate) await enqueueBillPaymentSync(result.payment_id, orgId)
  await Promise.all([
    recordEvent({ orgId, eventType: "vendor_payment_paid", entityType: "disbursement", entityId: disbursementId, payload: { bill_id: input.disbursement.bill_id, amount_cents: input.disbursement.amount_cents, provider_payout_id: input.providerPayoutId } }),
    recordAudit({ orgId, action: "update", entityType: "disbursement", entityId: disbursementId, after: { status: "paid", provider_payout_id: input.providerPayoutId }, source: "stripe_webhook" }),
  ])
}

async function processDisbursementReturn(input: { disbursement: Record<string, unknown>; providerEventId: string; providerReversalId: string; reason: string; occurredAt: string }) {
  const supabase = createServiceSupabaseClient()
  const orgId = String(input.disbursement.org_id)
  const disbursementId = String(input.disbursement.id)
  if (input.disbursement.status === "paid") {
    const { data, error } = await supabase.rpc("record_ap_payment_reversal_atomic", {
      p_org_id: orgId,
      p_disbursement_id: disbursementId,
      p_amount_cents: Number(input.disbursement.amount_cents),
      p_reversal_type: "ach_return",
      p_provider_reversal_id: input.providerReversalId,
      p_reason: input.reason,
      p_metadata: { provider_event_id: input.providerEventId },
    })
    if (error || !data) throw new Error(`Unable to record AP return: ${error?.message}`)
  } else {
    if (["created", "submitted", "debit_pending"].includes(String(input.disbursement.status))) {
      await advanceDisbursement(disbursementId, orgId, "funds_available")
    }
    await advanceDisbursement(disbursementId, orgId, "returned", {
      failure_reason: input.reason,
      returned_at: input.occurredAt,
    })
  }
  await postDisbursementReturnLedger({
    orgId,
    disbursementId,
    providerEventId: input.providerEventId,
    amountCents: Number(input.disbursement.amount_cents),
    currency: String(input.disbursement.currency),
    effectiveAt: input.occurredAt,
  })
  await recordEvent({ orgId, eventType: "vendor_payment_returned", entityType: "disbursement", entityId: disbursementId, payload: { bill_id: input.disbursement.bill_id, reason: input.reason } })
}

function stripePayload(event: Stripe.Event) {
  return JSON.parse(JSON.stringify(event)) as Record<string, unknown>
}

export async function processStripeApEvent(event: Stripe.Event): Promise<{ handled: boolean; duplicate?: boolean }> {
  const startedAt = new Date().toISOString()
  const occurredAt = new Date(event.created * 1000).toISOString()
  const providerAccountId = typeof event.account === "string" ? event.account : null

  if (event.type === "account.updated") {
    const account = event.data.object as Stripe.Account
    const synced = await syncVendorRecipient(account.id)
    if (!synced) return { handled: false }
    const providerEvent = await recordProviderEvent({
      provider: "stripe",
      providerEventId: event.id,
      providerAccountId: account.id,
      eventType: event.type,
      eventCreatedAt: occurredAt,
      payload: stripePayload(event),
    })
    if (providerEvent.duplicate && await providerEventCompleted(providerEvent.id)) return { handled: true, duplicate: true }
    await recordProcessingAttempt({ providerEventId: providerEvent.id, outcome: "processed", startedAt })
    return { handled: true }
  }

  let disbursements: Array<Record<string, unknown>> = []
  let targetStatus: DisbursementStatus | null = null
  let providerTransferId: string | null = null
  let providerPayoutId: string | null = null
  let providerReversalId: string | null = null
  let returnReason = "ACH payment returned"

  if (event.type.startsWith("payment_intent.")) {
    const intent = event.data.object as Stripe.PaymentIntent
    if (intent.metadata.arc_product !== "vendor_payments") return { handled: false }
    const disbursement = intent.metadata.disbursement_id
      ? await createServiceSupabaseClient().from("disbursements").select("*").eq("id", intent.metadata.disbursement_id).maybeSingle().then((result) => result.data)
      : await resolveDisbursementByPaymentId(intent.id)
    if (!disbursement) return { handled: false }
    disbursements = [disbursement]
    if (event.type === "payment_intent.processing") targetStatus = "debit_pending"
    else if (event.type === "payment_intent.succeeded") targetStatus = "funds_available"
    else if (event.type === "payment_intent.payment_failed") targetStatus = "failed"
    else if (event.type === "payment_intent.canceled") targetStatus = "canceled"
    else return { handled: false }
  } else if (event.type === "transfer.created") {
    const transfer = event.data.object as Stripe.Transfer
    const paymentId = await getPaymentRailProvider("stripe").resolveTransferPaymentId({ providerTransferId: transfer.id })
    const disbursement = paymentId ? await resolveDisbursementByPaymentId(paymentId) : null
    if (!disbursement) return { handled: false }
    disbursements = [disbursement]
    targetStatus = "transfer_pending"
    providerTransferId = transfer.id
  } else if (event.type === "payout.paid") {
    if (!providerAccountId) return { handled: false }
    const supabase = createServiceSupabaseClient()
    const { data: recipient } = await supabase.from("payment_recipient_accounts").select("id").eq("provider", "stripe").eq("provider_account_id", providerAccountId).maybeSingle()
    if (!recipient) return { handled: false }
    const payout = event.data.object as Stripe.Payout
    const transferIds = await getPaymentRailProvider("stripe").resolvePayoutTransferIds({ providerAccountId, providerPayoutId: payout.id })
    if (transferIds.length > 0) {
      const { data } = await supabase.from("disbursements").select("*").eq("provider", "stripe").eq("recipient_account_id", recipient.id).in("provider_transfer_id", transferIds)
      disbursements = data ?? []
    }
    providerPayoutId = payout.id
    targetStatus = "paid"
  } else if (event.type === "charge.dispute.created") {
    const dispute = event.data.object as Stripe.Dispute
    const paymentId = typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id
    const disbursement = paymentId ? await resolveDisbursementByPaymentId(paymentId) : null
    if (!disbursement) return { handled: false }
    disbursements = [disbursement]
    targetStatus = "returned"
    providerReversalId = dispute.id
    returnReason = dispute.reason ?? returnReason
  } else if (event.type === "charge.succeeded") {
    const chargeEvent = event.data.object as Stripe.Charge
    const paymentId = typeof chargeEvent.payment_intent === "string" ? chargeEvent.payment_intent : chargeEvent.payment_intent?.id
    const disbursement = paymentId ? await resolveDisbursementByPaymentId(paymentId) : null
    if (!disbursement) return { handled: false }
    const charge = await retrieveStripeChargeWithBalanceTransaction(chargeEvent.id, providerAccountId)
    const balance = charge.balance_transaction && typeof charge.balance_transaction !== "string" ? charge.balance_transaction : null
    const processorFeeCents = balance?.fee ?? 0
    const platformFeeCents = Number(disbursement.platform_fee_cents ?? 0)
    const providerEvent = await recordProviderEvent({ provider: "stripe", providerEventId: event.id, providerAccountId, orgId: String(disbursement.org_id), disbursementId: String(disbursement.id), eventType: event.type, eventCreatedAt: occurredAt, payload: stripePayload(event) })
    if (providerEvent.duplicate && await providerEventCompleted(providerEvent.id)) return { handled: true, duplicate: true }
    try {
      const supabase = createServiceSupabaseClient()
      await supabase.from("disbursements").update({ provider_charge_id: charge.id, provider_balance_transaction_id: balance?.id ?? null }).eq("id", disbursement.id).eq("org_id", disbursement.org_id)
      if (platformFeeCents > 0) {
        const { error: feeEventError } = await supabase.from("platform_fee_events").upsert({ org_id: disbursement.org_id, disbursement_id: disbursement.id, provider_event_id: providerEvent.id, kind: "ap_disbursement", fee_cents: platformFeeCents, currency: disbursement.currency, provider_reference: charge.id, idempotency_key: `disbursement:${disbursement.id}:platform_fee`, recognized_at: occurredAt }, { onConflict: "org_id,idempotency_key", ignoreDuplicates: true })
        if (feeEventError) throw new Error(`Unable to record platform fee: ${feeEventError.message}`)
      }
      await recordProcessingAttempt({ providerEventId: providerEvent.id, outcome: "processed", startedAt })
      return { handled: true }
    } catch (error) {
      await recordProcessingAttempt({ providerEventId: providerEvent.id, outcome: "failed", error: error instanceof Error ? error.message : String(error), startedAt })
      throw error
    }
  } else {
    return { handled: false }
  }

  const first = disbursements[0]
  const providerEvent = await recordProviderEvent({
    provider: "stripe",
    providerEventId: event.id,
    providerAccountId,
    orgId: disbursements.length === 1 ? String(first.org_id) : null,
    disbursementId: disbursements.length === 1 ? String(first.id) : null,
    eventType: event.type,
    eventCreatedAt: occurredAt,
    payload: stripePayload(event),
  })
  if (providerEvent.duplicate && await providerEventCompleted(providerEvent.id)) return { handled: true, duplicate: true }

  try {
    if (disbursements.length === 0) {
      await recordProcessingAttempt({ providerEventId: providerEvent.id, outcome: "ignored", startedAt })
      return { handled: true }
    }
    for (const disbursement of disbursements) {
      const orgId = String(disbursement.org_id)
      const disbursementId = String(disbursement.id)
      if (targetStatus === "paid" && providerPayoutId) {
        if (providerTransferId) await advanceDisbursement(disbursementId, orgId, "transfer_pending", { provider_transfer_id: providerTransferId })
        await advanceDisbursement(disbursementId, orgId, "payout_pending", { provider_payout_id: providerPayoutId })
        await processDisbursementPaid({ disbursement: { ...disbursement, provider_payout_id: providerPayoutId }, providerEventId: providerEvent.id, providerPayoutId, paidAt: occurredAt })
      } else if (targetStatus === "returned" && providerReversalId) {
        await processDisbursementReturn({ disbursement, providerEventId: providerEvent.id, providerReversalId, reason: returnReason, occurredAt })
        if (disbursement.status !== "paid") await rollUpTerminalDisbursement(disbursement, "returned", returnReason)
      } else if (targetStatus) {
        const patch: Record<string, unknown> = {}
        if (providerTransferId) patch.provider_transfer_id = providerTransferId
        if (targetStatus === "failed") patch.failure_reason = "Provider reported payment failure"
        await advanceDisbursement(disbursementId, orgId, targetStatus, patch)
        if (targetStatus === "failed" || targetStatus === "canceled") {
          await rollUpTerminalDisbursement(disbursement, targetStatus, typeof patch.failure_reason === "string" ? patch.failure_reason : undefined)
        }
      }
    }
    await recordProcessingAttempt({ providerEventId: providerEvent.id, outcome: "processed", startedAt })
    return { handled: true }
  } catch (error) {
    await recordProcessingAttempt({ providerEventId: providerEvent.id, outcome: "failed", error: error instanceof Error ? error.message : String(error), startedAt })
    throw error
  }
}
