import type { SupabaseClient } from "@supabase/supabase-js"

import type { Project, ProjectFinancialSettings } from "@/lib/types"
import { requireAuthorization } from "@/lib/services/authorization"
import { getBudgetWithActuals } from "@/lib/services/budgets"
import { requireOrgContext } from "@/lib/services/context"
import { listProjects } from "@/lib/services/projects"
import { getReportingExcludedProjectIds } from "@/lib/services/reporting-scope"
import { todayIsoDateOnly } from "@/lib/services/reports/dates"
import { computeProjectPoc, orderPocSnapshotsLatestFirst } from "@/lib/services/poc"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import type { ProjectPocWarning } from "@/lib/financials/poc-rules"
import { BILLED_INVOICE_STATUSES } from "@/lib/financials/ledger-status"
import {
  resolveEacCents,
  resolveOriginalContractCents,
  resolveRevisedContractCents,
} from "@/lib/financials/poc-inputs"

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
  /**
   * Where the numbers came from. `live` is computed now; `snapshot` is read back
   * from `poc_snapshots`. `asOf` used to be accepted and silently ignored, so a
   * historical WIP report showed today's position under yesterday's date — a
   * decorative parameter on a financial statement is worse than no parameter.
   */
  basis: "live" | "snapshot"
  /** Projects with no snapshot at or before `as_of`, so the report can say so. */
  projects_without_snapshot: string[]
  rows: WipOverUnderRow[]
  totals: WipOverUnderTotals
}

type PocSnapshotRow = {
  project_id: string
  as_of: string
  original_contract_cents: number | null
  approved_change_orders_cents: number | null
  revised_contract_cents: number | null
  cost_to_date_cents: number | null
  eac_cents: number | null
  percent_complete: number | null
  earned_revenue_cents: number | null
  billed_cents: number | null
  over_under_cents: number | null
  forecast_gross_profit_cents: number | null
  warnings: unknown
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
      .in("status", [...BILLED_INVOICE_STATUSES]),
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
  // Load failures are the report's own concern; every *input* judgement belongs
  // to the shared rules, and `computeProjectPoc` owns the rest of the warnings —
  // `missing_contract_value` used to be raised here as well as there.
  const loadIssues: string[] = []
  const extraWarnings: ProjectPocWarning[] = []
  const approvedChangeOrdersCents = rollups.approvedChangeOrdersByProject.get(project.id) ?? 0
  const revisedContractCents = resolveRevisedContractCents({
    billingContract: project.billing_contract ?? null,
    totalContractValueCents: project.total_contract_value_cents ?? null,
  })
  const originalContractCents = resolveOriginalContractCents({
    billingContract: project.billing_contract ?? null,
    revisedContractCents,
    approvedChangeOrdersCents,
  })

  const budgetData = await getBudgetWithActuals(project.id, orgId).catch((error) => {
    loadIssues.push(error instanceof Error ? error.message : "budget_unavailable")
    return null
  })
  if (!budgetData?.budget) extraWarnings.push("missing_budget")

  const summary = budgetData?.summary
  const actualCostCents = numberValue(summary?.total_actual_cents)
  const eacCents = resolveEacCents({
    summaryEacCents: numberValue(summary?.total_eac_cents),
    adjustedBudgetCents: numberValue(summary?.adjusted_budget_cents),
    actualCostCents,
  })
  const billedToDateCents = rollups.billedByProject.get(project.id) ?? 0
  const poc = computeProjectPoc(
    {
      originalContractCents,
      approvedChangeOrdersCents,
      revisedContractCents,
      actualCostCents,
      eacCents,
      billedCents: billedToDateCents,
    },
    { extraWarnings },
  )
  const issues = [...loadIssues, ...poc.warnings]

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
    cost_to_complete_cents: poc.costToCompleteCents,
    percent_complete: Math.round(poc.completionRatio * 1000) / 10,
    earned_revenue_cents: poc.earnedRevenueCents,
    billed_to_date_cents: billedToDateCents,
    over_under_billing_cents: poc.overUnderCents,
    over_billed_cents: Math.max(0, poc.overUnderCents),
    under_billed_cents: Math.max(0, -poc.overUnderCents),
    forecast_gross_profit_cents: poc.forecastGrossProfitCents,
    forecast_gross_margin_percent: poc.forecastGrossMarginPercent,
    balance_status:
      poc.overUnderCents > 0
        ? "over_billed"
        : poc.overUnderCents < 0
          ? "under_billed"
          : "in_balance",
    issues: Array.from(new Set(issues)),
  }
}

/**
 * The latest POC snapshot at or before a date, per project.
 *
 * Read through the service client on purpose. `poc_snapshots` RLS grants reads
 * to `books.read`, which would make snapshot-backed WIP unavailable to any org
 * that never turned Arc Books on — and standalone WIP is exactly B3's market.
 * The caller has already proven `budget.read` + `invoice.read`, which is the
 * right permission for this report; the snapshot table is an implementation
 * detail of it.
 */
