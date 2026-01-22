"use client"

import { useEffect, useMemo, useState } from "react"

import * as TabsPrimitive from "@radix-ui/react-tabs"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { NotificationPreferences } from "@/components/settings/notification-preferences"
import { ComplianceSettings } from "@/components/settings/compliance-settings"
import { QBOConnectionCard } from "@/components/integrations/qbo-connection-card"
import { Spinner } from "@/components/ui/spinner"
import { AlertCircle, Bell, Building2, CreditCard, Link2, Settings, User as UserIcon, Users } from "@/components/icons"
import { Info } from "lucide-react"
import { getQBOConnectionAction } from "@/app/(app)/settings/integrations/actions"
import { createBillingPortalSessionAction, createCheckoutSessionAction, getBillingAction, getBillingPlansAction } from "@/app/(app)/settings/actions"
import { useIsMobile } from "@/hooks/use-mobile"
import type { QBOConnection } from "@/lib/services/qbo-connection"
import type { ComplianceRules, TeamMember, User } from "@/lib/types"
import { TeamTable } from "@/components/team/team-table"
import { InviteMemberDialog } from "@/components/team/invite-member-dialog"
import Link from "next/link"
import packageJson from "@/package.json"

const sections = [
  { value: "profile", label: "Profile", description: "Name, email, avatar", icon: UserIcon },
  { value: "organization", label: "Organization", description: "Company details", icon: Building2 },
  { value: "billing", label: "Billing", description: "Subscription details", icon: CreditCard },
  { value: "notifications", label: "Notifications", description: "How you get updates", icon: Bell },
  { value: "integrations", label: "Integrations", description: "Connect your tools", icon: Link2 },
  { value: "team", label: "Team", description: "Manage internal members", icon: Users },
  { value: "compliance", label: "Compliance", description: "Payment gating rules", icon: Settings },
  { value: "about", label: "About", description: "About this workspace", icon: Info },
  { value: "danger", label: "Danger zone", description: "Destructive actions", icon: AlertCircle },
]

const appInfo = {
  name: "Strata",
  company: "Strata",
  version: packageJson.version ?? "0.1.0",
  termsUrl: "/terms",
  logoUrl: "/icon.svg",
}

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

