import "server-only"

import { assertBalancedLedgerEntries, type LedgerEntryInput } from "@/lib/payments/payment-domain"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

export async function postPaymentLedgerTransaction(input: {
  orgId: string
  disbursementId?: string | null
  providerEventId?: string | null
  sourceType: "payment_run" | "disbursement" | "provider_event" | "reconciliation" | "manual_adjustment"
  sourceId?: string | null
  transactionType: "payment_submitted" | "funds_available" | "transfer_created" | "payout_paid" | "processor_fee" | "platform_fee" | "return" | "reversal" | "adjustment"
  currency: string
  idempotencyKey: string
  reversesTransactionId?: string | null
  description?: string | null
  effectiveAt: string
  entries: LedgerEntryInput[]
}) {
  assertBalancedLedgerEntries(input.entries)
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase.rpc("post_payment_ledger_transaction_atomic", {
    p_org_id: input.orgId,
    p_disbursement_id: input.disbursementId ?? null,
    p_provider_event_id: input.providerEventId ?? null,
    p_source_type: input.sourceType,
    p_source_id: input.sourceId ?? null,
    p_transaction_type: input.transactionType,
    p_currency: input.currency,
    p_idempotency_key: input.idempotencyKey,
    p_reverses_transaction_id: input.reversesTransactionId ?? null,
    p_description: input.description ?? null,
    p_effective_at: input.effectiveAt,
    p_entries: input.entries.map((entry) => ({
      account_code: entry.accountCode,
      direction: entry.direction,
      amount_cents: entry.amountCents,
      currency: entry.currency.toLowerCase(),
    })),
  })
  if (error || !data) throw new Error(`Unable to post payment ledger transaction: ${error?.message}`)
  return data
}

/**
 * The builder's bank debit. Vendor amount only — fees are never part of the
 * money that moves for a payment, so this entry equals the bank feed line and
 * equals the BillPayment pushed to the accounting system.
 */
export function postDisbursementSubmittedLedger(input: {
  orgId: string
  disbursementId: string
  vendorAmountCents: number
  currency: string
  effectiveAt: string
}) {
  return postPaymentLedgerTransaction({
    orgId: input.orgId,
    disbursementId: input.disbursementId,
    sourceType: "disbursement",
    sourceId: input.disbursementId,
    transactionType: "payment_submitted",
    currency: input.currency,
    idempotencyKey: `disbursement:${input.disbursementId}:submitted`,
    description: "Builder bank debit submitted",
    effectiveAt: input.effectiveAt,
    entries: [
      { accountCode: "ach_clearing", direction: "debit", amountCents: input.vendorAmountCents, currency: input.currency },
      { accountCode: "org_cash", direction: "credit", amountCents: input.vendorAmountCents, currency: input.currency },
    ],
  })
}

/**
 * Recognise a run's fees as owed to Arc.
 *
 * Posted at run execution using the amounts frozen on the approved run, not the
 * provider's later actual. The builder's books should carry the number their
 * approver signed for; any difference between that and what the provider ends up
 * charging Arc is Arc's margin and belongs nowhere near these books.
 *
 * That reasoning is what removed the old fee-adjustment transaction, which
 * posted the estimate-to-actual difference against `org_cash` and drifted the
 * builder's cash from their real bank balance on every single payment.
 */
export function postApFeeAccrualLedger(input: {
  orgId: string
  runId: string
  feeChargeId: string
  processorFeeCents: number
  platformFeeCents: number
  currency: string
  effectiveAt: string
}) {
  const debits: LedgerEntryInput[] = []
  if (input.processorFeeCents > 0) debits.push({ accountCode: "processor_fee_expense", direction: "debit", amountCents: input.processorFeeCents, currency: input.currency })
  if (input.platformFeeCents > 0) debits.push({ accountCode: "platform_fee_expense", direction: "debit", amountCents: input.platformFeeCents, currency: input.currency })
  const accruedCents = input.processorFeeCents + input.platformFeeCents
  // A zero-fee run has nothing to recognise, and a ledger transaction with no
  // entries is not a balanced transaction, it is a meaningless one.
  if (accruedCents === 0) return Promise.resolve(null)
  return postPaymentLedgerTransaction({
    orgId: input.orgId,
    sourceType: "payment_run",
    sourceId: input.runId,
    transactionType: "platform_fee",
    currency: input.currency,
    idempotencyKey: `payment_run:${input.runId}:fee-accrual`,
    description: "AP fees recognised for this payment run",
    effectiveAt: input.effectiveAt,
    entries: [
      ...debits,
      { accountCode: "arc_fees_payable", direction: "credit", amountCents: accruedCents, currency: input.currency },
    ],
  })
}

/**
 * The fee debit that clears the payable.
 *
 * Separate from the accrual so a failed collection leaves the liability standing
 * rather than silently forgiving it — the fee was earned whether or not the ACH
 * pull succeeded, and someone has to chase it.
 */
export function postApFeeChargeSubmittedLedger(input: {
  orgId: string
  runId: string
  feeChargeId: string
  amountCents: number
  currency: string
  effectiveAt: string
}) {
  return postPaymentLedgerTransaction({
    orgId: input.orgId,
    sourceType: "payment_run",
    sourceId: input.runId,
    transactionType: "platform_fee",
    currency: input.currency,
    idempotencyKey: `payment_run_fee_charge:${input.feeChargeId}:submitted`,
    description: "Arc fee debit submitted",
    effectiveAt: input.effectiveAt,
    entries: [
      { accountCode: "arc_fees_payable", direction: "debit", amountCents: input.amountCents, currency: input.currency },
      { accountCode: "org_cash", direction: "credit", amountCents: input.amountCents, currency: input.currency },
    ],
  })
}