async function loadSnapshotsAsOf({
  orgId,
  projectIds,
  asOf,
}: {
  orgId: string
  projectIds: string[]
  asOf: string
}): Promise<Map<string, PocSnapshotRow>> {
  if (projectIds.length === 0) return new Map()
  const service = createServiceSupabaseClient()
  const latest = new Map<string, PocSnapshotRow>()
  const pageSize = 1000
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await orderPocSnapshotsLatestFirst(
      service
        .from("poc_snapshots")
        .select(
          "project_id, as_of, original_contract_cents, approved_change_orders_cents, revised_contract_cents, cost_to_date_cents, eac_cents, percent_complete, earned_revenue_cents, billed_cents, over_under_cents, forecast_gross_profit_cents, warnings",
        )
        .eq("org_id", orgId)
        .in("project_id", projectIds)
        .lte("as_of", asOf),
    ).range(from, from + pageSize - 1)
    if (error) throw new Error(`Failed to load POC snapshots: ${error.message}`)
    const rows = data ?? []
    for (const row of rows) {
      // Ordered newest-first, so the first row seen for a project wins.
      const projectId = row.project_id as string
      if (!latest.has(projectId)) latest.set(projectId, row as PocSnapshotRow)
    }
    if (rows.length < pageSize) break
  }
  return latest
}

function snapshotRow(project: Project, snapshot: PocSnapshotRow): WipOverUnderRow {
  const revisedContractCents = numberValue(snapshot.revised_contract_cents)
  const eacCents = numberValue(snapshot.eac_cents)
  const actualCostCents = numberValue(snapshot.cost_to_date_cents)
  const forecastGrossProfitCents = numberValue(snapshot.forecast_gross_profit_cents)
  const overUnderCents = numberValue(snapshot.over_under_cents)
  return {
    project_id: project.id,
    project_name: project.name,
    project_status: project.status ?? null,
    billing_model: resolveBillingModel(project),
    original_contract_cents: numberValue(snapshot.original_contract_cents),
    approved_change_orders_cents: numberValue(snapshot.approved_change_orders_cents),
    revised_contract_cents: revisedContractCents,
    actual_cost_cents: actualCostCents,
    eac_cents: eacCents,
    cost_to_complete_cents: Math.max(0, eacCents - actualCostCents),
    // The column stores a 0-1 ratio despite its name; the report displays a percent.
    percent_complete: Math.round(numberValue(snapshot.percent_complete) * 1000) / 10,
    earned_revenue_cents: numberValue(snapshot.earned_revenue_cents),
    billed_to_date_cents: numberValue(snapshot.billed_cents),
    over_under_billing_cents: overUnderCents,
    over_billed_cents: Math.max(0, overUnderCents),
    under_billed_cents: Math.max(0, -overUnderCents),
    forecast_gross_profit_cents: forecastGrossProfitCents,
    forecast_gross_margin_percent: marginPercent(forecastGrossProfitCents, revisedContractCents),
    balance_status: overUnderCents > 0 ? "over_billed" : overUnderCents < 0 ? "under_billed" : "in_balance",
    issues: Array.isArray(snapshot.warnings) ? snapshot.warnings.map(String) : [],
  }
}

/**
 * Build the report for a set of projects, from snapshots when the caller asked
 * for a past date and from live data otherwise. A past date with no snapshot
 * cannot be answered by computing now — that would report today's position under
 * a historical heading — so those projects are named in
 * `projects_without_snapshot` and left out.
 */
async function buildReportRows({
  projects,
  orgId,
  supabase,
  asOf,
  historical,
}: {
  projects: Project[]
  orgId: string
  supabase: SupabaseClient
  asOf: string
  historical: boolean
}): Promise<{ rows: WipOverUnderRow[]; missing: string[] }> {
  if (historical) {
    const snapshots = await loadSnapshotsAsOf({
      orgId,
      projectIds: projects.map((project) => project.id),
      asOf,
    })
    const rows: WipOverUnderRow[] = []
    const missing: string[] = []
    for (const project of projects) {
      const snapshot = snapshots.get(project.id)
      if (!snapshot) missing.push(project.id)
      else rows.push(snapshotRow(project, snapshot))
    }
    return { rows, missing }
  }

  const rollups = await loadRollups({
    supabase,
    orgId,
    projectIds: projects.map((project) => project.id),
  })
  const rows: WipOverUnderRow[] = []
  for (const project of projects) {
    rows.push(await buildWipRow({ project, orgId, rollups }))
  }
  return { rows, missing: [] }
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

  const today = todayIsoDateOnly()
  const effectiveAsOf = asOf ?? today
  const historical = effectiveAsOf < today
  const { rows, missing } = await buildReportRows({
    projects,
    orgId: resolvedOrgId,
    supabase,
    asOf: effectiveAsOf,
    historical,
  })

  return {
    as_of: effectiveAsOf,
    scope: "org",
    basis: historical ? "snapshot" : "live",
    projects_without_snapshot: missing,
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

  const today = todayIsoDateOnly()
  const effectiveAsOf = asOf ?? today
  const historical = effectiveAsOf < today
  const { rows, missing } = await buildReportRows({
    projects: [project],
    orgId: resolvedOrgId,
    supabase,
    asOf: effectiveAsOf,
    historical,
  })

  return {
    as_of: effectiveAsOf,
    scope: "project",
    project_id: projectId,
    basis: historical ? "snapshot" : "live",
    projects_without_snapshot: missing,
    rows,
    totals: computeTotals(rows),
  }
}
