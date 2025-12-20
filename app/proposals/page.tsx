import { Suspense } from "react"
import { AppShell } from "@/components/layout/app-shell"
import { getCurrentUserAction } from "@/app/actions/user"
import { listProposalsAction, listProposalProjectsAction } from "./actions"
import { ProposalsClient } from "@/components/proposals/proposals-client"

export const dynamic = 'force-dynamic'

export default async function ProposalsPage() {
  const [user, proposals, projects] = await Promise.all([
    getCurrentUserAction(),
    listProposalsAction(),
    listProposalProjectsAction(),
  ])

  return (
    <AppShell title="Proposals" user={user}>
      <div className="p-4 lg:p-6">
        <Suspense fallback={<div className="p-4">Loading...</div>}>
          <ProposalsClient proposals={proposals} projects={projects} />
        </Suspense>
      </div>
    </AppShell>
  )
}
