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
import { ReleaseNotesAnnouncement } from "@/components/layout/release-notes-announcement"
import { OrgInactiveScreen } from "@/components/layout/org-inactive-screen"
import { TrialStatusBanner } from "@/components/layout/trial-status-banner"
import { DemoUsageTracker } from "@/components/layout/demo-usage-tracker"
import { OptimisticPathProvider } from "@/lib/navigation/optimistic-pathname"
import { getCurrentUserAction } from "../actions/user"
import { getCrmDashboardStats } from "@/lib/services/crm"
import { getOrgAccessState, type OrgAccessState } from "@/lib/services/access"
import { getCurrentPlatformAccess } from "@/lib/services/platform-access"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { getPlatformSessionState } from "@/lib/services/platform-session"
import { getReleaseNotesSummary } from "@/lib/services/release-notes"
import { getNavigationBadgeCounts } from "@/lib/services/navigation-badges"
import { getOrgProductTier, requireOrgContext } from "@/lib/services/context"
import { isProgressBillingEnabledForOrg } from "@/lib/services/feature-flags"

export const dynamic = "force-dynamic"

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Fetch user data once at the layout level for the persistent shell
  const [currentUser, crmStats, access, platformAccess, permissionResult, platformSessionState, releaseNotesSummary, navigationBadgeCounts, productTier, progressBillingEnabled] = await Promise.all([
    getCurrentUserAction(),
    getCrmDashboardStats().catch(() => null),
    getOrgAccessState().catch((): OrgAccessState => ({ status: "unknown", locked: false })),
    getCurrentPlatformAccess().catch(() => ({ canAccessPlatform: false, roles: [], isEnvSuperadmin: false })),
    getCurrentUserPermissions().catch(() => ({ permissions: [] as string[] })),
    getPlatformSessionState().catch(() => ({
      platformContext: { active: false, orgId: null, orgName: null, startedAt: null },
      impersonation: { active: false, targetUserId: null, targetName: null, targetEmail: null, expiresAt: null }
    })),
    getReleaseNotesSummary().catch(() => ({ unreadCount: 0, announcement: null })),
    getNavigationBadgeCounts().catch(() => ({
      myWorkBadgeCount: 0,
      readyToBillBadgeCount: 0,
      projectReviewBadgeCounts: {} as Record<string, number>,
    })),
    getOrgProductTier().catch(() => "residential" as const),
    requireOrgContext(undefined, { allowLocked: true })
      .then((context) => isProgressBillingEnabledForOrg({ supabase: context.supabase, orgId: context.orgId }))
      .catch(() => false),
  ])

  const pipelineBadgeCount = crmStats ? crmStats.followUpsOverdue + crmStats.followUpsDueToday : 0

  if (access.locked) {
    return (
      <OrgInactiveScreen
        orgName={"orgName" in access ? access.orgName ?? null : null}
        reason={"reason" in access ? access.reason : undefined}
        hasPrice={"hasPrice" in access ? access.hasPrice : undefined}
        checkoutUrl={"checkoutUrl" in access ? access.checkoutUrl : undefined}
        supportEmail="support@arcnaples.com"
      />
    )
  }

  return (
    <SidebarProvider className="h-svh max-h-svh overflow-hidden">
      <OptimisticPathProvider>
        <DemoUsageTracker />
        <ReleaseNotesAnnouncement announcement={releaseNotesSummary.announcement} />
        <AppSidebar
          user={currentUser}
          pipelineBadgeCount={pipelineBadgeCount}
          myWorkBadgeCount={navigationBadgeCounts.myWorkBadgeCount}
          readyToBillBadgeCount={navigationBadgeCounts.readyToBillBadgeCount}
          projectReviewBadgeCounts={navigationBadgeCounts.projectReviewBadgeCounts}
          canAccessPlatform={platformAccess.canAccessPlatform}
          permissions={permissionResult.permissions}
          whatsNewUnreadCount={releaseNotesSummary.unreadCount}
          productTier={productTier}
        />
        <MobileActionProvider>
          <SidebarInset className="h-svh max-h-svh min-w-0 min-h-0 overflow-hidden">
            <PageTitleProvider productTier={productTier} progressBillingEnabled={progressBillingEnabled}>
              <AppHeader
                platformSessionControlDesktop={<PlatformSessionControl access={platformAccess} state={platformSessionState} />}
                platformSessionControlMobile={<PlatformSessionControl access={platformAccess} state={platformSessionState} />}
              />
              <TrialStatusBanner access={access} />
              <AppPageContent>{children}</AppPageContent>
            </PageTitleProvider>
          </SidebarInset>
          <MobileBottomNav
            user={currentUser}
            pipelineBadgeCount={pipelineBadgeCount}
            myWorkBadgeCount={navigationBadgeCounts.myWorkBadgeCount}
            readyToBillBadgeCount={navigationBadgeCounts.readyToBillBadgeCount}
            projectReviewBadgeCounts={navigationBadgeCounts.projectReviewBadgeCounts}
            canAccessPlatform={platformAccess.canAccessPlatform}
            permissions={permissionResult.permissions}
            whatsNewUnreadCount={releaseNotesSummary.unreadCount}
            productTier={productTier}
          />
        </MobileActionProvider>
      </OptimisticPathProvider>
    </SidebarProvider>
  )
}
