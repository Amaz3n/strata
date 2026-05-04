"use client"

import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react"
import { useSearchParams } from "next/navigation"

import * as TabsPrimitive from "@radix-ui/react-tabs"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { NotificationPreferences } from "@/components/settings/notification-preferences"
import { ComplianceSettings } from "@/components/settings/compliance-settings"
import { CostCodeManager } from "@/components/cost-codes/cost-code-manager"
import { QBOConnectionCard } from "@/components/integrations/qbo-connection-card"
import { StripeConnectionCard } from "@/components/integrations/stripe-connection-card"
import { Spinner } from "@/components/ui/spinner"
import { AlertTriangle, ArrowRight, Bell, Building2, Check, Clock, CreditCard, Link2, Receipt, Settings, Shield, Sparkles, Tag, User as UserIcon, Users, Zap } from "@/components/icons"
import { Info } from "lucide-react"
import { getQBOConnectionAction, getStripeConnectedAccountAction } from "@/app/(app)/settings/integrations/actions"
import { listCostCodesAction } from "@/app/(app)/settings/cost-codes/actions"
import { createBillingPortalSessionAction, createCheckoutSessionAction, getBillingPageDataAction, getOrganizationSettingsAction, getTeamSettingsDataAction, updateOrganizationLogoAction, updateOrganizationSettingsAction } from "@/app/(app)/settings/actions"
import { useIsMobile } from "@/hooks/use-mobile"
import type { QBOConnection } from "@/lib/services/qbo-connection"
import type { StripeConnectedAccount } from "@/lib/services/stripe-connected-accounts"
import type { ComplianceRequirementTemplateItem, ComplianceRules, CostCode, OrgRoleOption, PermissionOption, TeamMember, User } from "@/lib/types"
import { TeamTable } from "@/components/team/team-table"
import { MemberFormPanel } from "@/components/team/member-form-panel"
import { MfaSettingsCard } from "@/components/settings/mfa-settings-card"
import { SessionsSettingsCard } from "@/components/settings/sessions-settings-card"
import Link from "next/link"
import packageJson from "@/package.json"
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
    label: "Payables",
    description: "Payment gating policy",
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
  company: "Arc",
  version: packageJson.version ?? "0.1.0",
  termsUrl: "/terms",
  logoUrl: "/logo.svg",
}

type AiProvider = "openai" | "anthropic" | "google"
type AiConfigSource = "org" | "platform" | "env" | "default"

const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
}

const AI_PROVIDER_DEFAULT_MODELS: Record<AiProvider, string> = {
  openai: "gpt-4.1-mini",
  anthropic: "claude-3-5-sonnet-latest",
  google: "gemini-2.0-flash",
}

const AI_PROVIDER_PRESET_MODELS: Record<AiProvider, string[]> = {
  openai: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"],
  anthropic: ["claude-3-5-sonnet-latest", "claude-3-7-sonnet-latest", "claude-3-5-haiku-latest"],
  google: ["gemini-2.0-flash", "gemini-2.0-pro", "gemini-1.5-pro"],
}

const AI_CONFIG_SOURCE_LABELS: Record<AiConfigSource, string> = {
  org: "Organization override",
  platform: "Arc default",
  env: "Environment default",
  default: "Built-in default",
}

function isAiProvider(value: string): value is AiProvider {
  return value === "openai" || value === "anthropic" || value === "google"
}

const tabPanelClass = "overflow-hidden rounded-xl border border-border/80 bg-background/75 shadow-sm"
const tabPanelHeaderClass = "flex flex-col gap-3 border-b border-border/70 px-5 py-4 sm:flex-row sm:items-center sm:justify-between lg:px-6"
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
  aiProvider: AiProvider
  aiModel: string
  aiConfigSource: AiConfigSource
  logoUrl: string | null
  canManageOrganization: boolean
}

