import { connection } from "next/server"
import { z } from "zod"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { QueuePagination } from "@/components/layout/queue-pagination"
import { PurchasingSkeleton } from "@/components/layout/desk-skeletons"
import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { PurchasingClient } from "@/components/purchasing/purchasing-client"
import { listProductionBidQueue } from "@/lib/services/production-bid-queue"
import { listVarianceOrders } from "@/lib/services/commitment-change-orders"
import { listCostCodes } from "@/lib/services/cost-codes"
import { listPoCompletions } from "@/lib/services/po-completions"
import { listPoExceptions } from "@/lib/services/po-generation"
import { getPriceBookHealth, getRenewalCandidates, listPriceAgreements } from "@/lib/services/price-book"
import { getVarianceAnalysis } from "@/lib/services/reports/variance-analysis"
import { utcReportDateRange } from "@/lib/reports/date-range"
import { listPoPositionExceptions } from "@/lib/services/po-positions"
import { getPurchasingSettings } from "@/lib/services/purchasing-settings"
import { PoPositionBand } from "@/components/purchasing/po-position-band"
import { getAmbientDeskContext } from "@/lib/services/desk-context"
import { DeliveriesTab } from "@/components/purchasing/deliveries-tab"
import { listPoDeliveries } from "@/lib/services/po-receipts"
import { hasPermission } from "@/lib/services/permissions"
import { PoAcknowledgmentsTab } from "@/components/purchasing/po-acknowledgments-tab"
import { listPoAcknowledgmentQueue } from "@/lib/services/po-acknowledgments"


function relationName(value: unknown, fallback: string) {
  const row = Array.isArray(value) ? value[0] : value
  return row && typeof row === "object" && typeof Reflect.get(row, "name") === "string" ? String(Reflect.get(row, "name")) : fallback
}

/** A valid inclusive UTC range from the query string, or null so the desk falls back to the month so far. */
function validRange(from?: string, to?: string) {
  if (!from || !to) return null
  try {
    utcReportDateRange(from, to)
    return { from, to }
  } catch {
    return null
  }
}

