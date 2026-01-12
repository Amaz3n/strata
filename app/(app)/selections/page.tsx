import { PageLayout } from "@/components/layout/page-layout"
export const dynamic = 'force-dynamic'
import { NoProjectSelected } from "@/components/projects/no-project-selected"

export default async function SelectionsPage() {

  return (
    <PageLayout title="Selections">
      <div className="space-y-6">
        <NoProjectSelected />
      </div>
    </PageLayout>
  )
}





