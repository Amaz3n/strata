import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction } from "../actions"
import { getCloseoutPackageAction } from "@/app/(app)/closeout/actions"
import { CloseoutClient } from "@/components/closeout/closeout-client"

// export const dynamic = "force-dynamic" // Removed for better caching performance

interface ProjectCloseoutPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectCloseoutPage({ params }: ProjectCloseoutPageProps) {
  const { id } = await params

  const [project, closeout] = await Promise.all([
    getProjectAction(id),
    getCloseoutPackageAction(id),
  ])

  if (!project) notFound()

  return (
    <PageLayout title="Closeout">
      <div className="space-y-6">
        <CloseoutClient projectId={project.id} closeoutPackage={closeout?.package} items={closeout?.items ?? []} />
      </div>
    </PageLayout>
  )
}
