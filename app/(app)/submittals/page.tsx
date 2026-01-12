import { PageLayout } from "@/components/layout/page-layout"
import { SubmittalsClient } from "@/components/submittals/submittals-client"
import { listSubmittalsAction } from "./actions"
import { listProjectsAction } from "@/app/(app)/projects/actions"

export const dynamic = 'force-dynamic'

export default async function SubmittalsPage() {
  const [submittals, projects] = await Promise.all([
    listSubmittalsAction(),
    listProjectsAction(),
  ])

  return (
    <PageLayout title="Submittals">
      <div className="space-y-6">
        <SubmittalsClient submittals={submittals} projects={projects} />
      </div>
    </PageLayout>
  )
}
