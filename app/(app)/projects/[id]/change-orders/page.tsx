import { Suspense } from "react"
import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction } from "../actions"
import { listChangeOrdersAction } from "@/app/(app)/change-orders/actions"
import { ChangeOrdersClient } from "@/components/change-orders/change-orders-client"
import { Skeleton } from "@/components/ui/skeleton"
import { getOrgBilling } from "@/lib/services/orgs"
import type { Address } from "@/lib/types"

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

  const changeOrders = await listChangeOrdersAction(id)
  const orgBilling = await getOrgBilling().catch(() => null)

  return (
    <div className="space-y-6">
      <ChangeOrdersClient
        changeOrders={changeOrders}
        projects={[project]}
        hideProjectFilter
        builderInfo={{
          name: orgBilling?.org?.name,
          email: orgBilling?.org?.billing_email,
          address: formatAddress(orgBilling?.org?.address as Address | undefined),
        }}
      />
    </div>
  )
}

function formatAddress(address?: Address) {
  if (!address) return undefined
  const structured = [
    [address.street1, address.street2].filter(Boolean).join(" ").trim(),
    [address.city, address.state, address.postal_code].filter(Boolean).join(" ").trim(),
    (address.country ?? "").trim(),
  ].filter(Boolean)

  if (structured.length > 0) return structured.join("\n")
  return address.formatted?.trim() || undefined
}
