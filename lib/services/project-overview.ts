import "server-only"

import { cache } from "react"
import { addDays, differenceInCalendarDays, isBefore, parseISO } from "date-fns"
import type { SupabaseClient } from "@supabase/supabase-js"

import { BILLED_INVOICE_STATUSES } from "@/lib/financials/ledger-status"
import { resolveBilledCents } from "@/lib/financials/poc-inputs"
import { withSpan } from "@/lib/observability/spans"
import { getBudgetWithActuals } from "@/lib/services/budgets"
import { getProjectContract } from "@/lib/services/contracts"
import { requireOrgContext } from "@/lib/services/context"
import { getProjectJobCostActualsByCostCode } from "@/lib/services/job-cost-actuals"
import { hasPermission, requireProjectPermission } from "@/lib/services/permissions"
import type { Project } from "@/lib/types"

// ============================================================================
// project_overview_v1 — the read contract
//
// The overview is a READ CONTRACT, not a pile of loaders. It has exactly three
// bands, each independently loadable, each with its own latency budget:
//
//   identity    the project row                       (p95 300ms)
//   operations  what needs attention, what is coming  (p95 700ms)
//   financials  contract, billed, spend, budget       (p95 1500ms)
//
// Everything a band returns is bounded and displayed. Nothing is loaded "in
// case someone wants it": the previous shape computed ten entity counts, the
// recent-files list, the activity feed, the proposal list and the full draw
// schedule on every project switch, and rendered none of them.
// ============================================================================

/** How many rows each attention source may contribute before the band is capped. */
const ATTENTION_LIMITS = {
  task: 5,
  schedule: 5,
  rfi: 3,
  submittal: 3,
  punch: 3,
} as const

/** The attention band shows the N most urgent rows across every source. */
const ATTENTION_CAP = 10
/** The week band shows the N nearest dated rows across every source. */
const COMING_UP_CAP = 7
/** How far ahead "this week" reaches. */
const COMING_UP_DAYS = 7

export interface AttentionItem {
  id: string
  type: "task" | "schedule" | "rfi" | "submittal" | "punch" | "closeout" | "warranty"
  title: string
  reason: "overdue" | "at_risk" | "blocked" | "pending" | "missing"
  dueDate?: string | null
  status?: string
  link: string
}

export interface ComingUpItem {
  id: string
  type: "schedule" | "task" | "milestone" | "draw"
  title: string
  date: string
  status?: string
  progress?: number
  link: string
}

export interface ProjectOverviewTimeline {
  daysRemaining: number
  daysElapsed: number
  daysUntilStart: number
  totalDays: number
  timeElapsedPercent: number
}

export interface ProjectOverviewOperations {
  scheduleProgress: number
  attention: AttentionItem[]
  /** True when more rows matched than the band shows, so the UI can say so. */
  attentionTruncated: boolean
  comingUp: ComingUpItem[]
  comingUpTruncated: boolean
}

export interface ProjectOverviewFinancials {
  contractTotalCents: number
  approvedChangeOrdersTotalCents: number
  billedCents: number
  actualCents: number
  /** Null when the project has no budget, or the reader cannot see budgets. */
  adjustedBudgetCents: number | null
  /** Percent of the adjusted budget already spent. Null without a budget. */
  budgetVariancePercent: number | null
}

// ============================================================================
// Identity band
// ============================================================================

/** Timeline arithmetic is pure so it can be tested without a database. */
export function resolveProjectTimeline(
  project: Pick<Project, "start_date" | "end_date">,
  today: Date,
): ProjectOverviewTimeline {
  const startDate = project.start_date ? parseISO(project.start_date) : today
  const endDate = project.end_date ? parseISO(project.end_date) : today
  const totalDays = Math.max(1, differenceInCalendarDays(endDate, startDate))
  const daysElapsed = Math.max(0, Math.min(totalDays, differenceInCalendarDays(today, startDate)))
  const daysRemaining = Math.max(0, differenceInCalendarDays(endDate, today))
  // Days until the project starts (0 once it's underway) — lets the UI surface
  // "Starts in Nd" for not-yet-started projects instead of "Day 0 of N".
  const daysUntilStart = project.start_date
    ? Math.max(0, differenceInCalendarDays(startDate, today))
    : 0
  const hasDates = Boolean(project.start_date && project.end_date)
  return {
    totalDays: hasDates ? totalDays : 0,
    daysElapsed,
    daysRemaining,
    daysUntilStart,
    timeElapsedPercent: hasDates ? Math.min(100, Math.round((daysElapsed / totalDays) * 100)) : 0,
  }
}

