"use client"

import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { NotificationPreferences } from "@/components/settings/notification-preferences"
import { AppearanceSettings } from "@/components/settings/appearance-settings"
import { ComplianceSettings } from "@/components/settings/compliance-settings"
import { ContractTemplateSettings } from "@/components/settings/contract-template-settings"
import { CostCodeManager } from "@/components/cost-codes/cost-code-manager"
import { AccountingConnectionsPanel } from "@/components/integrations/accounting-connections-panel"
import { StripeConnectionCard } from "@/components/integrations/stripe-connection-card"
import { Spinner } from "@/components/ui/spinner"
import { AlertTriangle, ArrowRight, Bell, Building2, Check, Clock, CreditCard, Link2, Receipt, Settings, Shield, SlidersHorizontal, Sparkles, Tag, User as UserIcon, Users, Zap } from "@/components/icons"
import { Info } from "lucide-react"
import { getQBOConnectionAction, getStripeConnectedAccountAction } from "@/app/(app)/settings/integrations/actions"
import { listCostCodesAction } from "@/app/(app)/settings/cost-codes/actions"
import { createBillingPortalSessionAction, createCheckoutSessionAction, getBillingPageDataAction, getOrganizationSettingsAction, getTeamSettingsDataAction, updateOrganizationLogoAction, updateOrganizationSettingsAction, updateUserAvatarAction } from "@/app/(app)/settings/actions"
import { useIsMobile } from "@/hooks/use-mobile"
import type { QBOConnection } from "@/lib/services/accounting-connections"
import type { StripeConnectedAccount } from "@/lib/services/stripe-connected-accounts"
import type { ComplianceRequirementTemplateItem, ComplianceRules, CostCode, OrgRoleOption, PermissionOption, TeamMember, User } from "@/lib/types"
import { TeamTable } from "@/components/team/team-table"
import { MemberFormPanel } from "@/components/team/member-form-panel"
import type { DivisionDTO } from "@/lib/services/divisions"
import { MfaSettingsCard } from "@/components/settings/mfa-settings-card"
import { SessionsSettingsCard } from "@/components/settings/sessions-settings-card"
import Link from "next/link"
import packageJson from "@/package.json"
import { cn } from "@/lib/utils"

import { unwrapAction } from "@/lib/action-result"

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
    value: "notifications",
    label: "Notifications",
    description: "How you get updates",
    icon: Bell,
  },
  {
    value: "appearance",
    label: "Appearance",
    description: "Theme and UI size",
    icon: SlidersHorizontal,
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
    value: "cost-codes",
    label: "Cost Codes",
    description: "Manage financial coding",
    icon: Tag,
  },
  {
    value: "compliance",
    label: "Vendor Compliance",
    description: "Requirements and payment rules",
    icon: Settings,
  },
  {
    value: "about",
    label: "About",
    description: "About this workspace",
    icon: Info,
  },
]

function toRoleLabel(roleKey: string) {
  return roleKey
    .replace(/^org_/, "")
    .split("_")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ")
}

const appInfo = {
  name: "Arc",
  company: "Arc Project Systems LLC",
  version: packageJson.version ?? "0.1.0",
  termsUrl: "/terms",
  privacyUrl: "/privacy",
  logoUrl: "/arc-logo2.svg",
}

function formatBillingStatus(status: string) {
  return status
    .split("_")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ")
}

function CostCodeTableSkeleton() {
  return (
    <div className="flex h-full min-h-[calc(100svh-7rem)] flex-col overflow-hidden border-t border-border/70 bg-background">
      <div className="sticky top-0 z-20 flex shrink-0 flex-col gap-3 border-b bg-background px-4 py-3 sm:min-h-14 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
          <Skeleton className="h-9 w-full md:w-80" />
          <Skeleton className="h-9 w-full sm:w-40" />
        </div>
        <div className="flex shrink-0">
          <Skeleton className="h-9 w-full sm:w-32" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="grid grid-cols-[136px_minmax(280px,1fr)_150px_132px_112px_108px_92px] border-b bg-muted/40 px-4 py-3">
          {Array.from({ length: 7 }).map((_, index) => (
            <Skeleton key={index} className="h-4 w-16" />
          ))}
        </div>
        {Array.from({ length: 10 }).map((_, index) => (
          <div key={index} className="grid h-16 grid-cols-[136px_minmax(280px,1fr)_150px_132px_112px_108px_92px] items-center border-b px-4">
            <Skeleton className="h-4 w-20" />
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-56" />
              <Skeleton className="h-3 w-28" />
            </div>
            <Skeleton className="mx-auto hidden h-4 w-20 md:block" />
            <Skeleton className="mx-auto hidden h-5 w-16 lg:block" />
            <Skeleton className="mx-auto hidden h-4 w-14 lg:block" />
            <Skeleton className="mx-auto hidden h-5 w-14 xl:block" />
            <Skeleton className="ml-auto h-7 w-7" />
          </div>
        ))}
      </div>
      <div className="sticky bottom-0 z-20 flex shrink-0 flex-col gap-3 border-t bg-background px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <Skeleton className="h-4 w-44" />
        <div className="flex items-center justify-end gap-2">
          <Skeleton className="h-9 w-20" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-9 w-16" />
        </div>
      </div>
    </div>
  )
}

const tabPanelClass = "overflow-hidden rounded-xl border border-border/80 bg-background/75 shadow-sm"
const tabPanelHeaderClass = "flex min-h-14 flex-col justify-center gap-1 border-b border-border/70 px-4 py-3 sm:flex-row sm:items-center sm:justify-between lg:px-6"
const tabPanelBodyClass = "space-y-6 px-5 py-5 lg:px-6 lg:py-6"

type BillingDetails = {
  org?: {
    name?: string | null
    billing_model?: string | null
  } | null
  subscription?: {
    plan_code?: string | null
    status?: string | null
    current_period_end?: string | null
    external_customer_id?: string | null
    external_subscription_id?: string | null
    trial_ends_at?: string | null
  } | null
  plan?: {
    name?: string | null
    pricing_model?: string | null
    interval?: string | null
    amount_cents?: number | null
    currency?: string | null
  } | null
} | null

type BillingPlan = {
  code: string
  name: string
  pricingModel: string
  interval: string | null
  amountCents: number | null
  currency: string | null
}

type OrganizationSettingsData = {
  id: string
  name: string
  billingEmail: string
  address: string
  addressLine1: string
  addressLine2: string
  city: string
  state: string
  postalCode: string
  country: string
  defaultPaymentTermsDays: number
  defaultInvoiceNote: string
  proposalTermsTemplate: string
  estimateTermsTemplate: string
  estimateAccentColor: string
  estimateFont: string
  estimateIntroTemplate: string
  estimateBuilderSignerMode: "estimate_creator" | "prospect_owner" | "specific_user"
  estimateBuilderSignerUserId: string
  logoUrl: string | null
  canManageOrganization: boolean
}

