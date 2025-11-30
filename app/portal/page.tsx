import { AppShell } from "@/components/layout/app-shell"
import type { ConversationChannel } from "@/lib/types"
import { listProjectsAction } from "@/app/projects/actions"
import { getCurrentUserAction } from "@/app/actions/user"
import { loadPortalViewAction } from "./actions"
import { PortalClient } from "./portal-client"

export default async function PortalPage() {
  const [projects, currentUser] = await Promise.all([listProjectsAction(), getCurrentUserAction()])

  const initialChannel: ConversationChannel = "client"
  const initialProjectId = projects[0]?.id
  const initialView = initialProjectId ? await loadPortalViewAction(initialProjectId, initialChannel) : null

  return (
    <AppShell title="Portal" user={currentUser} badges={{ projects: projects.length }}>
      <div className="p-4 lg:p-6">
        <PortalClient
          projects={projects}
          initialChannel={initialChannel}
          initialView={initialView}
        />
      </div>
    </AppShell>
  )
}
