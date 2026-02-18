"use client"

import { usePathname } from "next/navigation"
import {
  Home,
  LayoutDashboard,
  FileText,
  MessageSquare,
  Receipt,
  HardHat,
  ClipboardCheck,
  ClipboardList,
  CheckSquare,
  CalendarDays,
  Camera,
  FolderOpen,
  Building2,
  Contact,
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
  SidebarHeader,
  SidebarRail,
  SidebarSeparator,
} from "@/components/ui/sidebar"
import type { User } from "@/lib/types"

interface AppSidebarProps {
  user?: User | null
  pipelineBadgeCount?: number
  canAccessPlatform?: boolean
}

type SidebarNavItem = {
  title: string
  url: string
  icon?: LucideIcon
  isActive?: boolean
  badge?: number
  disabled?: boolean
}

type SidebarNavGroup = {
  label?: string
  items: SidebarNavItem[]
}

function getProjectIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/projects\/([^/]+)/)
  return match?.[1] ?? null
}

function getProjectSection(pathname: string): string {
  if (pathname.includes("/drawings")) return "documents"
  if (pathname.includes("/rfis")) return "rfis"
  if (pathname.includes("/submittals")) return "submittals"
  if (pathname.includes("/decisions")) return "decisions"
  if (pathname.includes("/documents")) return "signatures"
  if (pathname.includes("/files")) return "documents"
  if (pathname.includes("/proposals")) return "proposals"
  if (pathname.includes("/bids")) return "bids"
  if (pathname.includes("/change-orders")) return "change-orders"
  if (pathname.includes("/invoices")) return "invoices"
  if (pathname.includes("/budget")) return "budget"
  if (pathname.includes("/commitments")) return "commitments"
  if (pathname.includes("/payables")) return "payables"
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

function buildGlobalNavigation(pathname: string, pipelineBadgeCount?: number, canAccessPlatform?: boolean): SidebarNavGroup[] {
  const workspaceItems: SidebarNavItem[] = [
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
      isActive: pathname === "/projects",
    },
    {
      title: "Pipeline",
      url: "/pipeline",
      icon: Contact,
      isActive: pathname === "/pipeline",
      badge: pipelineBadgeCount && pipelineBadgeCount > 0 ? pipelineBadgeCount : undefined,
    },
    {
      title: "Messages",
      url: "/messages",
      icon: MessageSquare,
      isActive: pathname.startsWith("/messages"),
    },
    {
      title: "Directory",
      url: "/directory",
      icon: Building2,
      isActive: pathname.startsWith("/directory"),
    },
  ]

  if (canAccessPlatform) {
    workspaceItems.push({
      title: "Platform",
      url: "/platform",
      icon: HardHat,
      isActive: pathname.startsWith("/platform"),
    })
  }

  return [{ label: "Workspace", items: workspaceItems }]
}

function buildProjectNavigation(projectId: string | null, section: string): SidebarNavGroup[] {
  const hasProject = Boolean(projectId)
  const base = hasProject ? `/projects/${projectId}` : "/projects"
  const financialSections = ["financials", "budget", "commitments", "payables", "invoices", "reports"]

  const scopedUrl = (suffix = "") => {
    if (!hasProject) return "/projects"
    return `${base}${suffix}`
  }

  return [
    {
      label: "Current Project",
      items: [
        {
          title: "Overview",
          url: scopedUrl(),
          icon: LayoutDashboard,
          isActive: hasProject && section === "overview",
          disabled: !hasProject,
        },
        {
          title: "Documents",
          url: scopedUrl("/files"),
          icon: FileText,
          isActive: hasProject && section === "documents",
          disabled: !hasProject,
        },
        {
          title: "Schedule",
          url: scopedUrl("/schedule"),
          icon: CalendarDays,
          isActive: hasProject && section === "schedule",
          disabled: !hasProject,
        },
        {
          title: "RFIs",
          url: scopedUrl("/rfis"),
          icon: MessageSquare,
          isActive: hasProject && section === "rfis",
          disabled: !hasProject,
        },
        {
          title: "Submittals",
          url: scopedUrl("/submittals"),
          icon: ClipboardCheck,
          isActive: hasProject && section === "submittals",
          disabled: !hasProject,
        },
        {
          title: "Decisions",
          url: scopedUrl("/decisions"),
          icon: CheckSquare,
          isActive: hasProject && section === "decisions",
          disabled: !hasProject,
        },
        {
          title: "Daily Logs",
          url: scopedUrl("/daily-logs"),
          icon: Camera,
          isActive: hasProject && section === "daily-logs",
          disabled: !hasProject,
        },
        {
          title: "Punch",
          url: scopedUrl("/punch"),
          icon: ClipboardList,
          isActive: hasProject && section === "punch",
          disabled: !hasProject,
        },
        {
          title: "Financials",
          url: scopedUrl("/financials"),
          icon: Receipt,
          isActive: hasProject && financialSections.includes(section),
          disabled: !hasProject,
        },
        {
          title: "Change Orders",
          url: scopedUrl("/change-orders"),
          icon: ClipboardList,
          isActive: hasProject && section === "change-orders",
          disabled: !hasProject,
        },
        {
          title: "Signatures",
          url: scopedUrl("/documents"),
          icon: ClipboardCheck,
          isActive: hasProject && section === "signatures",
          disabled: !hasProject,
        },
        {
          title: "Bids",
          url: scopedUrl("/bids"),
          icon: ClipboardList,
          isActive: hasProject && section === "bids",
          disabled: !hasProject,
        },
        {
          title: "Proposals",
          url: scopedUrl("/proposals"),
          icon: FileText,
          isActive: hasProject && section === "proposals",
          disabled: !hasProject,
        },
        {
          title: "Closeout",
          url: scopedUrl("/closeout"),
          icon: CheckSquare,
          isActive: hasProject && section === "closeout",
          disabled: !hasProject,
        },
        {
          title: "Warranty",
          url: scopedUrl("/warranty"),
          icon: ClipboardCheck,
          isActive: hasProject && section === "warranty",
          disabled: !hasProject,
        },
      ],
    },
  ]
}

export function AppSidebar({ user, pipelineBadgeCount, canAccessPlatform }: AppSidebarProps) {
  const pathname = usePathname()
  const projectId = getProjectIdFromPath(pathname)
  const section = getProjectSection(pathname)

  const navMain = [...buildGlobalNavigation(pathname, pipelineBadgeCount, canAccessPlatform), ...buildProjectNavigation(projectId, section)].map((group) => ({
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

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-14 flex items-center justify-center p-2">
        <OrgSwitcher org={orgData} />
      </SidebarHeader>
      <SidebarSeparator className="mx-0" />
      <div className="px-2 py-2">
        <SidebarProjectSwitcher projectId={projectId ?? undefined} />
      </div>
      <SidebarContent>
        <NavMain items={navMain} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
