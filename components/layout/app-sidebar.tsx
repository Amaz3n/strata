"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { AnimatePresence, motion } from "framer-motion"
import { OptimisticLink, useOptimisticPathname } from "@/lib/navigation/optimistic-pathname"
import {
  ArrowLeft,
  BarChart3,
  Bell,
  Bug,
  Building2,
  CalendarDays,
  ClipboardCheck,
  Contact,
  CreditCard,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Gavel,
  HardHat,
  Home,
  Link2,
  Layers,
  MapPin,
  Receipt,
  Settings,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Tag,
  Target,
  User as UserIcon,
  Users,
  Wallet,
} from "@/components/icons"
import type { LucideIcon } from "@/components/icons"
import { NavMain } from "./nav-main"
import { NavUser } from "./nav-user"
import { OrgSwitcher } from "./org-switcher"
import { DivisionContextSwitcher } from "./division-context-switcher"
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
import type { User } from "@/lib/types"
import type { ProductTier } from "@/lib/product-tier"
import { terminology } from "@/lib/terminology"
import { useSidebarProjects } from "./use-sidebar-projects"
import {
  buildProjectNavGroups,
  getProjectIdFromPath,
  getProjectSection,
  type ProjectNavGroup,
  type ProjectNavItem,
  type ProjectNavSubItem,
} from "./project-nav-items"

interface AppSidebarProps {
  user?: User | null
  pipelineBadgeCount?: number
  myWorkBadgeCount?: number
  readyToBillBadgeCount?: number
  projectReviewBadgeCounts?: Record<string, number>
  canAccessPlatform?: boolean
  permissions?: string[]
  whatsNewUnreadCount?: number
  productTier?: ProductTier
  hasDivisions?: boolean
  divisions?: Array<{ id: string; name: string }>
  divisionId?: string
  showProductionNavigation?: boolean
  showPurchasingNavigation?: boolean
  showPipelineNavigation?: boolean
}

type SidebarNavSubItem = ProjectNavSubItem
type SidebarNavItem = ProjectNavItem
type SidebarNavGroup = ProjectNavGroup

