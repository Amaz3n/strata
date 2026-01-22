import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction } from "../../../actions"
import { getDrawingSet, listDrawingSheetsWithUrls, listDrawingRevisions } from "@/lib/services/drawings"
import { DrawingsClient } from "@/components/drawings/drawings-client"

interface ProjectDrawingSetPageProps {
  params: Promise<{ id: string; setId: string }>
}

function buildDisciplineCounts(sheets: Array<{ discipline?: string | null }>) {
  return sheets.reduce<Record<string, number>>(
    (acc, sheet) => {
      const discipline = sheet.discipline ?? "X"
      acc.all = (acc.all ?? 0) + 1
      acc[discipline] = (acc[discipline] ?? 0) + 1
      return acc
    },
    { all: 0 }
  )
}

export default async function ProjectDrawingSetPage({ params }: ProjectDrawingSetPageProps) {
  const { id, setId } = await params

  const [project, set, sheets, revisions] = await Promise.all([
    getProjectAction(id),
    getDrawingSet(setId),
    listDrawingSheetsWithUrls({ project_id: id, drawing_set_id: setId, limit: 200 }),
    listDrawingRevisions({ project_id: id, drawing_set_id: setId, limit: 50 }),
  ])

  if (!project || !set || set.project_id !== id) {
    notFound()
  }

  const disciplineCounts = buildDisciplineCounts(sheets)

  return (
    <PageLayout
      title="Drawings"
      breadcrumbs={[
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Drawings", href: `/projects/${project.id}/drawings` },
        { label: set.title },
      ]}
    >
      <div className="px-6 py-0 h-full">
        <DrawingsClient
          initialSets={[set]}
          initialSheets={sheets}
          initialDisciplineCounts={disciplineCounts}
          initialRevisions={revisions}
          projects={[{ id: project.id, name: project.name }]}
          defaultProjectId={project.id}
          lockProject
          initialTabMode="sheets"
          initialSelectedSetId={setId}
          lockSet
          hideTabs
        />
      </div>
    </PageLayout>
  )
}
