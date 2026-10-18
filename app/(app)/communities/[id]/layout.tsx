import { notFound } from "next/navigation"
import { cacheLife } from "next/cache"
import { connection } from "next/server"
import { Suspense, type ReactNode } from "react"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"

import { CommunityContextSync } from "@/components/communities/community-context-sync"
import { CommunityHeaderStats } from "@/components/communities/community-header-stats"
import { CommunityStatusBadge } from "@/components/communities/community-status-badge"
import { CommunityTabs } from "@/components/communities/community-tabs"
import { CommunityUrgencyStrip } from "@/components/communities/community-urgency-strip"
import { PageLayout } from "@/components/layout/page-layout"
import { getCommunityLane } from "@/lib/services/community-portfolio"
import { getCommunityIdentity } from "@/lib/services/communities"

// A fabricated community ID cannot produce a valid inventory shell. Runtime
// validation still checks real community navigations in development.
export const instant = {
  unstable_disableBuildValidation: true,
}

async function CommunityLayoutContent({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const community = await loadCommunityIdentity(id)
  if (!community) notFound()

  return (
    <PageLayout
      title={community.name}
      breadcrumbs={[{ label: "Communities", href: "/communities" }, { label: community.name }]}
      fullBleed
    >
      <CommunityContextSync communityId={id} />
      <div className="flex min-h-full flex-col" data-instant-shell="community">
        {/* One band, not three. Urgencies are rarely more than a few chips and
            they read better beside the numbers than as their own stripe. */}
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-b px-4">
          <div className="flex flex-wrap items-center gap-3">
            <CommunityTabs communityId={id} />
            <CommunityStatusBadge status={community.status} />
          </div>
          <Suspense fallback={<CommunityHeaderStats lane={null} plannedLotCount={community.plannedLotCount} />}>
            <CommunityLiveHeader id={id} plannedLotCount={community.plannedLotCount} />
          </Suspense>
        </div>
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </PageLayout>
  )
}

async function loadCommunityIdentity(id: string) {
  "use cache: private"
  cacheLife("session")
  try {
    return await getCommunityIdentity(id)
  } catch (error) {
    if (error instanceof Error && error.message === "Community not found") return null
    throw error
  }
}

async function CommunityLiveHeader({ id, plannedLotCount }: { id: string; plannedLotCount: number | null }) {
  // Supply, pace, urgency and margin are live reads. Their computation must not
  // hold back the cached community identity, tabs or the selected page shell.
  await connection()
  const lane = await getCommunityLane(id).catch((error: unknown) => {
    console.error("Failed to load community header metrics", error)
    return null
  })
  return (
    <>
      <CommunityUrgencyStrip urgencies={lane?.urgencies ?? []} />
      <CommunityHeaderStats lane={lane} plannedLotCount={plannedLotCount} />
    </>
  )
}

export default function CommunityLayout(props: { children: ReactNode; params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={
      <PageLayout title="Community" breadcrumbs={[{ label: "Communities", href: "/communities" }, { label: "Community" }]} fullBleed>
        <PageLoadingSkeleton />
      </PageLayout>
    }>
      <CommunityLayoutContent {...props} />
    </Suspense>
  )
}
