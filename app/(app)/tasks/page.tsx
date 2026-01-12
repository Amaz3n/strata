import { PageLayout } from "@/components/layout/page-layout"
// export const dynamic = "force-dynamic" // Removed for better caching performance
import { NoProjectSelected } from "@/components/projects/no-project-selected"

export default async function TasksPage() {

  return (
    <PageLayout title="Tasks">
      <div className="space-y-6">
        <NoProjectSelected />
      </div>
    </PageLayout>
  )
}
