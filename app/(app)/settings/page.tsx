import { PageLayout } from "@/components/layout/page-layout"
export const dynamic = 'force-dynamic'
import { SettingsWindow } from "@/components/settings/settings-window"
import { getQBOConnection } from "@/lib/services/qbo-connection"
import { listTeamMembers } from "@/lib/services/team"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { getOrgBilling } from "@/lib/services/orgs"
import { getOrgAccessState } from "@/lib/services/access"
import { getComplianceRules } from "@/lib/services/compliance"
import { getCurrentUserAction } from "@/app/actions/user"

interface SettingsPageProps {
  searchParams: Promise<{
    tab?: string
  }>
}

export default async function SettingsPage({ searchParams }: SettingsPageProps) {
  const [currentUser, permissionResult, accessState, resolvedSearchParams] = await Promise.all([
    getCurrentUserAction(),
    getCurrentUserPermissions(),
    getOrgAccessState().catch(() => ({ status: "unknown", locked: false })),
    searchParams,
  ])
  const isLocked = accessState.locked

  const [qboConnection, teamMembers] = isLocked
    ? [null, []]
    : await Promise.all([getQBOConnection(), listTeamMembers()])
  const initialTab = typeof resolvedSearchParams?.tab === "string" ? resolvedSearchParams.tab : undefined
  const permissions = permissionResult?.permissions ?? []
  const canManageMembers = permissions.includes("members.manage")
  const canEditRoles = permissions.includes("org.admin")
  const canManageBilling = permissions.includes("billing.manage")
  const billing = canManageBilling ? await getOrgBilling().catch(() => null) : null
  const complianceRules = isLocked ? {
    require_w9: true,
    require_insurance: true,
    require_license: false,
    require_lien_waiver: false,
    block_payment_on_missing_docs: true,
  } : await getComplianceRules().catch(() => ({
    require_w9: true,
    require_insurance: true,
    require_license: false,
    require_lien_waiver: false,
    block_payment_on_missing_docs: true,
  }))
  const canManageCompliance = permissions.includes("org.admin")

  return (
    <PageLayout title="Settings">
      <SettingsWindow
        user={currentUser}
        initialTab={initialTab}
        initialQboConnection={qboConnection}
        teamMembers={teamMembers}
        canManageMembers={canManageMembers}
        canEditRoles={canEditRoles}
        initialBilling={billing}
        canManageBilling={canManageBilling}
        initialComplianceRules={complianceRules}
        canManageCompliance={canManageCompliance}
      />
    </PageLayout>
  )
}
