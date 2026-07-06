import { authorize } from "@/lib/services/authorization"
import { requireOrgContext, type OrgServiceContext } from "@/lib/services/context"
import { hasPermission } from "@/lib/services/permissions"

export interface NavigationBadgeCounts {
  myWorkBadgeCount: number
  readyToBillBadgeCount: number
  projectReviewBadgeCounts: Record<string, number>
}

const EMPTY_COUNTS: NavigationBadgeCounts = {
  myWorkBadgeCount: 0,
  readyToBillBadgeCount: 0,
  projectReviewBadgeCounts: {},
}

type ProjectRow = { project_id?: string | null }

/** The four review-queue categories, keyed by the workbench surface they land in. */
export interface ProjectReviewBreakdown {
  time: number
  expenses: number
  bills: number
  costs: number
  total: number
}

function emptyBreakdown(): ProjectReviewBreakdown {
  return { time: 0, expenses: 0, bills: 0, costs: 0, total: 0 }
}

function bumpBreakdown(
  breakdowns: Record<string, ProjectReviewBreakdown>,
  category: keyof Omit<ProjectReviewBreakdown, "total">,
  rows?: ProjectRow[] | null,
) {
  for (const row of rows ?? []) {
    const projectId = row.project_id
    if (!projectId) continue
    const entry = (breakdowns[projectId] ??= emptyBreakdown())
    entry[category] += 1
    entry.total += 1
  }
}

async function rowsFromResult<T extends ProjectRow>(
  result: PromiseSettledResult<{ data: T[] | null; error: any }>,
) {
  if (result.status === "rejected" || result.value.error) return []
  return result.value.data ?? []
}

async function canReviewProjectFinancialQueue(ctx: OrgServiceContext, projectId: string) {
  const decisions = await Promise.all([
    authorize({
      permission: "invoice.write",
      userId: ctx.userId,
      orgId: ctx.orgId,
      projectId,
      supabase: ctx.supabase,
    }),
    authorize({
      permission: "bill.approve",
      userId: ctx.userId,
      orgId: ctx.orgId,
      projectId,
      supabase: ctx.supabase,
    }),
  ])
  return decisions.some((decision) => decision.allowed)
}

/**
 * Per-project, per-category counts of financial items awaiting review, filtered
 * to projects where the current user can actually act on the queue. This is the
 * single source of truth for both the sidebar badge and the My Work desk.
 */
export async function getProjectFinancialReviewBreakdown(
  context?: OrgServiceContext,
): Promise<Record<string, ProjectReviewBreakdown>> {
  const ctx = context ?? await requireOrgContext()

  const { supabase, orgId } = ctx
  const [timeEntries, expenses, vendorBills, billableCosts] = await Promise.allSettled([
    supabase
      .from("time_entries")
      .select("project_id")
      .eq("org_id", orgId)
      .in("status", ["submitted", "pm_approved"]),
    supabase
      .from("project_expenses")
      .select("project_id")
      .eq("org_id", orgId)
      .in("status", ["draft", "submitted"]),
    supabase
      .from("vendor_bills")
      .select("project_id")
      .eq("org_id", orgId)
      .eq("status", "pending"),
    supabase
      .from("billable_costs")
      .select("project_id")
      .eq("org_id", orgId)
      .eq("status", "open")
      .eq("is_billable", true),
  ])

  const breakdowns: Record<string, ProjectReviewBreakdown> = {}
  bumpBreakdown(breakdowns, "time", await rowsFromResult(timeEntries))
  bumpBreakdown(breakdowns, "expenses", await rowsFromResult(expenses))
  bumpBreakdown(breakdowns, "bills", await rowsFromResult(vendorBills))
  bumpBreakdown(breakdowns, "costs", await rowsFromResult(billableCosts))

  const visible: Record<string, ProjectReviewBreakdown> = {}
  await Promise.all(
    Object.entries(breakdowns).map(async ([projectId, breakdown]) => {
      if (await canReviewProjectFinancialQueue(ctx, projectId).catch(() => false)) {
        visible[projectId] = breakdown
      }
    }),
  )
  return visible
}

