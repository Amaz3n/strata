"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useTransition } from "react"
import { signOutAction } from "@/app/auth/actions"
import {
  LayoutDashboard,
  FolderOpen,
  CalendarDays,
  FileText,
  MessageSquare,
  Users,
  Receipt,
  Share2,
  HardHat,
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
}

function buildNavigation() {
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
      isActive: false,
    },
    {
      title: "Schedule",
      url: "/schedule",
      icon: CalendarDays,
      isActive: false,
    },
    {
      title: "Documents",
      url: "/files",
      icon: FileText,
      isActive: false,
      items: [
        { title: "Files", url: "/files" },
        { title: "RFIs", url: "/rfis" },
        { title: "Submittals", url: "/submittals" },
      ],
    },
    {
      title: "Financial",
      url: "/change-orders",
      icon: Receipt,
      isActive: false,
      items: [
        { title: "Change Orders", url: "/change-orders" },
        { title: "Invoices", url: "/invoices" },
      ],
    },
    {
      title: "Sharing",
      url: "/sharing",
      icon: Share2,
      isActive: false,
    },
    {
      title: "Directory",
      url: "/team",
      icon: Users,
      isActive: false,
      items: [
        { title: "Team", url: "/team" },
        { title: "Contacts", url: "/contacts" },
        { title: "Companies", url: "/companies" },
      ],
    },
  ]
}

export function AppSidebar({ user }: AppSidebarProps) {
  const pathname = usePathname()
  const navMain = buildNavigation().map(item => ({
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
