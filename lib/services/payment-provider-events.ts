import "server-only"

import Stripe from "stripe"

import { getPaymentRailProvider } from "@/lib/integrations/payments/payment-rail-registry"
import { retrieveStripeChargeWithBalanceTransaction } from "@/lib/integrations/payments/stripe"
import {
  assertDisbursementTransition,
  planDisbursementAdvance,
  resolveRunItemStatus,
  resolveRunStatus,
  type DisbursementStatus,
  type UnpaidTerminalStatus,
} from "@/lib/payments/payment-domain"
import { enqueueBillPaymentSync, voidBillPaymentInAccounting } from "@/lib/services/accounting-sync"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import {
  postApFeeChargeReversalLedger,
  postApReturnLossLedger,
  postDisbursementPaidLedger,
  postDisbursementReturnLedger,
  postDisbursementSubmissionReversalLedger,
} from "@/lib/services/payment-ledger"
import { syncVendorRecipient } from "@/lib/services/payment-rail-setup"
import { sendVendorRemittanceAdvice } from "@/lib/services/vendor-remittance"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

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

async function rollUpTerminalDisbursement(disbursement: Record<string, unknown>, target: UnpaidTerminalStatus, reason?: string) {
  const supabase = createServiceSupabaseClient()
  const orgId = String(disbursement.org_id)
  const runItemPayeeId = String(disbursement.run_item_payee_id)
  const runItemId = String(disbursement.run_item_id)
  const runId = String(disbursement.run_id)
  await supabase.from("payment_run_item_payees").update({ status: target }).eq("org_id", orgId).eq("id", runItemPayeeId)
  const { data: payees } = await supabase.from("payment_run_item_payees").select("status").eq("org_id", orgId).eq("run_item_id", runItemId)
  const itemStatus = resolveRunItemStatus((payees ?? []).map((payee) => payee.status), target)
  await supabase.from("payment_run_items").update({ status: itemStatus, ...(reason ? { failure_reason: reason } : {}) }).eq("org_id", orgId).eq("id", runItemId)
  const { data: items } = await supabase.from("payment_run_items").select("status").eq("org_id", orgId).eq("run_id", runId)
  const runStatus = resolveRunStatus((items ?? []).map((item) => item.status))
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
  // An empty plan is the answer for duplicates, stale events, and anything
  // arriving after a terminal state. All three must leave the row alone.
  const path = planDisbursementAdvance(current, target)
  if (path.length === 0) return data
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
  // The outbox is deduplicated. Enqueue even when the money mutation was a
  // duplicate so a crash between settlement and enqueue repairs itself.
  if (typeof result.payment_id === "string") await enqueueBillPaymentSync(result.payment_id, orgId)
  // Tell the vendor what the deposit covers. Never let a failure here fail the
  // webhook: the money has moved, and a bounced email is not a reason to
  // reprocess a settlement.
  await sendVendorRemittanceAdvice({ orgId, disbursementId }).catch(() => undefined)
  await Promise.all([
    recordEvent({ orgId, eventType: "vendor_payment_paid", entityType: "disbursement", entityId: disbursementId, payload: { bill_id: input.disbursement.bill_id, amount_cents: input.disbursement.amount_cents, provider_payout_id: input.providerPayoutId } }),
    recordAudit({ orgId, action: "update", entityType: "disbursement", entityId: disbursementId, after: { status: "paid", provider_payout_id: input.providerPayoutId }, source: "stripe_webhook" }),
  ])
}

