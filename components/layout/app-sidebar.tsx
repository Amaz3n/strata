"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { AnimatePresence, motion } from "framer-motion"
import { OptimisticLink, useOptimisticPathname } from "@/lib/navigation/optimistic-pathname"
import {
  ArrowLeft,
  Bell,
  Briefcase,
  Building2,
  Contact,
  CreditCard,
  Flag,
  FolderOpen,
  Hammer,
  HardHat,
  Home,
  LayoutDashboard,
  Link2,
  Receipt,
  Settings,
  Shield,
  SlidersHorizontal,
  Tag,
  User as UserIcon,
  Users,
  Wallet,
} from "@/components/icons"
import type { LucideIcon } from "@/components/icons"
import { NavMain } from "./nav-main"
import { NavUser } from "./nav-user"
import { OrgSwitcher } from "./org-switcher"
import { SidebarProjectSwitcher } from "./sidebar-project-switcher"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
} from "@/components/ui/sidebar"
import type { Project, User } from "@/lib/types"
import { getProjectFinancialFeatureConfig } from "@/lib/financials/billing-model"
import { useSidebarProjects } from "./use-sidebar-projects"

interface AppSidebarProps {
  user?: User | null
  pipelineBadgeCount?: number
  canAccessPlatform?: boolean
  permissions?: string[]
}

type SidebarNavSubItem = {
  title: string
  url: string
  isActive?: boolean
  requiredAny?: string[]
}

type SidebarNavItem = {
  title: string
  url: string
  icon?: LucideIcon
  isActive?: boolean
  badge?: number
  disabled?: boolean
  requiredAny?: string[]
  items?: SidebarNavSubItem[]
}

type SidebarNavGroup = {
  label?: string
  items: SidebarNavItem[]
}

const settingsItems: SidebarNavItem[] = [
  { title: "Profile", url: "/settings?tab=profile", icon: UserIcon },
  { title: "Organization", url: "/settings?tab=organization", icon: Building2 },
  { title: "Invoicing", url: "/settings?tab=invoicing", icon: Receipt },
  { title: "Billing", url: "/settings?tab=billing", icon: CreditCard },
  { title: "Notifications", url: "/settings?tab=notifications", icon: Bell },
  { title: "Appearance", url: "/settings?tab=appearance", icon: SlidersHorizontal },
  { title: "Integrations", url: "/settings?tab=integrations", icon: Link2 },
  { title: "Team", url: "/settings?tab=team", icon: Users },
  { title: "Cost Codes", url: "/settings?tab=cost-codes", icon: Tag },
  { title: "Markup Rules", url: "/settings/markup-rules", icon: Tag },
  { title: "Vendor Compliance", url: "/settings?tab=compliance", icon: Settings },
  { title: "About", url: "/settings?tab=about", icon: Shield },
]

function getProjectIdFromPath(pathname: string): string | null {
  if (pathname === "/projects" || pathname.startsWith("/projects?")) return null
  const match = pathname.match(/^\/projects\/([^/]+)/)
  return match?.[1] ?? null
}

function getProjectSection(pathname: string): string {
  if (pathname.includes("/drawings")) return "drawings"
  if (pathname.includes("/rfis")) return "rfis"
  if (pathname.includes("/submittals")) return "submittals"
  if (pathname.includes("/decisions")) return "decisions"
  if (pathname.includes("/signatures")) return "signatures"
  if (pathname.includes("/documents")) return "documents"
  if (pathname.includes("/bids")) return "bids"
  if (pathname.includes("/change-orders")) return "change-orders"
  if (pathname.includes("/invoices")) return "invoices"
  if (pathname.includes("/financials/receivables")) return "receivables"
  if (pathname.includes("/budget")) return "budget"
  if (pathname.includes("/commitments")) return "commitments"
  if (pathname.includes("/payables")) return "payables"
  if (pathname.includes("/cost-inbox")) return "cost-inbox"
  if (pathname.includes("/time")) return "time"
  if (pathname.includes("/expenses")) return "expenses"
  if (pathname.includes("/reports")) return "reports"
  if (pathname.includes("/schedule")) return "schedule"
  if (pathname.includes("/tasks")) return "tasks"
  if (pathname.includes("/daily-logs")) return "daily-logs"
  if (pathname.includes("/punch")) return "punch"
  if (pathname.includes("/closeout")) return "closeout"
  if (pathname.includes("/warranty")) return "warranty"
  if (pathname.includes("/financials")) return "financials"
  return "overview"
}

