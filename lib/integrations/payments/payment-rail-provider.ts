import "server-only"

import type { ProviderSettlementWindow } from "@/lib/payments/settlement-estimate"

export interface RecipientCreateInput {
  vendorEntityId: string
  legalName: string
  email: string
  country: string
}

export interface RecipientSnapshot {
  provider: string
  providerAccountId: string
  status: "onboarding" | "pending_review" | "ready" | "restricted" | "disabled"
  detailsSubmitted: boolean
  payoutsEnabled: boolean
  requirementsCurrentlyDue: string[]
  requirementsEventuallyDue: string[]
  disabledReason: string | null
  bankName: string | null
  bankLast4: string | null
}

export interface FundingSetupSession {
  provider: string
  providerCustomerId: string
  providerSetupId: string
  clientSecret: string
}

export interface FundingSourceSnapshot {
  provider: string
  providerCustomerId: string
  providerPaymentMethodId: string
  providerMandateId: string | null
  bankName: string | null
  last4: string | null
  fingerprint: string | null
  accountHolderType: "individual" | "company" | null
  accountType: "checking" | "savings" | null
  verificationStatus: "pending" | "verified" | "failed"
  mandateStatus: "pending" | "accepted" | "revoked" | "invalid"
}

export interface ProviderDisbursementInput {
  disbursementId: string
  orgId: string
  /**
   * One amount, deliberately. It is both what the builder is debited and what
   * the vendor receives, because AP fees are collected in their own per-run debit
   * rather than added to the payment. Separate debit and recipient figures used to
   * exist here and were the mechanism by which the bank feed line stopped
   * matching the accounting entry.
   */
  amountCents: number
  currency: string
  providerCustomerId: string
  providerPaymentMethodId: string
  recipientProviderAccountId: string
  transferGroup: string
  idempotencyKey: string
  metadata: Record<string, string>
}

export interface ProviderVendorTransferInput {
  disbursementId: string
  orgId: string
  amountCents: number
  currency: string
  recipientProviderAccountId: string
  /** The cleared debit that funds this transfer, when the rail can bind them. */
  providerChargeId: string
  transferGroup: string
  idempotencyKey: string
  /** Remittance note. Providers may display this in transfer history; bank statement display is rail-dependent. */
  memo?: string
  metadata: Record<string, string>
}

export interface ProviderVendorTransferResult {
  provider: string
  providerTransferId: string
}

export interface ProviderPlatformPayoutSettings {
  interval: string
}

export interface ProviderDisbursementReference {
  disbursementId: string | null
  orgId: string | null
  arcProduct: string | null
}

export interface ProviderPlatformChargeInput {
  chargeId: string
  orgId: string
  amountCents: number
  currency: string
  providerCustomerId: string
  providerPaymentMethodId: string
  idempotencyKey: string
  metadata: Record<string, string>
}

export interface ProviderDisbursementResult {
  provider: string
  providerPaymentId: string
  status: "submitted" | "debit_pending" | "funds_available" | "failed"
}

export interface ProviderSettlementSnapshot {
  exists: boolean
  status: "pending" | "settled" | "failed" | "returned"
  debitAmountCents: number
  processorFeeCents: number | null
}

export interface ProviderActivity {
  /**
   * `fee_adjustment` is the rail's own money movement — processing fees,
   * adjustments, reserves, and failed-payout reversals — which is neither a
   * payment Arc submitted nor a payout it expected, and was therefore invisible
   * to a reconciliation that only ever looked at the three it knew about.
   */
  kind: "payment" | "fee_payment" | "transfer" | "payout" | "fee_adjustment"
  providerReference: string
  providerAccountId: string | null
  amountCents: number
  status: "pending" | "settled" | "failed" | "canceled" | "returned"
  linkedReferences: string[]
  metadata: Record<string, string>
  /** Provider's own label for a `fee_adjustment` (its balance-transaction type). */
  activityType?: string
}

/**
 * How the adapter knows this event is Arc's AP money.
 *
 * `provider_tagged` means the provider object itself carries Arc's AP marker, so
 * the event is AP whether or not a local row is found — and must never be
 * reinterpreted by another domain when the lookup misses. `requires_lookup`
 * means the object is shape-compatible with AP but only an Arc-side lookup can
 * settle it: a card dispute and an ACH return arrive as the same Stripe event,
 * and which one it is depends entirely on what Arc has recorded. Making the
 * distinction explicit is what stops an AP intent with no disbursement row from
 * falling through into the receivables ledger path.
 */
export type ProviderEventAttribution = "provider_tagged" | "requires_lookup"

