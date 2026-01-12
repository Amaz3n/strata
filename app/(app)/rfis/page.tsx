import { PageLayout } from "@/components/layout/page-layout"
import { RfisClient } from "@/components/rfis/rfis-client"
import { listRfisAction } from "./actions"
import { listProjectsAction } from "@/app/(app)/projects/actions"

export const dynamic = 'force-dynamic'

export default async function RfisPage() {
  const [rfis, projects] = await Promise.all([
    listRfisAction(),
    listProjectsAction(),
  ])

  return (
    <PageLayout title="RFIs">
      <div className="space-y-6">
        <RfisClient rfis={rfis} projects={projects} />
      </div>
    </PageLayout>
  )
}