interface SettingsWindowProps {
  user: User | null
  initialTab?: string
  initialQboConnection?: QBOConnection | null
  variant?: "page" | "dialog"
  teamMembers?: TeamMember[]
  canManageMembers?: boolean
  canEditRoles?: boolean
  initialBilling?: BillingDetails
  canManageBilling?: boolean
  initialComplianceRules?: ComplianceRules
  canManageCompliance?: boolean
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
  teamMembers = [],
  canManageMembers = false,
  canEditRoles = false,
  initialBilling = null,
  canManageBilling = true,
  initialComplianceRules = {
    require_w9: true,
    require_insurance: true,
    require_license: false,
    require_lien_waiver: false,
    block_payment_on_missing_docs: true,
  },
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
  const initials = useMemo(() => getInitials(user), [user])
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
    if (tab !== "integrations" || hasFetchedIntegrations) return

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
  }, [tab, hasFetchedIntegrations])

  useEffect(() => {
    if (tab !== "billing") return

    if (!canManageBilling) {
      setHasFetchedBilling(true)
      setHasFetchedPlans(true)
      return
    }

    if (hasFetchedBilling) return

    let isMounted = true
    setLoadingBilling(true)
    getBillingAction()
      .then((data) => {
        if (!isMounted) return
        setBilling(data)
        setHasFetchedBilling(true)
        setBillingError(null)
      })
      .catch((error) => {
        console.error("Failed to load billing details", error)
        if (!isMounted) return
        setBillingError("Unable to load billing details.")
        setHasFetchedBilling(true)
      })
      .finally(() => {
        if (isMounted) setLoadingBilling(false)
      })

    return () => {
      isMounted = false
    }
  }, [tab, hasFetchedBilling, canManageBilling])

  useEffect(() => {
    if (tab !== "billing" || hasFetchedPlans || !canManageBilling) return

    let isMounted = true
    setLoadingPlans(true)
    getBillingPlansAction()
      .then((data) => {
        if (!isMounted) return
        setPlans(data ?? [])
        setHasFetchedPlans(true)
      })
      .catch((error) => {
        console.error("Failed to load billing plans", error)
        if (!isMounted) return
        setHasFetchedPlans(true)
      })
      .finally(() => {
        if (isMounted) setLoadingPlans(false)
      })

    return () => {
      isMounted = false
    }
  }, [tab, hasFetchedPlans, canManageBilling])

  const containerHeight =
    variant === "dialog"
      ? "flex h-[70vh] min-h-[520px] max-h-[80vh]"
      : "flex h-full min-h-[calc(100vh-8rem)]"

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

  return (
    <Tabs value={tab} onValueChange={setTab}>
      <div className={containerHeight}>
        {!isMobile && (
          <div className="w-80 border-r bg-muted/30 p-6">
            <div className="flex items-center gap-3 rounded-lg border bg-background/80 p-4 shadow-sm">
              <Avatar className="h-12 w-12">
                <AvatarImage src={user?.avatar_url || "/placeholder.svg"} alt={user?.full_name} />
                <AvatarFallback className="text-base font-semibold">{initials}</AvatarFallback>
              </Avatar>
              <div className="text-sm">
                <p className="font-semibold leading-tight">{user?.full_name ?? "Account"}</p>
                <p className="text-muted-foreground text-xs">{user?.email ?? "—"}</p>
              </div>
            </div>

            <div className="mt-8">
              <p className="mb-4 pl-1 text-xs uppercase tracking-wide text-muted-foreground font-medium">Settings</p>
              <TabsPrimitive.List className="flex w-full flex-col gap-3 bg-transparent p-0">
                {sections.map((section) => (
                  <TabsPrimitive.Trigger
                    key={section.value}
                    value={section.value}
                    className="w-full min-h-[56px] justify-start gap-3 rounded-lg border bg-background/80 px-5 py-3 text-left shadow-sm transition-all hover:border-primary/50 hover:text-primary hover:shadow-md data-[state=active]:border-primary/60 data-[state=active]:bg-primary/5 data-[state=active]:text-primary data-[state=active]:shadow-md"
                  >
                    <div className="flex items-center gap-3">
                      <section.icon className="h-5 w-5" />
                      <p className="text-sm font-medium leading-tight">{section.label}</p>
                    </div>
                  </TabsPrimitive.Trigger>
                ))}
              </TabsPrimitive.List>
            </div>
          </div>
        )}

        <div className="flex-1 flex flex-col min-w-0">
          {isMobile && (
            <div className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 p-4">
              <div className="flex items-center gap-3 mb-4">
                <Settings className="h-5 w-5 text-primary" />
                <div>
                  <h1 className="text-lg font-semibold">Settings</h1>
                  <p className="text-sm text-muted-foreground">Manage your account and preferences</p>
                </div>
              </div>
              <TabsList className="grid w-full grid-cols-2 gap-2 bg-transparent p-0">
                {sections.map((section) => (
                  <TabsTrigger
                    key={section.value}
                    value={section.value}
                    className="justify-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm shadow-sm data-[state=active]:border-primary/60 data-[state=active]:bg-primary/5 data-[state=active]:text-primary"
                  >
                    <section.icon className="h-4 w-4" />
                    {section.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
          )}

          <ScrollArea className="flex-1">
            <div className="max-w-6xl mx-auto space-y-8 p-6 lg:p-8">
              <TabsContent value="profile" className="m-0 mt-0">
                <div className="rounded-xl border bg-card shadow-sm">
                  <div className="flex flex-col gap-3 border-b px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h2 className="text-lg font-semibold">Profile</h2>
                      <p className="text-sm text-muted-foreground">Update your personal information and preferences</p>
                    </div>
                    <Button size="sm">Save changes</Button>
                  </div>
                  <div className="space-y-8 p-6 lg:p-8">
                    <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
                      <div className="flex items-center gap-4">
                        <Avatar className="h-20 w-20">
                          <AvatarImage src={user?.avatar_url || "/placeholder.svg"} alt={user?.full_name} />
                          <AvatarFallback className="text-xl font-semibold">{initials}</AvatarFallback>
                        </Avatar>
                        <div>
                          <p className="text-base font-medium">{user?.full_name ?? "Your profile"}</p>
                          <p className="text-sm text-muted-foreground">Choose a friendly face for your team</p>
                          <div className="flex gap-2 mt-3">
                            <Button variant="outline" size="sm">Change photo</Button>
                            <Button variant="ghost" size="sm">Remove</Button>
                          </div>
                        </div>
                      </div>
                    </div>

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
                        <Label htmlFor="role" className="text-sm font-medium">Role</Label>
                        <Input id="role" placeholder="Project Manager" className="h-11" />
                      </div>
                    </div>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="organization" className="m-0 mt-0">
                <div className="rounded-xl border bg-card shadow-sm">
                  <div className="flex flex-col gap-3 border-b px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h2 className="text-lg font-semibold">Organization</h2>
                      <p className="text-sm text-muted-foreground">Manage your company details and settings</p>
                    </div>
                    <Button size="sm">Save changes</Button>
                  </div>
                  <div className="space-y-8 p-6 lg:p-8">
                    <div className="grid gap-6 lg:grid-cols-2">
                      <div className="space-y-3">
                        <Label htmlFor="company" className="text-sm font-medium">Company name</Label>
                        <Input id="company" defaultValue="Thompson Construction" placeholder="Company" className="h-11" />
                      </div>
                      <div className="space-y-3">
                        <Label htmlFor="org-phone" className="text-sm font-medium">Phone</Label>
                        <Input id="org-phone" type="tel" defaultValue="(503) 555-0123" placeholder="(555) 123-4567" className="h-11" />
                      </div>
                    </div>

                    <div className="space-y-3">
                      <Label htmlFor="address" className="text-sm font-medium">Address</Label>
                      <Input id="address" defaultValue="123 Builder Lane, Portland, OR 97201" placeholder="Street, City, State" className="h-11" />
                    </div>

                    <div className="grid gap-6 lg:grid-cols-2">
                      <div className="space-y-3">
                        <Label htmlFor="timezone" className="text-sm font-medium">Timezone</Label>
                        <Input id="timezone" placeholder="Pacific Time (PT)" className="h-11" />
                      </div>
                      <div className="space-y-3">
                        <Label htmlFor="website" className="text-sm font-medium">Website</Label>
                        <Input id="website" type="url" placeholder="https://your-company.com" className="h-11" />
                      </div>
                    </div>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="billing" className="m-0 mt-0">
                <div className="rounded-xl border bg-card shadow-sm">
                  <div className="flex flex-col gap-3 border-b px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h2 className="text-lg font-semibold">Billing</h2>
                      <p className="text-sm text-muted-foreground">Subscription details for this organization</p>
                    </div>
                  </div>
                  <div className="p-6 lg:p-8 space-y-4">
                    {!canManageBilling ? (
                      <div className="text-sm text-muted-foreground">
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
                      <Card>
                        <CardHeader className="pb-4">
                          <div className="flex items-center gap-3">
                            <CardTitle>{planName}</CardTitle>
                            <Badge variant={billingStatus === "active" ? "default" : "outline"} className="capitalize">
                              {billingStatus}
                            </Badge>
                          </div>
                          <CardDescription>
                            {billing.plan?.pricing_model ?? "subscription"} • {interval} • {amount}
                          </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-2 text-sm text-muted-foreground">
                          {renewal && <div>Current period ends: {new Date(renewal).toLocaleDateString()}</div>}
                          {trialEndsAt && <div>Trial ends: {new Date(trialEndsAt).toLocaleDateString()}</div>}
                          {billing.subscription?.external_customer_id && (
                            <div>External customer: {billing.subscription.external_customer_id}</div>
                          )}
                          {billing.subscription?.external_subscription_id && (
                            <div>Invoice/subscription ref: {billing.subscription.external_subscription_id}</div>
                          )}
                        </CardContent>
                      </Card>
                    ) : (
                      <div className="text-sm text-muted-foreground">No billing details available.</div>
                    )}

                    {billingActionError && (
                      <div className="text-sm text-destructive">{billingActionError}</div>
                    )}

                    {needsSubscription && (
                      <Card>
                        <CardHeader className="pb-2">
                          <CardTitle>Start subscription</CardTitle>
                          <CardDescription>
                            {isTrialing
                              ? "Keep your workspace active by choosing a plan."
                              : "Choose a plan to activate your workspace."}
                          </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
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
                            <div className="grid gap-3">
                              <Select
                                value={selectedPlanCode ?? undefined}
                                onValueChange={setSelectedPlanCode}
                              >
                                <SelectTrigger>
                                  <SelectValue placeholder="Select a plan" />
                                </SelectTrigger>
                                <SelectContent>
                                  {plans.map((plan) => (
                                    <SelectItem key={plan.code} value={plan.code}>
                                      {plan.name} • {plan.amountCents ? `$${(plan.amountCents / 100).toFixed(0)}` : "Custom"}
                                      {plan.interval ? `/${plan.interval}` : ""}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <Button onClick={handleSubscribe} disabled={!selectedPlanCode || checkoutLoading}>
                                {checkoutLoading ? "Redirecting..." : "Subscribe"}
                              </Button>
                            </div>
                          )}
                          {isPastDue && (
                            <div className="text-xs text-muted-foreground">
                              Your subscription is past due. Update billing to keep access active.
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    )}

                    {isActive && (
                      <div className="flex justify-start">
                        <Button variant="outline" onClick={handleManageBilling} disabled={portalLoading}>
                          {portalLoading ? "Opening portal..." : "Manage billing"}
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="notifications" className="m-0 mt-0">
                <div className="max-w-2xl">
                  <NotificationPreferences />
                </div>
              </TabsContent>

              <TabsContent value="integrations" className="m-0 mt-0">
                <div className="rounded-xl border bg-card shadow-sm">
                  <div className="flex flex-col gap-2 border-b px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h2 className="text-lg font-semibold">Integrations</h2>
                      <p className="text-sm text-muted-foreground">Connect your tools to automate workflows</p>
                    </div>
                  </div>
                  <div className="p-6 lg:p-8">
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
                <div className="space-y-6">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h2 className="text-lg font-semibold">Team</h2>
                      <p className="text-sm text-muted-foreground">
                        Manage internal teammates, roles, and invites.
                      </p>
                    </div>
                    <InviteMemberDialog canInvite={canManageMembers} />
                  </div>
                  <TeamTable members={teamMembers} canManageMembers={canManageMembers} canEditRoles={canEditRoles} />
                </div>
              </TabsContent>

              <TabsContent value="compliance" className="m-0 mt-0">
                <div className="space-y-6">
                  <ComplianceSettings initialRules={initialComplianceRules} canManage={canManageCompliance} />
                </div>
              </TabsContent>

              <TabsContent value="about" className="m-0 mt-0">
                <div className="rounded-xl border bg-card shadow-sm">
                  <div className="flex flex-col gap-2 border-b px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h2 className="text-lg font-semibold">About</h2>
                      <p className="text-sm text-muted-foreground">Workspace details and metadata</p>
                    </div>
                  </div>
                  <div className="p-6 lg:p-8 space-y-6 text-sm text-muted-foreground">
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
                        <span>{billing?.org?.name ?? "Workspace"}</span>
                      </div>
                      <div className="flex flex-col gap-1">
                        <span className="text-foreground font-medium">Plan</span>
                        <span>{planName}</span>
                      </div>
                      <div className="flex flex-col gap-1">
                        <span className="text-foreground font-medium">Status</span>
                        <span className="capitalize">{billingStatus}</span>
                      </div>
                      <div className="flex flex-col gap-1">
                        <span className="text-foreground font-medium">Terms</span>
                        <Link href={appInfo.termsUrl} className="text-primary hover:underline text-sm font-medium">
                          View terms
                        </Link>
                      </div>
                    </div>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="danger" className="m-0 mt-0">
                <div className="rounded-xl border border-destructive/50 bg-destructive/5 shadow-sm max-w-2xl">
                  <div className="flex items-center justify-between border-b border-destructive/30 px-6 py-5">
                    <div>
                      <h2 className="text-lg font-semibold text-destructive">Danger zone</h2>
                      <p className="text-sm text-muted-foreground">Irreversible and destructive actions</p>
                    </div>
                    <AlertCircle className="h-5 w-5 text-destructive" />
                  </div>
                  <div className="space-y-6 p-6 lg:p-8">
                    <div className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-background/80 p-6 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="font-medium text-base">Delete organization</p>
                        <p className="text-sm text-muted-foreground mt-1">
                          Permanently delete your organization and all data. This cannot be undone.
                        </p>
                      </div>
                      <Button variant="destructive" size="sm" className="w-full sm:w-auto mt-4 sm:mt-0">
                        Delete organization
                      </Button>
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