async function processDisbursementReturn(input: { disbursement: Record<string, unknown>; providerEventId: string; providerReversalId: string; reason: string; occurredAt: string }) {
  const supabase = createServiceSupabaseClient()
  const orgId = String(input.disbursement.org_id)
  const disbursementId = String(input.disbursement.id)
  const wasPaid = input.disbursement.status === "paid"
  if (wasPaid) {
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
    // Arc has just reopened the bill. Until the accounting system agrees, the
    // two ledgers disagree about whether this vendor was paid, so the reversal
    // is pushed inline and a failure retries the webhook rather than being
    // swallowed. Only a settled payment was ever pushed, so only that path
    // has anything to reverse.
    const reversal = data as Record<string, unknown>
    const paymentId = typeof reversal.payment_id === "string" ? reversal.payment_id : null
    if (paymentId) {
      await voidBillPaymentInAccounting({ orgId, paymentId, reason: input.reason })
    }
  } else {
    // `planDisbursementAdvance` routes a pre-settlement return through
    // funds_available on its own, so this no longer pre-walks by hand.
    await advanceDisbursement(disbursementId, orgId, "returned", {
      failure_reason: input.reason,
      returned_at: input.occurredAt,
    })
  }
  if (wasPaid) {
    await postDisbursementReturnLedger({ orgId, disbursementId, providerEventId: input.providerEventId, amountCents: Number(input.disbursement.amount_cents), currency: String(input.disbursement.currency), effectiveAt: input.occurredAt })
    // The vendor already has the money and the builder's bank took it back, so
    // this one survived the payout hold and is a real loss. Book it, then check
    // whether this org has now cost enough to stop paying through Arc.
    await postApReturnLossLedger({ orgId, disbursementId, providerEventId: input.providerEventId, amountCents: Number(input.disbursement.amount_cents), currency: String(input.disbursement.currency), effectiveAt: input.occurredAt })
    await enforceReturnLossCeiling(orgId)
  } else {
    await postDisbursementSubmissionReversalLedger({ orgId, disbursementId, providerEventId: input.providerEventId, vendorAmountCents: Number(input.disbursement.amount_cents), currency: String(input.disbursement.currency), effectiveAt: input.occurredAt })
  }
  await recordEvent({ orgId, eventType: "vendor_payment_returned", entityType: "disbursement", entityId: disbursementId, payload: { bill_id: input.disbursement.bill_id, reason: input.reason } })
}

/**
 * Trip an org's rail off once its unrecovered return losses reach the ceiling.
 *
 * The ceiling is the difference between a documented risk appetite and an
 * unbounded one. Disabling the org flag rather than the platform switch keeps
 * one bad customer from stopping everyone else's payroll, and the alert names
 * the number so a human can decide whether to raise it or keep them off.
 */
async function enforceReturnLossCeiling(orgId: string) {
  const supabase = createServiceSupabaseClient()
  const { data: policy } = await supabase
    .from("payment_rail_policies")
    .select("return_loss_ceiling_cents")
    .eq("org_id", orgId)
    .maybeSingle()
  const ceilingCents = policy?.return_loss_ceiling_cents == null ? null : Number(policy.return_loss_ceiling_cents)
  if (!ceilingCents) return

  // Sum the loss account itself rather than counting returns: it is the only
  // figure that already accounts for whatever was recovered.
  const { data: entries, error } = await supabase
    .from("payment_ledger_entries")
    .select("amount_cents,direction,transaction:payment_ledger_transactions!inner(org_id)")
    .eq("account_code", "ach_return_loss")
    .eq("payment_ledger_transactions.org_id", orgId)
    .limit(5_000)
  if (error) return
  const lossCents = (entries ?? []).reduce(
    (sum, entry) => sum + (entry.direction === "debit" ? Number(entry.amount_cents) : -Number(entry.amount_cents)),
    0,
  )
  if (lossCents < ceilingCents) return

  await supabase.from("feature_flags").upsert(
    { org_id: orgId, flag_key: "fintech_ap_payments", enabled: false, updated_at: new Date().toISOString() },
    { onConflict: "org_id,flag_key" },
  )
  await Promise.all([
    recordEvent({
      orgId,
      eventType: "payment_operations_alert",
      entityType: "payment_rail_policy",
      entityId: orgId,
      payload: {
        findings: [{
          code: "return_loss_ceiling_reached",
          detail: `Unrecovered ACH return losses reached the configured ceiling. Electronic payments are disabled for this organization pending review.`,
        }],
        loss_cents: lossCents,
        ceiling_cents: ceilingCents,
      },
    }),
    recordAudit({
      orgId,
      action: "update",
      entityType: "feature_flag",
      entityId: orgId,
      after: { flag_key: "fintech_ap_payments", enabled: false, reason: "return_loss_ceiling_reached", loss_cents: lossCents },
      source: "stripe_webhook",
    }),
  ])
}

/**
 * When this org's cleared funds may be transferred to the vendor.
 *
 * A zero hold is a legitimate choice — it reproduces the old destination-charge
 * timing — so it is expressible rather than clamped to a minimum Arc decided.
 */
async function resolvePayoutHoldExpiry(orgId: string, clearedAt: string): Promise<string> {
  const supabase = createServiceSupabaseClient()
  const { data } = await supabase.from("payment_rail_policies").select("payout_hold_hours").eq("org_id", orgId).maybeSingle()
  const hours = Number(data?.payout_hold_hours ?? 48)
  return new Date(new Date(clearedAt).getTime() + hours * 60 * 60 * 1000).toISOString()
}

