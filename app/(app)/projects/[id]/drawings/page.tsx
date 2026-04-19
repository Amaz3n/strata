import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { DrawingsSetsView } from "@/components/drawings"
import { getProjectAction } from "../actions"
import { listDrawingSets } from "@/lib/services/drawings"

interface ProjectDrawingsPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectDrawingsPage({ params }: ProjectDrawingsPageProps) {
  const { id } = await params

  const [project, sets] = await Promise.all([
    getProjectAction(id),
    listDrawingSets({ project_id: id, limit: 100 }),
  ])

  if (!project) {
    notFound()
  }

  return (
    <PageLayout title="Drawings">
      <div className="-m-4 -mt-6 h-[calc(100vh-3.5rem)]">
        <DrawingsSetsView
          initialSets={sets}
          projects={[{ id: project.id, name: project.name }]}
          selectedProjectId={project.id}
          lockProject
        />
      </div>
    </PageLayout>
  )
}
