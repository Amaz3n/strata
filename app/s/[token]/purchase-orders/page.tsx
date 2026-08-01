import { notFound } from "next/navigation"

import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { listPortalPurchaseOrders } from "@/lib/services/po-completions"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { PurchaseOrdersClient } from "./purchase-orders-client"

export const revalidate = 0

export default async function PortalPurchaseOrdersPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  let access
  try {
    access = await assertPortalActionAccess(token, {
      portalType: "sub",
      requireCompany: true,
      permission: "can_view_purchase_orders",
    })
  } catch {
    notFound()
  }

  const orders = await listPortalPurchaseOrders(access)

  return (
    <>
      <PortalPageHeader
        title="Purchase orders"
        description="Work the builder has awarded you by purchase order. Report the scope you have completed."
      />
      <PurchaseOrdersClient
        token={token}
        orders={orders as never}
        canReport={access.permissions.can_report_po_completion === true}
      />
    </>
  )
}
