import "server-only"

import { assertBalancedLedgerEntries, type LedgerEntryInput } from "@/lib/payments/payment-domain"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * The payment rails subledger — **not** a general ledger.
 *
 * This records what the money rails did: the builder's bank debit, funds clearing,
 * the vendor payout, fee accrual and collection, returns. It is balanced double entry
 * because provider events demand that rigour, but it is deliberately **outside** Arc
 * Books and must never feed the projector.
 *
 * The general ledger derives from `payments` and `payment_reversals`. Those already
 * carry every economic fact a rail payment produces: `record_ap_payment_atomic` writes
 * a `payments` row with the vendor amount, `processor_fee_cents`, `platform_fee_cents`,
 * and the bill link, and the projector posts AP, cash, and fee expense from it.
 * Consuming this subledger as well would post every rail payment **twice** — the
 * submitted and paid transactions below net to exactly the entry `postBillPayment`
 * already makes.
 *
 * What this subledger uniquely holds is rails-grain *timing* (money in transit between
 * debit and payout) and Arc's own platform economics. Neither belongs in a builder's
 * general ledger. The reconciliation spine ties the two together instead: every paid
 * disbursement here must have a matching `payments` row, which is what keeps the GL
 * honest without a second posting path.
 *
 * See `docs/plans/arc-books-gameplan.md` C2.1.2.
 */

/**
 * The transaction a reversal undoes, by the idempotency key that named it.
 *
 * `reverses_transaction_id` existed from the first migration and was never once
 * populated, so a reversal could only be tied back to its original by parsing
 * the idempotency-key string convention — which is not a foreign key, is not
 * enforced, and silently stops working the day a key format changes.
 */
async function findLedgerTransactionId(orgId: string, idempotencyKey: string): Promise<string | null> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase.from("payment_ledger_transactions")
    .select("id")
    .eq("org_id", orgId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle()
  if (error) throw new Error(`Unable to resolve the ledger transaction being reversed: ${error.message}`)
  return data?.id ? String(data.id) : null
}

export async function postPaymentLedgerTransaction(input: {
  orgId: string
  disbursementId?: string | null
  providerEventId?: string | null
  sourceType: "payment_run" | "disbursement" | "provider_event" | "reconciliation" | "manual_adjustment"
  sourceId?: string | null
  /**
   * The DB check still allows `funds_available`, `transfer_created` and
   * `processor_fee`. Nothing has ever emitted them: clearing and the vendor
   * transfer leg move no money between these accounts on their own, and the
   * processor fee is recognised as part of the run's fee accrual. They are left
   * out here so the type describes what this subledger actually posts rather
   * than what someone once imagined it might.
   */
  transactionType: "payment_submitted" | "payout_paid" | "platform_fee" | "return" | "reversal" | "adjustment"
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
export async function postApFeeChargeReversalLedger(input: {
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
    reversesTransactionId: await findLedgerTransactionId(input.orgId, `payment_run_fee_charge:${input.feeChargeId}:submitted`),
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
export async function postDisbursementSubmissionReversalLedger(input: {
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
    reversesTransactionId: await findLedgerTransactionId(input.orgId, `disbursement:${input.disbursementId}:submitted`),
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
export async function postDisbursementReturnLedger(input: { orgId: string; disbursementId: string; providerEventId: string; amountCents: number; currency: string; effectiveAt: string }) {
  return postPaymentLedgerTransaction({
    orgId: input.orgId,
    disbursementId: input.disbursementId,
    providerEventId: input.providerEventId,
    sourceType: "provider_event",
    sourceId: input.providerEventId,
    transactionType: "return",
    currency: input.currency,
    idempotencyKey: `disbursement:${input.disbursementId}:return:${input.providerEventId}`,
    // The settlement being undone. A return only reaches this helper when the
    // vendor was already paid, so the paid transaction is what it reverses.
    reversesTransactionId: await findLedgerTransactionId(input.orgId, `disbursement:${input.disbursementId}:paid`),
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
 *
 * The loss is Arc's but the row carries the builder's `org_id`, which is deliberate:
 * `enforceReturnLossCeiling` needs the per-org total to decide whose rail to disable.
 * It never reaches the builder's own books, because this subledger does not feed the
 * projector — see the module header. That is the whole reason the boundary matters.
 *
 * **Why the credit side is `payout_clearing`, and what it means that it never
 * clears.** A loss is a permanent consumption of value, so its contra has to be
 * cash — and this subledger's account set has no Arc-cash account, only the
 * builder's `org_cash`, which would be a lie here: the builder's money came back,
 * Arc's did not. `payout_clearing` is the closest true statement available; it is
 * the leg between the platform balance and the vendor's bank, which is exactly the
 * money that left and is not coming back. The consequence is that this account
 * carries a standing credit balance equal to cumulative unrecovered outlay,
 * because nothing debits it: the platform-to-vendor transfer leg is not posted at
 * all (which is also why `transfer_created` has no emitter). That residual is
 * intentional and readable — it is the same number `ach_return_loss` carries as a
 * debit — but it is a modelling gap, not a clearing account doing its job.
 * Closing it properly means posting the transfer leg and adding an Arc-cash
 * account to the DB check, which is a schema change and a change to how
 * `postDisbursementPaidLedger` books settlement.
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
