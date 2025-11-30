"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useTransition } from "react"
import { signOutAction } from "@/app/auth/actions"
import {
  LayoutDashboard,
  FolderOpen,
  CheckSquare,
  CalendarDays,
  ClipboardList,
  FileText,
  Image,
  MessageSquare,
  Users,
  Receipt,
  Settings,
  HardHat,
  LogOut,
  Plus,
  BadgeCheck,
  CreditCard,
  Bell,
  Sparkles,
} from "@/components/icons"
import { NavMain } from "./nav-main"
import { NavUser } from "./nav-user"
import { OrgSwitcher } from "./org-switcher"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from "@/components/ui/sidebar"
import type { User } from "@/lib/types"

interface AppSidebarProps {
  user?: User | null
  badges?: {
    projects?: number
    tasks?: number
  }
}

function buildNavigation(badges?: AppSidebarProps["badges"]) {
  return [
    {
      title: "Dashboard",
      url: "/",
      icon: LayoutDashboard,
      isActive: false,
    },
    {
      title: "Projects",
      url: "/projects",
      icon: FolderOpen,
      badge: badges?.projects,
      isActive: false,
    },
    {
      title: "Tasks",
      url: "/tasks",
      icon: CheckSquare,
      badge: badges?.tasks,
      isActive: false,
      items: [
        {
          title: "All Tasks",
          url: "/tasks",
        },
        {
          title: "My Tasks",
          url: "/tasks?filter=mine",
        },
      ],
    },
    {
      title: "Schedule",
      url: "/schedule",
      icon: CalendarDays,
      isActive: false,
    },
    {
      title: "Daily Logs",
      url: "/daily-logs",
      icon: ClipboardList,
      isActive: false,
    },
    {
      title: "Photos",
      url: "/photos",
      icon: Image,
      isActive: false,
    },
    {
      title: "Files",
      url: "/files",
      icon: FileText,
      isActive: false,
    },
    {
      title: "Portal",
      url: "/portal",
      icon: MessageSquare,
      isActive: false,
    },
    {
      title: "Change Orders",
      url: "/change-orders",
      icon: Receipt,
      isActive: false,
    },
    {
      title: "Budget",
      url: "/budget",
      icon: Receipt,
      isActive: false,
    },
    {
      title: "Team",
      url: "/team",
      icon: Users,
      isActive: false,
    },
    {
      title: "Contacts",
      url: "/contacts",
      icon: Users,
      isActive: false,
    },
  ]
}

export function AppSidebar({ user, badges }: AppSidebarProps) {
  const pathname = usePathname()
  const navMain = buildNavigation(badges).map(item => ({
    ...item,
    isActive: pathname === item.url || (item.items?.some(sub => pathname === sub.url) ?? false),
  }))

  const orgData = {
    name: "Strata Construction",
    logo: HardHat,
    plan: "Pro",
  }

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <OrgSwitcher org={orgData} />
      </SidebarHeader>
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
