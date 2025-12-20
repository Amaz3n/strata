import { notFound } from "next/navigation"
import { AppShell } from "@/components/layout/app-shell"
import { getCurrentUserAction } from "@/app/actions/user"
import { getProjectAction } from "../actions"
import { listDrawingSets, listDrawingSheets, getDisciplineCounts } from "@/lib/services/drawings"
import { DrawingsClient } from "@/components/drawings/drawings-client"

export const dynamic = "force-dynamic"

interface ProjectDrawingsPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectDrawingsPage({ params }: ProjectDrawingsPageProps) {
  const { id } = await params

  const [project, currentUser, sets, sheets, disciplineCounts] = await Promise.all([
    getProjectAction(id),
    getCurrentUserAction(),
    listDrawingSets({ project_id: id, limit: 50 }),
    listDrawingSheets({ project_id: id, limit: 100 }),
    getDisciplineCounts(id),
  ])

  if (!project) {
    notFound()
  }

  return (
    <AppShell
      title="Drawings"
      user={currentUser}
      breadcrumbs={[
        { label: "Projects", href: "/projects" },
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Drawings" },
      ]}
    >
      <div className="p-6 h-full">
        <DrawingsClient
          initialSets={sets}
          initialSheets={sheets}
          initialDisciplineCounts={disciplineCounts}
          projects={[{ id: project.id, name: project.name }]}
          defaultProjectId={project.id}
          lockProject
        />
      </div>
    </AppShell>
  )
}
