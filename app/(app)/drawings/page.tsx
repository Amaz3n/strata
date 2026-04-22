import { PageLayout } from "@/components/layout/page-layout"
import { DrawingsSetsView } from "@/components/drawings"
import { listDrawingSets, listDrawingSheets } from "@/lib/services/drawings"
import { listProjectsForDrawingsAction } from "./actions"

interface DrawingsPageProps {
  searchParams: Promise<{ project?: string; set?: string; sheetId?: string }>
}

export default async function DrawingsPage({ searchParams }: DrawingsPageProps) {
  const query = await searchParams
  const projects = await listProjectsForDrawingsAction()
  const selectedProjectId =
    query.project && projects.some((p) => p.id === query.project)
      ? query.project
      : undefined

  const [sets, sheets] = selectedProjectId
    ? await Promise.all([
        listDrawingSets({ project_id: selectedProjectId, limit: 100 }),
        listDrawingSheets({ project_id: selectedProjectId, limit: 500 }),
      ])
    : [[], []]
  const initialSelectedSetId =
    query.set && sets.some((set) => set.id === query.set) ? query.set : undefined

  return (
    <PageLayout title="Drawings">
      <div className="-m-4 -mt-6 h-[calc(100vh-3.5rem)]">
        <DrawingsSetsView
          initialSets={sets}
          initialSheets={sheets}
          projects={projects}
          selectedProjectId={selectedProjectId}
          initialSelectedSetId={initialSelectedSetId}
          initialSheetId={query.sheetId}
        />
      </div>
    </PageLayout>
  )
}
