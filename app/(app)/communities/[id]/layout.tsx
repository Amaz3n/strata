import { notFound } from "next/navigation"
import type { ReactNode } from "react"

import { CommunityContextSync } from "@/components/communities/community-context-sync"
import { CommunityHeaderStats } from "@/components/communities/community-header-stats"
import { CommunityStatusBadge } from "@/components/communities/community-status-badge"
import { CommunityTabs } from "@/components/communities/community-tabs"
import { CommunityUrgencyStrip } from "@/components/communities/community-urgency-strip"
import { PageLayout } from "@/components/layout/page-layout"
import { getCommunityLane } from "@/lib/services/community-portfolio"
import { getCommunity } from "@/lib/services/communities"

export default async function CommunityLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  // The lane is the same computation the board runs, so drilling in is a zoom
  // rather than a change of subject. Without report.read it comes back with a
  // null margin and the header simply drops that one stat.
  const [community, lane] = await Promise.all([
    getCommunity(id).catch(() => null),
    getCommunityLane(id).catch(() => null),
  ])
  if (!community) notFound()

  return (
    <PageLayout
      title={community.name}
      breadcrumbs={[{ label: "Communities", href: "/communities" }, { label: community.name }]}
      fullBleed
    >
      <CommunityContextSync communityId={id} />
      <div className="flex min-h-full flex-col">
        {/* One band, not three. Urgencies are rarely more than a few chips and
            they read better beside the numbers than as their own stripe. */}
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-b px-4">
          <div className="flex flex-wrap items-center gap-3">
            <CommunityTabs communityId={id} />
            <CommunityStatusBadge status={community.status} />
            <CommunityUrgencyStrip urgencies={lane?.urgencies ?? []} />
          </div>
          <CommunityHeaderStats lane={lane} plannedLotCount={community.plannedLotCount} />
        </div>
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </PageLayout>
  )
}
