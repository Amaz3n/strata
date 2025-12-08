import { notFound } from "next/navigation"

import { headers } from "next/headers"

import { getInvoiceByToken, recordInvoiceViewed } from "@/lib/services/invoices"
import { createPaymentIntent } from "@/lib/services/payments"
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
  const h = headers()
  const getHeader = (name: string) => (typeof h.get === "function" ? h.get(name) : null)

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
      const intent = await createPaymentIntent(
        {
          invoice_id: invoice.id,
        },
        invoice.org_id,
      )

      if (intent?.client_secret) {
        paymentProps = {
          clientSecret: intent.client_secret,
          publishableKey,
          token,
        }
      }
    } catch (err) {
      // Gracefully degrade: show read-only invoice if payments not configured or no balance.
      console.warn("Payment intent not created for public invoice:", err)
    }
  }

  return <InvoicePublicWithPay invoice={invoice} payment={paymentProps} />
}