export async function getProjectFinancialReviewBadgeCounts(context?: OrgServiceContext) {
  const breakdown = await getProjectFinancialReviewBreakdown(context)
  const counts: Record<string, number> = {}
  for (const [projectId, entry] of Object.entries(breakdown)) {
    counts[projectId] = entry.total
  }
  return counts
}

// Count of projects with something ready to bill — mirrors the Billing desk so
// the sidebar badge matches "N ready to bill" on the page. Model-aware: fixed-
// price projects bill by due draws, not their (non-client-billable) job costs.
async function getReadyToBillBadgeCount(ctx: OrgServiceContext) {
  const canViewInvoices = await hasPermission("invoice.read", ctx).catch(() => false)
  if (!canViewInvoices) return 0

  const today = new Date().toISOString().split("T")[0]
  const [costs, draws] = await Promise.all([
    ctx.supabase
      .from("billable_costs")
      .select("project_id")
      .eq("org_id", ctx.orgId)
      .eq("status", "open")
      .eq("is_billable", true),
    ctx.supabase
      .from("draw_schedules")
      .select("project_id")
      .eq("org_id", ctx.orgId)
      .eq("status", "pending")
      .lte("due_date", today),
  ])
  if (costs.error && draws.error) return 0

  const costProjectIds = (costs.data ?? []).map((row: any) => row.project_id).filter(Boolean) as string[]
  const drawProjectIds = new Set(
    (draws.data ?? []).map((row: any) => row.project_id).filter(Boolean) as string[],
  )

  const involved = Array.from(new Set<string>([...costProjectIds, ...drawProjectIds]))
  if (involved.length === 0) return 0

  const { data: settings } = await ctx.supabase
    .from("project_financial_settings")
    .select("project_id, billing_model")
    .eq("org_id", ctx.orgId)
    .in("project_id", involved)
  const fixedPriceProjectIds = new Set(
    (settings ?? [])
      .filter((row: any) => row.billing_model === "fixed_price")
      .map((row: any) => row.project_id as string),
  )

  const readyProjectIds = new Set<string>(drawProjectIds)
  for (const projectId of costProjectIds) {
    if (fixedPriceProjectIds.has(projectId) || drawProjectIds.has(projectId)) continue
    readyProjectIds.add(projectId)
  }
  return readyProjectIds.size
}

async function getAssignedTaskDueSoonCount(ctx: OrgServiceContext) {
  const dueCutoff = new Date()
  dueCutoff.setDate(dueCutoff.getDate() + 7)
  const cutoffIso = dueCutoff.toISOString().slice(0, 10)

  const { data, error } = await ctx.supabase
    .from("task_assignments")
    .select("due_date, task:tasks!inner(id, status, due_date)")
    .eq("org_id", ctx.orgId)
    .eq("user_id", ctx.userId)

  if (error) return 0

  return (data ?? []).filter((row: any) => {
    const task = Array.isArray(row.task) ? row.task[0] : row.task
    if (!task || task.status === "done") return false
    const dueDate = row.due_date ?? task.due_date
    return Boolean(dueDate && String(dueDate) <= cutoffIso)
  }).length
}

export async function getNavigationBadgeCounts(): Promise<NavigationBadgeCounts> {
  try {
    const ctx = await requireOrgContext()
    const [projectReviewBadgeCounts, readyToBillBadgeCount, dueSoonTaskCount] = await Promise.all([
      getProjectFinancialReviewBadgeCounts(ctx),
      getReadyToBillBadgeCount(ctx),
      getAssignedTaskDueSoonCount(ctx),
    ])
    const reviewCount = Object.values(projectReviewBadgeCounts).reduce((sum, count) => sum + count, 0)

    return {
      projectReviewBadgeCounts,
      readyToBillBadgeCount,
      myWorkBadgeCount: reviewCount + dueSoonTaskCount,
    }
  } catch {
    return EMPTY_COUNTS
  }
}
