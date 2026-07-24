import "server-only"

import {
  getDivisionAccessForUser,
  getDivisionScopedProjectIds,
} from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"

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
  projectedMarginCents: number
  projectedMarginPercent: number
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
  projectedMarginCents: number
  projectedMarginPercent: number
  targetMarginPercent: number | null
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

  let communityQuery = context.supabase
    .from("communities")
    .select("id,name,division_id,settings")
    .eq("org_id", context.orgId)
    .is("archived_at", null)
    .order("name")
    .limit(250)
  if (filters.communityId) communityQuery = communityQuery.eq("id", filters.communityId)
  if (filters.divisionId) communityQuery = communityQuery.eq("division_id", filters.divisionId)
  else if (divisionAccess.assignedOnly) {
    if (divisionAccess.divisionIds.length === 0) return emptyPortfolio()
    communityQuery = communityQuery.in("division_id", divisionAccess.divisionIds)
  }
  const { data: communities, error: communityError } = await communityQuery
  if (communityError) throw new Error(`Failed to load reporting communities: ${communityError.message}`)
  const communityIds = (communities ?? []).map((row) => row.id as string)
  if (communityIds.length === 0 || (authorizedProjectIds !== null && authorizedProjectIds.length === 0)) {
    return emptyPortfolio()
  }

  let lotQuery = context.supabase
    .from("lots")
    .select("id,community_id,project_id,lot_number,status,house_plan_id,plan:house_plans(id,name,code),project:projects(name,division_id)")
    .eq("org_id", context.orgId)
    .in("community_id", communityIds)
    .not("project_id", "is", null)
    .limit(2_000)
  if (authorizedProjectIds !== null) lotQuery = lotQuery.in("project_id", authorizedProjectIds)
  const { data: lots, error: lotError } = await lotQuery
  if (lotError) throw new Error(`Failed to load community homes: ${lotError.message}`)
  const projectIds = Array.from(new Set((lots ?? []).map((row) => row.project_id as string).filter(Boolean)))
  if (projectIds.length === 0) {
    return { ...emptyPortfolio(), communities: (communities ?? []).map((row) => emptyCommunity(row)) }
  }

  const [contractsResult, closingsResult, budgetsResult, costsResult, vpoResult] = await Promise.all([
    context.supabase
      .from("contracts")
      .select("project_id,total_cents,status,contract_type,signed_at")
      .eq("org_id", context.orgId)
      .in("project_id", projectIds)
      .eq("contract_type", "purchase_agreement")
      .order("signed_at", { ascending: false, nullsFirst: false })
      .limit(2_000),
    context.supabase
      .from("closings")
      .select("project_id,status,settlement,actual_date,scheduled_date")
      .eq("org_id", context.orgId)
      .in("project_id", projectIds)
      .neq("status", "cancelled")
      .limit(2_000),
    context.supabase
      .from("budgets")
      .select("project_id,total_cents,version,status")
      .eq("org_id", context.orgId)
      .in("project_id", projectIds)
      .order("version", { ascending: false })
      .limit(2_000),
    context.supabase
      .from("job_cost_entries")
      .select("project_id,cost_cents")
      .eq("org_id", context.orgId)
      .in("project_id", projectIds)
      .eq("status", "posted")
      .limit(10_000),
    context.supabase
      .from("commitment_change_orders")
      .select("project_id,total_cents,status,reason:variance_reason_codes(code,label),company:companies(name)")
      .eq("org_id", context.orgId)
      .in("project_id", projectIds)
      .not("reason_code_id", "is", null)
      .in("status", ["approved", "executed"])
      .limit(5_000),
  ])
  for (const result of [contractsResult, closingsResult, budgetsResult, costsResult, vpoResult]) {
    if (result.error) throw new Error(`Failed to load production reporting data: ${result.error.message}`)
  }

  const contracts = new Map<string, any>()
  for (const row of contractsResult.data ?? []) if (!contracts.has(row.project_id)) contracts.set(row.project_id, row)
  const closings = new Map((closingsResult.data ?? []).map((row) => [row.project_id as string, row]))
  const budgets = new Map<string, number>()
  for (const row of budgetsResult.data ?? []) if (!budgets.has(row.project_id)) budgets.set(row.project_id, Number(row.total_cents ?? 0))
  const costs = new Map<string, number>()
  for (const row of costsResult.data ?? []) costs.set(row.project_id, (costs.get(row.project_id) ?? 0) + Number(row.cost_cents ?? 0))
  const vpos = new Map<string, number>()
  for (const row of vpoResult.data ?? []) vpos.set(row.project_id, (vpos.get(row.project_id) ?? 0) + Number(row.total_cents ?? 0))

  const lotRows: Array<ProductionLotPnlRow & { communityId: string }> = (lots ?? []).map((lot: any) => {
    const contract = contracts.get(lot.project_id)
    const closing: any = closings.get(lot.project_id)
    const settlementTotal = Number(closing?.settlement?.final_price_cents ?? 0)
    const revenueCents = settlementTotal || Number(contract?.total_cents ?? 0)
    const budgetCents = budgets.get(lot.project_id) ?? 0
    const actualCostCents = costs.get(lot.project_id) ?? 0
    const vpoCents = vpos.get(lot.project_id) ?? 0
    const projectedCost = Math.max(actualCostCents, budgetCents) + vpoCents
    const projectedMarginCents = revenueCents - projectedCost
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
      projectedMarginCents,
      projectedMarginPercent: revenueCents > 0 ? (projectedMarginCents / revenueCents) * 100 : 0,
    }
  })

  const communityRows = (communities ?? []).map((community) => {
    const scopedLots = lotRows.filter((row) => row.communityId === community.id)
    const revenueCents = sum(scopedLots.map((row) => ({ amount: row.revenueCents })))
    const budgetCents = sum(scopedLots.map((row) => ({ amount: row.budgetCents })))
    const actualCostCents = sum(scopedLots.map((row) => ({ amount: row.actualCostCents })))
    const vpoCents = sum(scopedLots.map((row) => ({ amount: row.vpoCents })))
    const projectedMarginCents = sum(scopedLots.map((row) => ({ amount: row.projectedMarginCents })))
    const closedRevenueCents = sum(scopedLots.filter((row) => row.status === "closed").map((row) => ({ amount: row.revenueCents })))
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
      projectedMarginCents,
      projectedMarginPercent: revenueCents > 0 ? (projectedMarginCents / revenueCents) * 100 : 0,
      targetMarginPercent: typeof (community.settings as any)?.target_margin_percent === "number"
        ? Number((community.settings as any).target_margin_percent)
        : typeof (community.settings as any)?.margin_target_percent === "number"
          ? Number((community.settings as any).margin_target_percent)
          : null,
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
    existing.costCents += Math.max(row.actualCostCents, row.budgetCents) + row.vpoCents
    existing.marginCents = existing.revenueCents - existing.costCents
    existing.marginPercent = existing.revenueCents > 0 ? (existing.marginCents / existing.revenueCents) * 100 : 0
    planMap.set(row.planId, existing)
  }

  const totalDirectCost = sum(lotRows.map((row) => ({ amount: Math.max(row.actualCostCents, row.budgetCents) })))
  const varianceMap = new Map<string, ProductionPortfolioReport["variance"][number]>()
  for (const row of vpoResult.data ?? []) {
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
  const marginCents = revenueCents - Math.max(actualCostCents, budgetCents) - vpoCents
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
      marginCents,
      marginPercent: revenueCents > 0 ? (marginCents / revenueCents) * 100 : 0,
    },
  }
}

