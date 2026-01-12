import { PageLayout } from "@/components/layout/page-layout"
export const dynamic = 'force-dynamic'
import type { ConversationChannel } from "@/lib/types"
import { listProjectsAction } from "@/app/(app)/projects/actions"
import { loadPortalViewAction } from "./actions"
import { PortalClient } from "./portal-client"

export default async function PortalPage() {

  const initialChannel: ConversationChannel = "client"
  const initialProjectId = projects[0]?.id
  const initialView = initialProjectId ? await loadPortalViewAction(initialProjectId, initialChannel) : null

  return (
    <PageLayout title="Page">
      <div className="space-y-6">
        <PortalClient
          projects={projects}
          initialChannel={initialChannel}
          initialView={initialView}
        />
      </div>
    </PageLayout>
  )
}
