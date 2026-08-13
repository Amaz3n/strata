import { notFound } from "next/navigation"
import { Suspense } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction } from "../actions"
import {
  listFilesAction,
  getFileCountsAction,
  listChildFoldersAction,
} from "@/app/(app)/documents/actions"
import { UnifiedDocumentsLayout } from "@/components/documents"

import { unwrapAction } from "@/lib/action-result"

interface ProjectFilesPageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<{ path?: string }>
}

export const instant = true

export default function ProjectFilesPage({ params, searchParams }: ProjectFilesPageProps) {
  return (
    <PageLayout
      title="Documents"
    >
      <Suspense
        fallback={
          <div data-instant-shell="project-documents" className="p-6 space-y-4">
            <Skeleton className="h-8 w-48 mb-6" />
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full rounded-md" />
              ))}
            </div>
          </div>
        }
      >
        <ProjectFilesData params={params} searchParams={searchParams} />
      </Suspense>
    </PageLayout>
  )
}

async function ProjectFilesData({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ path?: string }>
}) {
  const [{ id }, query] = await Promise.all([params, searchParams])
  const project = await getProjectAction(id)

  if (!project) {
    notFound()
  }

  const normalizedPath = query.path?.trim() ? query.path : undefined

  const [filesResult, counts, folders] = await Promise.all([
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

  return (
    <div className="-m-4 -mt-6 h-[calc(100vh-3.5rem)]">
      <UnifiedDocumentsLayout
        project={{ id: project.id, name: project.name }}
        initialFiles={filesResult.data}
        initialTotalCount={filesResult.count}
        initialHasMore={filesResult.hasMore}
        initialCounts={counts}
        initialFolders={folders.map((folder) => folder.path)}
        initialFolderCounts={Object.fromEntries(
          folders.map((folder) => [folder.path, folder.itemCount])
        )}
        initialSets={[]}
        initialPath={query.path}
      />
    </div>
  )
}
