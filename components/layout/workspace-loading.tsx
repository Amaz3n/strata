"use client"

import { terminology } from "@/lib/terminology"
import { isTradeSurface } from "@/lib/workspace-surface"
import { PageLayout } from "./page-layout"
import { PageLoadingSkeleton } from "./page-loading-skeleton"
import { usePageTitle } from "./page-title-context"

export function WorkspaceLoading({ destination }: { destination: "home" | "projects" }) {
  const { productTier, workspaceSurface } = usePageTitle()
  const trade = isTradeSurface(workspaceSurface)
  const title = destination === "projects"
    ? terminology(productTier, workspaceSurface.profile).projects
    : trade ? "Today" : productTier === "production" ? "Home" : "Control Tower"

  return (
    <PageLayout title={title} fullBleed={destination === "home" && !trade}>
      <PageLoadingSkeleton />
    </PageLayout>
  )
}
