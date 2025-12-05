import { AppShell } from "@/components/layout/app-shell"
import { getCurrentUserAction } from "@/app/actions/user"
import { listTeamMembers } from "@/lib/services/team"
import { InviteMemberDialog } from "@/components/team/invite-member-dialog"
import { TeamTable } from "@/components/team/team-table"

export default async function TeamPage() {
  const [members, currentUser] = await Promise.all([listTeamMembers(), getCurrentUserAction()])

  return (
    <AppShell title="Team" user={currentUser}>
      <div className="p-4 lg:p-6 space-y-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Team</h1>
            <p className="text-muted-foreground mt-1">Manage internal teammates, roles, and invite workflow.</p>
          </div>
          <InviteMemberDialog />
        </div>
        <TeamTable members={members} />
      </div>
    </AppShell>
  )
}

