import { PageLayout } from "@/components/layout/page-layout"
import { NoProjectSelected } from "@/components/projects/no-project-selected"

// export const dynamic = "force-dynamic" // Removed for better caching performance

export default async function FilesPage() {

  return (
    <PageLayout title="Documents">
      <div className="-m-4 -mt-6 h-[calc(100vh-3.5rem)]">
        <NoProjectSelected />
      </div>
    </PageLayout>
  )
}

