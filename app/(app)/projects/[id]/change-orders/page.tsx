import { Suspense } from "react"
import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction } from "../actions"
import { listChangeOrdersAction } from "@/app/(app)/change-orders/actions"
import { ChangeOrdersClient } from "@/components/change-orders/change-orders-client"
import { listCostCodes } from "@/lib/services/cost-codes"
import { Skeleton } from "@/components/ui/skeleton"

interface ProjectChangeOrdersPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectChangeOrdersPage({ params }: ProjectChangeOrdersPageProps) {
  const { id } = await params

  return (
    <>
      <PageLayout title="Change Orders" breadcrumbs={[
        { label: "Project" },
        { label: "Change Orders" },
      ]} />
      <Suspense fallback={
        <div className="p-6 space-y-4">
          <Skeleton className="h-8 w-48 mb-6" />
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-md" />
            ))}
          </div>
        </div>
      }>
        <ProjectChangeOrdersData id={id} />
      </Suspense>
    </>
  )
}

async function ProjectChangeOrdersData({ id }: { id: string }) {
  const project = await getProjectAction(id)

  if (!project) {
    notFound()
  }

  const [changeOrders, costCodes] = await Promise.all([
    listChangeOrdersAction(id),
    listCostCodes().catch(() => []),
  ])

  return (
    <div className="space-y-6">
      <ChangeOrdersClient
        changeOrders={changeOrders}
        projects={[project]}
        costCodes={costCodes}
        hideProjectFilter
      />
    </div>
  )
}
