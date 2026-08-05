import "server-only"

import Stripe from "stripe"

import type {
  FundingSetupSession,
  FundingSourceSnapshot,
  PaymentRailProvider,
  ProviderDisbursementInput,
  ProviderDisbursementResult,
  RecipientCreateInput,
  RecipientSnapshot,
} from "@/lib/integrations/payments/payment-rail-provider"
import { mapWithConcurrency } from "@/lib/payments/concurrency"
import type { ProviderSettlementWindow } from "@/lib/payments/settlement-estimate"

/** Stripe's maximum page size for balance-transaction listing. */
const PAYOUT_PAGE_SIZE = 100
/**
 * A ceiling, not a page cap — pagination walks past it. It exists so a
 * pathological payout raises rather than pinning a webhook worker indefinitely.
 */
const MAX_PAYOUT_BALANCE_TRANSACTIONS = 10_000
/** Enough parallelism to drain a large payout, low enough to stay under rate limits. */
const PAYOUT_CHARGE_CONCURRENCY = 8

let stripeSingleton: Stripe | null = null

function stripeClient() {
  const secret = process.env.STRIPE_SECRET_KEY
  if (!secret) throw new Error("STRIPE_SECRET_KEY is not configured")
  if (!stripeSingleton) stripeSingleton = new Stripe(secret, { apiVersion: "2025-02-24.acacia" })
  return stripeSingleton
}

function assertStripeExecutionMode() {
  const secret = process.env.STRIPE_SECRET_KEY ?? ""
  const mode = process.env.FINTECH_PAYMENTS_MODE
  if (mode !== "test" && mode !== "live") throw new Error("FINTECH_PAYMENTS_MODE must be explicitly set to test or live before payment execution")
  const isTestCredential = secret.includes("_test_")
  const isLiveCredential = secret.includes("_live_")
  if (mode === "test" && !isTestCredential) throw new Error("Test-mode AP execution requires a Stripe test credential")
  if (mode === "live" && (!isLiveCredential || process.env.FINTECH_PAYMENTS_LIVE_MODE_APPROVED !== "true")) {
    throw new Error("Live AP execution requires a live Stripe credential and explicit live-mode approval")
  }
}

function mapRecipientStatus(account: Stripe.Account): RecipientSnapshot["status"] {
  if (account.requirements?.disabled_reason) return "restricted"
  if (account.payouts_enabled && account.details_submitted) return "ready"
  if (account.details_submitted) return "pending_review"
  return "onboarding"
}

async function mapRecipient(account: Stripe.Account): Promise<RecipientSnapshot> {
  const externalAccounts = await stripeClient().accounts.listExternalAccounts(account.id, { object: "bank_account", limit: 1 })
  const bank = externalAccounts.data[0]
  return {
    provider: "stripe",
    providerAccountId: account.id,
    status: mapRecipientStatus(account),
    detailsSubmitted: Boolean(account.details_submitted),
    payoutsEnabled: Boolean(account.payouts_enabled),
    requirementsCurrentlyDue: account.requirements?.currently_due ?? [],
    requirementsEventuallyDue: account.requirements?.eventually_due ?? [],
    disabledReason: account.requirements?.disabled_reason ?? null,
    bankName: bank && bank.object === "bank_account" ? bank.bank_name ?? null : null,
    bankLast4: bank?.last4 ?? null,
  }
}

function mapIntentStatus(status: Stripe.PaymentIntent.Status): ProviderDisbursementResult["status"] {
  if (status === "succeeded") return "funds_available"
  if (status === "processing") return "debit_pending"
  if (status === "canceled" || status === "requires_payment_method") return "failed"
  return "submitted"
}

/**
 * ⚠ UNCONFIRMED PRICING/TIMING INPUT. These are Stripe's published typical
 * windows for an ACH debit clearing to the platform balance (leg one) and an
 * Express connected account's default daily payout reaching the vendor's bank
 * (leg two). They have NOT been confirmed against Arc's Stripe program
 * configuration, which is gated by the fintech gameplan's "STOP — Stripe program
 * configuration" (§8, Phase 2): payout schedule, controller configuration, and
 * settlement timing all move these numbers.
 *
 * Everything downstream presents the result as an estimated window, never a
 * commitment. Confirm with Stripe, then change the four numbers here.
 */
const STRIPE_SETTLEMENT_WINDOW: ProviderSettlementWindow = {
  debitBusinessDays: { min: 4, max: 5 },
  payoutBusinessDays: { min: 1, max: 2 },
}

