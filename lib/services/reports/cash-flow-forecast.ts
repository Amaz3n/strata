import {
  applyStartPace,
  BASE_FORECAST_SCENARIO,
  closingProceedsCents,
  forecastMonth,
  plannedStartCostCents,
  shiftIsoDate,
  type ForecastScenario,
} from "@/lib/financials/cash-forecast-drivers"
import { BILLED_INVOICE_STATUSES, PAYABLE_VENDOR_BILL_STATUSES } from "@/lib/financials/ledger-status"
import { payableOutstandingCents } from "@/lib/financials/payables-rules"
import { readAllRows, readAllRowsById } from "@/lib/land/paging"
import { resolveDivisionScope } from "@/lib/land/scope"
import { landObligationsByMonth } from "@/lib/land/takedown-cash"
import { getDivisionAccessForUser } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { loadLandObligationRows } from "@/lib/services/land-contracts"
import { hasPermission, requirePermission } from "@/lib/services/permissions"
import { resolveVisibleProjectIds } from "@/lib/services/projects"
import { forecastScenarioSchema } from "@/lib/validation/cash-forecast"

function month(date: string | null | undefined) {
  return date && /^\d{4}-\d{2}/.test(date) ? date.slice(0, 7) : new Date().toISOString().slice(0, 7)
}

/** One ID-keyed `.in()` list per request; a long list does not fit in a PostgREST URL. */
const PROJECT_CHUNK = 100
/** A scope past this many rows fails loudly rather than forecasting from part of it. */
const FORECAST_ROW_CAP = 50_000

type ForecastProject = { id: string; name: string; phase: string | null; status: string | null; start_date: string | null; end_date: string | null }
const ACTIVE_STATUSES = ["active", "planning", "on_hold"]
type ForecastInvoice = { id: string; project_id: string; due_date: string | null; balance_due_cents: number | null; total_cents: number | null }
type ForecastBill = { id: string; project_id: string; due_date: string | null; total_cents: number | null; paid_cents: number | null; retainage_cents: number | null }
type ForecastCommitment = { id: string; project_id: string; total_cents: number | null; vendor_bills: Array<{ total_cents: number | null }> | null }

function chunks(ids: string[]) {
  const out: string[][] = []
  for (let index = 0; index < ids.length; index += PROJECT_CHUNK) out.push(ids.slice(index, index + PROJECT_CHUNK))
  return out
}

type OrgContext = Awaited<ReturnType<typeof requireOrgContext>>
type ForecastLens = { projectId?: string; divisionId?: string; communityId?: string }

/**
 * The communities whose land obligations the forecast carries, or null for the
 * whole org. Land is not a project's money: a project lens carries none, and a
 * reader without community access sees none. The caller's division scope
 * always applies; a division or community lens only narrows it.
 */
async function landScope(context: OrgContext, input: ForecastLens): Promise<string[] | null> {
  if (input.projectId || !(await hasPermission("community.read", context))) return []
  const decision = resolveDivisionScope(await getDivisionAccessForUser({ orgId: context.orgId, userId: context.userId }), input.divisionId)
  if (decision.kind === "none") return []
  if (decision.kind === "all" && !input.communityId) return null
  const communities = await readAllRows<{ id: string }>((from, to) => {
    let query = context.supabase.from("communities").select("id").eq("org_id", context.orgId)
    if (decision.kind === "limited") query = query.in("division_id", decision.divisionIds)
    if (input.communityId) query = query.eq("id", input.communityId)
    return query.order("id").range(from, to)
  }, { cap: FORECAST_ROW_CAP, label: "Failed to load cash-flow communities" })
  return communities.rows.map((row) => row.id)
}

/** A community lens on projects: homes reach a community only through their lot. */
async function communityProjectIds(context: OrgContext, communityId: string) {
  const lots = await readAllRows<{ project_id: string }>((from, to) =>
    context.supabase.from("lots").select("project_id").eq("org_id", context.orgId).eq("community_id", communityId)
      .not("project_id", "is", null).order("id").range(from, to),
  { cap: FORECAST_ROW_CAP, label: "Failed to load cash-flow community homes" })
  return lots.rows.map((row) => row.project_id)
}

