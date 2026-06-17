"use server"

import { z } from "zod"

import { getInvoiceForPortal } from "@/lib/services/invoices"
import { createPublicInvoicePaymentIntent } from "@/lib/services/payments"
import { validatePortalToken } from "@/lib/services/portal-access"

const createPortalInvoicePaymentIntentInputSchema = z.object({
  portalToken: z.string().min(1, "Portal link is required"),
  invoiceId: z.string().uuid("Invoice is required"),
  method: z.enum(["ach", "card"]),
})

export async function getInvoiceForPortalAction(token: string, invoiceId: string) {
  const access = await validatePortalToken(token)
  if (!access || !access.permissions.can_view_invoices) {
    throw new Error("Not authorized")
  }

  const invoice = await getInvoiceForPortal(invoiceId, access.org_id, access.project_id)
  if (!invoice || !invoice.client_visible) {
    throw new Error("Invoice not available")
  }

  return invoice
}

export async function createPortalInvoicePaymentIntentAction(input: unknown) {
  const parsed = createPortalInvoicePaymentIntentInputSchema.parse(input)
  const access = await validatePortalToken(parsed.portalToken)
  if (!access || !access.permissions.can_view_invoices || !access.permissions.can_pay_invoices) {
    throw new Error("This portal link is not allowed to pay invoices.")
  }

  const invoice = await getInvoiceForPortal(parsed.invoiceId, access.org_id, access.project_id)
  if (!invoice || !invoice.client_visible || !invoice.token) {
    throw new Error("Invoice is not available for online payment.")
  }

  return createPublicInvoicePaymentIntent({
    token: invoice.token,
    method: parsed.method,
  })
}







