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
/** Rail movements that are not a payment, a transfer, or a payout. */
const FEE_ADJUSTMENT_BALANCE_TYPES = ["stripe_fee", "adjustment", "reserve_transaction", "payout_failure"] as const

const DEFINITIVE_SUBMISSION_CODES = new Set([
  "account_closed",
  "bank_account_unusable",
  "customer_cash_balance_transactional_currency_mismatch",
  "payment_method_customer_decline",
  "payment_method_microdeposit_verification_attempts_exceeded",
  "payment_method_microdeposit_verification_timeout",
  "payment_method_not_available",
  "payment_method_provider_decline",
  "payment_method_unactivated",
  "resource_missing",
])

/** Whether retrying the same idempotency key is recovery or a known rejection. */
export function classifyStripeSubmissionError(error: unknown): "definitive" | "ambiguous" {
  if (!error || typeof error !== "object") return "ambiguous"
  const code = typeof Reflect.get(error, "code") === "string" ? Reflect.get(error, "code") : null
  const declineCode = typeof Reflect.get(error, "decline_code") === "string" ? Reflect.get(error, "decline_code") : null
  const type = typeof Reflect.get(error, "type") === "string" ? Reflect.get(error, "type") : null
  if ((code && DEFINITIVE_SUBMISSION_CODES.has(code)) || (declineCode && DEFINITIVE_SUBMISSION_CODES.has(declineCode))) return "definitive"
  if (type === "StripeCardError" || type === "StripeInvalidRequestError") return "definitive"
  return "ambiguous"
}

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

/**
 * Rail movements that are neither a payment nor a payout: Stripe's own fees,
 * manual adjustments, reserve holds, and the reversal that lands when a payout
 * bounces. None of them are anything Arc submitted, so nothing in the old
 * three-kind reconciliation could see them — a reserve placed on a vendor
 * account, or a failed payout that quietly returned funds, left no trace.
 *
 * Enumerated on the vendors' connected accounts only. The same balance
 * transaction types also exist on the platform account, but those are Arc's own
 * cost of doing business rather than any one builder's money, and posting them
 * into an org-scoped exception queue would charge every tenant for the same
 * platform fee. That is a platform-level control, not this one.
 */
