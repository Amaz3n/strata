import type React from "react"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"

import type { User } from "@/lib/types"
import { AppSidebar } from "@/components/layout/app-sidebar"
import { AppHeader } from "@/components/layout/app-header"
import { PageTitleProvider } from "@/components/layout/page-title-context"
import { PlatformSessionBanner } from "@/components/layout/platform-session-banner"
import { OrgInactiveScreen } from "@/components/layout/org-inactive-screen"
import { getCurrentUserAction } from "../actions/user"
import { getCrmDashboardStats } from "@/lib/services/crm"
import { getOrgAccessState } from "@/lib/services/access"
import { getCurrentPlatformAccess } from "@/lib/services/platform-access"

export const dynamic = "force-dynamic"

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Fetch user data once at the layout level for the persistent shell
  const [currentUser, crmStats, access, platformAccess] = await Promise.all([
    getCurrentUserAction(),
    getCrmDashboardStats().catch(() => null),
    getOrgAccessState().catch(() => ({ status: "unknown", locked: false })),
    getCurrentPlatformAccess().catch(() => ({ canAccessPlatform: false, roles: [], isEnvSuperadmin: false })),
  ])

  const pipelineBadgeCount = crmStats ? crmStats.followUpsOverdue + crmStats.followUpsDueToday : 0

  if (access.locked) {
    return <OrgInactiveScreen orgName={access.orgName ?? null} reason={access.reason} />
  }

  return (
    <SidebarProvider>
      <AppSidebar
        user={currentUser}
        pipelineBadgeCount={pipelineBadgeCount}
        canAccessPlatform={platformAccess.canAccessPlatform}
      />
      <SidebarInset className="min-w-0 overflow-x-hidden">
        <PageTitleProvider>
          <PlatformSessionBanner />
          <AppHeader />
          <div className="flex flex-1 flex-col gap-4 p-4 pt-6 min-w-0 overflow-x-hidden">
            {children}
          </div>
        </PageTitleProvider>
      </SidebarInset>
    </SidebarProvider>
  )
}
