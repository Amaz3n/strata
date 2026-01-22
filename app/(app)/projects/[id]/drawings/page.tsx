import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction } from "../actions"
import { listDrawingSets } from "@/lib/services/drawings"
import { DrawingsClient } from "@/components/drawings/drawings-client"

// export const dynamic = "force-dynamic" // Removed for better caching performance

interface ProjectDrawingsPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectDrawingsPage({ params }: ProjectDrawingsPageProps) {
  const { id } = await params

  const [project, sets] = await Promise.all([
    getProjectAction(id),
    listDrawingSets({ project_id: id, limit: 50 }),
  ])

  if (!project) {
    notFound()
  }

  return (
    <PageLayout
      title="Drawings"
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Drawings" },
      ]}
    >
      <div className="px-6 py-0 h-full">
        <DrawingsClient
          initialSets={sets}
          initialSheets={[]}
          initialDisciplineCounts={{}}
          projects={[{ id: project.id, name: project.name }]}
          defaultProjectId={project.id}
          lockProject
          initialTabMode="sets"
          hideTabs
        />
      </div>
    </PageLayout>
  )
}
