import { AppShell } from "@/components/layout/app-shell"
import { getCurrentUserAction } from "@/app/actions/user"
import { listTeamMembers } from "@/lib/services/team"
import { InviteMemberDialog } from "@/components/team/invite-member-dialog"
import { TeamTable } from "@/components/team/team-table"
import { getCurrentUserPermissions } from "@/lib/services/permissions"

export default async function TeamPage() {
  const [members, currentUser, permissionResult] = await Promise.all([
    listTeamMembers(),
    getCurrentUserAction(),
    getCurrentUserPermissions(),
  ])

  const canManageMembers = permissionResult.permissions.includes("members.manage")
  const canEditRoles = permissionResult.permissions.includes("org.admin")

  return (
    <AppShell title="Team" user={currentUser}>
      <div className="p-4 lg:p-6 space-y-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Team</h1>
            <p className="text-muted-foreground mt-1">Manage internal teammates, roles, and invite workflow.</p>
          </div>
          <InviteMemberDialog canInvite={canManageMembers} />
        </div>
        <TeamTable members={members} canManageMembers={canManageMembers} canEditRoles={canEditRoles} />
      </div>
    </AppShell>
  )
}

