import React, { Suspense } from "react"
import { connection } from "next/server"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"

import type { User } from "@/lib/types"
import { AppSidebar } from "@/components/layout/app-sidebar"
import { AppHeader } from "@/components/layout/app-header"
import { MobileBottomNav } from "@/components/layout/mobile-bottom-nav"
import { PageTitleProvider } from "@/components/layout/page-title-context"
import { MobileActionProvider } from "@/components/layout/mobile-action-context"
import { AppPageContent } from "@/components/layout/app-page-content"
import { ArcLoadingMark } from "@/components/brand/arc-loading-mark"
import { DelayedLoadingStatus } from "@/components/brand/delayed-loading-status"
import { ReleaseNotesAnnouncement } from "@/components/layout/release-notes-announcement"
import { OrgInactiveScreen } from "@/components/layout/org-inactive-screen"
import { TrialStatusBanner } from "@/components/layout/trial-status-banner"
import { DemoUsageTracker } from "@/components/layout/demo-usage-tracker"
import { OptimisticPathProvider } from "@/lib/navigation/optimistic-pathname"
import {
  NavigationBadgeProvider,
  type NavigationBadgeValues,
} from "@/components/layout/navigation-badge-context"
import { getAppChromeContext } from "@/lib/services/app-chrome"
import { getReleaseNotesSummary } from "@/lib/services/release-notes"
import { getNavigationBadgeCounts } from "@/lib/services/navigation-badges"
import { shouldShowProductionOrgNavigation } from "@/lib/product-tier"

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
  // Badge counts are "as of now" by definition (due dates, follow-ups, activity
  // stamps), so this promise is request-time work. Establishing that here keeps
  // the clock reads below legal while the shell around it still prerenders --
  // the promise is streamed, never awaited in the render path.
  await connection()

  const [releaseNotesSummary, navigationBadgeCounts] = await Promise.all([
    getReleaseNotesSummary().catch(() => ({ unreadCount: 0, announcement: null })),
    getNavigationBadgeCounts().catch(() => ({
      pipelineBadgeCount: 0,
      myWorkBadgeCount: 0,
      readyToBillBadgeCount: 0,
      projectReviewBadgeCounts: {} as Record<string, number>,
      projectCorrespondenceBadgeCounts: {} as Record<string, number>,
    })),
  ])

  return {
    pipelineBadgeCount: navigationBadgeCounts.pipelineBadgeCount,
    myWorkBadgeCount: navigationBadgeCounts.myWorkBadgeCount,
    readyToBillBadgeCount: navigationBadgeCounts.readyToBillBadgeCount,
    projectReviewBadgeCounts: navigationBadgeCounts.projectReviewBadgeCounts,
    projectCorrespondenceBadgeCounts: navigationBadgeCounts.projectCorrespondenceBadgeCounts,
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

  // One private cache entry for the whole shell. Ten separate awaits here meant
  // ten dynamic holes, none of which could be prefetched, so the App Shell for
  // every authenticated route was an empty sidebar rectangle.
  const {
    user: currentUser,
    permissions,
    access,
    platformAccess,
    platformSessionState,
    productTier,
    ambientContext,
    projects,
    hasProductionProjects,
    hasPriceAgreements,
    booksEnabled,
  } = await getAppChromeContext()

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
    // Publishes the resolved tier to every nested fallback. `contents` keeps the
    // wrapper out of layout — it exists only so `--arc-loading-light` inherits,
    // which is why no loader below has to re-resolve the product tier itself.
    <div
      className="contents"
      style={
        {
          "--arc-loading-light": `var(--tier-${productTier}-light)`,
        } as React.CSSProperties
      }
    >
      <SidebarProvider className="h-svh max-h-svh overflow-hidden">
        <OptimisticPathProvider>
          <NavigationBadgeProvider valuesPromise={navigationBadgesPromise}>
            <DemoUsageTracker />
            <Suspense fallback={null}>
              <ReleaseNotesAnnouncementSlot />
            </Suspense>
            <AppSidebar
              user={currentUser}
              projects={projects}
              canAccessPlatform={platformAccess.canAccessPlatform}
              permissions={permissions}
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
                projects={projects}
                canAccessPlatform={platformAccess.canAccessPlatform}
                permissions={permissions}
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
    </div>
  )
}

function AppChromeFallback() {
  return (
    // Empty sidebar and header geometry lands immediately — it is the shell,
    // not feedback. Only the mark and its announcement wait out the delay.
    <div className="flex h-svh max-h-svh overflow-hidden bg-background">
      <div className="hidden w-64 shrink-0 border-r bg-sidebar md:block" />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="h-14 border-b bg-background" />
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <DelayedLoadingStatus label="Loading Arc">
            <ArcLoadingMark className="h-16 w-auto sm:h-[4.5rem]" />
          </DelayedLoadingStatus>
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
