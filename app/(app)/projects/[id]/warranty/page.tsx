import { Suspense } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction } from "../actions"
import { listWarrantyRequestsAction } from "@/app/(app)/warranty/actions"
import { listCompaniesAction } from "@/app/(app)/companies/actions"
import { WarrantyClient } from "@/components/warranty/warranty-client"

import { unwrapAction } from "@/lib/action-result"

interface ProjectWarrantyPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectWarrantyPage({ params }: ProjectWarrantyPageProps) {
  const { id } = await params

  return (
    <>
      <PageLayout
        title="Warranty"
        breadcrumbs={[
          { label: "Project" },
          { label: "Warranty" },
        ]}
      />
      <Suspense fallback={<ProjectWarrantyFallback />}>
        <ProjectWarrantyData id={id} />
      </Suspense>
    </>
  )
}

function ProjectWarrantyFallback() {
  return (
    <div className="p-6 space-y-4">
      <Skeleton className="h-8 w-48 mb-6" />
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-md" />
        ))}
      </div>
    </div>
  )
}

async function ProjectWarrantyData({ id }: { id: string }) {
  const project = await getProjectAction(id)

  if (!project) notFound()

  const [requests, companies] = await Promise.all([listWarrantyRequestsAction(id), listCompaniesAction()])

  return <WarrantyClient projectId={project.id} requests={requests} companies={companies} />
}
