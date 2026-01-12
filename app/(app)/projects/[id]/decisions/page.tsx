import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction } from "../actions"
import { listDecisionsAction } from "@/app/(app)/decisions/actions"
import { DecisionsClient } from "@/components/decisions/decisions-client"

// export const dynamic = "force-dynamic" // Removed for better caching performance

interface ProjectDecisionsPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectDecisionsPage({ params }: ProjectDecisionsPageProps) {
  const { id } = await params

  const [project, decisions] = await Promise.all([
    getProjectAction(id),
    listDecisionsAction(id),
  ])

  if (!project) {
    notFound()
  }

  return (
    <PageLayout title="Decisions">
      <div className="space-y-6">
        <DecisionsClient projectId={project.id} decisions={decisions} />
      </div>
    </PageLayout>
  )
}
