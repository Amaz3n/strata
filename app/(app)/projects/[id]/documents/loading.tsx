import { PageLayout } from "@/components/layout/page-layout"
import { ProjectDocumentsSkeleton } from "@/components/documents/project-documents-skeleton"

export default function ProjectDocumentsLoading() {
  return (
    <PageLayout title="Documents" fullBleed>
      <div data-instant-shell="project-documents" className="flex h-full min-h-0 flex-col">
        <ProjectDocumentsSkeleton />
      </div>
    </PageLayout>
  )
}
