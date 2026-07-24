import { PageLayout } from "@/components/layout/page-layout"
import { PurchasingClient } from "@/components/purchasing/purchasing-client"
import { listOrgBidPackages } from "@/lib/services/bids"
import { listCompanies } from "@/lib/services/companies"
import { listVarianceOrders } from "@/lib/services/commitment-change-orders"
import { listCommunities } from "@/lib/services/communities"
import { listCostCodes } from "@/lib/services/cost-codes"
import { listHousePlans } from "@/lib/services/house-plans"
import { listPoCompletions } from "@/lib/services/po-completions"
import { listPoExceptions } from "@/lib/services/po-generation"
import { getPriceBookHealth, listPriceAgreements } from "@/lib/services/price-book"
import { getVarianceAnalysis } from "@/lib/services/reports/variance-analysis"
import { getAmbientDeskContext } from "@/lib/services/desk-context"

export const dynamic = "force-dynamic"

function relationName(value: unknown, fallback: string) {
  const row = Array.isArray(value) ? value[0] : value
  return row && typeof row === "object" && typeof Reflect.get(row, "name") === "string" ? String(Reflect.get(row, "name")) : fallback
}

export default async function PurchasingPage({ searchParams }: { searchParams: Promise<{ tab?: string; project?: string }> }) {
  const params = await searchParams
  const ambient = await getAmbientDeskContext()
  const today = new Date()
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)).toISOString().slice(0, 10)
  const [agreements, health, bids, exceptions, vpos, completions, variance, companies, costCodes, communities, plans] = await Promise.all([
    listPriceAgreements({ page: 1, pageSize: 50, divisionId: ambient.divisionId }), getPriceBookHealth({ divisionId: ambient.divisionId }), listOrgBidPackages(undefined, ambient.divisionId),
    listPoExceptions({ status: "open", page: 1, pageSize: 50 }), listVarianceOrders({ status: "pending", projectId: params.project, page: 1, pageSize: 50 }),
    listPoCompletions({ page: 1, pageSize: 50 }), getVarianceAnalysis({ startDate: monthStart, endDate: today.toISOString().slice(0, 10), divisionId: ambient.divisionId }),
    listCompanies(), listCostCodes(), listCommunities(), listHousePlans(),
  ])

  return <PageLayout title="Purchasing" fullBleed><PurchasingClient
    initialTab={["price-book","bids","exceptions","vpos","variance","completions"].includes(params.tab ?? "") ? params.tab : undefined}
    health={health} agreements={agreements.items} agreementCount={agreements.count}
    bids={bids.filter((row) => row.award_target === "price_agreement").map((row) => ({ id: row.id, title: row.title, jobName: row.job_name ?? "Price book", status: row.status, dueAt: row.due_at ?? null, invites: row.invite_count ?? 0, responses: row.response_count ?? 0 }))}
    exceptions={exceptions.items.map((row) => ({ id: row.id, projectId: row.project_id, projectName: relationName(row.project, "Project"), description: row.description, reason: row.reason, quantity: Number(row.quantity ?? 0), uom: row.uom ?? null, costCode: relationName(row.cost_code, "Uncoded"), candidates: Array.isArray(row.candidates) ? row.candidates.filter((value: unknown): value is string => typeof value === "string") : [], createdAt: row.created_at }))}
    exceptionCount={exceptions.count}
    vpos={vpos.items.map((row) => ({ id: row.id, title: row.title, projectId: row.project_id, vendor: row.company_name ?? "Unassigned", reason: row.reason_label ?? "Unclassified", origin: row.origin ?? "office", totalCents: row.total_cents, photoCount: row.photo_file_ids.length, createdAt: row.created_at }))}
    vpoCount={vpos.count}
    completions={completions.items.map((row) => ({ id: row.id, project: relationName(row.project, "Project"), po: relationName(row.commitment, "Purchase order"), status: row.status, amountCents: row.amount_cents ?? null, reportedAt: row.reported_at }))}
    variance={variance}
    companies={companies.map((row) => ({ id: row.id, name: row.name }))}
    costCodes={costCodes.map((row) => ({ id: row.id, name: row.name, code: row.code }))}
    communities={communities.map((row) => ({ id: row.id, name: row.name, code: row.code }))}
    plans={plans.map((row) => ({ id: row.id, name: row.name, code: row.code }))}
  /></PageLayout>
}