export async function getCommunityPnl(communityId: string, orgId?: string) {
  const report = await getProductionPortfolioReport({ communityId }, orgId)
  return report.communities[0] ?? null
}

export type LandPortfolioRow = {
  communityId: string
  communityName: string
  availableLots: number
  startsTrailing90: number
  monthsOfSupply: number | null
  plannedStarts90: number
  deliveryCoverageLots: number
  upcomingLots: number
  upcomingCashCents: number
  depositsAtRiskCents: number
  nextTakedownDate: string | null
}

export async function getLandPortfolio(divisionId?: string, orgId?: string): Promise<LandPortfolioRow[]> {
  const context = await requireOrgContext(orgId)
  await requirePermission("community.read", context)
  const divisionAccess = await getDivisionAccessForUser({
    orgId: context.orgId,
    userId: context.userId,
  })
  if (divisionId && divisionAccess.assignedOnly && !divisionAccess.divisionIds.includes(divisionId)) {
    return []
  }
  let communitiesQuery = context.supabase.from("communities").select("id,name,division_id").eq("org_id", context.orgId).is("archived_at", null).limit(250)
  if (divisionId) communitiesQuery = communitiesQuery.eq("division_id", divisionId)
  else if (divisionAccess.assignedOnly) {
    if (divisionAccess.divisionIds.length === 0) return []
    communitiesQuery = communitiesQuery.in("division_id", divisionAccess.divisionIds)
  }
  const { data: communities, error } = await communitiesQuery
  if (error) throw new Error(`Failed to load communities: ${error.message}`)
  const ids = (communities ?? []).map((row) => row.id as string)
  if (!ids.length) return []
  const today = new Date()
  const in90 = new Date(today)
  in90.setDate(in90.getDate() + 90)
  const trailing90 = new Date(today)
  trailing90.setDate(trailing90.getDate() - 90)
  const [lotsResult, startsResult, slotsResult, takedownsResult] = await Promise.all([
    context.supabase.from("lots").select("community_id,status").eq("org_id", context.orgId).in("community_id", ids).limit(5_000),
    context.supabase.from("start_packages").select("community_id,actual_start_date").eq("org_id", context.orgId).in("community_id", ids).eq("status", "released").gte("actual_start_date", trailing90.toISOString().slice(0, 10)).limit(2_000),
    context.supabase.from("community_release_slots").select("community_id,target_starts,week_start").eq("org_id", context.orgId).in("community_id", ids).gte("week_start", today.toISOString().slice(0, 10)).lte("week_start", in90.toISOString().slice(0, 10)).limit(5_000),
    context.supabase.from("lot_takedowns").select("community_id,scheduled_date,lot_count,price_per_lot_cents,deposit_cents,status").eq("org_id", context.orgId).in("community_id", ids).gte("scheduled_date", today.toISOString().slice(0, 10)).lte("scheduled_date", in90.toISOString().slice(0, 10)).neq("status", "closed").order("scheduled_date").limit(2_000),
  ])
  for (const result of [lotsResult, startsResult, slotsResult, takedownsResult]) {
    if (result.error) throw new Error(`Failed to load Land portfolio: ${result.error.message}`)
  }
  const lots = lotsResult.data ?? []
  const starts = startsResult.data ?? []
  const slots = slotsResult.data ?? []
  const takedowns = takedownsResult.data ?? []
  return (communities ?? []).map((community) => {
    const availableLots = (lots ?? []).filter((row) => row.community_id === community.id && ["owned", "developed", "assigned"].includes(row.status)).length
    const startsTrailing90 = (starts ?? []).filter((row) => row.community_id === community.id).length
    const plannedStarts90 = (slots ?? []).filter((row) => row.community_id === community.id).reduce((total, row) => total + Number(row.target_starts ?? 0), 0)
    const due = (takedowns ?? []).filter((row) => row.community_id === community.id)
    const upcomingLots = due.reduce((total, row) => total + Number(row.lot_count ?? 0), 0)
    return {
      communityId: community.id,
      communityName: community.name,
      availableLots,
      startsTrailing90,
      monthsOfSupply: startsTrailing90 > 0 ? availableLots / (startsTrailing90 / 3) : null,
      plannedStarts90,
      deliveryCoverageLots: availableLots + upcomingLots - plannedStarts90,
      upcomingLots,
      upcomingCashCents: due.reduce((total, row) => total + Number(row.lot_count ?? 0) * Number(row.price_per_lot_cents ?? 0), 0),
      depositsAtRiskCents: due.reduce((total, row) => total + Number(row.deposit_cents ?? 0), 0),
      nextTakedownDate: due[0]?.scheduled_date ?? null,
    }
  })
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
    projectedMarginCents: 0,
    projectedMarginPercent: 0,
    targetMarginPercent: null,
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
