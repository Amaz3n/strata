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
import { AuthorizationError } from "@/lib/services/authorization"

function rethrowTypedAuthError(error: unknown): never {
  if (error instanceof AuthorizationError) {
    throw new Error(`AUTH_FORBIDDEN:${error.reasonCode}`)
  }
  throw error
}

export async function generatePayLinkAction(input: unknown) {
  try {
    const parsed = generatePayLinkInputSchema.parse(input)
    const result = await generatePayLink(parsed)
    revalidatePath("/invoices")
    return result
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function createPaymentIntentAction(input: unknown) {
  try {
    const parsed = createPaymentIntentInputSchema.parse(input)
    const intent = await createPaymentIntent(parsed)
    return intent
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function recordPaymentAction(input: unknown) {
  try {
    const parsed = recordPaymentInputSchema.parse(input)
    const payment = await recordPayment(parsed)
    if (parsed.invoice_id) {
      revalidatePath(`/invoices/${parsed.invoice_id}`)
    }
    return payment
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}

export async function listPaymentsForInvoiceAction(invoiceId: string) {
  try {
    return await listPaymentsForInvoice(invoiceId)
  } catch (error) {
    rethrowTypedAuthError(error)
  }
}
