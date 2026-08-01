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

export function postDisbursementSubmittedLedger(input: {
  orgId: string
  disbursementId: string
  vendorAmountCents: number
  processorFeeCents: number
  platformFeeCents: number
  currency: string
  effectiveAt: string
}) {
  const debitEntries: LedgerEntryInput[] = [
    { accountCode: "ach_clearing", direction: "debit", amountCents: input.vendorAmountCents, currency: input.currency },
  ]
  if (input.processorFeeCents > 0) debitEntries.push({ accountCode: "processor_fee_expense", direction: "debit", amountCents: input.processorFeeCents, currency: input.currency })
  if (input.platformFeeCents > 0) debitEntries.push({ accountCode: "platform_fee_expense", direction: "debit", amountCents: input.platformFeeCents, currency: input.currency })
  const totalDebitCents = input.vendorAmountCents + input.processorFeeCents + input.platformFeeCents
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
      ...debitEntries,
      { accountCode: "org_cash", direction: "credit", amountCents: totalDebitCents, currency: input.currency },
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
    description: "ACH return held in suspense pending provider loss allocation",
    effectiveAt: input.effectiveAt,
    entries: [
      { accountCode: "org_cash", direction: "debit", amountCents: input.amountCents, currency: input.currency },
      { accountCode: "suspense", direction: "credit", amountCents: input.amountCents, currency: input.currency },
    ],
  })
}