export type NormalizedPaymentRailEvent = {
  provider: string
  providerEventId: string
  providerEventType: string
  providerAccountId: string | null
  occurredAt: string
  attribution: ProviderEventAttribution
  payload: Record<string, unknown>
} & (
  | { kind: "recipient.updated"; recipientProviderAccountId: string }
  | { kind: "fee_charge.status"; providerPaymentId: string; status: "debit_pending" | "succeeded" | "failed" | "canceled" }
  | {
      kind: "disbursement.status"
      providerPaymentId: string
      disbursementId: string | null
      status: "debit_pending" | "funds_available" | "failed" | "canceled" | "transfer_pending"
      providerTransferId: string | null
    }
  /**
   * The transfers a payout settled are deliberately NOT resolved here. Doing so
   * cost an unbounded balance-transaction walk plus one charge retrieval per
   * source before Arc had even asked whether the payout was its own, which is
   * how a large payout timed out a webhook mid-flight. The domain layer resolves
   * them once the recipient account is known to be Arc's.
   */
  | { kind: "disbursement.paid"; providerPayoutId: string }
  | {
      kind: "disbursement.payout_attention"
      providerPayoutId: string
      status: "failed" | "canceled"
      reason: string
    }
  | { kind: "disbursement.returned"; providerPaymentId: string; providerReversalId: string; reason: string }
  | {
      kind: "disbursement.authorization_inquiry"
      providerPaymentId: string
      providerInquiryId: string
      status: string
      reason: string
    }
  | {
      kind: "funding_source.updated"
      providerPaymentMethodId: string
      blocked: boolean
      reason: string | null
    }
  | {
      kind: "disbursement.charge_settled"
      providerPaymentId: string
      providerChargeId: string
      providerBalanceTransactionId: string | null
      actualProcessorFeeCents: number
    }
)

export interface PaymentRailProvider {
  readonly key: string
  /**
   * How long this rail takes, in business days, for each leg of a disbursement.
   * Declarative rather than a call: the numbers are contract terms, not runtime
   * state, and keeping them as data lets the estimate math stay pure and tested.
   */
  readonly settlementWindow: ProviderSettlementWindow
  createRecipient(input: RecipientCreateInput): Promise<RecipientSnapshot>
  createRecipientOnboardingLink(input: { providerAccountId: string; refreshUrl: string; returnUrl: string }): Promise<string>
  retrieveRecipient(providerAccountId: string): Promise<RecipientSnapshot>
  createFundingCustomer(input: { orgId: string; name: string; email?: string | null }): Promise<string>
  createFundingSetup(input: { orgId: string; providerCustomerId: string }): Promise<FundingSetupSession>
  retrieveFundingSource(input: { providerSetupId: string }): Promise<FundingSourceSnapshot>
  submitDisbursement(input: ProviderDisbursementInput): Promise<ProviderDisbursementResult>
  /**
   * Debit the builder for Arc's fees. No vendor destination — the money stays
   * with the platform, which is what distinguishes it from a disbursement and
   * why it is a separate call rather than a disbursement with a null recipient.
   */
  submitPlatformCharge(input: ProviderPlatformChargeInput): Promise<ProviderDisbursementResult>
  /**
   * Send cleared funds on to the vendor.
   *
   * Separate from `submitDisbursement` on purpose: the debit and the payout are
   * two decisions taken at different times, and collapsing them into one call
   * is what removed Arc's ability to hold funds through the return window.
   */
  createVendorTransfer(input: ProviderVendorTransferInput): Promise<ProviderVendorTransferResult>
  reverseVendorTransfer(input: {
    providerTransferId: string
    disbursementId: string
    idempotencyKey: string
  }): Promise<{ providerReversalId: string }>
  findVendorTransfer(input: { transferGroup: string; disbursementId: string }): Promise<ProviderVendorTransferResult | null>
  retrievePlatformPayoutSettings(): Promise<ProviderPlatformPayoutSettings>
  resolveDisbursementReference(input: { providerPaymentId: string }): Promise<ProviderDisbursementReference>
  resolvePaymentChargeId(input: { providerPaymentId: string }): Promise<string | null>
  retrieveSettlement(input: { providerPaymentId: string }): Promise<ProviderSettlementSnapshot>
  /**
   * Independently enumerate provider activity so reconciliation can find money
   * that has no local Arc row, not merely re-fetch rows Arc already knows.
   *
   * Discovery is by **provider-side identity** — the funding customers Arc opened
   * for this org and the connected accounts its vendors are paid into — never by
   * metadata Arc wrote onto its own objects. Filtering on Arc's own marker made
   * the control structurally incapable of seeing the one thing it exists to
   * catch: a movement created outside Arc, or with its metadata stripped.
   * Metadata is still read, but only to classify and to hand an object to the
   * right tenant, never to decide whether it is worth looking at.
   */
  listActivity(input: {
    orgId: string
    periodStart: string
    periodEnd: string
    /** Connected accounts this org's vendors are paid into. */
    recipientProviderAccountIds: string[]
    /** Provider customers Arc created for this org's funding sources. */
    fundingProviderCustomerIds: string[]
  }): Promise<ProviderActivity[]>
  resolveTransferPaymentId(input: { providerTransferId: string }): Promise<string | null>
  resolvePayoutTransferIds(input: { providerAccountId: string; providerPayoutId: string }): Promise<string[]>
  /** Convert provider-specific webhook objects into Arc's event vocabulary. */
  normalizeWebhookEvent(input: unknown): Promise<NormalizedPaymentRailEvent | null>
}
