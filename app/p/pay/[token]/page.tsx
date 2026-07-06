import { notFound } from "next/navigation"

import { PayLinkClient } from "@/components/payments/pay-link-client"
import { getInvoiceForPayLink } from "@/lib/services/payments"

interface Params {
  params: Promise<{ token: string }>
}

export const revalidate = 0
export const metadata = {
  robots: {
    index: false,
    follow: false,
  },
}

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

  return (
    <PayLinkClient
      token={token}
      invoice={result.invoice}
      publishableKey={publishableKey}
    />
  )
}