async function listRecipientFeeAdjustments(
  providerAccountId: string,
  created: { gte: number; lt: number },
): Promise<ProviderActivity[]> {
  const rows: ProviderActivity[] = []
  for (const type of FEE_ADJUSTMENT_BALANCE_TYPES) {
    let cursor: string | undefined
    do {
      const page = await stripeClient().balanceTransactions.list(
        { created, type, limit: 100, ...(cursor ? { starting_after: cursor } : {}) },
        { stripeAccount: providerAccountId },
      )
      for (const transaction of page.data) {
        const sourceId = typeof transaction.source === "string" ? transaction.source : transaction.source?.id
        rows.push({
          kind: "fee_adjustment",
          providerReference: transaction.id,
          providerAccountId,
          // Fees and reversals are negative on the balance; the exception queue
          // reports the signed movement so a reserve reads as money withheld.
          amountCents: transaction.amount,
          status: transaction.status === "available" ? "settled" : "pending",
          linkedReferences: sourceId ? [sourceId] : [],
          metadata: {},
          activityType: transaction.type,
        })
      }
      cursor = page.has_more ? page.data.at(-1)?.id : undefined
    } while (cursor)
  }
  return rows
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
      source_transaction: input.providerChargeId,
      transfer_group: input.transferGroup,
      description: input.memo,
      metadata: { ...input.metadata, arc_product: "vendor_payments" },
    }, { idempotencyKey: input.idempotencyKey })
    return { provider: "stripe", providerTransferId: transfer.id }
  },

  async reverseVendorTransfer(input) {
    assertStripeExecutionMode()
    const reversal = await stripeClient().transfers.createReversal(
      input.providerTransferId,
      { metadata: { disbursement_id: input.disbursementId, arc_product: "vendor_payments" } },
      { idempotencyKey: input.idempotencyKey },
    )
    return { providerReversalId: reversal.id }
  },

  async findVendorTransfer(input) {
    // A run can contain more than one Stripe page of vendors. Walk the whole
    // transfer group: missing an older transfer on reclaim would turn the
    // adoption safety check into a second payment.
    for await (const transfer of stripeClient().transfers.list({ transfer_group: input.transferGroup, limit: 100 })) {
      if (transfer.metadata.disbursement_id === input.disbursementId) {
        return { provider: "stripe", providerTransferId: transfer.id }
      }
    }
    return null
  },

  async retrievePlatformPayoutSettings() {
    const account = await stripeClient().accounts.retrieve()
    if (account.deleted) throw new Error("Stripe platform account was deleted")
    return { interval: account.settings?.payouts?.schedule?.interval ?? "unknown" }
  },

  async resolveDisbursementReference(input) {
    const intent = await stripeClient().paymentIntents.retrieve(input.providerPaymentId)
    return {
      disbursementId: intent.metadata.disbursement_id || null,
      orgId: intent.metadata.org_id || null,
      arcProduct: intent.metadata.arc_product || null,
    }
  },

  async resolvePaymentChargeId(input) {
    const intent = await stripeClient().paymentIntents.retrieve(input.providerPaymentId)
    return typeof intent.latest_charge === "string" ? intent.latest_charge : intent.latest_charge?.id ?? null
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
    const fundingCustomerIds = new Set(input.fundingProviderCustomerIds)
    const recipientAccountIds = [...new Set(input.recipientProviderAccountIds)]
    const recipientAccountIdSet = new Set(recipientAccountIds)

    let paymentCursor: string | undefined
    do {
      const page = await stripeClient().paymentIntents.list({ created, limit: 100, ...(paymentCursor ? { starting_after: paymentCursor } : {}) })
      for (const intent of page.data) {
        const customerId = typeof intent.customer === "string" ? intent.customer : intent.customer?.id ?? null
        // Discovery is the customer, which Stripe owns; the marker below only
        // decides which bucket a discovered movement lands in. An intent drawn
        // on this builder's bank that Arc never tagged is precisely the debit
        // this control exists to surface, so it stays in. Metadata naming this
        // org is an additional way IN, never a way out — a funding source
        // removed after the debit must not make the debit disappear.
        const claimedByOrg = intent.metadata.org_id === input.orgId
        if (!claimedByOrg && (!customerId || !fundingCustomerIds.has(customerId))) continue
        // Another tenant's money on the same platform account is that tenant's
        // exception, not this one's.
        if (intent.metadata.org_id && !claimedByOrg) continue
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
        const destination = typeof transfer.destination === "string" ? transfer.destination : transfer.destination?.id ?? null
        // The destination account is Stripe's record of where the money went. A
        // transfer into a vendor this builder pays, created by something other
        // than Arc, has to be visible. As above, metadata naming this org only
        // ever widens the net — a vendor relationship ended after the transfer
        // must not erase the transfer.
        const claimedByOrg = transfer.metadata.org_id === input.orgId
        if (!claimedByOrg && (!destination || !recipientAccountIdSet.has(destination))) continue
        // A vendor entity is global, so the same connected account receives
        // transfers from several builders. Metadata is how a tagged transfer is
        // handed to its owner instead of being everyone's exception.
        if (transfer.metadata.org_id && !claimedByOrg) continue
        const source = typeof transfer.source_transaction === "string" ? transfer.source_transaction : transfer.source_transaction?.id
        activity.push({
          kind: "transfer",
          providerReference: transfer.id,
          providerAccountId: destination,
          amountCents: transfer.amount,
          status: transfer.reversed ? "returned" : "settled",
          linkedReferences: source ? [source] : [],
          metadata: stripeMetadata(transfer.metadata),
        })
      }
      transferCursor = page.has_more ? page.data.at(-1)?.id : undefined
    } while (transferCursor)

    for (const providerAccountId of recipientAccountIds) {
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
          // A payout with no resolvable source transfer used to be dropped here,
          // which meant money leaving a vendor account Arc pays into, funded by
          // something Arc never sent, produced no record at all.
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

      activity.push(...await listRecipientFeeAdjustments(providerAccountId, created))
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
      // Default: shape-compatible with AP, but only an Arc-side lookup settles
      // it. Branches that read Arc's own marker off the object upgrade this.
      attribution: "requires_lookup" as const,
      payload: JSON.parse(JSON.stringify(event)) as Record<string, unknown>,
    }
    const tagged = { ...base, attribution: "provider_tagged" as const }
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
          ...tagged,
          kind: "fee_charge.status",
          providerPaymentId: intent.id,
          status: status === "funds_available" ? "succeeded" : status,
        }
      }
      return {
        ...tagged,
        kind: "disbursement.status",
        providerPaymentId: intent.id,
        disbursementId: intent.metadata.disbursement_id || null,
        status,
        providerTransferId: null,
      }
    }
    if (event.type === "transfer.created") {
      const transfer = event.data.object as Stripe.Transfer
      if (transfer.metadata.arc_product !== "vendor_payments") return null
      const paymentId = await stripeApProvider.resolveTransferPaymentId({ providerTransferId: transfer.id })
      if (!paymentId) return null
      return {
        ...tagged,
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
      return { ...base, kind: "disbursement.paid", providerPayoutId: payout.id }
    }
    if (event.type === "payout.failed" || event.type === "payout.canceled") {
      if (!base.providerAccountId) return null
      const payout = event.data.object as Stripe.Payout
      return {
        ...base,
        kind: "disbursement.payout_attention",
        providerPayoutId: payout.id,
        status: event.type === "payout.failed" ? "failed" : "canceled",
        reason: payout.failure_message ?? payout.failure_code ?? `Stripe payout ${event.type === "payout.failed" ? "failed" : "was canceled"}`,
      }
    }
    if (["charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed"].includes(event.type)) {
      const dispute = event.data.object as Stripe.Dispute
      const paymentId = typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id
      if (!paymentId) return null
      // One Stripe event, two unrelated meanings: on the AP rail a dispute is an
      // ACH debit coming back off the builder's bank; on the receivables rail it
      // is a card chargeback against an invoice payment. Which one it is used to
      // be decided only by whether the disbursement lookup happened to miss.
      // Stripe names the instrument, so say it out loud: a card dispute is never
      // an ACH return and this adapter declines it outright.
      const disputeMethod: { type?: string } | undefined = dispute.payment_method_details
      if (disputeMethod?.type === "card") return null
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
      // Stripe copies a PaymentIntent's metadata onto the charge it creates, so
      // the same marker the `payment_intent.*` branch uses is available here —
      // and without it every receivables charge paid for a second retrieval of a
      // charge this adapter was always going to hand back to the AR handler.
      if (eventCharge.metadata.arc_product !== "vendor_payments") return null
      const paymentId = typeof eventCharge.payment_intent === "string" ? eventCharge.payment_intent : eventCharge.payment_intent?.id
      if (!paymentId) return null
      const charge = await stripeClient().charges.retrieve(eventCharge.id, {
        expand: ["balance_transaction"],
      }, base.providerAccountId ? { stripeAccount: base.providerAccountId } : undefined)
      const balance = charge.balance_transaction && typeof charge.balance_transaction !== "string" ? charge.balance_transaction : null
      return {
        ...tagged,
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
