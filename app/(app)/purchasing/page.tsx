import { connection } from "next/server"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { QueuePagination } from "@/components/layout/queue-pagination"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { PurchasingClient } from "@/components/purchasing/purchasing-client"
import { listProductionBidQueue } from "@/lib/services/production-bid-queue"
import { listVarianceOrders } from "@/lib/services/commitment-change-orders"
import { listCostCodes } from "@/lib/services/cost-codes"
import { listPoCompletions } from "@/lib/services/po-completions"
import { listPoExceptions } from "@/lib/services/po-generation"
import { getPriceBookHealth, listPriceAgreements } from "@/lib/services/price-book"
import { getVarianceAnalysis } from "@/lib/services/reports/variance-analysis"
import { getAmbientDeskContext } from "@/lib/services/desk-context"


function relationName(value: unknown, fallback: string) {
  const row = Array.isArray(value) ? value[0] : value
  return row && typeof row === "object" && typeof Reflect.get(row, "name") === "string" ? String(Reflect.get(row, "name")) : fallback
}

async function PurchasingPageContent({ searchParams }: { searchParams: Promise<{ tab?: string; project?: string; page?: string; q?: string; status?: string }> }) {
  await connection()
  const params = await searchParams
  const tab = ["price-book", "bids", "exceptions", "vpos", "variance", "completions"].includes(params.tab ?? "") ? params.tab! : "price-book"
  const requestedPage = Number(params.page ?? 1)
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1
  const bidStatuses = ["draft", "sent", "open", "closed", "awarded", "cancelled"] as const
  const bidStatus = bidStatuses.find((value) => value === params.status)
  const search = (params.q ?? "").slice(0, 200)
  const pageSize = 50
  const emptyPage = { items: [], count: 0 }
  const ambient = await getAmbientDeskContext()
  const today = new Date()
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)).toISOString().slice(0, 10)
  const [agreements, health, bids, exceptions, vpos, completions, variance, costCodes] = await Promise.all([
    tab === "price-book" ? listPriceAgreements({ page, pageSize, divisionId: ambient.divisionId }) : emptyPage,
    tab === "price-book" ? getPriceBookHealth({ divisionId: ambient.divisionId }) : null,
    tab === "bids" ? listProductionBidQueue({ page, pageSize, divisionId: ambient.divisionId, communityId: ambient.communityId, search, status: bidStatus }) : emptyPage,
    tab === "exceptions" ? listPoExceptions({ status: "open", projectId: params.project, divisionId: ambient.divisionId, communityId: ambient.communityId, page, pageSize }) : emptyPage,
    tab === "vpos" ? listVarianceOrders({ status: "pending", projectId: params.project, divisionId: ambient.divisionId, communityId: ambient.communityId, page, pageSize }) : emptyPage,
    tab === "completions" ? listPoCompletions({ projectId: params.project, divisionId: ambient.divisionId, communityId: ambient.communityId, page, pageSize }) : emptyPage,
    tab === "variance" ? getVarianceAnalysis({ startDate: monthStart, endDate: today.toISOString().slice(0, 10), divisionId: ambient.divisionId }) : null,
    tab === "price-book" ? listCostCodes() : [],
  ])

  const total = tab === "bids" ? bids.count : tab === "price-book" ? agreements.count : tab === "exceptions" ? exceptions.count : tab === "vpos" ? vpos.count : tab === "completions" ? completions.count : null
  const paginationParams = new URLSearchParams({ tab })
  if (tab === "bids" && search) paginationParams.set("q", search)
  if (tab === "bids" && bidStatus) paginationParams.set("status", bidStatus)
  if (params.project) paginationParams.set("project", params.project)
  return <PageLayout title="Purchasing" fullBleed>
    {tab === "bids" && <form action="/purchasing" className="flex flex-wrap items-center gap-2 border-b p-4">
      <input type="hidden" name="tab" value="bids" />
      <label htmlFor="production-bid-search" className="sr-only">Search bid packages</label>
      <Input id="production-bid-search" name="q" defaultValue={search} maxLength={200} placeholder="Search bid packages" className="max-w-sm" />
      <label htmlFor="production-bid-status" className="sr-only">Bid status</label>
      <select id="production-bid-status" name="status" defaultValue={bidStatus ?? ""} className="h-9 border bg-background px-3 text-sm">
        <option value="">All except cancelled</option>
        {bidStatuses.map((status) => <option key={status} value={status}>{status[0].toUpperCase() + status.slice(1)}</option>)}
      </select>
      <Button type="submit" variant="outline">Filter</Button>
    </form>}
    <PurchasingClient
    key={`${ambient.divisionId ?? ""}:${ambient.communityId ?? ""}:${params.project ?? ""}:${tab}:${page}:${search}:${bidStatus ?? ""}`} initialTab={tab}
    health={health} agreements={agreements.items} agreementCount={agreements.count}
    bids={bids.items}
    exceptions={exceptions.items.map((row) => ({ id: row.id, projectId: row.project_id, projectName: relationName(row.project, "Project"), description: row.description, reason: row.reason, quantity: Number(row.quantity ?? 0), uom: row.uom ?? null, costCode: relationName(row.cost_code, "Uncoded"), candidates: Array.isArray(row.candidates) ? row.candidates.filter((value: unknown): value is string => typeof value === "string") : [], createdAt: row.created_at }))}
    exceptionCount={exceptions.count}
    vpos={vpos.items.map((row) => ({ id: row.id, title: row.title, projectId: row.project_id, vendor: row.company_name ?? "Unassigned", reason: row.reason_label ?? "Unclassified", origin: row.origin ?? "office", totalCents: row.total_cents, photoCount: row.photo_file_ids.length, createdAt: row.created_at }))}
    vpoCount={vpos.count}
    completions={completions.items.map((row) => ({ id: row.id, project: relationName(row.project, "Project"), po: relationName(row.commitment, "Purchase order"), status: row.status, amountCents: row.amount_cents ?? null, reportedAt: row.reported_at }))}
    variance={variance}
    costCodes={costCodes.map((row) => ({ id: row.id, name: row.name, code: row.code }))}
  />{total !== null && <QueuePagination page={page} pageSize={pageSize} total={total} href={`/purchasing?${paginationParams}`} />}</PageLayout>
}

export default function PurchasingPage(props: Parameters<typeof PurchasingPageContent>[0]) {
  return (
    <Suspense fallback={<PageLayout title="Purchasing" fullBleed><PageLoadingSkeleton /></PageLayout>}>
      <PurchasingPageContent {...props} />
    </Suspense>
  )
}
