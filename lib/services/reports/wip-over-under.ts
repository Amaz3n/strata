import type { SupabaseClient } from "@supabase/supabase-js"

import type { Project, ProjectFinancialSettings } from "@/lib/types"
import { requireAuthorization } from "@/lib/services/authorization"
import { getBudgetWithActuals } from "@/lib/services/budgets"
import { requireOrgContext } from "@/lib/services/context"
import { listProjects } from "@/lib/services/projects"
import { getReportingExcludedProjectIds } from "@/lib/services/reporting-scope"
import { todayIsoDateOnly } from "@/lib/services/reports/dates"

const BILLED_INVOICE_STATUSES = ["sent", "partial", "paid", "overdue"]
const INCLUDED_PROJECT_STATUSES = new Set(["planning", "active", "on_hold", "completed"])

export type WipBillingModel =
  | "fixed_price"
  | "cost_plus_percent"
  | "cost_plus_fixed_fee"
  | "cost_plus_gmp"
  | "time_and_materials"
  | "unknown"

export type WipBalanceStatus = "over_billed" | "under_billed" | "in_balance"

export type WipOverUnderRow = {
  project_id: string
  project_name: string
  project_status: string | null
  billing_model: WipBillingModel
  original_contract_cents: number
  approved_change_orders_cents: number
  revised_contract_cents: number
  actual_cost_cents: number
  eac_cents: number
  cost_to_complete_cents: number
  percent_complete: number
  earned_revenue_cents: number
  billed_to_date_cents: number
  over_under_billing_cents: number
  over_billed_cents: number
  under_billed_cents: number
  forecast_gross_profit_cents: number
  forecast_gross_margin_percent: number | null
  balance_status: WipBalanceStatus
  issues: string[]
}

export type WipOverUnderTotals = {
  project_count: number
  original_contract_cents: number
  approved_change_orders_cents: number
  revised_contract_cents: number
  actual_cost_cents: number
  eac_cents: number
  cost_to_complete_cents: number
  percent_complete: number
  earned_revenue_cents: number
  billed_to_date_cents: number
  net_over_under_billing_cents: number
  over_billed_cents: number
  under_billed_cents: number
  forecast_gross_profit_cents: number
  forecast_gross_margin_percent: number | null
}

export type WipOverUnderReport = {
  as_of: string
  scope: "org" | "project"
  project_id?: string
  rows: WipOverUnderRow[]
  totals: WipOverUnderTotals
}

