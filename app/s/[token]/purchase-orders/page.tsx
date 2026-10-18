import { connection } from "next/server"
import { notFound } from "next/navigation"

import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { listPortalPurchaseOrders } from "@/lib/services/portal-purchase-orders"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { PurchaseOrdersClient } from "./purchase-orders-client"


export default async function PortalPurchaseOrdersPage({ params }: { params: Promise<{ token: string }> }) {
  await connection()
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

  const { orders, total, canReportCompletion } = await listPortalPurchaseOrders(access)

  return (
    <>
      <PortalPageHeader
        title="Purchase orders"
        description="Purchase orders issued to you. Accept or dispute each version, and report the scope you have completed."
      />
      <PurchaseOrdersClient
        token={token}
        orders={orders}
        total={total}
        canReport={canReportCompletion}
        canAcknowledge={access.permissions.can_acknowledge_purchase_orders === true}
        showProject={access.project_id === null}
      />
    </>
  )
}
