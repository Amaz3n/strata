import "server-only"

import type { PaymentRailProvider } from "@/lib/integrations/payments/payment-rail-provider"
import { stripeApProvider } from "@/lib/integrations/payments/stripe-ap"

const providers: Record<string, PaymentRailProvider> = { stripe: stripeApProvider }

export function getPaymentRailProvider(key = "stripe") {
  const provider = providers[key]
  if (!provider) throw new Error(`Unsupported payment rail provider: ${key}`)
  return provider
}

