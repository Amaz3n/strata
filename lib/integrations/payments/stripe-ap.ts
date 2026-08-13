import "server-only"

import Stripe from "stripe"

import type {
  FundingSetupSession,
  FundingSourceSnapshot,
  NormalizedPaymentRailEvent,
  PaymentRailProvider,
  ProviderDisbursementInput,
  ProviderDisbursementResult,
  ProviderActivity,
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

/**
 * The Express account Arc already created for this vendor entity, if one exists.
 *
 * Stripe has no metadata query for accounts — the Search API does not cover
 * them — so this is a bounded walk of the platform's connected accounts. The cap
 * is what keeps a pathological account list from turning vendor onboarding into
 * an unbounded crawl; past it we accept the (rare, recoverable) duplicate rather
 * than hang. Onboarding a vendor happens once, so the cost lands in the right
 * place. If the connected-account count ever approaches the cap, the durable
 * answer is to persist the provider account id before the local row is written,
 * not to raise this number.
 */
const MAX_RECIPIENT_LOOKUP_ACCOUNTS = 1_000

async function findRecipientByVendorEntity(vendorEntityId: string): Promise<Stripe.Account | null> {
  let match: Stripe.Account | null = null
  let scanned = 0
  await stripeClient().accounts.list({ limit: 100 }).autoPagingEach((account) => {
    scanned += 1
    if (account.metadata?.vendor_entity_id === vendorEntityId) {
      match = account
      return false
    }
    if (scanned >= MAX_RECIPIENT_LOOKUP_ACCOUNTS) return false
    return undefined
  })
  return match
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

function settlementStatus(status: Stripe.PaymentIntent.Status): ProviderActivity["status"] {
  if (status === "succeeded") return "settled"
  if (status === "canceled") return "canceled"
  if (status === "requires_payment_method") return "failed"
  return "pending"
}

function stripeMetadata(metadata: Stripe.Metadata | null | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(metadata ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
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
    // Creating a vendor-facing Express account against live credentials is money
    // infrastructure even though no money moves in this call: it is the thing a
    // payout is later sent to. It was the one provider-account call outside the
    // execution-mode gate, so accounts could be minted on live keys before
    // FINTECH_PAYMENTS_LIVE_MODE_APPROVED was ever set.
    assertStripeExecutionMode()
    // Stripe's idempotency keys expire after 24 hours, so a local insert that
    // failed after the account was created stops protecting us the next day and
    // the retry mints a SECOND Express account for the same vendor. Look for the
    // one we already made before creating another.
    const existing = await findRecipientByVendorEntity(input.vendorEntityId)
    if (existing) return mapRecipient(existing)
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
    assertStripeExecutionMode()
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
    assertStripeExecutionMode()
    const customer = await stripeClient().customers.create({
      name: input.name,
      email: input.email ?? undefined,
      metadata: { org_id: input.orgId, arc_product: "ap_funding" },
    }, { idempotencyKey: `org:${input.orgId}:ap-funding-customer` })
    return customer.id
  },

  async createFundingSetup(input): Promise<FundingSetupSession> {
    // Collects a real bank account against the platform's credentials, so it
    // belongs behind the same gate as the customer it attaches to.
    assertStripeExecutionMode()
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
        charge_type: "vendor_disbursement",
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
      description: input.memo,
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

  async listActivity(input) {
    const created = {
      gte: Math.floor(new Date(input.periodStart).getTime() / 1000),
      lt: Math.floor(new Date(input.periodEnd).getTime() / 1000),
    }
    const activity: ProviderActivity[] = []

    let paymentCursor: string | undefined
    do {
      const page = await stripeClient().paymentIntents.list({ created, limit: 100, ...(paymentCursor ? { starting_after: paymentCursor } : {}) })
      for (const intent of page.data) {
        if (intent.metadata.arc_product !== "vendor_payments") continue
        activity.push({
          kind: intent.metadata.charge_type === "platform_fee" ? "fee_payment" : "payment",
          providerReference: intent.id,
          providerAccountId: null,
          amountCents: intent.amount_received > 0 ? intent.amount_received : intent.amount,
          status: settlementStatus(intent.status),
          linkedReferences: [],
          metadata: stripeMetadata(intent.metadata),
        })
      }
      paymentCursor = page.has_more ? page.data.at(-1)?.id : undefined
    } while (paymentCursor)

    let transferCursor: string | undefined
    do {
      const page = await stripeClient().transfers.list({ created, limit: 100, ...(transferCursor ? { starting_after: transferCursor } : {}) })
      for (const transfer of page.data) {
        if (transfer.metadata.arc_product !== "vendor_payments") continue
        const source = typeof transfer.source_transaction === "string" ? transfer.source_transaction : transfer.source_transaction?.id
        activity.push({
          kind: "transfer",
          providerReference: transfer.id,
          providerAccountId: typeof transfer.destination === "string" ? transfer.destination : transfer.destination?.id ?? null,
          amountCents: transfer.amount,
          status: transfer.reversed ? "returned" : "settled",
          linkedReferences: source ? [source] : [],
          metadata: stripeMetadata(transfer.metadata),
        })
      }
      transferCursor = page.has_more ? page.data.at(-1)?.id : undefined
    } while (transferCursor)

    for (const providerAccountId of [...new Set(input.recipientProviderAccountIds)]) {
      let payoutCursor: string | undefined
      do {
        const page = await stripeClient().payouts.list(
          { created, limit: 100, ...(payoutCursor ? { starting_after: payoutCursor } : {}) },
          { stripeAccount: providerAccountId },
        )
        const payoutRows = await mapWithConcurrency(page.data, 4, async (payout) => ({
          payout,
          transferIds: await stripeApProvider.resolvePayoutTransferIds({ providerAccountId, providerPayoutId: payout.id }),
        }))
        for (const { payout, transferIds } of payoutRows) {
          if (transferIds.length === 0) continue
          const status: ProviderActivity["status"] = payout.status === "paid"
            ? "settled"
            : payout.status === "failed"
              ? "failed"
              : payout.status === "canceled"
                ? "canceled"
                : "pending"
          activity.push({
            kind: "payout",
            providerReference: payout.id,
            providerAccountId,
            amountCents: payout.amount,
            status,
            linkedReferences: transferIds,
            metadata: stripeMetadata(payout.metadata),
          })
        }
        payoutCursor = page.has_more ? page.data.at(-1)?.id : undefined
      } while (payoutCursor)
    }

    return activity
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

  async normalizeWebhookEvent(input): Promise<NormalizedPaymentRailEvent | null> {
    const event = input as Stripe.Event
    if (!event || typeof event.id !== "string" || typeof event.type !== "string" || !event.data?.object) {
      throw new Error("Stripe webhook event is malformed")
    }
    const base = {
      provider: "stripe",
      providerEventId: event.id,
      providerEventType: event.type,
      providerAccountId: typeof event.account === "string" ? event.account : null,
      occurredAt: new Date(event.created * 1000).toISOString(),
      payload: JSON.parse(JSON.stringify(event)) as Record<string, unknown>,
    }
    if (event.type === "account.updated") {
      const account = event.data.object as Stripe.Account
      return { ...base, kind: "recipient.updated", recipientProviderAccountId: account.id }
    }
    if (["account.external_account.created", "account.external_account.updated", "account.external_account.deleted"].includes(event.type) && base.providerAccountId) {
      return { ...base, kind: "recipient.updated", recipientProviderAccountId: base.providerAccountId }
    }
    if (event.type === "payment_method.automatically_updated") {
      const paymentMethod = event.data.object as Stripe.PaymentMethod
      const statusDetails = paymentMethod.us_bank_account?.status_details
      const blocked = Boolean(statusDetails && "blocked" in statusDetails && statusDetails.blocked)
      return {
        ...base,
        kind: "funding_source.updated",
        providerPaymentMethodId: paymentMethod.id,
        blocked,
        reason: blocked ? "Stripe reported the ACH bank account as blocked" : null,
      }
    }
    if (event.type.startsWith("payment_intent.")) {
      const intent = event.data.object as Stripe.PaymentIntent
      if (intent.metadata.arc_product !== "vendor_payments") return null
      const status = event.type === "payment_intent.processing"
        ? "debit_pending"
        : event.type === "payment_intent.succeeded"
          ? "funds_available"
          : event.type === "payment_intent.payment_failed"
            ? "failed"
            : event.type === "payment_intent.canceled"
              ? "canceled"
              : null
      if (!status) return null
      if (intent.metadata.charge_type === "platform_fee") {
        return {
          ...base,
          kind: "fee_charge.status",
          providerPaymentId: intent.id,
          status: status === "funds_available" ? "succeeded" : status,
        }
      }
      return {
        ...base,
        kind: "disbursement.status",
        providerPaymentId: intent.id,
        disbursementId: intent.metadata.disbursement_id || null,
        status,
        providerTransferId: null,
      }
    }
    if (event.type === "transfer.created") {
      const transfer = event.data.object as Stripe.Transfer
      const paymentId = await stripeApProvider.resolveTransferPaymentId({ providerTransferId: transfer.id })
      if (!paymentId) return null
      return {
        ...base,
        kind: "disbursement.status",
        providerPaymentId: paymentId,
        disbursementId: null,
        status: "transfer_pending",
        providerTransferId: transfer.id,
      }
    }
    if (event.type === "payout.paid") {
      if (!base.providerAccountId) return null
      const payout = event.data.object as Stripe.Payout
      const transferIds = await stripeApProvider.resolvePayoutTransferIds({
        providerAccountId: base.providerAccountId,
        providerPayoutId: payout.id,
      })
      return { ...base, kind: "disbursement.paid", providerPayoutId: payout.id, providerTransferIds: transferIds }
    }
    if (event.type === "payout.failed" || event.type === "payout.canceled") {
      if (!base.providerAccountId) return null
      const payout = event.data.object as Stripe.Payout
      const transferIds = await stripeApProvider.resolvePayoutTransferIds({
        providerAccountId: base.providerAccountId,
        providerPayoutId: payout.id,
      })
      return {
        ...base,
        kind: "disbursement.payout_attention",
        providerPayoutId: payout.id,
        providerTransferIds: transferIds,
        status: event.type === "payout.failed" ? "failed" : "canceled",
        reason: payout.failure_message ?? payout.failure_code ?? `Stripe payout ${event.type === "payout.failed" ? "failed" : "was canceled"}`,
      }
    }
    if (["charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed"].includes(event.type)) {
      const dispute = event.data.object as Stripe.Dispute
      const paymentId = typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id
      if (!paymentId) return null
      if (String(dispute.status).startsWith("warning_")) {
        return {
          ...base,
          kind: "disbursement.authorization_inquiry",
          providerPaymentId: paymentId,
          providerInquiryId: dispute.id,
          status: dispute.status,
          reason: dispute.reason ?? "ACH authorization evidence requested",
        }
      }
      if (event.type !== "charge.dispute.created") return null
      return {
        ...base,
        kind: "disbursement.returned",
        providerPaymentId: paymentId,
        providerReversalId: dispute.id,
        reason: dispute.reason ?? "ACH payment returned",
      }
    }
    if (event.type === "charge.succeeded") {
      const eventCharge = event.data.object as Stripe.Charge
      const paymentId = typeof eventCharge.payment_intent === "string" ? eventCharge.payment_intent : eventCharge.payment_intent?.id
      if (!paymentId) return null
      const charge = await stripeClient().charges.retrieve(eventCharge.id, {
        expand: ["balance_transaction"],
      }, base.providerAccountId ? { stripeAccount: base.providerAccountId } : undefined)
      const balance = charge.balance_transaction && typeof charge.balance_transaction !== "string" ? charge.balance_transaction : null
      return {
        ...base,
        kind: "disbursement.charge_settled",
        providerPaymentId: paymentId,
        providerChargeId: charge.id,
        providerBalanceTransactionId: balance?.id ?? null,
        actualProcessorFeeCents: balance?.fee ?? 0,
      }
    }
    return null
  },
}
