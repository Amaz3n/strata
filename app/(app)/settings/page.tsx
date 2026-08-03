import { Suspense } from "react"
import { Skeleton } from "@/components/ui/skeleton"
export const dynamic = 'force-dynamic'
import { PageLayout } from "@/components/layout/page-layout"
import { SettingsWindow } from "@/components/settings/settings-window"
import { getStripeConnectedAccount } from "@/lib/services/stripe-connected-accounts"
import { TEAM_PERMISSION_OPTIONS, listAssignableOrgRoles, listOrgRolePermissions, listTeamMembers } from "@/lib/services/team"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { getOrgAccessState } from "@/lib/services/access"
import { getComplianceRules, getDefaultComplianceRequirements } from "@/lib/services/compliance"
import { listComplianceDocumentTypes } from "@/lib/services/compliance-documents"
import { getCurrentUserAction } from "@/app/actions/user"
import { listDivisions } from "@/lib/services/divisions"
import { getDocumentNumbering } from "@/lib/services/document-numbering"
import { getPaymentRailSettings } from "@/lib/services/payment-rail-setup"
import { getBooksModuleSettings } from "@/lib/services/books/module"
import type { ComplianceRules } from "@/lib/types"

const DEFAULT_COMPLIANCE_RULES: ComplianceRules = {
  require_lien_waiver: false,
  block_payment_on_missing_docs: true,
  warn_subcontract_execution_on_missing_docs: true,
  block_subcontract_execution_on_missing_docs: false,
}

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

  const [stripeConnection, teamMembers, roleOptions, permissionOptions, divisions, rolePermissions] = isLocked
    ? [null, initialTab === "team" ? [] : undefined, initialTab === "team" ? [] : undefined, initialTab === "team" ? [] : undefined, initialTab === "team" ? [] : undefined, initialTab === "team" ? {} : undefined]
    : await Promise.all([
        getStripeConnectedAccount(),
        initialTab === "team" ? listTeamMembers(undefined, { includeProjectCounts: false }) : Promise.resolve(undefined),
        initialTab === "team" ? listAssignableOrgRoles().catch(() => []) : Promise.resolve(undefined),
        initialTab === "team" ? Promise.resolve(TEAM_PERMISSION_OPTIONS) : Promise.resolve(undefined),
        initialTab === "team" ? listDivisions().catch(() => []) : Promise.resolve(undefined),
        initialTab === "team" ? listOrgRolePermissions().catch(() => ({})) : Promise.resolve(undefined),
      ])
  const permissions = permissionResult?.permissions ?? []
  const canManageMembers = permissions.includes("members.manage")
  const canEditRoles = permissions.includes("org.admin")
  const canManageBilling = permissions.includes("billing.manage")
  const canManageCompliance =
    permissions.includes("org.admin") ||
    permissions.includes("billing.manage")
  const canManageAccounting = permissions.includes("org.admin") || permissions.includes("*")
  // Mirrors the service: listOrgExternalAccess requires project.manage.
  const canManageExternalAccess =
    permissions.includes("project.manage") ||
    permissions.includes("org.admin") ||
    permissions.includes("*")

  const [complianceRules, complianceRequirementDefaults, complianceDocumentTypes, documentNumbering, paymentRailSettings, booksSettings] = isLocked
    ? [DEFAULT_COMPLIANCE_RULES, [], [], null, null, { enabled: false, settings: null, canDisable: true, connections: [] }]
    : await Promise.all([
        getComplianceRules().catch(() => DEFAULT_COMPLIANCE_RULES),
        getDefaultComplianceRequirements().catch(() => []),
        listComplianceDocumentTypes().catch(() => []),
        getDocumentNumbering().catch(() => null),
        getPaymentRailSettings().catch(() => null),
        getBooksModuleSettings({ includeConnections: canManageAccounting }),
      ])

  return (
    <SettingsWindow
      initialDocumentNumbering={documentNumbering}
      user={currentUser}
      initialTab={initialTab}
      initialStripeConnection={stripeConnection}
      teamMembers={teamMembers}
      roleOptions={roleOptions}
      permissionOptions={permissionOptions}
      initialRolePermissions={rolePermissions}
      divisions={divisions}
      canManageMembers={canManageMembers}
      canEditRoles={canEditRoles}
      canManageBilling={canManageBilling}
      initialComplianceRules={complianceRules}
      canManageCompliance={canManageCompliance}
      initialComplianceRequirementDefaults={complianceRequirementDefaults}
      complianceDocumentTypes={complianceDocumentTypes}
      initialPaymentRailSettings={paymentRailSettings}
      stripePublishableKey={process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? null}
      initialBooksSettings={booksSettings}
      canManageAccounting={canManageAccounting}
      canManageExternalAccess={canManageExternalAccess}
    />
  )
}

export default function SettingsPage({ searchParams }: SettingsPageProps) {
  return (
    <PageLayout fullBleed>
      <div className="flex h-full min-h-0 overflow-hidden">
        <Suspense fallback={<div className="p-6 space-y-4"><Skeleton className="h-8 w-48 mb-6" /><div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => (<Skeleton key={i} className="h-16 w-full rounded-md" />))}</div></div>}>
          <SettingsData searchParams={searchParams} />
        </Suspense>
      </div>
    </PageLayout>
  )
}
