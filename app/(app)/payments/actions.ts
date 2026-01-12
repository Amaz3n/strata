"use server"

import { revalidatePath } from "next/cache"

import {
  createPaymentIntent,
  generatePayLink,
  listPaymentsForInvoice,
  recordPayment,
} from "@/lib/services/payments"
import {
  createPaymentIntentInputSchema,
  generatePayLinkInputSchema,
  recordPaymentInputSchema,
} from "@/lib/validation/payments"

export async function generatePayLinkAction(input: unknown) {
  const parsed = generatePayLinkInputSchema.parse(input)
  const result = await generatePayLink(parsed)
  revalidatePath("/invoices")
  return result
}

export async function createPaymentIntentAction(input: unknown) {
  const parsed = createPaymentIntentInputSchema.parse(input)
  const intent = await createPaymentIntent(parsed)
  return intent
}

export async function recordPaymentAction(input: unknown) {
  const parsed = recordPaymentInputSchema.parse(input)
  const payment = await recordPayment(parsed)
  if (parsed.invoice_id) {
    revalidatePath(`/invoices/${parsed.invoice_id}`)
  }
  return payment
}

export async function listPaymentsForInvoiceAction(invoiceId: string) {
  return listPaymentsForInvoice(invoiceId)
}




