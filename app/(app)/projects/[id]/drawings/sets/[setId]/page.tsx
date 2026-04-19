import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { DrawingSetDetail } from "@/components/drawings"
import { getProjectAction } from "../../../actions"
import {
  getDrawingSet,
  listDrawingSheetsWithUrls,
} from "@/lib/services/drawings"

interface ProjectDrawingSetPageProps {
  params: Promise<{ id: string; setId: string }>
}

export default async function ProjectDrawingSetPage({ params }: ProjectDrawingSetPageProps) {
  const { id, setId } = await params

  const [project, selectedSet, sheets] = await Promise.all([
    getProjectAction(id),
    getDrawingSet(setId),
    listDrawingSheetsWithUrls({
      project_id: id,
      drawing_set_id: setId,
      limit: 500,
    }),
  ])

  if (!project || !selectedSet || selectedSet.project_id !== project.id) {
    notFound()
  }

  return (
    <PageLayout title="Drawings">
      <div className="-m-4 -mt-6 h-[calc(100vh-3.5rem)]">
        <DrawingSetDetail
          set={selectedSet}
          sheets={sheets}
          projectId={project.id}
          projectName={project.name}
        />
      </div>
    </PageLayout>
  )
}
