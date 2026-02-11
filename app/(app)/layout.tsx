import type React from "react"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"

import type { User } from "@/lib/types"
import { AppSidebar } from "@/components/layout/app-sidebar"
import { AppHeader } from "@/components/layout/app-header"
import { PageTitleProvider } from "@/components/layout/page-title-context"
import { getCurrentUserAction } from "../actions/user"
import { getCrmDashboardStats } from "@/lib/services/crm"
import { getOrgAccessState } from "@/lib/services/access"

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const headerList = await headers()
  const pathname = headerList.get("x-pathname") ?? ""

  // Fetch user data once at the layout level for the persistent shell
  const [currentUser, crmStats, access] = await Promise.all([
    getCurrentUserAction(),
    getCrmDashboardStats().catch(() => null),
    getOrgAccessState().catch(() => ({ status: "unknown", locked: false })),
  ])

  const pipelineBadgeCount = crmStats ? crmStats.followUpsOverdue + crmStats.followUpsDueToday : 0
  const allowLockedAccess = pathname.startsWith("/settings") || pathname.startsWith("/billing/locked")

  if (access.locked && !allowLockedAccess) {
    redirect("/settings?tab=billing")
  }

  return (
    <SidebarProvider>
      <AppSidebar user={currentUser} pipelineBadgeCount={pipelineBadgeCount} />
      <SidebarInset className="min-w-0 overflow-x-hidden">
        <PageTitleProvider>
          <AppHeader />
          <div className="flex flex-1 flex-col gap-4 p-4 pt-6 min-w-0 overflow-x-hidden">
            {children}
          </div>
        </PageTitleProvider>
      </SidebarInset>
    </SidebarProvider>
  )
}
