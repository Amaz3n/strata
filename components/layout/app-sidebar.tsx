"use client"

import { usePathname } from "next/navigation"
import {
  Home,
  LayoutDashboard,
  FileText,
  Layers,
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
  permissions?: string[]
}

type SidebarNavItem = {
  title: string
  url: string
  icon?: LucideIcon
  isActive?: boolean
  badge?: number
  disabled?: boolean
  requiredAny?: string[]
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
  if (pathname.includes("/drawings")) return "drawings"
  if (pathname.includes("/rfis")) return "rfis"
  if (pathname.includes("/submittals")) return "submittals"
  if (pathname.includes("/decisions")) return "decisions"
  if (pathname.includes("/signatures")) return "signatures"
  if (pathname.includes("/documents")) return "documents"
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

function canAccess(requiredAny: string[] | undefined, permissions: Set<string>) {
  if (!requiredAny || requiredAny.length === 0) return true
  if (permissions.has("*") || permissions.has("org.admin")) return true
  return requiredAny.some((permission) => permissions.has(permission))
}

function filterNavigation(groups: SidebarNavGroup[], permissions: Set<string>) {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => canAccess(item.requiredAny, permissions)),
    }))
    .filter((group) => group.items.length > 0)
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
      requiredAny: ["org.member", "project.read"],
    },
    {
      title: "Pipeline",
      url: "/pipeline",
      icon: Contact,
      isActive: pathname === "/pipeline",
      badge: pipelineBadgeCount && pipelineBadgeCount > 0 ? pipelineBadgeCount : undefined,
      requiredAny: ["pipeline.read", "pipeline.write"],
    },
    {
      title: "Messages",
      url: "/messages",
      icon: MessageSquare,
      isActive: pathname.startsWith("/messages"),
      requiredAny: ["message.read", "message.write"],
    },
    {
      title: "Directory",
      url: "/directory",
      icon: Building2,
      isActive: pathname.startsWith("/directory"),
      requiredAny: ["directory.read", "directory.write"],
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
          requiredAny: ["org.member", "project.read"],
        },
        {
          title: "Documents",
          url: scopedUrl("/documents"),
          icon: FileText,
          isActive: hasProject && section === "documents",
          disabled: !hasProject,
          requiredAny: ["docs.read"],
        },
        {
          title: "Drawings",
          url: scopedUrl("/drawings"),
          icon: Layers,
          isActive: hasProject && section === "drawings",
          disabled: !hasProject,
          requiredAny: ["drawing.read", "docs.read"],
        },
        {
          title: "Schedule",
          url: scopedUrl("/schedule"),
          icon: CalendarDays,
          isActive: hasProject && section === "schedule",
          disabled: !hasProject,
          requiredAny: ["schedule.read"],
        },
        {
          title: "RFIs",
          url: scopedUrl("/rfis"),
          icon: MessageSquare,
          isActive: hasProject && section === "rfis",
          disabled: !hasProject,
          requiredAny: ["rfi.read"],
        },
        {
          title: "Submittals",
          url: scopedUrl("/submittals"),
          icon: ClipboardCheck,
          isActive: hasProject && section === "submittals",
          disabled: !hasProject,
          requiredAny: ["submittal.read"],
        },
        {
          title: "Decisions",
          url: scopedUrl("/decisions"),
          icon: CheckSquare,
          isActive: hasProject && section === "decisions",
          disabled: !hasProject,
          requiredAny: ["decision.read", "decision.write"],
        },
        {
          title: "Daily Logs",
          url: scopedUrl("/daily-logs"),
          icon: Camera,
          isActive: hasProject && section === "daily-logs",
          disabled: !hasProject,
          requiredAny: ["daily_log.read"],
        },
        {
          title: "Punch",
          url: scopedUrl("/punch"),
          icon: ClipboardList,
          isActive: hasProject && section === "punch",
          disabled: !hasProject,
          requiredAny: ["punch.read", "punch.write"],
        },
        {
          title: "Financials",
          url: scopedUrl("/financials"),
          icon: Receipt,
          isActive: hasProject && financialSections.includes(section),
          disabled: !hasProject,
          requiredAny: ["budget.read", "invoice.read", "bill.read", "payment.read", "draw.read", "commitment.read"],
        },
        {
          title: "Change Orders",
          url: scopedUrl("/change-orders"),
          icon: ClipboardList,
          isActive: hasProject && section === "change-orders",
          disabled: !hasProject,
          requiredAny: ["change_order.read"],
        },
        {
          title: "Signatures",
          url: scopedUrl("/signatures"),
          icon: ClipboardCheck,
          isActive: hasProject && section === "signatures",
          disabled: !hasProject,
          requiredAny: ["signature.read", "signature.send"],
        },
        {
          title: "Bids",
          url: scopedUrl("/bids"),
          icon: ClipboardList,
          isActive: hasProject && section === "bids",
          disabled: !hasProject,
          requiredAny: ["bid.read", "bid.write"],
        },
        {
          title: "Proposals",
          url: scopedUrl("/proposals"),
          icon: FileText,
          isActive: hasProject && section === "proposals",
          disabled: !hasProject,
          requiredAny: ["proposal.read", "proposal.write"],
        },
        {
          title: "Closeout",
          url: scopedUrl("/closeout"),
          icon: CheckSquare,
          isActive: hasProject && section === "closeout",
          disabled: !hasProject,
          requiredAny: ["closeout.read", "closeout.write"],
        },
        {
          title: "Warranty",
          url: scopedUrl("/warranty"),
          icon: ClipboardCheck,
          isActive: hasProject && section === "warranty",
          disabled: !hasProject,
          requiredAny: ["warranty.read", "warranty.write"],
        },
      ],
    },
  ]
}

export function AppSidebar({ user, pipelineBadgeCount, canAccessPlatform, permissions = [] }: AppSidebarProps) {
  const pathname = usePathname()
  const projectId = getProjectIdFromPath(pathname)
  const section = getProjectSection(pathname)
  const permissionSet = new Set(permissions)

  const navMain = filterNavigation(
    [...buildGlobalNavigation(pathname, pipelineBadgeCount, canAccessPlatform), ...buildProjectNavigation(projectId, section)],
    permissionSet,
  ).map((group) => ({
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
