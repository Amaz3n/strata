import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction, getProjectTeamAction, listProjectPunchItemsAction } from "../actions"
import { ProjectPunchClient } from "./project-punch-client"

// export const dynamic = "force-dynamic" // Removed for better caching performance

interface ProjectPunchPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectPunchPage({ params }: ProjectPunchPageProps) {
  const { id } = await params

  const [project, team, punchItems] = await Promise.all([
    getProjectAction(id),
    getProjectTeamAction(id),
    listProjectPunchItemsAction(id),
  ])

  if (!project) {
    notFound()
  }

  return (
    <PageLayout title="Punch">
      <div className="space-y-6">
        <ProjectPunchClient projectId={project.id} initialItems={punchItems} team={team} />
      </div>
    </PageLayout>
  )
}
