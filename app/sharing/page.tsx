import { AppShell } from "@/components/layout/app-shell"
import { listProjectsAction } from "@/app/projects/actions"
import { getCurrentUserAction } from "@/app/actions/user"
import { listPortalTokens } from "@/lib/services/portal-access"
import { SharingClient } from "./sharing-client"

export default async function SharingPage() {
  const [projects, currentUser] = await Promise.all([listProjectsAction(), getCurrentUserAction()])
  const firstProjectId = projects[0]?.id
  const tokens = firstProjectId ? await listPortalTokens(firstProjectId) : []

  return (
    <AppShell title="Sharing" user={currentUser} badges={{ projects: projects.length }}>
      <div className="p-4 lg:p-6">
        <SharingClient projects={projects} initialTokens={tokens} />
      </div>
    </AppShell>
  )
}

