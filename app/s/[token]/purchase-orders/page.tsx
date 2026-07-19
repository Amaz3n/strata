import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft } from "lucide-react"

import { PortalHeader } from "@/components/portal/portal-header"
import { Button } from "@/components/ui/button"
import { listPortalPurchaseOrders } from "@/lib/services/po-completions"
import { assertPortalActionAccess, loadSubPortalData } from "@/lib/services/portal-access"
import { PurchaseOrdersClient } from "./purchase-orders-client"

export const revalidate = 0

export default async function PortalPurchaseOrdersPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  let access
  try {
    access = await assertPortalActionAccess(token, { portalType: "sub", requireCompany: true, permission: "can_view_purchase_orders" })
  } catch { notFound() }
  const [orders, data] = await Promise.all([
    listPortalPurchaseOrders(access),
    loadSubPortalData({ orgId: access.org_id, projectId: access.project_id, companyId: access.company_id!, permissions: access.permissions }),
  ])
  return <div className="min-h-screen bg-background"><PortalHeader orgName={data.org.name} project={data.project} /><main className="mx-auto w-full max-w-2xl space-y-4 px-4 py-6"><Button variant="ghost" size="sm" asChild className="-ml-2"><Link href={`/s/${token}`}><ArrowLeft /> Back to dashboard</Link></Button><div><h1 className="text-xl font-semibold">Purchase orders</h1><p className="mt-1 text-sm text-muted-foreground">Review awarded work and report completed scope.</p></div><PurchaseOrdersClient token={token} orders={orders as never} canReport={access.permissions.can_report_po_completion === true} /></main></div>
}