type Rollups = {
  approvedChangeOrdersByProject: Map<string, number>
  billedByProject: Map<string, number>
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function percent(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0
  return Math.round((numerator / denominator) * 1000) / 10
}

function marginPercent(profitCents: number, revenueCents: number): number | null {
  if (revenueCents <= 0) return null
  return Math.round((profitCents / revenueCents) * 1000) / 10
}

function resolveBillingModel(project: Project): WipBillingModel {
  const settingsModel = (project.financial_settings as ProjectFinancialSettings | null | undefined)?.billing_model
  if (settingsModel) return settingsModel

  const snapshotModel = project.billing_contract?.snapshot?.billing_model
  if (
    snapshotModel === "fixed_price" ||
    snapshotModel === "cost_plus_percent" ||
    snapshotModel === "cost_plus_fixed_fee" ||
    snapshotModel === "cost_plus_gmp" ||
    snapshotModel === "time_and_materials"
  ) {
    return snapshotModel
  }

  return "unknown"
}

function resolveRevisedContractCents(project: Project): number {
  const contract = project.billing_contract
  const snapshot = (contract?.snapshot ?? {}) as Record<string, unknown>
  return (
    numberValue(snapshot.revised_total_cents) ||
    numberValue(contract?.total_cents) ||
    numberValue(project.total_contract_value_cents) ||
    0
  )
}

function resolveOriginalContractCents({
  project,
  revisedContractCents,
  approvedChangeOrdersCents,
}: {
  project: Project
  revisedContractCents: number
  approvedChangeOrdersCents: number
}) {
  const snapshot = (project.billing_contract?.snapshot ?? {}) as Record<string, unknown>
  const explicitOriginal =
    numberValue(snapshot.original_total_cents) ||
    numberValue(snapshot.base_contract_cents) ||
    numberValue(snapshot.contract_sum_cents)
  if (explicitOriginal > 0) return explicitOriginal

  const inferredOriginal = revisedContractCents - approvedChangeOrdersCents
  return inferredOriginal > 0 ? inferredOriginal : revisedContractCents
}

async function loadRollups({
  supabase,
  orgId,
  projectIds,
}: {
  supabase: SupabaseClient
  orgId: string
  projectIds: string[]
}): Promise<Rollups> {
  if (projectIds.length === 0) {
    return {
      approvedChangeOrdersByProject: new Map(),
      billedByProject: new Map(),
    }
  }

  const [changeOrdersResult, invoicesResult] = await Promise.all([
    supabase
      .from("change_orders")
      .select("project_id, total_cents, status")
      .eq("org_id", orgId)
      .in("project_id", projectIds),
    supabase
      .from("invoices")
      .select("project_id, total_cents, status")
      .eq("org_id", orgId)
      .in("project_id", projectIds)
      .in("status", BILLED_INVOICE_STATUSES),
  ])

  if (changeOrdersResult.error) {
    throw new Error(`Failed to load WIP change orders: ${changeOrdersResult.error.message}`)
  }
  if (invoicesResult.error) {
    throw new Error(`Failed to load WIP invoices: ${invoicesResult.error.message}`)
  }

  const approvedChangeOrdersByProject = new Map<string, number>()
  for (const row of changeOrdersResult.data ?? []) {
    if (String(row.status ?? "").toLowerCase() !== "approved") continue
    const projectId = row.project_id as string | null
    if (!projectId) continue
    approvedChangeOrdersByProject.set(
      projectId,
      (approvedChangeOrdersByProject.get(projectId) ?? 0) + Number(row.total_cents ?? 0),
    )
  }

  const billedByProject = new Map<string, number>()
  for (const row of invoicesResult.data ?? []) {
    const projectId = row.project_id as string | null
    if (!projectId) continue
    billedByProject.set(projectId, (billedByProject.get(projectId) ?? 0) + Number(row.total_cents ?? 0))
  }

  return { approvedChangeOrdersByProject, billedByProject }
}

async function buildWipRow({
  project,
  orgId,
  rollups,
}: {
  project: Project
  orgId: string
  rollups: Rollups
}): Promise<WipOverUnderRow> {
  const issues: string[] = []
  const approvedChangeOrdersCents = rollups.approvedChangeOrdersByProject.get(project.id) ?? 0
  const revisedContractCents = resolveRevisedContractCents(project)
  const originalContractCents = resolveOriginalContractCents({
    project,
    revisedContractCents,
    approvedChangeOrdersCents,
  })

  if (revisedContractCents <= 0) issues.push("missing_contract_value")

  const budgetData = await getBudgetWithActuals(project.id, orgId).catch((error) => {
    issues.push(error instanceof Error ? error.message : "budget_unavailable")
    return null
  })
  if (!budgetData?.budget) issues.push("missing_budget")

  const summary = budgetData?.summary
  const actualCostCents = numberValue(summary?.total_actual_cents)
  const summaryEacCents = numberValue(summary?.total_eac_cents)
  const adjustedBudgetCents = numberValue(summary?.adjusted_budget_cents)
  const eacCents = summaryEacCents || Math.max(adjustedBudgetCents, actualCostCents)
  const percentCompleteRatio = eacCents > 0 ? Math.min(1, Math.max(0, actualCostCents / eacCents)) : 0
  const earnedRevenueCents = Math.round(revisedContractCents * percentCompleteRatio)
  const billedToDateCents = rollups.billedByProject.get(project.id) ?? numberValue(summary?.total_invoiced_cents)
  const overUnderBillingCents = billedToDateCents - earnedRevenueCents
  const forecastGrossProfitCents = revisedContractCents - eacCents

  if (eacCents <= 0) issues.push("missing_eac")

  return {
    project_id: project.id,
    project_name: project.name,
    project_status: project.status ?? null,
    billing_model: resolveBillingModel(project),
    original_contract_cents: originalContractCents,
    approved_change_orders_cents: approvedChangeOrdersCents,
    revised_contract_cents: revisedContractCents,
    actual_cost_cents: actualCostCents,
    eac_cents: eacCents,
    cost_to_complete_cents: Math.max(0, eacCents - actualCostCents),
    percent_complete: Math.round(percentCompleteRatio * 1000) / 10,
    earned_revenue_cents: earnedRevenueCents,
    billed_to_date_cents: billedToDateCents,
    over_under_billing_cents: overUnderBillingCents,
    over_billed_cents: Math.max(0, overUnderBillingCents),
    under_billed_cents: Math.max(0, -overUnderBillingCents),
    forecast_gross_profit_cents: forecastGrossProfitCents,
    forecast_gross_margin_percent: marginPercent(forecastGrossProfitCents, revisedContractCents),
    balance_status:
      overUnderBillingCents > 0
        ? "over_billed"
        : overUnderBillingCents < 0
          ? "under_billed"
          : "in_balance",
    issues: Array.from(new Set(issues)),
  }
}

function computeTotals(rows: WipOverUnderRow[]): WipOverUnderTotals {
  const totals = rows.reduce(
    (acc, row) => {
      acc.original_contract_cents += row.original_contract_cents
      acc.approved_change_orders_cents += row.approved_change_orders_cents
      acc.revised_contract_cents += row.revised_contract_cents
      acc.actual_cost_cents += row.actual_cost_cents
      acc.eac_cents += row.eac_cents
      acc.cost_to_complete_cents += row.cost_to_complete_cents
      acc.earned_revenue_cents += row.earned_revenue_cents
      acc.billed_to_date_cents += row.billed_to_date_cents
      acc.net_over_under_billing_cents += row.over_under_billing_cents
      acc.over_billed_cents += row.over_billed_cents
      acc.under_billed_cents += row.under_billed_cents
      acc.forecast_gross_profit_cents += row.forecast_gross_profit_cents
      return acc
    },
    {
      project_count: rows.length,
      original_contract_cents: 0,
      approved_change_orders_cents: 0,
      revised_contract_cents: 0,
      actual_cost_cents: 0,
      eac_cents: 0,
      cost_to_complete_cents: 0,
      percent_complete: 0,
      earned_revenue_cents: 0,
      billed_to_date_cents: 0,
      net_over_under_billing_cents: 0,
      over_billed_cents: 0,
      under_billed_cents: 0,
      forecast_gross_profit_cents: 0,
      forecast_gross_margin_percent: null as number | null,
    },
  )

  totals.percent_complete = percent(totals.actual_cost_cents, totals.eac_cents)
  totals.forecast_gross_margin_percent = marginPercent(
    totals.forecast_gross_profit_cents,
    totals.revised_contract_cents,
  )
  return totals
}

export async function getOrgWipOverUnderReport({
  asOf,
  includeInactive = false,
  orgId,
}: {
  asOf?: string
  includeInactive?: boolean
  orgId?: string
} = {}): Promise<WipOverUnderReport> {
  const { supabase, orgId: resolvedOrgId, userId, productTier } = await requireOrgContext(orgId)

  await Promise.all([
    requireAuthorization({
      permission: "budget.read",
      userId,
      orgId: resolvedOrgId,
      supabase,
      resourceType: "report",
      resourceId: "wip-over-under",
    }),
    requireAuthorization({
      permission: "invoice.read",
      userId,
      orgId: resolvedOrgId,
      supabase,
      resourceType: "report",
      resourceId: "wip-over-under",
    }),
  ])

  const [allProjects, excludedProjectIds] = await Promise.all([
    listProjects(undefined, { supabase, orgId: resolvedOrgId, userId, productTier }),
    getReportingExcludedProjectIds(supabase, resolvedOrgId),
  ])
  const excludedProjects = new Set(excludedProjectIds)
  const projects = allProjects
    .filter((project) => includeInactive || INCLUDED_PROJECT_STATUSES.has(project.status))
    .filter((project) => !excludedProjects.has(project.id))
    .sort((a, b) => a.name.localeCompare(b.name))

  const rollups = await loadRollups({
    supabase,
    orgId: resolvedOrgId,
    projectIds: projects.map((project) => project.id),
  })

  const rows: WipOverUnderRow[] = []
  for (const project of projects) {
    rows.push(await buildWipRow({ project, orgId: resolvedOrgId, rollups }))
  }

  return {
    as_of: asOf ?? todayIsoDateOnly(),
    scope: "org",
    rows,
    totals: computeTotals(rows),
  }
}

export async function getProjectWipOverUnderReport({
  projectId,
  asOf,
  orgId,
}: {
  projectId: string
  asOf?: string
  orgId?: string
}): Promise<WipOverUnderReport> {
  const { supabase, orgId: resolvedOrgId, userId, productTier } = await requireOrgContext(orgId)

  await requireAuthorization({
    permission: "invoice.read",
    userId,
    orgId: resolvedOrgId,
    projectId,
    supabase,
    resourceType: "project",
    resourceId: projectId,
  })

  const projects = await listProjects(undefined, { supabase, orgId: resolvedOrgId, userId, productTier })
  const project = projects.find((row) => row.id === projectId)
  if (!project) throw new Error("Project not found")

  const rollups = await loadRollups({ supabase, orgId: resolvedOrgId, projectIds: [projectId] })
  const row = await buildWipRow({ project, orgId: resolvedOrgId, rollups })
  const rows = [row]

  return {
    as_of: asOf ?? todayIsoDateOnly(),
    scope: "project",
    project_id: projectId,
    rows,
    totals: computeTotals(rows),
  }
}
