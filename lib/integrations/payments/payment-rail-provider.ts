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
  providerChargeId: string | null
  transferGroup: string
  idempotencyKey: string
  metadata: Record<string, string>
}

export interface ProviderVendorTransferResult {
  provider: string
  providerTransferId: string
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
  retrieveSettlement(input: { providerPaymentId: string }): Promise<ProviderSettlementSnapshot>
  resolveTransferPaymentId(input: { providerTransferId: string }): Promise<string | null>
  resolvePayoutTransferIds(input: { providerAccountId: string; providerPayoutId: string }): Promise<string[]>
}
