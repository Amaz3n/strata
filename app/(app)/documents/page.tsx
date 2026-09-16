import { Suspense } from "react"
import { connection } from "next/server"
import { PageLayout } from "@/components/layout/page-layout"
import { Skeleton } from "@/components/ui/skeleton"
import { UnifiedDocumentsLayout } from "@/components/documents"
import { loadDocumentsViewAction } from "./actions"

export const instant = true

type Props = { searchParams: Promise<{ path?: string }> }

export default function DocumentsPage({ searchParams }: Props) {
  return (
    <PageLayout title="Documents" fullBleed>
      <Suspense fallback={<div data-instant-shell="office-documents" className="space-y-4 p-6"><Skeleton className="h-8 w-48" /><Skeleton className="h-64 w-full" /></div>}>
        <OfficeDocuments searchParams={searchParams} />
      </Suspense>
    </PageLayout>
  )
}

async function OfficeDocuments({ searchParams }: Props) {
  await connection()
  const query = await searchParams
  const path = query.path?.trim() || undefined
  const view = await loadDocumentsViewAction({
    filters: { folder_path: path, root_only: !path, limit: 100, offset: 0 },
    childFolderPath: path,
  })
  const folders = view.childFolders ?? []
  return (
    <UnifiedDocumentsLayout
      project={{ name: "Office documents" }}
      initialFiles={view.files}
      initialTotalCount={view.totalCount}
      initialHasMore={view.hasMore}
      initialCounts={view.counts ?? {}}
      initialFolders={folders.map((folder) => folder.path)}
      initialFolderCounts={Object.fromEntries(folders.map((folder) => [folder.path, folder.itemCount]))}
      initialPath={path}
    />
  )
}
