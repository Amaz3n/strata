"use server"

import { revalidatePath } from "next/cache"

import {
  createPaymentIntent,
  generatePayLink,
  getReceivePaymentWorkspace,
  listPaymentsForInvoice,
  recordMultiInvoicePayment,
  recordPayment,
} from "@/lib/services/payments"
import {
  createPaymentIntentInputSchema,
  generatePayLinkInputSchema,
  receivePaymentInputSchema,
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

export async function loadReceivePaymentWorkspaceAction(input?: {
  partyType?: "contact" | "company"
  partyId?: string
}) {
  return run(() => getReceivePaymentWorkspace(input))
}

export async function recordMultiInvoicePaymentAction(input: unknown) {
  return run(async () => {
    const parsed = receivePaymentInputSchema.parse(input)
    const result = await recordMultiInvoicePayment(parsed)
    revalidatePath("/billing")
    revalidatePath("/billing/receive-payment")
    revalidatePath("/invoices")
    for (const allocation of parsed.allocations) {
      revalidatePath(`/invoices/${allocation.invoice_id}`)
    }
    return result
  })
}
