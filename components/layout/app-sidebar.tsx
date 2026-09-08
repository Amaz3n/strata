"use client"

import Link from "next/link"
import { visibleSettingsSections as getVisibleSettingsSections } from "@/lib/settings/sections"

import { useMemo } from "react"
import { useSearchParams } from "next/navigation"
import { AnimatePresence, motion } from "framer-motion"
import { OptimisticLink, useOptimisticNavigate, useOptimisticPathname } from "@/lib/navigation/optimistic-pathname"
import {
  ArrowLeft,
  BarChart3,
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
  Layers,
  MapPin,
  Receipt,
  Ruler,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Target,
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
import type { ProjectNavigationItem, User } from "@/lib/types"
import type { ProductTier } from "@/lib/product-tier"
import { terminology } from "@/lib/terminology"
import { useNavigationBadges } from "./navigation-badge-context"
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
  /** Loaded by the layout's cached chrome context, not fetched after hydration. */
  projects: ProjectNavigationItem[]
  canAccessPlatform?: boolean
  permissions?: string[]
  productTier?: ProductTier
  showProductionNavigation?: boolean
  showPurchasingNavigation?: boolean
  showPipelineNavigation?: boolean
  booksEnabled?: boolean
}

type SidebarNavSubItem = ProjectNavSubItem
type SidebarNavItem = ProjectNavItem
type SidebarNavGroup = ProjectNavGroup


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

  const personalItems: SidebarNavItem[] = [
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
  ]

  const homesItem: SidebarNavItem = {
    title: orgTerms.projects,
    url: "/projects",
    icon: FolderOpen,
    isActive: pathname === "/projects" || pathname.startsWith("/projects?"),
    requiredAny: ["org.member", "project.read"],
  }

  const pipelineItem: SidebarNavItem | null = showPipelineNavigation ? {
    title: "Pipeline",
    url: "/pipeline",
    icon: Contact,
    isActive: pathname.startsWith("/pipeline"),
    badge: pipelineBadgeCount && pipelineBadgeCount > 0 ? pipelineBadgeCount : undefined,
    requiredAny: ["pipeline.read", "pipeline.write"],
  } : null

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
    {
      title: "Books",
      url: "/books",
      icon: FileSpreadsheet,
      isActive: pathname.startsWith("/books"),
      requiredAny: ["books.read"],
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

  // A production builder narrates its business as sell → build → back office, so
  // the sidebar follows that spine instead of one flat list of ten. Other tiers keep
  // the single unlabelled workspace group they have always had.
  const groups: SidebarNavGroup[] = showProductionNavigation
    ? [
        { items: personalItems },
        {
          label: "Sell",
          items: [
            {
              title: "Sales",
              url: "/sales",
              icon: Target,
              isActive: pathname.startsWith("/sales"),
              requiredAny: ["sales.read"],
            },
            // Only reachable on a hybrid org (non-production tier carrying
            // production projects); a true production org has no Pipeline.
            ...(pipelineItem ? [pipelineItem] : []),
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
          ],
        },
        {
          label: "Build",
          items: [
            {
              title: "Starts",
              url: "/starts",
              icon: CalendarDays,
              isActive: pathname.startsWith("/starts"),
              requiredAny: ["start.read"],
            },
            homesItem,
            {
              title: "Warranty",
              url: "/warranty",
              icon: ShieldCheck,
              isActive: pathname.startsWith("/warranty"),
              requiredAny: ["warranty.read"],
            },
          ],
        },
        { label: "Office", items: officeItems },
      ]
    : [
        { items: [...personalItems, homesItem, ...(pipelineItem ? [pipelineItem] : [])] },
        { label: "Office", items: officeItems },
      ]

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
  projects,
  canAccessPlatform,
  permissions = [],
  productTier = "residential",
  showProductionNavigation = false,
  showPurchasingNavigation = false,
  showPipelineNavigation = true,
  booksEnabled = false,
}: AppSidebarProps) {
  const {
    pipelineBadgeCount,
    myWorkBadgeCount,
    readyToBillBadgeCount,
    projectReviewBadgeCounts,
    projectCorrespondenceBadgeCounts,
    whatsNewUnreadCount,
  } = useNavigationBadges()
  const pathname = useOptimisticPathname()
  const navigate = useOptimisticNavigate()
  const searchParams = useSearchParams()
  const isSettings = pathname.startsWith("/settings")
  const projectId = getProjectIdFromPath(pathname)
  const isProject = Boolean(projectId)
  const section = getProjectSection(pathname)
  const permissionSet = useMemo(() => new Set(permissions), [permissions])
  const currentProject = useMemo(
    () => projects.find((project) => project.id === projectId),
    [projects, projectId],
  )

  const activeSettingsTab = searchParams.get("tab") ?? "profile"
  const settingsReturnTo = searchParams.get("returnTo") || "/"
  const settingsItemHref = (item: SidebarNavItem) => {
    const tab = new URLSearchParams(item.url.split("?")[1] ?? "").get("tab")
    if (!tab) return item.url
    return `/settings?${new URLSearchParams({ tab, returnTo: settingsReturnTo })}`
  }

  const navGroups = useMemo(() => {
    if (isSettings) return [] as SidebarNavGroup[]
    if (isProject && projectId) {
      return filterGroups(
        buildProjectNavGroups({
          projectId,
          section,
          project: currentProject,
          reviewBadgeCount: projectReviewBadgeCounts[projectId],
          correspondenceBadgeCount: projectCorrespondenceBadgeCounts[projectId],
          orgTier: productTier,
        }),
        permissionSet,
      )
    }
    const groups = filterGroups(
      buildWorkspaceGroups(pathname, pipelineBadgeCount, myWorkBadgeCount, readyToBillBadgeCount, canAccessPlatform, productTier, showProductionNavigation, showPurchasingNavigation, showPipelineNavigation),
      permissionSet,
    )
    return groups.map((group) => ({
      ...group,
      items: group.items.filter((item) => item.title !== "Books" || booksEnabled),
    })).filter((group) => group.items.length > 0)
  }, [isSettings, isProject, projectId, section, currentProject, pathname, pipelineBadgeCount, myWorkBadgeCount, readyToBillBadgeCount, canAccessPlatform, permissionSet, projectReviewBadgeCounts, projectCorrespondenceBadgeCounts, productTier, showProductionNavigation, showPurchasingNavigation, showPipelineNavigation, booksEnabled])

  const navMain = navGroups.map((group) => ({
    ...group,
    items: group.items.map((item) => ({
      ...item,
      isActive: !item.disabled && (item.isActive || pathname === item.url),
    })),
  }))
  const visibleSettingsSections = getVisibleSettingsSections(permissions, productTier)

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
                      navigate(settingsReturnTo)
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
                  <SidebarProjectSwitcher projectId={projectId ?? undefined} projects={projects} />
                </div>
              </div>
            ) : (
              <OrgSwitcher org={orgData} />
            )}
          </motion.div>
        </AnimatePresence>
      </SidebarHeader>
      <SidebarSeparator className="mx-0" />
      <SidebarContent>
        {isSettings ? (
          <>
            {visibleSettingsSections.map((section) => (
              <SidebarGroup key={section.label}>
                <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
                <SidebarMenu>
                  {section.items.map((item) => (
                    <SidebarMenuItem key={item.title}>
                      <SidebarMenuButton
                        tooltip={item.title}
                        isActive={item.url.includes("?tab=") ? activeSettingsTab === new URLSearchParams(item.url.split("?")[1] ?? "").get("tab") : pathname.startsWith(item.url.split("?")[0])}
                        asChild
                      >
                        <Link href={settingsItemHref(item)} prefetch="auto" onClick={(event) => {
                          if (pathname !== "/settings" || !item.url.includes("?tab=") || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
                          event.preventDefault()
                          window.history.pushState(null, "", settingsItemHref(item))
                        }}>
                          {item.icon && <item.icon />}
                          <span>{item.title}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroup>
            ))}
          </>
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