// ============================================================================
// Operations band
// ============================================================================

function isoDay(date: Date) {
  return date.toISOString().split("T")[0]
}

function fail(what: string, error: { message: string } | null) {
  // Query failures surface as a band error, never as a healthy zero. A timed-out
  // count that renders "0 overdue" is worse than no band at all.
  if (error) throw new Error(`Failed to load ${what}: ${error.message}`)
}

async function loadOperations(
  supabase: SupabaseClient,
  orgId: string,
  projectId: string,
  today: Date,
): Promise<ProjectOverviewOperations> {
  const todayStr = isoDay(today)
  const horizonStr = isoDay(addDays(today, COMING_UP_DAYS))

  const [
    scheduleTotal,
    scheduleCompleted,
    scheduleAtRisk,
    scheduleUpcoming,
    overdueTasks,
    upcomingTasks,
    overdueRfis,
    overdueSubmittals,
    overduePunch,
    upcomingDraws,
  ] = await Promise.all([
    supabase
      .from("schedule_items")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .neq("status", "cancelled"),
    supabase
      .from("schedule_items")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("status", "completed"),
    supabase
      .from("schedule_items")
      .select("id, name, end_date, status", { count: "exact" })
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .or(`status.in.(at_risk,blocked),and(end_date.lt.${todayStr},status.neq.completed,status.neq.cancelled)`)
      .order("end_date", { ascending: true })
      .limit(ATTENTION_LIMITS.schedule),
    supabase
      .from("schedule_items")
      .select("id, name, start_date, end_date, status, progress, item_type", { count: "exact" })
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .not("status", "in", "(completed,cancelled)")
      .or(`start_date.gte.${todayStr},end_date.gte.${todayStr}`)
      .lte("start_date", horizonStr)
      .order("start_date", { ascending: true })
      .limit(COMING_UP_CAP),
    supabase
      .from("tasks")
      .select("id, title, due_date, status", { count: "exact" })
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .neq("status", "done")
      .lt("due_date", todayStr)
      .order("due_date", { ascending: true })
      .limit(ATTENTION_LIMITS.task),
    supabase
      .from("tasks")
      .select("id, title, due_date, status", { count: "exact" })
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .neq("status", "done")
      .gte("due_date", todayStr)
      .lte("due_date", horizonStr)
      .order("due_date", { ascending: true })
      .limit(ATTENTION_LIMITS.task),
    supabase
      .from("rfis")
      .select("id, subject, due_date, status", { count: "exact" })
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .in("status", ["open", "in_review"])
      .lt("due_date", todayStr)
      .order("due_date", { ascending: true })
      .limit(ATTENTION_LIMITS.rfi),
    supabase
      .from("submittals")
      .select("id, title, due_date, status", { count: "exact" })
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .in("status", ["pending", "submitted", "in_review", "revise_resubmit"])
      .lt("due_date", todayStr)
      .order("due_date", { ascending: true })
      .limit(ATTENTION_LIMITS.submittal),
    supabase
      .from("punch_items")
      .select("id, title, due_date, status", { count: "exact" })
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .neq("status", "closed")
      .lt("due_date", todayStr)
      .order("due_date", { ascending: true })
      .limit(ATTENTION_LIMITS.punch),
    supabase
      .from("draw_schedules")
      .select("id, title, due_date, status", { count: "exact" })
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .in("status", ["pending", "scheduled"])
      .gte("due_date", todayStr)
      .order("due_date", { ascending: true })
      .limit(2),
  ])

  fail("schedule progress", scheduleTotal.error)
  fail("completed schedule items", scheduleCompleted.error)
  fail("at-risk schedule items", scheduleAtRisk.error)
  fail("upcoming schedule items", scheduleUpcoming.error)
  fail("overdue tasks", overdueTasks.error)
  fail("upcoming tasks", upcomingTasks.error)
  fail("overdue RFIs", overdueRfis.error)
  fail("overdue submittals", overdueSubmittals.error)
  fail("overdue punch items", overduePunch.error)
  fail("upcoming draws", upcomingDraws.error)

  const total = scheduleTotal.count ?? 0
  const scheduleProgress = total > 0 ? Math.round(((scheduleCompleted.count ?? 0) / total) * 100) : 0

  const attention: AttentionItem[] = []
  let attentionMatched = 0

  attentionMatched += overdueTasks.count ?? 0
  for (const task of overdueTasks.data ?? []) {
    attention.push({
      id: task.id,
      type: "task",
      title: task.title,
      reason: "overdue",
      dueDate: task.due_date,
      status: task.status,
      link: `/projects/${projectId}/tasks?highlight=${task.id}`,
    })
  }

  attentionMatched += scheduleAtRisk.count ?? 0
  for (const item of scheduleAtRisk.data ?? []) {
    const overdue = Boolean(item.end_date) && isBefore(parseISO(item.end_date), today) && item.status !== "completed"
    attention.push({
      id: item.id,
      type: "schedule",
      title: item.name,
      reason: overdue ? "overdue" : item.status === "blocked" ? "blocked" : "at_risk",
      dueDate: item.end_date,
      status: item.status,
      link: `/projects/${projectId}/schedule?highlight=${item.id}`,
    })
  }

  attentionMatched += overdueRfis.count ?? 0
  for (const rfi of overdueRfis.data ?? []) {
    attention.push({
      id: rfi.id,
      type: "rfi",
      title: rfi.subject,
      reason: "overdue",
      dueDate: rfi.due_date,
      status: rfi.status,
      link: `/rfis?project=${projectId}&highlight=${rfi.id}`,
    })
  }

  attentionMatched += overdueSubmittals.count ?? 0
  for (const submittal of overdueSubmittals.data ?? []) {
    attention.push({
      id: submittal.id,
      type: "submittal",
      title: submittal.title,
      reason: "overdue",
      dueDate: submittal.due_date,
      status: submittal.status,
      link: `/submittals?project=${projectId}&highlight=${submittal.id}`,
    })
  }

  attentionMatched += overduePunch.count ?? 0
  for (const punch of overduePunch.data ?? []) {
    attention.push({
      id: punch.id,
      type: "punch",
      title: punch.title,
      reason: "overdue",
      dueDate: punch.due_date,
      status: punch.status,
      link: `/projects/${projectId}/punch?highlight=${punch.id}`,
    })
  }

  attention.sort(byDueDate)

  const comingUp: ComingUpItem[] = []
  const comingUpMatched =
    (scheduleUpcoming.count ?? 0) + (upcomingTasks.count ?? 0) + (upcomingDraws.count ?? 0)
  for (const item of scheduleUpcoming.data ?? []) {
    comingUp.push({
      id: item.id,
      type: item.item_type === "milestone" ? "milestone" : "schedule",
      title: item.name,
      date: item.start_date ?? item.end_date,
      status: item.status,
      progress: item.progress ?? 0,
      link: `/projects/${projectId}/schedule?highlight=${item.id}`,
    })
  }
  for (const task of upcomingTasks.data ?? []) {
    comingUp.push({
      id: task.id,
      type: "task",
      title: task.title,
      date: task.due_date,
      status: task.status,
      link: `/projects/${projectId}/tasks?highlight=${task.id}`,
    })
  }
  for (const draw of upcomingDraws.data ?? []) {
    if (!draw.due_date) continue
    comingUp.push({
      id: draw.id,
      type: "draw",
      title: draw.title,
      date: draw.due_date,
      status: draw.status,
      link: `/projects/${projectId}/financials`,
    })
  }
  comingUp.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

  return {
    scheduleProgress,
    attention: attention.slice(0, ATTENTION_CAP),
    attentionTruncated: attentionMatched > Math.min(attention.length, ATTENTION_CAP),
    comingUp: comingUp.slice(0, COMING_UP_CAP),
    comingUpTruncated: comingUpMatched > Math.min(comingUp.length, COMING_UP_CAP),
  }
}

