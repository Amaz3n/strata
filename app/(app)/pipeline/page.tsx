import { PageLayout } from "@/components/layout/page-layout"
import { OpportunitiesClient } from "@/components/opportunities/opportunities-client"
import { listOpportunities } from "@/lib/services/opportunities"
import { listTeamMembers } from "@/lib/services/team"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { listContacts } from "@/lib/services/contacts"

export const dynamic = "force-dynamic"

export default async function PipelinePage() {
  const [opportunities, teamMembers, permissionResult, clients] = await Promise.all([
    listOpportunities(),
    listTeamMembers(),
    getCurrentUserPermissions(),
    listContacts(undefined, { contact_type: "client" }),
  ])

  const permissions = permissionResult?.permissions ?? []
  const canEdit = permissions.includes("org.member")
  const canCreate = permissions.includes("org.member")

  return (
    <PageLayout title="Opportunities">
      <OpportunitiesClient
        opportunities={opportunities}
        teamMembers={teamMembers}
        clients={clients}
        canCreate={canCreate}
        canEdit={canEdit}
      />
    </PageLayout>
  )
}
