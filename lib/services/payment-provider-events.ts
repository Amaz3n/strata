import "server-only"

import { getPaymentRailProvider } from "@/lib/integrations/payments/payment-rail-registry"
import type {
  NormalizedPaymentRailEvent,
  PaymentRailProvider,
} from "@/lib/integrations/payments/payment-rail-provider"
import {
  assertDisbursementTransition,
  assertPaymentRunTransition,
  classifyReturnStage,
  isPaymentRunTerminal,
  planDisbursementAdvance,
  resolveRunItemStatus,
  resolveRunStatus,
  scheduleTransferRelease,
  type DisbursementStatus,
  type UnpaidTerminalStatus,
} from "@/lib/payments/payment-domain"
import {
  enqueueBillPaymentSync,
  enqueueBillPaymentVoid,
  recordPayableAccountingEnqueueResult,
} from "@/lib/services/accounting-sync"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import {
  postApFeeChargeReversalLedger,
  postApReturnLossLedger,
  postApReturnLossRecoveryLedger,
  postDisbursementPaidLedger,
  postDisbursementReturnLedger,
  postDisbursementSubmissionReversalLedger,
} from "@/lib/services/payment-ledger"
import {
  openPaymentOperationsIncident,
  resolvePaymentOperationsIncident,
} from "@/lib/services/ops-watchdog"
import { syncVendorRecipient } from "@/lib/services/payment-rail-setup"
import { sendVendorPaymentReturnNotice, sendVendorRemittanceAdvice } from "@/lib/services/vendor-remittance"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/** Page size for the return-loss ledger sum. */
const RETURN_LOSS_PAGE_SIZE = 1_000
/**
 * Hard ceiling on that walk. One entry per unrecovered return, so an org past
 * this has been far beyond any plausible loss ceiling for a long time — the
 * number exists to bound a webhook, not to be reached.
 */
const MAX_RETURN_LOSS_LEDGER_ENTRIES = 20_000

/**
 * ## Insert-first webhook idempotency — the canonical explanation
 *
 * The unique index on (provider, provider_event_id) decides, not a prior SELECT.
 * Two deliveries of the same Stripe event arriving together both saw "no row"
 * and both inserted; one won and the other threw a 23505 that read as a
 * processing failure, so Stripe retried an event that had in fact been stored.
 * Insert first, and treat the conflict as what it is — a duplicate.
 *
 * The AR half of the webhook (`app/api/webhooks/stripe/route.ts`, on
 * `webhook_events`) follows the same discipline against its own table and points
 * back here rather than restating it.
 */
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
  const { data, error } = await supabase.from("payment_provider_events").insert({
    provider: input.provider,
    provider_event_id: input.providerEventId,
    provider_account_id: input.providerAccountId ?? null,
    org_id: input.orgId ?? null,
    disbursement_id: input.disbursementId ?? null,
    event_type: input.eventType,
    event_created_at: input.eventCreatedAt ?? null,
    payload: input.payload,
  }).select("id").maybeSingle()
  if (!error && data) return { id: String(data.id), duplicate: false, completed: false }
  if (error && (error as { code?: string }).code !== "23505") {
    throw new Error(`Unable to store provider event: ${error.message}`)
  }
  // The attempts come back with the row. Asking separately meant a second
  // round trip on the duplicate path, which is the hot path — a provider that
  // retries aggressively hits it far more often than the first delivery.
  const { data: existing, error: existingError } = await supabase
    .from("payment_provider_events")
    .select("id,attempts:payment_provider_event_attempts(outcome)")
    .eq("provider", input.provider)
    .eq("provider_event_id", input.providerEventId)
    .maybeSingle()
  if (existingError || !existing) throw new Error(`Unable to store provider event: ${existingError?.message ?? "conflicting event vanished"}`)
  const completed = (existing.attempts ?? []).some((attempt: { outcome: string }) =>
    attempt.outcome === "processed" || attempt.outcome === "ignored")
  return { id: String(existing.id), duplicate: true, completed }
}

async function recordProcessingAttempt(input: { providerEventId: string; outcome: "processed" | "ignored" | "failed"; error?: string | null; startedAt: string }) {
  const supabase = createServiceSupabaseClient()
  const { error } = await supabase.rpc("record_payment_provider_event_attempt", {
    p_provider_event_id: input.providerEventId,
    p_outcome: input.outcome,
    p_processing_error: input.error ?? null,
    p_started_at: input.startedAt,
    p_completed_at: new Date().toISOString(),
  })
  if (error) throw new Error(`Unable to record provider event attempt: ${error.message}`)
}

/**
 * Move a run to the status its item rollup produced, with the same discipline
 * disbursements get: the transition is asserted against the legal table and the
 * write is a compare-and-swap on the status just read, so a concurrent rollup
 * cannot interleave into an illegal hop. A rollup that recomputes the status the
 * run already has is a no-op, not a transition.
 */
