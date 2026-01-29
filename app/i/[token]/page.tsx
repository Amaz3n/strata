import { notFound } from "next/navigation"

import { headers } from "next/headers"

import { getInvoiceByToken, recordInvoiceViewed } from "@/lib/services/invoices"
import { createPaymentIntent } from "@/lib/services/payments"
import { listReceiptsForInvoice } from "@/lib/services/receipts"
import { InvoicePublicWithPay } from "@/components/invoices/invoice-public-with-pay"

interface Params {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function InvoicePublicPage({ params }: Params) {
  const { token } = await params
  const invoice = await getInvoiceByToken(token)

  if (!invoice) {
    notFound()
  }

  // Record view for auditing/insight; non-blocking if it fails
  const h = await headers()
  const getHeader = (name: string) => h.get(name)

  const userAgent = getHeader("user-agent")
  const ip =
    getHeader("x-forwarded-for")?.split(",")?.[0]?.trim() ||
    getHeader("x-real-ip") ||
    getHeader("cf-connecting-ip") ||
    null

  await recordInvoiceViewed({
    invoiceId: invoice.id,
    orgId: invoice.org_id,
    token,
    userAgent,
    ipAddress: ip,
  })

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
      console.log("Creating payment intent for invoice:", {
        invoiceId: invoice.id,
        balanceDue: invoice.totals?.balance_due_cents ?? invoice.balance_due_cents,
        status: invoice.status,
        total: invoice.totals?.total_cents ?? invoice.total_cents,
      })

      const intent = await createPaymentIntent(
        {
          invoice_id: invoice.id,
          currency: invoice.currency,
        },
        invoice.org_id,
      )

      if (intent?.client_secret) {
        paymentProps = {
          clientSecret: intent.client_secret,
          publishableKey,
          token,
        }
        console.log("Payment intent created successfully")
      } else {
        console.log("Payment intent created but no client_secret")
      }
    } catch (err) {
      // Gracefully degrade: show read-only invoice if payments not configured or no balance.
      console.error("Payment intent not created for public invoice:", err)
      console.error("Error details:", {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      })
    }
  } else {
    console.log("No publishable key found")
  }

  const receipts = await listReceiptsForInvoice({ orgId: invoice.org_id, invoiceId: invoice.id })

  return <InvoicePublicWithPay invoice={invoice} payment={paymentProps} receipts={receipts} />
}