interface SettingsWindowProps {
  user: User | null
  initialTab?: string
  initialQboConnection?: QBOConnection | null
  initialStripeConnection?: StripeConnectedAccount | null
  variant?: "page" | "dialog"
  teamMembers?: TeamMember[]
  roleOptions?: OrgRoleOption[]
  permissionOptions?: PermissionOption[]
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
  variant = "page",
  teamMembers: initialTeamMembers,
  roleOptions: initialRoleOptions,
  permissionOptions: initialPermissionOptions,
  canManageMembers: initialCanManageMembers,
  canEditRoles: initialCanEditRoles,
  initialBilling = null,
  canManageBilling = true,
  initialComplianceRules = {
    require_lien_waiver: false,
    block_payment_on_missing_docs: true,
  },
  initialComplianceRequirementDefaults = [],
  canManageCompliance = false,
}: SettingsWindowProps) {
  const searchParams = useSearchParams()
  const settingsReturnTo = searchParams.get("returnTo")
  const defaultTab = sections.some((section) => section.value === initialTab) ? initialTab : "profile"
  const [tab, setTab] = useState<string>(defaultTab)
  const [qboConnection, setQboConnection] = useState<QBOConnection | null>(initialQboConnection)
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
  const [hasFetchedTeam, setHasFetchedTeam] = useState<boolean>(initialTeamMembers !== undefined || initialRoleOptions !== undefined || initialPermissionOptions !== undefined || initialCanManageMembers !== undefined || initialCanEditRoles !== undefined)
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
    aiProvider: "openai" as AiProvider,
    aiModel: AI_PROVIDER_DEFAULT_MODELS.openai,
  })
  const [organizationAiSource, setOrganizationAiSource] = useState<AiConfigSource>("default")
  const [useInheritedAiDefaults, setUseInheritedAiDefaults] = useState(true)
  const [aiSettingsDirty, setAiSettingsDirty] = useState(false)
  const [hasFetchedOrganization, setHasFetchedOrganization] = useState(false)
  const [loadingOrganization, setLoadingOrganization] = useState(false)
  const [organizationError, setOrganizationError] = useState<string | null>(null)
  const [organizationNotice, setOrganizationNotice] = useState<string | null>(null)
  const [isSavingOrganization, startOrganizationSave] = useTransition()
  const [isUpdatingLogo, startLogoUpdate] = useTransition()
  const logoInputRef = useRef<HTMLInputElement | null>(null)
  const profilePhotoInputRef = useRef<HTMLInputElement | null>(null)
  const [profilePhotoPreviewUrl, setProfilePhotoPreviewUrl] = useState<string | null>(null)
  const [profileNotice, setProfileNotice] = useState<string | null>(null)
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
      aiProvider: data.aiProvider ?? "openai",
      aiModel: data.aiModel ?? AI_PROVIDER_DEFAULT_MODELS[data.aiProvider ?? "openai"],
    })
    setOrganizationAiSource(data.aiConfigSource ?? "default")
    setUseInheritedAiDefaults(data.aiConfigSource !== "org")
    setAiSettingsDirty(false)
  }, [])

  const aiSourceLabel = useMemo(() => {
    if (useInheritedAiDefaults && organizationAiSource === "org") {
      return "Arc default (pending save)"
    }
    return AI_CONFIG_SOURCE_LABELS[organizationAiSource]
  }, [organizationAiSource, useInheritedAiDefaults])

  useEffect(() => {
    const nextTab = sections.some((section) => section.value === initialTab) ? initialTab : "profile"
    setTab(nextTab)
  }, [initialTab])

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
    if (initialTeamMembers !== undefined || initialRoleOptions !== undefined || initialCanManageMembers !== undefined || initialCanEditRoles !== undefined) {
      setHasFetchedTeam(true)
    }
  }, [initialTeamMembers, initialRoleOptions, initialCanManageMembers, initialCanEditRoles])

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

  const handleTabChange = (nextTab: string) => {
    setTab(nextTab)
    if (variant === "page") {
      const nextParams = new URLSearchParams()
      nextParams.set("tab", nextTab)
      if (settingsReturnTo) nextParams.set("returnTo", settingsReturnTo)
      window.history.replaceState(null, "", `/settings?${nextParams.toString()}`)
      window.dispatchEvent(new CustomEvent("arc-settings-tab-change", { detail: nextTab }))
    }
    if (nextTab === "team") {
      loadTeam()
    }
    if (nextTab === "cost-codes") {
      loadCostCodes()
    }
  }

  useEffect(() => {
    if (variant !== "page") return
    const handleSettingsTabChange = (event: Event) => {
      const nextTab = (event as CustomEvent<string>).detail
      if (!sections.some((section) => section.value === nextTab)) return
      setTab(nextTab)
      if (nextTab === "team") {
        loadTeam()
      }
      if (nextTab === "cost-codes") {
        loadCostCodes()
      }
    }
    window.addEventListener("arc-settings-tab-change", handleSettingsTabChange)
    return () => window.removeEventListener("arc-settings-tab-change", handleSettingsTabChange)
  }, [variant, loadTeam, loadCostCodes])

  useEffect(() => {
    if (currentMemberRole || loadingTeam) return
    loadTeam()
  }, [currentMemberRole, loadingTeam, loadTeam])

  useEffect(() => {
    if (tab !== "cost-codes") return
    loadCostCodes()
  }, [tab, loadCostCodes])

  const containerHeight = variant === "dialog" ? "flex h-[76vh] min-h-[560px] max-h-[84vh]" : "flex h-full min-h-0"
  const activeSection = sections.find((section) => section.value === tab) ?? sections[0]

  const planName = billing?.plan?.name ?? billing?.subscription?.plan_code ?? billing?.org?.billing_model ?? "Custom"
  const billingStatus = billing?.subscription?.status ?? "active"
  const amount = billing?.plan?.amount_cents != null ? `$${(billing.plan.amount_cents / 100).toFixed(2)} ${billing.plan.currency ?? "usd"}` : "Custom / invoiced"
  const interval = billing?.plan?.interval ?? "monthly"
  const trialEndsAt = billing?.subscription?.trial_ends_at
  const isActive = billingStatus === "active"
  const isTrialing = billingStatus === "trialing"
  const isPastDue = billingStatus === "past_due"
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
  const planCurrency = (billing?.plan?.currency ?? "usd").toUpperCase()
  const planCodeStr = (billing?.subscription?.plan_code ?? billing?.org?.billing_model ?? "").toLowerCase()
  const PlanTierIcon = planCodeStr.includes("business") || planCodeStr.includes("enterprise") ? Building2 : planCodeStr.includes("pro") ? Zap : Sparkles
  const includedFeatures = ["Workspace access for your team and organization settings.", "Projects, cost codes, compliance rules, and financial workflows.", "Invoices, receipts, payment methods, and plan changes through the billing portal.", "Security settings, member permissions, and support from the Arc team."]

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
      const { url } = await createCheckoutSessionAction(selectedPlanCode)
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
      const { url } = await createBillingPortalSessionAction()
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

  const handleOrganizationFieldChange = (field: "name" | "billingEmail" | "addressLine1" | "addressLine2" | "city" | "state" | "postalCode" | "country" | "defaultPaymentTermsDays" | "defaultInvoiceNote", value: string | number) => {
    setOrganizationForm((prev) => ({ ...prev, [field]: value }))
    setOrganizationNotice(null)
    setOrganizationError(null)
  }

  const handleAiProviderChange = (provider: string) => {
    if (!isAiProvider(provider)) return

    setOrganizationForm((prev) => {
      const previousDefaultModel = AI_PROVIDER_DEFAULT_MODELS[prev.aiProvider]
      const nextDefaultModel = AI_PROVIDER_DEFAULT_MODELS[provider]
      const shouldResetModel = !prev.aiModel.trim() || prev.aiModel.trim() === previousDefaultModel
      return {
        ...prev,
        aiProvider: provider,
        aiModel: shouldResetModel ? nextDefaultModel : prev.aiModel,
      }
    })
    setOrganizationAiSource("org")
    setUseInheritedAiDefaults(false)
    setAiSettingsDirty(true)
    setOrganizationNotice(null)
    setOrganizationError(null)
  }

  const handleAiModelChange = (value: string) => {
    setOrganizationForm((prev) => ({ ...prev, aiModel: value }))
    setOrganizationAiSource("org")
    setUseInheritedAiDefaults(false)
    setAiSettingsDirty(true)
    setOrganizationNotice(null)
    setOrganizationError(null)
  }

  const handleUseInheritedAiDefaults = (inherit: boolean) => {
    setUseInheritedAiDefaults(inherit)
    if (!inherit) {
      setOrganizationAiSource("org")
      setOrganizationForm((prev) => ({
        ...prev,
        aiModel: prev.aiModel.trim() || AI_PROVIDER_DEFAULT_MODELS[prev.aiProvider],
      }))
    }
    setAiSettingsDirty(true)
    setOrganizationNotice(null)
    setOrganizationError(null)
  }

  const handleOrganizationSave = () => {
    if (!organizationSettings?.canManageOrganization || isSavingOrganization) return

    setOrganizationNotice(null)
    setOrganizationError(null)

    startOrganizationSave(async () => {
      const result = await updateOrganizationSettingsAction({
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
        aiProvider: useInheritedAiDefaults ? undefined : organizationForm.aiProvider,
        aiModel: useInheritedAiDefaults ? undefined : organizationForm.aiModel,
        aiInheritDefaults: useInheritedAiDefaults,
      })

      if (result?.error) {
        setOrganizationError(result.error)
        return
      }

      try {
        const refreshed = await getOrganizationSettingsAction()
        applyOrganizationSettings(refreshed)
      } catch (error) {
        console.error("Failed to refresh organization settings", error)
        setAiSettingsDirty(false)
      }
      setOrganizationNotice("Organization settings saved.")
    })
  }

  const handleLogoFileSelection = (file: File | null) => {
    if (!file || !organizationSettings?.canManageOrganization || isUpdatingLogo) return

    setOrganizationNotice(null)
    setOrganizationError(null)

    startLogoUpdate(async () => {
      const payload = new FormData()
      payload.set("logo", file)
      const result = await updateOrganizationLogoAction(payload)

      if (result?.error) {
        setOrganizationError(result.error)
        return
      }

      setOrganizationSettings((prev) => (prev ? { ...prev, logoUrl: result.logoUrl ?? null } : prev))
      setOrganizationNotice("Organization logo updated.")
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
      const result = await updateOrganizationLogoAction(payload)

      if (result?.error) {
        setOrganizationError(result.error)
        return
      }

      setOrganizationSettings((prev) => (prev ? { ...prev, logoUrl: null } : prev))
      setOrganizationNotice("Organization logo removed.")
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
      setProfileNotice(null)
      return
    }

    if (file.size > 5 * 1024 * 1024) {
      setProfileError("Profile photo must be 5MB or smaller.")
      setProfileNotice(null)
      return
    }

    if (profilePhotoPreviewUrl) {
      URL.revokeObjectURL(profilePhotoPreviewUrl)
    }

    const nextPreviewUrl = URL.createObjectURL(file)
    setProfilePhotoPreviewUrl(nextPreviewUrl)
    setProfileError(null)
    setProfileNotice("Photo selected.")
  }

  const handleProfilePhotoRemove = () => {
    if (profilePhotoPreviewUrl) {
      URL.revokeObjectURL(profilePhotoPreviewUrl)
    }
    setProfilePhotoPreviewUrl(null)
    setProfileError(null)
    setProfileNotice(null)
    if (profilePhotoInputRef.current) {
      profilePhotoInputRef.current.value = ""
    }
  }

  return (
    <Tabs value={tab} onValueChange={handleTabChange}>
      <div className={cn(containerHeight, "relative min-h-0 overflow-hidden bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85", variant === "dialog" && "border border-border/80 shadow-[0_28px_80px_-46px_rgba(15,23,42,0.45)]")}>
        <div className="pointer-events-none absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-primary/[0.07] to-transparent" />
        {variant === "dialog" && !isMobile && (
          <div className="flex min-h-0 w-80 flex-col border-r border-border/70 bg-muted/20 p-4">
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pr-1">
              <button type="button" onClick={() => handleTabChange("profile")} className={cn("flex w-full items-center gap-3 border px-4 py-3 text-left transition-all", tab === "profile" ? "border-primary/30 bg-primary/5 ring-1 ring-primary/30" : "border-border/70 bg-background/80 hover:border-border/80 hover:bg-background")}>
                <Avatar className="h-12 w-12 border border-border/50">
                  <AvatarImage src={user?.avatar_url ?? undefined} alt={user?.full_name} />
                  <AvatarFallback className="text-base font-semibold">{initials}</AvatarFallback>
                </Avatar>
                <div className="flex-1 overflow-hidden">
                  <p className="truncate font-semibold leading-tight">{user?.full_name ?? "Account"}</p>
                  <p className="truncate text-xs text-muted-foreground">{user?.email ?? "—"}</p>
                </div>
              </button>

              <div className="mt-5">
                <p className="mb-3 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Workspace settings</p>
                <TabsPrimitive.List className="flex w-full flex-col gap-1.5 bg-transparent p-0">
                  {sections
                    .filter((section) => section.value !== "profile")
                    .map((section) => (
                      <TabsPrimitive.Trigger key={section.value} value={section.value} className="group w-full min-h-[64px] justify-start gap-3 border border-transparent bg-background/40 px-3.5 py-3 text-left transition-all hover:border-border/80 hover:bg-background/85 data-[state=active]:border-primary/30 data-[state=active]:bg-primary/5">
                        <div className="flex items-start gap-3">
                          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center border border-border/70 bg-background/70 text-muted-foreground transition-colors group-data-[state=active]:border-primary/40 group-data-[state=active]:bg-primary/10 group-data-[state=active]:text-primary">
                            <section.icon className="h-4 w-4" />
                          </div>
                          <div className="space-y-0.5">
                            <p className="text-sm font-medium leading-tight">{section.label}</p>
                            <p className="text-xs leading-tight text-muted-foreground">{section.description}</p>
                          </div>
                        </div>
                      </TabsPrimitive.Trigger>
                    ))}
                </TabsPrimitive.List>
              </div>
            </div>
          </div>
        )}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className={cn("border-b border-border/70 bg-background/90 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/70 lg:px-6", "py-4")}>
            <div className="mb-4 flex items-center gap-3">
              <div className="flex size-9 items-center justify-center border border-primary/30 bg-primary/5 text-primary">
                <activeSection.icon className="h-4 w-4" />
              </div>
              <div>
                {tab !== "profile" && tab !== "organization" && tab !== "billing" && tab !== "team" && tab !== "about" && <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Settings</p>}
                <h1 className="text-lg font-semibold leading-tight">{activeSection.label}</h1>
                {tab !== "profile" && tab !== "organization" && tab !== "billing" && tab !== "team" && tab !== "about" && <p className="text-sm text-muted-foreground">{activeSection.description}</p>}
              </div>
            </div>

            {isMobile ? (
              <div className="flex items-center gap-2 overflow-hidden">
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
            ) : (
              <p className="text-sm text-muted-foreground">Manage your account and workspace preferences.</p>
            )}
          </div>

          <ScrollArea className="min-h-0 flex-1" viewportClassName={cn("min-h-0", tab === "team" && "overflow-hidden")}>
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
                  <Card className="rounded-none border-x-0 border-t-0 bg-background/75 shadow-none">
                    <CardHeader className="gap-4 px-5 py-6 sm:flex sm:flex-row sm:items-start sm:justify-between lg:px-8">
                      <div className="flex items-start gap-4">
                        <div className="flex size-10 shrink-0 items-center justify-center border border-primary/30 bg-primary/5 text-primary">
                          <PlanTierIcon className="h-4 w-4" />
                        </div>
                        <div>
                          <CardDescription>Current plan</CardDescription>
                          <CardTitle className="mt-1 text-2xl font-semibold leading-tight">{planName}</CardTitle>
                        </div>
                      </div>
                      <CardAction className="static row-auto col-auto justify-self-auto sm:text-right">
                        <div className="flex items-baseline gap-1 sm:justify-end">
                          <span className="text-3xl font-semibold tabular-nums text-foreground">{planAmountDisplay}</span>
                          {planIntervalSuffix && <span className="text-sm font-medium text-muted-foreground">{planIntervalSuffix}</span>}
                        </div>
                        {billing?.plan?.amount_cents != null && <p className="mt-1 text-[11px] uppercase tracking-wider text-muted-foreground">{planCurrency}</p>}
                      </CardAction>
                    </CardHeader>
                    <CardContent className="space-y-5 px-5 pb-6 lg:px-8">
                      <div className="grid gap-3 border-t border-border/60 pt-5 sm:grid-cols-2">
                        <div>
                          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Billing</p>
                          <p className="mt-1 text-sm text-foreground">{amount}</p>
                        </div>
                        <div>
                          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Cycle</p>
                          <p className="mt-1 text-sm capitalize text-foreground">{interval} billing</p>
                        </div>
                      </div>

                      <Accordion type="single" collapsible className="border-t border-border/60">
                        <AccordionItem value="included" className="border-b-0">
                          <AccordionTrigger className="py-4 hover:no-underline">
                            <span>
                              <span className="block text-sm font-medium">What this subscription includes</span>
                              <span className="mt-1 block text-xs font-normal text-muted-foreground">Expand for a quick summary of plan access and billing tools.</span>
                            </span>
                          </AccordionTrigger>
                          <AccordionContent className="pb-1">
                            <div className="grid gap-3 sm:grid-cols-2">
                              {includedFeatures.map((feature) => (
                                <div key={feature} className="flex gap-2 rounded-md border border-border/60 bg-muted/20 p-3">
                                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                                  <p className="text-sm leading-5 text-muted-foreground">{feature}</p>
                                </div>
                              ))}
                            </div>
                          </AccordionContent>
                        </AccordionItem>
                      </Accordion>
                    </CardContent>
                  </Card>

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
                        <div className="mb-8">
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
                          <div className="border border-border/70 bg-muted/20 px-4 py-6 text-sm text-muted-foreground">No active plans are available. Please contact support.</div>
                        ) : (
                          <>
                            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                              {plans.map((plan, idx) => {
                                const code = plan.code.toLowerCase()
                                const isSelected = selectedPlanCode === plan.code
                                const TierIcon = code.includes("business") || code.includes("enterprise") ? Building2 : code.includes("pro") ? Zap : Sparkles
                                const planAmount = plan.amountCents != null ? `$${(plan.amountCents / 100).toFixed(0)}` : "Custom"
                                const planSuffix = plan.amountCents != null && plan.interval ? `/${plan.interval === "monthly" ? "mo" : plan.interval === "yearly" ? "yr" : plan.interval}` : ""
                                const isFeatured = idx === Math.min(1, plans.length - 1) && plans.length > 1
                                return (
                                  <button key={plan.code} type="button" onClick={() => setSelectedPlanCode(plan.code)} className={cn("group relative overflow-hidden border px-5 py-6 text-left transition-all", isSelected ? "border-primary bg-primary/[0.04] shadow-[0_0_0_1px_var(--primary)]" : "border-border/70 bg-background/60 hover:border-primary/40 hover:bg-background")}>
                                    {isFeatured && <span className="absolute right-3 top-3 inline-flex items-center bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary">Popular</span>}
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

                  {isActive && (
                    <Card className="mx-5 my-8 rounded-xl bg-background/75 lg:mx-8 lg:my-10">
                      <CardHeader className="gap-4 sm:flex sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex items-start gap-3">
                          <div className="flex size-9 shrink-0 items-center justify-center border border-border/70 bg-background text-muted-foreground">
                            <Receipt className="h-4 w-4" />
                          </div>
                          <div>
                            <CardTitle className="text-base">Billing portal</CardTitle>
                            <CardDescription className="mt-1">View invoices, update payment methods, and manage plan changes in Stripe.</CardDescription>
                          </div>
                        </div>
                        <Button onClick={handleManageBilling} disabled={portalLoading} className="gap-2">
                          {portalLoading ? "Opening..." : "Open billing portal"}
                          <ArrowRight className="h-3.5 w-3.5" />
                        </Button>
                      </CardHeader>
                    </Card>
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
                          <AvatarImage src={profilePhotoPreviewUrl ?? user?.avatar_url ?? undefined} alt={user?.full_name} />
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
                            <input ref={profilePhotoInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="hidden" onChange={(event) => handleProfilePhotoSelection(event.target.files?.[0] ?? null)} />
                            <Button type="button" variant="outline" size="sm" onClick={() => profilePhotoInputRef.current?.click()}>
                              Change photo
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                    {(profileError || profileNotice) && <div className={cn("mt-4 rounded-md border px-3 py-2 text-sm", profileError ? "border-destructive/30 bg-destructive/5 text-destructive" : "border-primary/30 bg-primary/5 text-primary")}>{profileError ?? profileNotice}</div>}
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
                        <div className="space-y-3">
                          <Label htmlFor="billing-email" className="text-sm font-medium">
                            Billing email
                          </Label>
                          <Input id="billing-email" type="email" value={organizationForm.billingEmail} onChange={(event) => handleOrganizationFieldChange("billingEmail", event.target.value)} placeholder="billing@company.com" className="h-11" disabled={!organizationSettings?.canManageOrganization} />
                        </div>
                      </div>

                      <div className="space-y-4 rounded-lg border border-border/70 bg-muted/20 p-4">
                        <p className="text-sm font-semibold text-foreground">Billing address</p>
                        <div className="grid gap-4 lg:grid-cols-2">
                          <div className="space-y-2">
                            <Label htmlFor="address-line-1" className="text-sm font-medium">
                              Address line 1
                            </Label>
                            <Input id="address-line-1" value={organizationForm.addressLine1} onChange={(event) => handleOrganizationFieldChange("addressLine1", event.target.value)} placeholder="123 Main St" className="h-11" disabled={!organizationSettings?.canManageOrganization} />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="address-line-2" className="text-sm font-medium">
                              Address line 2
                            </Label>
                            <Input id="address-line-2" value={organizationForm.addressLine2} onChange={(event) => handleOrganizationFieldChange("addressLine2", event.target.value)} placeholder="Suite, floor, unit (optional)" className="h-11" disabled={!organizationSettings?.canManageOrganization} />
                          </div>
                        </div>
                        <div className="grid gap-4 lg:grid-cols-4">
                          <div className="space-y-2 lg:col-span-2">
                            <Label htmlFor="address-city" className="text-sm font-medium">
                              City
                            </Label>
                            <Input id="address-city" value={organizationForm.city} onChange={(event) => handleOrganizationFieldChange("city", event.target.value)} placeholder="Naples" className="h-11" disabled={!organizationSettings?.canManageOrganization} />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="address-state" className="text-sm font-medium">
                              State
                            </Label>
                            <Input id="address-state" value={organizationForm.state} onChange={(event) => handleOrganizationFieldChange("state", event.target.value)} placeholder="FL" className="h-11" disabled={!organizationSettings?.canManageOrganization} />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="address-postal" className="text-sm font-medium">
                              ZIP
                            </Label>
                            <Input id="address-postal" value={organizationForm.postalCode} onChange={(event) => handleOrganizationFieldChange("postalCode", event.target.value)} placeholder="34102" className="h-11" disabled={!organizationSettings?.canManageOrganization} />
                          </div>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="address-country" className="text-sm font-medium">
                            Country
                          </Label>
                          <Input id="address-country" value={organizationForm.country} onChange={(event) => handleOrganizationFieldChange("country", event.target.value)} placeholder="United States" className="h-11" disabled={!organizationSettings?.canManageOrganization} />
                        </div>
                      </div>

                      <div className="space-y-4 rounded-lg border border-border/70 bg-background/60 p-4">
                        <p className="text-sm font-semibold text-foreground">Billing defaults</p>
                        <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
                          <div className="space-y-2">
                            <Label htmlFor="default-net-terms" className="text-sm font-medium">
                              Default net terms
                            </Label>
                            <Input id="default-net-terms" type="number" min={0} max={365} value={organizationForm.defaultPaymentTermsDays} onChange={(event) => handleOrganizationFieldChange("defaultPaymentTermsDays", Number(event.target.value || 0))} className="h-11" disabled={!organizationSettings?.canManageOrganization} />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="default-invoice-note" className="text-sm font-medium">
                              Default payment details
                            </Label>
                            <Textarea id="default-invoice-note" value={organizationForm.defaultInvoiceNote} onChange={(event) => handleOrganizationFieldChange("defaultInvoiceNote", event.target.value)} placeholder={"Bank: Example Bank, IBAN: XXXX 0000 0000 0000 0000\nReference: Invoice number"} className="min-h-[88px]" disabled={!organizationSettings?.canManageOrganization} />
                          </div>
                        </div>
                      </div>

                      <div className="flex justify-start">
                        <Button size="sm" onClick={handleOrganizationSave} disabled={!organizationSettings?.canManageOrganization || isSavingOrganization || loadingOrganization}>
                          {isSavingOrganization ? "Saving..." : "Save changes"}
                        </Button>
                      </div>
                    </div>
                  )}

                  {(organizationError || organizationNotice) && <div className={cn("mt-4 rounded-md border px-3 py-2 text-sm", organizationError ? "border-destructive/30 bg-destructive/5 text-destructive" : "border-primary/30 bg-primary/5 text-primary")}>{organizationError ?? organizationNotice}</div>}
                </div>
              </TabsContent>

              <TabsContent value="notifications" className="m-0 mt-0 px-5 py-8 lg:px-8 lg:py-10">
                <div className="mx-auto max-w-6xl">
                  <div className={tabPanelClass}>
                    <div className={tabPanelHeaderClass}>
                      <div>
                        <h2 className="text-base font-semibold">Notifications</h2>
                        <p className="text-sm text-muted-foreground">Configure how and when you receive updates.</p>
                      </div>
                    </div>
                    <div className={tabPanelBodyClass}>
                      <div className="max-w-2xl">
                        <NotificationPreferences />
                      </div>
                    </div>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="integrations" className="m-0 mt-0 outline-none focus-visible:outline-none">
                <div className="flex flex-col">
                  {/* Modern Header */}
                  <div className="relative overflow-hidden border-b border-border/70 bg-gradient-to-br from-indigo-500/[0.05] via-background to-background px-6 py-10 md:px-10 md:py-12 lg:px-12 lg:py-14">
                    <div className="pointer-events-none absolute inset-0 [background-image:linear-gradient(to_right,oklch(0.5_0_0/0.03)_1px,transparent_1px),linear-gradient(to_bottom,oklch(0.5_0_0/0.03)_1px,transparent_1px)] [background-size:24px_24px]" />
                    <div className="relative max-w-4xl">
                      <div className="flex items-center gap-3 text-indigo-600">
                        <Link2 className="h-5 w-5" />
                        <span className="text-[11px] font-bold uppercase tracking-[0.2em]">External Connections</span>
                      </div>
                      <h2 className="mt-4 text-3xl font-semibold tracking-tight text-foreground md:text-4xl">Integrations</h2>
                      <p className="mt-3 text-lg text-muted-foreground leading-relaxed">Connect Arc with your accounting and payment tools to automate your entire financial workflow.</p>
                    </div>
                  </div>

                  {/* Spacious Grid */}
                  <div className="px-6 py-8 md:px-10 md:py-10 lg:px-12 lg:py-12">
                    {loadingIntegrations ? (
                      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
                        <Spinner className="h-8 w-8 mb-4 text-indigo-500/50" />
                        <span className="text-sm font-medium tracking-wide">Syncing integration status...</span>
                      </div>
                    ) : (
                      <div className="mx-auto max-w-6xl">
                        <div className="grid gap-8 lg:grid-cols-2">
                          <StripeConnectionCard connection={stripeConnection} canManage={Boolean(organizationSettings?.canManageOrganization)} onConnectionChange={setStripeConnection} />
                          <QBOConnectionCard connection={qboConnection} onConnectionChange={setQboConnection} />
                        </div>

                        {/* Future integrations placeholder */}
                        <div className="mt-12 rounded-2xl border border-dashed border-border/60 bg-muted/20 p-8 text-center">
                          <p className="text-sm font-medium text-muted-foreground">
                            Looking for another integration?
                            <a href="mailto:support@arc.build" className="ml-1 text-primary hover:underline">
                              Let us know
                            </a>
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="team" className="m-0 mt-0 h-full min-h-0 outline-none focus-visible:outline-none">
                <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background">
                  <div className="relative z-20 flex shrink-0 flex-col gap-3 border-b bg-background/95 px-4 py-3 backdrop-blur-sm sm:flex-row sm:items-center sm:justify-between lg:px-6">
                    <div className="min-w-0">
                      <h2 className="text-sm font-semibold">Team directory</h2>
                      <p className="mt-0.5 text-xs text-muted-foreground">Manage teammates, role assignments, MFA status, and invite workflow.</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Select value={teamFilter} onValueChange={(next) => setTeamFilter(next as "active" | "archived")}>
                        <SelectTrigger size="sm" className="h-8 w-[160px]">
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
                  </div>

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
                        <TeamTable className="h-full" members={teamMembers} canManageMembers={canManageMembers} canEditRoles={canEditRoles} showProjectCounts={false} showInviteAction={false} hideToolbar view={teamFilter} onViewChange={setTeamFilter} onMemberChange={refreshTeam} onInviteMember={() => setTeamView({ mode: "invite" })} onEditMember={(member) => setTeamView({ mode: "edit", member })} />
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

              <TabsContent value="cost-codes" className="m-0 mt-0 px-5 py-8 lg:px-8 lg:py-10">
                <div className="mx-auto max-w-6xl">
                  <div className={tabPanelClass}>
                    <div className={tabPanelHeaderClass}>
                      <div>
                        <h2 className="text-base font-semibold">Cost Codes</h2>
                        <p className="text-sm text-muted-foreground">Manage your org-wide cost code library for financial workflows.</p>
                      </div>
                    </div>
                    <div className={tabPanelBodyClass}>
                      {loadingCostCodes ? (
                        <div className="flex items-center gap-3 text-muted-foreground">
                          <Spinner className="h-4 w-4" />
                          <span className="text-sm">Loading cost codes...</span>
                        </div>
                      ) : costCodesError ? (
                        <div className="text-sm text-destructive">{costCodesError}</div>
                      ) : (
                        <CostCodeManager costCodes={costCodes} canManage={Boolean(organizationSettings?.canManageOrganization)} onCostCodesChange={setCostCodes} />
                      )}
                    </div>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="compliance" className="m-0 mt-0 px-5 py-8 lg:px-8 lg:py-10">
                <div className="mx-auto max-w-6xl">
                  <div className={tabPanelClass}>
                    <div className={tabPanelHeaderClass}>
                      <div>
                        <h2 className="text-base font-semibold">Payables</h2>
                        <p className="text-sm text-muted-foreground">Configure payment gating and compliance requirements.</p>
                      </div>
                    </div>
                    <div className={tabPanelBodyClass}>
                      <ComplianceSettings initialRules={initialComplianceRules} initialRequirementDefaults={initialComplianceRequirementDefaults} canManage={canManageCompliance} />
                    </div>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="about" className="m-0 mt-0 h-full">
                <div className="flex flex-col min-h-[calc(100vh-20rem)] py-16 lg:py-24">
                  <div className="flex-1 space-y-24">
                    <div className="flex flex-col items-center justify-center space-y-10 text-center">
                      <div className="relative">
                        <div className="absolute -inset-6 rounded-full bg-primary/5 blur-3xl" />
                        <div className="relative flex h-40 w-40 items-center justify-center rounded-3xl border border-border/50 bg-background/80 shadow-xl transition-all duration-500 hover:scale-105">
                          <img src={appInfo.logoUrl} alt={`${appInfo.name} logo`} className="h-24 w-24 object-contain" />
                        </div>
                      </div>
                      <div className="space-y-4">
                        <h2 className="text-4xl font-extrabold tracking-tight text-foreground">{appInfo.name}</h2>
                        <p className="text-sm font-semibold tracking-widest uppercase text-muted-foreground/60">Version {appInfo.version}</p>
                      </div>
                    </div>

                    <div className="mx-auto w-full max-w-2xl px-4">
                      <div className="grid gap-px overflow-hidden rounded-2xl border border-border/60 bg-border/60 shadow-2xl sm:grid-cols-2">
                        <div className="bg-background/95 p-8 space-y-2">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80">Workspace</span>
                          <p className="text-lg font-semibold text-foreground">{organizationSettings?.name ?? billing?.org?.name ?? "Workspace"}</p>
                        </div>
                        <div className="bg-background/95 p-8 space-y-2">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80">Workspace ID</span>
                          <p className="font-mono text-xs text-foreground/80 break-all">{organizationSettings?.id ?? "—"}</p>
                        </div>
                        <div className="bg-background/95 p-8 space-y-2">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80">Account</span>
                          <p className="text-lg font-semibold text-foreground break-all">{user?.email ?? "—"}</p>
                        </div>
                        <div className="bg-background/95 p-8 space-y-2">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80">Your Role</span>
                          <p className="text-lg font-semibold text-foreground">{userRoleLabel ?? (loadingTeam ? "Loading..." : "Member")}</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="mt-24 pt-12 border-t border-border/40">
                    <div className="mx-auto max-w-2xl flex flex-col items-center justify-center space-y-8 px-4">
                      <nav className="flex items-center justify-center gap-x-8 text-sm font-semibold">
                        <Link href="https://arcnaples.com" target="_blank" className="text-muted-foreground/80 transition-all hover:text-primary hover:scale-105">
                          Website
                        </Link>
                        <Link href={appInfo.termsUrl} className="text-muted-foreground/80 transition-all hover:text-primary hover:scale-105">
                          Terms
                        </Link>
                        <Link href="/settings/support" className="text-muted-foreground/80 transition-all hover:text-primary hover:scale-105">
                          Support
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
