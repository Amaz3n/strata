import { PageLayout } from "@/components/layout/page-layout"
import { StartPipelineClient } from "@/components/starts/start-pipeline-client"
import { listStartPackages } from "@/lib/services/starts"

export const dynamic = "force-dynamic"

export default async function StartsPipelinePage() {
  const result = await listStartPackages({ pageSize: 200 })
  return (
    <PageLayout title="Start pipeline" fullBleed>
      <div className="p-4">
        <StartPipelineClient packages={result.packages} total={result.total} />
      </div>
    </PageLayout>
  )
}
