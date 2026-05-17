import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { ProposalsClient } from "@/components/proposals/proposals-client"
import { listProposalsAction, listProposalProjectsAction } from "./actions"
import { Skeleton } from "@/components/ui/skeleton"

export const dynamic = 'force-dynamic'

async function ProposalsData() {
  const [proposals, projects] = await Promise.all([
    listProposalsAction(),
    listProposalProjectsAction(),
  ])

  return (
    <div className="space-y-6">
      <ProposalsClient proposals={proposals} projects={projects} allowNoProject={false} />
    </div>
  )
}

export default function ProposalsPage() {
  return (
    <PageLayout title="Proposals">
      <Suspense fallback={<div className="p-6 space-y-4"><Skeleton className="h-8 w-48 mb-6" /><div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => (<Skeleton key={i} className="h-16 w-full rounded-md" />))}</div></div>}>
        <ProposalsData />
      </Suspense>
    </PageLayout>
  )
}
