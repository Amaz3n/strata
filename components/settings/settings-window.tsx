"use client"

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react"

import * as TabsPrimitive from "@radix-ui/react-tabs"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { ScrollArea } from "@/components/ui/scroll-area"
import { NotificationPreferences } from "@/components/settings/notification-preferences"
import { ComplianceSettings } from "@/components/settings/compliance-settings"
import { QBOConnectionCard } from "@/components/integrations/qbo-connection-card"
import { Spinner } from "@/components/ui/spinner"
import { Bell, Building2, CreditCard, Link2, Settings, User as UserIcon, Users } from "@/components/icons"
import { Info } from "lucide-react"
import { getQBOConnectionAction } from "@/app/(app)/settings/integrations/actions"
import {
  createBillingPortalSessionAction,
  createCheckoutSessionAction,
  getBillingPageDataAction,
  getOrganizationSettingsAction,
  getTeamSettingsDataAction,
  updateOrganizationLogoAction,
  updateOrganizationSettingsAction,
} from "@/app/(app)/settings/actions"
import { useIsMobile } from "@/hooks/use-mobile"
import type { QBOConnection } from "@/lib/services/qbo-connection"
import type { ComplianceRequirementTemplateItem, ComplianceRules, OrgRoleOption, TeamMember, User } from "@/lib/types"
import { TeamTable } from "@/components/team/team-table"
import { MfaSettingsCard } from "@/components/settings/mfa-settings-card"
import Link from "next/link"
import packageJson from "@/package.json"
import { cn } from "@/lib/utils"

const sections = [
  { value: "profile", label: "Profile", description: "Name, email, avatar", icon: UserIcon },
  { value: "organization", label: "Organization", description: "Company details", icon: Building2 },
  { value: "billing", label: "Billing", description: "Subscription details", icon: CreditCard },
  { value: "notifications", label: "Notifications", description: "How you get updates", icon: Bell },
  { value: "integrations", label: "Integrations", description: "Connect your tools", icon: Link2 },
  { value: "team", label: "Team", description: "Manage internal members", icon: Users },
  { value: "compliance", label: "Payables", description: "Payment gating policy", icon: Settings },
  { value: "about", label: "About", description: "About this workspace", icon: Info },
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
  logoUrl: "/icon.svg",
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
  logoUrl: string | null
  canManageOrganization: boolean
}

