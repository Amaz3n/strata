import { utcReportDateRange } from "@/lib/reports/date-range"
import { readAllRows, type RangeResult } from "@/lib/land/paging"
import { resolveDivisionScope } from "@/lib/land/scope"
import { getDivisionAccessForUser, requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { toCsv } from "@/lib/services/reports/csv"

export type VarianceDimension = "reason" | "community" | "plan" | "division" | "vendor" | "superintendent" | "month"

export type VarianceAnalysisRow = {
  dimension: VarianceDimension
  dimension_id: string
  dimension_label: string
  net_variance_cents: number
  absolute_variance_cents: number
  incidence: number
  direct_cost_budget_cents: number
  variance_rate: number
}

export type VarianceAnalysisResult = {
  rows: VarianceAnalysisRow[]
  summary: {
    totalAbsoluteCents: number
    totalNetCents: number
    incidence: number
    directCostBudgetCents: number
    varianceRate: number
    benchmarkLow: number
    benchmarkHigh: number
  }
  /** True when a division or membership scope narrowed the report. */
  scoped: boolean
}

/** One approved variance order with everything the seven dimensions need. */
export type VarianceFact = {
  project_id: string
  total_cents: number
  approved_at: string
  reason_code_id: string | null
  reason_label: string | null
  community_id: string | null
  community_name: string | null
  house_plan_id: string | null
  plan_name: string | null
  division_id: string | null
  division_name: string | null
  company_id: string | null
  company_name: string | null
  superintendent_id: string | null
  superintendent_name: string | null
}

const BENCHMARK_LOW = 0.01
const BENCHMARK_HIGH = 0.02
/** Matches the RPC: only approved orders carrying a variance reason count. */
const COUNTED_STATUSES = ["approved"]
const FACT_PAGE_SIZE = 1000

export async function getVarianceAnalysis({
  startDate,
  endDate,
  divisionId,
  orgId,
}: { startDate: string; endDate: string; divisionId?: string; orgId?: string }): Promise<VarianceAnalysisResult> {
  utcReportDateRange(startDate, endDate)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({ permission: "price_book.read", userId, orgId: resolvedOrgId, supabase, logDecision: true })
  const scope = resolveDivisionScope(await getDivisionAccessForUser({ orgId: resolvedOrgId, userId }), divisionId)
  if (scope.kind === "none") return { ...emptyVariance(), scoped: true }
  if (scope.kind === "limited") {
    // The report's division is the lot's, falling back to the project's (coalesce in the RPC). A home
    // on a lot in the division counts even when the project row carries no division of its own.
    const [projects, lots] = await Promise.all([
      readAllRows<{ id: string }>((from, to) => supabase.from("projects").select("id")
        .eq("org_id", resolvedOrgId).in("division_id", scope.divisionIds)
        .order("id").range(from, to),
      { cap: 100001, pageSize: FACT_PAGE_SIZE, label: "Failed to scope variance analysis" }),
      readAllRows<{ id: string; project_id: string }>((from, to) => supabase.from("lots").select("id,project_id")
        .eq("org_id", resolvedOrgId).in("division_id", scope.divisionIds).not("project_id", "is", null)
        .order("id").range(from, to),
      { cap: 100001, pageSize: FACT_PAGE_SIZE, label: "Failed to scope variance analysis" }),
    ])
    if (projects.truncated || lots.truncated) throw new Error("Variance analysis exceeds the supported project scope; narrow the division filter")
    const projectIds = [...new Set([...projects.rows.map((row) => row.id), ...lots.rows.map((row) => row.project_id)])]
    return getScopedVarianceAnalysis({ supabase: createServiceSupabaseClient(), orgId: resolvedOrgId, projectIds, divisionIds: scope.divisionIds, startDate, endDate })
  }
  const aggregate = await readAllRows<Record<string, unknown>>((from, to) => supabase.rpc("get_variance_analysis", {
    p_org_id: resolvedOrgId, p_start_date: startDate, p_end_date: endDate,
  }).order("dimension").order("dimension_id").order("dimension_label").range(from, to),
  { cap: 100001, pageSize: FACT_PAGE_SIZE, label: "Failed to load variance analysis" })
  if (aggregate.truncated) throw new Error("Variance analysis exceeds the supported group count; narrow the report scope")
  const rows: VarianceAnalysisRow[] = aggregate.rows.map((row: Record<string, unknown>) => ({
    dimension: row.dimension as VarianceDimension,
    dimension_id: String(row.dimension_id ?? ""),
    dimension_label: String(row.dimension_label ?? "Unassigned"),
    net_variance_cents: Number(row.net_variance_cents ?? 0),
    absolute_variance_cents: Number(row.absolute_variance_cents ?? 0),
    incidence: Number(row.incidence ?? 0),
    direct_cost_budget_cents: Number(row.direct_cost_budget_cents ?? 0),
    variance_rate: Number(row.variance_rate ?? 0),
  }))
  return { ...summarize(rows), scoped: false }
}

/**
 * The division-scoped report, aggregated in TypeScript because the RPC takes
 * no project filter.
 *
 * `supabase` is the service client, because the caller already passed the report's
 * authorization and division resolution and `projectIds` is exactly what that decided.
 * Reading the project rows as the member would hide a home whose project carries no
 * division (RLS division backstop) even though its lot puts it in the member's division,
 * and the consistency check below would then fail the whole report.
 *
 * It must produce the same numbers the RPC does or a purchasing manager with
 * one division sees a different report from the org admin looking at the same
 * homes: the same seven dimensions, keyed off `approved_at` (not creation),
 * counting only approved orders, and reading every matching row rather than
 * the first page.
 */
async function getScopedVarianceAnalysis({
  supabase,
  orgId,
  projectIds,
  divisionIds,
  startDate,
  endDate,
}: {
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"]
  orgId: string
  projectIds: string[]
  divisionIds: string[]
  startDate: string
  endDate: string
}): Promise<VarianceAnalysisResult> {
  if (!projectIds.length) return { ...emptyVariance(), scoped: true }

  const [allFacts, budgetByProject] = await Promise.all([
    loadVarianceFacts({ supabase, orgId, projectIds, startDate, endDate }),
    loadLatestBudgets({ supabase, orgId, projectIds }),
  ])
  // A project row in scope can sit on a lot that belongs to another division; the fact's division wins.
  const facts = allFacts.filter((fact) => fact.division_id !== null && divisionIds.includes(fact.division_id))
  return { ...summarize(aggregateVarianceFacts(facts, budgetByProject)), scoped: true }
}

/** Every reference batch stays below URL and REST row limits. */
async function readReferenceRows<T>(ids: string[], label: string,
  query: (ids: string[], from: number, to: number) => PromiseLike<RangeResult<T>>): Promise<T[]> {
  const rows: T[] = []
  const unique = [...new Set(ids)]
  for (let offset = 0; offset < unique.length; offset += 100) {
    const result = await readAllRows<T>((from, to) => query(unique.slice(offset, offset + 100), from, to),
      { cap: 100001, pageSize: FACT_PAGE_SIZE, label })
    if (result.truncated) throw new Error(`${label}: scope exceeds the supported report size`)
    rows.push(...result.rows)
  }
  return rows
}

async function loadVarianceFacts({
  supabase,
  orgId,
  projectIds,
  startDate,
  endDate,
}: {
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"]
  orgId: string
  projectIds: string[]
  startDate: string
  endDate: string
}): Promise<VarianceFact[]> {
  const range = utcReportDateRange(startDate, endDate)
  const orders = await readReferenceRows<Record<string, unknown>>(projectIds, "Failed to load scoped variance analysis", (ids, from, to) => supabase
    .from("commitment_change_orders")
    .select("id,project_id,total_cents,approved_at,reason_code_id,company_id,reason:variance_reason_codes(label),company:companies(name)")
    .eq("org_id", orgId).in("project_id", ids).not("reason_code_id", "is", null).in("status", COUNTED_STATUSES)
    .gte("approved_at", range.startInclusive).lt("approved_at", range.endExclusive)
    .order("id").range(from, to))
  if (orders.length === 0) return []

  const orderProjectIds = Array.from(new Set(orders.map((row) => String(row.project_id))))
  const [lots, projects, superintendentByProject] = await Promise.all([
    readReferenceRows<Record<string, unknown>>(orderProjectIds, "Failed to load variance lots", (ids, from, to) => supabase
      .from("lots").select("id,project_id,community_id,house_plan_id,division_id,community:communities(name),house_plan:house_plans(name)")
      .eq("org_id", orgId).in("project_id", ids).order("id").range(from, to)),
    readReferenceRows<Record<string, unknown>>(orderProjectIds, "Failed to load variance projects", (ids, from, to) => supabase
      .from("projects").select("id,division_id,division:divisions(name)")
      .eq("org_id", orgId).in("id", ids).order("id").range(from, to)),
    loadSuperintendents({ supabase, orgId, projectIds: orderProjectIds }),
  ])
  const lotByProject = new Map(lots.map((row) => [String(row.project_id), row]))
  const projectById = new Map(projects.map((row) => [String(row.id), row]))
  if (projectById.size !== orderProjectIds.length) throw new Error("Variance history references missing projects")

  return orders.map((row): VarianceFact => {
    const projectId = String(row.project_id)
    const lot = lotByProject.get(projectId)
    const project = projectById.get(projectId)
    const divisionId = (lot?.division_id as string | null) ?? (project?.division_id as string | null) ?? null
    const superintendent = superintendentByProject.get(projectId) ?? null
    return {
      project_id: projectId,
      total_cents: Number(row.total_cents ?? 0),
      approved_at: String(row.approved_at ?? ""),
      reason_code_id: (row.reason_code_id as string | null) ?? null,
      reason_label: relationField(row.reason, "label"),
      community_id: (lot?.community_id as string | null) ?? null,
      community_name: relationField(lot?.community, "name"),
      house_plan_id: (lot?.house_plan_id as string | null) ?? null,
      plan_name: relationField(lot?.house_plan, "name"),
      division_id: divisionId,
      division_name: relationField(project?.division, "name"),
      company_id: (row.company_id as string | null) ?? null,
      company_name: relationField(row.company, "name"),
      superintendent_id: superintendent?.userId ?? null,
      superintendent_name: superintendent?.label ?? null,
    }
  })
}

async function loadSuperintendents({
  supabase,
  orgId,
  projectIds,
}: {
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"]
  orgId: string
  projectIds: string[]
}): Promise<Map<string, { userId: string; label: string }>> {
  const byProject = new Map<string, { userId: string; label: string }>()
  // roles is a catalog the member client cannot read; the lookup carries no org data.
  const { data: roles, error: roleError } = await createServiceSupabaseClient().from("roles").select("id").eq("key", "field")
  if (roleError) throw new Error(`Failed to load the superintendent role: ${roleError.message}`)
  const roleIds = (roles ?? []).map((row) => row.id as string)
  if (roleIds.length === 0) return byProject

  const members = await readReferenceRows<Record<string, unknown>>(projectIds, "Failed to load variance superintendents", (ids, from, to) => supabase
    .from("project_members").select("id,project_id,user_id,created_at,user:app_users(full_name,email)")
    .eq("org_id", orgId).eq("status", "active").in("project_id", ids).in("role_id", roleIds)
    .order("created_at", { ascending: true }).order("id").range(from, to))
  for (const row of members) {
    const projectId = String(row.project_id)
    if (byProject.has(projectId)) continue
    byProject.set(projectId, {
      userId: String(row.user_id),
      label: relationField(row.user, "full_name") ?? relationField(row.user, "email") ?? "Unassigned",
    })
  }
  return byProject
}

async function loadLatestBudgets({
  supabase,
  orgId,
  projectIds,
}: {
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"]
  orgId: string
  projectIds: string[]
}): Promise<Map<string, number>> {
  const latest = new Map<string, number>()
  const budgets = await readReferenceRows<{ project_id: string; total_cents: number; version: number }>(projectIds, "Failed to load variance budgets", (ids, from, to) => supabase
    .from("budgets").select("id,project_id,total_cents,version").eq("org_id", orgId).in("project_id", ids)
    .order("project_id", { ascending: true }).order("version", { ascending: false }).order("id").range(from, to))
  for (const row of budgets) {
    if (!latest.has(row.project_id)) latest.set(row.project_id, Number(row.total_cents ?? 0))
  }
  return latest
}

function relationField(value: unknown, field: string): string | null {
  const relation = Array.isArray(value) ? value[0] : value
  if (!relation || typeof relation !== "object") return null
  const raw = (relation as Record<string, unknown>)[field]
  return typeof raw === "string" && raw.length > 0 ? raw : null
}

function monthKey(approvedAt: string): { id: string; label: string } {
  const parsed = new Date(approvedAt)
  if (Number.isNaN(parsed.getTime())) return { id: "", label: "Unassigned" }
  const month = parsed.toLocaleString("en-US", { month: "short", timeZone: "UTC" })
  return {
    id: `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, "0")}`,
    label: `${month} ${parsed.getUTCFullYear()}`,
  }
}

/**
 * The RPC's `expanded` CTE, in TypeScript: every fact is counted once per
 * dimension, and each dimension's budget denominator is the sum of the latest
 * budget of every project that contributed to it.
 */
export function aggregateVarianceFacts(
  facts: readonly VarianceFact[],
  budgetByProject: ReadonlyMap<string, number>,
): VarianceAnalysisRow[] {
  const groups = new Map<string, VarianceAnalysisRow>()
  const projectsByGroup = new Map<string, Set<string>>()

  for (const fact of facts) {
    const month = monthKey(fact.approved_at)
    const keys: Array<{ dimension: VarianceDimension; id: string | null; label: string }> = [
      { dimension: "reason", id: fact.reason_code_id, label: fact.reason_label ?? "Unclassified" },
      { dimension: "community", id: fact.community_id, label: fact.community_name ?? "No community" },
      { dimension: "plan", id: fact.house_plan_id, label: fact.plan_name ?? "No plan" },
      { dimension: "division", id: fact.division_id, label: fact.division_name ?? "Main" },
      { dimension: "vendor", id: fact.company_id, label: fact.company_name ?? "No vendor" },
      { dimension: "superintendent", id: fact.superintendent_id, label: fact.superintendent_name ?? "Unassigned" },
      { dimension: "month", id: month.id, label: month.label },
    ]
    const amount = Number(fact.total_cents ?? 0)
    for (const key of keys) {
      const dimensionId = key.id ?? ""
      const groupKey = `${key.dimension}:${dimensionId}:${key.label}`
      const current = groups.get(groupKey) ?? {
        dimension: key.dimension,
        dimension_id: dimensionId,
        dimension_label: key.label,
        net_variance_cents: 0,
        absolute_variance_cents: 0,
        incidence: 0,
        direct_cost_budget_cents: 0,
        variance_rate: 0,
      }
      current.net_variance_cents += amount
      current.absolute_variance_cents += Math.abs(amount)
      current.incidence += 1
      groups.set(groupKey, current)
      const projects = projectsByGroup.get(groupKey) ?? new Set<string>()
      projects.add(fact.project_id)
      projectsByGroup.set(groupKey, projects)
    }
  }

  return Array.from(groups.entries())
    .map(([groupKey, row]) => {
      const budget = Array.from(projectsByGroup.get(groupKey) ?? [])
        .reduce((total, projectId) => total + (budgetByProject.get(projectId) ?? 0), 0)
      return {
        ...row,
        direct_cost_budget_cents: budget,
        variance_rate: budget > 0 ? row.absolute_variance_cents / budget : 0,
      }
    })
    .sort((a, b) =>
      a.dimension.localeCompare(b.dimension) ||
      b.absolute_variance_cents - a.absolute_variance_cents ||
      a.dimension_label.localeCompare(b.dimension_label),
    )
}

function summarize(rows: VarianceAnalysisRow[]) {
  const reasonRows = rows.filter((row) => row.dimension === "reason")
  const totalAbsoluteCents = reasonRows.reduce((sum, row) => sum + row.absolute_variance_cents, 0)
  const totalNetCents = reasonRows.reduce((sum, row) => sum + row.net_variance_cents, 0)
  // A home can contribute to several reasons; summing reason denominators
  // counts its budget repeatedly. Each home belongs to one division group.
  const directCostBudgetCents = rows.filter((row) => row.dimension === "division").reduce((sum, row) => sum + row.direct_cost_budget_cents, 0)
  return {
    rows,
    summary: {
      totalAbsoluteCents,
      totalNetCents,
      incidence: reasonRows.reduce((sum, row) => sum + row.incidence, 0),
      directCostBudgetCents,
      varianceRate: directCostBudgetCents > 0 ? totalAbsoluteCents / directCostBudgetCents : 0,
      benchmarkLow: BENCHMARK_LOW,
      benchmarkHigh: BENCHMARK_HIGH,
    },
  }
}

function emptyVariance() {
  return summarize([])
}

export function varianceAnalysisCsv(rows: VarianceAnalysisRow[]) {
  return toCsv(rows, [
    { key: "dimension", header: "Dimension" },
    { key: "dimension_label", header: "Group" },
    { key: "net_variance_cents", header: "Net variance", format: (value) => (Number(value) / 100).toFixed(2) },
    { key: "absolute_variance_cents", header: "Absolute variance", format: (value) => (Number(value) / 100).toFixed(2) },
    { key: "incidence", header: "Incidence" },
    { key: "direct_cost_budget_cents", header: "Direct-cost budget", format: (value) => (Number(value) / 100).toFixed(2) },
    { key: "variance_rate", header: "Variance rate", format: (value) => (Number(value) * 100).toFixed(2) + "%" },
  ])
}
