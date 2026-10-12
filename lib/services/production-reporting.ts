import "server-only"

import { originalMargin, rollUpOriginalMargin, type CapturedBaseline, type HomeMarginBaselineStage } from "@/lib/financials/home-margin-baseline"
import { projectedMargin, rollUpProjectedMargin } from "@/lib/financials/production-margin"
import {
  getDivisionAccessForUser,
  getDivisionScopedProjectIds,
} from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { readAllRowsById, type RangeResult } from "@/lib/land/paging"

type Relation<T> = T | T[] | null

function one<T>(value: Relation<T>): T | null {
  return Array.isArray(value) ? value[0] ?? null : value
}

function sum(rows: Array<{ amount: number }>) {
  return rows.reduce((total, row) => total + row.amount, 0)
}

export type ProductionLotPnlRow = {
  projectId: string
  projectName: string
  lotNumber: string
  planId: string | null
  planName: string
  status: string
  revenueCents: number
  budgetCents: number
  actualCostCents: number
  vpoCents: number
  projectedCostCents: number
  projectedMarginCents: number
  projectedMarginPercent: number
  /**
   * The margin the home was released at (else sold at), locked when captured;
   * null when the home has no baseline or its cost was unknown then.
   */
  originalMarginCents: number | null
  originalMarginPercent: number | null
  originalMarginStage: HomeMarginBaselineStage | null
}

export type CommunityPnlRow = {
  communityId: string
  communityName: string
  divisionId: string | null
  revenueCents: number
  closedRevenueCents: number
  backlogRevenueCents: number
  budgetCents: number
  actualCostCents: number
  vpoCents: number
  projectedCostCents: number
  projectedMarginCents: number
  projectedMarginPercent: number
  targetMarginPercent: number | null
  /** Original margin over the homes that have one, as a percent of their original sale price. */
  originalMarginCents: number | null
  originalMarginPercent: number | null
  originalMarginHomes: number
  lotCount: number
  lots: ProductionLotPnlRow[]
}

export type ProductionPortfolioReport = {
  communities: CommunityPnlRow[]
  plans: Array<{
    planId: string
    planName: string
    homes: number
    revenueCents: number
    costCents: number
    marginCents: number
    marginPercent: number
  }>
  variance: Array<{
    key: string
    reason: string
    trade: string
    count: number
    amountCents: number
    percentOfDirectCost: number
  }>
  totals: {
    revenueCents: number
    closedRevenueCents: number
    backlogRevenueCents: number
    budgetCents: number
    actualCostCents: number
    vpoCents: number
    marginCents: number
    marginPercent: number
  }
}

/** IDs per `.in()` filter; a longer list does not fit in a PostgREST URL. */
const ID_CHUNK = 100
/** Past this many rows in one set the report fails instead of understating it. */
const REPORT_ROW_CAP = 200_000

type IdRow = { id: string }
type CommunityRow = IdRow & { name: string; division_id: string | null; settings: unknown }
type LotRow = IdRow & { community_id: string; project_id: string; lot_number: string; status: string; house_plan_id: string | null; plan: unknown; project: unknown }
type ContractRow = IdRow & { project_id: string; total_cents: number | null; signed_at: string | null }
type ClosingRow = IdRow & { project_id: string; status: string; settlement: unknown; actual_date: string | null; scheduled_date: string | null }
type BudgetRow = IdRow & { project_id: string; total_cents: number | null; version: number | null }
type CostRow = IdRow & { project_id: string; cost_cents: number | null }
type VpoRow = IdRow & { project_id: string; total_cents: number | null; reason: unknown; company: unknown }
type BaselineRow = IdRow & { project_id: string; stage: HomeMarginBaselineStage; captured_at: string; sale_price_cents: number | null; cost_cents: number | null; margin_cents: number | null; margin_bps: number | null }

/**
 * Every row matching `read` for each ID chunk, keyset-paged to the end. A
 * portfolio summed from the first API page is not a smaller number, it is a
 * wrong one — the margin of every home past the cap simply vanished.
 */
