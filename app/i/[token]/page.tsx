import { notFound } from "next/navigation"

import { headers } from "next/headers"

import { getInvoiceByToken, recordInvoiceViewed } from "@/lib/services/invoices"
import { calculatePaymentFeeQuotes, loadPaymentFeePolicy } from "@/lib/payments/fees"
import { listReceiptsForInvoice } from "@/lib/services/receipts"
import { listPublicInvoiceLienWaivers } from "@/lib/services/invoice-lien-waivers"
import { InvoicePublicWithPay } from "@/components/invoices/invoice-public-with-pay"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

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
  }

  const receipts = await listReceiptsForInvoice({ orgId: invoice.org_id, invoiceId: invoice.id })
  const lienWaivers = await listPublicInvoiceLienWaivers({ orgId: invoice.org_id, invoiceId: invoice.id })

  // Load org branding + project name so the on-page preview matches the downloaded PDF.
  const brandingClient = createServiceSupabaseClient()
  const [orgResult, projectResult] = await Promise.all([
    brandingClient.from("orgs").select("name, billing_email, address, logo_url").eq("id", invoice.org_id).maybeSingle(),
    invoice.project_id
      ? brandingClient.from("projects").select("name").eq("org_id", invoice.org_id).eq("id", invoice.project_id).maybeSingle()
      : Promise.resolve({ data: null as { name?: string | null } | null }),
  ])

  const branding = {
    name: orgResult.data?.name ?? null,
    email: orgResult.data?.billing_email ?? null,
    address: orgResult.data?.address ?? null,
    logoUrl: orgResult.data?.logo_url ?? null,
    projectName: projectResult.data?.name ?? null,
  }

  return (
    <InvoicePublicWithPay
      invoice={invoice}
      payment={paymentProps}
      receipts={receipts}
      branding={branding}
      lienWaivers={lienWaivers}
    />
  )
}