type Bucket = { inflow_cents: number; outflow_cents: number; committed_unbilled_cents: number; land_obligations_cents: number; closing_proceeds_cents: number; starts_cost_cents: number }

/** Every set read to the end, one ID chunk at a time. */
async function readPerChunk<Row extends { id: string }>(
  ids: string[],
  label: string,
  read: (projectIds: string[], afterId: string | null, limit: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>,
) {
  return (await Promise.all(chunks(ids).map((projectIds) => readAllRowsById<Row>((afterId, limit) => read(projectIds, afterId, limit), { cap: FORECAST_ROW_CAP, label, pageSize: 1000 })))).flat()
}

/**
 * The projects the reader may forecast, narrowed by any lens. Receivables and
 * payables read the ones under construction; the construction drivers read
 * them all, since a planned start's home is not yet delivering.
 */
async function scopedProjects(context: OrgContext, input: ForecastLens): Promise<ForecastProject[]> {
  const { supabase, orgId, userId } = context
  const visibleProjectIds = await resolveVisibleProjectIds({ supabase, orgId, userId, includePrecon: false })
  if (visibleProjectIds?.length === 0) return []
  const lensProjectIds = input.communityId ? await communityProjectIds(context, input.communityId) : null
  if (lensProjectIds?.length === 0) return []
  return readAllRowsById<ForecastProject>((afterId, limit) => {
    let query = supabase.from("projects").select("id,name,phase,status,start_date,end_date").eq("org_id", orgId)
    if (visibleProjectIds) query = query.in("id", visibleProjectIds)
    if (lensProjectIds) query = query.in("id", lensProjectIds)
    if (input.projectId) query = query.eq("id", input.projectId)
    if (input.divisionId) query = query.eq("division_id", input.divisionId)
    if (afterId) query = query.gt("id", afterId)
    return query.order("id").limit(limit).returns<ForecastProject[]>()
  }, { cap: FORECAST_ROW_CAP, label: "Failed to load cash-flow projects", pageSize: 1000 })
}

/** Project cash: receivables in, approved bills and committed-but-unbilled cost out. */
async function projectCash(context: OrgContext, scoped: ForecastProject[], bucket: (key: string) => Bucket) {
  const { supabase, orgId } = context
  // Phase does not matter: a home still to start can already carry purchase orders and billed deposits, and
  // each of those counts here exactly once (starts net the commitments out of their budget).
  const projects = scoped.filter((project) => ACTIVE_STATUSES.includes(project.status ?? ""))
  const ids = projects.map((project) => project.id)
  if (!ids.length) return
  const [invoices, bills, commitments] = await Promise.all([
    // Forecast cash IN from real receivables only. Excluding `paid` and `void`
    // left `draft` and `saved` in, so an invoice nobody had sent — and might
    // never send — was projected as money arriving on its due date.
    readPerChunk<ForecastInvoice>(ids, "Failed to load cash-flow receivables", (projectIds, afterId, limit) => {
      let query = supabase.from("invoices").select("id,project_id,due_date,balance_due_cents,total_cents").eq("org_id", orgId).in("project_id", projectIds).in("status", [...BILLED_INVOICE_STATUSES])
      if (afterId) query = query.gt("id", afterId)
      return query.order("id").limit(limit).returns<ForecastInvoice[]>()
    }),
    readPerChunk<ForecastBill>(ids, "Failed to load cash-flow payables", (projectIds, afterId, limit) => {
      let query = supabase.from("vendor_bills").select("id,project_id,due_date,total_cents,paid_cents,retainage_cents").eq("org_id", orgId).in("project_id", projectIds).in("status", [...PAYABLE_VENDOR_BILL_STATUSES])
      if (afterId) query = query.gt("id", afterId)
      return query.order("id").limit(limit).returns<ForecastBill[]>()
    }),
    readPerChunk<ForecastCommitment>(ids, "Failed to load cash-flow commitments", (projectIds, afterId, limit) => {
      let query = supabase.from("commitments").select("id,project_id,total_cents,vendor_bills(total_cents)").eq("org_id", orgId).in("project_id", projectIds).in("status", ["approved","executed"])
      if (afterId) query = query.gt("id", afterId)
      return query.order("id").limit(limit).returns<ForecastCommitment[]>()
    }),
  ])
  for (const invoice of invoices) bucket(month(invoice.due_date)).inflow_cents += Math.max(0, Number(invoice.balance_due_cents ?? invoice.total_cents ?? 0))
  // Held retainage is not due on the bill's due date — `payableOutstandingCents`
  // is the one rule that knows to leave it out.
  for (const bill of bills) bucket(month(bill.due_date)).outflow_cents += payableOutstandingCents({ total_cents: Number(bill.total_cents ?? 0), paid_cents: Number(bill.paid_cents ?? 0), retainage_cents: Number(bill.retainage_cents ?? 0) })
  const projectById = new Map(projects.map((project) => [project.id, project]))
  for (const commitment of commitments) {
    const billed = (commitment.vendor_bills ?? []).reduce((sum, bill) => sum + Number(bill.total_cents ?? 0), 0)
    const unbilled = Math.max(0, Number(commitment.total_cents ?? 0) - billed)
    const project = projectById.get(commitment.project_id)
    bucket(month(project?.end_date)).committed_unbilled_cents += unbilled
  }
}

/**
 * `restricted` is set when the reader cannot open the records a driver is
 * computed from (budgets and commitments for starts; invoices for closings):
 * a closing's proceeds net of invoices they cannot see would overstate cash, so
 * the driver is left out and says so.
 */
export type CashForecastDrivers = {
  starts: { count: number; costCents: number; undatedCount: number; unbudgetedCount: number; restricted: boolean }
  closings: { count: number; proceedsCents: number; undatedCount: number; unsignedCount: number; restricted: boolean }
}

type StartRow = { id: string; project_id: string | null; target_week: string | null; scheduled_start_date: string | null }
type ClosingRow = { id: string; project_id: string; scheduled_date: string | null }
type BudgetRow = { id: string; project_id: string; version: number | null; total_cents: number | null }
type CommitmentTotalRow = { id: string; project_id: string; total_cents: number | null }
type AgreementRow = { id: string; project_id: string; total_cents: number | null; signed_at: string | null }
type BilledInvoiceRow = { id: string; project_id: string; total_cents: number | null }

/**
 * Construction cash: planned starts (the uncommitted budget of each home still
 * to start, in its start month) out, and scheduled closings (agreement price
 * less what is already billed, on the closing date) in. The scenario moves
 * closings by whole weeks and scales planned starts; it never touches money
 * already billed, bought or committed.
 */
async function constructionCash(context: OrgContext, projects: ForecastProject[], bucket: (key: string) => Bucket, scenario: ForecastScenario, today: string): Promise<CashForecastDrivers> {
  const { supabase, orgId } = context
  const drivers: CashForecastDrivers = {
    starts: { count: 0, costCents: 0, undatedCount: 0, unbudgetedCount: 0, restricted: false },
    closings: { count: 0, proceedsCents: 0, undatedCount: 0, unsignedCount: 0, restricted: false },
  }
  const [canReadBudgets, canReadCommitments, canReadInvoices, canReadSales] = await Promise.all([
    hasPermission("budget.read", context), hasPermission("commitment.read", context), hasPermission("invoice.read", context), hasPermission("sales.read", context),
  ])
  drivers.starts.restricted = !(canReadBudgets && canReadCommitments)
  drivers.closings.restricted = !(canReadInvoices && canReadSales)
  const ids = projects.map((project) => project.id)
  if (!ids.length) return drivers
  const [starts, closings, budgets, commitments, agreements, invoices] = await Promise.all([
    drivers.starts.restricted ? [] : readPerChunk<StartRow>(ids, "Failed to load planned starts", (projectIds, afterId, limit) => {
      let query = supabase.from("start_packages").select("id,project_id,target_week,scheduled_start_date").eq("org_id", orgId).in("project_id", projectIds).in("status", ["open","ready","releasing","attention"])
      if (afterId) query = query.gt("id", afterId)
      return query.order("id").limit(limit).returns<StartRow[]>()
    }),
    drivers.closings.restricted ? [] : readPerChunk<ClosingRow>(ids, "Failed to load scheduled closings", (projectIds, afterId, limit) => {
      let query = supabase.from("closings").select("id,project_id,scheduled_date").eq("org_id", orgId).in("project_id", projectIds).in("status", ["projected","scheduled","cleared_to_close"])
      if (afterId) query = query.gt("id", afterId)
      return query.order("id").limit(limit).returns<ClosingRow[]>()
    }),
    drivers.starts.restricted ? [] : readPerChunk<BudgetRow>(ids, "Failed to load start budgets", (projectIds, afterId, limit) => {
      let query = supabase.from("budgets").select("id,project_id,version,total_cents").eq("org_id", orgId).in("project_id", projectIds).neq("status", "draft")
      if (afterId) query = query.gt("id", afterId)
      return query.order("id").limit(limit).returns<BudgetRow[]>()
    }),
    drivers.starts.restricted ? [] : readPerChunk<CommitmentTotalRow>(ids, "Failed to load start commitments", (projectIds, afterId, limit) => {
      let query = supabase.from("commitments").select("id,project_id,total_cents").eq("org_id", orgId).in("project_id", projectIds).in("status", ["approved","executed"])
      if (afterId) query = query.gt("id", afterId)
      return query.order("id").limit(limit).returns<CommitmentTotalRow[]>()
    }),
    drivers.closings.restricted ? [] : readPerChunk<AgreementRow>(ids, "Failed to load closing agreements", (projectIds, afterId, limit) => {
      let query = supabase.from("contracts").select("id,project_id,total_cents,signed_at").eq("org_id", orgId).in("project_id", projectIds).eq("contract_type", "purchase_agreement").eq("status", "active")
      if (afterId) query = query.gt("id", afterId)
      return query.order("id").limit(limit).returns<AgreementRow[]>()
    }),
    drivers.closings.restricted ? [] : readPerChunk<BilledInvoiceRow>(ids, "Failed to load closing receivables", (projectIds, afterId, limit) => {
      let query = supabase.from("invoices").select("id,project_id,total_cents").eq("org_id", orgId).in("project_id", projectIds).in("status", [...BILLED_INVOICE_STATUSES])
      if (afterId) query = query.gt("id", afterId)
      return query.order("id").limit(limit).returns<BilledInvoiceRow[]>()
    }),
  ])

  const sumBy = <Row extends { project_id: string }>(rows: Row[], amount: (row: Row) => number) => {
    const totals = new Map<string, number>()
    for (const row of rows) totals.set(row.project_id, (totals.get(row.project_id) ?? 0) + amount(row))
    return totals
  }
  const newestBudget = new Map<string, BudgetRow>()
  for (const row of budgets) {
    const current = newestBudget.get(row.project_id)
    if (!current || Number(row.version ?? 0) > Number(current.version ?? 0)) newestBudget.set(row.project_id, row)
  }
  const committed = sumBy(commitments, (row) => Number(row.total_cents ?? 0))
  const startMonths = new Map<string, number>()
  for (const start of starts) {
    if (!start.project_id) continue
    const date = start.scheduled_start_date ?? start.target_week
    if (!date) { drivers.starts.undatedCount += 1; continue }
    const budget = newestBudget.get(start.project_id)
    if (!budget) { drivers.starts.unbudgetedCount += 1; continue }
    const cost = plannedStartCostCents({ budgetCents: Number(budget.total_cents ?? 0), committedCents: committed.get(start.project_id) ?? 0 })
    const key = forecastMonth(date, today)
    startMonths.set(key, (startMonths.get(key) ?? 0) + cost)
    drivers.starts.count += 1
  }
  for (const [key, cost] of startMonths) {
    const paced = applyStartPace(cost, scenario.startPacePercent)
    bucket(key).starts_cost_cents += paced
    drivers.starts.costCents += paced
  }

  const agreementByProject = new Map<string, AgreementRow>()
  for (const row of agreements) {
    const current = agreementByProject.get(row.project_id)
    if (!current || (row.signed_at ?? "") > (current.signed_at ?? "")) agreementByProject.set(row.project_id, row)
  }
  // Every issued invoice, a closing's own included (one left by a failed settlement is already a receivable
  // above), so the proceeds are only the price not yet billed and no dollar is counted twice.
  const billed = sumBy(invoices, (row) => Number(row.total_cents ?? 0))
  for (const closing of closings) {
    if (!closing.scheduled_date) { drivers.closings.undatedCount += 1; continue }
    const agreement = agreementByProject.get(closing.project_id)
    if (!agreement) { drivers.closings.unsignedCount += 1; continue }
    const proceeds = closingProceedsCents({ agreementTotalCents: Number(agreement.total_cents ?? 0), billedCents: billed.get(closing.project_id) ?? 0 })
    bucket(forecastMonth(shiftIsoDate(closing.scheduled_date, scenario.closingShiftWeeks), today)).closing_proceeds_cents += proceeds
    drivers.closings.count += 1
    drivers.closings.proceedsCents += proceeds
  }
  return drivers
}

/**
 * Cash in and out by month: every delivery project the caller can open, the
 * planned starts and scheduled closings of the homes they can open, and — at
 * org, division or community scope — the land contracts' takedowns, deposits
 * and fees (`landObligationsByMonth`, the same rule the community board uses).
 * The caller's division and project-membership scope always applies; a
 * `divisionId`, `communityId` or `projectId` lens only narrows it. Every set is
 * read to the end — a forecast summed from the first page is not smaller, it is
 * wrong. The scenario moves closings and scales starts only; construction
 * financing (loan draws, interest, payoffs) is not part of the forecast.
 */
export async function getCashFlowForecast(input: ForecastLens & { orgId?: string; scenario?: Partial<ForecastScenario> }) {
  const context = await requireOrgContext(input.orgId)
  await requirePermission("report.read", context)
  const scenario = forecastScenarioSchema.parse({ ...BASE_FORECAST_SCENARIO, ...input.scenario })
  const buckets = new Map<string, Bucket>()
  const bucket = (key: string) => {
    const value = buckets.get(key) ?? { inflow_cents: 0, outflow_cents: 0, committed_unbilled_cents: 0, land_obligations_cents: 0, closing_proceeds_cents: 0, starts_cost_cents: 0 }
    buckets.set(key, value)
    return value
  }
  const today = new Date().toISOString().slice(0, 10)
  const [projects, communityIds] = await Promise.all([scopedProjects(context, input), landScope(context, input)])
  const [, drivers] = await Promise.all([
    projectCash(context, projects, bucket),
    constructionCash(context, projects, bucket, scenario, today),
  ])
  if (communityIds === null || communityIds.length > 0) {
    const land = await loadLandObligationRows(context.supabase, context.orgId, { communityIds })
    for (const row of landObligationsByMonth({ ...land, today })) bucket(row.month).land_obligations_cents += row.totalCents
  }
  const months = Array.from(buckets.keys()).sort()
  const rows = months.map((key) => {
    const value = bucket(key)
    return {
      month: key,
      ...value,
      net_cents: value.inflow_cents + value.closing_proceeds_cents - value.outflow_cents - value.committed_unbilled_cents - value.land_obligations_cents - value.starts_cost_cents,
    }
  })
  return {
    months,
    rows,
    scenario,
    drivers,
    totals: {
      inflow_cents: rows.reduce((sum, row) => sum + row.inflow_cents, 0),
      closing_proceeds_cents: rows.reduce((sum, row) => sum + row.closing_proceeds_cents, 0),
      outflow_cents: rows.reduce((sum, row) => sum + row.outflow_cents, 0),
      committed_unbilled_cents: rows.reduce((sum, row) => sum + row.committed_unbilled_cents, 0),
      land_obligations_cents: rows.reduce((sum, row) => sum + row.land_obligations_cents, 0),
      starts_cost_cents: rows.reduce((sum, row) => sum + row.starts_cost_cents, 0),
      net_cents: rows.reduce((sum, row) => sum + row.net_cents, 0),
    },
  }
}
