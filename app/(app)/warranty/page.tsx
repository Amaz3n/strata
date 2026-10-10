import Link from "next/link"
import { QueuePagination } from "@/components/layout/queue-pagination"
import { warrantyDeskUrlPage, warrantyDispatchWeek, normalizeWarrantyDeskSearch, warrantyQueueSlaFilter, warrantyDeskUrlValue } from "@/lib/warranty/desk-query"
import { getBooksUiAccess } from "@/lib/services/books/ui-access"
import { Suspense } from "react"
import { connection } from "next/server"
import { PageLayout } from "@/components/layout/page-layout"
import { Skeleton } from "@/components/ui/skeleton"
import { isWarrantyAnalyticsAvailable, getWarrantyCostSummary, getWarrantyDefectAnalysis, listWarrantyBackcharges, listWarrantyRequestsForOrg, listWarrantyTechnicians, listWarrantyVisitsForDispatch, listWarrantyVisitsPendingVerification } from "@/lib/services/warranty"
import { WarrantyDeskClient } from "./warranty-desk-client"
import { getAmbientDeskContext } from "@/lib/services/desk-context"


export default function WarrantyDeskPage(props: { searchParams: Promise<{ tab?: string; page?: string; week?: string; [key: string]: string | string[] | undefined }> }) {
  return <PageLayout title="Warranty & service" breadcrumbs={[{ label: "Warranty" }]}><Suspense fallback={<WarrantyDeskLoading />}><WarrantyDeskData {...props} /></Suspense></PageLayout>
}

function WarrantyDeskLoading() {
  return <div aria-label="Loading warranty desk" aria-busy="true" className="space-y-3">{Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className="h-12 w-full" />)}</div>
}

async function WarrantyDeskData({ searchParams }: { searchParams: Promise<{ tab?: string; page?: string; week?: string; [key: string]: string | string[] | undefined }> }) {
  await connection()
  const [ambient, params] = await Promise.all([getAmbientDeskContext(), searchParams])
  const requestedTab = warrantyDeskUrlValue(params.tab)
  const tab = ["queue", "dispatch", "verify", "backcharges", "analytics"].includes(requestedTab ?? "") ? requestedTab! : "queue"
  const page = warrantyDeskUrlPage(warrantyDeskUrlValue(params.page)), pageSize = 100
  const week = warrantyDispatchWeek(warrantyDeskUrlValue(params.week))
  const search = normalizeWarrantyDeskSearch(warrantyDeskUrlValue(params.search)), sla = warrantyQueueSlaFilter(warrantyDeskUrlValue(params.sla))
  const analyticsAvailable = tab !== "analytics" || await isWarrantyAnalyticsAvailable({ divisionId: ambient.divisionId, communityId: ambient.communityId })
  const [requests, visits, pendingVerification, backcharges, defects, costs, technicians, booksAccess] = await Promise.all([
    tab === "queue" ? listWarrantyRequestsForOrg({ status: ["open","in_progress"], search, slaState: sla === "all" ? undefined : sla, page, pageSize, communityId: ambient.communityId, divisionId: ambient.divisionId }) : { rows: [], total: 0 },
    tab === "dispatch" ? listWarrantyVisitsForDispatch({ from: week.from, to: week.to, divisionId: ambient.divisionId, communityId: ambient.communityId, page, pageSize }) : { rows: [], total: 0 },
    tab === "verify" ? listWarrantyVisitsPendingVerification({ divisionId: ambient.divisionId, communityId: ambient.communityId, page, pageSize }) : { rows: [], total: 0 },
    tab === "backcharges" ? listWarrantyBackcharges({ page, pageSize, divisionId: ambient.divisionId, communityId: ambient.communityId }) : { rows: [], total: 0 },
    tab === "analytics" && analyticsAvailable ? getWarrantyDefectAnalysis({ groupBy: "community", divisionId: ambient.divisionId, communityId: ambient.communityId }) : [],
    tab === "analytics" && analyticsAvailable ? getWarrantyCostSummary({ communityId: ambient.communityId, divisionId: ambient.divisionId }) : [],
    tab === "queue" ? listWarrantyTechnicians() : [],
    tab === "analytics" ? getBooksUiAccess() : { adjust: false },
  ])
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    const first = warrantyDeskUrlValue(value)
    if (first !== undefined) query.set(key, first)
  }
  query.set("tab", tab)
  query.delete("page")
  if (tab === "dispatch") query.set("week", week.week)
  const href = `/warranty?${query}`
  const weekHref = (date: string) => {
    const next = new URLSearchParams(query)
    next.set("week", date)
    return `/warranty?${next}`
  }
  const total = tab === "queue" ? requests.total : tab === "dispatch" ? visits.total : tab === "verify" ? pendingVerification.total : backcharges.total
  const activeRows = tab === "queue" ? requests.rows : tab === "dispatch" ? visits.rows : tab === "verify" ? pendingVerification.rows : backcharges.rows
  const dataKey = activeRows.map((row) => row.id).join(",")
  return <div className="space-y-3">
    {tab === "dispatch" && <nav aria-label="Dispatch week" className="flex flex-wrap items-center justify-between gap-3 border border-border px-3 py-2 text-sm">
      <Link prefetch href={weekHref(week.previous)}>Previous week</Link>
      <span className="text-muted-foreground">Week of {week.week} · UTC</span>
      <Link prefetch href={weekHref(week.next)}>Next week</Link>
    </nav>}
    <WarrantyDeskClient key={`${tab}:${page}:${week.week}:${search}:${sla}:${ambient.divisionId ?? ""}:${ambient.communityId ?? ""}:${dataKey}`} initialTab={tab} analyticsAvailable={analyticsAvailable} initialSearch={search} initialSla={sla} dispatchWeekStart={week.from} canReviewAccounting={booksAccess.adjust} requests={requests.rows} total={requests.total} visits={visits.rows} pendingVerification={pendingVerification.rows} backcharges={backcharges.rows} defects={defects} costs={costs} technicians={technicians} />
    {tab !== "analytics" && <QueuePagination page={page} pageSize={pageSize} total={total} href={href} label="Warranty pages" />}
  </div>
}