function canAccess(requiredAny: string[] | undefined, permissions: Set<string>) {
  if (!requiredAny || requiredAny.length === 0) return true
  if (permissions.has("*") || permissions.has("org.admin")) return true
  return requiredAny.some((permission) => permissions.has(permission))
}

function filterGroups(groups: SidebarNavGroup[], permissions: Set<string>): SidebarNavGroup[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items
        .map((item) => {
          const subs = item.items?.filter((sub) => canAccess(sub.requiredAny, permissions))
          return { ...item, items: subs }
        })
        .filter((item) => {
          if (!canAccess(item.requiredAny, permissions)) return false
          // Drop a parent if it had sub-items but none survive permission filtering
          if (Array.isArray(item.items) && item.items.length === 0) return false
          return true
        }),
    }))
    .filter((group) => group.items.length > 0)
}

function buildWorkspaceGroups(
  pathname: string,
  pipelineBadgeCount?: number,
  canAccessPlatform?: boolean,
): SidebarNavGroup[] {
  const items: SidebarNavItem[] = [
    {
      title: "Home",
      url: "/",
      icon: Home,
      isActive: pathname === "/",
    },
    {
      title: "Projects",
      url: "/projects",
      icon: FolderOpen,
      isActive: pathname === "/projects" || pathname.startsWith("/projects?"),
      requiredAny: ["org.member", "project.read"],
    },
    {
      title: "Financial Control",
      url: "/financial-control",
      icon: Wallet,
      isActive: pathname.startsWith("/financial-control"),
      requiredAny: ["invoice.read"],
    },
    {
      title: "Pipeline",
      url: "/pipeline",
      icon: Contact,
      isActive: pathname.startsWith("/pipeline"),
      badge: pipelineBadgeCount && pipelineBadgeCount > 0 ? pipelineBadgeCount : undefined,
      requiredAny: ["pipeline.read", "pipeline.write"],
    },
    {
      title: "Directory",
      url: "/directory",
      icon: Building2,
      isActive: pathname.startsWith("/directory"),
      requiredAny: ["directory.read", "directory.write"],
    },
  ]

  return [{ items }]
}

function getFinancialLandingUrl(projectId: string, project?: Project) {
  const base = `/projects/${projectId}`
  if (!project) return `${base}/financials`
  const config = getProjectFinancialFeatureConfig(project, project.billing_contract)
  if (config.landingPage === "receivables") return `${base}/financials/receivables`
  if (config.landingPage === "budget") return `${base}/financials/budget`
  return `${base}/financials`
}

function buildFinancialSubs(projectId: string, section: string, project?: Project): SidebarNavSubItem[] {
  const base = `/projects/${projectId}`
  const url = (suffix = "") => `${base}${suffix}`
  const config = project ? getProjectFinancialFeatureConfig(project, project.billing_contract) : null

  return [
    config?.showInbox === false
      ? null
      : { title: "Inbox", url: url("/financials"), isActive: section === "financials" || section === "cost-inbox", requiredAny: ["budget.read", "invoice.read", "bill.read", "payment.read", "draw.read", "commitment.read"] },
    { title: "Budget", url: url("/financials/budget"), isActive: section === "budget" || section === "commitments", requiredAny: ["budget.read", "commitment.read"] },
    { title: "Receivables", url: url("/financials/receivables"), isActive: section === "receivables" || section === "invoices", requiredAny: ["invoice.read", "payment.read", "draw.read"] },
    { title: "Payables", url: url("/financials/payables"), isActive: section === "payables", requiredAny: ["bill.read", "commitment.read"] },
    config?.showTime === false
      ? null
      : { title: "Time", url: url("/time"), isActive: section === "time", requiredAny: ["invoice.read", "invoice.write"] },
    config?.showExpenses === false
      ? null
      : { title: "Expenses", url: url("/expenses"), isActive: section === "expenses", requiredAny: ["invoice.read", "invoice.write", "bill.read"] },
    { title: "Change Orders", url: url("/change-orders"), isActive: section === "change-orders", requiredAny: ["change_order.read"] },
  ].filter(Boolean) as SidebarNavSubItem[]
}

