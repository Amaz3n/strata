import { AppShell } from "@/components/layout/app-shell"
export const dynamic = 'force-dynamic'
import { ChangeOrdersClient } from "@/components/change-orders/change-orders-client"
import { listChangeOrdersAction } from "./actions"
import { listProjectsAction } from "../projects/actions"
import { getCurrentUserAction } from "../actions/user"

export default async function ChangeOrdersPage() {
  const [changeOrders, projects, currentUser] = await Promise.all([
    listChangeOrdersAction(),
    listProjectsAction(),
    getCurrentUserAction(),
  ])

  return (
    <AppShell title="Change Orders" user={currentUser}>
      <div className="p-4 lg:p-6">
        <ChangeOrdersClient changeOrders={changeOrders} projects={projects} />
      </div>
    </AppShell>
  )
}

