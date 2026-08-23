import React, { Suspense } from "react"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"

import type { User } from "@/lib/types"
import { AppSidebar } from "@/components/layout/app-sidebar"
import { AppHeader } from "@/components/layout/app-header"
import { MobileBottomNav } from "@/components/layout/mobile-bottom-nav"
import { PageTitleProvider } from "@/components/layout/page-title-context"
import { MobileActionProvider } from "@/components/layout/mobile-action-context"
import { AppPageContent } from "@/components/layout/app-page-content"
import { ArcLoadingMark } from "@/components/brand/arc-loading-mark"
import { ReleaseNotesAnnouncement } from "@/components/layout/release-notes-announcement"
import { OrgInactiveScreen } from "@/components/layout/org-inactive-screen"
import { TrialStatusBanner } from "@/components/layout/trial-status-banner"
import { DemoUsageTracker } from "@/components/layout/demo-usage-tracker"
import { OptimisticPathProvider } from "@/lib/navigation/optimistic-pathname"
import {
  NavigationBadgeProvider,
  type NavigationBadgeValues,
} from "@/components/layout/navigation-badge-context"
import { getCurrentUserAction } from "../actions/user"
import { getOrgAccessState, type OrgAccessState } from "@/lib/services/access"
import { getCurrentPlatformAccess } from "@/lib/services/platform-access"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { getPlatformSessionState } from "@/lib/services/platform-session"
import { getReleaseNotesSummary } from "@/lib/services/release-notes"
import { getNavigationBadgeCounts } from "@/lib/services/navigation-badges"
import { getOrgProductTier } from "@/lib/services/context"
import { getAmbientDeskContext } from "@/lib/services/desk-context"
import { orgHasProductionProjects } from "@/lib/services/production-desk-scope"
import { shouldShowProductionOrgNavigation } from "@/lib/product-tier"
import { orgHasPriceAgreements } from "@/lib/services/price-book"
import { isBooksWorkspaceEnabled } from "@/lib/services/books/module"

// This layout is the contract for every authenticated destination: a click
// must be able to render app chrome immediately while request data streams.
export const instant = true


/**
 * Badge counts and the What's New announcement are shell decoration, not shell
 * structure — the nav tree is byte-identical without them. They are loaded off
 * the critical path so first paint is gated only on what decides *what the chrome
 * is*: identity, access, permissions, posture and ambient scope.
 */
async function loadNavigationBadges(): Promise<NavigationBadgeValues> {
  const [releaseNotesSummary, navigationBadgeCounts] = await Promise.all([
    getReleaseNotesSummary().catch(() => ({ unreadCount: 0, announcement: null })),
    getNavigationBadgeCounts().catch(() => ({
      pipelineBadgeCount: 0,
      myWorkBadgeCount: 0,
      readyToBillBadgeCount: 0,
      projectReviewBadgeCounts: {} as Record<string, number>,
    })),
  ])

  return {
    pipelineBadgeCount: navigationBadgeCounts.pipelineBadgeCount,
    myWorkBadgeCount: navigationBadgeCounts.myWorkBadgeCount,
    readyToBillBadgeCount: navigationBadgeCounts.readyToBillBadgeCount,
    projectReviewBadgeCounts: navigationBadgeCounts.projectReviewBadgeCounts,
    whatsNewUnreadCount: releaseNotesSummary.unreadCount,
  }
}

async function ReleaseNotesAnnouncementSlot() {
  const summary = await getReleaseNotesSummary().catch(() => ({
    unreadCount: 0,
    announcement: null,
  }))
  return <ReleaseNotesAnnouncement announcement={summary.announcement} />
}

