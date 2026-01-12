import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction } from "../actions"
import { DocumentsCenterClient } from "@/app/(app)/files/documents-client"
import {
  listFilesAction,
  getFileCountsAction,
} from "@/app/(app)/files/actions"

// export const dynamic = "force-dynamic" // Removed for better caching performance

interface ProjectFilesPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectFilesPage({ params }: ProjectFilesPageProps) {
  const { id } = await params

  const [project, files, counts] = await Promise.all([
    getProjectAction(id),
    listFilesAction({ project_id: id, limit: 60, offset: 0 }),
    getFileCountsAction(id),
  ])

  if (!project) {
    notFound()
  }

  return (
    <PageLayout title="Files">
      <div className="px-6 py-0 h-full">
        <DocumentsCenterClient
          initialFiles={files}
          initialCounts={counts}
          initialProjects={[{ id: project.id, name: project.name }]}
          defaultProjectId={project.id}
          lockProject
        />
      </div>
    </PageLayout>
  )
}
