"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { ScrollArea } from "@/components/ui/scroll-area"
import { NotificationPreferences } from "@/components/settings/notification-preferences"
import { ComplianceSettings } from "@/components/settings/compliance-settings"
import { OrganizationPanel } from "@/components/settings/organization-panel"
import { IntegrationsPanel } from "@/components/integrations/integrations-panel"
import { Bell, Building2, CreditCard, FileSpreadsheet, KeyRound, Link2, Receipt, ShieldCheck, User as UserIcon, Users, Wallet } from "@/components/icons"
import { ExternalAccessPanel } from "@/components/sharing/external-access-directory"
import { getTeamSettingsDataAction } from "@/app/(app)/settings/actions"
import { useIsMobile } from "@/hooks/use-mobile"
import type { StripeConnectedAccount } from "@/lib/services/stripe-connected-accounts"
import type { ComplianceDocumentType, ComplianceRequirementTemplateItem, ComplianceRules, OrgRoleOption, PermissionOption, TeamMember, User } from "@/lib/types"
import { TeamRoster } from "@/components/team/team-roster"
import type { DivisionDTO } from "@/lib/services/divisions"
import type { DocumentNumberingSettings } from "@/lib/document-number"
import { ProfilePanel } from "@/components/settings/profile-panel"
import { BillingPanel } from "@/components/settings/billing-panel"
import { PaymentRailPanel } from "@/components/settings/payment-rail-panel"
import { InvoicingPanel } from "@/components/settings/invoicing-panel"
import { AccountingSettingsPanel } from "@/components/settings/accounting-settings-panel"
import type { getBooksModuleSettings } from "@/lib/services/books/module"
import type { PaymentRailSettings } from "@/lib/services/payment-rail-setup"
import { cn } from "@/lib/utils"

const sections = [
  {
    value: "profile",
    label: "Profile",
    description: "Name, email, avatar",
    icon: UserIcon,
  },
  {
    value: "organization",
    label: "Organization",
    description: "Company details",
    icon: Building2,
  },
  {
    value: "invoicing",
    label: "Invoicing",
    description: "Client invoice defaults",
    icon: Receipt,
  },
  {
    value: "billing",
    label: "Billing",
    description: "Subscription details",
    icon: CreditCard,
  },
  {
    value: "accounting",
    label: "Accounting",
    description: "Books and ledger strategy",
    icon: FileSpreadsheet,
  },
  {
    value: "payments",
    label: "Vendor payments",
    description: "ACH funding and approvals",
    icon: Wallet,
  },
  {
    value: "notifications",
    label: "Notifications",
    description: "How you get updates",
    icon: Bell,
  },
  {
    value: "integrations",
    label: "Integrations",
    description: "Connect your tools",
    icon: Link2,
  },
  {
    value: "team",
    label: "Team",
    description: "Manage internal members",
    icon: Users,
  },
  {
    value: "compliance",
    label: "Vendor compliance",
    description: "Requirements and payment rules",
    icon: ShieldCheck,
  },
  {
    value: "external-access",
    label: "External access",
    description: "Clients, subs and reviewers",
    icon: KeyRound,
  },
]

function toRoleLabel(roleKey: string) {
  return roleKey
    .replace(/^org_/, "")
    .split("_")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ")
}

interface SettingsWindowProps {
  user: User | null
  initialTab?: string
  initialStripeConnection?: StripeConnectedAccount | null
  initialDocumentNumbering?: DocumentNumberingSettings | null
  teamMembers?: TeamMember[]
  roleOptions?: OrgRoleOption[]
  permissionOptions?: PermissionOption[]
  initialRolePermissions?: Record<string, string[]>
  divisions?: DivisionDTO[]
  canManageMembers?: boolean
  canEditRoles?: boolean
  canManageBilling?: boolean
  initialComplianceRules?: ComplianceRules
  canManageCompliance?: boolean
  initialComplianceRequirementDefaults?: ComplianceRequirementTemplateItem[]
  complianceDocumentTypes?: ComplianceDocumentType[]
  initialPaymentRailSettings?: PaymentRailSettings | null
  stripePublishableKey?: string | null
  initialBooksSettings: Awaited<ReturnType<typeof getBooksModuleSettings>>
  canManageAccounting?: boolean
  canManageExternalAccess?: boolean
}

