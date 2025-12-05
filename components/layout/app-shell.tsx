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
}

export function AppShell({ children, title, user }: AppShellProps) {
  return (
    <SidebarProvider>
      <AppSidebar user={user} />
      <SidebarInset className="min-w-0 overflow-x-hidden">
        <AppHeader title={title} />
        <div className="flex flex-1 flex-col gap-4 p-4 pt-0 min-w-0 overflow-x-hidden">
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