function stripePayload(event: Stripe.Event) {
  return JSON.parse(JSON.stringify(event)) as Record<string, unknown>
}

/**
 * Terminal state for Arc's own per-run fee debit.
 *
 * A failed collection reverses the cash side and leaves the liability standing:
 * the fee was earned when the vendors were paid, so a failed pull is a
 * receivable someone chases, not a debt that quietly disappears.
 */
async function processFeeChargeEvent(input: {
  event: Stripe.Event
  intent: Stripe.PaymentIntent
  occurredAt: string
  startedAt: string
  providerAccountId: string | null
}): Promise<{ handled: boolean; duplicate?: boolean }> {
  const supabase = createServiceSupabaseClient()
  const { data: charge } = await supabase
    .from("payment_run_fee_charges")
    .select("id,org_id,run_id,status,amount_cents,currency")
    .eq("provider", "stripe")
    .eq("provider_payment_id", input.intent.id)
    .maybeSingle()
  if (!charge) return { handled: false }

  const target = input.event.type === "payment_intent.processing"
    ? "debit_pending"
    : input.event.type === "payment_intent.succeeded"
      ? "succeeded"
      : input.event.type === "payment_intent.payment_failed"
        ? "failed"
        : input.event.type === "payment_intent.canceled"
          ? "canceled"
          : null
  if (!target) return { handled: false }

  const providerEvent = await recordProviderEvent({
    provider: "stripe",
    providerEventId: input.event.id,
    providerAccountId: input.providerAccountId,
    orgId: String(charge.org_id),
    eventType: input.event.type,
    eventCreatedAt: input.occurredAt,
    payload: stripePayload(input.event),
  })
  if (providerEvent.duplicate && await providerEventCompleted(providerEvent.id)) return { handled: true, duplicate: true }

  try {
    // Terminal states are final; a late `processing` after `succeeded` is a
    // stale delivery, not a regression to walk backwards into.
    if (["succeeded", "failed", "canceled"].includes(String(charge.status))) {
      await recordProcessingAttempt({ providerEventId: providerEvent.id, outcome: "ignored", startedAt: input.startedAt })
      return { handled: true }
    }
    await supabase.from("payment_run_fee_charges").update({
      status: target,
      ...(target === "succeeded" ? { settled_at: input.occurredAt } : {}),
      ...(target === "failed" || target === "canceled" ? { failure_reason: `Provider reported ${input.event.type}` } : {}),
    }).eq("org_id", charge.org_id).eq("id", charge.id)

    if (target === "failed" || target === "canceled") {
      await postApFeeChargeReversalLedger({
        orgId: String(charge.org_id),
        runId: String(charge.run_id),
        feeChargeId: String(charge.id),
        amountCents: Number(charge.amount_cents),
        currency: String(charge.currency),
        effectiveAt: input.occurredAt,
      })
      await recordEvent({
        orgId: String(charge.org_id),
        eventType: "payment_run_fee_charge_failed",
        entityType: "payment_run",
        entityId: String(charge.run_id),
        payload: { fee_charge_id: charge.id, amount_cents: charge.amount_cents, error: `Provider reported ${input.event.type}` },
      })
    }
    await recordProcessingAttempt({ providerEventId: providerEvent.id, outcome: "processed", startedAt: input.startedAt })
    return { handled: true }
  } catch (error) {
    await recordProcessingAttempt({ providerEventId: providerEvent.id, outcome: "failed", error: error instanceof Error ? error.message : String(error), startedAt: input.startedAt })
    throw error
  }
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
  let transferReleaseAfter: string | null = null
  let returnReason = "ACH payment returned"

  if (event.type.startsWith("payment_intent.")) {
    const intent = event.data.object as Stripe.PaymentIntent
    if (intent.metadata.arc_product !== "vendor_payments") return { handled: false }
    // Arc's own fee debit rides the same rail and the same event types, but has
    // no disbursement behind it. Without this branch its terminal state would
    // never arrive and every fee charge would sit at `submitted` forever.
    if (intent.metadata.charge_type === "platform_fee") {
      return processFeeChargeEvent({ event, intent, occurredAt, startedAt, providerAccountId })
    }
    const disbursement = intent.metadata.disbursement_id
      ? await createServiceSupabaseClient().from("disbursements").select("*").eq("id", intent.metadata.disbursement_id).maybeSingle().then((result) => result.data)
      : await resolveDisbursementByPaymentId(intent.id)
    if (!disbursement) return { handled: false }
    disbursements = [disbursement]
    if (event.type === "payment_intent.processing") targetStatus = "debit_pending"
    else if (event.type === "payment_intent.succeeded") {
      targetStatus = "funds_available"
      // The debit has cleared to Arc. The hold starts now, and the vendor
      // transfer is created by the release sweep once it expires — a return
      // arriving inside the window costs nothing because no transfer exists yet.
      transferReleaseAfter = await resolvePayoutHoldExpiry(String(disbursement.org_id), occurredAt)
    }
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
    const actualProcessorFeeCents = balance?.fee ?? 0
    const platformFeeCents = Number(disbursement.platform_fee_cents ?? 0)
    // What the builder was quoted and charged, frozen on the approved run. Kept
    // apart from the actual below because they answer different questions.
    const quotedProcessorFeeCents = Number(disbursement.processor_fee_cents ?? 0)
    const providerEvent = await recordProviderEvent({ provider: "stripe", providerEventId: event.id, providerAccountId, orgId: String(disbursement.org_id), disbursementId: String(disbursement.id), eventType: event.type, eventCreatedAt: occurredAt, payload: stripePayload(event) })
    if (providerEvent.duplicate && await providerEventCompleted(providerEvent.id)) return { handled: true, duplicate: true }
    try {
      const supabase = createServiceSupabaseClient()
      // Record what the provider actually charged Arc, alongside — not over —
      // what the builder was quoted. The quote is what the approver signed for
      // and what the fee debit collected; the actual is Arc's own cost, and the
      // difference is Arc's margin. Overwriting the quote with the actual would
      // erase the evidence of what was charged.
      const { error: chargeUpdateError } = await supabase.from("disbursements").update({
        provider_charge_id: charge.id,
        provider_balance_transaction_id: balance?.id ?? null,
        actual_processor_fee_cents: actualProcessorFeeCents,
      }).eq("id", disbursement.id).eq("org_id", disbursement.org_id)
      if (chargeUpdateError) throw new Error(`Unable to record provider charge and actual fee: ${chargeUpdateError.message}`)
      // Revenue recognition, per disbursement, at the quoted amounts that were
      // actually collected. Pass-through cost and Arc's own margin stay
      // reportable apart: one is recovered at cost, the other is margin.
      const feeEvents = [
        { kind: "ap_processor_passthrough" as const, feeCents: quotedProcessorFeeCents, suffix: "processor_fee" },
        { kind: "ap_disbursement" as const, feeCents: platformFeeCents, suffix: "platform_fee" },
      ].filter((entry) => entry.feeCents > 0)
      if (feeEvents.length > 0) {
        const { error: feeEventError } = await supabase.from("platform_fee_events").upsert(
          feeEvents.map((entry) => ({
            org_id: disbursement.org_id,
            disbursement_id: disbursement.id,
            provider_event_id: providerEvent.id,
            kind: entry.kind,
            fee_cents: entry.feeCents,
            currency: disbursement.currency,
            provider_reference: charge.id,
            idempotency_key: `disbursement:${disbursement.id}:${entry.suffix}`,
            recognized_at: occurredAt,
          })),
          { onConflict: "org_id,idempotency_key", ignoreDuplicates: true },
        )
        if (feeEventError) throw new Error(`Unable to record AP fees: ${feeEventError.message}`)
      }
      // No ledger posting here. The fee liability was recognised and cleared at
      // run execution against the approved amounts; posting again on settlement
      // would double-count it in the builder's books.
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
      const message = "Provider payout is known to Arc but its transfers are not resolvable yet"
      await recordProcessingAttempt({ providerEventId: providerEvent.id, outcome: "failed", error: message, startedAt })
      throw new Error(message)
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
        if (transferReleaseAfter) patch.transfer_release_after = transferReleaseAfter
        if (targetStatus === "failed") patch.failure_reason = "Provider reported payment failure"
        await advanceDisbursement(disbursementId, orgId, targetStatus, patch)
        if (targetStatus === "failed" || targetStatus === "canceled") {
          await postDisbursementSubmissionReversalLedger({ orgId, disbursementId, providerEventId: providerEvent.id, vendorAmountCents: Number(disbursement.amount_cents), currency: String(disbursement.currency), effectiveAt: occurredAt })
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
