import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction } from "../actions"
import { listDrawingSets } from "@/lib/services/drawings"
import {
  listFilesAction,
  getFileCountsAction,
  listFoldersAction,
} from "@/app/(app)/documents/actions"
import { UnifiedDocumentsLayout } from "@/components/documents"

interface ProjectFilesPageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<{ path?: string; set?: string }>
}

export default async function ProjectFilesPage({ params, searchParams }: ProjectFilesPageProps) {
  const { id } = await params
  const query = await searchParams

  const [project, filesResult, counts, folders, sets] = await Promise.all([
    getProjectAction(id),
    listFilesAction({ project_id: id, limit: 100, offset: 0 }),
    getFileCountsAction(id),
    listFoldersAction(id),
    listDrawingSets({ project_id: id, limit: 50 }),
  ])

  if (!project) {
    notFound()
  }

  return (
    <PageLayout title="Documents">
      <div className="-m-4 -mt-6 h-[calc(100vh-3.5rem)]">
        <UnifiedDocumentsLayout
          project={{ id: project.id, name: project.name }}
          initialFiles={filesResult.data}
          initialTotalCount={filesResult.count}
          initialHasMore={filesResult.hasMore}
          initialCounts={counts}
          initialFolders={folders}
          initialSets={sets}
          initialPath={query.path}
          initialSetId={query.set}
        />
      </div>
    </PageLayout>
  )
}
