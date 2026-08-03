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

let stripeSingleton: Stripe | null = null

function stripeClient() {
  const secret = process.env.STRIPE_SECRET_KEY
  if (!secret) throw new Error("STRIPE_SECRET_KEY is not configured")
  if (!stripeSingleton) stripeSingleton = new Stripe(secret, { apiVersion: "2025-02-24.acacia" })
  return stripeSingleton
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

export const stripeApProvider: PaymentRailProvider = {
  key: "stripe",

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
    const intent = await stripeClient().paymentIntents.create({
      amount: input.debitAmountCents,
      currency: input.currency,
      customer: input.providerCustomerId,
      payment_method: input.providerPaymentMethodId,
      payment_method_types: ["us_bank_account"],
      confirm: true,
      off_session: true,
      // Stripe rejects `application_fee_amount` alongside `transfer_data[amount]`
      // on a destination charge — they are two ways to express the same split.
      // We send the vendor's exact take and keep the remainder (processor +
      // platform fees) on the platform balance, so the fee never has to be
      // re-derived from the charge total.
      transfer_data: {
        destination: input.recipientProviderAccountId,
        amount: input.recipientAmountCents,
      },
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
    const activity = await stripeClient().balanceTransactions.list(
      { payout: input.providerPayoutId, limit: 100 },
      { stripeAccount: input.providerAccountId },
    )
    const transferIds = new Set<string>()
    for (const transaction of activity.data) {
      const sourceId = typeof transaction.source === "string" ? transaction.source : transaction.source?.id
      if (!sourceId) continue
      try {
        const destinationCharge = await stripeClient().charges.retrieve(sourceId, {}, { stripeAccount: input.providerAccountId })
        const sourceTransfer = typeof destinationCharge.source_transfer === "string"
          ? destinationCharge.source_transfer
          : destinationCharge.source_transfer?.id
        if (sourceTransfer) transferIds.add(sourceTransfer)
      } catch {
        // Non-charge balance activity (fees, adjustments, reserves) is expected in
        // a payout and does not correspond to one Arc disbursement.
      }
    }
    return [...transferIds]
  },
}
