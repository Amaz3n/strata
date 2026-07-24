import { notFound } from "next/navigation"
import type { ReactNode } from "react"

import { CommunityStatusBadge } from "@/components/communities/community-status-badge"
import { CommunityContextSync } from "@/components/communities/community-context-sync"
import { CommunityTabs } from "@/components/communities/community-tabs"
import { LotMixBar } from "@/components/communities/lot-mix-bar"
import { PageLayout } from "@/components/layout/page-layout"
import { LOT_STATUSES } from "@/lib/land/lot-lifecycle"
import { getCommunity } from "@/lib/services/communities"

export default async function CommunityLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params
  const community = await getCommunity(id).catch(() => null)
  if (!community) notFound()
  const totalLots = LOT_STATUSES.reduce((sum, status) => sum + community.lotCounts[status], 0)
  return (
    <PageLayout title={community.name} breadcrumbs={[{ label: "Communities", href: "/communities" }, { label: community.name }]} fullBleed>
      <CommunityContextSync communityId={id} />
      <div className="flex min-h-full flex-col">
        <div className="flex flex-wrap items-center justify-between gap-x-6 border-b px-4">
          <CommunityTabs communityId={id} />
          <div className="flex flex-wrap items-center gap-4 py-2">
            <CommunityStatusBadge status={community.status} />
            <dl className="flex items-baseline gap-4 text-xs">
              <div className="flex items-baseline gap-1.5">
                <dt className="text-muted-foreground">Lots</dt>
                <dd className="font-medium tabular-nums">{totalLots}{community.plannedLotCount != null ? <span className="font-normal text-muted-foreground"> / {community.plannedLotCount}</span> : null}</dd>
              </div>
              <div className="flex items-baseline gap-1.5">
                <dt className="text-muted-foreground">Started</dt>
                <dd className="font-medium tabular-nums">{community.lotCounts.started}</dd>
              </div>
              <div className="flex items-baseline gap-1.5">
                <dt className="text-muted-foreground">Closed</dt>
                <dd className="font-medium tabular-nums">{community.lotCounts.closed}</dd>
              </div>
            </dl>
            <LotMixBar counts={community.lotCounts} plannedLotCount={community.plannedLotCount} className="w-40" />
          </div>
        </div>
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </PageLayout>
  )
}
