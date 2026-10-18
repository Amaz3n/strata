"use server"

import { revalidatePath } from "next/cache"

import { recordCustomerRefund } from "@/lib/services/customer-refunds"
import { recordMultiInvoicePayment, recordPayment } from "@/lib/services/payments"
import { receivePaymentInputSchema, recordPaymentInputSchema } from "@/lib/validation/payments"
import { PROJECT_BILLING_SEGMENT } from "@/lib/financials/invoice-destinations"

import { actionError, type ActionResult } from "@/lib/action-result"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}


export async function recordPaymentAction(input: unknown) {
  return run(async () => {
    const parsed = recordPaymentInputSchema.parse(input)
    const payment = await recordPayment(parsed)
    revalidatePath("/invoices")
    revalidatePath("/billing")
    revalidatePath("/directory", "layout")
    if (payment.project_id) revalidatePath(`/projects/${payment.project_id}/${PROJECT_BILLING_SEGMENT}`)
    return payment
  })
}

export async function recordMultiInvoicePaymentAction(input: unknown) {
  return run(async () => {
    const parsed = receivePaymentInputSchema.parse(input)
    const result = await recordMultiInvoicePayment(parsed)
    revalidatePath("/billing")
    revalidatePath("/billing/receive-payment")
    revalidatePath("/invoices")
    revalidatePath("/directory", "layout")
    return result
  })
}

export async function recordCustomerRefundAction(input: unknown) {
  return run(async () => {
    const result = await recordCustomerRefund(input)
    revalidatePath("/billing", "layout")
    revalidatePath("/directory", "layout")
    revalidatePath("/books", "layout")
    if (result.projectId) revalidatePath(`/projects/${result.projectId}/${PROJECT_BILLING_SEGMENT}`)
    return result
  })
}
