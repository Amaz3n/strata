import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction } from "../actions"
import { listDrawingSets, listDrawingSheetsWithUrls, getDisciplineCounts } from "@/lib/services/drawings"
import { DrawingsClient } from "@/components/drawings/drawings-client"

// export const dynamic = "force-dynamic" // Removed for better caching performance

interface ProjectDrawingsPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectDrawingsPage({ params }: ProjectDrawingsPageProps) {
  const { id } = await params

  const [project, sets, sheets, disciplineCounts] = await Promise.all([
    getProjectAction(id),
    listDrawingSets({ project_id: id, limit: 50 }),
    listDrawingSheetsWithUrls({ project_id: id, limit: 100 }),
    getDisciplineCounts(id),
  ])

  if (!project) {
    notFound()
  }

  return (
    <PageLayout title="Drawings">
      <div className="px-6 py-0 h-full">
        <DrawingsClient
          initialSets={sets}
          initialSheets={sheets}
          initialDisciplineCounts={disciplineCounts}
          projects={[{ id: project.id, name: project.name }]}
          defaultProjectId={project.id}
          lockProject
        />
      </div>
    </PageLayout>
  )
}