interface SettingsWindowProps {
  user: User | null
  initialTab?: string
  initialQboConnection?: QBOConnection | null
  variant?: "page" | "dialog"
  teamMembers?: TeamMember[]
  roleOptions?: OrgRoleOption[]
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
  variant = "page",
  teamMembers: initialTeamMembers,
  roleOptions: initialRoleOptions,
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
  const defaultTab = sections.some((section) => section.value === initialTab) ? initialTab : "profile"
  const [tab, setTab] = useState<string>(defaultTab)
  const [qboConnection, setQboConnection] = useState<QBOConnection | null>(initialQboConnection)
  const [hasFetchedIntegrations, setHasFetchedIntegrations] = useState<boolean>(Boolean(initialQboConnection))
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
  const [canManageMembers, setCanManageMembers] = useState<boolean>(initialCanManageMembers ?? false)
  const [canEditRoles, setCanEditRoles] = useState<boolean>(initialCanEditRoles ?? false)
  const [hasFetchedTeam, setHasFetchedTeam] = useState<boolean>(
      initialTeamMembers !== undefined ||
      initialRoleOptions !== undefined ||
      initialCanManageMembers !== undefined ||
      initialCanEditRoles !== undefined,
  )
  const [loadingTeam, setLoadingTeam] = useState(false)
  const [teamError, setTeamError] = useState<string | null>(null)
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
  })
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
  const userRoleLabel = currentMemberRole
    ? (teamMembers.find((member) => member.user.id === user?.id)?.role_label ?? "")
        .replace(/^org[\s_-]+/i, "")
        .trim() ||
      (roleOptions.find((option) => option.key === currentMemberRole)?.label ?? "")
        .replace(/^org[\s_-]+/i, "")
        .trim() ||
      toRoleLabel(currentMemberRole)
    : null
  const isMobile = useIsMobile()

  useEffect(() => {
    const nextTab = sections.some((section) => section.value === initialTab) ? initialTab : "profile"
    setTab(nextTab)
  }, [initialTab])

  useEffect(() => {
    setQboConnection(initialQboConnection ?? null)
    setHasFetchedIntegrations(Boolean(initialQboConnection))
  }, [initialQboConnection])

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
    if (
      initialTeamMembers !== undefined ||
      initialRoleOptions !== undefined ||
      initialCanManageMembers !== undefined ||
      initialCanEditRoles !== undefined
    ) {
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
        })
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
  }, [hasFetchedOrganization])

  useEffect(() => {
    if (hasFetchedIntegrations) return

    let isMounted = true
    setLoadingIntegrations(true)
    getQBOConnectionAction()
      .then((connection) => {
        if (!isMounted) return
        setQboConnection(connection)
        setHasFetchedIntegrations(true)
      })
      .catch((error) => {
        console.error("Failed to load QuickBooks connection", error)
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

  const loadTeam = useCallback((forceRefresh = false) => {
    if ((hasFetchedTeam && !forceRefresh) || loadingTeam) return
    let isMounted = true
    setLoadingTeam(true)
    setTeamError(null)
    Promise.resolve(getTeamSettingsDataAction())
      .then((data) => {
        if (!isMounted) return
        setTeamMembers(data?.teamMembers ?? [])
        setRoleOptions(data?.roleOptions ?? [])
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
  }, [hasFetchedTeam, loadingTeam])

  const refreshTeam = () => {
    loadTeam(true)
  }

  const handleTabChange = (nextTab: string) => {
    setTab(nextTab)
    if (nextTab === "team") {
      loadTeam()
    }
  }

  useEffect(() => {
    if (currentMemberRole || loadingTeam) return
    loadTeam()
  }, [currentMemberRole, loadingTeam, loadTeam])

  const containerHeight =
    variant === "dialog"
      ? "flex h-[76vh] min-h-[560px] max-h-[84vh]"
      : "flex h-full min-h-[calc(100vh-8rem)]"
  const activeSection = sections.find((section) => section.value === tab) ?? sections[0]

  const planName =
    billing?.plan?.name ??
    billing?.subscription?.plan_code ??
    billing?.org?.billing_model ??
    "Custom"
  const billingStatus = billing?.subscription?.status ?? "active"
  const renewal = billing?.subscription?.current_period_end
  const amount =
    billing?.plan?.amount_cents != null
      ? `$${(billing.plan.amount_cents / 100).toFixed(2)} ${billing.plan.currency ?? "usd"}`
      : "Custom / invoiced"
  const interval = billing?.plan?.interval ?? "monthly"
  const trialEndsAt = billing?.subscription?.trial_ends_at
  const isActive = billingStatus === "active"
  const isTrialing = billingStatus === "trialing"
  const isPastDue = billingStatus === "past_due"
  const needsSubscription = !isActive
  const formattedRenewal = renewal ? new Date(renewal).toLocaleDateString() : "Not set"
  const formattedTrialEnd = trialEndsAt ? new Date(trialEndsAt).toLocaleDateString() : "Not set"

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

  const handleOrganizationFieldChange = (
    field:
      | "name"
      | "billingEmail"
      | "addressLine1"
      | "addressLine2"
      | "city"
      | "state"
      | "postalCode"
      | "country"
      | "defaultPaymentTermsDays"
      | "defaultInvoiceNote",
    value: string | number,
  ) => {
    setOrganizationForm((prev) => ({ ...prev, [field]: value }))
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
      })

      if (result?.error) {
        setOrganizationError(result.error)
        return
      }

      setOrganizationSettings((prev) =>
        prev
          ? {
              ...prev,
              name: organizationForm.name.trim(),
              billingEmail: organizationForm.billingEmail.trim(),
              address: [
                [organizationForm.addressLine1.trim(), organizationForm.addressLine2.trim()].filter(Boolean).join(" ").trim(),
                [organizationForm.city.trim(), organizationForm.state.trim(), organizationForm.postalCode.trim()].filter(Boolean).join(" ").trim(),
                organizationForm.country.trim(),
              ]
                .filter(Boolean)
                .join("\n")
                .trim(),
              addressLine1: organizationForm.addressLine1.trim(),
              addressLine2: organizationForm.addressLine2.trim(),
              city: organizationForm.city.trim(),
              state: organizationForm.state.trim(),
              postalCode: organizationForm.postalCode.trim(),
              country: organizationForm.country.trim(),
              defaultPaymentTermsDays: Number(organizationForm.defaultPaymentTermsDays ?? 15),
              defaultInvoiceNote: organizationForm.defaultInvoiceNote.trim(),
            }
          : prev,
      )
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
      <div
        className={cn(
          containerHeight,
          "relative overflow-hidden border border-border/80 bg-background/95 shadow-[0_28px_80px_-46px_rgba(15,23,42,0.45)] backdrop-blur supports-[backdrop-filter]:bg-background/85",
        )}
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-primary/[0.07] to-transparent" />
        {!isMobile && (
          <div className="w-80 border-r border-border/70 bg-muted/20 p-4">
            <div className="flex items-center gap-3 border border-border/70 bg-background/80 px-4 py-3 shadow-sm">
              <Avatar className="h-12 w-12">
                <AvatarImage src={user?.avatar_url || "/placeholder.svg"} alt={user?.full_name} />
                <AvatarFallback className="text-base font-semibold">{initials}</AvatarFallback>
              </Avatar>
              <div className="text-sm">
                <p className="font-semibold leading-tight">{user?.full_name ?? "Account"}</p>
                <p className="text-muted-foreground text-xs">{user?.email ?? "—"}</p>
              </div>
            </div>

            <div className="mt-5">
              <p className="mb-3 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Workspace settings
              </p>
              <TabsPrimitive.List className="flex w-full flex-col gap-1.5 bg-transparent p-0">
                {sections.map((section) => (
                  <TabsPrimitive.Trigger
                    key={section.value}
                    value={section.value}
                    className="group w-full min-h-[64px] justify-start gap-3 border border-transparent bg-background/40 px-3.5 py-3 text-left transition-all hover:border-border/80 hover:bg-background/85 data-[state=active]:border-primary/30 data-[state=active]:bg-primary/5"
                  >
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
        )}

        <div className="flex-1 flex flex-col min-w-0">
          <div className="border-b border-border/70 bg-background/90 px-4 py-4 backdrop-blur supports-[backdrop-filter]:bg-background/70 lg:px-6">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex size-9 items-center justify-center border border-primary/30 bg-primary/5 text-primary">
                <activeSection.icon className="h-4 w-4" />
              </div>
              <div>
                {tab !== "profile" && tab !== "organization" && tab !== "billing" && tab !== "team" && tab !== "about" && (
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Settings</p>
                )}
                <h1 className="text-lg font-semibold leading-tight">{activeSection.label}</h1>
                {tab !== "profile" && tab !== "organization" && tab !== "billing" && tab !== "team" && tab !== "about" && (
                  <p className="text-sm text-muted-foreground">{activeSection.description}</p>
                )}
              </div>
            </div>

            {isMobile ? (
              <TabsList className="h-auto w-full justify-start gap-2 overflow-x-auto bg-transparent p-0 pb-1">
                {sections.map((section) => (
                  <TabsTrigger
                    key={section.value}
                    value={section.value}
                    className="h-9 shrink-0 gap-2 border border-border/70 bg-background/70 px-3 text-xs font-medium data-[state=active]:border-primary/30 data-[state=active]:bg-primary/5 data-[state=active]:text-primary"
                  >
                    <section.icon className="h-3.5 w-3.5" />
                    {section.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            ) : (
              <p className="text-sm text-muted-foreground">Manage your account and workspace preferences.</p>
            )}
          </div>

          <ScrollArea className="flex-1">
            <div className="mx-auto w-full max-w-6xl space-y-8 p-5 lg:p-8">
              <TabsContent value="profile" className="m-0 mt-0">
                <div className="space-y-7">
                  <div className="rounded-xl border border-border/80 bg-background/75 p-5 shadow-sm lg:p-6">
                    <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
                      <div className="flex items-center gap-4">
                        <Avatar className="h-20 w-20 border border-border/80">
                          <AvatarImage
                            src={profilePhotoPreviewUrl ?? user?.avatar_url ?? "/placeholder.svg"}
                            alt={user?.full_name}
                          />
                          <AvatarFallback className="text-xl font-semibold">{initials}</AvatarFallback>
                        </Avatar>
                        <div className="space-y-1">
                          <p className="text-base font-semibold">{user?.full_name ?? "Your profile"}</p>
                          <p className="text-sm text-muted-foreground">{user?.email ?? "—"}</p>
                          <div className="flex items-center gap-2 pt-2">
                            <input
                              ref={profilePhotoInputRef}
                              type="file"
                              accept="image/png,image/jpeg,image/webp,image/svg+xml"
                              className="hidden"
                              onChange={(event) => handleProfilePhotoSelection(event.target.files?.[0] ?? null)}
                            />
                            <Button type="button" variant="outline" size="sm" onClick={() => profilePhotoInputRef.current?.click()}>
                              Change photo
                            </Button>
                            <Button type="button" variant="ghost" size="sm" onClick={handleProfilePhotoRemove}>
                              Remove
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                    {(profileError || profileNotice) && (
                      <div
                        className={cn(
                          "mt-4 rounded-md border px-3 py-2 text-sm",
                          profileError
                            ? "border-destructive/30 bg-destructive/5 text-destructive"
                            : "border-primary/30 bg-primary/5 text-primary",
                        )}
                      >
                        {profileError ?? profileNotice}
                      </div>
                    )}
                  </div>

                  <div className="overflow-hidden rounded-xl border border-border/80 bg-background/75 shadow-sm">
                    <div className="border-b border-border/70 px-5 py-4 lg:px-6">
                      <h2 className="text-base font-semibold">Personal details</h2>
                      <p className="text-sm text-muted-foreground">Update your basic account information.</p>
                    </div>
                    <div className="space-y-6 px-5 py-5 lg:px-6 lg:py-6">
                      <div className="grid gap-6 lg:grid-cols-2">
                        <div className="space-y-3">
                          <Label htmlFor="name" className="text-sm font-medium">Full name</Label>
                          <Input id="name" defaultValue={user?.full_name} placeholder="Alex Contractor" className="h-11" />
                        </div>
                        <div className="space-y-3">
                          <Label htmlFor="email" className="text-sm font-medium">Email</Label>
                          <Input id="email" type="email" defaultValue={user?.email} placeholder="you@company.com" className="h-11" />
                        </div>
                      </div>

                      <div className="grid gap-6 lg:grid-cols-2">
                        <div className="space-y-3">
                          <Label htmlFor="phone" className="text-sm font-medium">Phone</Label>
                          <Input id="phone" type="tel" placeholder="(503) 555-0123" className="h-11" />
                        </div>
                        <div className="space-y-3">
                          <Label htmlFor="role-readonly" className="text-sm font-medium">Role</Label>
                          <Input
                            id="role-readonly"
                            value={userRoleLabel ?? (loadingTeam ? "Loading role..." : "Unknown role")}
                            readOnly
                            aria-readonly
                            className="h-11 border-dashed bg-muted/30 text-muted-foreground"
                          />
                        </div>
                      </div>

                      <div className="flex justify-start">
                        <Button size="sm">Save changes</Button>
                      </div>
                    </div>
                  </div>

                  <MfaSettingsCard />
                </div>
              </TabsContent>

              <TabsContent value="organization" className="m-0 mt-0">
                <div className={tabPanelClass}>
                  <div className={cn(tabPanelBodyClass, "space-y-8")}>
                    {loadingOrganization ? (
                      <div className="flex items-center gap-3 text-muted-foreground">
                        <Spinner className="h-4 w-4" />
                        <span className="text-sm">Loading organization settings...</span>
                      </div>
                    ) : (
                      <>
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
                            <input
                              ref={logoInputRef}
                              type="file"
                              accept="image/png,image/jpeg,image/webp,image/svg+xml"
                              className="hidden"
                              onChange={(event) => handleLogoFileSelection(event.target.files?.[0] ?? null)}
                              disabled={!organizationSettings?.canManageOrganization || isUpdatingLogo}
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => logoInputRef.current?.click()}
                              disabled={!organizationSettings?.canManageOrganization || isUpdatingLogo}
                            >
                              {isUpdatingLogo ? "Uploading..." : "Upload logo"}
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={handleLogoRemove}
                              disabled={!organizationSettings?.canManageOrganization || isUpdatingLogo || !organizationSettings?.logoUrl}
                            >
                              Remove
                            </Button>
                          </div>
                        </div>
                        {!organizationSettings?.canManageOrganization && (
                          <p className="-mt-2 text-xs text-muted-foreground">
                            Only organization admins can update branding.
                          </p>
                        )}

                        <div className="grid gap-6 lg:grid-cols-2">
                          <div className="space-y-3">
                            <Label htmlFor="company" className="text-sm font-medium">Company name</Label>
                            <Input
                              id="company"
                              value={organizationForm.name}
                              onChange={(event) => handleOrganizationFieldChange("name", event.target.value)}
                              placeholder="Company name"
                              className="h-11"
                              disabled={!organizationSettings?.canManageOrganization}
                            />
                          </div>
                          <div className="space-y-3">
                            <Label htmlFor="billing-email" className="text-sm font-medium">Billing email</Label>
                            <Input
                              id="billing-email"
                              type="email"
                              value={organizationForm.billingEmail}
                              onChange={(event) => handleOrganizationFieldChange("billingEmail", event.target.value)}
                              placeholder="billing@company.com"
                              className="h-11"
                              disabled={!organizationSettings?.canManageOrganization}
                            />
                          </div>
                        </div>

                        <div className="space-y-4 rounded-lg border border-border/70 bg-muted/20 p-4">
                          <p className="text-sm font-semibold text-foreground">Billing address</p>
                          <div className="grid gap-4 lg:grid-cols-2">
                            <div className="space-y-2">
                              <Label htmlFor="address-line-1" className="text-sm font-medium">Address line 1</Label>
                              <Input
                                id="address-line-1"
                                value={organizationForm.addressLine1}
                                onChange={(event) => handleOrganizationFieldChange("addressLine1", event.target.value)}
                                placeholder="123 Main St"
                                className="h-11"
                                disabled={!organizationSettings?.canManageOrganization}
                              />
                            </div>
                            <div className="space-y-2">
                              <Label htmlFor="address-line-2" className="text-sm font-medium">Address line 2</Label>
                              <Input
                                id="address-line-2"
                                value={organizationForm.addressLine2}
                                onChange={(event) => handleOrganizationFieldChange("addressLine2", event.target.value)}
                                placeholder="Suite, floor, unit (optional)"
                                className="h-11"
                                disabled={!organizationSettings?.canManageOrganization}
                              />
                            </div>
                          </div>
                          <div className="grid gap-4 lg:grid-cols-4">
                            <div className="space-y-2 lg:col-span-2">
                              <Label htmlFor="address-city" className="text-sm font-medium">City</Label>
                              <Input
                                id="address-city"
                                value={organizationForm.city}
                                onChange={(event) => handleOrganizationFieldChange("city", event.target.value)}
                                placeholder="Naples"
                                className="h-11"
                                disabled={!organizationSettings?.canManageOrganization}
                              />
                            </div>
                            <div className="space-y-2">
                              <Label htmlFor="address-state" className="text-sm font-medium">State</Label>
                              <Input
                                id="address-state"
                                value={organizationForm.state}
                                onChange={(event) => handleOrganizationFieldChange("state", event.target.value)}
                                placeholder="FL"
                                className="h-11"
                                disabled={!organizationSettings?.canManageOrganization}
                              />
                            </div>
                            <div className="space-y-2">
                              <Label htmlFor="address-postal" className="text-sm font-medium">ZIP</Label>
                              <Input
                                id="address-postal"
                                value={organizationForm.postalCode}
                                onChange={(event) => handleOrganizationFieldChange("postalCode", event.target.value)}
                                placeholder="34102"
                                className="h-11"
                                disabled={!organizationSettings?.canManageOrganization}
                              />
                            </div>
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="address-country" className="text-sm font-medium">Country</Label>
                            <Input
                              id="address-country"
                              value={organizationForm.country}
                              onChange={(event) => handleOrganizationFieldChange("country", event.target.value)}
                              placeholder="United States"
                              className="h-11"
                              disabled={!organizationSettings?.canManageOrganization}
                            />
                          </div>
                        </div>

                        <div className="space-y-4 rounded-lg border border-border/70 bg-background/60 p-4">
                          <p className="text-sm font-semibold text-foreground">Billing defaults</p>
                          <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
                            <div className="space-y-2">
                              <Label htmlFor="default-net-terms" className="text-sm font-medium">Default net terms</Label>
                              <Input
                                id="default-net-terms"
                                type="number"
                                min={0}
                                max={365}
                                value={organizationForm.defaultPaymentTermsDays}
                                onChange={(event) =>
                                  handleOrganizationFieldChange("defaultPaymentTermsDays", Number(event.target.value || 0))
                                }
                                className="h-11"
                                disabled={!organizationSettings?.canManageOrganization}
                              />
                            </div>
                            <div className="space-y-2">
                              <Label htmlFor="default-invoice-note" className="text-sm font-medium">Default payment details</Label>
                              <Textarea
                                id="default-invoice-note"
                                value={organizationForm.defaultInvoiceNote}
                                onChange={(event) => handleOrganizationFieldChange("defaultInvoiceNote", event.target.value)}
                                placeholder={"Bank: Example Bank, IBAN: XXXX 0000 0000 0000 0000\nReference: Invoice number"}
                                className="min-h-[88px]"
                                disabled={!organizationSettings?.canManageOrganization}
                              />
                            </div>
                          </div>
                        </div>

                        <div className="flex justify-start">
                          <Button
                            size="sm"
                            onClick={handleOrganizationSave}
                            disabled={!organizationSettings?.canManageOrganization || isSavingOrganization || loadingOrganization}
                          >
                            {isSavingOrganization ? "Saving..." : "Save changes"}
                          </Button>
                        </div>
                      </>
                    )}

                    {(organizationError || organizationNotice) && (
                      <div
                        className={cn(
                          "rounded-md border px-3 py-2 text-sm",
                          organizationError
                            ? "border-destructive/30 bg-destructive/5 text-destructive"
                            : "border-primary/30 bg-primary/5 text-primary",
                        )}
                      >
                        {organizationError ?? organizationNotice}
                      </div>
                    )}
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="billing" className="m-0 mt-0">
                <div className={tabPanelClass}>
                  <div className={cn(tabPanelBodyClass, "space-y-4")}>
                    {!canManageBilling ? (
                      <div className="rounded-lg border border-border/70 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
                        You do not have permission to view billing for this organization.
                      </div>
                    ) : loadingBilling ? (
                      <div className="flex items-center gap-3 text-muted-foreground">
                        <Spinner className="h-4 w-4" />
                        <span className="text-sm">Loading billing details...</span>
                      </div>
                    ) : billingError ? (
                      <div className="text-sm text-destructive">{billingError}</div>
                    ) : billing ? (
                      <>
                        <div className="grid gap-3 md:grid-cols-3">
                          <div className="rounded-lg border border-border/70 bg-muted/20 p-4">
                            <p className="text-xs uppercase tracking-wide text-muted-foreground">Current plan</p>
                            <p className="mt-2 text-base font-semibold text-foreground">{planName}</p>
                            <p className="text-sm text-muted-foreground">{amount}</p>
                          </div>
                          <div className="rounded-lg border border-border/70 bg-muted/20 p-4">
                            <p className="text-xs uppercase tracking-wide text-muted-foreground">Status</p>
                            <div className="mt-2">
                              <Badge variant={billingStatus === "active" ? "default" : "outline"} className="capitalize">
                                {billingStatus}
                              </Badge>
                            </div>
                            <p className="mt-2 text-sm text-muted-foreground">Billing cycle: {interval}</p>
                          </div>
                          <div className="rounded-lg border border-border/70 bg-muted/20 p-4">
                            <p className="text-xs uppercase tracking-wide text-muted-foreground">Renewal</p>
                            <p className="mt-2 text-base font-semibold text-foreground">{formattedRenewal}</p>
                            {trialEndsAt && (
                              <p className="text-sm text-muted-foreground">Trial ends: {formattedTrialEnd}</p>
                            )}
                          </div>
                        </div>

                        <div className="rounded-lg border border-border/70 bg-background/60 p-4">
                          <p className="text-sm font-medium text-foreground">Billing details</p>
                          <div className="mt-2 space-y-1 text-sm text-muted-foreground">
                            <div>Pricing model: {billing.plan?.pricing_model ?? "subscription"}</div>
                            {billing.subscription?.external_customer_id && (
                              <div>Customer ID: {billing.subscription.external_customer_id}</div>
                            )}
                            {billing.subscription?.external_subscription_id && (
                              <div>Subscription ID: {billing.subscription.external_subscription_id}</div>
                            )}
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="text-sm text-muted-foreground">No billing details available.</div>
                    )}

                    {billingActionError && (
                      <div className="text-sm text-destructive">{billingActionError}</div>
                    )}

                    {needsSubscription && (
                      <div className="rounded-lg border border-border/70 bg-background/60 p-4">
                        <p className="text-base font-semibold text-foreground">Choose a plan</p>
                        <p className="mt-1 text-sm text-muted-foreground">
                            {isTrialing
                              ? "Keep your workspace active by choosing a plan."
                              : "Choose a plan to activate your workspace."}
                        </p>
                        <div className="mt-4 space-y-4">
                          {loadingPlans ? (
                            <div className="flex items-center gap-3 text-muted-foreground">
                              <Spinner className="h-4 w-4" />
                              <span className="text-sm">Loading plans...</span>
                            </div>
                          ) : plans.length === 0 ? (
                            <div className="text-sm text-muted-foreground">
                              No active plans are available. Please contact support.
                            </div>
                          ) : (
                            <div className="grid gap-3 md:grid-cols-2">
                              {plans.map((plan) => {
                                const isSelected = selectedPlanCode === plan.code
                                const planAmount =
                                  plan.amountCents != null
                                    ? `$${(plan.amountCents / 100).toFixed(0)}${plan.interval ? `/${plan.interval}` : ""}`
                                    : "Custom pricing"
                                return (
                                  <button
                                    key={plan.code}
                                    type="button"
                                    onClick={() => setSelectedPlanCode(plan.code)}
                                    className={cn(
                                      "rounded-lg border px-4 py-3 text-left transition-colors",
                                      isSelected
                                        ? "border-primary/40 bg-primary/5"
                                        : "border-border/70 bg-muted/20 hover:border-primary/25 hover:bg-primary/[0.03]",
                                    )}
                                  >
                                    <p className="text-sm font-semibold text-foreground">{plan.name}</p>
                                    <p className="text-sm text-muted-foreground">{planAmount}</p>
                                    <p className="mt-1 text-xs text-muted-foreground capitalize">{plan.pricingModel}</p>
                                  </button>
                                )
                              })}
                            </div>
                          )}
                          <div className="flex items-center gap-3">
                            <Button onClick={handleSubscribe} disabled={!selectedPlanCode || checkoutLoading}>
                              {checkoutLoading ? "Redirecting..." : "Subscribe"}
                            </Button>
                            {selectedPlanCode && (
                              <span className="text-xs text-muted-foreground">
                                Selected: {plans.find((plan) => plan.code === selectedPlanCode)?.name}
                              </span>
                            )}
                          </div>
                          {isPastDue && (
                            <div className="text-xs text-muted-foreground">
                              Your subscription is past due. Update billing to keep access active.
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {isActive && (
                      <div className="rounded-lg border border-border/70 bg-background/60 p-4">
                        <p className="text-sm font-medium text-foreground">Payment and invoices</p>
                        <p className="mt-1 text-sm text-muted-foreground">
                          Open the billing portal to update card details, download invoices, and manage subscription settings.
                        </p>
                        <div className="mt-3 flex justify-start">
                          <Button variant="outline" onClick={handleManageBilling} disabled={portalLoading}>
                            {portalLoading ? "Opening portal..." : "Open billing portal"}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="notifications" className="m-0 mt-0">
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
              </TabsContent>

              <TabsContent value="integrations" className="m-0 mt-0">
                <div className={tabPanelClass}>
                  <div className={cn(tabPanelHeaderClass, "gap-2")}>
                    <div>
                      <h2 className="text-base font-semibold">Integrations</h2>
                      <p className="text-sm text-muted-foreground">Connect your tools to automate workflows</p>
                    </div>
                  </div>
                  <div className={tabPanelBodyClass}>
                    {loadingIntegrations ? (
                      <div className="flex items-center justify-center gap-3 text-muted-foreground py-10">
                        <Spinner className="h-5 w-5" />
                        <span className="text-sm">Loading integrations...</span>
                      </div>
                    ) : (
                      <div className="grid gap-6">
                        <QBOConnectionCard connection={qboConnection} />
                      </div>
                    )}
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="team" className="m-0 mt-0">
                {loadingTeam ? (
                  <div className="flex items-center gap-3 text-muted-foreground">
                    <Spinner className="h-4 w-4" />
                    <span className="text-sm">Loading team members...</span>
                  </div>
                ) : teamError ? (
                  <div className="text-sm text-destructive">{teamError}</div>
                ) : (
                  <TeamTable
                    members={teamMembers}
                    roleOptions={roleOptions}
                    canManageMembers={canManageMembers}
                    canEditRoles={canEditRoles}
                    showProjectCounts={false}
                    onMemberChange={refreshTeam}
                  />
                )}
              </TabsContent>

              <TabsContent value="compliance" className="m-0 mt-0">
                <div className={tabPanelClass}>
                  <div className={tabPanelHeaderClass}>
                    <div>
                      <h2 className="text-base font-semibold">Payables</h2>
                      <p className="text-sm text-muted-foreground">Configure payment gating and compliance requirements.</p>
                    </div>
                  </div>
                  <div className={tabPanelBodyClass}>
                    <ComplianceSettings
                      initialRules={initialComplianceRules}
                      initialRequirementDefaults={initialComplianceRequirementDefaults}
                      canManage={canManageCompliance}
                    />
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="about" className="m-0 mt-0">
                <div className={tabPanelClass}>
                  <div className={cn(tabPanelBodyClass, "space-y-6 text-sm text-muted-foreground")}>
                    <div className="flex items-center gap-4">
                      <div className="h-12 w-12 rounded-lg border bg-background/80 flex items-center justify-center overflow-hidden">
                        <img src={appInfo.logoUrl} alt={`${appInfo.name} logo`} className="h-10 w-10 object-contain" />
                      </div>
                      <div>
                        <p className="text-foreground font-semibold leading-tight">{appInfo.name}</p>
                        <p className="text-xs uppercase tracking-wide text-muted-foreground">Version {appInfo.version}</p>
                        <p className="text-xs text-muted-foreground">By {appInfo.company}</p>
                      </div>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="flex flex-col gap-1">
                        <span className="text-foreground font-medium">Workspace</span>
                        <span>{organizationSettings?.name ?? billing?.org?.name ?? "Workspace"}</span>
                      </div>
                      <div className="flex flex-col gap-1">
                        <span className="text-foreground font-medium">Workspace ID</span>
                        <span className="font-mono text-xs">{organizationSettings?.id ?? "—"}</span>
                      </div>
                      <div className="flex flex-col gap-1">
                        <span className="text-foreground font-medium">Signed-in account</span>
                        <span>{user?.email ?? "—"}</span>
                      </div>
                      <div className="flex flex-col gap-1">
                        <span className="text-foreground font-medium">Your role</span>
                        <span>{userRoleLabel ?? (loadingTeam ? "Loading role..." : "Unknown role")}</span>
                      </div>
                    </div>

                    <div className="rounded-lg border border-border/70 bg-background/60 p-4">
                      <p className="text-sm font-medium text-foreground">Resources</p>
                      <div className="mt-2 flex flex-wrap items-center gap-4 text-sm">
                        <Link href={appInfo.termsUrl} className="text-primary hover:underline font-medium">
                          Terms
                        </Link>
                        <Link href="/settings/support" className="text-primary hover:underline font-medium">
                          Support
                        </Link>
                      </div>
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
