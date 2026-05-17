import { Suspense } from "react"
import { Skeleton } from "@/components/ui/skeleton"
export const dynamic = 'force-dynamic'
import { SettingsWindow } from "@/components/settings/settings-window"
import { getQBOConnection } from "@/lib/services/qbo-connection"
import { getStripeConnectedAccount } from "@/lib/services/stripe-connected-accounts"
import { TEAM_PERMISSION_OPTIONS, listAssignableOrgRoles, listTeamMembers } from "@/lib/services/team"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { getOrgBilling } from "@/lib/services/orgs"
import { getOrgAccessState } from "@/lib/services/access"
import { getComplianceRules, getDefaultComplianceRequirements } from "@/lib/services/compliance"
import { getCurrentUserAction } from "@/app/actions/user"

interface SettingsPageProps {
  searchParams: Promise<{
    tab?: string
  }>
}

async function SettingsData({ searchParams }: SettingsPageProps) {
  const [currentUser, permissionResult, accessState, resolvedSearchParams] = await Promise.all([
    getCurrentUserAction(),
    getCurrentUserPermissions(),
    getOrgAccessState().catch(() => ({ status: "unknown", locked: false })),
    searchParams,
  ])
  const isLocked = accessState.locked
  const initialTab = typeof resolvedSearchParams?.tab === "string" ? resolvedSearchParams.tab : undefined

  const [qboConnection, stripeConnection, teamMembers, roleOptions, permissionOptions] = isLocked
    ? [null, null, initialTab === "team" ? [] : undefined, initialTab === "team" ? [] : undefined, initialTab === "team" ? [] : undefined]
    : await Promise.all([
        getQBOConnection(),
        getStripeConnectedAccount(),
        initialTab === "team" ? listTeamMembers(undefined, { includeProjectCounts: false }) : Promise.resolve(undefined),
        initialTab === "team" ? listAssignableOrgRoles().catch(() => []) : Promise.resolve(undefined),
        initialTab === "team" ? Promise.resolve(TEAM_PERMISSION_OPTIONS) : Promise.resolve(undefined),
      ])
  const permissions = permissionResult?.permissions ?? []
  const canManageMembers = permissions.includes("members.manage")
  const canEditRoles = permissions.includes("org.admin")
  const canManageBilling = permissions.includes("billing.manage")
  const billing = canManageBilling ? await getOrgBilling().catch(() => null) : null
  const complianceRules = isLocked ? {
    require_lien_waiver: false,
    block_payment_on_missing_docs: true,
  } : await getComplianceRules().catch(() => ({
    require_lien_waiver: false,
    block_payment_on_missing_docs: true,
  }))
  const canManageCompliance =
    permissions.includes("org.admin") ||
    permissions.includes("billing.manage") ||
    permissions.includes("org.member")
  const complianceRequirementDefaults = isLocked
    ? []
    : await getDefaultComplianceRequirements().catch(() => [])

  return (
    <SettingsWindow
      user={currentUser}
      initialTab={initialTab}
      initialQboConnection={qboConnection}
      initialStripeConnection={stripeConnection}
      teamMembers={teamMembers}
      roleOptions={roleOptions}
      permissionOptions={permissionOptions}
      canManageMembers={canManageMembers}
      canEditRoles={canEditRoles}
      initialBilling={billing}
      canManageBilling={canManageBilling}
      initialComplianceRules={complianceRules}
      canManageCompliance={canManageCompliance}
      initialComplianceRequirementDefaults={complianceRequirementDefaults}
    />
  )
}

export default function SettingsPage({ searchParams }: SettingsPageProps) {
  return (
    <div className="-m-4 -mt-6 flex h-full min-h-0 overflow-hidden">
      <Suspense fallback={<div className="p-6 space-y-4"><Skeleton className="h-8 w-48 mb-6" /><div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => (<Skeleton key={i} className="h-16 w-full rounded-md" />))}</div></div>}>
        <SettingsData searchParams={searchParams} />
      </Suspense>
    </div>
  )
}
