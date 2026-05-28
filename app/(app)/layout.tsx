import type React from "react"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"

import type { User } from "@/lib/types"
import { AppSidebar } from "@/components/layout/app-sidebar"
import { AppHeader } from "@/components/layout/app-header"
import { MobileBottomNav } from "@/components/layout/mobile-bottom-nav"
import { PageTitleProvider } from "@/components/layout/page-title-context"
import { MobileActionProvider } from "@/components/layout/mobile-action-context"
import { AppPageContent } from "@/components/layout/app-page-content"
import { PlatformSessionControl } from "@/components/layout/platform-session-control"
import { OrgInactiveScreen } from "@/components/layout/org-inactive-screen"
import { DemoUsageTracker } from "@/components/layout/demo-usage-tracker"
import { OptimisticPathProvider } from "@/lib/navigation/optimistic-pathname"
import { getCurrentUserAction } from "../actions/user"
import { getCrmDashboardStats } from "@/lib/services/crm"
import { getOrgAccessState } from "@/lib/services/access"
import { getCurrentPlatformAccess } from "@/lib/services/platform-access"
import { getCurrentUserPermissions } from "@/lib/services/permissions"

export const dynamic = "force-dynamic"

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Fetch user data once at the layout level for the persistent shell
  const [currentUser, crmStats, access, platformAccess, permissionResult] = await Promise.all([
    getCurrentUserAction(),
    getCrmDashboardStats().catch(() => null),
    getOrgAccessState().catch(() => ({ status: "unknown", locked: false })),
    getCurrentPlatformAccess().catch(() => ({ canAccessPlatform: false, roles: [], isEnvSuperadmin: false })),
    getCurrentUserPermissions().catch(() => ({ permissions: [] as string[] })),
  ])

  const pipelineBadgeCount = crmStats ? crmStats.followUpsOverdue + crmStats.followUpsDueToday : 0

  if (access.locked) {
    return <OrgInactiveScreen orgName={"orgName" in access ? access.orgName ?? null : null} reason={"reason" in access ? access.reason : undefined} />
  }

  return (
    <SidebarProvider className="h-svh max-h-svh overflow-hidden">
      <OptimisticPathProvider>
        <DemoUsageTracker />
        <AppSidebar
          user={currentUser}
          pipelineBadgeCount={pipelineBadgeCount}
          canAccessPlatform={platformAccess.canAccessPlatform}
          permissions={permissionResult.permissions}
        />
        <MobileActionProvider>
          <SidebarInset className="h-svh max-h-svh min-w-0 min-h-0 overflow-hidden">
            <PageTitleProvider>
              <AppHeader platformSessionControl={<PlatformSessionControl />} />
              <AppPageContent>{children}</AppPageContent>
            </PageTitleProvider>
          </SidebarInset>
          <MobileBottomNav
            user={currentUser}
            pipelineBadgeCount={pipelineBadgeCount}
            canAccessPlatform={platformAccess.canAccessPlatform}
            permissions={permissionResult.permissions}
          />
        </MobileActionProvider>
      </OptimisticPathProvider>
    </SidebarProvider>
  )
}