interface SettingsWindowProps {
  user: User | null
  initialTab?: string
  initialQboConnection?: QBOConnection | null
  initialStripeConnection?: StripeConnectedAccount | null
  teamMembers?: TeamMember[]
  roleOptions?: OrgRoleOption[]
  permissionOptions?: PermissionOption[]
  divisions?: DivisionDTO[]
  canManageMembers?: boolean
  canEditRoles?: boolean
  initialBilling?: BillingDetails
  canManageBilling?: boolean
  initialComplianceRules?: ComplianceRules
  canManageCompliance?: boolean
  initialComplianceRequirementDefaults?: ComplianceRequirementTemplateItem[]
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
  initialQboConnection = null,
  initialStripeConnection = null,
  teamMembers: initialTeamMembers,
  roleOptions: initialRoleOptions,
  permissionOptions: initialPermissionOptions,
  divisions = [],
  canManageMembers: initialCanManageMembers,
  canEditRoles: initialCanEditRoles,
  initialBilling = null,
  canManageBilling = true,
  initialComplianceRules = {
    require_lien_waiver: false,
    block_payment_on_missing_docs: true,
    warn_subcontract_execution_on_missing_docs: true,
    block_subcontract_execution_on_missing_docs: false,
  },
  initialComplianceRequirementDefaults = [],
  canManageCompliance = false,
}: SettingsWindowProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const settingsReturnTo = searchParams.get("returnTo")
  const defaultTab = sections.some((section) => section.value === initialTab) ? initialTab : "profile"
  const [tab, setTab] = useState<string>(defaultTab)
  const [, setQboConnection] = useState<QBOConnection | null>(initialQboConnection)
  const [stripeConnection, setStripeConnection] = useState<StripeConnectedAccount | null>(initialStripeConnection)
  const [hasFetchedIntegrations, setHasFetchedIntegrations] = useState<boolean>(Boolean(initialQboConnection) || Boolean(initialStripeConnection))
  const [loadingIntegrations, setLoadingIntegrations] = useState(false)
  const [billing, setBilling] = useState<BillingDetails>(initialBilling)
  const [hasFetchedBilling, setHasFetchedBilling] = useState<boolean>(Boolean(initialBilling))
  const [loadingBilling, setLoadingBilling] = useState(false)
  const [billingError, setBillingError] = useState<string | null>(null)
  const [plans, setPlans] = useState<BillingPlan[]>([])
  const [hasFetchedPlans, setHasFetchedPlans] = useState(false)
  const [loadingPlans, setLoadingPlans] = useState(false)
  const [selectedPlanCode, setSelectedPlanCode] = useState<string | null>(null)
  const [checkoutLoading, setCheckoutLoading] = useState(false)
  const [portalLoading, setPortalLoading] = useState(false)
  const [billingActionError, setBillingActionError] = useState<string | null>(null)
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>(initialTeamMembers ?? [])
  const [roleOptions, setRoleOptions] = useState<OrgRoleOption[]>(initialRoleOptions ?? [])
  const [permissionOptions, setPermissionOptions] = useState<PermissionOption[]>(initialPermissionOptions ?? [])
  const [canManageMembers, setCanManageMembers] = useState<boolean>(initialCanManageMembers ?? false)
  const [canEditRoles, setCanEditRoles] = useState<boolean>(initialCanEditRoles ?? false)
  const [hasFetchedTeam, setHasFetchedTeam] = useState<boolean>(initialTeamMembers !== undefined || initialRoleOptions !== undefined || initialPermissionOptions !== undefined)
  const [loadingTeam, setLoadingTeam] = useState(false)
  const [teamError, setTeamError] = useState<string | null>(null)
  const [teamView, setTeamView] = useState<{ mode: "list" } | { mode: "invite" } | { mode: "edit"; member: TeamMember }>({ mode: "list" })
  const isTeamFormOpen = teamView.mode !== "list"
  const [lastTeamFormView, setLastTeamFormView] = useState<{ mode: "invite" } | { mode: "edit"; member: TeamMember }>({ mode: "invite" })
  useEffect(() => {
    if (teamView.mode !== "list") setLastTeamFormView(teamView)
  }, [teamView])
  const [teamFilter, setTeamFilter] = useState<"active" | "archived">("active")
  const teamActiveCount = useMemo(() => teamMembers.filter((m) => m.status !== "suspended").length, [teamMembers])
  const teamArchivedCount = useMemo(() => teamMembers.filter((m) => m.status === "suspended").length, [teamMembers])
  const [costCodes, setCostCodes] = useState<CostCode[]>([])
  const [hasFetchedCostCodes, setHasFetchedCostCodes] = useState(false)
  const [loadingCostCodes, setLoadingCostCodes] = useState(false)
  const [costCodesError, setCostCodesError] = useState<string | null>(null)
  const [organizationSettings, setOrganizationSettings] = useState<OrganizationSettingsData | null>(null)
  const [organizationForm, setOrganizationForm] = useState({
    name: "",
    billingEmail: "",
    addressLine1: "",
    addressLine2: "",
    city: "",
    state: "",
    postalCode: "",
    country: "",
    defaultPaymentTermsDays: 15,
    defaultInvoiceNote: "",
    proposalTermsTemplate: "",
    estimateTermsTemplate: "",
    estimateAccentColor: "",
    estimateFont: "",
    estimateIntroTemplate: "",
    estimateBuilderSignerMode: "estimate_creator" as "estimate_creator" | "prospect_owner" | "specific_user",
    estimateBuilderSignerUserId: "",
  })
  const [organizationDirty, setOrganizationDirty] = useState(false)
  const [hasFetchedOrganization, setHasFetchedOrganization] = useState(false)
  const [loadingOrganization, setLoadingOrganization] = useState(false)
  const [organizationError, setOrganizationError] = useState<string | null>(null)
  const [organizationNotice, setOrganizationNotice] = useState<string | null>(null)
  const [isSavingOrganization, startOrganizationSave] = useTransition()
  const [isUpdatingLogo, startLogoUpdate] = useTransition()
  const [isUpdatingProfilePhoto, startProfilePhotoUpdate] = useTransition()
  const logoInputRef = useRef<HTMLInputElement | null>(null)
  const profilePhotoInputRef = useRef<HTMLInputElement | null>(null)
  const [profilePhotoPreviewUrl, setProfilePhotoPreviewUrl] = useState<string | null>(null)
  const [profilePhotoUrl, setProfilePhotoUrl] = useState<string | null>(user?.avatar_url ?? null)
  const [profileError, setProfileError] = useState<string | null>(null)
  const initials = useMemo(() => getInitials(user), [user])
  const currentMemberRole = teamMembers.find((member) => member.user.id === user?.id)?.role
  const userRoleLabel = currentMemberRole ? (teamMembers.find((member) => member.user.id === user?.id)?.role_label ?? "").replace(/^org[\s_-]+/i, "").trim() || (roleOptions.find((option) => option.key === currentMemberRole)?.label ?? "").replace(/^org[\s_-]+/i, "").trim() || toRoleLabel(currentMemberRole) : null
  const isMobile = useIsMobile()

  const applyOrganizationSettings = useCallback((data: OrganizationSettingsData) => {
    setOrganizationSettings(data)
    setOrganizationForm({
      name: data.name ?? "",
      billingEmail: data.billingEmail ?? "",
      addressLine1: data.addressLine1 ?? "",
      addressLine2: data.addressLine2 ?? "",
      city: data.city ?? "",
      state: data.state ?? "",
      postalCode: data.postalCode ?? "",
      country: data.country ?? "",
      defaultPaymentTermsDays: data.defaultPaymentTermsDays ?? 15,
      defaultInvoiceNote: data.defaultInvoiceNote ?? "",
      proposalTermsTemplate: data.proposalTermsTemplate ?? "",
      estimateTermsTemplate: data.estimateTermsTemplate ?? "",
      estimateAccentColor: data.estimateAccentColor ?? "",
      estimateFont: data.estimateFont ?? "",
      estimateIntroTemplate: data.estimateIntroTemplate ?? "",
      estimateBuilderSignerMode: data.estimateBuilderSignerMode ?? "estimate_creator",
      estimateBuilderSignerUserId: data.estimateBuilderSignerUserId ?? "",
    })
    setOrganizationDirty(false)
  }, [])

  useEffect(() => {
    const nextTab = sections.some((section) => section.value === initialTab) ? initialTab : "profile"
    setTab(nextTab)
  }, [initialTab])

  useEffect(() => {
    setProfilePhotoUrl(user?.avatar_url ?? null)
  }, [user?.avatar_url])

  useEffect(() => {
    setQboConnection(initialQboConnection ?? null)
    setStripeConnection(initialStripeConnection ?? null)
    setHasFetchedIntegrations(Boolean(initialQboConnection) || Boolean(initialStripeConnection))
  }, [initialQboConnection, initialStripeConnection])

  useEffect(() => {
    setBilling(initialBilling ?? null)
    setHasFetchedBilling(Boolean(initialBilling))
    setBillingError(null)
  }, [initialBilling])

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

  useEffect(() => {
    return () => {
      if (profilePhotoPreviewUrl) {
        URL.revokeObjectURL(profilePhotoPreviewUrl)
      }
    }
  }, [profilePhotoPreviewUrl])

  useEffect(() => {
    if (hasFetchedOrganization) return

    let isMounted = true
    setLoadingOrganization(true)
    setOrganizationError(null)
    setOrganizationNotice(null)

    getOrganizationSettingsAction()
      .then((data) => {
        if (!isMounted) return
        applyOrganizationSettings(data)
        setHasFetchedOrganization(true)
      })
      .catch((error) => {
        console.error("Failed to load organization settings", error)
        if (!isMounted) return
        setOrganizationError("Unable to load organization settings.")
        setHasFetchedOrganization(true)
      })
      .finally(() => {
        if (isMounted) setLoadingOrganization(false)
      })

    return () => {
      isMounted = false
    }
  }, [applyOrganizationSettings, hasFetchedOrganization])

  useEffect(() => {
    if (hasFetchedIntegrations) return

    let isMounted = true
    setLoadingIntegrations(true)
    Promise.all([getQBOConnectionAction(), getStripeConnectedAccountAction()])
      .then(([qbo, stripe]) => {
        if (!isMounted) return
        setQboConnection(qbo)
        setStripeConnection(stripe)
        setHasFetchedIntegrations(true)
      })
      .catch((error) => {
        console.error("Failed to load integrations", error)
        setHasFetchedIntegrations(true)
      })
      .finally(() => {
        if (isMounted) setLoadingIntegrations(false)
      })

    return () => {
      isMounted = false
    }
  }, [hasFetchedIntegrations])

  useEffect(() => {
    if (!canManageBilling) {
      setHasFetchedBilling(true)
      setHasFetchedPlans(true)
      setLoadingBilling(false)
      setLoadingPlans(false)
      return
    }

    if (hasFetchedBilling && hasFetchedPlans) return

    let isMounted = true
    setLoadingBilling(true)
    setLoadingPlans(true)
    getBillingPageDataAction()
      .then((data) => {
        if (!isMounted) return
        setBilling(data?.billing ?? null)
        setPlans(data?.plans ?? [])
        setHasFetchedBilling(true)
        setHasFetchedPlans(true)
        setBillingError(null)
      })
      .catch((error) => {
        console.error("Failed to load billing page data", error)
        if (!isMounted) return
        setBillingError("Unable to load billing details right now.")
        setHasFetchedBilling(true)
        setHasFetchedPlans(true)
      })
      .finally(() => {
        if (isMounted) {
          setLoadingBilling(false)
          setLoadingPlans(false)
        }
      })

    return () => {
      isMounted = false
    }
  }, [hasFetchedBilling, hasFetchedPlans, canManageBilling])

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

  const loadCostCodes = useCallback(
    (forceRefresh = false) => {
      if ((hasFetchedCostCodes && !forceRefresh) || loadingCostCodes) return
      let isMounted = true
      setLoadingCostCodes(true)
      setCostCodesError(null)
      Promise.resolve(listCostCodesAction(true))
        .then((rows) => {
          if (!isMounted) return
          setCostCodes(rows ?? [])
          setHasFetchedCostCodes(true)
        })
        .catch((error) => {
          console.error("Failed to load cost codes", error)
          if (!isMounted) return
          setCostCodesError("Unable to load cost codes.")
          setHasFetchedCostCodes(true)
        })
        .finally(() => {
          if (isMounted) setLoadingCostCodes(false)
        })
      return () => {
        isMounted = false
      }
    },
    [hasFetchedCostCodes, loadingCostCodes],
  )

  const refreshTeam = () => {
    loadTeam(true)
  }

  const confirmDiscardOrganizationChanges = useCallback(() => {
    if (!organizationDirty) return true
    return window.confirm("Discard unsaved settings changes?")
  }, [organizationDirty])

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
    if (nextTab === "cost-codes") {
      loadCostCodes()
    }
  }

  useEffect(() => {
    if (currentMemberRole || loadingTeam) return
    loadTeam()
  }, [currentMemberRole, loadingTeam, loadTeam])

  useEffect(() => {
    if (!organizationDirty) return
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", handleBeforeUnload)
    return () => window.removeEventListener("beforeunload", handleBeforeUnload)
  }, [organizationDirty])

  useEffect(() => {
    ;(window as typeof window & { __arcSettingsDirty?: boolean }).__arcSettingsDirty = organizationDirty
    return () => {
      delete (window as typeof window & { __arcSettingsDirty?: boolean }).__arcSettingsDirty
    }
  }, [organizationDirty])

  useEffect(() => {
    if (tab !== "organization") return
    loadTeam()
  }, [tab, loadTeam])

  useEffect(() => {
    if (tab !== "cost-codes") return
    loadCostCodes()
  }, [tab, loadCostCodes])

  const containerHeight = "flex h-full min-h-0 w-full"
  const activeSection = sections.find((section) => section.value === tab) ?? sections[0]

  const planName = billing?.plan?.name ?? billing?.subscription?.plan_code ?? billing?.org?.billing_model ?? "Custom"
  const billingStatus = billing?.subscription?.status ?? "active"
  const interval = billing?.plan?.interval ?? "monthly"
  const trialEndsAt = billing?.subscription?.trial_ends_at
  const isActive = billingStatus === "active"
  const isTrialing = billingStatus === "trialing"
  const isPastDue = billingStatus === "past_due"
  const hasStripeCustomer = Boolean(billing?.subscription?.external_customer_id)
  const needsSubscription = !isActive
  const formattedTrialEnd = trialEndsAt
    ? new Date(trialEndsAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "Not set"

  const trialEndDate = trialEndsAt ? new Date(trialEndsAt) : null
  const msPerDay = 1000 * 60 * 60 * 24
  const daysUntilTrialEnd = trialEndDate ? Math.max(0, Math.ceil((trialEndDate.getTime() - Date.now()) / msPerDay)) : null

  const planAmountDisplay = billing?.plan?.amount_cents != null ? `$${(billing.plan.amount_cents / 100).toFixed(0)}` : "Custom"
  const planIntervalSuffix = billing?.plan?.amount_cents != null && interval ? `/${interval === "monthly" ? "mo" : interval === "yearly" ? "yr" : interval}` : ""
  const planCodeStr = (billing?.subscription?.plan_code ?? billing?.org?.billing_model ?? "").toLowerCase()
  const PlanTierIcon = planCodeStr.includes("business") || planCodeStr.includes("enterprise") ? Building2 : planCodeStr.includes("pro") ? Zap : Sparkles

  useEffect(() => {
    if (!selectedPlanCode && plans.length > 0) {
      const defaultCode = billing?.subscription?.plan_code ?? plans[0]?.code
      if (defaultCode) setSelectedPlanCode(defaultCode)
    }
  }, [plans, selectedPlanCode, billing?.subscription?.plan_code])

  const handleSubscribe = async () => {
    if (!selectedPlanCode) return
    setCheckoutLoading(true)
    setBillingActionError(null)
    try {
      const { url } = unwrapAction(await createCheckoutSessionAction(selectedPlanCode))
      if (url) {
        window.location.href = url
      } else {
        setBillingActionError("Unable to start checkout. Please try again.")
      }
    } catch (error: any) {
      console.error("Checkout error", error)
      setBillingActionError(error?.message ?? "Unable to start checkout.")
    } finally {
      setCheckoutLoading(false)
    }
  }

  const handleManageBilling = async () => {
    setPortalLoading(true)
    setBillingActionError(null)
    try {
      const { url } = unwrapAction(await createBillingPortalSessionAction())
      if (url) {
        window.location.href = url
      } else {
        setBillingActionError("Unable to open billing portal.")
      }
    } catch (error: any) {
      console.error("Billing portal error", error)
      setBillingActionError(error?.message ?? "Unable to open billing portal.")
    } finally {
      setPortalLoading(false)
    }
  }

  const handleOrganizationFieldChange = (field: "name" | "billingEmail" | "addressLine1" | "addressLine2" | "city" | "state" | "postalCode" | "country" | "defaultPaymentTermsDays" | "defaultInvoiceNote" | "proposalTermsTemplate" | "estimateTermsTemplate" | "estimateAccentColor" | "estimateFont" | "estimateIntroTemplate" | "estimateBuilderSignerMode" | "estimateBuilderSignerUserId", value: string | number) => {
    setOrganizationForm((prev) => ({ ...prev, [field]: value }))
    setOrganizationDirty(true)
    setOrganizationNotice(null)
    setOrganizationError(null)
  }

  const handleOrganizationSave = (section: "organization" | "invoicing") => {
    if (!organizationSettings?.canManageOrganization || isSavingOrganization) return

    setOrganizationNotice(null)
    setOrganizationError(null)

    startOrganizationSave(async () => {
      const result = unwrapAction(await updateOrganizationSettingsAction({
        section,
        name: organizationForm.name,
        billingEmail: organizationForm.billingEmail,
        addressLine1: organizationForm.addressLine1,
        addressLine2: organizationForm.addressLine2,
        city: organizationForm.city,
        state: organizationForm.state,
        postalCode: organizationForm.postalCode,
        country: organizationForm.country,
        defaultPaymentTermsDays: Number(organizationForm.defaultPaymentTermsDays ?? 15),
        defaultInvoiceNote: organizationForm.defaultInvoiceNote,
        proposalTermsTemplate: organizationForm.proposalTermsTemplate,
        estimateTermsTemplate: organizationForm.estimateTermsTemplate,
        estimateAccentColor: organizationForm.estimateAccentColor,
        estimateFont: organizationForm.estimateFont,
        estimateIntroTemplate: organizationForm.estimateIntroTemplate,
        estimateBuilderSignerMode: organizationForm.estimateBuilderSignerMode,
        estimateBuilderSignerUserId: organizationForm.estimateBuilderSignerUserId || null,
      }))

      if (result?.error) {
        setOrganizationError(result.error)
        toast.error("Unable to save settings", { description: result.error })
        return
      }

      try {
        const refreshed = await getOrganizationSettingsAction()
        applyOrganizationSettings(refreshed)
      } catch (error) {
        console.error("Failed to refresh organization settings", error)
        setOrganizationDirty(false)
      }
      setOrganizationNotice(null)
      toast.success(section === "invoicing" ? "Invoicing settings saved" : "Organization settings saved")
    })
  }

  const handleLogoFileSelection = (file: File | null) => {
    if (!file || !organizationSettings?.canManageOrganization || isUpdatingLogo) return

    setOrganizationNotice(null)
    setOrganizationError(null)

    startLogoUpdate(async () => {
      const payload = new FormData()
      payload.set("logo", file)
      const result = unwrapAction(await updateOrganizationLogoAction(payload))

      if (result?.error) {
        setOrganizationError(result.error)
        toast.error("Unable to upload logo", { description: result.error })
        return
      }

      setOrganizationSettings((prev) => (prev ? { ...prev, logoUrl: result.logoUrl ?? null } : prev))
      setOrganizationNotice(null)
      toast.success("Organization logo updated")
      if (logoInputRef.current) {
        logoInputRef.current.value = ""
      }
    })
  }

  const handleLogoRemove = () => {
    if (!organizationSettings?.canManageOrganization || isUpdatingLogo) return

    setOrganizationNotice(null)
    setOrganizationError(null)

    startLogoUpdate(async () => {
      const payload = new FormData()
      payload.set("remove", "true")
      const result = unwrapAction(await updateOrganizationLogoAction(payload))

      if (result?.error) {
        setOrganizationError(result.error)
        toast.error("Unable to remove logo", { description: result.error })
        return
      }

      setOrganizationSettings((prev) => (prev ? { ...prev, logoUrl: null } : prev))
      setOrganizationNotice(null)
      toast.success("Organization logo removed")
      if (logoInputRef.current) {
        logoInputRef.current.value = ""
      }
    })
  }

  const handleProfilePhotoSelection = (file: File | null) => {
    if (!file) return

    const supportedTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"])
    if (!supportedTypes.has(file.type)) {
      setProfileError("Use PNG, JPG, WEBP, or SVG.")
      toast.error("Unable to upload profile photo", { description: "Use PNG, JPG, WEBP, or SVG." })
      return
    }

    if (file.size > 5 * 1024 * 1024) {
      setProfileError("Profile photo must be 5MB or smaller.")
      toast.error("Unable to upload profile photo", { description: "Profile photo must be 5MB or smaller." })
      return
    }

    if (profilePhotoPreviewUrl) {
      URL.revokeObjectURL(profilePhotoPreviewUrl)
    }

    const nextPreviewUrl = URL.createObjectURL(file)
    setProfilePhotoPreviewUrl(nextPreviewUrl)
    setProfileError(null)

    startProfilePhotoUpdate(async () => {
      const payload = new FormData()
      payload.set("avatar", file)
      const result = unwrapAction(await updateUserAvatarAction(payload))

      if (result?.error) {
        setProfileError(result.error)
        setProfilePhotoPreviewUrl(null)
        URL.revokeObjectURL(nextPreviewUrl)
        toast.error("Unable to upload profile photo", { description: result.error })
        return
      }

      setProfilePhotoUrl(result.avatarUrl ?? null)
      setProfilePhotoPreviewUrl(null)
      URL.revokeObjectURL(nextPreviewUrl)
      toast.success("Profile photo updated")
      if (profilePhotoInputRef.current) {
        profilePhotoInputRef.current.value = ""
      }
    })
  }

  const handleProfilePhotoRemove = () => {
    if (profilePhotoPreviewUrl) {
      URL.revokeObjectURL(profilePhotoPreviewUrl)
    }
    setProfilePhotoPreviewUrl(null)
    setProfileError(null)
    if (profilePhotoInputRef.current) {
      profilePhotoInputRef.current.value = ""
    }
  }

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
              {tab === "team" && (
                <div className="flex shrink-0 items-center gap-2">
                  <Select value={teamFilter} onValueChange={(next) => setTeamFilter(next as "active" | "archived")}>
                    <SelectTrigger size="sm" className="h-8 w-[150px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">Active ({teamActiveCount})</SelectItem>
                      <SelectItem value="archived">Archived ({teamArchivedCount})</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button disabled={!canManageMembers} onClick={() => setTeamView({ mode: "invite" })} size="sm" className="h-8">
                    <Users className="mr-1.5 h-3.5 w-3.5" />
                    Invite member
                  </Button>
                </div>
              )}
              {tab === "billing" && canManageBilling && hasStripeCustomer && (
                <Button onClick={handleManageBilling} disabled={portalLoading} size="sm" className="gap-2">
                  {portalLoading ? "Opening..." : "Manage billing"}
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              )}
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
                  {sections
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

          <ScrollArea className="min-h-0 flex-1" viewportClassName="min-h-0">
            <TabsContent value="billing" className="m-0 mt-0 outline-none focus-visible:outline-none">
              {!canManageBilling ? (
                <div className="flex flex-col items-center justify-center px-6 py-24 text-center">
                  <Shield className="h-10 w-10 text-muted-foreground/40" />
                  <p className="mt-4 max-w-sm text-sm text-muted-foreground">You do not have permission to view billing for this organization.</p>
                </div>
              ) : loadingBilling ? (
                <div className="flex h-64 items-center justify-center gap-3 text-muted-foreground">
                  <Spinner className="h-4 w-4" />
                  <span className="text-sm">Loading billing details…</span>
                </div>
              ) : billingError ? (
                <div className="px-6 py-12 text-center text-sm text-destructive">{billingError}</div>
              ) : (
                <div className="flex flex-col">
                  <div className="border-b border-border/70">
                    <div className="flex flex-col gap-5 px-5 py-6 sm:flex-row sm:items-center sm:justify-between lg:px-8">
                      <div className="flex min-w-0 items-start gap-4">
                        <div className="flex size-12 shrink-0 items-center justify-center border border-border/70 bg-background text-muted-foreground">
                          <PlanTierIcon className="h-5 w-5" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Current plan</p>
                          <h2 className="mt-1 truncate text-2xl font-semibold leading-tight">{planName}</h2>
                        </div>
                      </div>
                      <div className="shrink-0 sm:text-right">
                        <div className="flex items-baseline gap-1 sm:justify-end">
                          <span className="text-3xl font-semibold tabular-nums text-foreground">{planAmountDisplay}</span>
                          {planIntervalSuffix && <span className="text-sm font-medium text-muted-foreground">{planIntervalSuffix}</span>}
                        </div>
                        <div className="mt-2 flex justify-start sm:justify-end">
                          <Badge variant="outline" className={cn("border-border bg-muted/20 text-muted-foreground", isActive && "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400")}>
                            {formatBillingStatus(billingStatus)}
                          </Badge>
                        </div>
                      </div>
                    </div>

                  </div>

                  {/* Inline alerts */}
                  {(isTrialing || isPastDue || billingActionError) && (
                    <div className="space-y-2 border-b border-border/70 px-5 py-4 lg:px-8">
                      {isTrialing && trialEndDate && (
                        <div className="flex items-start gap-3 border border-primary/25 bg-primary/[0.04] px-4 py-3 text-sm">
                          <Clock className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                          <div className="flex-1">
                            <p className="font-medium text-foreground">{daysUntilTrialEnd === 0 ? "Your trial ends today." : `Your trial ends in ${daysUntilTrialEnd} day${daysUntilTrialEnd === 1 ? "" : "s"}.`}</p>
                            <p className="text-muted-foreground">Add a payment method to keep your workspace active after {formattedTrialEnd}.</p>
                          </div>
                        </div>
                      )}
                      {isPastDue && (
                        <div className="flex items-start gap-3 border border-destructive/30 bg-destructive/[0.05] px-4 py-3 text-sm">
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                          <div className="flex-1">
                            <p className="font-medium text-foreground">Payment past due</p>
                            <p className="text-muted-foreground">Update your billing details to restore full access to your workspace.</p>
                          </div>
                          <Button size="sm" variant="outline" onClick={handleManageBilling} disabled={portalLoading}>
                            Update payment
                          </Button>
                        </div>
                      )}
                      {billingActionError && <div className="border border-destructive/30 bg-destructive/[0.05] px-4 py-3 text-sm text-destructive">{billingActionError}</div>}
                    </div>
                  )}

                  {/* Plan picker (only when needed) */}
                  {needsSubscription && (
                    <div className={cn(tabPanelClass, "mx-5 my-8 lg:mx-8 lg:my-10")}>
                      <div className={tabPanelHeaderClass}>
                        <div>
                          <h3 className="text-base font-semibold text-foreground">Choose your plan</h3>
                          <p className="mt-1 text-sm text-muted-foreground">{isTrialing ? "Pick a plan to keep your workspace active after the trial." : "Activate your workspace by selecting a plan."}</p>
                        </div>
                      </div>
                      <div className={tabPanelBodyClass}>
                        {loadingPlans ? (
                          <div className="flex items-center gap-3 text-muted-foreground">
                            <Spinner className="h-4 w-4" />
                            <span className="text-sm">Loading plans…</span>
                          </div>
                        ) : plans.length === 0 ? (
                          <div className="border border-border/70 bg-muted/20 px-4 py-6 text-sm text-muted-foreground">No active plans are available.</div>
                        ) : (
                          <>
                            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                              {plans.map((plan) => {
                                const code = plan.code.toLowerCase()
                                const isSelected = selectedPlanCode === plan.code
                                const TierIcon = code.includes("business") || code.includes("enterprise") ? Building2 : code.includes("pro") ? Zap : Sparkles
                                const planAmount = plan.amountCents != null ? `$${(plan.amountCents / 100).toFixed(0)}` : "Custom"
                                const planSuffix = plan.amountCents != null && plan.interval ? `/${plan.interval === "monthly" ? "mo" : plan.interval === "yearly" ? "yr" : plan.interval}` : ""
                                return (
                                  <button key={plan.code} type="button" onClick={() => setSelectedPlanCode(plan.code)} className={cn("group relative overflow-hidden border px-5 py-6 text-left transition-all", isSelected ? "border-primary bg-primary/[0.04] shadow-[0_0_0_1px_var(--primary)]" : "border-border/70 bg-background/60 hover:border-primary/40 hover:bg-background")}>
                                    <div className="flex size-10 items-center justify-center border border-border/70 bg-background text-muted-foreground transition-colors group-hover:border-primary/40 group-hover:text-primary">
                                      <TierIcon className="h-4 w-4" />
                                    </div>
                                    <p className="mt-5 text-base font-semibold text-foreground">{plan.name}</p>
                                    <div className="mt-2 flex items-baseline gap-1">
                                      <span className="text-3xl font-semibold tabular-nums text-foreground">{planAmount}</span>
                                      {planSuffix && <span className="text-sm text-muted-foreground">{planSuffix}</span>}
                                    </div>
                                    <div className={cn("mt-5 flex items-center gap-2 text-sm font-medium transition-colors", isSelected ? "text-primary" : "text-muted-foreground group-hover:text-foreground")}>
                                      {isSelected ? (
                                        <>
                                          <Check className="h-4 w-4" /> Selected
                                        </>
                                      ) : (
                                        <>
                                          Select plan
                                          <ArrowRight className="h-3.5 w-3.5" />
                                        </>
                                      )}
                                    </div>
                                  </button>
                                )
                              })}
                            </div>
                            <div className="mt-8 flex flex-wrap items-center gap-3">
                              <Button onClick={handleSubscribe} disabled={!selectedPlanCode || checkoutLoading} size="lg" className="gap-2">
                                {checkoutLoading ? "Redirecting…" : `Continue with ${plans.find((p) => p.code === selectedPlanCode)?.name ?? "selected plan"}`}
                                <ArrowRight className="h-4 w-4" />
                              </Button>
                              <p className="text-xs text-muted-foreground">Secure checkout powered by Stripe.</p>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  )}

                </div>
              )}
            </TabsContent>

            <div className="w-full">
              <TabsContent value="profile" className="m-0 mt-0 px-5 py-8 lg:px-8 lg:py-10">
                <div className="mx-auto max-w-6xl space-y-7">
                  <div className="rounded-xl border border-border/80 bg-background/75 p-5 shadow-sm lg:p-6">
                    <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
                      <div className="flex items-center gap-4">
                        <Avatar className="h-20 w-20 border border-border/80">
                          <AvatarImage src={profilePhotoPreviewUrl ?? profilePhotoUrl ?? undefined} alt={user?.full_name} />
                          <AvatarFallback className="text-xl font-semibold">{initials}</AvatarFallback>
                        </Avatar>
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <p className="text-base font-semibold">{user?.full_name ?? "Your profile"}</p>
                            {userRoleLabel && (
                              <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-medium uppercase tracking-wider">
                                {userRoleLabel}
                              </Badge>
                            )}
                          </div>
                          <p className="text-sm text-muted-foreground">{user?.email ?? "—"}</p>
                          <div className="flex items-center gap-2 pt-2">
                            <input ref={profilePhotoInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="hidden" onChange={(event) => handleProfilePhotoSelection(event.target.files?.[0] ?? null)} disabled={isUpdatingProfilePhoto} />
                            <Button type="button" variant="outline" size="sm" onClick={() => profilePhotoInputRef.current?.click()} disabled={isUpdatingProfilePhoto}>
                              {isUpdatingProfilePhoto ? "Uploading..." : "Change photo"}
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                    {profileError && <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{profileError}</div>}
                  </div>

                  <MfaSettingsCard />
                  <SessionsSettingsCard />
                </div>
              </TabsContent>

              <TabsContent value="organization" className="m-0 mt-0 px-5 py-8 lg:px-8 lg:py-10">
                <div className="space-y-8">
                  {loadingOrganization ? (
                    <div className="flex items-center gap-3 text-muted-foreground p-6">
                      <Spinner className="h-4 w-4" />
                      <span className="text-sm">Loading organization settings...</span>
                    </div>
                  ) : (
                    <div className="space-y-8">
                      <div className="flex flex-col gap-4 border-b border-border/70 pb-6 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex items-center gap-4">
                          <Avatar className="h-14 w-14 rounded-lg border">
                            <AvatarImage src={organizationSettings?.logoUrl ?? undefined} alt="Organization logo" className="object-cover" />
                            <AvatarFallback className="rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                              <Building2 className="h-6 w-6" />
                            </AvatarFallback>
                          </Avatar>
                          <div>
                            <p className="text-sm font-semibold">Organization logo</p>
                            <p className="text-xs text-muted-foreground">Used in the org switcher and customer-facing headers.</p>
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <input ref={logoInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="hidden" onChange={(event) => handleLogoFileSelection(event.target.files?.[0] ?? null)} disabled={!organizationSettings?.canManageOrganization || isUpdatingLogo} />
                          <Button type="button" variant="outline" size="sm" onClick={() => logoInputRef.current?.click()} disabled={!organizationSettings?.canManageOrganization || isUpdatingLogo}>
                            {isUpdatingLogo ? "Uploading..." : "Upload logo"}
                          </Button>
                          <Button type="button" variant="ghost" size="sm" onClick={handleLogoRemove} disabled={!organizationSettings?.canManageOrganization || isUpdatingLogo || !organizationSettings?.logoUrl}>
                            Remove
                          </Button>
                        </div>
                      </div>
                      {!organizationSettings?.canManageOrganization && <p className="-mt-2 text-xs text-muted-foreground px-1">Only organization admins can update branding.</p>}

                      <div className="grid gap-6 lg:grid-cols-2">
                        <div className="space-y-3">
                          <Label htmlFor="company" className="text-sm font-medium">
                            Company name
                          </Label>
                          <Input id="company" value={organizationForm.name} onChange={(event) => handleOrganizationFieldChange("name", event.target.value)} placeholder="Company name" className="h-11" disabled={!organizationSettings?.canManageOrganization} />
                        </div>
                      </div>

                      <div className="space-y-5 border-t border-border/70 pt-6">
                        <div>
                          <p className="text-sm font-semibold">Estimate &amp; proposal templates</p>
                          <p className="text-xs text-muted-foreground">Default terms applied to client-facing estimates and proposals. Per-document terms always take precedence.</p>
                        </div>
                        <div className="space-y-3">
                          <Label htmlFor="estimate-terms-template" className="text-sm font-medium">
                            Default estimate terms
                          </Label>
                          <p className="-mt-1 text-xs text-muted-foreground">Shown on the estimate PDF when no per-estimate terms are entered.</p>
                          <Textarea id="estimate-terms-template" value={organizationForm.estimateTermsTemplate} onChange={(event) => handleOrganizationFieldChange("estimateTermsTemplate", event.target.value)} placeholder={"Estimate valid for 30 days. Pricing subject to final measurements and selections."} className="min-h-[96px]" disabled={!organizationSettings?.canManageOrganization} />
                        </div>
                        <div className="space-y-3">
                          <Label htmlFor="proposal-terms-template" className="text-sm font-medium">
                            Default proposal terms
                          </Label>
                          <p className="-mt-1 text-xs text-muted-foreground">Templated terms &amp; conditions added to the proposal PDF above the signature block.</p>
                          <Textarea id="proposal-terms-template" value={organizationForm.proposalTermsTemplate} onChange={(event) => handleOrganizationFieldChange("proposalTermsTemplate", event.target.value)} placeholder={"Payment schedule, scope of work, warranty, and change-order terms…"} className="min-h-[120px]" disabled={!organizationSettings?.canManageOrganization} />
                        </div>
                      </div>

                      <ContractTemplateSettings canManage={Boolean(organizationSettings?.canManageOrganization)} />

                      <div className="flex items-center justify-between gap-4 border-t border-border/70 pt-6">
                        <div><p className="text-sm font-semibold">Document numbering</p><p className="text-xs text-muted-foreground">Prefixes and zero-padding for RFIs, submittals, change orders, meetings, and transmittals.</p></div>
                        <Button variant="outline" asChild><a href="/settings/document-numbering">Configure</a></Button>
                      </div>

                      <div className="space-y-5 border-t border-border/70 pt-6">
                        <div>
                          <p className="text-sm font-semibold">Estimate branding</p>
                          <p className="text-xs text-muted-foreground">Applied to client-facing estimates — the review portal and the PDF. Per-estimate overrides always win.</p>
                        </div>
                        <div className="grid gap-5 sm:grid-cols-2">
                          <div className="space-y-2">
                            <Label htmlFor="estimate-accent-color" className="text-sm font-medium">Accent color</Label>
                            <div className="flex items-center gap-2">
                              <input
                                type="color"
                                aria-label="Accent color"
                                value={organizationForm.estimateAccentColor || "#1a1a1a"}
                                onChange={(event) => handleOrganizationFieldChange("estimateAccentColor", event.target.value)}
                                disabled={!organizationSettings?.canManageOrganization}
                                className="h-10 w-12 cursor-pointer rounded border bg-transparent p-1 disabled:opacity-50"
                              />
                              <Input
                                id="estimate-accent-color"
                                value={organizationForm.estimateAccentColor}
                                onChange={(event) => handleOrganizationFieldChange("estimateAccentColor", event.target.value)}
                                placeholder="#2563eb"
                                className="h-10 max-w-[140px] font-mono"
                                disabled={!organizationSettings?.canManageOrganization}
                              />
                              {organizationForm.estimateAccentColor ? (
                                <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => handleOrganizationFieldChange("estimateAccentColor", "")} disabled={!organizationSettings?.canManageOrganization}>
                                  Reset
                                </button>
                              ) : null}
                            </div>
                            <p className="text-xs text-muted-foreground">Used for headers, section titles, and the total.</p>
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="estimate-font" className="text-sm font-medium">Portal font</Label>
                            <Select value={organizationForm.estimateFont || "__default"} onValueChange={(value) => handleOrganizationFieldChange("estimateFont", value === "__default" ? "" : value)} disabled={!organizationSettings?.canManageOrganization}>
                              <SelectTrigger id="estimate-font" className="h-10">
                                <SelectValue placeholder="Default" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__default">Default (system sans)</SelectItem>
                                <SelectItem value="Georgia, 'Times New Roman', serif">Serif (Georgia)</SelectItem>
                                <SelectItem value="'Inter', system-ui, sans-serif">Inter</SelectItem>
                                <SelectItem value="'Courier New', ui-monospace, monospace">Monospace</SelectItem>
                              </SelectContent>
                            </Select>
                            <p className="text-xs text-muted-foreground">Applies to the review portal document.</p>
                          </div>
                        </div>
                        <div className="space-y-3">
                          <Label htmlFor="estimate-intro-template" className="text-sm font-medium">Default cover note</Label>
                          <p className="-mt-1 text-xs text-muted-foreground">A short intro seeded into every new estimate (editable per estimate). Appears above the line items.</p>
                          <Textarea id="estimate-intro-template" value={organizationForm.estimateIntroTemplate} onChange={(event) => handleOrganizationFieldChange("estimateIntroTemplate", event.target.value)} placeholder={"Thanks for the opportunity to bid your project. Below is a detailed breakdown of the scope and pricing…"} className="min-h-[96px]" disabled={!organizationSettings?.canManageOrganization} />
                        </div>
                        <a href="/settings/templates" className="inline-flex items-center text-sm font-medium text-primary hover:underline">
                          Manage estimate templates →
                        </a>
                      </div>

                      <div className="space-y-5 border-t border-border/70 pt-6">
                        <div>
                          <p className="text-sm font-semibold">Estimate execution</p>
                          <p className="text-xs text-muted-foreground">Choose which Arc user receives the builder countersignature request after a client signs an estimate.</p>
                        </div>
                        <div className="grid gap-4 lg:grid-cols-2">
                          <div className="space-y-3">
                            <Label htmlFor="estimate-builder-signer-mode" className="text-sm font-medium">
                              Builder signer routing
                            </Label>
                            <Select
                              value={organizationForm.estimateBuilderSignerMode}
                              onValueChange={(value) => handleOrganizationFieldChange("estimateBuilderSignerMode", value)}
                              disabled={!organizationSettings?.canManageOrganization}
                            >
                              <SelectTrigger id="estimate-builder-signer-mode" className="h-10">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="estimate_creator">Estimate creator</SelectItem>
                                <SelectItem value="prospect_owner">Prospect owner</SelectItem>
                                <SelectItem value="specific_user">Specific Arc user</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          {organizationForm.estimateBuilderSignerMode === "specific_user" ? (
                            <div className="space-y-3">
                              <Label htmlFor="estimate-builder-signer-user" className="text-sm font-medium">
                                Builder signer
                              </Label>
                              <Select
                                value={organizationForm.estimateBuilderSignerUserId || "__none"}
                                onValueChange={(value) => handleOrganizationFieldChange("estimateBuilderSignerUserId", value === "__none" ? "" : value)}
                                disabled={!organizationSettings?.canManageOrganization || loadingTeam}
                              >
                                <SelectTrigger id="estimate-builder-signer-user" className="h-10">
                                  <SelectValue placeholder={loadingTeam ? "Loading team..." : "Select a user"} />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="__none">Select a user</SelectItem>
                                  {teamMembers
                                    .filter((member) => member.status !== "suspended" && member.user?.id && member.user?.email)
                                    .map((member) => (
                                      <SelectItem key={member.user.id} value={member.user.id}>
                                        {member.user.full_name || member.user.email}
                                      </SelectItem>
                                    ))}
                                </SelectContent>
                              </Select>
                            </div>
                          ) : null}
                        </div>
                      </div>

                      <div className="flex justify-start">
                        <Button size="sm" onClick={() => handleOrganizationSave("organization")} disabled={!organizationSettings?.canManageOrganization || isSavingOrganization || loadingOrganization}>
                          {isSavingOrganization ? "Saving..." : "Save changes"}
                        </Button>
                      </div>
                    </div>
                  )}

                  {(organizationError || organizationNotice) && <div className={cn("mt-4 rounded-md border px-3 py-2 text-sm", organizationError ? "border-destructive/30 bg-destructive/5 text-destructive" : "border-primary/30 bg-primary/5 text-primary")}>{organizationError ?? organizationNotice}</div>}
                </div>
              </TabsContent>

              <TabsContent value="invoicing" className="m-0 mt-0 px-5 py-8 lg:px-8 lg:py-10">
                <div className="mx-auto max-w-6xl space-y-8">
                  {loadingOrganization ? (
                    <div className="flex items-center gap-3 text-muted-foreground p-6">
                      <Spinner className="h-4 w-4" />
                      <span className="text-sm">Loading invoicing settings...</span>
                    </div>
                  ) : (
                    <>
                      <section className="overflow-hidden border border-border/80 bg-background/75 shadow-sm">
                        <div className="border-b border-border/70 px-4 py-4 lg:px-5">
                          <h2 className="text-sm font-medium text-foreground">Invoice sender</h2>
                          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                            These details appear on client-facing invoices and payment documents.
                          </p>
                        </div>
                        <div className="divide-y divide-border/70">
                          <div className="grid gap-3 px-4 py-4 lg:grid-cols-[220px_1fr] lg:px-5">
                            <Label htmlFor="billing-email" className="pt-2 text-sm font-medium">
                              Invoice email
                            </Label>
                            <Input id="billing-email" type="email" value={organizationForm.billingEmail} onChange={(event) => handleOrganizationFieldChange("billingEmail", event.target.value)} placeholder="billing@company.com" className="h-10" disabled={!organizationSettings?.canManageOrganization} />
                          </div>
                          <div className="grid gap-3 px-4 py-4 lg:grid-cols-[220px_1fr] lg:px-5">
                            <div>
                              <Label htmlFor="address-line-1" className="text-sm font-medium">
                                Remittance address
                              </Label>
                              <p className="mt-1 text-xs leading-5 text-muted-foreground">Used as the business address on invoices.</p>
                            </div>
                            <div className="space-y-3">
                              <div className="grid gap-3 lg:grid-cols-2">
                                <Input id="address-line-1" value={organizationForm.addressLine1} onChange={(event) => handleOrganizationFieldChange("addressLine1", event.target.value)} placeholder="Address line 1" className="h-10" disabled={!organizationSettings?.canManageOrganization} />
                                <Input id="address-line-2" value={organizationForm.addressLine2} onChange={(event) => handleOrganizationFieldChange("addressLine2", event.target.value)} placeholder="Address line 2" className="h-10" disabled={!organizationSettings?.canManageOrganization} />
                              </div>
                              <div className="grid gap-3 lg:grid-cols-[1fr_120px_140px]">
                                <Input id="address-city" value={organizationForm.city} onChange={(event) => handleOrganizationFieldChange("city", event.target.value)} placeholder="City" className="h-10" disabled={!organizationSettings?.canManageOrganization} />
                                <Input id="address-state" value={organizationForm.state} onChange={(event) => handleOrganizationFieldChange("state", event.target.value)} placeholder="State" className="h-10" disabled={!organizationSettings?.canManageOrganization} />
                                <Input id="address-postal" value={organizationForm.postalCode} onChange={(event) => handleOrganizationFieldChange("postalCode", event.target.value)} placeholder="ZIP" className="h-10" disabled={!organizationSettings?.canManageOrganization} />
                              </div>
                              <Input id="address-country" value={organizationForm.country} onChange={(event) => handleOrganizationFieldChange("country", event.target.value)} placeholder="Country" className="h-10" disabled={!organizationSettings?.canManageOrganization} />
                            </div>
                          </div>
                        </div>
                      </section>

                      <section className="overflow-hidden border border-border/80 bg-background/75 shadow-sm">
                        <div className="border-b border-border/70 px-4 py-4 lg:px-5">
                          <h2 className="text-sm font-medium text-foreground">Invoice defaults</h2>
                          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                            Starting values for new client invoices. You can still override them per invoice.
                          </p>
                        </div>
                        <div className="divide-y divide-border/70">
                          <div className="grid gap-3 px-4 py-4 lg:grid-cols-[220px_1fr] lg:px-5">
                            <Label htmlFor="default-net-terms" className="pt-2 text-sm font-medium">
                              Default net terms
                            </Label>
                            <div className="max-w-40">
                              <Input id="default-net-terms" type="number" min={0} max={365} value={organizationForm.defaultPaymentTermsDays} onChange={(event) => handleOrganizationFieldChange("defaultPaymentTermsDays", Number(event.target.value || 0))} className="h-10" disabled={!organizationSettings?.canManageOrganization} />
                            </div>
                          </div>
                          <div className="grid gap-3 px-4 py-4 lg:grid-cols-[220px_1fr] lg:px-5">
                            <div>
                              <Label htmlFor="default-invoice-note" className="text-sm font-medium">
                                Payment details
                              </Label>
                              <p className="mt-1 text-xs leading-5 text-muted-foreground">Bank details, check instructions, or other payment notes.</p>
                            </div>
                            <Textarea id="default-invoice-note" value={organizationForm.defaultInvoiceNote} onChange={(event) => handleOrganizationFieldChange("defaultInvoiceNote", event.target.value)} placeholder={"Bank: Example Bank, IBAN: XXXX 0000 0000 0000 0000\nReference: Invoice number"} className="min-h-[96px]" disabled={!organizationSettings?.canManageOrganization} />
                          </div>
                        </div>
                      </section>

                      <div className="flex justify-start">
                        <Button size="sm" onClick={() => handleOrganizationSave("invoicing")} disabled={!organizationSettings?.canManageOrganization || isSavingOrganization || loadingOrganization}>
                          {isSavingOrganization ? "Saving..." : "Save invoicing settings"}
                        </Button>
                      </div>
                    </>
                  )}

                  {(organizationError || organizationNotice) && <div className={cn("rounded-md border px-3 py-2 text-sm", organizationError ? "border-destructive/30 bg-destructive/5 text-destructive" : "border-primary/30 bg-primary/5 text-primary")}>{organizationError ?? organizationNotice}</div>}
                </div>
              </TabsContent>

              <TabsContent value="notifications" className="m-0 mt-0 px-5 py-8 lg:px-8 lg:py-10">
                <div className="mx-auto flex max-w-6xl justify-center">
                  <NotificationPreferences />
                </div>
              </TabsContent>

              <TabsContent value="appearance" className="m-0 mt-0 px-5 py-8 lg:px-8 lg:py-10">
                <AppearanceSettings />
              </TabsContent>

              <TabsContent value="integrations" className="m-0 mt-0 outline-none focus-visible:outline-none">
                <div className="flex min-h-full flex-col">
                  <div className="flex-1">
                    {loadingIntegrations ? (
                      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
                        <Spinner className="h-8 w-8 mb-4 text-indigo-500/50" />
                        <span className="text-sm font-medium tracking-wide">Syncing integration status...</span>
                      </div>
                    ) : (
                      <div className="w-full">
                        <div className="flex flex-col border-y border-border/70">
                          <StripeConnectionCard connection={stripeConnection} canManage={Boolean(organizationSettings?.canManageOrganization)} onConnectionChange={setStripeConnection} />
                          <div className="h-px bg-border/70" />
                          <AccountingConnectionsPanel />
                        </div>

                      </div>
                    )}
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="team" className="m-0 mt-0 h-full min-h-0 outline-none focus-visible:outline-none">
                <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background">
                  <div className="relative z-10 min-h-0 flex-1 overflow-hidden">
                    <div className="h-full min-w-0 overflow-auto">
                      {loadingTeam ? (
                        <div className="flex items-center gap-3 p-8 text-muted-foreground">
                          <Spinner className="h-4 w-4" />
                          <span className="text-sm">Loading team members...</span>
                        </div>
                      ) : teamError ? (
                        <div className="p-8 text-sm text-destructive">{teamError}</div>
                      ) : (
                        <TeamTable className="h-full" tableWrapperClassName="px-0 py-0 sm:px-0" members={teamMembers} canManageMembers={canManageMembers} canEditRoles={canEditRoles} showProjectCounts={false} showInviteAction={false} hideToolbar view={teamFilter} onViewChange={setTeamFilter} onMemberChange={refreshTeam} onInviteMember={() => setTeamView({ mode: "invite" })} onEditMember={(member) => setTeamView({ mode: "edit", member })} />
                      )}
                    </div>

                    <Sheet
                      open={isTeamFormOpen}
                      onOpenChange={(open) => {
                        if (!open) setTeamView({ mode: "list" })
                      }}
                    >
                      <SheetContent
                        side="right"
                        mobileFullscreen
                        className="sm:max-w-lg sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 fast-sheet-animation"
                        style={{
                          animationDuration: '150ms',
                          transitionDuration: '150ms'
                        } as CSSProperties}
                      >
                        <SheetHeader className="sr-only">
                          <SheetTitle>{lastTeamFormView.mode === "edit" ? "Edit team member" : "Invite team member"}</SheetTitle>
                        </SheetHeader>
                      <MemberFormPanel
                        mode={lastTeamFormView.mode}
                        member={lastTeamFormView.mode === "edit" ? lastTeamFormView.member : undefined}
                        roleOptions={roleOptions}
                        permissionOptions={permissionOptions}
                        divisions={divisions}
                        canManageMembers={canManageMembers}
                        canEditRoles={canEditRoles}
                        onCancel={() => setTeamView({ mode: "list" })}
                        onSuccess={() => {
                          setTeamView({ mode: "list" })
                          refreshTeam()
                        }}
                      />
                      </SheetContent>
                    </Sheet>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="cost-codes" className="m-0 mt-0 h-full min-h-[calc(100svh-7rem)] outline-none focus-visible:outline-none">
                {loadingCostCodes || (!hasFetchedCostCodes && tab === "cost-codes") ? (
                  <CostCodeTableSkeleton />
                ) : costCodesError ? (
                  <div className="px-6 py-12 text-center text-sm text-destructive">{costCodesError}</div>
                ) : (
                  <CostCodeManager costCodes={costCodes} canManage={Boolean(organizationSettings?.canManageOrganization)} onCostCodesChange={setCostCodes} />
                )}
              </TabsContent>

              <TabsContent value="compliance" className="m-0 mt-0 h-full min-h-0 outline-none focus-visible:outline-none">
                <ComplianceSettings initialRules={initialComplianceRules} initialRequirementDefaults={initialComplianceRequirementDefaults} canManage={canManageCompliance} />
              </TabsContent>

              <TabsContent value="about" className="m-0 mt-0 h-full">
                <div className="flex min-h-full flex-col justify-between px-5 py-8 lg:px-8 lg:py-10">
                  <div className="space-y-10">
                    <div className="flex flex-col items-center justify-center space-y-5 text-center">
                      <div className="relative">
                        <div className="absolute -inset-4 rounded-full bg-primary/5 blur-3xl" />
                        <div className="relative flex h-28 w-28 items-center justify-center border border-border/50 bg-white shadow-lg transition-all duration-500 hover:scale-105">
                          <img src={appInfo.logoUrl} alt={`${appInfo.name} logo`} className="h-20 w-20 object-contain" />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <h2 className="text-3xl font-extrabold tracking-tight text-foreground">{appInfo.name}</h2>
                        <p className="text-xs font-semibold tracking-widest uppercase text-muted-foreground/60">Version {appInfo.version}</p>
                      </div>
                    </div>

                    <div className="mx-auto w-full max-w-2xl px-4">
                      <div className="grid gap-px overflow-hidden rounded-xl border border-border/60 bg-border/60 shadow-xl sm:grid-cols-2">
                        <div className="space-y-1.5 bg-background/95 p-5">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80">Workspace</span>
                          <p className="text-lg font-semibold text-foreground">{organizationSettings?.name ?? billing?.org?.name ?? "Workspace"}</p>
                        </div>
                        <div className="space-y-1.5 bg-background/95 p-5">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80">Workspace ID</span>
                          <p className="font-mono text-xs text-foreground/80 break-all">{organizationSettings?.id ?? "—"}</p>
                        </div>
                        <div className="space-y-1.5 bg-background/95 p-5">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80">Account</span>
                          <p className="text-lg font-semibold text-foreground break-all">{user?.email ?? "—"}</p>
                        </div>
                        <div className="space-y-1.5 bg-background/95 p-5">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80">Your Role</span>
                          <p className="text-lg font-semibold text-foreground">{userRoleLabel ?? (loadingTeam ? "Loading..." : "Member")}</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="mt-8 border-t border-border/40 pt-6">
                    <div className="mx-auto flex max-w-2xl flex-col items-center justify-center space-y-4 px-4">
                      <nav className="flex items-center justify-center gap-x-8 text-sm font-semibold">
                        <Link href="https://arcnaples.com" target="_blank" className="text-muted-foreground/80 transition-all hover:text-primary hover:scale-105">
                          Website
                        </Link>
                        <Link href={appInfo.termsUrl} className="text-muted-foreground/80 transition-all hover:text-primary hover:scale-105">
                          Terms
                        </Link>
                        <Link href={appInfo.privacyUrl} className="text-muted-foreground/80 transition-all hover:text-primary hover:scale-105">
                          Privacy
                        </Link>
                      </nav>

                      <p className="text-xs font-medium text-muted-foreground/40 tracking-widest uppercase">
                        &copy; {new Date().getFullYear()} {appInfo.company}. Built for builders.
                      </p>
                    </div>
                  </div>
                </div>
              </TabsContent>
            </div>
          </ScrollArea>
        </div>
      </div>
    </Tabs>
  )
}
