"use server"

import { getInvoiceForPortal } from "@/lib/services/invoices"
import { validatePortalToken } from "@/lib/services/portal-access"

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








