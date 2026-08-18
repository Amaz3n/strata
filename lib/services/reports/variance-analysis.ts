import { getDivisionScopedProjectIds, requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
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
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({ permission: "price_book.read", userId, orgId: resolvedOrgId, supabase, logDecision: true })
  const authorizedIds = await getDivisionScopedProjectIds({ orgId: resolvedOrgId, userId, supabase })
  if (divisionId || authorizedIds !== null) {
    let projectsQuery = supabase.from("projects").select("id").eq("org_id", resolvedOrgId).eq("phase", "delivery")
    if (divisionId) projectsQuery = projectsQuery.eq("division_id", divisionId)
    if (authorizedIds) projectsQuery = projectsQuery.in("id", authorizedIds.length ? authorizedIds : ["00000000-0000-0000-0000-000000000000"])
    const { data: projects, error: projectError } = await projectsQuery.limit(1000)
    if (projectError) throw new Error(`Failed to scope variance analysis: ${projectError.message}`)
    const projectIds = (projects ?? []).map((row) => row.id)
    return getScopedVarianceAnalysis({ supabase, orgId: resolvedOrgId, projectIds, startDate, endDate })
  }
  const { data, error } = await supabase.rpc("get_variance_analysis", {
    p_org_id: resolvedOrgId,
    p_start_date: startDate,
    p_end_date: endDate,
  })
  if (error) throw new Error(`Failed to load variance analysis: ${error.message}`)
  const rows: VarianceAnalysisRow[] = (data ?? []).map((row: Record<string, unknown>) => ({
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
  startDate,
  endDate,
}: {
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"]
  orgId: string
  projectIds: string[]
  startDate: string
  endDate: string
}): Promise<VarianceAnalysisResult> {
  if (!projectIds.length) return { ...emptyVariance(), scoped: true }

  const [facts, budgetByProject] = await Promise.all([
    loadVarianceFacts({ supabase, orgId, projectIds, startDate, endDate }),
    loadLatestBudgets({ supabase, orgId, projectIds }),
  ])
  return { ...summarize(aggregateVarianceFacts(facts, budgetByProject)), scoped: true }
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
  const orders: Array<Record<string, unknown>> = []
  for (let page = 0; ; page += 1) {
    const from = page * FACT_PAGE_SIZE
    const { data, error } = await supabase
      .from("commitment_change_orders")
      .select("id,project_id,total_cents,approved_at,reason_code_id,company_id,reason:variance_reason_codes(label),company:companies(name)")
      .eq("org_id", orgId)
      .in("project_id", projectIds)
      .not("reason_code_id", "is", null)
      .in("status", COUNTED_STATUSES)
      .gte("approved_at", `${startDate}T00:00:00Z`)
      .lte("approved_at", `${endDate}T23:59:59.999Z`)
      .order("id", { ascending: true })
      .range(from, from + FACT_PAGE_SIZE - 1)
    if (error) throw new Error(`Failed to load scoped variance analysis: ${error.message}`)
    orders.push(...(data ?? []))
    if ((data?.length ?? 0) < FACT_PAGE_SIZE) break
  }
  if (orders.length === 0) return []

  const orderProjectIds = Array.from(new Set(orders.map((row) => String(row.project_id))))
  const [lotResult, projectResult, superintendentByProject] = await Promise.all([
    supabase
      .from("lots")
      .select("project_id, community_id, house_plan_id, division_id, community:communities(name), house_plan:house_plans(name)")
      .eq("org_id", orgId)
      .in("project_id", orderProjectIds)
      .limit(5000),
    supabase
      .from("projects")
      .select("id, division_id, division:divisions(name)")
      .eq("org_id", orgId)
      .in("id", orderProjectIds)
      .limit(5000),
    loadSuperintendents({ supabase, orgId, projectIds: orderProjectIds }),
  ])
  if (lotResult.error) throw new Error(`Failed to load variance lots: ${lotResult.error.message}`)
  if (projectResult.error) throw new Error(`Failed to load variance projects: ${projectResult.error.message}`)

  const lotByProject = new Map((lotResult.data ?? []).map((row) => [String(row.project_id), row]))
  const projectById = new Map((projectResult.data ?? []).map((row) => [String(row.id), row]))

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
  const { data: roles, error: roleError } = await supabase.from("roles").select("id").eq("key", "field")
  if (roleError) throw new Error(`Failed to load the superintendent role: ${roleError.message}`)
  const roleIds = (roles ?? []).map((row) => row.id as string)
  if (roleIds.length === 0) return byProject

  const { data, error } = await supabase
    .from("project_members")
    .select("project_id, user_id, created_at, user:app_users(full_name, email)")
    .eq("org_id", orgId)
    .eq("status", "active")
    .in("project_id", projectIds)
    .in("role_id", roleIds)
    .order("created_at", { ascending: true })
    .limit(5000)
  if (error) throw new Error(`Failed to load variance superintendents: ${error.message}`)
  for (const row of data ?? []) {
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
  for (let page = 0; ; page += 1) {
    const from = page * FACT_PAGE_SIZE
    const { data, error } = await supabase
      .from("budgets")
      .select("project_id, total_cents, version")
      .eq("org_id", orgId)
      .in("project_id", projectIds)
      .order("project_id", { ascending: true })
      .order("version", { ascending: false })
      .range(from, from + FACT_PAGE_SIZE - 1)
    if (error) throw new Error(`Failed to load variance budgets: ${error.message}`)
    for (const row of data ?? []) {
      const projectId = String(row.project_id)
      if (!latest.has(projectId)) latest.set(projectId, Number(row.total_cents ?? 0))
    }
    if ((data?.length ?? 0) < FACT_PAGE_SIZE) break
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
  const directCostBudgetCents = reasonRows.reduce((sum, row) => sum + row.direct_cost_budget_cents, 0)
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
