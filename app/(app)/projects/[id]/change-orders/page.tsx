import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction } from "../actions"
import { listChangeOrdersAction } from "@/app/(app)/change-orders/actions"
import { ChangeOrdersClient } from "@/components/change-orders/change-orders-client"
import { listCostCodes } from "@/lib/services/cost-codes"

// export const dynamic = "force-dynamic" // Removed for better caching performance

interface ProjectChangeOrdersPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectChangeOrdersPage({ params }: ProjectChangeOrdersPageProps) {
  const { id } = await params

  const [project, changeOrders] = await Promise.all([
    getProjectAction(id),
    listChangeOrdersAction(id),
  ])
  const costCodes = await listCostCodes().catch(() => [])

  if (!project) {
    notFound()
  }

  return (
    <PageLayout title="Page">
      <div className="space-y-6">
        <ChangeOrdersClient changeOrders={changeOrders} projects={[project]} costCodes={costCodes} />
      </div>
    </PageLayout>
  )
}