/** Reopen the payable when the provider rejects or returns the fee debit. */
export function postApFeeChargeReversalLedger(input: {
  orgId: string
  runId: string
  feeChargeId: string
  amountCents: number
  currency: string
  effectiveAt: string
}) {
  return postPaymentLedgerTransaction({
    orgId: input.orgId,
    sourceType: "payment_run",
    sourceId: input.runId,
    transactionType: "reversal",
    currency: input.currency,
    idempotencyKey: `payment_run_fee_charge:${input.feeChargeId}:reversal`,
    description: "Reverse unsuccessful Arc fee debit",
    effectiveAt: input.effectiveAt,
    entries: [
      { accountCode: "org_cash", direction: "debit", amountCents: input.amountCents, currency: input.currency },
      { accountCode: "arc_fees_payable", direction: "credit", amountCents: input.amountCents, currency: input.currency },
    ],
  })
}

export function postDisbursementPaidLedger(input: { orgId: string; disbursementId: string; providerEventId: string; amountCents: number; currency: string; effectiveAt: string }) {
  return postPaymentLedgerTransaction({
    orgId: input.orgId,
    disbursementId: input.disbursementId,
    providerEventId: input.providerEventId,
    sourceType: "provider_event",
    sourceId: input.providerEventId,
    transactionType: "payout_paid",
    currency: input.currency,
    idempotencyKey: `disbursement:${input.disbursementId}:paid`,
    description: "Vendor payout reconciled",
    effectiveAt: input.effectiveAt,
    entries: [
      { accountCode: "vendor_payable", direction: "debit", amountCents: input.amountCents, currency: input.currency },
      { accountCode: "ach_clearing", direction: "credit", amountCents: input.amountCents, currency: input.currency },
    ],
  })
}

/** Undo a debit the provider never took. Vendor amount only, mirroring the debit. */
export function postDisbursementSubmissionReversalLedger(input: {
  orgId: string
  disbursementId: string
  providerEventId: string
  vendorAmountCents: number
  currency: string
  effectiveAt: string
}) {
  return postPaymentLedgerTransaction({
    orgId: input.orgId,
    disbursementId: input.disbursementId,
    providerEventId: input.providerEventId,
    sourceType: "provider_event",
    sourceId: input.providerEventId,
    transactionType: "reversal",
    currency: input.currency,
    idempotencyKey: `disbursement:${input.disbursementId}:submission-reversal`,
    description: "Reverse unsuccessful builder bank debit",
    effectiveAt: input.effectiveAt,
    entries: [
      { accountCode: "org_cash", direction: "debit", amountCents: input.vendorAmountCents, currency: input.currency },
      { accountCode: "ach_clearing", direction: "credit", amountCents: input.vendorAmountCents, currency: input.currency },
    ],
  })
}

/**
 * An ACH return after the vendor was paid, in the builder's books.
 *
 * Their bank reversed the debit, so their cash comes back and the obligation to
 * the vendor reopens — which is exactly what `record_ap_payment_reversal_atomic`
 * does to the bill. Balanced, and true.
 *
 * This used to credit `suspense` with a comment saying the loss was "pending
 * provider loss allocation", which never happened. Suspense is not an answer to
 * who paid for something; it is a record of not having asked. The loss is Arc's,
 * not the builder's, and it is posted separately by `postApReturnLossLedger`.
 */
export function postDisbursementReturnLedger(input: { orgId: string; disbursementId: string; providerEventId: string; amountCents: number; currency: string; effectiveAt: string }) {
  return postPaymentLedgerTransaction({
    orgId: input.orgId,
    disbursementId: input.disbursementId,
    providerEventId: input.providerEventId,
    sourceType: "provider_event",
    sourceId: input.providerEventId,
    transactionType: "return",
    currency: input.currency,
    idempotencyKey: `disbursement:${input.disbursementId}:return:${input.providerEventId}`,
    description: "ACH return reversed the builder debit and reopened the payable",
    effectiveAt: input.effectiveAt,
    entries: [
      { accountCode: "org_cash", direction: "debit", amountCents: input.amountCents, currency: input.currency },
      { accountCode: "vendor_payable", direction: "credit", amountCents: input.amountCents, currency: input.currency },
    ],
  })
}

/**
 * Arc's unrecovered outlay when a return lands after the vendor has been paid.
 *
 * The payout hold exists to make this rare: a return inside the hold window
 * costs nothing because no transfer was ever created. What survives the hold is
 * a real loss, and it is booked to a named loss account so the number is
 * knowable — an org's cumulative total is what trips its rail off.
 */
export function postApReturnLossLedger(input: {
  orgId: string
  disbursementId: string
  providerEventId: string
  amountCents: number
  currency: string
  effectiveAt: string
}) {
  return postPaymentLedgerTransaction({
    orgId: input.orgId,
    disbursementId: input.disbursementId,
    providerEventId: input.providerEventId,
    sourceType: "provider_event",
    sourceId: input.providerEventId,
    transactionType: "adjustment",
    currency: input.currency,
    idempotencyKey: `disbursement:${input.disbursementId}:return-loss`,
    description: "Unrecovered ACH return: vendor was paid before the debit was reversed",
    effectiveAt: input.effectiveAt,
    entries: [
      { accountCode: "ach_return_loss", direction: "debit", amountCents: input.amountCents, currency: input.currency },
      { accountCode: "payout_clearing", direction: "credit", amountCents: input.amountCents, currency: input.currency },
    ],
  })
}
