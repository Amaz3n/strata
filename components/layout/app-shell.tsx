"use client"

import type React from "react"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import { Breadcrumb, BreadcrumbList, BreadcrumbItem, BreadcrumbPage } from "@/components/ui/breadcrumb"

import type { User } from "@/lib/types"
import { AppSidebar } from "./app-sidebar"
import { AppHeader } from "./app-header"

interface AppShellProps {
  children: React.ReactNode
  title?: string
  user?: User | null
  badges?: {
    projects?: number
    tasks?: number
  }
}

export function AppShell({ children, title, user, badges }: AppShellProps) {
  return (
    <SidebarProvider>
      <AppSidebar user={user} badges={badges} />
      <SidebarInset>
        <AppHeader title={title} />
        <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
