import "server-only"

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
  recipientAmountCents: number
  debitAmountCents: number
  processorFeeCents: number
  platformFeeCents: number
  currency: string
  providerCustomerId: string
  providerPaymentMethodId: string
  recipientProviderAccountId: string
  transferGroup: string
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
  createRecipient(input: RecipientCreateInput): Promise<RecipientSnapshot>
  createRecipientOnboardingLink(input: { providerAccountId: string; refreshUrl: string; returnUrl: string }): Promise<string>
  retrieveRecipient(providerAccountId: string): Promise<RecipientSnapshot>
  createFundingCustomer(input: { orgId: string; name: string; email?: string | null }): Promise<string>
  createFundingSetup(input: { orgId: string; providerCustomerId: string }): Promise<FundingSetupSession>
  retrieveFundingSource(input: { providerSetupId: string }): Promise<FundingSourceSnapshot>
  submitDisbursement(input: ProviderDisbursementInput): Promise<ProviderDisbursementResult>
  retrieveSettlement(input: { providerPaymentId: string }): Promise<ProviderSettlementSnapshot>
  resolveTransferPaymentId(input: { providerTransferId: string }): Promise<string | null>
  resolvePayoutTransferIds(input: { providerAccountId: string; providerPayoutId: string }): Promise<string[]>
}
