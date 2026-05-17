import { notFound } from "next/navigation"

import { headers } from "next/headers"

import { getInvoiceByToken, recordInvoiceViewed } from "@/lib/services/invoices"
import { calculatePaymentFeeQuotes, loadPaymentFeePolicy } from "@/lib/payments/fees"
import { listReceiptsForInvoice } from "@/lib/services/receipts"
import { InvoicePublicWithPay } from "@/components/invoices/invoice-public-with-pay"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

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
        publishableKey: string
        token: string
        feeQuotes: ReturnType<typeof calculatePaymentFeeQuotes>
      }
    | null = null

  if (publishableKey) {
    try {
      const policy = await loadPaymentFeePolicy(createServiceSupabaseClient(), invoice.org_id)
      const balanceDue = invoice.totals?.balance_due_cents ?? invoice.balance_due_cents ?? invoice.total_cents ?? 0
      paymentProps = {
        publishableKey,
        token,
        feeQuotes: calculatePaymentFeeQuotes(balanceDue, policy),
      }
    } catch (err) {
      // Gracefully degrade: show read-only invoice if payments not configured or no balance.
      console.error("Payment options not created for public invoice:", err)
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