function buildProjectGroups(projectId: string, section: string, project?: Project): SidebarNavGroup[] {
  const base = `/projects/${projectId}`
  const url = (suffix = "") => `${base}${suffix}`
  const financialSections = ["financials", "budget", "commitments", "payables", "receivables", "invoices", "reports", "time", "expenses", "change-orders", "cost-inbox"]

  const planSubs: SidebarNavSubItem[] = [
    { title: "Documents", url: url("/documents"), isActive: section === "documents", requiredAny: ["docs.read"] },
    { title: "Drawings", url: url("/drawings"), isActive: section === "drawings", requiredAny: ["drawing.read", "docs.read"] },
    { title: "Bids", url: url("/bids"), isActive: section === "bids", requiredAny: ["bid.read", "bid.write"] },
    { title: "Signatures", url: url("/signatures"), isActive: section === "signatures", requiredAny: ["signature.read", "signature.send"] },
  ]
  const buildSubs: SidebarNavSubItem[] = [
    { title: "Schedule", url: url("/schedule"), isActive: section === "schedule", requiredAny: ["schedule.read"] },
    { title: "Daily Logs", url: url("/daily-logs"), isActive: section === "daily-logs", requiredAny: ["daily_log.read"] },
    { title: "Punch", url: url("/punch"), isActive: section === "punch", requiredAny: ["punch.read", "punch.write"] },
    { title: "RFIs", url: url("/rfis"), isActive: section === "rfis", requiredAny: ["rfi.read"] },
    { title: "Submittals", url: url("/submittals"), isActive: section === "submittals", requiredAny: ["submittal.read"] },
    { title: "Decisions", url: url("/decisions"), isActive: section === "decisions", requiredAny: ["decision.read", "decision.write"] },
  ]
  const financialSubs = buildFinancialSubs(projectId, section, project)
  const closeSubs: SidebarNavSubItem[] = [
    { title: "Closeout", url: url("/closeout"), isActive: section === "closeout", requiredAny: ["closeout.read", "closeout.write"] },
    { title: "Warranty", url: url("/warranty"), isActive: section === "warranty", requiredAny: ["warranty.read", "warranty.write"] },
  ]

  return [
    {
      items: [
        {
          title: "Overview",
          url: url(),
          icon: LayoutDashboard,
          isActive: section === "overview",
          requiredAny: ["org.member", "project.read"],
        },
        {
          title: "Plan",
          url: url("/documents"),
          icon: Briefcase,
          isActive: planSubs.some((s) => s.isActive),
          items: planSubs,
        },
        {
          title: "Build",
          url: url("/schedule"),
          icon: Hammer,
          isActive: buildSubs.some((s) => s.isActive),
          items: buildSubs,
        },
        {
          title: "Financials",
          url: getFinancialLandingUrl(projectId, project),
          icon: Wallet,
          isActive: financialSubs.some((s) => s.isActive) || financialSections.includes(section),
          items: financialSubs,
        },
        {
          title: "Close",
          url: url("/closeout"),
          icon: Flag,
          isActive: closeSubs.some((s) => s.isActive),
          items: closeSubs,
        },
      ],
    },
  ]
}

