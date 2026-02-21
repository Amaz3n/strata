"use client"

import type React from "react"
import { usePathname } from "next/navigation"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"

import type { User } from "@/lib/types"
import { AppSidebar } from "./app-sidebar"
import { AppHeader, type AppBreadcrumbItem } from "./app-header"

interface AppShellProps {
  children: React.ReactNode
  title?: string
  breadcrumbs?: AppBreadcrumbItem[]
  user?: User | null
}

export function AppShell({ children, title, breadcrumbs, user }: AppShellProps) {
  const pathname = usePathname()
  const isDocsPage = /^\/projects\/[^/]+\/files/.test(pathname)

  // Debug logging
  if (typeof window !== 'undefined') {
    console.log('[AppShell] pathname:', pathname, 'isDocsPage:', isDocsPage)
  }

  return (
    <SidebarProvider
      style={{
        "--sidebar-width": isDocsPage ? "28rem" : "16rem"
      } as React.CSSProperties}
    >
      <AppSidebar user={user} />
      <SidebarInset className="min-w-0 overflow-x-hidden">
        <AppHeader title={title} breadcrumbs={breadcrumbs} />
        <div className="flex flex-1 flex-col gap-4 p-4 pt-0 min-w-0 overflow-x-hidden">
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