const settingsItems: SidebarNavItem[] = [
  { title: "Profile", url: "/settings?tab=profile", icon: UserIcon },
  { title: "Organization", url: "/settings?tab=organization", icon: Building2 },
  { title: "Divisions", url: "/settings/divisions", icon: Building2 },
  { title: "Invoicing", url: "/settings?tab=invoicing", icon: Receipt },
  { title: "Billing", url: "/settings?tab=billing", icon: CreditCard },
  { title: "Notifications", url: "/settings?tab=notifications", icon: Bell },
  { title: "Appearance", url: "/settings?tab=appearance", icon: SlidersHorizontal },
  { title: "Integrations", url: "/settings?tab=integrations", icon: Link2 },
  { title: "Team", url: "/settings?tab=team", icon: Users },
  { title: "Cost Codes", url: "/settings?tab=cost-codes", icon: Tag },
  { title: "Data Imports", url: "/settings/imports", icon: FileSpreadsheet, requiredAny: ["import.manage"] },
  { title: "Markup Rules", url: "/settings/markup-rules", icon: SlidersHorizontal },
  { title: "Billing Rates", url: "/settings/billing-rates", icon: Wallet },
  { title: "Templates", url: "/settings/templates", icon: FileText },
  { title: "Warranty", url: "/settings/warranty", icon: ShieldCheck, requiredAny: ["warranty.manage"] },
  { title: "Vendor Compliance", url: "/settings?tab=compliance", icon: ShieldCheck },
  { title: "About", url: "/settings?tab=about", icon: Settings },
]

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
  myWorkBadgeCount?: number,
  readyToBillBadgeCount?: number,
  canAccessPlatform?: boolean,
  productTier: ProductTier = "residential",
  showProductionNavigation = false,
  showPurchasingNavigation = false,
  showPipelineNavigation = true,
): SidebarNavGroup[] {
  const orgTerms = terminology(productTier)
  const workspaceItems: SidebarNavItem[] = [
    {
      title: "Home",
      url: "/",
      icon: Home,
      isActive: pathname === "/",
    },
    {
      title: "Tasks",
      url: "/tasks",
      icon: ClipboardCheck,
      isActive: pathname.startsWith("/tasks") || pathname.startsWith("/my-work"),
      badge: myWorkBadgeCount && myWorkBadgeCount > 0 ? myWorkBadgeCount : undefined,
      requiredAny: ["org.member"],
    },
    {
      title: orgTerms.projects,
      url: "/projects",
      icon: FolderOpen,
      isActive: pathname === "/projects" || pathname.startsWith("/projects?"),
      requiredAny: ["org.member", "project.read"],
    },
    showPipelineNavigation ? {
      title: "Pipeline",
      url: "/pipeline",
      icon: Contact,
      isActive: pathname.startsWith("/pipeline"),
      badge: pipelineBadgeCount && pipelineBadgeCount > 0 ? pipelineBadgeCount : undefined,
      requiredAny: ["pipeline.read", "pipeline.write"],
    } : null,
  ].filter(Boolean) as SidebarNavItem[]

  if (showProductionNavigation) {
    workspaceItems.splice(
      workspaceItems.length,
      0,
      {
        title: "Communities",
        url: "/communities",
        icon: MapPin,
        isActive: pathname.startsWith("/communities"),
        requiredAny: ["community.read"],
      },
      {
        title: "Plans",
        url: "/plans",
        icon: Layers,
        isActive: pathname.startsWith("/plans"),
        requiredAny: ["plan.read"],
      },
      {
        title: "Design Studio",
        url: "/design-studio",
        icon: SlidersHorizontal,
        isActive: pathname.startsWith("/design-studio"),
        requiredAny: ["selections.read", "design_studio.manage"],
      },
      {
        title: "Sales",
        url: "/sales",
        icon: Target,
        isActive: pathname.startsWith("/sales"),
        requiredAny: ["sales.read"],
      },
      {
        title: "Starts",
        url: "/starts",
        icon: CalendarDays,
        isActive: pathname.startsWith("/starts"),
        requiredAny: ["start.read"],
      },
      {
        title: "My Houses",
        url: "/my-houses",
        icon: HardHat,
        isActive: pathname.startsWith("/my-houses"),
        requiredAny: ["start.read"],
      },
      {
        title: "Warranty",
        url: "/warranty",
        icon: ShieldCheck,
        isActive: pathname.startsWith("/warranty"),
        requiredAny: ["warranty.read"],
      },
    )
  }

  const officeItems: SidebarNavItem[] = [
    ...(showPurchasingNavigation ? [{
      title: "Purchasing",
      url: "/purchasing",
      icon: Receipt,
      isActive: pathname.startsWith("/purchasing"),
      requiredAny: ["price_book.read"],
    }] : []),
    {
      title: "Billing",
      url: "/billing",
      icon: Wallet,
      isActive: pathname.startsWith("/billing"),
      badge: readyToBillBadgeCount && readyToBillBadgeCount > 0 ? readyToBillBadgeCount : undefined,
      requiredAny: ["invoice.read"],
    },
    {
      title: "Payables",
      url: "/payables",
      icon: CreditCard,
      isActive: pathname.startsWith("/payables"),
      requiredAny: ["bill.read", "payment.read"],
    },
    ...(productTier === "production" ? [] : [{
      title: "Bids",
      url: "/bids",
      icon: Gavel,
      isActive: pathname.startsWith("/bids"),
      requiredAny: ["bid.read", "bid.write"],
    }]),
    ...(productTier === "production" ? [] : [{
      title: "Schedule",
      url: "/schedule",
      icon: CalendarDays,
      isActive: pathname.startsWith("/schedule"),
      requiredAny: ["schedule.read"],
    }]),
    {
      title: "Directory",
      url: "/directory",
      icon: Building2,
      isActive: pathname.startsWith("/directory"),
      requiredAny: ["directory.read", "directory.write"],
    },
    {
      title: "Reports",
      url: "/reports",
      icon: BarChart3,
      isActive: pathname.startsWith("/reports"),
      requiredAny: ["report.read"],
    },
  ]

  if (productTier === "commercial") {
    officeItems.push({
      title: "Safety",
      url: "/safety",
      icon: ShieldCheck,
      isActive: pathname.startsWith("/safety"),
      requiredAny: ["safety.read"],
    })
  }

  const groups: SidebarNavGroup[] = [{ items: workspaceItems }, { label: "Office", items: officeItems }]

  if (canAccessPlatform) {
    groups.push({
      label: "Platform",
      items: [
        {
          title: "Platform",
          url: "/platform",
          icon: Shield,
          isActive: pathname === "/platform",
        },
        {
          title: "Issues",
          url: "/platform/bugs",
          icon: Bug,
          isActive: pathname.startsWith("/platform/bugs"),
        },
      ],
    })
  }

  return groups
}

