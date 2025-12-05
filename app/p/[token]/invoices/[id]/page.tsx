import { notFound } from "next/navigation"

import { validatePortalToken } from "@/lib/services/portal-access"
import { getInvoiceForPortal } from "@/lib/services/invoices"
import { InvoicePortalClient } from "./portal-invoice-client"

interface Params {
  params: Promise<{ token: string; id: string }>
}

export const revalidate = 0

export default async function InvoicePortalPage({ params }: Params) {
  const { token, id } = await params
  const access = await validatePortalToken(token)
  if (!access || !access.permissions.can_view_invoices) {
    notFound()
  }

  const invoice = await getInvoiceForPortal(id, access.org_id, access.project_id)
  if (!invoice || !invoice.client_visible) {
    notFound()
  }

  return <InvoicePortalClient invoice={invoice} portalType="client" />
}