export const stripeApProvider: PaymentRailProvider = {
  key: "stripe",
  settlementWindow: STRIPE_SETTLEMENT_WINDOW,

  async createRecipient(input: RecipientCreateInput) {
    const account = await stripeClient().accounts.create({
      type: "express",
      country: input.country,
      email: input.email,
      business_profile: { name: input.legalName },
      capabilities: { transfers: { requested: true } },
      metadata: { vendor_entity_id: input.vendorEntityId, arc_product: "vendor_payments" },
    }, { idempotencyKey: `vendor-entity:${input.vendorEntityId}:recipient` })
    return mapRecipient(account)
  },

  async createRecipientOnboardingLink(input) {
    const link = await stripeClient().accountLinks.create({
      account: input.providerAccountId,
      refresh_url: input.refreshUrl,
      return_url: input.returnUrl,
      type: "account_onboarding",
    })
    return link.url
  },

  async retrieveRecipient(providerAccountId) {
    const account = await stripeClient().accounts.retrieve(providerAccountId)
    if (account.deleted) throw new Error("Stripe recipient account was deleted")
    return mapRecipient(account)
  },

  async createFundingCustomer(input) {
    const customer = await stripeClient().customers.create({
      name: input.name,
      email: input.email ?? undefined,
      metadata: { org_id: input.orgId, arc_product: "ap_funding" },
    }, { idempotencyKey: `org:${input.orgId}:ap-funding-customer` })
    return customer.id
  },

  async createFundingSetup(input): Promise<FundingSetupSession> {
    const setupIntent = await stripeClient().setupIntents.create({
      customer: input.providerCustomerId,
      payment_method_types: ["us_bank_account"],
      payment_method_options: {
        us_bank_account: {
          financial_connections: { permissions: ["payment_method", "balances"] },
          verification_method: "instant",
        },
      },
      metadata: { org_id: input.orgId, arc_product: "ap_funding" },
    })
    if (!setupIntent.client_secret) throw new Error("Stripe did not return a funding setup client secret")
    return {
      provider: "stripe",
      providerCustomerId: input.providerCustomerId,
      providerSetupId: setupIntent.id,
      clientSecret: setupIntent.client_secret,
    }
  },

  async retrieveFundingSource(input): Promise<FundingSourceSnapshot> {
    const setupIntent = await stripeClient().setupIntents.retrieve(input.providerSetupId, {
      expand: ["payment_method", "mandate"],
    })
    if (setupIntent.status !== "succeeded") throw new Error("Bank account setup is not complete")
    const paymentMethod = setupIntent.payment_method
    if (!paymentMethod || typeof paymentMethod === "string" || paymentMethod.type !== "us_bank_account") {
      throw new Error("Funding setup did not produce a US bank account")
    }
    const bank = paymentMethod.us_bank_account
    const customerId = typeof setupIntent.customer === "string" ? setupIntent.customer : setupIntent.customer?.id
    if (!customerId) throw new Error("Funding setup is missing its customer")
    const mandateId = typeof setupIntent.mandate === "string" ? setupIntent.mandate : setupIntent.mandate?.id ?? null
    return {
      provider: "stripe",
      providerCustomerId: customerId,
      providerPaymentMethodId: paymentMethod.id,
      providerMandateId: mandateId,
      bankName: bank?.bank_name ?? null,
      last4: bank?.last4 ?? null,
      fingerprint: bank?.fingerprint ?? null,
      accountHolderType: bank?.account_holder_type ?? null,
      accountType: bank?.account_type ?? null,
      // A SetupIntent only reaches `succeeded` after Stripe has verified the
      // selected Financial Connections bank account for this mandate.
      verificationStatus: "verified",
      mandateStatus: mandateId ? "accepted" : "pending",
    }
  },

  async submitDisbursement(input: ProviderDisbursementInput): Promise<ProviderDisbursementResult> {
    assertStripeExecutionMode()
    const intent = await stripeClient().paymentIntents.create({
      amount: input.amountCents,
      currency: input.currency,
      customer: input.providerCustomerId,
      payment_method: input.providerPaymentMethodId,
      payment_method_types: ["us_bank_account"],
      confirm: true,
      off_session: true,
      // Deliberately NOT a destination charge. `transfer_data` would make Stripe
      // create the vendor transfer the instant this debit clears, which hands
      // away the only decision that matters for return risk: when the money
      // stops being recoverable. The debit lands on the platform balance and the
      // transfer is created later, by Arc, after the hold — see
      // `releaseMaturedVendorTransfers`.
      transfer_group: input.transferGroup,
      metadata: {
        ...input.metadata,
        org_id: input.orgId,
        disbursement_id: input.disbursementId,
        charge_type: "destination",
        arc_product: "vendor_payments",
      },
    }, { idempotencyKey: input.idempotencyKey })
    return { provider: "stripe", providerPaymentId: intent.id, status: mapIntentStatus(intent.status) }
  },

  async createVendorTransfer(input) {
    assertStripeExecutionMode()
    const transfer = await stripeClient().transfers.create({
      amount: input.amountCents,
      currency: input.currency,
      destination: input.recipientProviderAccountId,
      // Binds the transfer to the specific charge that funded it, so Stripe
      // draws on those funds rather than whatever happens to be on the platform
      // balance — and so a reconciliation can trace vendor money to its debit.
      ...(input.providerChargeId ? { source_transaction: input.providerChargeId } : {}),
      transfer_group: input.transferGroup,
      metadata: { ...input.metadata, arc_product: "vendor_payments" },
    }, { idempotencyKey: input.idempotencyKey })
    return { provider: "stripe", providerTransferId: transfer.id }
  },

  async submitPlatformCharge(input) {
    assertStripeExecutionMode()
    // No `transfer_data`: the funds stay on the platform balance. This is Arc
    // collecting its own fee, not a payment on the builder's behalf, and the
    // absence of a destination is the whole difference.
    const intent = await stripeClient().paymentIntents.create({
      amount: input.amountCents,
      currency: input.currency,
      customer: input.providerCustomerId,
      payment_method: input.providerPaymentMethodId,
      payment_method_types: ["us_bank_account"],
      confirm: true,
      off_session: true,
      metadata: {
        ...input.metadata,
        org_id: input.orgId,
        fee_charge_id: input.chargeId,
        charge_type: "platform_fee",
        arc_product: "vendor_payments",
      },
    }, { idempotencyKey: input.idempotencyKey })
    return { provider: "stripe", providerPaymentId: intent.id, status: mapIntentStatus(intent.status) }
  },

  async retrieveSettlement(input) {
    try {
      const intent = await stripeClient().paymentIntents.retrieve(input.providerPaymentId, {
        expand: ["latest_charge.balance_transaction"],
      })
      const charge = intent.latest_charge && typeof intent.latest_charge !== "string" ? intent.latest_charge : null
      const balance = charge?.balance_transaction && typeof charge.balance_transaction !== "string"
        ? charge.balance_transaction
        : null
      const status = intent.status === "succeeded"
        ? "settled"
        : intent.status === "canceled" || intent.status === "requires_payment_method"
          ? "failed"
          : "pending"
      return {
        exists: true,
        status,
        debitAmountCents: intent.amount_received > 0 ? intent.amount_received : intent.amount,
        processorFeeCents: balance?.fee ?? null,
      }
    } catch (error) {
      if (error instanceof Stripe.errors.StripeInvalidRequestError && error.code === "resource_missing") {
        return { exists: false, status: "failed", debitAmountCents: 0, processorFeeCents: null }
      }
      throw error
    }
  },

  async resolveTransferPaymentId(input) {
    const transfer = await stripeClient().transfers.retrieve(input.providerTransferId)
    const sourceTransaction = typeof transfer.source_transaction === "string"
      ? transfer.source_transaction
      : transfer.source_transaction?.id
    if (!sourceTransaction) return null
    const charge = await stripeClient().charges.retrieve(sourceTransaction)
    return typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id ?? null
  },

  async resolvePayoutTransferIds(input) {
    // A vendor entity is global across builders, so one Stripe payout routinely
    // bundles transfers from several of them. Every page has to be walked: a
    // truncated list silently strands disbursements in payout_pending forever,
    // and the failure gets worse as more builders pay the same vendor.
    const sourceIds: string[] = []
    let truncated = false
    await stripeClient().balanceTransactions
      .list({ payout: input.providerPayoutId, type: "payment", limit: PAYOUT_PAGE_SIZE }, { stripeAccount: input.providerAccountId })
      .autoPagingEach((transaction) => {
        const sourceId = typeof transaction.source === "string" ? transaction.source : transaction.source?.id
        if (sourceId) sourceIds.push(sourceId)
        if (sourceIds.length < MAX_PAYOUT_BALANCE_TRANSACTIONS) return
        truncated = true
        return false
      })
    // Refusing to return a partial answer is the point. Stripe retries the
    // webhook, and an unresolvable payout raises an exception a human owns
    // rather than quietly closing some of the bills it paid.
    if (truncated) {
      throw new Error(`Payout ${input.providerPayoutId} exceeds ${MAX_PAYOUT_BALANCE_TRANSACTIONS} settled charges; resolve it manually rather than paying out a partial match`)
    }

    const resolved = await mapWithConcurrency(sourceIds, PAYOUT_CHARGE_CONCURRENCY, async (sourceId) => {
      try {
        const destinationCharge = await stripeClient().charges.retrieve(sourceId, {}, { stripeAccount: input.providerAccountId })
        return typeof destinationCharge.source_transfer === "string"
          ? destinationCharge.source_transfer
          : destinationCharge.source_transfer?.id ?? null
      } catch (error) {
        // Non-charge balance activity (fees, adjustments, reserves) can still
        // appear and does not correspond to one Arc disbursement. Anything else
        // is a real provider failure and must not be swallowed into a short list.
        if (error instanceof Stripe.errors.StripeInvalidRequestError && error.code === "resource_missing") return null
        throw error
      }
    })
    return [...new Set(resolved.filter((transferId): transferId is string => Boolean(transferId)))]
  },
}