export function AppSidebar({ user, pipelineBadgeCount, canAccessPlatform, permissions = [] }: AppSidebarProps) {
  const pathname = useOptimisticPathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const isSettings = pathname.startsWith("/settings")
  const projectId = getProjectIdFromPath(pathname)
  const isProject = Boolean(projectId)
  const section = getProjectSection(pathname)
  const permissionSet = useMemo(() => new Set(permissions), [permissions])
  const { projects } = useSidebarProjects()
  const currentProject = useMemo(
    () => projects.find((project) => project.id === projectId),
    [projects, projectId],
  )

  const [activeSettingsTab, setActiveSettingsTab] = useState(searchParams.get("tab") ?? "profile")
  const settingsReturnTo = searchParams.get("returnTo") || "/"
  const settingsHref = (tab: string) => {
    const params = new URLSearchParams()
    params.set("tab", tab)
    if (settingsReturnTo) params.set("returnTo", settingsReturnTo)
    return `/settings?${params.toString()}`
  }
  const switchSettingsTab = (tab: string) => {
    setActiveSettingsTab(tab)
    window.history.replaceState(null, "", settingsHref(tab))
    window.dispatchEvent(new CustomEvent("arc-settings-tab-change", { detail: tab }))
  }
  useEffect(() => {
    setActiveSettingsTab(searchParams.get("tab") ?? "profile")
  }, [searchParams])
  useEffect(() => {
    const handleSettingsTabChange = (event: Event) => {
      setActiveSettingsTab((event as CustomEvent<string>).detail)
    }
    window.addEventListener("arc-settings-tab-change", handleSettingsTabChange)
    return () => window.removeEventListener("arc-settings-tab-change", handleSettingsTabChange)
  }, [])

  const navGroups = useMemo(() => {
    if (isSettings) return [] as SidebarNavGroup[]
    if (isProject && projectId) {
      return filterGroups(buildProjectGroups(projectId, section, currentProject), permissionSet)
    }
    return filterGroups(
      buildWorkspaceGroups(pathname, pipelineBadgeCount, canAccessPlatform),
      permissionSet,
    )
  }, [isSettings, isProject, projectId, section, currentProject, pathname, pipelineBadgeCount, canAccessPlatform, permissionSet])

  const navMain = navGroups.map((group) => ({
    ...group,
    items: group.items.map((item) => ({
      ...item,
      isActive: !item.disabled && (item.isActive || pathname === item.url),
    })),
  }))

  const orgData = {
    name: "Arc Construction",
    logo: HardHat,
    plan: "Pro",
  }

  const headerKey = isSettings ? "settings" : isProject ? "project" : "workspace"

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-14 flex items-stretch p-2">
        <AnimatePresence initial={false} mode="wait">
          <motion.div
            key={headerKey}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.14, ease: "easeOut" }}
            className="flex w-full"
          >
            {isSettings ? (
              <SidebarMenu className="w-full">
                <SidebarMenuItem>
                  <SidebarMenuButton
                    tooltip="Back"
                    onClick={() => {
                      router.push(settingsReturnTo)
                    }}
                    className="h-10 text-xs uppercase tracking-wider text-sidebar-foreground/70 hover:text-sidebar-foreground"
                  >
                    <ArrowLeft />
                    <span>Back</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            ) : isProject ? (
              <div className="flex w-full items-stretch border border-sidebar-border/70 group-data-[collapsible=icon]:border-transparent">
                <OptimisticLink
                  href="/projects"
                  aria-label="All projects"
                  title="All projects"
                  className="flex h-10 w-9 shrink-0 items-center justify-center border-r border-sidebar-border/70 text-sidebar-foreground/55 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground group-data-[collapsible=icon]:hidden"
                >
                  <ArrowLeft className="size-4" />
                </OptimisticLink>
                <div className="min-w-0 flex-1">
                  <SidebarProjectSwitcher projectId={projectId ?? undefined} />
                </div>
              </div>
            ) : (
              <OrgSwitcher org={orgData} />
            )}
          </motion.div>
        </AnimatePresence>
      </SidebarHeader>
      <SidebarSeparator className="mx-0" />
      {!isSettings && !isProject && (
        <div className="px-2 py-2">
          <SidebarProjectSwitcher projectId={projectId ?? undefined} />
        </div>
      )}
      <SidebarContent>
        {isSettings ? (
          <SidebarGroup>
            <SidebarGroupLabel>Settings</SidebarGroupLabel>
            <SidebarMenu>
              {settingsItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    tooltip={item.title}
                    isActive={activeSettingsTab === new URLSearchParams(item.url.split("?")[1] ?? "").get("tab")}
                    onClick={() => switchSettingsTab(new URLSearchParams(item.url.split("?")[1] ?? "").get("tab") ?? "profile")}
                  >
                    {item.icon && <item.icon />}
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ) : (
          <AnimatePresence initial={false} mode="wait">
            <motion.div
              key={isProject ? "nav-project" : "nav-workspace"}
              initial={{ opacity: 0, y: 2 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -2 }}
              transition={{ duration: 0.12, ease: "easeOut" }}
            >
              <NavMain items={navMain} />
            </motion.div>
          </AnimatePresence>
        )}
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} canAccessPlatform={canAccessPlatform} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
