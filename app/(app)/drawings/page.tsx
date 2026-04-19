import { PageLayout } from "@/components/layout/page-layout"
import { DrawingsSetsView } from "@/components/drawings"
import { listDrawingSets } from "@/lib/services/drawings"
import { listProjectsForDrawingsAction } from "./actions"

interface DrawingsPageProps {
  searchParams: Promise<{ project?: string }>
}

export default async function DrawingsPage({ searchParams }: DrawingsPageProps) {
  const query = await searchParams
  const projects = await listProjectsForDrawingsAction()
  const selectedProjectId =
    query.project && projects.some((p) => p.id === query.project)
      ? query.project
      : undefined

  const sets = selectedProjectId
    ? await listDrawingSets({ project_id: selectedProjectId, limit: 100 })
    : []

  return (
    <PageLayout title="Drawings">
      <div className="-m-4 -mt-6 h-[calc(100vh-3.5rem)]">
        <DrawingsSetsView
          initialSets={sets}
          projects={projects}
          selectedProjectId={selectedProjectId}
        />
      </div>
    </PageLayout>
  )
}
