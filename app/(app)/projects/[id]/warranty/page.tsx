import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction } from "../actions"
import { listWarrantyRequestsAction } from "@/app/(app)/warranty/actions"
import { WarrantyClient } from "@/components/warranty/warranty-client"

// export const dynamic = "force-dynamic" // Removed for better caching performance

interface ProjectWarrantyPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectWarrantyPage({ params }: ProjectWarrantyPageProps) {
  const { id } = await params

  const [project, requests] = await Promise.all([
    getProjectAction(id),
    listWarrantyRequestsAction(id),
  ])

  if (!project) notFound()

  return (
    <PageLayout title="Warranty">
      <div className="space-y-6">
        <WarrantyClient projectId={project.id} requests={requests} />
      </div>
    </PageLayout>
  )
}
