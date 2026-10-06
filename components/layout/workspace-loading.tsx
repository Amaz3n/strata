"use client"

import { terminology } from "@/lib/terminology"
import { PageLayout } from "./page-layout"
import { PageLoadingSkeleton } from "./page-loading-skeleton"
import { usePageTitle } from "./page-title-context"

export function WorkspaceLoading({ destination }: { destination: "home" | "projects" }) {
  const { productTier, businessProfile } = usePageTitle()
  const title = destination === "projects"
    ? terminology(productTier, businessProfile).projects
    : businessProfile.kind === "trade" ? "Today" : productTier === "production" ? "Home" : "Control Tower"

  return (
    <PageLayout title={title} fullBleed={destination === "home" && businessProfile.kind !== "trade"}>
      <PageLoadingSkeleton />
    </PageLayout>
  )
}
