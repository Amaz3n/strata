import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { DrawingsSetsView } from "@/components/drawings"
import { getProjectAction } from "../actions"
import { listDrawingSets, listDrawingSheets } from "@/lib/services/drawings"

interface ProjectDrawingsPageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<{ set?: string; sheetId?: string }>
}

export default async function ProjectDrawingsPage({
  params,
  searchParams,
}: ProjectDrawingsPageProps) {
  const { id } = await params
  const query = await searchParams

  const [project, sets, sheets] = await Promise.all([
    getProjectAction(id),
    listDrawingSets({ project_id: id, limit: 100 }),
    listDrawingSheets({ project_id: id, limit: 500 }),
  ])

  if (!project) {
    notFound()
  }

  const initialSelectedSetId =
    query.set && sets.some((set) => set.id === query.set) ? query.set : undefined

  return (
    <PageLayout title="Drawings">
      <div className="-m-4 -mt-6 h-[calc(100vh-3.5rem)]">
        <DrawingsSetsView
          initialSets={sets}
          initialSheets={sheets}
          projects={[{ id: project.id, name: project.name }]}
          selectedProjectId={project.id}
          lockProject
          initialSelectedSetId={initialSelectedSetId}
          initialSheetId={query.sheetId}
        />
      </div>
    </PageLayout>
  )
}
