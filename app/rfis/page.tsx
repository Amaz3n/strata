import { AppShell } from "@/components/layout/app-shell"
export const dynamic = 'force-dynamic'
import { RfisClient } from "@/components/rfis/rfis-client"
import { listRfisAction } from "./actions"
import { listProjectsAction } from "../projects/actions"
import { getCurrentUserAction } from "../actions/user"

export default async function RfisPage() {
  const [rfis, projects, currentUser] = await Promise.all([
    listRfisAction(),
    listProjectsAction(),
    getCurrentUserAction(),
  ])

  return (
    <AppShell title="RFIs" user={currentUser}>
      <div className="p-4 lg:p-6">
        <RfisClient rfis={rfis} projects={projects} />
      </div>
    </AppShell>
  )
}

