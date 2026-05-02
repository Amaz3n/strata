import { PageLayout } from "@/components/layout/page-layout"
export const dynamic = 'force-dynamic'
import { TEAM_PERMISSION_OPTIONS, listAssignableOrgRoles, listTeamMembers } from "@/lib/services/team"
import { TeamPageClient } from "@/components/team/team-page-client"
import { getCurrentUserPermissions } from "@/lib/services/permissions"

export default async function TeamPage() {
  const [members, permissionResult, roleOptions] = await Promise.all([
    listTeamMembers(),
    getCurrentUserPermissions(),
    listAssignableOrgRoles().catch(() => []),
  ])

  const canManageMembers = permissionResult.permissions.includes("members.manage")
  const canEditRoles = permissionResult.permissions.includes("org.admin")

  return (
    <PageLayout title="Team">
      <TeamPageClient
        members={members}
        canManageMembers={canManageMembers}
        canEditRoles={canEditRoles}
        roleOptions={roleOptions}
        permissionOptions={TEAM_PERMISSION_OPTIONS}
      />
    </PageLayout>
  )
}
