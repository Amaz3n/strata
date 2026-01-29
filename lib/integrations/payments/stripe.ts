import Stripe from "stripe"

let stripeSingleton: Stripe | null = null

function getStripe() {
  const secret = process.env.STRIPE_SECRET_KEY
  if (!secret) {
    throw new Error("STRIPE_SECRET_KEY is not configured")
  }
  if (!stripeSingleton) {
    stripeSingleton = new Stripe(secret, {
      apiVersion: "2025-02-24.acacia",
    })
  }
  return stripeSingleton
}

export interface CreateStripeIntentParams {
  amount_cents: number
  currency: string
  invoice_id: string
  org_id: string
  project_id?: string | null
  description?: string
  customer_id?: string
  payment_method_types?: string[]
  metadata?: Record<string, string>
}

export interface StripeIntentResult {
  provider_intent_id: string
  client_secret: string
  status: string
}

export async function createStripePaymentIntent(params: CreateStripeIntentParams): Promise<StripeIntentResult> {
  const paymentMethodTypes = params.payment_method_types ?? ["us_bank_account", "card"]

  const intent = await getStripe().paymentIntents.create({
    amount: params.amount_cents,
    currency: params.currency,
    payment_method_types: paymentMethodTypes,
    description: params.description,
    customer: params.customer_id,
    metadata: {
      org_id: params.org_id,
      project_id: params.project_id ?? "",
      invoice_id: params.invoice_id,
      ...params.metadata,
    },
    payment_method_options: {
      us_bank_account: {
        financial_connections: {
          permissions: ["payment_method", "balances"],
        },
        verification_method: "instant",
      },
    },
  })

  return {
    provider_intent_id: intent.id,
    client_secret: intent.client_secret!,
    status: intent.status,
  }
}

export async function retrieveStripePaymentIntent(intentId: string) {
  return getStripe().paymentIntents.retrieve(intentId)
}

export async function createStripeCustomer(params: { email: string; name: string; metadata?: Record<string, string> }) {
  return getStripe().customers.create({
    email: params.email,
    name: params.name,
    metadata: params.metadata,
  })
}

export async function attachPaymentMethod(customerId: string, paymentMethodId: string) {
  return getStripe().paymentMethods.attach(paymentMethodId, { customer: customerId })
}

export function getAppBaseUrl() {
  return process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL || process.env.APP_URL || "https://arcnaples.com"
}

export async function createStripeCheckoutSession(params: {
  customerId: string
  priceId: string
  successUrl: string
  cancelUrl: string
  metadata?: Record<string, string>
  trialEnd?: string | null
}) {
  const trialEndTimestamp =
    params.trialEnd && new Date(params.trialEnd) > new Date()
      ? Math.floor(new Date(params.trialEnd).getTime() / 1000)
      : undefined

  return getStripe().checkout.sessions.create({
    mode: "subscription",
    customer: params.customerId,
    line_items: [{ price: params.priceId, quantity: 1 }],
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    subscription_data: {
      trial_end: trialEndTimestamp,
      metadata: params.metadata,
    },
    metadata: params.metadata,
  })
}

export async function createStripeBillingPortalSession(customerId: string, returnUrl: string) {
  return getStripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  })
}

export function constructWebhookEvent(payload: string, signature: string) {
  return getStripe().webhooks.constructEvent(payload, signature, process.env.STRIPE_WEBHOOK_SECRET!)
}

export function mapStripeEventToDomain(event: Stripe.Event) {
  switch (event.type) {
    case "payment_intent.succeeded": {
      const intent = event.data.object as Stripe.PaymentIntent
      return {
        type: "payment_succeeded" as const,
        provider_payment_id: intent.id,
        amount_cents: intent.amount,
        currency: intent.currency,
    method: mapPaymentMethodType(intent.payment_method_types?.[0] ?? "ach"),
        fee_cents: 0,
        metadata: intent.metadata,
        invoice_id: intent.metadata.invoice_id,
        org_id: intent.metadata.org_id,
      }
    }
    case "payment_intent.payment_failed": {
      const intent = event.data.object as Stripe.PaymentIntent
      return {
        type: "payment_failed" as const,
        provider_payment_id: intent.id,
        error: intent.last_payment_error?.message,
        metadata: intent.metadata,
      }
    }
    case "charge.succeeded": {
      const charge = event.data.object as Stripe.Charge
      return {
        type: "charge_succeeded" as const,
        provider_payment_id: charge.payment_intent as string,
        provider_charge_id: charge.id,
        fee_cents: charge.balance_transaction ? 0 : 0,
        receipt_url: charge.receipt_url ?? undefined,
      }
    }
    default:
      return null
  }
}

function mapPaymentMethodType(stripeType: string): string {
  switch (stripeType) {
    case "us_bank_account":
      return "ach"
    case "card":
      return "card"
    default:
      return stripeType
  }
}

export function calculateFees(amount_cents: number, method: "ach" | "card") {
  if (method === "ach") {
    const stripeFee = Math.min(Math.round(amount_cents * 0.008), 500)
    const platformFee = 50
    return { stripe_fee: stripeFee, platform_fee: platformFee, total_fee: stripeFee + platformFee }
  }

  const stripeFee = Math.round(amount_cents * 0.029) + 30
  const platformFee = Math.round(amount_cents * 0.005)
  return { stripe_fee: stripeFee, platform_fee: platformFee, total_fee: stripeFee + platformFee }
}
