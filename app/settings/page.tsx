import { AppShell } from "@/components/layout/app-shell"
export const dynamic = 'force-dynamic'
import { SettingsWindow } from "@/components/settings/settings-window"
import { getCurrentUserAction } from "../actions/user"
import { getQBOConnection } from "@/lib/services/qbo-connection"
import { listTeamMembers } from "@/lib/services/team"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { getOrgBilling } from "@/lib/services/orgs"

interface SettingsPageProps {
  searchParams?: {
    tab?: string
  }
}

export default async function SettingsPage({ searchParams }: SettingsPageProps) {
  const [currentUser, qboConnection, teamMembers, permissionResult] = await Promise.all([
    getCurrentUserAction(),
    getQBOConnection(),
    listTeamMembers(),
    getCurrentUserPermissions(),
  ])
  const initialTab = typeof searchParams?.tab === "string" ? searchParams.tab : undefined
  const permissions = permissionResult.permissions
  const canManageMembers = permissions.includes("members.manage")
  const canEditRoles = permissions.includes("org.admin")
  const canManageBilling = permissions.includes("billing.manage")
  const billing = canManageBilling ? await getOrgBilling().catch(() => null) : null

  return (
    <AppShell title="Settings" user={currentUser}>
      <SettingsWindow
        user={currentUser}
        initialTab={initialTab}
        initialQboConnection={qboConnection}
        teamMembers={teamMembers}
        canManageMembers={canManageMembers}
        canEditRoles={canEditRoles}
        initialBilling={billing}
        canManageBilling={canManageBilling}
      />
    </AppShell>
  )
}
