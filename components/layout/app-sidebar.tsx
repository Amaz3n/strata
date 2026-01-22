"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import {
  LayoutDashboard,
  FileText,
  MessageSquare,
  Receipt,
  HardHat,
  Layers,
  ClipboardCheck,
  ClipboardList,
  CheckSquare,
  CalendarDays,
  Camera,
  FolderOpen,
  Building2,
  Settings,
  Contact,
} from "@/components/icons"
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
  if (pathname.includes("/files")) return "files"
  if (pathname.includes("/proposals")) return "proposals"
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

function buildGlobalNavigation(pathname: string, pipelineBadgeCount?: number) {
  return [
    {
      label: "Workspace",
      items: [
        {
          title: "Pipeline",
          url: "/pipeline",
          icon: Contact,
          isActive: pathname === "/pipeline",
          badge: pipelineBadgeCount && pipelineBadgeCount > 0 ? pipelineBadgeCount : undefined,
        },
        {
          title: "Prospects",
          url: "/prospects",
          icon: Contact,
          isActive: pathname.startsWith("/prospects"),
        },
        {
          title: "Projects",
          url: "/projects",
          icon: FolderOpen,
          isActive: pathname.startsWith("/projects"),
        },
        {
          title: "Estimates",
          url: "/estimates",
          icon: Receipt,
          isActive: pathname.startsWith("/estimates"),
        },
        {
          title: "Proposals",
          url: "/proposals",
          icon: FileText,
          isActive: pathname.startsWith("/proposals"),
        },
        {
          title: "Directory",
          url: "/directory",
          icon: Building2,
          isActive: pathname.startsWith("/directory"),
        },
        {
          title: "Compliance",
          url: "/compliance",
          icon: CheckSquare,
          isActive: pathname.startsWith("/compliance"),
        },
        {
          title: "Settings",
          url: "/settings",
          icon: Settings,
          isActive: pathname.startsWith("/settings"),
        },
      ],
    },
  ]
}

function buildProjectNavigation(projectId: string, section: string) {
  const base = `/projects/${projectId}`
  const financialSections = ["financials", "budget", "commitments", "payables", "invoices", "reports"]
  return [
    {
      items: [
        {
          title: "Overview",
          url: base,
          icon: LayoutDashboard,
          isActive: section === "overview",
        },
        {
          title: "Schedule",
          url: `${base}/schedule`,
          icon: CalendarDays,
          isActive: section === "schedule",
        },
        {
          title: "Tasks",
          url: `${base}/tasks`,
          icon: CheckSquare,
          isActive: section === "tasks",
        },
        {
          title: "Drawings",
          url: `${base}/drawings`,
          icon: Layers,
          isActive: section === "drawings",
        },
        {
          title: "Files",
          url: `${base}/files`,
          icon: FileText,
          isActive: section === "files",
        },
        {
          title: "Messages",
          url: `${base}/messages`,
          icon: MessageSquare,
          isActive: section === "messages",
        },
        {
          title: "RFIs",
          url: `${base}/rfis`,
          icon: MessageSquare,
          isActive: section === "rfis",
        },
        {
          title: "Submittals",
          url: `${base}/submittals`,
          icon: ClipboardCheck,
          isActive: section === "submittals",
        },
        {
          title: "Decisions",
          url: `${base}/decisions`,
          icon: CheckSquare,
          isActive: section === "decisions",
        },
        {
          title: "Daily Logs",
          url: `${base}/daily-logs`,
          icon: Camera,
          isActive: section === "daily-logs",
        },
        {
          title: "Punch",
          url: `${base}/punch`,
          icon: ClipboardList,
          isActive: section === "punch",
        },
        {
          title: "Financials",
          url: `${base}/financials`,
          icon: Receipt,
          isActive: financialSections.includes(section),
        },
        {
          title: "Proposals",
          url: `${base}/proposals`,
          icon: FileText,
          isActive: section === "proposals",
        },
        {
          title: "Change Orders",
          url: `${base}/change-orders`,
          icon: ClipboardList,
          isActive: section === "change-orders",
        },
        {
          title: "Closeout",
          url: `${base}/closeout`,
          icon: CheckSquare,
          isActive: section === "closeout",
        },
        {
          title: "Warranty",
          url: `${base}/warranty`,
          icon: ClipboardCheck,
          isActive: section === "warranty",
        },
      ],
    },
  ]
}

export function AppSidebar({ user, pipelineBadgeCount }: AppSidebarProps) {
  const pathname = usePathname()
  const projectId = getProjectIdFromPath(pathname)
  const section = getProjectSection(pathname)

  const navMain = (projectId ? buildProjectNavigation(projectId, section) : buildGlobalNavigation(pathname, pipelineBadgeCount)).map((group) => ({
    ...group,
    items: group.items.map((item) => ({
      ...item,
      isActive: item.isActive || pathname === item.url,
    })),
  }))

  const orgData = {
    name: "Strata Construction",
    logo: HardHat,
    plan: "Pro",
  }

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-14 flex items-center justify-center p-2">
        <OrgSwitcher org={orgData} />
      </SidebarHeader>
      {projectId && (
        <>
          <SidebarSeparator className="mx-0" />
          <div className="px-2 py-2">
            <SidebarProjectSwitcher projectId={projectId} />
          </div>
        </>
      )}
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
