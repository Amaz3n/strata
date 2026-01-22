import { PageLayout } from "@/components/layout/page-layout"
import { ProspectsTable } from "@/components/crm"
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
        <div>
          <h1 className="text-2xl font-bold">Prospects</h1>
          <p className="text-muted-foreground">
            Manage your leads and track them through the sales pipeline
          </p>
        </div>
        <ProspectsTable
          prospects={prospects}
          teamMembers={teamMembers}
          canCreate={canCreate}
          canEdit={canEdit}
        />
      </div>
    </PageLayout>
  )
}