function getInitials(user: User | null) {
  if (!user?.full_name) return "?"
  return user.full_name
    .split(" ")
    .map((name) => name[0])
    .join("")
    .slice(0, 3)
    .toUpperCase()
}

export function SettingsWindow({
  user,
  initialTab = "profile",
  initialStripeConnection = null,
  initialDocumentNumbering = null,
  teamMembers: initialTeamMembers,
  roleOptions: initialRoleOptions,
  permissionOptions: initialPermissionOptions,
  initialRolePermissions,
  divisions = [],
  canManageMembers: initialCanManageMembers,
  canEditRoles: initialCanEditRoles,
  canManageBilling = true,
  initialComplianceRules = {
    require_lien_waiver: false,
    block_payment_on_missing_docs: true,
    warn_subcontract_execution_on_missing_docs: true,
    block_subcontract_execution_on_missing_docs: false,
  },
  initialComplianceRequirementDefaults = [],
  complianceDocumentTypes = [],
  canManageCompliance = false,
  initialPaymentRailSettings = null,
  stripePublishableKey = null,
  initialBooksSettings,
  canManageAccounting = false,
  canManageExternalAccess = false,
}: SettingsWindowProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const settingsReturnTo = searchParams.get("returnTo")
  // External access reads every project's share records, so it is hidden from
  // anyone the service would refuse anyway rather than shown as a tab that errors.
  const visibleSections = useMemo(
    () => sections.filter((section) => section.value !== "external-access" || canManageExternalAccess),
    [canManageExternalAccess],
  )
  const defaultTab = visibleSections.some((section) => section.value === initialTab) ? initialTab : "profile"
  const [tab, setTab] = useState<string>(defaultTab)
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>(initialTeamMembers ?? [])
  const [roleOptions, setRoleOptions] = useState<OrgRoleOption[]>(initialRoleOptions ?? [])
  const [permissionOptions, setPermissionOptions] = useState<PermissionOption[]>(initialPermissionOptions ?? [])
  const [canManageMembers, setCanManageMembers] = useState<boolean>(initialCanManageMembers ?? false)
  const [canEditRoles, setCanEditRoles] = useState<boolean>(initialCanEditRoles ?? false)
  const [rolePermissions, setRolePermissions] = useState<Record<string, string[]>>(initialRolePermissions ?? {})
  const [teamDivisions, setTeamDivisions] = useState<DivisionDTO[]>(divisions ?? [])
  const [teamLocked, setTeamLocked] = useState<boolean>(false)
  const [hasFetchedTeam, setHasFetchedTeam] = useState<boolean>(initialTeamMembers !== undefined || initialRoleOptions !== undefined || initialPermissionOptions !== undefined)
  const [loadingTeam, setLoadingTeam] = useState(false)
  const [teamError, setTeamError] = useState<string | null>(null)
  const initials = useMemo(() => getInitials(user), [user])
  const currentMemberRole = teamMembers.find((member) => member.user.id === user?.id)?.role
  const userRoleLabel = currentMemberRole ? (teamMembers.find((member) => member.user.id === user?.id)?.role_label ?? "").replace(/^org[\s_-]+/i, "").trim() || (roleOptions.find((option) => option.key === currentMemberRole)?.label ?? "").replace(/^org[\s_-]+/i, "").trim() || toRoleLabel(currentMemberRole) : null
  const isMobile = useIsMobile()

  useEffect(() => {
    const nextTab = visibleSections.some((section) => section.value === initialTab) ? initialTab : "profile"
    setTab(nextTab)
  }, [initialTab, visibleSections])

  useEffect(() => {
    if (initialTeamMembers !== undefined) {
      setTeamMembers(initialTeamMembers)
    }
    if (initialRoleOptions !== undefined) {
      setRoleOptions(initialRoleOptions)
    }
    if (initialCanManageMembers !== undefined) {
      setCanManageMembers(initialCanManageMembers)
    }
    if (initialCanEditRoles !== undefined) {
      setCanEditRoles(initialCanEditRoles)
    }
    if (initialTeamMembers !== undefined || initialRoleOptions !== undefined || initialPermissionOptions !== undefined) {
      setHasFetchedTeam(true)
    }
  }, [initialTeamMembers, initialRoleOptions, initialPermissionOptions, initialCanManageMembers, initialCanEditRoles])

  const loadTeam = useCallback(
    (forceRefresh = false) => {
      if ((hasFetchedTeam && !forceRefresh) || loadingTeam) return
      let isMounted = true
      setLoadingTeam(true)
      setTeamError(null)
      Promise.resolve(getTeamSettingsDataAction())
        .then((data) => {
          if (!isMounted) return
          setTeamMembers(data?.teamMembers ?? [])
          setRoleOptions(data?.roleOptions ?? [])
          setPermissionOptions(data?.permissionOptions ?? [])
          setRolePermissions(data?.rolePermissions ?? {})
          setTeamDivisions(data?.divisions ?? [])
          setTeamLocked(Boolean(data?.locked))
          setCanManageMembers(Boolean(data?.canManageMembers))
          setCanEditRoles(Boolean(data?.canEditRoles))
          setHasFetchedTeam(true)
        })
        .catch((error) => {
          console.error("Failed to load team settings", error)
          if (!isMounted) return
          setTeamError("Unable to load team members.")
          setHasFetchedTeam(true)
        })
        .finally(() => {
          if (isMounted) setLoadingTeam(false)
        })
      return () => {
        isMounted = false
      }
    },
    [hasFetchedTeam, loadingTeam],
  )

  const refreshTeam = () => {
    loadTeam(true)
  }

  // The active panel (currently Invoicing) publishes unsaved-edit state on
  // window.__arcSettingsDirty; the sidebar reads the same flag before navigating.
  const confirmDiscardOrganizationChanges = useCallback(() => {
    if (typeof window === "undefined") return true
    const dirty = Boolean((window as typeof window & { __arcSettingsDirty?: boolean }).__arcSettingsDirty)
    if (!dirty) return true
    return window.confirm("Discard unsaved settings changes?")
  }, [])

  const handleTabChange = (nextTab: string) => {
    if (nextTab !== tab && !confirmDiscardOrganizationChanges()) return
    setTab(nextTab)
    const nextParams = new URLSearchParams()
    nextParams.set("tab", nextTab)
    if (settingsReturnTo) nextParams.set("returnTo", settingsReturnTo)
    router.replace(`/settings?${nextParams.toString()}`, { scroll: false })
    if (nextTab === "team" || nextTab === "organization") {
      loadTeam()
    }
  }

  useEffect(() => {
    if (currentMemberRole || loadingTeam) return
    loadTeam()
  }, [currentMemberRole, loadingTeam, loadTeam])

  useEffect(() => {
    if (tab !== "organization") return
    loadTeam()
  }, [tab, loadTeam])

  const containerHeight = "flex h-full min-h-0 w-full"
  const activeSection = visibleSections.find((section) => section.value === tab) ?? visibleSections[0]

  return (
    <Tabs value={tab} onValueChange={handleTabChange} className="h-full min-h-0 gap-0">
      <div className={cn(containerHeight, "relative min-h-0 overflow-hidden bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85")}>
        <div className="pointer-events-none absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-primary/[0.07] to-transparent" />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-border bg-background/95 px-2 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80">
            <div className="flex h-10 items-center gap-3 px-2 lg:px-4">
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-sm font-medium text-foreground">{activeSection.label}</h1>
              </div>
            </div>

            {isMobile ? (
              <div className="flex items-center gap-2 overflow-hidden px-2 pb-2">
                <button type="button" onClick={() => handleTabChange("profile")} className={cn("flex shrink-0 items-center justify-center rounded-full border transition-all", tab === "profile" ? "border-primary/30 bg-primary/10 ring-2 ring-primary/20" : "border-border/70 bg-background/70")}>
                  <Avatar className="h-9 w-9">
                    <AvatarImage src={user?.avatar_url || "/placeholder.svg"} alt={user?.full_name} />
                    <AvatarFallback className="text-xs font-semibold">{initials}</AvatarFallback>
                  </Avatar>
                </button>
                <TabsList className="h-auto flex-1 justify-start gap-2 overflow-x-auto bg-transparent p-0 pb-1 no-scrollbar">
                  {visibleSections
                    .filter((section) => section.value !== "profile")
                    .map((section) => (
                      <TabsTrigger key={section.value} value={section.value} className="h-9 shrink-0 gap-2 border border-border/70 bg-background/70 px-3 text-xs font-medium data-[state=active]:border-primary/30 data-[state=active]:bg-primary/5 data-[state=active]:text-primary">
                        <section.icon className="h-3.5 w-3.5" />
                        {section.label}
                      </TabsTrigger>
                    ))}
                </TabsList>
              </div>
            ) : null}
          </div>

          <ScrollArea className={cn("min-h-0", tab === "team" || tab === "invoicing" ? "hidden" : "flex-1")} viewportClassName="min-h-0">
            <TabsContent value="billing" className="m-0 mt-0 outline-none focus-visible:outline-none">
              <BillingPanel canManageBilling={canManageBilling} />
            </TabsContent>

            <TabsContent value="payments" className="m-0 mt-0 outline-none focus-visible:outline-none">
              <PaymentRailPanel initialSettings={initialPaymentRailSettings} publishableKey={stripePublishableKey} />
            </TabsContent>

            <div className="w-full">
              <TabsContent value="profile" className="m-0 mt-0 outline-none focus-visible:outline-none">
                <ProfilePanel user={user} roleLabel={userRoleLabel} roleLoading={loadingTeam && !userRoleLabel} />
              </TabsContent>

              <TabsContent value="organization" className="m-0 mt-0 outline-none focus-visible:outline-none">
                <OrganizationPanel
                  initialDocumentNumbering={initialDocumentNumbering}
                  teamMembers={teamMembers}
                  teamLoading={loadingTeam}
                />
              </TabsContent>

              <TabsContent value="notifications" className="m-0 mt-0 outline-none focus-visible:outline-none">
                <NotificationPreferences />
              </TabsContent>

              <TabsContent value="integrations" className="m-0 mt-0 outline-none focus-visible:outline-none">
                <IntegrationsPanel initialStripe={initialStripeConnection} />
              </TabsContent>

              <TabsContent value="accounting" className="m-0 mt-0 outline-none focus-visible:outline-none">
                <AccountingSettingsPanel initialSettings={initialBooksSettings} canManage={canManageAccounting} />
              </TabsContent>

              <TabsContent value="compliance" className="m-0 mt-0 outline-none focus-visible:outline-none">
                <ComplianceSettings
                  initialRules={initialComplianceRules}
                  initialRequirementDefaults={initialComplianceRequirementDefaults}
                  documentTypes={complianceDocumentTypes}
                  canManage={canManageCompliance}
                />
              </TabsContent>

              <TabsContent value="external-access" className="m-0 mt-0 outline-none focus-visible:outline-none">
                <ExternalAccessPanel />
              </TabsContent>

            </div>
          </ScrollArea>

          {/* Invoicing is a full-bleed two-pane layout (controls + edge-to-edge invoice
              preview), so like Team it owns its height outside the shared ScrollArea. */}
          <TabsContent value="invoicing" className="m-0 flex min-h-0 flex-1 flex-col overflow-hidden outline-none focus-visible:outline-none">
            <InvoicingPanel />
          </TabsContent>

          {/* Team owns its own scroll container (sticky header + footer), so it
              lives outside the shared ScrollArea, which collapses when hidden. */}
          <TabsContent value="team" className="m-0 flex min-h-0 flex-1 flex-col overflow-hidden outline-none focus-visible:outline-none">
            <TeamRoster
              members={teamMembers}
              onMembersChange={setTeamMembers}
              roleOptions={roleOptions}
              permissionOptions={permissionOptions}
              rolePermissions={rolePermissions}
              divisions={teamDivisions}
              currentUserId={user?.id ?? null}
              canManageMembers={canManageMembers}
              canEditRoles={canEditRoles}
              canManageBilling={canManageBilling}
              locked={teamLocked}
              loading={loadingTeam}
              error={teamError}
              onReload={refreshTeam}
              onGoToBilling={() => handleTabChange("billing")}
            />
          </TabsContent>
        </div>
      </div>
    </Tabs>
  )
}
