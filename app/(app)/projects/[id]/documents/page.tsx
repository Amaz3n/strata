import { notFound } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction } from "../actions"
import {
  listFilesAction,
  getFileCountsAction,
  listChildFoldersAction,
} from "@/app/(app)/documents/actions"
import { UnifiedDocumentsLayout } from "@/components/documents"

interface ProjectFilesPageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<{ path?: string }>
}

export default async function ProjectFilesPage({ params, searchParams }: ProjectFilesPageProps) {
  const { id } = await params
  const query = await searchParams

  const normalizedPath = query.path?.trim() ? query.path : undefined

  const [project, filesResult, counts, folders] = await Promise.all([
    getProjectAction(id),
    listFilesAction({
      project_id: id,
      folder_path: normalizedPath,
      root_only: normalizedPath ? undefined : true,
      limit: 100,
      offset: 0,
    }),
    getFileCountsAction(id),
    listChildFoldersAction(id, normalizedPath),
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
          initialFolders={folders.map((folder) => folder.path)}
          initialSets={[]}
          initialPath={query.path}
        />
      </div>
    </PageLayout>
  )
}
