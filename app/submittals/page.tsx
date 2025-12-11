import { AppShell } from "@/components/layout/app-shell"
export const dynamic = 'force-dynamic'
import { SubmittalsClient } from "@/components/submittals/submittals-client"
import { listSubmittalsAction } from "./actions"
import { listProjectsAction } from "../projects/actions"
import { getCurrentUserAction } from "../actions/user"

export default async function SubmittalsPage() {
  const [submittals, projects, currentUser] = await Promise.all([
    listSubmittalsAction(),
    listProjectsAction(),
    getCurrentUserAction(),
  ])

  return (
    <AppShell title="Submittals" user={currentUser}>
      <div className="p-4 lg:p-6">
        <SubmittalsClient submittals={submittals} projects={projects} />
      </div>
    </AppShell>
  )
}

