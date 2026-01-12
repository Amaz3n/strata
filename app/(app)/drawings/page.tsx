import { PageLayout } from "@/components/layout/page-layout"
import { NoProjectSelected } from "@/components/projects/no-project-selected"

// export const dynamic = "force-dynamic" // Removed for better caching performance

export default async function DrawingsPage() {

  return (
    <PageLayout title="Drawings">
      <div className="px-6 py-0 h-full">
        <NoProjectSelected />
      </div>
    </PageLayout>
  )
}
