import { PageLayout } from "@/components/layout/page-layout"
import { ProspectsClient } from "@/components/prospects/prospects-client"
import { listProspects } from "@/lib/services/crm"
import { listTeamMembers } from "@/lib/services/team"
import { getCurrentUserPermissions } from "@/lib/services/permissions"

export const dynamic = "force-dynamic"

export default async function ProspectsPage() {
  const [prospects, teamMembers, permissionResult] = await Promise.all([
    listProspects(),
    listTeamMembers(),
    getCurrentUserPermissions(),
  ])

  const permissions = permissionResult?.permissions ?? []
  const canEdit = permissions.includes("org.member")
  const canCreate = permissions.includes("org.member")

  return (
    <PageLayout title="Prospects">
      <div className="space-y-6">
        <ProspectsClient
          prospects={prospects}
          teamMembers={teamMembers}
          canCreate={canCreate}
          canEdit={canEdit}
        />
      </div>
    </PageLayout>
  )
}