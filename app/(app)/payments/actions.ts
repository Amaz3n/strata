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

import { actionError, type ActionResult } from "@/lib/action-result"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}


export async function generatePayLinkAction(input: unknown) {
  return run(async () => {
    const parsed = generatePayLinkInputSchema.parse(input)
    const result = await generatePayLink(parsed)
    revalidatePath("/invoices")
    return result
  })
}

export async function createPaymentIntentAction(input: unknown) {
  return run(async () => {
    const parsed = createPaymentIntentInputSchema.parse(input)
    const intent = await createPaymentIntent(parsed)
    return intent
  })
}

export async function recordPaymentAction(input: unknown) {
  return run(async () => {
    const parsed = recordPaymentInputSchema.parse(input)
    const payment = await recordPayment(parsed)
    if (parsed.invoice_id) {
      revalidatePath(`/invoices/${parsed.invoice_id}`)
      revalidatePath("/invoices")
    }
    return payment
  })
}

export async function listPaymentsForInvoiceAction(invoiceId: string) {
  return await listPaymentsForInvoice(invoiceId)
}
