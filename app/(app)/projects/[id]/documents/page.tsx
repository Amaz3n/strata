import { notFound } from "next/navigation"
import { Suspense } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectAction } from "../actions"
import { loadDocumentsViewAction } from "@/app/(app)/documents/actions"
import { UnifiedDocumentsLayout } from "@/components/documents"

interface ProjectFilesPageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<{ path?: string }>
}

export const instant = true

export default function ProjectFilesPage({ params, searchParams }: ProjectFilesPageProps) {
  return (
    <PageLayout title="Documents" fullBleed>
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

  const view = await loadDocumentsViewAction({
    projectId: id,
    filters: {
      folder_path: normalizedPath,
      root_only: normalizedPath ? undefined : true,
      limit: 100,
      offset: 0,
    },
    childFolderPath: normalizedPath,
  })
  const folders = view.childFolders ?? []

  return (
    <UnifiedDocumentsLayout
      project={{ id: project.id, name: project.name }}
      initialFiles={view.files}
      initialTotalCount={view.totalCount}
      initialHasMore={view.hasMore}
      initialCounts={view.counts ?? {}}
      initialFolders={folders.map((folder) => folder.path)}
      initialFolderCounts={Object.fromEntries(
        folders.map((folder) => [folder.path, folder.itemCount])
      )}
      initialFolderPermissions={view.folderPermissions ?? []}
      initialPath={query.path}
    />
  )
}
