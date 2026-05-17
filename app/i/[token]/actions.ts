"use server"

import { createPublicInvoicePaymentIntent } from "@/lib/services/payments"
import { createPublicInvoicePaymentIntentInputSchema } from "@/lib/validation/payments"

export async function createPublicInvoicePaymentIntentAction(input: unknown) {
  const parsed = createPublicInvoicePaymentIntentInputSchema.parse(input)
  return createPublicInvoicePaymentIntent(parsed)
}
