import { connection } from "next/server"
import { Suspense } from "react"
import Link from "next/link"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { PageLayout } from "@/components/layout/page-layout"
import { QueuePagination } from "@/components/layout/queue-pagination"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { TradeLookaheadClient } from "@/components/schedule/trade-lookahead-client"
import { TradeNoticeAttention } from "@/components/schedule/trade-notice-attention"
import { TradeResponseBand, TradeResponseBandSkeleton } from "@/components/schedule/trade-response-band"
import { getTradeLookaheadWorkspace } from "@/lib/services/trade-lookahead"
import { listTradeNoticeAttention } from "@/lib/services/trade-notices"
import { getAmbientDeskContext } from "@/lib/services/desk-context"
import { requireOrgContext } from "@/lib/services/context"
import { hasPermission } from "@/lib/services/permissions"
import { cn } from "@/lib/utils"

const WINDOWS = [2, 3, 4] as const
const positivePage = (value?: string) => {
  const page = Number(value ?? 1)
  return Number.isSafeInteger(page) && page > 0 && page <= 1000000 ? page : 1
}
type Props = { searchParams: Promise<{ weeks?: string; page?: string; q?: string; group?: string; itemPage?: string; responsePage?: string }> }

async function TradeLookaheadPageContent({ searchParams }: Props) {
  await connection()
  const [params, ambient, context] = await Promise.all([searchParams, getAmbientDeskContext(), requireOrgContext()])
  const weeks = params.weeks === "2" || params.weeks === "4" ? Number(params.weeks) as 2 | 4 : 3
  const page = positivePage(params.page), itemPage = positivePage(params.itemPage)
  const q = (params.q ?? "").trim().slice(0, 120)
  const scope = { communityId: ambient.communityId, divisionId: ambient.divisionId }
  const [workspace, canSend, canAssign, canResolve, attention] = await Promise.all([
    getTradeLookaheadWorkspace({ weeks, page, q, group: params.group, itemPage, ...scope }, context.orgId),
    hasPermission("start.write", context),
    hasPermission("schedule.edit", context),
    Promise.all([hasPermission("start.release", context), hasPermission("start.write", context)]).then(([release, write]) => release && write),
    listTradeNoticeAttention(context.orgId),
  ])
  const listParams = new URLSearchParams({ weeks: String(weeks) })
  if (q) listParams.set("q", q)
  const pageParams = new URLSearchParams(listParams)
  pageParams.set("page", String(page))
  const listHref = `/schedule/trades?${pageParams}`
  const detailParams = new URLSearchParams(pageParams)
  if (params.group) detailParams.set("group", params.group)
  return <PageLayout title="Trade look-aheads" breadcrumbs={[{ label: "Schedule", href: "/schedule" }, { label: "Trade look-aheads" }]}>
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Upcoming work grouped by trade company in the current community and division.</p>
        <div className="flex border text-xs" role="group" aria-label="Look-ahead window">
          {WINDOWS.map(window => {
            const query = new URLSearchParams(listParams)
            query.set("weeks", String(window))
            return <Link key={window} href={`/schedule/trades?${query}`} className={cn("px-3 py-1.5 tabular-nums", window === weeks ? "bg-foreground font-medium text-background" : "text-muted-foreground hover:text-foreground")} aria-current={window === weeks ? "true" : undefined}>{window} wk</Link>
          })}
        </div>
      </div>
      <form action="/schedule/trades" className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="weeks" value={weeks} />
        <label htmlFor="trade-lookahead-search" className="sr-only">Search company or trade</label>
        <Input id="trade-lookahead-search" name="q" defaultValue={q} maxLength={120} placeholder="Search company or trade" className="max-w-sm" />
        <Button type="submit" variant="outline">Search</Button>
      </form>
      <Suspense fallback={<TradeResponseBandSkeleton />}>
        <TradeResponseBand page={positivePage(params.responsePage)} communityId={scope.communityId} href={`/schedule/trades?${pageParams}`} />
      </Suspense>
      <TradeNoticeAttention rows={attention.rows} total={attention.total} limit={attention.limit} canResolve={canResolve} />
      {workspace.selectedUnavailable && <p role="status" className="border p-3 text-sm">This trade group is unavailable in the current scope. <Link href={listHref} className="underline">Return to the group list</Link>.</p>}
      <TradeLookaheadClient key={`${context.orgId}:${context.userId}:${scope.communityId ?? ""}:${scope.divisionId ?? ""}:${weeks}:${q}:${page}:${params.group ?? ""}:${itemPage}`} rows={workspace.rows} selected={workspace.selected} weeks={weeks} canSend={canSend} canAssign={canAssign} scope={scope} listHref={listHref} total={workspace.total} />
      <QueuePagination page={page} pageSize={workspace.pageSize} total={workspace.total} href={`/schedule/trades?${listParams}`} label="Trade group pages" />
      {workspace.selected && <QueuePagination page={itemPage} pageSize={workspace.itemPageSize} total={workspace.selected.itemCount} href={`/schedule/trades?${detailParams}`} pageParam="itemPage" label="Selected trade task pages" />}
    </div>
  </PageLayout>
}
export default function TradeLookaheadPage(props: Props) {
  return <Suspense fallback={<PageLayout title="Trade look-aheads" breadcrumbs={[{ label: "Schedule", href: "/schedule" }, { label: "Trade look-aheads" }]}><PageLoadingSkeleton /></PageLayout>}><TradeLookaheadPageContent {...props} /></Suspense>
}
