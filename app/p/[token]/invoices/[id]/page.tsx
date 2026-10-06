import { connection } from "next/server"
import { InvoiceWaiverLinks } from "@/components/portal/invoice-waiver-links"
import { notFound, unstable_rethrow } from "next/navigation"

import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { getInvoiceForPortal } from "@/lib/services/invoices"
import { listReceiptsForInvoice } from "@/lib/services/receipts"
import { listOpenBookCostDetailsForInvoice } from "@/lib/services/cost-plus"
import { listSharedInvoiceBackupPackagesForPortal } from "@/lib/services/owner-billing-packages"
import { calculatePaymentFeeQuotes, loadPaymentFeePolicy, restrictPaymentFeePolicyToInvoice } from "@/lib/payments/fee-engine"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { InvoicePortalClient } from "./portal-invoice-client"

interface Params {
  params: Promise<{ token: string; id: string }>
}


export default async function InvoicePortalPage({ params }: Params) {
  await connection()
  const { token, id } = await params
  let access: Awaited<ReturnType<typeof assertPortalActionAccess>>
  try {
    access = await assertPortalActionAccess(token, {
      portalType: "client",
      requireProject: true,
      permission: "can_view_invoices",
    })
  } catch (error) {
    unstable_rethrow(error)
    notFound()
  }

  const projectId = access.project_id
  if (!projectId) notFound()
  const invoice = await getInvoiceForPortal(id, access.org_id, projectId)
  if (!invoice) {
    notFound()
  }

  const portalInvoice = invoice
  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY

  async function loadPaymentProps() {
    if (!publishableKey || !access.permissions.can_pay_invoices) return null
    const balanceDue = portalInvoice.totals?.balance_due_cents ?? portalInvoice.balance_due_cents ?? portalInvoice.total_cents ?? 0
    if (balanceDue <= 0 || !portalInvoice.token) return null

    try {
      const policy = await loadPaymentFeePolicy(createServiceSupabaseClient(), access.org_id)
      return {
        publishableKey,
        portalToken: token,
        feeQuotes: calculatePaymentFeeQuotes(balanceDue, restrictPaymentFeePolicyToInvoice(policy, portalInvoice.metadata)),
      }
    } catch (err) {
      unstable_rethrow(err)
      // Show the invoice and offline instructions if payment settings cannot load.
      console.warn("Payment options not created for portal invoice:", err)
      return null
    }
  }

  const paymentPromise = loadPaymentProps()
  const proofPromise = Promise.allSettled([
    listReceiptsForInvoice({ orgId: access.org_id, invoiceId: invoice.id }),
    listOpenBookCostDetailsForInvoice({
      invoiceId: invoice.id,
      orgId: access.org_id,
      projectId,
    }),
    listSharedInvoiceBackupPackagesForPortal({
      orgId: access.org_id,
      projectId,
      invoiceId: invoice.id,
    }),
  ])

  const [paymentProps, [receiptsResult, costDetailsResult, backupPackagesResult]] = await Promise.all([
    paymentPromise,
    proofPromise,
  ])

  for (const result of [receiptsResult, costDetailsResult, backupPackagesResult]) {
    if (result.status === "rejected") unstable_rethrow(result.reason)
  }

  const proofErrors = [
    receiptsResult.status === "rejected" ? `Receipts: ${receiptsResult.reason?.message ?? String(receiptsResult.reason)}` : null,
    costDetailsResult.status === "rejected" ? `Cost detail: ${costDetailsResult.reason?.message ?? String(costDetailsResult.reason)}` : null,
    backupPackagesResult.status === "rejected" ? `Backup package: ${backupPackagesResult.reason?.message ?? String(backupPackagesResult.reason)}` : null,
  ].filter(Boolean) as string[]

  return (
    <>
      <InvoiceWaiverLinks orgId={access.org_id} invoiceId={invoice.id} token={token}/>
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
    </>
  )
}
