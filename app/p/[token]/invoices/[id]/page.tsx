import { notFound } from "next/navigation"

import { validatePortalToken } from "@/lib/services/portal-access"
import { getInvoiceForPortal } from "@/lib/services/invoices"
import { listReceiptsForInvoice } from "@/lib/services/receipts"
import { listOpenBookCostDetailsForInvoice } from "@/lib/services/cost-plus"
import { listSharedInvoiceBackupPackagesForPortal } from "@/lib/services/owner-billing-packages"
import { calculatePaymentFeeQuotes, loadPaymentFeePolicy } from "@/lib/payments/fees"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
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
        publishableKey: string
        portalToken: string
        feeQuotes: ReturnType<typeof calculatePaymentFeeQuotes>
      }
    | null = null

  if (publishableKey && access.permissions.can_pay_invoices) {
    try {
      const balanceDue = invoice.totals?.balance_due_cents ?? invoice.balance_due_cents ?? invoice.total_cents ?? 0
      if (balanceDue > 0 && invoice.token) {
        const policy = await loadPaymentFeePolicy(createServiceSupabaseClient(), access.org_id)
        paymentProps = {
          publishableKey,
          portalToken: token,
          feeQuotes: calculatePaymentFeeQuotes(balanceDue, policy),
        }
      }
    } catch (err) {
      // Gracefully degrade: show the invoice and offline payment instructions if payment settings cannot load.
      console.warn("Payment options not created for portal invoice:", err)
    }
  }

  const [receiptsResult, costDetailsResult, backupPackagesResult] = await Promise.allSettled([
    listReceiptsForInvoice({ orgId: access.org_id, invoiceId: invoice.id }),
    listOpenBookCostDetailsForInvoice({
      invoiceId: invoice.id,
      orgId: access.org_id,
      projectId: access.project_id,
    }),
    listSharedInvoiceBackupPackagesForPortal({
      orgId: access.org_id,
      projectId: access.project_id,
      invoiceId: invoice.id,
    }),
  ])

  const proofErrors = [
    receiptsResult.status === "rejected" ? `Receipts: ${receiptsResult.reason?.message ?? String(receiptsResult.reason)}` : null,
    costDetailsResult.status === "rejected" ? `Cost detail: ${costDetailsResult.reason?.message ?? String(costDetailsResult.reason)}` : null,
    backupPackagesResult.status === "rejected" ? `Backup package: ${backupPackagesResult.reason?.message ?? String(backupPackagesResult.reason)}` : null,
  ].filter(Boolean) as string[]

  return (
    <InvoicePortalClient
      token={token}
      invoice={invoice}
      portalType="client"
      payment={paymentProps}
      receipts={receiptsResult.status === "fulfilled" ? receiptsResult.value : []}
      costDetails={costDetailsResult.status === "fulfilled" ? costDetailsResult.value : []}
      backupPackages={backupPackagesResult.status === "fulfilled" ? backupPackagesResult.value : []}
      proofErrors={proofErrors}
    />
  )
}