async function readForIds<Row extends IdRow>(
  ids: string[],
  label: string,
  read: (chunk: string[], afterId: string | null, limit: number) => PromiseLike<RangeResult<Row>>,
): Promise<Row[]> {
  const chunks: string[][] = []
  for (let index = 0; index < ids.length; index += ID_CHUNK) chunks.push(ids.slice(index, index + ID_CHUNK))
  const pages = await Promise.all(chunks.map((chunk) =>
    readAllRowsById<Row>((afterId, limit) => read(chunk, afterId, limit), { cap: REPORT_ROW_CAP, label, pageSize: 1000 })))
  return pages.flat()
}

export async function getProductionPortfolioReport(
  filters: { communityId?: string; divisionId?: string } = {},
  orgId?: string,
): Promise<ProductionPortfolioReport> {
  const context = await requireOrgContext(orgId)
  await requirePermission("report.read", context)
  const divisionAccess = await getDivisionAccessForUser({
    orgId: context.orgId,
    userId: context.userId,
  })
  if (
    filters.divisionId &&
    divisionAccess.assignedOnly &&
    !divisionAccess.divisionIds.includes(filters.divisionId)
  ) {
    return emptyPortfolio()
  }
  const authorizedProjectIds = await getDivisionScopedProjectIds({
    orgId: context.orgId,
    userId: context.userId,
    supabase: context.supabase,
  })

  if (!filters.divisionId && divisionAccess.assignedOnly && divisionAccess.divisionIds.length === 0) return emptyPortfolio()
  const { supabase, orgId: scopedOrgId } = context
  const communities = (await readAllRowsById<CommunityRow>((afterId, limit) => {
    let query = supabase
      .from("communities")
      .select("id,name,division_id,settings")
      .eq("org_id", scopedOrgId)
      .is("archived_at", null)
    if (filters.communityId) query = query.eq("id", filters.communityId)
    if (filters.divisionId) query = query.eq("division_id", filters.divisionId)
    else if (divisionAccess.assignedOnly) query = query.in("division_id", divisionAccess.divisionIds)
    if (afterId) query = query.gt("id", afterId)
    return query.order("id").limit(limit).returns<CommunityRow[]>()
  }, { cap: REPORT_ROW_CAP, label: "Failed to load reporting communities", pageSize: 1000 }))
    .sort((left, right) => left.name.localeCompare(right.name))
  const communityIds = communities.map((row) => row.id)
  if (communityIds.length === 0 || (authorizedProjectIds !== null && authorizedProjectIds.length === 0)) {
    return emptyPortfolio()
  }

  const authorized = authorizedProjectIds === null ? null : new Set(authorizedProjectIds)
  const lots = (await readForIds<LotRow>(communityIds, "Failed to load community homes", (chunk, afterId, limit) => {
    let query = supabase
      .from("lots")
      .select("id,community_id,project_id,lot_number,status,house_plan_id,plan:house_plans(id,name,code),project:projects(name,division_id)")
      .eq("org_id", scopedOrgId)
      .in("community_id", chunk)
      .not("project_id", "is", null)
    if (afterId) query = query.gt("id", afterId)
    return query.order("id").limit(limit).returns<LotRow[]>()
  })).filter((lot) => authorized === null || authorized.has(lot.project_id))
  const projectIds = Array.from(new Set(lots.map((row) => row.project_id).filter(Boolean)))
  if (projectIds.length === 0) {
    return { ...emptyPortfolio(), communities: communities.map((row) => emptyCommunity(row)) }
  }

  const [contractRows, closingRows, budgetRows, costRows, vpoRows, baselineRows] = await Promise.all([
    readForIds<ContractRow>(projectIds, "Failed to load purchase agreements", (chunk, afterId, limit) => {
      let query = supabase.from("contracts").select("id,project_id,total_cents,signed_at")
        .eq("org_id", scopedOrgId).in("project_id", chunk).eq("contract_type", "purchase_agreement")
      if (afterId) query = query.gt("id", afterId)
      return query.order("id").limit(limit).returns<ContractRow[]>()
    }),
    readForIds<ClosingRow>(projectIds, "Failed to load closings", (chunk, afterId, limit) => {
      let query = supabase.from("closings").select("id,project_id,status,settlement,actual_date,scheduled_date")
        .eq("org_id", scopedOrgId).in("project_id", chunk).neq("status", "cancelled")
      if (afterId) query = query.gt("id", afterId)
      return query.order("id").limit(limit).returns<ClosingRow[]>()
    }),
    // The baseline is the newest budget that has left draft: a draft being
    // worked on must never replace the approved number margin is read against.
    readForIds<BudgetRow>(projectIds, "Failed to load budgets", (chunk, afterId, limit) => {
      let query = supabase.from("budgets").select("id,project_id,total_cents,version")
        .eq("org_id", scopedOrgId).in("project_id", chunk).neq("status", "draft")
      if (afterId) query = query.gt("id", afterId)
      return query.order("id").limit(limit).returns<BudgetRow[]>()
    }),
    readForIds<CostRow>(projectIds, "Failed to load job cost", (chunk, afterId, limit) => {
      let query = supabase.from("job_cost_entries").select("id,project_id,cost_cents")
        .eq("org_id", scopedOrgId).in("project_id", chunk).eq("status", "posted")
      if (afterId) query = query.gt("id", afterId)
      return query.order("id").limit(limit).returns<CostRow[]>()
    }),
    readForIds<VpoRow>(projectIds, "Failed to load variance POs", (chunk, afterId, limit) => {
      let query = supabase.from("commitment_change_orders").select("id,project_id,total_cents,reason:variance_reason_codes(code,label),company:companies(name)")
        .eq("org_id", scopedOrgId).in("project_id", chunk).not("reason_code_id", "is", null).in("status", ["approved", "executed"])
      if (afterId) query = query.gt("id", afterId)
      return query.order("id").limit(limit).returns<VpoRow[]>()
    }),
    readForIds<BaselineRow>(projectIds, "Failed to load margin baselines", (chunk, afterId, limit) => {
      let query = supabase.from("home_margin_baselines").select("id,project_id,stage,captured_at,sale_price_cents,cost_cents,margin_cents,margin_bps")
        .eq("org_id", scopedOrgId).in("project_id", chunk)
      if (afterId) query = query.gt("id", afterId)
      return query.order("id").limit(limit).returns<BaselineRow[]>()
    }),
  ])

  // The newest signed agreement per home (unsigned ones last), as the old
  // `signed_at desc nulls last` ordering chose.
  const contracts = new Map<string, ContractRow>()
  for (const row of contractRows) {
    const current = contracts.get(row.project_id)
    if (!current || (row.signed_at ?? "") > (current.signed_at ?? "")) contracts.set(row.project_id, row)
  }
  const closings = new Map<string, ClosingRow>(closingRows.map((row) => [row.project_id, row]))
  const latestBudget = new Map<string, BudgetRow>()
  for (const row of budgetRows) {
    const current = latestBudget.get(row.project_id)
    if (!current || Number(row.version ?? 0) > Number(current.version ?? 0)) latestBudget.set(row.project_id, row)
  }
  const budgets = new Map<string, number>(Array.from(latestBudget, ([projectId, row]) => [projectId, Number(row.total_cents ?? 0)]))
  const costs = new Map<string, number>()
  for (const row of costRows) costs.set(row.project_id, (costs.get(row.project_id) ?? 0) + Number(row.cost_cents ?? 0))
  const vpos = new Map<string, number>()
  for (const row of vpoRows) vpos.set(row.project_id, (vpos.get(row.project_id) ?? 0) + Number(row.total_cents ?? 0))
  const baselines = new Map<string, CapturedBaseline[]>()
  for (const row of baselineRows) {
    baselines.set(row.project_id, [...(baselines.get(row.project_id) ?? []), {
      stage: row.stage, capturedAt: row.captured_at, salePriceCents: row.sale_price_cents, costCents: row.cost_cents, marginCents: row.margin_cents, marginBps: row.margin_bps,
    }])
  }

  const lotRows: Array<ProductionLotPnlRow & { communityId: string }> = lots.map((lot) => {
    const contract = contracts.get(lot.project_id)
    const closing: any = closings.get(lot.project_id)
    const settlementTotal = closing?.settlement?.finalPriceCents ?? closing?.settlement?.final_price_cents
    const revenueCents = Number(settlementTotal ?? contract?.total_cents ?? 0)
    const budgetCents = budgets.get(lot.project_id) ?? 0
    const actualCostCents = costs.get(lot.project_id) ?? 0
    const vpoCents = vpos.get(lot.project_id) ?? 0
    const margin = projectedMargin({ revenueCents, budgetCents, actualCostCents, vpoCents })
    const original = originalMargin(baselines.get(lot.project_id) ?? [])
    return {
      communityId: lot.community_id,
      projectId: lot.project_id,
      projectName: one<any>(lot.project)?.name ?? `Lot ${lot.lot_number}`,
      lotNumber: lot.lot_number,
      planId: lot.house_plan_id ?? null,
      planName: one<any>(lot.plan)?.name ?? one<any>(lot.plan)?.code ?? "Unassigned",
      status: closing?.status === "closed" ? "closed" : contract ? "backlog" : lot.status,
      revenueCents,
      budgetCents,
      actualCostCents,
      vpoCents,
      projectedCostCents: margin.projectedCostCents,
      projectedMarginCents: margin.marginCents,
      projectedMarginPercent: margin.marginPercent,
      originalMarginCents: original?.marginCents ?? null,
      originalMarginPercent: original?.marginBps == null ? null : original.marginBps / 100,
      originalMarginStage: original?.stage ?? null,
    }
  })

  const communityRows = communities.map((community) => {
    const scopedLots = lotRows.filter((row) => row.communityId === community.id)
    const revenueCents = sum(scopedLots.map((row) => ({ amount: row.revenueCents })))
    const budgetCents = sum(scopedLots.map((row) => ({ amount: row.budgetCents })))
    const actualCostCents = sum(scopedLots.map((row) => ({ amount: row.actualCostCents })))
    const vpoCents = sum(scopedLots.map((row) => ({ amount: row.vpoCents })))
    const rollup = rollUpProjectedMargin(scopedLots.map((row) => ({ revenueCents: row.revenueCents, projectedCostCents: row.projectedCostCents, marginCents: row.projectedMarginCents })))
    const closedRevenueCents = sum(scopedLots.filter((row) => row.status === "closed").map((row) => ({ amount: row.revenueCents })))
    const original = rollUpOriginalMargin(scopedLots.map((row) => originalMargin(baselines.get(row.projectId) ?? [])))
    return {
      communityId: community.id,
      communityName: community.name,
      divisionId: community.division_id ?? null,
      revenueCents,
      closedRevenueCents,
      backlogRevenueCents: revenueCents - closedRevenueCents,
      budgetCents,
      actualCostCents,
      vpoCents,
      projectedCostCents: rollup.projectedCostCents,
      projectedMarginCents: rollup.marginCents,
      projectedMarginPercent: rollup.marginPercent,
      targetMarginPercent: typeof (community.settings as any)?.target_margin_percent === "number"
        ? Number((community.settings as any).target_margin_percent)
        : typeof (community.settings as any)?.margin_target_percent === "number"
          ? Number((community.settings as any).margin_target_percent)
          : null,
      originalMarginCents: original.marginCents,
      originalMarginPercent: original.marginPercent,
      originalMarginHomes: original.homes,
      lotCount: scopedLots.length,
      lots: scopedLots.map(({ communityId: _communityId, ...row }) => row),
    }
  })

  const planMap = new Map<string, ProductionPortfolioReport["plans"][number]>()
  for (const row of lotRows) {
    if (!row.planId) continue
    const existing = planMap.get(row.planId) ?? {
      planId: row.planId,
      planName: row.planName,
      homes: 0,
      revenueCents: 0,
      costCents: 0,
      marginCents: 0,
      marginPercent: 0,
    }
    existing.homes += 1
    existing.revenueCents += row.revenueCents
    existing.costCents += row.projectedCostCents
    existing.marginCents = existing.revenueCents - existing.costCents
    existing.marginPercent = existing.revenueCents > 0 ? (existing.marginCents / existing.revenueCents) * 100 : 0
    planMap.set(row.planId, existing)
  }

  const totalDirectCost = sum(lotRows.map((row) => ({ amount: row.projectedCostCents })))
  const varianceMap = new Map<string, ProductionPortfolioReport["variance"][number]>()
  for (const row of vpoRows) {
    const reasonRow = one<any>(row.reason)
    const companyRow = one<any>(row.company)
    const reason = reasonRow?.label ?? reasonRow?.code ?? "Uncoded"
    const trade = companyRow?.name ?? "Unassigned trade"
    const key = `${reason}:${trade}`
    const existing = varianceMap.get(key) ?? { key, reason, trade, count: 0, amountCents: 0, percentOfDirectCost: 0 }
    existing.count += 1
    existing.amountCents += Number(row.total_cents ?? 0)
    existing.percentOfDirectCost = totalDirectCost > 0 ? (existing.amountCents / totalDirectCost) * 100 : 0
    varianceMap.set(key, existing)
  }

  const revenueCents = sum(communityRows.map((row) => ({ amount: row.revenueCents })))
  const closedRevenueCents = sum(communityRows.map((row) => ({ amount: row.closedRevenueCents })))
  const budgetCents = sum(communityRows.map((row) => ({ amount: row.budgetCents })))
  const actualCostCents = sum(communityRows.map((row) => ({ amount: row.actualCostCents })))
  const vpoCents = sum(communityRows.map((row) => ({ amount: row.vpoCents })))
  const portfolio = rollUpProjectedMargin(communityRows.map((row) => ({ revenueCents: row.revenueCents, projectedCostCents: row.projectedCostCents, marginCents: row.projectedMarginCents })))
  return {
    communities: communityRows,
    plans: Array.from(planMap.values()).sort((a, b) => b.marginCents - a.marginCents),
    variance: Array.from(varianceMap.values()).sort((a, b) => b.amountCents - a.amountCents),
    totals: {
      revenueCents,
      closedRevenueCents,
      backlogRevenueCents: revenueCents - closedRevenueCents,
      budgetCents,
      actualCostCents,
      vpoCents,
      marginCents: portfolio.marginCents,
      marginPercent: portfolio.marginPercent,
    },
  }
}

export async function getCommunityPnl(communityId: string, orgId?: string) {
  const report = await getProductionPortfolioReport({ communityId }, orgId)
  return report.communities[0] ?? null
}

function emptyCommunity(row: any): CommunityPnlRow {
  return {
    communityId: row.id,
    communityName: row.name,
    divisionId: row.division_id ?? null,
    revenueCents: 0,
    closedRevenueCents: 0,
    backlogRevenueCents: 0,
    budgetCents: 0,
    actualCostCents: 0,
    vpoCents: 0,
    projectedCostCents: 0,
    projectedMarginCents: 0,
    projectedMarginPercent: 0,
    targetMarginPercent: null,
    originalMarginCents: null,
    originalMarginPercent: null,
    originalMarginHomes: 0,
    lotCount: 0,
    lots: [],
  }
}

function emptyPortfolio(): ProductionPortfolioReport {
  return {
    communities: [],
    plans: [],
    variance: [],
    totals: {
      revenueCents: 0,
      closedRevenueCents: 0,
      backlogRevenueCents: 0,
      budgetCents: 0,
      actualCostCents: 0,
      vpoCents: 0,
      marginCents: 0,
      marginPercent: 0,
    },
  }
}
