import { PageLayout } from "@/components/layout/page-layout"
import { NoProjectSelected } from "@/components/projects/no-project-selected"

export const dynamic = 'force-dynamic'

export default async function InvoicesPage() {

  return (
    <PageLayout title="Invoices">
      <div className="space-y-6">
        <NoProjectSelected />
      </div>
    </PageLayout>
  )
}
