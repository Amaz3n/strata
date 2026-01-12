import { notFound } from "next/navigation"

import { validatePortalToken } from "@/lib/services/portal-access"
import { getInvoiceForPortal } from "@/lib/services/invoices"
import { createPaymentIntent } from "@/lib/services/payments"
import { listReceiptsForInvoice } from "@/lib/services/receipts"
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
  if (!invoice) {
    notFound()
  }

  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY

  let paymentProps:
    | {
        clientSecret: string
        publishableKey: string
        token: string
      }
    | null = null

  if (publishableKey) {
    try {
      const intent = await createPaymentIntent(
        {
          invoice_id: invoice.id,
        },
        access.org_id,
      )

      if (intent?.client_secret) {
        paymentProps = {
          clientSecret: intent.client_secret,
          publishableKey,
          token,
        }
      }
    } catch (err) {
      // If invoice is already paid or payments are not configured (missing Stripe key), skip the payment panel.
      console.warn("Payment intent not created for portal invoice:", err)
    }
  }

  const receipts = await listReceiptsForInvoice({ orgId: access.org_id, invoiceId: invoice.id })

  return <InvoicePortalClient invoice={invoice} portalType="client" payment={paymentProps} receipts={receipts} />
}