export function AppSidebar({
  user,
  pipelineBadgeCount,
  myWorkBadgeCount,
  readyToBillBadgeCount,
  projectReviewBadgeCounts = {},
  canAccessPlatform,
  permissions = [],
  whatsNewUnreadCount = 0,
  productTier = "residential",
  hasDivisions = false,
  divisions = [],
  divisionId,
  showProductionNavigation = false,
  showPurchasingNavigation = false,
  showPipelineNavigation = true,
}: AppSidebarProps) {
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
  const navigateSettingsItem = (item: SidebarNavItem) => {
    const tab = new URLSearchParams(item.url.split("?")[1] ?? "").get("tab")
    const isDirty = Boolean((window as typeof window & { __arcSettingsDirty?: boolean }).__arcSettingsDirty)
    if (isDirty && !window.confirm("Discard unsaved settings changes?")) return

    if (tab) {
      setActiveSettingsTab(tab)
      router.replace(settingsHref(tab), { scroll: false })
      return
    }

    router.push(item.url)
  }
  useEffect(() => {
    setActiveSettingsTab(searchParams.get("tab") ?? "profile")
  }, [searchParams])

  const navGroups = useMemo(() => {
    if (isSettings) return [] as SidebarNavGroup[]
    if (isProject && projectId) {
      return filterGroups(
        buildProjectNavGroups({
          projectId,
          section,
          project: currentProject,
          reviewBadgeCount: projectReviewBadgeCounts[projectId],
          orgTier: productTier,
        }),
        permissionSet,
      )
    }
    return filterGroups(
      buildWorkspaceGroups(pathname, pipelineBadgeCount, myWorkBadgeCount, readyToBillBadgeCount, canAccessPlatform, productTier, showProductionNavigation, showPurchasingNavigation, showPipelineNavigation),
      permissionSet,
    )
  }, [isSettings, isProject, projectId, section, currentProject, pathname, pipelineBadgeCount, myWorkBadgeCount, readyToBillBadgeCount, canAccessPlatform, permissionSet, projectReviewBadgeCounts, productTier, showProductionNavigation, showPurchasingNavigation, showPipelineNavigation])

  const navMain = navGroups.map((group) => ({
    ...group,
    items: group.items.map((item) => ({
      ...item,
      isActive: !item.disabled && (item.isActive || pathname === item.url),
    })),
  }))
  const visibleSettingsItems = settingsItems.filter(
    (item) => item.title !== "Divisions" || showProductionNavigation || hasDivisions,
  )

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
        <div className="space-y-2 px-2 py-2">
          {hasDivisions ? <DivisionContextSwitcher divisions={divisions} divisionId={divisionId} /> : null}
          <SidebarProjectSwitcher projectId={projectId ?? undefined} />
        </div>
      )}
      <SidebarContent>
        {isSettings ? (
          <SidebarGroup>
            <SidebarGroupLabel>Settings</SidebarGroupLabel>
            <SidebarMenu>
              {visibleSettingsItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    tooltip={item.title}
                    isActive={item.url.includes("?tab=") ? activeSettingsTab === new URLSearchParams(item.url.split("?")[1] ?? "").get("tab") : pathname === item.url}
                    onClick={() => navigateSettingsItem(item)}
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
        <NavUser
          user={user}
          canAccessPlatform={canAccessPlatform}
          whatsNewUnreadCount={whatsNewUnreadCount}
        />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