export async function transitionPaymentRunStatus(input: {
  supabase: ReturnType<typeof createServiceSupabaseClient>
  orgId: string
  runId: string
  toStatus: string
  extraPatch?: Record<string, unknown>
}) {
  const { data: run, error } = await input.supabase.from("payment_runs").select("status").eq("org_id", input.orgId).eq("id", input.runId).maybeSingle()
  if (error || !run) throw new Error(`Payment run was not found for status rollup: ${error?.message ?? input.runId}`)
  if (run.status === input.toStatus) return
  assertPaymentRunTransition(run.status, input.toStatus)
  const { error: updateError } = await input.supabase.from("payment_runs")
    .update({ status: input.toStatus, ...(input.extraPatch ?? {}) })
    .eq("org_id", input.orgId).eq("id", input.runId).eq("status", run.status)
  if (updateError) throw new Error(`Unable to update payment run status: ${updateError.message}`)
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
  const itemStatuses = (items ?? []).map((item) => item.status)
  const runStatus = resolveRunStatus(itemStatuses)
  const allTerminal = isPaymentRunTerminal(itemStatuses)
  await transitionPaymentRunStatus({
    supabase,
    orgId,
    runId,
    toStatus: runStatus,
    extraPatch: ["paid", "failed"].includes(runStatus) || (runStatus === "partially_failed" && allTerminal) ? { completed_at: new Date().toISOString() } : undefined,
  })
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

async function resolveDisbursementByPaymentId(provider: PaymentRailProvider, providerPaymentId: string) {
  const supabase = createServiceSupabaseClient()
  const { data } = await supabase.from("disbursements").select("*").eq("provider", provider.key).eq("provider_payment_id", providerPaymentId).maybeSingle()
  if (data) return { disbursement: data, reference: null }
  const reference = await provider.resolveDisbursementReference({ providerPaymentId })
  if (!reference.disbursementId) return { disbursement: null, reference }
  const { data: byMetadata } = await supabase.from("disbursements").select("*")
    .eq("provider", provider.key)
    .eq("id", reference.disbursementId)
    .maybeSingle()
  return { disbursement: byMetadata, reference }
}

async function rejectUnattributedRailEvent(input: {
  event: NormalizedPaymentRailEvent
  reference: { orgId: string | null; disbursementId: string | null; arcProduct: string | null } | null
  startedAt: string
}): Promise<never> {
  const orgId = input.reference?.orgId ?? null
  const detail = `Provider-tagged AP event ${input.event.providerEventId} could not be attributed to disbursement ${input.reference?.disbursementId ?? "unknown"}`
  const stored = await recordProviderEvent({
    provider: input.event.provider,
    providerEventId: input.event.providerEventId,
    providerAccountId: input.event.providerAccountId,
    orgId,
    // The metadata id is precisely the row we failed to resolve. Persisting it
    // as the FK would make the dead-letter write fail and lose the incident.
    disbursementId: null,
    eventType: input.event.providerEventType,
    eventCreatedAt: input.event.occurredAt,
    payload: input.event.payload,
  })
  if (orgId) {
    const code = `unattributed_rail_event:${input.event.providerEventId}`
    const shouldNotify = await openPaymentOperationsIncident({ orgId, code, detail })
    if (shouldNotify) await recordEvent({ orgId, eventType: "payment_operations_alert", entityType: "provider_event", entityId: input.event.providerEventId, payload: { findings: [{ code: "unattributed_rail_event", detail }] } })
  }
  await recordProcessingAttempt({ providerEventId: stored.id, outcome: "failed", error: detail, startedAt: input.startedAt })
  throw new Error(detail)
}

async function processDisbursementPaid(input: { disbursement: Record<string, unknown>; providerEventId: string; providerPayoutId: string; paidAt: string }) {
  const supabase = createServiceSupabaseClient()
  const disbursementId = String(input.disbursement.id)
  const orgId = String(input.disbursement.org_id)
  const providerPaymentId = input.disbursement.provider_payment_id
  if (typeof providerPaymentId !== "string" || providerPaymentId.length === 0) {
    throw new Error(`Disbursement ${disbursementId} is missing its provider payment id`)
  }
  const { data, error } = await supabase.rpc("record_ap_payment_atomic", {
    p_org_id: orgId,
    p_disbursement_id: disbursementId,
    p_provider_payment_id: providerPaymentId,
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
  if (typeof result.payment_id === "string") {
    const syncResult = await enqueueBillPaymentSync(result.payment_id, orgId)
    await recordPayableAccountingEnqueueResult({
      orgId,
      billId: String(input.disbursement.bill_id),
      entityType: "bill_payment",
      entityId: result.payment_id,
      result: syncResult,
    })
  }

  // Repair rather than announcement: a post-transfer return that pays out anyway
  // closes its own incident, and a replay is exactly when a crash between the
  // RPC and this line gets healed. Resolving an already-resolved incident is a
  // no-op, so it runs ahead of the duplicate check below.
  if (input.disbursement.status === "returned_after_transfer") {
    await resolvePaymentOperationsIncident({ orgId, code: `post_transfer_return:${disbursementId}` })
  }

  // A replay settled nothing: the RPC found the payment it wrote the first time
  // and returned it untouched. Everything below announces the settlement — a
  // remittance email to the vendor and a `vendor_payment_paid` event that fans
  // out to the builder — and announcing it again for money that moved once is
  // the duplicate-notification bug, not idempotency. The mailer's own
  // idempotency key is the second line of defence; this is the first, and it is
  // the one that keeps the event log honest about how often a vendor was paid.
  if (result.duplicate === true) return

  // Tell the vendor what the deposit covers. Never let a failure here fail the
  // webhook: the money has moved, and a bounced email is not a reason to
  // reprocess a settlement.
  await sendVendorRemittanceAdvice({ orgId, disbursementId }).catch(() => undefined)
  await Promise.all([
    recordEvent({ orgId, eventType: "vendor_payment_paid", entityType: "disbursement", entityId: disbursementId, payload: { bill_id: input.disbursement.bill_id, amount_cents: input.disbursement.amount_cents, provider_payout_id: input.providerPayoutId } }),
    recordAudit({ orgId, action: "update", entityType: "disbursement", entityId: disbursementId, after: { status: "paid", provider_payout_id: input.providerPayoutId }, source: `${String(input.disbursement.provider)}_webhook` }),
  ])
}

async function processDisbursementReturn(input: { disbursement: Record<string, unknown>; providerEventId: string; providerReversalId: string; reason: string; occurredAt: string }) {
  const supabase = createServiceSupabaseClient()
  const orgId = String(input.disbursement.org_id)
  const disbursementId = String(input.disbursement.id)
  const amountCents = Number(input.disbursement.amount_cents)
  const currency = String(input.disbursement.currency)
  const stage = classifyReturnStage(String(input.disbursement.status))
  let paymentIdToVoid: string | null = null

  if (stage === "post_payout") {
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
    const reversal = data as Record<string, unknown>
    paymentIdToVoid = typeof reversal.payment_id === "string" ? reversal.payment_id : null
    await postDisbursementReturnLedger({ orgId, disbursementId, providerEventId: input.providerEventId, amountCents, currency, effectiveAt: input.occurredAt })
  } else if (stage === "post_transfer") {
    await advanceDisbursement(disbursementId, orgId, "returned_after_transfer", {
      failure_reason: input.reason,
      returned_at: input.occurredAt,
    })
    // The builder's debit came back, but the vendor transfer may still pay out.
    await postDisbursementSubmissionReversalLedger({ orgId, disbursementId, providerEventId: input.providerEventId, vendorAmountCents: amountCents, currency, effectiveAt: input.occurredAt })
  } else {
    await advanceDisbursement(disbursementId, orgId, "returned", {
      failure_reason: input.reason,
      returned_at: input.occurredAt,
    })
    await postDisbursementSubmissionReversalLedger({ orgId, disbursementId, providerEventId: input.providerEventId, vendorAmountCents: amountCents, currency, effectiveAt: input.occurredAt })
    await rollUpTerminalDisbursement(input.disbursement, "returned", input.reason)
  }
  // Stripe invalidates an ACH mandate when the account holder disputes the
  // debit. Fail closed even for the rare post-succeeded failure: the builder
  // must re-verify and re-authorize this bank before Arc attempts another debit.
  const { error: fundingError } = await supabase.from("org_funding_sources").update({
    status: "disabled",
    mandate_status: "invalid",
    verification_status: "failed",
    disabled_at: input.occurredAt,
  }).eq("org_id", orgId).eq("id", input.disbursement.funding_source_id)
  if (fundingError) throw new Error(`Unable to disable the returned ACH funding source: ${fundingError.message}`)
  await recordAudit({
    orgId,
    action: "update",
    entityType: "org_funding_source",
    entityId: String(input.disbursement.funding_source_id),
    after: { status: "disabled", mandate_status: "invalid", verification_status: "failed", reason: input.reason },
    source: `${String(input.disbursement.provider)}_webhook`,
  })
  if (stage !== "pre_transfer") {
    await postApReturnLossLedger({ orgId, disbursementId, providerEventId: input.providerEventId, amountCents, currency, effectiveAt: input.occurredAt })
    await enforceReturnLossCeiling(orgId, String(input.disbursement.provider))
    const detail = `ACH debit returned after Arc created the vendor transfer (${stage}). Do not create a replacement payment while recovery is pending.`
    await openPaymentOperationsIncident({ orgId, code: `post_transfer_return:${disbursementId}`, detail })
  }
  // Own state, ledger, funding control, incident, and notification are durable
  // before any external accounting mutation is queued.
  await recordEvent({ orgId, eventType: "vendor_payment_returned", entityType: "disbursement", entityId: disbursementId, payload: { bill_id: input.disbursement.bill_id, reason: input.reason, return_stage: stage } })

  // The vendor was told the money was on its way; they are owed the correction.
  // Only once Arc had released it toward them — a pre-transfer return never
  // reached the vendor and there is nothing for them to reconcile. Best effort
  // by design: the money state is already durable above and a bounced email is
  // not a reason to reprocess a return.
  if (stage !== "pre_transfer") {
    await sendVendorPaymentReturnNotice({ orgId, disbursementId, stage }).catch(() => undefined)
  }

  if (paymentIdToVoid) {
    const queued = await enqueueBillPaymentVoid({ orgId, paymentId: paymentIdToVoid, reason: input.reason })
    if (!queued.enqueued && queued.reason !== "duplicate") throw new Error("Unable to enqueue the accounting bill-payment void")
  }

  if (stage === "post_transfer" && typeof input.disbursement.provider_transfer_id === "string") {
    let transferReversed = false
    try {
      const provider = getPaymentRailProvider(String(input.disbursement.provider))
      await provider.reverseVendorTransfer({
        providerTransferId: input.disbursement.provider_transfer_id,
        disbursementId,
        idempotencyKey: `disbursement:${disbursementId}:transfer-reversal`,
      })
      transferReversed = true
    } catch {
      // Insufficient connected-account balance is expected after payout. The
      // loss and incident remain open; payout.paid will close the state gap.
    }
    if (transferReversed) {
      const { error: recoveryError } = await supabase.rpc("complete_post_transfer_return_recovery_atomic", {
        p_org_id: orgId,
        p_disbursement_id: disbursementId,
        p_reason: input.reason,
        p_returned_at: input.occurredAt,
      })
      if (recoveryError) throw new Error(`Unable to complete transfer-return recovery: ${recoveryError.message}`)
      await postApReturnLossRecoveryLedger({ orgId, disbursementId, providerEventId: input.providerEventId, amountCents, currency, effectiveAt: input.occurredAt })
      await resolvePaymentOperationsIncident({ orgId, code: `post_transfer_return:${disbursementId}` })
    }
  }
}

/**
 * Trip an org's rail off once its unrecovered return losses reach the ceiling.
 *
 * The ceiling is the difference between a documented risk appetite and an
 * unbounded one. Disabling the org flag rather than the platform switch keeps
 * one bad customer from stopping everyone else's payroll, and the alert names
 * the number so a human can decide whether to raise it or keep them off.
 */
async function enforceReturnLossCeiling(orgId: string, providerKey: string) {
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
  const entries: Array<{ amount_cents: number; direction: string }> = []
  let ledgerReadError: { message: string } | null = null
  for (let from = 0; from < MAX_RETURN_LOSS_LEDGER_ENTRIES; from += RETURN_LOSS_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("payment_ledger_entries")
      .select("amount_cents,direction,transaction:payment_ledger_transactions!inner(org_id)")
      .eq("account_code", "ach_return_loss")
      .eq("payment_ledger_transactions.org_id", orgId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + RETURN_LOSS_PAGE_SIZE - 1)
    if (error) {
      ledgerReadError = error
      break
    }
    entries.push(...((data ?? []) as Array<{ amount_cents: number; direction: string }>))
    if ((data ?? []).length < RETURN_LOSS_PAGE_SIZE) break
  }
  // An unbounded walk inside a webhook is a way to hang the handler, not a way
  // to be thorough. Past the ceiling on entries the total cannot be computed
  // honestly, which is the same situation as a failed read and takes the same
  // fail-closed path.
  if (!ledgerReadError && entries.length >= MAX_RETURN_LOSS_LEDGER_ENTRIES) {
    ledgerReadError = { message: `More than ${MAX_RETURN_LOSS_LEDGER_ENTRIES} return-loss ledger entries; the total cannot be summed inside a webhook` }
  }
  if (ledgerReadError) {
    // The ceiling fails closed. A ledger read that cannot be trusted must not
    // silently disable the loss control — alert, then rethrow so the webhook
    // records a failed attempt and the provider redelivers. Every mutation on
    // this path is idempotent, so the retry is safe.
    const detail = "The ACH return-loss ledger could not be read, so the loss ceiling could not be enforced for this return. The webhook will retry."
    // A single-org open, not the batch synchronizer: that one would let this
    // org's failure resolve every other org's still-failing ceiling check.
    const shouldNotify = await openPaymentOperationsIncident({ orgId, code: "return_loss_ceiling_check_failed", detail })
    if (shouldNotify) {
      await recordEvent({
        orgId,
        eventType: "payment_operations_alert",
        entityType: "payment_rail_policy",
        entityId: orgId,
        payload: {
          findings: [{ code: "return_loss_ceiling_check_failed", detail }],
          error: ledgerReadError.message,
          ceiling_cents: ceilingCents,
        },
      })
    }
    throw new Error(`Unable to read return-loss ledger for ceiling enforcement: ${ledgerReadError.message}`)
  }
  // A successful check closes only this organization's incident.
  await resolvePaymentOperationsIncident({ orgId, code: "return_loss_ceiling_check_failed" })
  const lossCents = (entries ?? []).reduce(
    (sum, entry) => sum + (entry.direction === "debit" ? Number(entry.amount_cents) : -Number(entry.amount_cents)),
    0,
  )
  if (lossCents < ceilingCents) return

  const { error: disableError } = await supabase.from("feature_flags").upsert(
    { org_id: orgId, flag_key: "fintech_ap_payments", enabled: false, updated_at: new Date().toISOString() },
    { onConflict: "org_id,flag_key" },
  )
  if (disableError) throw new Error(`Unable to trip the payment return-loss circuit breaker: ${disableError.message}`)
  const ceilingDetail = "Unrecovered ACH return losses reached the configured ceiling. Electronic payments are disabled for this organization pending review."
  const shouldNotify = await openPaymentOperationsIncident({ orgId, code: "return_loss_ceiling_reached", detail: ceilingDetail })
  if (shouldNotify) {
    await Promise.all([
      recordEvent({
        orgId,
        eventType: "payment_operations_alert",
        entityType: "payment_rail_policy",
        entityId: orgId,
        payload: {
          findings: [{ code: "return_loss_ceiling_reached", detail: ceilingDetail }],
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
        source: `${providerKey}_webhook`,
      }),
    ])
  }
}

/**
 * When this org's cleared funds may be transferred to the vendor.
 *
 * Production policy enforces at least 48 business hours. The default here is a
 * final fail-safe for a legacy row, not permission to bypass that minimum.
 */
async function resolvePayoutHoldExpiry(orgId: string, clearedAt: string): Promise<string> {
  const supabase = createServiceSupabaseClient()
  const { data } = await supabase.from("payment_rail_policies").select("payout_hold_hours").eq("org_id", orgId).maybeSingle()
  const hours = Math.max(Number(data?.payout_hold_hours ?? 48), 48)
  return scheduleTransferRelease(clearedAt, hours)
}

/**
 * Terminal state for Arc's own per-run fee debit.
 *
 * A failed collection reverses the cash side and leaves the liability standing:
 * the fee was earned when the vendors were paid, so a failed pull is a
 * receivable someone chases, not a debt that quietly disappears.
 */
async function processFeeChargeEvent(input: {
  event: Extract<NormalizedPaymentRailEvent, { kind: "fee_charge.status" }>
  startedAt: string
}): Promise<{ handled: boolean; duplicate?: boolean }> {
  const supabase = createServiceSupabaseClient()
  const { data: charge } = await supabase
    .from("payment_run_fee_charges")
    .select("id,org_id,run_id,status,amount_cents,currency")
    .eq("provider", input.event.provider)
    .eq("provider_payment_id", input.event.providerPaymentId)
    .maybeSingle()
  if (!charge) return { handled: false }

  const target = input.event.status

  const providerEvent = await recordProviderEvent({
    provider: input.event.provider,
    providerEventId: input.event.providerEventId,
    providerAccountId: input.event.providerAccountId,
    orgId: String(charge.org_id),
    eventType: input.event.providerEventType,
    eventCreatedAt: input.event.occurredAt,
    payload: input.event.payload,
  })
  if (providerEvent.duplicate && providerEvent.completed) return { handled: true, duplicate: true }

  try {
    // Terminal states are final; a late `processing` after `succeeded` is a
    // stale delivery, not a regression to walk backwards into.
    if (["succeeded", "failed", "canceled"].includes(String(charge.status))) {
      await recordProcessingAttempt({ providerEventId: providerEvent.id, outcome: "ignored", startedAt: input.startedAt })
      return { handled: true }
    }
    await supabase.from("payment_run_fee_charges").update({
      status: target,
      ...(target === "succeeded" ? { settled_at: input.event.occurredAt } : {}),
      ...(target === "failed" || target === "canceled" ? { failure_reason: `Provider reported ${input.event.providerEventType}` } : {}),
    }).eq("org_id", charge.org_id).eq("id", charge.id)

    if (target === "failed" || target === "canceled") {
      await postApFeeChargeReversalLedger({
        orgId: String(charge.org_id),
        runId: String(charge.run_id),
        feeChargeId: String(charge.id),
        amountCents: Number(charge.amount_cents),
        currency: String(charge.currency),
        effectiveAt: input.event.occurredAt,
      })
      await recordEvent({
        orgId: String(charge.org_id),
        eventType: "payment_run_fee_charge_failed",
        entityType: "payment_run",
        entityId: String(charge.run_id),
        payload: { fee_charge_id: charge.id, amount_cents: charge.amount_cents, error: `Provider reported ${input.event.providerEventType}` },
      })
    }
    await recordProcessingAttempt({ providerEventId: providerEvent.id, outcome: "processed", startedAt: input.startedAt })
    return { handled: true }
  } catch (error) {
    await recordProcessingAttempt({ providerEventId: providerEvent.id, outcome: "failed", error: error instanceof Error ? error.message : String(error), startedAt: input.startedAt })
    throw error
  }
}

export interface PaymentRailEventResult {
  handled: boolean
  duplicate?: boolean
  /**
   * Which rail this event belongs to, decided here and nowhere else.
   *
   * `ap` covers both "Arc processed it" and "the provider object carries Arc's
   * AP marker but no Arc row matched". The second case is the important one: an
   * AP intent whose disbursement lookup misses used to report the same
   * `handled: false` as an event from another product, and the caller then ran
   * it through the receivables mapper — where it landed on `recordPayment`
   * keyed on an `invoice_id` an AP intent has never carried. Nothing structural
   * stopped that; this does.
   */
  domain: "ap" | "unrelated"
}

export async function processPaymentRailEvent(
  providerKey: string,
  rawEvent: unknown,
): Promise<PaymentRailEventResult> {
  const provider = getPaymentRailProvider(providerKey)
  const event = await provider.normalizeWebhookEvent(rawEvent)
  if (!event) return { handled: false, domain: "unrelated" }
  const result = await processNormalizedRailEvent(provider, event)
  return {
    ...result,
    domain: result.handled || event.attribution === "provider_tagged" ? "ap" : "unrelated",
  }
}

async function processNormalizedRailEvent(
  provider: PaymentRailProvider,
  event: NormalizedPaymentRailEvent,
): Promise<{ handled: boolean; duplicate?: boolean }> {
  const startedAt = new Date().toISOString()

  if (event.kind === "recipient.updated") {
    const synced = await syncVendorRecipient(
      event.recipientProviderAccountId,
      event.provider,
      `${event.provider}_webhook`,
    )
    if (!synced) return { handled: false }
    const providerEvent = await recordProviderEvent({
      provider: event.provider,
      providerEventId: event.providerEventId,
      providerAccountId: event.recipientProviderAccountId,
      eventType: event.providerEventType,
      eventCreatedAt: event.occurredAt,
      payload: event.payload,
    })
    if (providerEvent.duplicate && providerEvent.completed) return { handled: true, duplicate: true }
    await recordProcessingAttempt({ providerEventId: providerEvent.id, outcome: "processed", startedAt })
    return { handled: true }
  }

  if (event.kind === "funding_source.updated") {
    const supabase = createServiceSupabaseClient()
    const { data: funding, error: fundingLookupError } = await supabase.from("org_funding_sources")
      .select("id,org_id,status,mandate_status,verification_status")
      .eq("provider", event.provider)
      .eq("provider_payment_method_id", event.providerPaymentMethodId)
      .maybeSingle()
    if (fundingLookupError) throw new Error(`Unable to resolve provider funding source: ${fundingLookupError.message}`)
    if (!funding) return { handled: false }
    const providerEvent = await recordProviderEvent({
      provider: event.provider,
      providerEventId: event.providerEventId,
      providerAccountId: event.providerAccountId,
      orgId: funding.org_id,
      eventType: event.providerEventType,
      eventCreatedAt: event.occurredAt,
      payload: event.payload,
    })
    if (providerEvent.duplicate && providerEvent.completed) return { handled: true, duplicate: true }
    try {
      if (event.blocked) {
        const { error: fundingError } = await supabase.from("org_funding_sources").update({
          status: "disabled",
          mandate_status: "invalid",
          verification_status: "failed",
          disabled_at: event.occurredAt,
        }).eq("org_id", funding.org_id).eq("id", funding.id)
        if (fundingError) throw new Error(`Unable to disable blocked ACH funding source: ${fundingError.message}`)
        await Promise.all([
          recordEvent({
            orgId: funding.org_id,
            eventType: "payment_operations_alert",
            entityType: "org_funding_source",
            entityId: funding.id,
            payload: { findings: [{ code: "funding_source_blocked", detail: event.reason ?? "Stripe blocked this ACH bank account" }] },
          }),
          recordAudit({
            orgId: funding.org_id,
            action: "update",
            entityType: "org_funding_source",
            entityId: funding.id,
            before: { status: funding.status, mandate_status: funding.mandate_status, verification_status: funding.verification_status },
            after: { status: "disabled", mandate_status: "invalid", verification_status: "failed", reason: event.reason },
            source: `${event.provider}_webhook`,
          }),
        ])
      }
      await recordProcessingAttempt({ providerEventId: providerEvent.id, outcome: "processed", startedAt })
      return { handled: true }
    } catch (error) {
      await recordProcessingAttempt({ providerEventId: providerEvent.id, outcome: "failed", error: error instanceof Error ? error.message : String(error), startedAt })
      throw error
    }
  }

  if (event.kind === "disbursement.authorization_inquiry") {
    const resolved = await resolveDisbursementByPaymentId(provider, event.providerPaymentId)
    if (!resolved.disbursement) {
      if (event.attribution === "provider_tagged" || resolved.reference?.arcProduct === "vendor_payments") await rejectUnattributedRailEvent({ event, reference: resolved.reference, startedAt })
      return { handled: false }
    }
    const disbursement = resolved.disbursement
    const orgId = String(disbursement.org_id)
    const disbursementId = String(disbursement.id)
    const providerEvent = await recordProviderEvent({
      provider: event.provider,
      providerEventId: event.providerEventId,
      providerAccountId: event.providerAccountId,
      orgId,
      disbursementId,
      eventType: event.providerEventType,
      eventCreatedAt: event.occurredAt,
      payload: event.payload,
    })
    if (providerEvent.duplicate && providerEvent.completed) return { handled: true, duplicate: true }
    try {
      const detail = `Stripe requested ACH authorization evidence (${event.status}): ${event.reason}`
      const incidentCode = `ach_authorization_inquiry:${disbursementId}`
      if (event.status === "warning_closed") {
        await resolvePaymentOperationsIncident({ orgId, code: incidentCode })
        await recordProcessingAttempt({ providerEventId: providerEvent.id, outcome: "processed", startedAt })
        return { handled: true }
      }
      const shouldNotify = await openPaymentOperationsIncident({ orgId, code: incidentCode, detail })
      if (shouldNotify) {
        await recordEvent({ orgId, eventType: "payment_operations_alert", entityType: "disbursement", entityId: disbursementId, payload: { findings: [{ code: "ach_authorization_inquiry", detail }], provider_inquiry_id: event.providerInquiryId } })
      }
      await recordProcessingAttempt({ providerEventId: providerEvent.id, outcome: "processed", startedAt })
      return { handled: true }
    } catch (error) {
      await recordProcessingAttempt({ providerEventId: providerEvent.id, outcome: "failed", error: error instanceof Error ? error.message : String(error), startedAt })
      throw error
    }
  }

  if (event.kind === "fee_charge.status") {
    return processFeeChargeEvent({ event, startedAt })
  }

  let disbursements: Array<Record<string, unknown>> = []
  let targetStatus: DisbursementStatus | null = null
  let providerTransferId: string | null = null
  let providerPayoutId: string | null = null
  let providerReversalId: string | null = null
  let transferReleaseAfter: string | null = null
  let returnReason = "ACH payment returned"

  const supabase = createServiceSupabaseClient()

  if (event.kind === "disbursement.status") {
    const direct = event.disbursementId
      ? await supabase.from("disbursements").select("*").eq("provider", event.provider).eq("id", event.disbursementId).maybeSingle().then((result) => result.data)
      : null
    const resolved = direct ? { disbursement: direct, reference: null } : await resolveDisbursementByPaymentId(provider, event.providerPaymentId)
    if (!resolved.disbursement) {
      if (event.attribution === "provider_tagged" || resolved.reference?.arcProduct === "vendor_payments") await rejectUnattributedRailEvent({ event, reference: resolved.reference, startedAt })
      return { handled: false }
    }
    const disbursement = resolved.disbursement
    disbursements = [disbursement]
    targetStatus = event.status
    providerTransferId = event.providerTransferId
    if (event.status === "funds_available") {
      // The debit has cleared to Arc. The hold starts now, and the vendor
      // transfer is created by the release sweep once it expires — a return
      // arriving inside the window costs nothing because no transfer exists yet.
      transferReleaseAfter = await resolvePayoutHoldExpiry(String(disbursement.org_id), event.occurredAt)
    }
  } else if (event.kind === "disbursement.paid") {
    if (!event.providerAccountId) return { handled: false }
    const { data: recipient } = await supabase.from("payment_recipient_accounts").select("id").eq("provider", event.provider).eq("provider_account_id", event.providerAccountId).maybeSingle()
    // The expensive part comes after this check, deliberately. Resolving a
    // payout's transfers is an unbounded balance-transaction walk plus a charge
    // retrieval per source; doing it during normalization spent all of that on
    // every payout Stripe reports, including every one on an account Arc has
    // never heard of, and a large payout ran the webhook out of time before Arc
    // had asked a single question of its own database.
    if (!recipient) return { handled: false }
    const providerTransferIds = await provider.resolvePayoutTransferIds({
      providerAccountId: event.providerAccountId,
      providerPayoutId: event.providerPayoutId,
    })
    if (providerTransferIds.length > 0) {
      const { data } = await supabase.from("disbursements").select("*").eq("provider", event.provider).eq("recipient_account_id", recipient.id).in("provider_transfer_id", providerTransferIds)
      disbursements = data ?? []
    }
    providerPayoutId = event.providerPayoutId
    targetStatus = "paid"
  } else if (event.kind === "disbursement.payout_attention") {
    if (!event.providerAccountId) return { handled: false }
    const { data: recipient } = await supabase.from("payment_recipient_accounts").select("id").eq("provider", event.provider).eq("provider_account_id", event.providerAccountId).maybeSingle()
    if (!recipient) return { handled: false }
    const providerTransferIds = await provider.resolvePayoutTransferIds({
      providerAccountId: event.providerAccountId,
      providerPayoutId: event.providerPayoutId,
    })
    if (providerTransferIds.length > 0) {
      const { data } = await supabase.from("disbursements").select("*").eq("provider", event.provider).eq("recipient_account_id", recipient.id).in("provider_transfer_id", providerTransferIds)
      disbursements = data ?? []
    }
    const first = disbursements[0]
    const providerEvent = await recordProviderEvent({
      provider: event.provider,
      providerEventId: event.providerEventId,
      providerAccountId: event.providerAccountId,
      orgId: disbursements.length === 1 ? String(first.org_id) : null,
      disbursementId: disbursements.length === 1 ? String(first.id) : null,
      eventType: event.providerEventType,
      eventCreatedAt: event.occurredAt,
      payload: event.payload,
    })
    if (providerEvent.duplicate && providerEvent.completed) return { handled: true, duplicate: true }
    try {
      if (disbursements.length === 0) throw new Error("Failed provider payout could not be matched to an Arc transfer")
      for (const disbursement of disbursements) {
        const orgId = String(disbursement.org_id)
        const disbursementId = String(disbursement.id)
        if (disbursement.status === "transfer_pending") {
          await advanceDisbursement(disbursementId, orgId, "payout_pending", { provider_payout_id: event.providerPayoutId })
        }
        const { error: failureError } = await supabase.from("disbursements").update({
          provider_payout_id: event.providerPayoutId,
          failure_reason: event.reason,
        }).eq("org_id", orgId).eq("id", disbursementId)
        if (failureError) throw new Error(`Unable to record provider payout failure: ${failureError.message}`)
        const detail = `Vendor bank payout ${event.status}: ${event.reason}. Do not create a replacement payment; the transferred funds remain associated with this vendor while payout details are repaired.`
        const shouldNotify = await openPaymentOperationsIncident({ orgId, code: `vendor_payout_failed:${disbursementId}`, detail })
        if (shouldNotify) await recordEvent({ orgId, eventType: "payment_operations_alert", entityType: "disbursement", entityId: disbursementId, payload: { findings: [{ code: "vendor_payout_failed", detail }], provider_payout_id: event.providerPayoutId } })
      }
      await syncVendorRecipient(event.providerAccountId, event.provider, `${event.provider}_payout_failure`)
      await recordProcessingAttempt({ providerEventId: providerEvent.id, outcome: "processed", startedAt })
      return { handled: true }
    } catch (error) {
      await recordProcessingAttempt({ providerEventId: providerEvent.id, outcome: "failed", error: error instanceof Error ? error.message : String(error), startedAt })
      throw error
    }
  } else if (event.kind === "disbursement.returned") {
    const resolved = await resolveDisbursementByPaymentId(provider, event.providerPaymentId)
    if (!resolved.disbursement) {
      if (event.attribution === "provider_tagged" || resolved.reference?.arcProduct === "vendor_payments") await rejectUnattributedRailEvent({ event, reference: resolved.reference, startedAt })
      return { handled: false }
    }
    const disbursement = resolved.disbursement
    disbursements = [disbursement]
    targetStatus = "returned"
    providerReversalId = event.providerReversalId
    returnReason = event.reason
  } else if (event.kind === "disbursement.charge_settled") {
    const resolved = await resolveDisbursementByPaymentId(provider, event.providerPaymentId)
    if (!resolved.disbursement) {
      if (event.attribution === "provider_tagged" || resolved.reference?.arcProduct === "vendor_payments") await rejectUnattributedRailEvent({ event, reference: resolved.reference, startedAt })
      return { handled: false }
    }
    const disbursement = resolved.disbursement
    const platformFeeCents = Number(disbursement.platform_fee_cents ?? 0)
    // What the builder was quoted and charged, frozen on the approved run. Kept
    // apart from the actual below because they answer different questions.
    const quotedProcessorFeeCents = Number(disbursement.processor_fee_cents ?? 0)
    const providerEvent = await recordProviderEvent({ provider: event.provider, providerEventId: event.providerEventId, providerAccountId: event.providerAccountId, orgId: String(disbursement.org_id), disbursementId: String(disbursement.id), eventType: event.providerEventType, eventCreatedAt: event.occurredAt, payload: event.payload })
    if (providerEvent.duplicate && providerEvent.completed) return { handled: true, duplicate: true }
    try {
      // Record what the provider actually charged Arc, alongside — not over —
      // what the builder was quoted. The quote is what the approver signed for
      // and what the fee debit collected; the actual is Arc's own cost, and the
      // difference is Arc's margin. Overwriting the quote with the actual would
      // erase the evidence of what was charged.
      const { error: chargeUpdateError } = await supabase.from("disbursements").update({
        provider_charge_id: event.providerChargeId,
        provider_balance_transaction_id: event.providerBalanceTransactionId,
        actual_processor_fee_cents: event.actualProcessorFeeCents,
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
            provider_reference: event.providerChargeId,
            idempotency_key: `disbursement:${disbursement.id}:${entry.suffix}`,
            recognized_at: event.occurredAt,
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
  }

  const first = disbursements[0]
  const providerEvent = await recordProviderEvent({
    provider: event.provider,
    providerEventId: event.providerEventId,
    providerAccountId: event.providerAccountId,
    orgId: disbursements.length === 1 ? String(first.org_id) : null,
    disbursementId: disbursements.length === 1 ? String(first.id) : null,
    eventType: event.providerEventType,
    eventCreatedAt: event.occurredAt,
    payload: event.payload,
  })
  if (providerEvent.duplicate && providerEvent.completed) return { handled: true, duplicate: true }

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
        await processDisbursementPaid({ disbursement: { ...disbursement, provider_payout_id: providerPayoutId }, providerEventId: providerEvent.id, providerPayoutId, paidAt: event.occurredAt })
        await supabase.from("disbursements").update({ failure_reason: null }).eq("org_id", orgId).eq("id", disbursementId)
        await resolvePaymentOperationsIncident({ orgId, code: `vendor_payout_failed:${disbursementId}` })
      } else if (targetStatus === "returned" && providerReversalId) {
        await processDisbursementReturn({ disbursement, providerEventId: providerEvent.id, providerReversalId, reason: returnReason, occurredAt: event.occurredAt })
      } else if (targetStatus) {
        const patch: Record<string, unknown> = {}
        if (providerTransferId) patch.provider_transfer_id = providerTransferId
        if (transferReleaseAfter) patch.transfer_release_after = transferReleaseAfter
        if (targetStatus === "failed") patch.failure_reason = "Provider reported payment failure"
        await advanceDisbursement(disbursementId, orgId, targetStatus, patch)
        if (targetStatus === "failed" || targetStatus === "canceled") {
          await postDisbursementSubmissionReversalLedger({ orgId, disbursementId, providerEventId: providerEvent.id, vendorAmountCents: Number(disbursement.amount_cents), currency: String(disbursement.currency), effectiveAt: event.occurredAt })
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

/** Compatibility entry point for the Stripe webhook route. Domain processing is
 * provider-neutral; the adapter owns all Stripe object interpretation. */
export async function processStripeApEvent(event: unknown) {
  return processPaymentRailEvent("stripe", event)
}