function byDueDate(a: AttentionItem, b: AttentionItem) {
  if (!a.dueDate && !b.dueDate) return 0
  if (!a.dueDate) return 1
  if (!b.dueDate) return -1
  return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()
}

// ============================================================================
// Financials band
// ============================================================================

async function loadFinancials(
  supabase: SupabaseClient,
  orgId: string,
  projectId: string,
  canReadBudget: boolean,
): Promise<ProjectOverviewFinancials> {
  const [contract, changeOrders, invoices, budget] = await Promise.all([
    getProjectContract(projectId),
    supabase
      .from("change_orders")
      .select("total_cents")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("status", "approved"),
    supabase
      .from("invoices")
      .select("total_cents")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .in("status", [...BILLED_INVOICE_STATUSES]),
    // ONE reconstruction. The overview used to run this twice — once directly and
    // once inside getProjectPocPosition — and used the second run for nothing but
    // `billedCents`, which is exactly the invoice sum three lines above.
    canReadBudget ? getBudgetWithActuals(projectId, orgId) : Promise.resolve(null),
  ])

  fail("approved change orders", changeOrders.error)
  fail("billed invoices", invoices.error)

  const adjustedBudgetCents = budget ? budget.summary.adjusted_budget_cents ?? 0 : null
  const budgetActualCents = budget ? budget.summary.total_actual_cents ?? 0 : null

  // Actuals must not depend on a budget existing: a project with QBO-imported
  // invoices and no budget still has spend, and zeroing it blanks the Margin KPI.
  const actualCents =
    budgetActualCents ??
    (await getProjectJobCostActualsByCostCode({ projectId, orgId, supabase })).reduce(
      (sum, row) => sum + row.actual_cents,
      0,
    )

  return {
    contractTotalCents: contract?.total_cents ?? 0,
    approvedChangeOrdersTotalCents: (changeOrders.data ?? []).reduce(
      (sum, row) => sum + (row.total_cents ?? 0),
      0,
    ),
    // The project's one billed number: invoice TOTALS in the billed set, the same
    // definition the budget tab's "Billed" uses. Cost-coded invoice LINES are a
    // different number whenever an invoice carries tax or is uncoded.
    billedCents: resolveBilledCents((invoices.data ?? []).map((row) => row.total_cents)),
    actualCents,
    adjustedBudgetCents,
    budgetVariancePercent:
      adjustedBudgetCents && adjustedBudgetCents > 0
        ? Math.round(((budgetActualCents ?? 0) / adjustedBudgetCents) * 100)
        : null,
  }
}

// ============================================================================
// Entry points
//
// Request-cached so a band that two sections read (the stats strip and the
// attention list both need financials) costs one load per render.
// ============================================================================

const operationsCached = cache(async (projectId: string): Promise<ProjectOverviewOperations> => {
  const { supabase, orgId, userId, productTier } = await requireOrgContext()
  await requireProjectPermission(userId, projectId, "project.read")
  return withSpan("project.operations", { tier: productTier }, () =>
    loadOperations(supabase, orgId, projectId, new Date()),
  )
})

const financialsCached = cache(async (projectId: string): Promise<ProjectOverviewFinancials> => {
  const { supabase, orgId, userId, productTier } = await requireOrgContext()
  await requireProjectPermission(userId, projectId, "project.read")
  const canReadBudget = await hasPermission("budget.read", { supabase, orgId, userId })
  return withSpan("project.financials", { tier: productTier, budget: canReadBudget }, () =>
    loadFinancials(supabase, orgId, projectId, canReadBudget),
  )
})

export function getProjectOverviewOperations(projectId: string) {
  return operationsCached(projectId)
}

export function getProjectOverviewFinancials(projectId: string) {
  return financialsCached(projectId)
}
