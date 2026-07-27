import { notFound } from "next/navigation"
import type { ReactNode } from "react"

import { CommunityContextSync } from "@/components/communities/community-context-sync"
import { CommunityStatusBadge } from "@/components/communities/community-status-badge"
import { CommunityTabs } from "@/components/communities/community-tabs"
import { PageLayout } from "@/components/layout/page-layout"
import { LOT_STATUSES } from "@/lib/land/lot-lifecycle"
import { getCommunity } from "@/lib/services/communities"

/** Lots a buyer could still be sold — the one number the workbench header owes you. */
const SELLABLE = ["owned", "developed", "assigned"] as const

export default async function CommunityLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const community = await getCommunity(id).catch(() => null)
  if (!community) notFound()

  const totalLots = LOT_STATUSES.reduce((sum, status) => sum + community.lotCounts[status], 0)
  const sellable = SELLABLE.reduce((sum, status) => sum + community.lotCounts[status], 0)

  return (
    <PageLayout
      title={community.name}
      breadcrumbs={[{ label: "Communities", href: "/communities" }, { label: community.name }]}
      fullBleed
    >
      <CommunityContextSync communityId={id} />
      <div className="flex min-h-full flex-col">
        <div className="flex flex-wrap items-center justify-between gap-x-6 border-b px-4">
          <CommunityTabs communityId={id} />
          <div className="flex flex-wrap items-center gap-3 py-2">
            <CommunityStatusBadge status={community.status} />
            <dl className="flex items-baseline gap-4 text-xs">
              <div className="flex items-baseline gap-1.5">
                <dt className="text-muted-foreground">Sellable</dt>
                <dd className="font-medium tabular-nums">{sellable}</dd>
              </div>
              <div className="flex items-baseline gap-1.5">
                <dt className="text-muted-foreground">Building</dt>
                <dd className="font-medium tabular-nums">{community.lotCounts.started}</dd>
              </div>
              <div className="flex items-baseline gap-1.5">
                <dt className="text-muted-foreground">Closed</dt>
                <dd className="font-medium tabular-nums">{community.lotCounts.closed}</dd>
              </div>
              <div className="flex items-baseline gap-1.5">
                <dt className="text-muted-foreground">Lots</dt>
                <dd className="font-medium tabular-nums">
                  {totalLots}
                  {community.plannedLotCount != null ? (
                    <span className="font-normal text-muted-foreground"> / {community.plannedLotCount}</span>
                  ) : null}
                </dd>
              </div>
            </dl>
          </div>
        </div>
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </PageLayout>
  )
}
