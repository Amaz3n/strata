import { NoProjectSelected } from "@/components/projects/no-project-selected"
import { PageLayout } from "@/components/layout/page-layout"

export const dynamic = 'force-dynamic'

export default async function ChangeOrdersPage() {
  return (
    <PageLayout title="Change Orders">
      <div className="space-y-6">
        <NoProjectSelected />
      </div>
    </PageLayout>
  )
}