async function PurchasingPageContent({ searchParams }: { searchParams: Promise<{ tab?: string; project?: string; page?: string; q?: string; status?: string; state?: string; from?: string; to?: string; vendor?: string; code?: string; pbstatus?: string; expiring?: string }> }) {
  await connection()
  const params = await searchParams
  const tab = ["price-book", "bids", "exceptions", "vpos", "variance", "completions", "deliveries", "acknowledgments"].includes(params.tab ?? "") ? params.tab! : "price-book"
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
  const varianceRange = validRange(params.from, params.to) ?? { from: monthStart, to: today.toISOString().slice(0, 10) }
  const deliveryStates = [["open", "Owed"], ["late", "Late"], ["short", "Short"], ["partial", "Partial"], ["expected", "Expected"], ["all", "All"]] as const
  const deliveryState = deliveryStates.find(([value]) => value === params.state)?.[0] ?? "open"
  const deliveriesRequest = tab === "deliveries"
    ? Promise.all([
      listPoDeliveries({ state: deliveryState, projectId: params.project, divisionId: ambient.divisionId, communityId: ambient.communityId, page, pageSize }),
      hasPermission("po_receipt.record"),
      hasPermission("po_exception.resolve"),
    ])
    : null
  const agreementStates = ["draft", "active", "expired", "superseded", "void"] as const
  const priceBookFilters = {
    companyId: z.string().uuid().safeParse(params.vendor).data,
    costCodeId: z.string().uuid().safeParse(params.code).data,
    status: agreementStates.find((value) => value === params.pbstatus),
    expiring: params.expiring === "1",
  }
  const acknowledgmentStates = [["action", "Needs action"], ["disputed", "Disputed"], ["revised", "Revised"], ["pending", "Pending"], ["accepted", "Accepted"], ["all", "All"]] as const
  const acknowledgmentState = acknowledgmentStates.find(([value]) => value === params.state)?.[0] ?? "action"
  const acknowledgmentsRequest = tab === "acknowledgments"
    ? Promise.all([
      listPoAcknowledgmentQueue({ state: acknowledgmentState, divisionId: ambient.divisionId, communityId: ambient.communityId, page, pageSize }),
      hasPermission("po_exception.resolve"),
    ])
    : null
  const healthRequest = tab === "price-book" ? getPriceBookHealth({ divisionId: ambient.divisionId }) : Promise.resolve(null)
  const [agreements, health, renewals, bids, exceptions, vpos, completions, variance, costCodes, positions, settings] = await Promise.all([
    tab === "price-book" ? listPriceAgreements({
      page, pageSize, divisionId: ambient.divisionId, companyId: priceBookFilters.companyId, costCodeId: priceBookFilters.costCodeId,
      status: priceBookFilters.status, ...(priceBookFilters.expiring ? { expiringWithinDays: (await healthRequest)?.leadDays } : {}),
    }) : emptyPage,
    healthRequest,
    healthRequest.then((value) => value ? getRenewalCandidates({ divisionId: ambient.divisionId, windowDays: value.leadDays }) : null),
    tab === "bids" ? listProductionBidQueue({ page, pageSize, divisionId: ambient.divisionId, communityId: ambient.communityId, search, status: bidStatus }) : emptyPage,
    tab === "exceptions" ? listPoExceptions({ status: "open", projectId: params.project, divisionId: ambient.divisionId, communityId: ambient.communityId, page, pageSize }) : emptyPage,
    tab === "vpos" ? listVarianceOrders({ status: "pending", projectId: params.project, divisionId: ambient.divisionId, communityId: ambient.communityId, page, pageSize }) : emptyPage,
    tab === "completions" ? listPoCompletions({ projectId: params.project, divisionId: ambient.divisionId, communityId: ambient.communityId, page, pageSize }) : emptyPage,
    tab === "variance" ? getVarianceAnalysis({ startDate: varianceRange.from, endDate: varianceRange.to, divisionId: ambient.divisionId }) : null,
    tab === "price-book" ? listCostCodes() : [],
    tab === "completions" ? listPoPositionExceptions({ divisionId: ambient.divisionId, communityId: ambient.communityId }) : null,
    tab === "completions" ? getPurchasingSettings() : null,
  ])

  const [acknowledgments, canResolveAcknowledgment] = acknowledgmentsRequest ? await acknowledgmentsRequest : [null, false]
  const [deliveries, canReceive, canResolveShortage] = deliveriesRequest ? await deliveriesRequest : [null, false, false]
  const total = acknowledgments ? acknowledgments.total : deliveries ? deliveries.total : tab === "bids" ? bids.count : tab === "price-book" ? agreements.count : tab === "exceptions" ? exceptions.count : tab === "vpos" ? vpos.count : tab === "completions" ? completions.count : null
  const paginationParams = new URLSearchParams({ tab })
  if (tab === "bids" && search) paginationParams.set("q", search)
  if (tab === "bids" && bidStatus) paginationParams.set("status", bidStatus)
  if (params.project) paginationParams.set("project", params.project)
  if (tab === "price-book") {
    if (priceBookFilters.companyId) paginationParams.set("vendor", priceBookFilters.companyId)
    if (priceBookFilters.costCodeId) paginationParams.set("code", priceBookFilters.costCodeId)
    if (priceBookFilters.status) paginationParams.set("pbstatus", priceBookFilters.status)
    if (priceBookFilters.expiring) paginationParams.set("expiring", "1")
  }
  if (tab === "deliveries") paginationParams.set("state", deliveryState)
  if (tab === "acknowledgments") paginationParams.set("state", acknowledgmentState)
  return <PageLayout title="Purchasing" fullBleed>
    {positions && <PoPositionBand rows={positions.rows} total={positions.total} truncated={positions.truncated} />}
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
    key={`${ambient.divisionId ?? ""}:${ambient.communityId ?? ""}:${params.project ?? ""}:${tab}:${page}:${search}:${bidStatus ?? ""}:${priceBookFilters.companyId ?? ""}:${priceBookFilters.costCodeId ?? ""}:${priceBookFilters.status ?? ""}:${priceBookFilters.expiring}`} initialTab={tab}
    health={health} agreements={agreements.items} agreementCount={agreements.count}
    renewals={renewals ?? { rows: [], count: 0 }}
    priceBookFilters={{
      company: priceBookFilters.companyId ? { id: priceBookFilters.companyId, name: agreements.items[0]?.company_name ?? "Selected vendor", detail: "" } : null,
      costCodeId: priceBookFilters.costCodeId ?? "", state: priceBookFilters.status ?? "", expiring: priceBookFilters.expiring,
    }}
    bids={bids.items}
    exceptions={exceptions.items.map((row) => ({ id: row.id, projectId: row.project_id, projectName: relationName(row.project, "Project"), description: row.description, reason: row.reason, quantity: Number(row.quantity ?? 0), uom: row.uom ?? null, costCode: relationName(row.cost_code, "Uncoded"), candidates: Array.isArray(row.candidates) ? row.candidates.filter((value: unknown): value is string => typeof value === "string") : [], createdAt: row.created_at }))}
    exceptionCount={exceptions.count}
    vpos={vpos.items.map((row) => ({ id: row.id, title: row.title, projectId: row.project_id, commitmentId: row.commitment_id, evidenceCount: row.evidence_file_ids.length, vendor: row.company_name ?? "Unassigned", reason: row.reason_label ?? "Unclassified", origin: row.origin ?? "office", totalCents: row.total_cents, photoCount: row.photo_file_ids.length, createdAt: row.created_at }))}
    vpoCount={vpos.count}
    completions={completions.items.map((row) => ({ id: row.id, project: relationName(row.project, "Project"), po: relationName(row.commitment, "Purchase order"), status: row.status, amountCents: row.amount_cents ?? null, reportedAt: row.reported_at }))}
    variance={variance} varianceRange={varianceRange} requiresInspection={settings?.po_completion_requires_inspection === true}
    costCodes={costCodes.map((row) => ({ id: row.id, name: row.name, code: row.code }))}
    acknowledgments={acknowledgments && <PoAcknowledgmentsTab rows={acknowledgments.rows} total={acknowledgments.total} pageSize={pageSize} canResolve={canResolveAcknowledgment}
      filters={acknowledgmentStates.map(([value, label]) => ({
        value, label, active: value === acknowledgmentState,
        count: value === "disputed" || value === "revised" || value === "pending" || value === "accepted" ? acknowledgments.counts[value] : undefined,
        href: `/purchasing?${new URLSearchParams({ tab: "acknowledgments", state: value, ...(params.project ? { project: params.project } : {}) })}`,
      }))} />}
    deliveries={deliveries && <DeliveriesTab rows={deliveries.rows} total={deliveries.total} pageSize={pageSize} canRecord={canReceive} canResolve={canResolveShortage}
      filters={deliveryStates.map(([value, label]) => ({ value, label, active: value === deliveryState, href: `/purchasing?${new URLSearchParams({ tab: "deliveries", state: value, ...(params.project ? { project: params.project } : {}) })}` }))} />}
  />{total !== null && <QueuePagination page={page} pageSize={pageSize} total={total} href={`/purchasing?${paginationParams}`} />}</PageLayout>
}

export default function PurchasingPage(props: Parameters<typeof PurchasingPageContent>[0]) {
  return (
    <Suspense fallback={<PageLayout title="Purchasing" fullBleed><PurchasingSkeleton /></PageLayout>}>
      <PurchasingPageContent {...props} />
    </Suspense>
  )
}
