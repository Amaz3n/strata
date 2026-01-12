import { notFound } from "next/navigation"

import { PayLinkClient } from "@/components/payments/pay-link-client"
import { createPaymentIntent, getInvoiceForPayLink } from "@/lib/services/payments"

interface Params {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function PayLinkPage({ params }: Params) {
  const { token } = await params
  const result = await getInvoiceForPayLink(token)
  if (!result || !result.invoice) {
    notFound()
  }

  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
  if (!publishableKey) {
    throw new Error("Stripe publishable key is not configured")
  }

  const intent = await createPaymentIntent(
    {
      invoice_id: result.invoice.id,
    },
    result.invoice.org_id,
  )

  return <PayLinkClient token={token} invoice={result.invoice} publishableKey={publishableKey} clientSecret={intent.client_secret ?? ""} />
}






