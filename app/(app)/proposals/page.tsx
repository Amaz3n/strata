import { PageLayout } from "@/components/layout/page-layout"
import { ProposalsClient } from "@/components/proposals/proposals-client"
import { listProposalsAction, listProposalProjectsAction } from "./actions"

export const dynamic = 'force-dynamic'

export default async function ProposalsPage() {
  const [proposals, projects] = await Promise.all([
    listProposalsAction(),
    listProposalProjectsAction(),
  ])

  return (
    <PageLayout title="Proposals">
      <div className="space-y-6">
        <ProposalsClient proposals={proposals} projects={projects} allowNoProject />
      </div>
    </PageLayout>
  )
}