async function AuthenticatedAppChrome({
  children,
}: {
  children: React.ReactNode
}) {
  // Started, deliberately not awaited: streams to the client behind the shell.
  const navigationBadgesPromise = loadNavigationBadges()

  // Fetch user data once at the layout level for the persistent shell
  const [currentUser, access, platformAccess, permissionResult, platformSessionState, productTier, ambientContext, hasProductionProjects, hasPriceAgreements, booksEnabled] = await Promise.all([
    getCurrentUserAction(),
    getOrgAccessState().catch((): OrgAccessState => ({ status: "unknown", locked: false })),
    getCurrentPlatformAccess().catch(() => ({ canAccessPlatform: false, roles: [], isEnvSuperadmin: false })),
    getCurrentUserPermissions().catch(() => ({ permissions: [] as string[] })),
    getPlatformSessionState().catch(() => ({
      platformContext: { active: false, orgId: null, orgName: null, startedAt: null },
      impersonation: { active: false, targetUserId: null, targetName: null, targetEmail: null, expiresAt: null }
    })),
    getOrgProductTier().catch(() => "residential" as const),
    getAmbientDeskContext().catch(() => ({ divisions: [], divisionId: undefined, communities: [], communityId: undefined, pinnableCommunities: [] })),
    orgHasProductionProjects().catch(() => false),
    orgHasPriceAgreements().catch(() => false),
    isBooksWorkspaceEnabled().catch(() => false),
  ])

  const showProductionNavigation = shouldShowProductionOrgNavigation(productTier, hasProductionProjects)
  const showPurchasingNavigation = showProductionNavigation || hasPriceAgreements

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
        <NavigationBadgeProvider valuesPromise={navigationBadgesPromise}>
          <DemoUsageTracker />
          <Suspense fallback={null}>
            <ReleaseNotesAnnouncementSlot />
          </Suspense>
          <AppSidebar
            user={currentUser}
            canAccessPlatform={platformAccess.canAccessPlatform}
            permissions={permissionResult.permissions}
            productTier={productTier}
            hasDivisions={ambientContext.divisions.length > 0}
            showProductionNavigation={showProductionNavigation}
            showPurchasingNavigation={showPurchasingNavigation}
            showPipelineNavigation={productTier !== "production"}
            booksEnabled={booksEnabled}
          />
          <MobileActionProvider>
            <SidebarInset className="h-svh max-h-svh min-w-0 min-h-0 overflow-hidden">
              <PageTitleProvider productTier={productTier}>
                <AppHeader
                  divisions={ambientContext.divisions}
                  divisionId={ambientContext.divisionId}
                  communities={ambientContext.pinnableCommunities}
                  communityId={ambientContext.communityId}
                  showCommunityScope={showProductionNavigation}
                  platformAccess={platformAccess}
                  platformSessionState={platformSessionState}
                />
                <TrialStatusBanner access={access} />
                <AppPageContent>{children}</AppPageContent>
              </PageTitleProvider>
            </SidebarInset>
            <MobileBottomNav
              user={currentUser}
              canAccessPlatform={platformAccess.canAccessPlatform}
              permissions={permissionResult.permissions}
              productTier={productTier}
              showProductionNavigation={showProductionNavigation}
              showPipelineNavigation={productTier !== "production"}
              showPurchasingNavigation={showPurchasingNavigation}
              booksEnabled={booksEnabled}
            />
          </MobileActionProvider>
        </NavigationBadgeProvider>
      </OptimisticPathProvider>
    </SidebarProvider>
  )
}

function AppChromeFallback() {
  return (
    <div
      className="flex h-svh max-h-svh overflow-hidden bg-background"
      role="status"
      aria-busy="true"
      aria-label="Loading Arc"
    >
      <div className="hidden w-64 shrink-0 border-r bg-sidebar md:block" />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="h-14 border-b bg-background" />
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <div className="arc-loading-presence">
            <ArcLoadingMark className="h-16 w-auto sm:h-[4.5rem]" />
          </div>
        </div>
      </div>
    </div>
  )
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<AppChromeFallback />}>
      <AuthenticatedAppChrome>{children}</AuthenticatedAppChrome>
    </Suspense>
  )
}
