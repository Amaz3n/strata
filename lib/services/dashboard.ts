import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

import { requireOrgContext } from "@/lib/services/context";
import { applyProjectReportingScope, applyReportingExclusion, getReportingExcludedProjectIds } from "@/lib/services/reporting-scope";
import { listProjectsWithClient } from "@/lib/services/projects";
import { listTasksWithClient } from "@/lib/services/tasks";
import type { DashboardStats, Project, Task } from "@/lib/types";

export interface DashboardSnapshot {
  projects: Project[];
  tasks: Task[];
  stats: DashboardStats;
}

export async function getDashboardSnapshot(
  orgId?: string,
): Promise<DashboardSnapshot> {
  const context = await requireOrgContext(orgId);

  const [projects, tasks, approvalsCount, photosCount] = await Promise.all([
    listProjectsWithClient(context.supabase, context.orgId),
    listTasksWithClient(context.supabase, context.orgId),
    countPendingApprovals(context),
    countRecentPhotos(context),
  ]);

  const stats: DashboardStats = {
    activeProjects: projects.filter(
      (p) =>
        p.status === "active" ||
        p.status === "on_hold",
    ).length,
    tasksThisWeek: tasks.filter((task) => isDueThisWeek(task.due_date)).length,
    pendingApprovals: approvalsCount,
    recentPhotos: photosCount,
  };

  return { projects, tasks, stats };
}

async function countPendingApprovals(context: {
  supabase: SupabaseClient;
  orgId: string;
}) {
  const { count, error } = await context.supabase
    .from("approvals")
    .select("id", { count: "exact", head: true })
    .eq("org_id", context.orgId)
    .eq("status", "pending");

  if (error) {
    console.error("Failed to count approvals", error);
    return 0;
  }

  return count ?? 0;
}

async function countRecentPhotos(context: {
  supabase: SupabaseClient;
  orgId: string;
}) {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const { count, error } = await context.supabase
    .from("photos")
    .select("id", { count: "exact", head: true })
    .eq("org_id", context.orgId)
    .gte("created_at", sevenDaysAgo.toISOString());

  if (error) {
    console.error("Failed to count recent photos", error);
    return 0;
  }

  return count ?? 0;
}

function isDueThisWeek(dueDate?: string) {
  if (!dueDate) return false;
  const due = new Date(dueDate);
  const now = new Date();
  const diff = due.getTime() - now.getTime();
  const days = diff / (1000 * 60 * 60 * 24);
  return days >= -7 && days <= 7;
}

// --- Control Tower ---

export interface PortfolioHealth {
  activeProjects: number;
  projectsAtRisk: number;
  cashRiskCents: number;
  overdueARCents: number;
  unpaidApprovedBillsCents: number;
  totalBlockers: number;
  itemsDueNext7Days: number;
}

export interface OverdueInvoiceItem {
  id: string;
  number: string | null;
  projectName: string | null;
  balanceCents: number;
  dueDate: string | null;
  daysOverdue: number;
  href: string;
}

export interface DueWorkItem {
  id: string;
  title: string;
  projectName: string | null;
  date: string | null;
  isOverdue: boolean;
  isCriticalPath: boolean;
  href: string;
}

export type OperationsLookaheadKind =
  | "schedule_start"
  | "schedule_finish"
  | "task_due";

export interface OperationsLookaheadItem {
  id: string;
  title: string;
  projectName: string | null;
  date: string;
  kind: OperationsLookaheadKind;
  itemType?: string | null;
  trade?: string | null;
  status?: string | null;
  isOverdue: boolean;
  isCriticalPath: boolean;
  href: string;
}

export interface OperationsLookaheadConflict {
  id: string;
  title: string;
  detail: string;
  date: string;
  tone: "warning" | "destructive";
  projectCount: number;
}

export interface OperationsLookaheadDay {
  key: string;
  label: string;
  date: string;
  isToday: boolean;
  items: OperationsLookaheadItem[];
  conflicts: OperationsLookaheadConflict[];
}

export interface OperationsLookahead {
  windowStart: string;
  windowEnd: string;
  totalItems: number;
  overdueCount: number;
  conflictCount: number;
  heavyDays: number;
  days: OperationsLookaheadDay[];
}

export interface BudgetHealthItem {
  projectId: string;
  projectName: string;
  budgetCents: number;
  actualCents: number;
  /** actual - budget; positive when over budget. */
  overageCents: number;
  percentSpent: number;
  status: "over" | "warning";
  href: string;
}

export interface BudgetHealth {
  /** Sum of overruns across jobs that are over budget. */
  overBudgetCents: number;
  jobsOver: number;
  jobsApproaching: number;
  jobsTracked: number;
  jobsNoBudget: number;
  /** Portfolio actual / budget across tracked jobs, as a percent. */
  percentSpent: number;
  items: BudgetHealthItem[];
}

/**
 * The shape of the control tower desk. Produced by the band loaders below
 * rather than by any single call — component props reference slices of this
 * (`ControlTowerData["financials"]` and friends).
 */
export interface ControlTowerData {
  portfolioHealth: PortfolioHealth;
  projects: {
    byStatus: Record<string, number>;
  };
  tasks: {
    total: number;
    dueThisWeek: number;
    overdue: number;
    byStatus: Record<string, number>;
  };
  financials: {
    totalInvoiced: number;
    totalCollected: number;
    totalOverdue: number;
    outstandingAR: number;
    readyToInvoiceCents: number;
    overdueInvoices: OverdueInvoiceItem[];
    revenueSeries: Array<{
      key: string;
      month: string;
      revenueCents: number;
    }>;
    arAging: {
      current: number;
      oneToThirty: number;
      thirtyOneToSixty: number;
      sixtyOneToNinety: number;
      overNinety: number;
      noDueDate: number;
    };
  };
  openItems: {
    rfis: number;
    submittals: number;
    changeOrders: number;
    punchItems: number;
  };
  dueItems: {
    tasks: DueWorkItem[];
    scheduleItems: DueWorkItem[];
  };
  operationsLookahead: OperationsLookahead;
  budgetHealth: BudgetHealth;
  schedule: {
    totalItems: number;
    completedItems: number;
    criticalPathItems: number;
    atRiskItems: number;
    behindItems: number;
  };
}

function monthLabel(key: string): string {
  const [year, month] = key.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString("en-US", {
    month: "short",
  });
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addLocalDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function parseLocalDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const [datePart] = value.split("T");
  const parts = datePart.split("-").map(Number);
  if (parts.length !== 3 || parts.some((part) => Number.isNaN(part))) {
    const fallback = new Date(value);
    return Number.isNaN(fallback.getTime()) ? null : startOfLocalDay(fallback);
  }
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

function dateKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function formatDayLabel(date: Date, today: Date): string {
  const diffDays = Math.round((date.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function humanizeToken(value: string | null | undefined): string {
  if (!value) return "";
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

// Shape returned by the dashboard_invoice_rollup DB function; keys mirror the
// jsonb the SQL builds.
type InvoiceRollupPayload = {
  total_invoiced: number;
  total_collected: number;
  total_overdue: number;
  revenue_series: Array<{ key: string; revenue_cents: number }> | null;
  ar_aging: {
    current: number;
    no_due_date: number;
    one_to_thirty: number;
    thirty_one_to_sixty: number;
    sixty_one_to_ninety: number;
    over_ninety: number;
  };
};

type BudgetRollupRow = {
  project_id: string;
  budget_cents: number;
  actual_cents: number;
};

// --- Control tower bands ---
//
// This desk used to be a single `getControlTowerData()` await: 16 parallel
// queries plus a 17th (`dashboard_budget_rollup`) that could not start until the
// other 16 had landed, because it needs the active project ids. TTFB was the
// slowest query in the whole set and nothing painted until every one finished.
//
// It is now cached slices plus the bands composed from them. Each band is
// awaited inside its own Suspense boundary, so the shell paints immediately and
// bands land on their own clocks; `cache()` keeps the shared slices to exactly
// one query per request no matter how many bands read them.

type ControlTowerContext = {
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"];
  orgId: string;
  excludedProjectIds: string[];
  /** Keep rows with no project (org-level invoices, unassigned costs); drop only
   *  rows belonging to an excluded project. */
  keep: (projectId: string | null | undefined) => boolean;
  /** One clock for the whole request, so bands can't disagree about "overdue". */
  now: Date;
  weekFromNow: Date;
};

const getControlTowerContext = cache(async (orgId?: string): Promise<ControlTowerContext> => {
  const context = await requireOrgContext(orgId);
  const { supabase, orgId: resolvedOrgId } = context;
  // Projects flagged out of reporting (test / friends-and-family jobs) are
  // dropped from every rollup below so they don't skew the numbers.
  const excludedProjectIds = await getReportingExcludedProjectIds(supabase, resolvedOrgId);
  const excludedSet = new Set(excludedProjectIds);
  const now = new Date();

  return {
    supabase,
    orgId: resolvedOrgId,
    excludedProjectIds,
    keep: (projectId) => !projectId || !excludedSet.has(projectId),
    now,
    weekFromNow: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
  };
});

const getProjectsSlice = cache(async (orgId?: string) => {
  const ctx = await getControlTowerContext(orgId);
  const { data } = await ctx.supabase
    .from("projects")
    .select("id, name, status, start_date, end_date, total_value")
    .eq("org_id", ctx.orgId);

  const projects = (data ?? []).filter((p) => ctx.keep(p.id));
  const projectsByStatus: Record<string, number> = {};
  for (const p of projects) {
    projectsByStatus[p.status] = (projectsByStatus[p.status] ?? 0) + 1;
  }
  const activeProjects = projects.filter((p) => ["active", "on_hold"].includes(p.status));

  return {
    projects,
    projectsByStatus,
    activeProjects,
    activeProjectIds: activeProjects.map((p) => p.id),
    activeProjectSet: new Set(activeProjects.map((p) => p.id)),
  };
});

const getTasksSlice = cache(async (orgId?: string) => {
  const ctx = await getControlTowerContext(orgId);
  // Fetched rows exclude 'done' — that is the unbounded part; the done count
  // comes from a head count so byStatus/total stay exact.
  const [tasksResult, tasksDoneResult] = await Promise.all([
    ctx.supabase
      .from("tasks")
      .select("id, status, due_date, title, project_id, project:projects(name)")
      .eq("org_id", ctx.orgId)
      .neq("status", "done"),
    applyReportingExclusion(
      ctx.supabase
        .from("tasks")
        .select("id", { count: "exact", head: true })
        .eq("org_id", ctx.orgId)
        .eq("status", "done"),
      ctx.excludedProjectIds,
    ),
  ]);

  const tasks = (tasksResult.data ?? []).filter((t) =>
    ctx.keep((t as { project_id?: string | null }).project_id),
  );
  const doneTasksCount = tasksDoneResult.count ?? 0;

  const tasksByStatus: Record<string, number> = {};
  let tasksDueThisWeek = 0;
  let tasksOverdue = 0;
  for (const t of tasks) {
    tasksByStatus[t.status] = (tasksByStatus[t.status] ?? 0) + 1;
    if (t.due_date) {
      const due = new Date(t.due_date);
      if (due < ctx.now) tasksOverdue++;
      if (due >= ctx.now && due <= ctx.weekFromNow) tasksDueThisWeek++;
    }
  }
  if (doneTasksCount > 0) {
    tasksByStatus["done"] = doneTasksCount;
  }

  return { tasks, doneTasksCount, tasksByStatus, tasksDueThisWeek, tasksOverdue };
});

const getScheduleSlice = cache(async (orgId?: string) => {
  const ctx = await getControlTowerContext(orgId);
  // Fetched rows exclude completed/cancelled; completed and critical-path
  // counts come from head counts.
  const [scheduleResult, scheduleCompletedResult, scheduleCriticalResult] = await Promise.all([
    ctx.supabase
      .from("schedule_items")
      .select("id, project_id, status, is_critical_path, progress, start_date, end_date, name, item_type, trade, assigned_to, phase, project:projects(name)")
      .eq("org_id", ctx.orgId)
      .not("status", "in", "(cancelled,completed)"),
    applyReportingExclusion(
      ctx.supabase
        .from("schedule_items")
        .select("id", { count: "exact", head: true })
        .eq("org_id", ctx.orgId)
        .eq("status", "completed"),
      ctx.excludedProjectIds,
    ),
    applyReportingExclusion(
      ctx.supabase
        .from("schedule_items")
        .select("id", { count: "exact", head: true })
        .eq("org_id", ctx.orgId)
        .neq("status", "cancelled")
        .eq("is_critical_path", true),
      ctx.excludedProjectIds,
    ),
  ]);

  const scheduleItems = (scheduleResult.data ?? []).filter((s) =>
    ctx.keep((s as { project_id?: string | null }).project_id),
  );

  let atRiskItems = 0;
  let behindItems = 0;
  for (const s of scheduleItems) {
    if (s.status === "at_risk") atRiskItems++;
    if (s.status === "blocked") behindItems++;
  }

  return {
    scheduleItems,
    completedItems: scheduleCompletedResult.count ?? 0,
    criticalPathItems: scheduleCriticalResult.count ?? 0,
    atRiskItems,
    behindItems,
  };
});

export interface ControlTowerMoneyBand {
  financials: ControlTowerData["financials"];
  budgetHealth: BudgetHealth;
  unpaidApprovedBillsCents: number;
}

/**
 * Invoice totals/series/aging and per-project budget actuals are aggregated in
 * SQL (`dashboard_invoice_rollup` / `dashboard_budget_rollup`) — invoice and
 * job-cost history grow without bound, so only aggregates cross the wire.
 */
export const getControlTowerMoneyBand = cache(async (orgId?: string): Promise<ControlTowerMoneyBand> => {
  const ctx = await getControlTowerContext(orgId);
  const todayKeyUtc = ctx.now.toISOString().slice(0, 10);

  const [
    projectsSlice,
    invoiceRollupResult,
    overdueInvoiceCandidatesResult,
    vendorBillsResult,
    billableCostsResult,
  ] = await Promise.all([
    getProjectsSlice(orgId),
    ctx.supabase.rpc("dashboard_invoice_rollup", {
      p_org_id: ctx.orgId,
      p_excluded_project_ids: ctx.excludedProjectIds,
    }),
    ctx.supabase
      .from("invoices")
      .select(
        "id, status, total_cents, balance_due_cents, due_date, invoice_number, project_id, project:projects(name)",
      )
      .eq("org_id", ctx.orgId)
      .neq("status", "void")
      .gt("balance_due_cents", 0)
      .or(`status.eq.overdue,due_date.lte.${todayKeyUtc}`)
      .order("due_date", { ascending: true, nullsFirst: false })
      .limit(24),
    ctx.supabase
      .from("vendor_bills")
      .select("id, project_id, status, amount_cents, balance_due_cents")
      .eq("org_id", ctx.orgId)
      .in("status", ["approved", "partial"]),
    ctx.supabase
      .from("billable_costs")
      .select("id, project_id, billable_cents")
      .eq("org_id", ctx.orgId)
      .eq("status", "open")
      .eq("is_billable", true),
  ]);

  // Budget health — latest budget vs posted job-cost actuals, for active jobs
  // only. This is the one genuinely sequential step: it needs the active
  // project ids. It now waits on the projects slice alone rather than on every
  // other query the desk makes.
  const budgetRollupRows: BudgetRollupRow[] =
    projectsSlice.activeProjectIds.length === 0
      ? []
      : (
          await ctx.supabase.rpc("dashboard_budget_rollup", {
            p_org_id: ctx.orgId,
            p_project_ids: projectsSlice.activeProjectIds,
          })
        ).data ?? [];

  const emptyInvoiceRollup: InvoiceRollupPayload = {
    total_invoiced: 0,
    total_collected: 0,
    total_overdue: 0,
    revenue_series: [],
    ar_aging: {
      current: 0,
      no_due_date: 0,
      one_to_thirty: 0,
      thirty_one_to_sixty: 0,
      sixty_one_to_ninety: 0,
      over_ninety: 0,
    },
  };
  const invoiceRollup: InvoiceRollupPayload = invoiceRollupResult.data ?? emptyInvoiceRollup;
  const overdueInvoiceCandidates = (overdueInvoiceCandidatesResult.data ?? []).filter((i) =>
    ctx.keep((i as { project_id?: string | null }).project_id),
  );
  const vendorBills = (vendorBillsResult.data ?? []).filter((b) =>
    ctx.keep((b as { project_id?: string | null }).project_id),
  );
  const billableCosts = (billableCostsResult.data ?? []).filter((c) =>
    ctx.keep((c as { project_id?: string | null }).project_id),
  );

  const budgetByProject = new Map<string, number>();
  const actualByProject = new Map<string, number>();
  for (const row of budgetRollupRows) {
    budgetByProject.set(row.project_id, row.budget_cents);
    actualByProject.set(row.project_id, row.actual_cents);
  }

  const budgetHealthItems: BudgetHealthItem[] = [];
  let overBudgetCents = 0;
  let jobsOver = 0;
  let jobsApproaching = 0;
  let jobsTracked = 0;
  let jobsNoBudget = 0;
  let trackedBudgetTotal = 0;
  let trackedActualTotal = 0;

  for (const project of projectsSlice.activeProjects) {
    const budget = budgetByProject.get(project.id) ?? 0;
    const actual = actualByProject.get(project.id) ?? 0;
    if (budget <= 0) {
      jobsNoBudget += 1;
      continue;
    }
    jobsTracked += 1;
    trackedBudgetTotal += budget;
    trackedActualTotal += actual;
    const percentSpent = Math.round((actual / budget) * 100);
    if (percentSpent < 90) continue;
    const overage = actual - budget;
    if (percentSpent >= 100) {
      jobsOver += 1;
      overBudgetCents += Math.max(0, overage);
    } else {
      jobsApproaching += 1;
    }
    budgetHealthItems.push({
      projectId: project.id,
      projectName: project.name,
      budgetCents: budget,
      actualCents: actual,
      overageCents: overage,
      percentSpent,
      status: percentSpent >= 100 ? "over" : "warning",
      href: `/projects/${project.id}/financials/budget`,
    });
  }
  budgetHealthItems.sort((a, b) => b.percentSpent - a.percentSpent);

  const budgetHealth: BudgetHealth = {
    overBudgetCents,
    jobsOver,
    jobsApproaching,
    jobsTracked,
    jobsNoBudget,
    percentSpent:
      trackedBudgetTotal > 0
        ? Math.round((trackedActualTotal / trackedBudgetTotal) * 100)
        : 0,
    items: budgetHealthItems.slice(0, 10),
  };

  const totalInvoiced = invoiceRollup.total_invoiced;
  const totalCollected = invoiceRollup.total_collected;
  const totalOverdue = invoiceRollup.total_overdue;
  const revenueSeries = (invoiceRollup.revenue_series ?? []).map((point) => ({
    key: point.key,
    month: monthLabel(point.key),
    revenueCents: point.revenue_cents,
  }));

  // Vendor bills — unpaid approved
  let unpaidApprovedBillsCents = 0;
  for (const bill of vendorBills) {
    unpaidApprovedBillsCents += bill.balance_due_cents ?? bill.amount_cents ?? 0;
  }

  // Approved costs earned but not yet invoiced (ready to bill)
  let readyToInvoiceCents = 0;
  for (const cost of billableCosts) {
    readyToInvoiceCents += (cost as { billable_cents?: number | null }).billable_cents ?? 0;
  }

  const daysBetween = (from: Date, to: Date) =>
    Math.max(0, Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)));

  // Candidates arrive pre-filtered (positive balance, overdue status or past
  // due) and pre-sorted oldest-due first, capped at 24 before the excluded-
  // project filter trims them to the final 8.
  const overdueInvoices: OverdueInvoiceItem[] = overdueInvoiceCandidates
    .map((inv) => {
      const i = inv as typeof inv & {
        invoice_number?: string | null;
        project_id?: string | null;
        project?: { name?: string | null } | null;
      };
      const projectId = i.project_id ?? null;
      return {
        id: inv.id,
        number: i.invoice_number ?? null,
        projectName: i.project?.name ?? null,
        balanceCents: inv.balance_due_cents ?? 0,
        dueDate: inv.due_date ?? null,
        daysOverdue: inv.due_date ? daysBetween(new Date(inv.due_date), ctx.now) : 0,
        href: projectId
          ? `/projects/${projectId}/financials/receivables?invoice=${inv.id}`
          : "/invoices",
      };
    })
    .sort((a, b) => b.daysOverdue - a.daysOverdue)
    .slice(0, 8);

  return {
    financials: {
      totalInvoiced,
      totalCollected,
      totalOverdue,
      outstandingAR: totalInvoiced - totalCollected,
      readyToInvoiceCents,
      overdueInvoices,
      revenueSeries,
      arAging: {
        current: invoiceRollup.ar_aging.current,
        oneToThirty: invoiceRollup.ar_aging.one_to_thirty,
        thirtyOneToSixty: invoiceRollup.ar_aging.thirty_one_to_sixty,
        sixtyOneToNinety: invoiceRollup.ar_aging.sixty_one_to_ninety,
        overNinety: invoiceRollup.ar_aging.over_ninety,
        noDueDate: invoiceRollup.ar_aging.no_due_date,
      },
    },
    budgetHealth,
    unpaidApprovedBillsCents,
  };
});

/** Open-item head counts. No row ever crosses the wire — the fastest band. */
export const getControlTowerExceptionsBand = cache(async (orgId?: string) => {
  const ctx = await getControlTowerContext(orgId);
  const [rfisResult, submittalsResult, changeOrdersResult, punchResult] = await Promise.all([
    ctx.supabase
      .from("rfis")
      .select("id", { count: "exact", head: true })
      .eq("org_id", ctx.orgId)
      .in("status", ["open", "pending", "in_review"]),
    ctx.supabase
      .from("submittals")
      .select("id", { count: "exact", head: true })
      .eq("org_id", ctx.orgId)
      .in("status", ["open", "pending", "in_review", "submitted"]),
    ctx.supabase
      .from("change_orders")
      .select("id", { count: "exact", head: true })
      .eq("org_id", ctx.orgId)
      .eq("status", "pending"),
    ctx.supabase
      .from("punch_items")
      .select("id", { count: "exact", head: true })
      .eq("org_id", ctx.orgId)
      .in("status", ["open", "in_progress"]),
  ]);

  const openItems: ControlTowerData["openItems"] = {
    rfis: rfisResult.count ?? 0,
    submittals: submittalsResult.count ?? 0,
    changeOrders: changeOrdersResult.count ?? 0,
    punchItems: punchResult.count ?? 0,
  };
  return { openItems };
});

export interface ControlTowerScheduleBand {
  schedule: ControlTowerData["schedule"];
  operationsLookahead: OperationsLookahead;
  dueItems: ControlTowerData["dueItems"];
}

export const getControlTowerScheduleBand = cache(async (orgId?: string): Promise<ControlTowerScheduleBand> => {
  const ctx = await getControlTowerContext(orgId);
  const [projectsSlice, tasksSlice, scheduleSlice] = await Promise.all([
    getProjectsSlice(orgId),
    getTasksSlice(orgId),
    getScheduleSlice(orgId),
  ]);
  const { tasks } = tasksSlice;
  const { scheduleItems } = scheduleSlice;
  const { activeProjectSet } = projectsSlice;
  const { now, weekFromNow } = ctx;

  const dueTasks: DueWorkItem[] = tasks
    .filter((t) => {
      if (!t.due_date) return false;
      return new Date(t.due_date) <= weekFromNow;
    })
    .map((t) => {
      const row = t as typeof t & {
        title?: string | null;
        project_id?: string | null;
        project?: { name?: string | null } | null;
      };
      return {
        id: t.id,
        title: row.title ?? "Task",
        projectName: row.project?.name ?? null,
        date: t.due_date ?? null,
        isOverdue: !!t.due_date && new Date(t.due_date) < now,
        isCriticalPath: false,
        href: row.project_id ? `/projects/${row.project_id}/tasks` : "/tasks",
      };
    })
    .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""))
    .slice(0, 8);

  const dueScheduleItems: DueWorkItem[] = scheduleItems
    .filter((s) => {
      const end = (s as { end_date?: string | null }).end_date;
      return !!end && new Date(end) <= weekFromNow;
    })
    .map((s) => {
      const row = s as typeof s & {
        name?: string | null;
        end_date?: string | null;
        is_critical_path?: boolean | null;
        project_id?: string | null;
        project?: { name?: string | null } | null;
      };
      const end = row.end_date ?? null;
      return {
        id: s.id,
        title: row.name ?? "Schedule item",
        projectName: row.project?.name ?? null,
        date: end,
        isOverdue: !!end && new Date(end) < now,
        isCriticalPath: !!row.is_critical_path,
        href: row.project_id ? `/projects/${row.project_id}/schedule` : "/schedule",
      };
    })
    .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""))
    .slice(0, 8);

  const today = startOfLocalDay(now);
  const lookaheadEnd = addLocalDays(today, 6);
  const lookaheadDays = Array.from({ length: 7 }, (_, index) => {
    const date = addLocalDays(today, index);
    const key = dateKey(date);
    return {
      key,
      label: formatDayLabel(date, today),
      date: key,
      isToday: index === 0,
      items: [] as OperationsLookaheadItem[],
      conflicts: [] as OperationsLookaheadConflict[],
    };
  });
  const lookaheadByDay = new Map(lookaheadDays.map((day) => [day.key, day]));

  const addLookaheadItem = (item: OperationsLookaheadItem) => {
    const day = lookaheadByDay.get(item.date);
    if (!day) return;
    day.items.push(item);
  };

  const isInLookahead = (date: Date | null) =>
    !!date && date >= today && date <= lookaheadEnd;

  const overdueScheduleItems = scheduleItems.filter((s) => {
    const end = parseLocalDate((s as { end_date?: string | null }).end_date);
    return !!end && end < today;
  }).length;

  for (const s of scheduleItems) {
    if (!activeProjectSet.has((s as { project_id?: string | null }).project_id ?? "")) continue;

    const row = s as typeof s & {
      project_id?: string | null;
      name?: string | null;
      start_date?: string | null;
      end_date?: string | null;
      item_type?: string | null;
      trade?: string | null;
      is_critical_path?: boolean | null;
      project?: { name?: string | null } | null;
    };
    const projectName = row.project?.name ?? null;
    const start = parseLocalDate(row.start_date);
    const end = parseLocalDate(row.end_date);
    const title = row.name ?? "Schedule item";
    const href = row.project_id ? `/projects/${row.project_id}/schedule` : "/schedule";

    if (isInLookahead(start)) {
      addLookaheadItem({
        id: `${s.id}:start`,
        title,
        projectName,
        date: dateKey(start!),
        kind: "schedule_start",
        itemType: row.item_type ?? null,
        trade: row.trade ?? null,
        status: s.status,
        isOverdue: false,
        isCriticalPath: !!row.is_critical_path,
        href,
      });
    }

    if (isInLookahead(end) && (!start || dateKey(start) !== dateKey(end!))) {
      addLookaheadItem({
        id: `${s.id}:finish`,
        title,
        projectName,
        date: dateKey(end!),
        kind: "schedule_finish",
        itemType: row.item_type ?? null,
        trade: row.trade ?? null,
        status: s.status,
        isOverdue: false,
        isCriticalPath: !!row.is_critical_path,
        href,
      });
    }
  }

  const overdueTasksForLookahead = tasks.filter((t) => {
    if (!t.due_date) return false;
    const due = parseLocalDate(t.due_date);
    return !!due && due < today;
  }).length;

  for (const t of tasks) {
    if (!t.due_date) continue;
    const due = parseLocalDate(t.due_date);
    if (!isInLookahead(due)) continue;
    const row = t as typeof t & {
      title?: string | null;
      project_id?: string | null;
      project?: { name?: string | null } | null;
    };
    if (row.project_id && !activeProjectSet.has(row.project_id)) continue;
    addLookaheadItem({
      id: `${t.id}:task`,
      title: row.title ?? "Task",
      projectName: row.project?.name ?? null,
      date: dateKey(due!),
      kind: "task_due",
      status: t.status,
      isOverdue: false,
      isCriticalPath: false,
      href: row.project_id ? `/projects/${row.project_id}/tasks` : "/tasks",
    });
  }

  const scheduledByDay = new Map<string, Array<{
    id: string;
    projectId: string;
    projectName: string | null;
    trade: string | null;
    assignedTo: string | null;
  }>>();

  for (const s of scheduleItems) {
    const row = s as typeof s & {
      project_id?: string | null;
      start_date?: string | null;
      end_date?: string | null;
      trade?: string | null;
      assigned_to?: string | null;
      project?: { name?: string | null } | null;
    };
    if (!row.project_id || !activeProjectSet.has(row.project_id)) continue;
    const start = parseLocalDate(row.start_date);
    const end = parseLocalDate(row.end_date) ?? start;
    if (!start || !end || end < today || start > lookaheadEnd) continue;

    for (const day of lookaheadDays) {
      const dayDate = parseLocalDate(day.date);
      if (!dayDate || dayDate < start || dayDate > end) continue;
      const rows = scheduledByDay.get(day.key) ?? [];
      rows.push({
        id: s.id,
        projectId: row.project_id,
        projectName: row.project?.name ?? null,
        trade: row.trade ?? null,
        assignedTo: row.assigned_to ?? null,
      });
      scheduledByDay.set(day.key, rows);
    }
  }

  for (const day of lookaheadDays) {
    const scheduled = scheduledByDay.get(day.key) ?? [];
    if (scheduled.length >= 8) {
      day.conflicts.push({
        id: `${day.key}:heavy`,
        title: "Heavy field day",
        detail: `${scheduled.length} active schedule items across ${new Set(scheduled.map((item) => item.projectId)).size} projects`,
        date: day.key,
        tone: scheduled.length >= 12 ? "destructive" : "warning",
        projectCount: new Set(scheduled.map((item) => item.projectId)).size,
      });
    }

    const byTrade = new Map<string, typeof scheduled>();
    for (const item of scheduled) {
      const trade = item.trade?.trim();
      if (!trade) continue;
      const rows = byTrade.get(trade) ?? [];
      rows.push(item);
      byTrade.set(trade, rows);
    }
    for (const [trade, rows] of byTrade) {
      const projectCount = new Set(rows.map((item) => item.projectId)).size;
      if (projectCount < 2) continue;
      day.conflicts.push({
        id: `${day.key}:trade:${trade}`,
        title: `${humanizeToken(trade)} overlap`,
        detail: `${projectCount} projects need this trade on the same day`,
        date: day.key,
        tone: projectCount >= 3 ? "destructive" : "warning",
        projectCount,
      });
    }

    const byAssignee = new Map<string, typeof scheduled>();
    for (const item of scheduled) {
      const assignedTo = item.assignedTo?.trim();
      if (!assignedTo) continue;
      const rows = byAssignee.get(assignedTo) ?? [];
      rows.push(item);
      byAssignee.set(assignedTo, rows);
    }
    for (const [assignedTo, rows] of byAssignee) {
      const projectCount = new Set(rows.map((item) => item.projectId)).size;
      if (projectCount < 2) continue;
      day.conflicts.push({
        id: `${day.key}:assignee:${assignedTo}`,
        title: "Assignee overlap",
        detail: `${projectCount} projects have work assigned to the same person`,
        date: day.key,
        tone: "destructive",
        projectCount,
      });
    }
  }

  for (const day of lookaheadDays) {
    day.items.sort((a, b) => {
      const priority = (item: OperationsLookaheadItem) =>
        item.isCriticalPath ? 0 : item.kind === "schedule_finish" ? 1 : item.kind === "schedule_start" ? 2 : 3;
      return priority(a) - priority(b) || a.title.localeCompare(b.title);
    });
    day.conflicts.sort((a, b) => {
      const toneWeight = (tone: OperationsLookaheadConflict["tone"]) => tone === "destructive" ? 0 : 1;
      return toneWeight(a.tone) - toneWeight(b.tone) || b.projectCount - a.projectCount;
    });
  }

  const operationsLookahead: OperationsLookahead = {
    windowStart: dateKey(today),
    windowEnd: dateKey(lookaheadEnd),
    totalItems: lookaheadDays.reduce((sum, day) => sum + day.items.length, 0),
    overdueCount: overdueScheduleItems + overdueTasksForLookahead,
    conflictCount: lookaheadDays.reduce((sum, day) => sum + day.conflicts.length, 0),
    heavyDays: lookaheadDays.filter((day) => day.conflicts.some((conflict) => conflict.id.endsWith(":heavy"))).length,
    days: lookaheadDays,
  };

  return {
    schedule: {
      totalItems: scheduleItems.length + scheduleSlice.completedItems,
      completedItems: scheduleSlice.completedItems,
      criticalPathItems: scheduleSlice.criticalPathItems,
      atRiskItems: scheduleSlice.atRiskItems,
      behindItems: scheduleSlice.behindItems,
    },
    operationsLookahead,
    dueItems: {
      tasks: dueTasks,
      scheduleItems: dueScheduleItems,
    },
  };
});

/**
 * The KPI strip's headline numbers. Genuinely cross-band — it reads money,
 * exceptions and the shared slices — so it is composed from the cached bands
 * rather than issuing its own queries.
 */
export const getControlTowerPortfolioHealth = cache(async (orgId?: string): Promise<PortfolioHealth> => {
  const ctx = await getControlTowerContext(orgId);
  const [projectsSlice, tasksSlice, scheduleSlice, money, exceptions] = await Promise.all([
    getProjectsSlice(orgId),
    getTasksSlice(orgId),
    getScheduleSlice(orgId),
    getControlTowerMoneyBand(orgId),
    getControlTowerExceptionsBand(orgId),
  ]);

  const projectsAtRisk =
    scheduleSlice.atRiskItems > 0 || scheduleSlice.behindItems > 0
      ? new Set(
          scheduleSlice.scheduleItems
            .filter((s) => s.status === "at_risk" || s.status === "blocked")
            .map((s) => (s as { project_id?: string | null }).project_id)
            .filter(Boolean),
        ).size
      : 0;

  const totalBlockers =
    exceptions.openItems.rfis + exceptions.openItems.changeOrders + tasksSlice.tasksOverdue;

  const itemsDueNext7Days =
    tasksSlice.tasksDueThisWeek +
    scheduleSlice.scheduleItems.filter((s) => {
      const end = (s as { end_date?: string | null }).end_date;
      if (!end) return false;
      const endDate = new Date(end);
      return endDate >= ctx.now && endDate <= ctx.weekFromNow;
    }).length;

  return {
    activeProjects: projectsSlice.activeProjects.length,
    projectsAtRisk,
    cashRiskCents: money.financials.totalOverdue + money.unpaidApprovedBillsCents,
    overdueARCents: money.financials.totalOverdue,
    unpaidApprovedBillsCents: money.unpaidApprovedBillsCents,
    totalBlockers,
    itemsDueNext7Days,
  };
});

/** Project status mix + task rollup for the KPI strip's sheets. */
export const getControlTowerProjectsBand = cache(async (orgId?: string) => {
  const [projectsSlice, tasksSlice] = await Promise.all([
    getProjectsSlice(orgId),
    getTasksSlice(orgId),
  ]);
  return {
    projectsByStatus: projectsSlice.projectsByStatus,
    tasks: {
      total: tasksSlice.tasks.length + tasksSlice.doneTasksCount,
      dueThisWeek: tasksSlice.tasksDueThisWeek,
      overdue: tasksSlice.tasksOverdue,
      byStatus: tasksSlice.tasksByStatus,
    },
  };
});

// --- Lifecycle Stage Board ---

export interface LifecycleItem {
  id: string;
  label: string;
  detail: string;
  entity: string;
  entityId: string;
  projectName?: string;
  severity: "info" | "warn" | "critical";
  href?: string;
}

export interface LifecycleStage {
  key: string;
  label: string;
  items: LifecycleItem[];
}

export async function getLifecycleBoard(
  orgId?: string,
): Promise<LifecycleStage[]> {
  const context = await requireOrgContext(orgId);
  const { supabase, orgId: resolvedOrgId } = context;

  const now = new Date();

  const [
    opportunitiesRes,
    proposalsRes,
    projectsRes,
    contractsRes,
    commitmentsRes,
    rfisRes,
    submittalsRes,
    changeOrdersRes,
    tasksRes,
    scheduleRes,
    invoicesRes,
    vendorBillsRes,
    punchRes,
    closeoutItemsRes,
    warrantyRes,
  ] = await Promise.all([
    // Precon: stalled opportunities
    supabase
      .from("opportunities")
      .select("id, name, status, updated_at")
      .eq("org_id", resolvedOrgId)
      .in("status", [
        "new",
        "contacted",
        "qualified",
        "estimating",
        "proposed",
      ]),
    // Precon: proposals not accepted
    supabase
      .from("proposals")
      .select("id, opportunity_id, status, created_at")
      .eq("org_id", resolvedOrgId)
      .in("status", ["draft", "sent"]),
    // All non-terminal projects
    supabase
      .from("projects")
      .select("id, name, status, start_date, end_date")
      .eq("org_id", resolvedOrgId)
      .in("status", ["active", "on_hold", "completed"]),
    // Setup: unsigned contracts
    supabase
      .from("contracts")
      .select("id, project_id, status, total_cents")
      .eq("org_id", resolvedOrgId)
      .in("status", ["draft"]),
    // Setup: draft commitments
    supabase
      .from("commitments")
      .select("id, project_id, title, status")
      .eq("org_id", resolvedOrgId)
      .eq("status", "draft"),
    // Execution: open/overdue RFIs
    supabase
      .from("rfis")
      .select("id, project_id, subject, status, due_date, priority")
      .eq("org_id", resolvedOrgId)
      .in("status", ["open", "pending"]),
    // Execution: pending submittals
    supabase
      .from("submittals")
      .select("id, project_id, title, status, due_date")
      .eq("org_id", resolvedOrgId)
      .in("status", ["pending", "submitted", "revise_resubmit"]),
    // Commercials: pending change orders
    supabase
      .from("change_orders")
      .select("id, project_id, title, status, total_cents")
      .eq("org_id", resolvedOrgId)
      .eq("status", "pending"),
    // Execution: blocked/overdue tasks
    supabase
      .from("tasks")
      .select("id, project_id, title, status, due_date")
      .eq("org_id", resolvedOrgId)
      .in("status", ["todo", "in_progress"])
      .not("due_date", "is", null),
    // Execution: at-risk schedule items
    supabase
      .from("schedule_items")
      .select("id, project_id, title, status, is_critical_path, end_date")
      .eq("org_id", resolvedOrgId)
      .in("status", ["at_risk", "blocked"]),
    // Commercials: overdue invoices
    supabase
      .from("invoices")
      .select(
        "id, project_id, status, total_cents, balance_due_cents, due_date, invoice_number",
      )
      .eq("org_id", resolvedOrgId)
      .in("status", ["sent", "partial", "overdue"]),
    // Commercials: bills awaiting approval
    supabase
      .from("vendor_bills")
      .select(
        "id, project_id, status, amount_cents, balance_due_cents, bill_number",
      )
      .eq("org_id", resolvedOrgId)
      .eq("status", "pending"),
    // Closeout: open punch items
    supabase
      .from("punch_items")
      .select("id, project_id, title, status, severity")
      .eq("org_id", resolvedOrgId)
      .in("status", ["open", "in_progress"]),
    // Closeout: incomplete items
    supabase
      .from("closeout_items")
      .select("id, project_id, title, status")
      .eq("org_id", resolvedOrgId)
      .in("status", ["missing"]),
    // Closeout: open warranty requests
    supabase
      .from("warranty_requests")
      .select("id, project_id, title, status, priority")
      .eq("org_id", resolvedOrgId)
      .in("status", ["open", "in_progress"]),
  ]);

  // Build project name map
  const projects = projectsRes.data ?? [];
  const projectMap = new Map(projects.map((p) => [p.id, p.name]));
  const pName = (pid?: string) => (pid ? projectMap.get(pid) : undefined);

  // --- PRECON ---
  const preconItems: LifecycleItem[] = [];

  // Stalled opportunities (no update in 7+ days)
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  for (const opp of opportunitiesRes.data ?? []) {
    const stale = opp.updated_at && new Date(opp.updated_at) < sevenDaysAgo;
    if (stale) {
      preconItems.push({
        id: `opp-${opp.id}`,
        label: opp.name,
        detail: `${opp.status} · no activity 7+ days`,
        entity: "opportunity",
        entityId: opp.id,
        severity: opp.status === "proposed" ? "warn" : "info",
        href: `/pipeline`,
      });
    }
  }

  // Unsigned proposals
  for (const prop of proposalsRes.data ?? []) {
    const opp = (opportunitiesRes.data ?? []).find(
      (o) => o.id === prop.opportunity_id,
    );
    preconItems.push({
      id: `prop-${prop.id}`,
      label: opp?.name ?? "Proposal",
      detail:
        prop.status === "draft" ? "Proposal not sent" : "Awaiting signature",
      entity: "proposal",
      entityId: prop.id,
      severity: prop.status === "sent" ? "warn" : "info",
    });
  }

  // --- SETUP / MOBILIZATION ---
  const setupItems: LifecycleItem[] = [];

  for (const c of contractsRes.data ?? []) {
    setupItems.push({
      id: `contract-${c.id}`,
      label: pName(c.project_id) ?? "Contract",
      detail: "Contract unsigned",
      entity: "contract",
      entityId: c.id,
      projectName: pName(c.project_id),
      severity: "warn",
      href: c.project_id ? `/projects/${c.project_id}` : undefined,
    });
  }

  for (const cm of commitmentsRes.data ?? []) {
    setupItems.push({
      id: `commit-${cm.id}`,
      label: cm.title,
      detail: "Commitment in draft",
      entity: "commitment",
      entityId: cm.id,
      projectName: pName(cm.project_id),
      severity: "info",
      href: cm.project_id
        ? `/projects/${cm.project_id}/commitments`
        : undefined,
    });
  }

  // --- EXECUTION ---
  const execItems: LifecycleItem[] = [];

  for (const rfi of rfisRes.data ?? []) {
    const overdue = rfi.due_date && new Date(rfi.due_date) < now;
    execItems.push({
      id: `rfi-${rfi.id}`,
      label: rfi.subject,
      detail: overdue ? "RFI overdue" : `RFI ${rfi.status}`,
      entity: "rfi",
      entityId: rfi.id,
      projectName: pName(rfi.project_id),
      severity: overdue
        ? "critical"
        : rfi.priority === "urgent"
          ? "critical"
          : "warn",
      href: rfi.project_id ? `/projects/${rfi.project_id}` : undefined,
    });
  }

  for (const sub of submittalsRes.data ?? []) {
    const overdue = sub.due_date && new Date(sub.due_date) < now;
    execItems.push({
      id: `sub-${sub.id}`,
      label: sub.title,
      detail: overdue
        ? "Submittal overdue"
        : sub.status === "revise_resubmit"
          ? "Revise & resubmit"
          : `Submittal ${sub.status}`,
      entity: "submittal",
      entityId: sub.id,
      projectName: pName(sub.project_id),
      severity:
        overdue || sub.status === "revise_resubmit" ? "critical" : "warn",
      href: sub.project_id ? `/projects/${sub.project_id}` : undefined,
    });
  }

  for (const si of scheduleRes.data ?? []) {
    execItems.push({
      id: `sched-${si.id}`,
      label: si.title ?? "Schedule item",
      detail:
        si.status === "blocked"
          ? "Blocked"
          : si.is_critical_path
            ? "Critical path at risk"
            : "At risk",
      entity: "schedule_item",
      entityId: si.id,
      projectName: pName(si.project_id),
      severity:
        si.status === "blocked" || si.is_critical_path ? "critical" : "warn",
      href: si.project_id ? `/projects/${si.project_id}` : undefined,
    });
  }

  // Overdue tasks
  for (const task of tasksRes.data ?? []) {
    if (task.due_date && new Date(task.due_date) < now) {
      execItems.push({
        id: `task-${task.id}`,
        label: task.title,
        detail: "Task overdue",
        entity: "task",
        entityId: task.id,
        projectName: pName(task.project_id),
        severity: "warn",
        href: `/tasks`,
      });
    }
  }

  // --- COMMERCIALS ---
  const commercialItems: LifecycleItem[] = [];

  for (const co of changeOrdersRes.data ?? []) {
    commercialItems.push({
      id: `co-${co.id}`,
      label: co.title,
      detail: `CO pending · ${formatCentsCurrency(co.total_cents ?? 0)}`,
      entity: "change_order",
      entityId: co.id,
      projectName: pName(co.project_id),
      severity: "warn",
      href: co.project_id ? `/projects/${co.project_id}` : undefined,
    });
  }

  for (const inv of invoicesRes.data ?? []) {
    const overdue =
      inv.due_date &&
      new Date(inv.due_date) < now &&
      (inv.balance_due_cents ?? 0) > 0;
    if (overdue) {
      commercialItems.push({
        id: `inv-${inv.id}`,
        label: `Invoice #${inv.invoice_number ?? "—"}`,
        detail: `${formatCentsCurrency(inv.balance_due_cents ?? 0)} overdue`,
        entity: "invoice",
        entityId: inv.id,
        projectName: pName(inv.project_id),
        severity: "critical",
        href: `/invoices`,
      });
    }
  }

  for (const bill of vendorBillsRes.data ?? []) {
    commercialItems.push({
      id: `bill-${bill.id}`,
      label: `Bill #${bill.bill_number ?? "—"}`,
      detail: `${formatCentsCurrency(bill.amount_cents ?? 0)} awaiting approval`,
      entity: "vendor_bill",
      entityId: bill.id,
      projectName: pName(bill.project_id),
      severity: "warn",
      href: bill.project_id
        ? `/projects/${bill.project_id}/payables`
        : undefined,
    });
  }

  // --- CLOSEOUT / WARRANTY ---
  const closeoutItems: LifecycleItem[] = [];

  for (const ci of closeoutItemsRes.data ?? []) {
    closeoutItems.push({
      id: `closeout-${ci.id}`,
      label: ci.title ?? "Closeout document",
      detail: "Missing document",
      entity: "closeout_item",
      entityId: ci.id,
      projectName: pName(ci.project_id),
      severity: "warn",
      href: ci.project_id ? `/projects/${ci.project_id}` : undefined,
    });
  }

  for (const pi of punchRes.data ?? []) {
    closeoutItems.push({
      id: `punch-${pi.id}`,
      label: pi.title,
      detail: `Punch ${pi.status}${pi.severity ? ` · ${pi.severity}` : ""}`,
      entity: "punch_item",
      entityId: pi.id,
      projectName: pName(pi.project_id),
      severity:
        pi.severity === "high" || pi.severity === "urgent"
          ? "critical"
          : "warn",
      href: pi.project_id ? `/projects/${pi.project_id}` : undefined,
    });
  }

  for (const wr of warrantyRes.data ?? []) {
    closeoutItems.push({
      id: `warranty-${wr.id}`,
      label: wr.title,
      detail: `Warranty ${wr.status}${wr.priority === "high" || wr.priority === "urgent" ? " · urgent" : ""}`,
      entity: "warranty",
      entityId: wr.id,
      projectName: pName(wr.project_id),
      severity:
        wr.priority === "high" || wr.priority === "urgent"
          ? "critical"
          : "warn",
      href: wr.project_id ? `/projects/${wr.project_id}` : undefined,
    });
  }

  return [
    { key: "precon", label: "Pre-Construction", items: preconItems },
    { key: "setup", label: "Setup & Mobilization", items: setupItems },
    { key: "execution", label: "Execution", items: execItems },
    { key: "commercials", label: "Commercials", items: commercialItems },
    { key: "closeout", label: "Closeout & Warranty", items: closeoutItems },
  ];
}

// --- Decision Queue ---

export type DecisionType =
  | "change_order"
  | "rfi"
  | "submittal"
  | "vendor_bill"
  | "proposal"
  | "punch_item";

export interface DecisionItem {
  id: string;
  type: DecisionType;
  typeLabel: string;
  title: string;
  projectName?: string;
  projectId?: string;
  createdAt: string;
  ageDays: number;
  impactCents?: number;
  impactDays?: number;
  impactLabel: string;
  severity: "low" | "medium" | "high";
  href: string;
  ctaLabel: string;
}

export async function getDecisionQueue(
  orgId?: string,
): Promise<DecisionItem[]> {
  const context = await requireOrgContext(orgId);
  const { supabase, orgId: resolvedOrgId } = context;

  const now = new Date();

  const [
    changeOrdersRes,
    rfisRes,
    submittalsRes,
    vendorBillsRes,
    punchRes,
    projectsRes,
  ] = await Promise.all([
    supabase
      .from("change_orders")
      .select(
        "id, project_id, title, status, total_cents, days_impact, created_at",
      )
      .eq("org_id", resolvedOrgId)
      .eq("status", "pending"),
    supabase
      .from("rfis")
      .select(
        "id, project_id, subject, status, due_date, priority, cost_impact_cents, schedule_impact_days, created_at",
      )
      .eq("org_id", resolvedOrgId)
      .in("status", ["open", "pending"]),
    supabase
      .from("submittals")
      .select(
        "id, project_id, title, status, due_date, lead_time_days, created_at",
      )
      .eq("org_id", resolvedOrgId)
      .in("status", ["pending", "submitted"]),
    supabase
      .from("vendor_bills")
      .select("id, project_id, bill_number, status, amount_cents, created_at")
      .eq("org_id", resolvedOrgId)
      .eq("status", "pending"),
    supabase
      .from("punch_items")
      .select("id, project_id, title, status, severity, created_at")
      .eq("org_id", resolvedOrgId)
      .eq("status", "open")
      .in("severity", ["high", "urgent"]),
    supabase.from("projects").select("id, name").eq("org_id", resolvedOrgId).eq("phase", "delivery"),
  ]);

  const projectMap = new Map(
    (projectsRes.data ?? []).map((p) => [p.id, p.name]),
  );
  // Items belonging to reporting-excluded projects are dropped from the queue.
  const excludedProjects = new Set(await getReportingExcludedProjectIds(supabase, resolvedOrgId));
  const pName = (pid?: string) => (pid ? projectMap.get(pid) : undefined);
  const daysSince = (dateStr: string) =>
    Math.max(
      0,
      Math.floor(
        (now.getTime() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24),
      ),
    );

  const items: DecisionItem[] = [];

  // Change orders pending approval
  for (const co of changeOrdersRes.data ?? []) {
    const age = daysSince(co.created_at);
    items.push({
      id: `co-${co.id}`,
      type: "change_order",
      typeLabel: "Change Order",
      title: co.title,
      projectName: pName(co.project_id),
      projectId: co.project_id,
      createdAt: co.created_at,
      ageDays: age,
      impactCents: co.total_cents ?? undefined,
      impactDays: co.days_impact ?? undefined,
      impactLabel: co.total_cents
        ? `${formatCentsCurrency(co.total_cents)}${co.days_impact ? ` · ${co.days_impact}d` : ""}`
        : co.days_impact
          ? `${co.days_impact} day impact`
          : "Pending review",
      severity:
        age > 7 || (co.total_cents ?? 0) > 1_000_000
          ? "high"
          : age > 3
            ? "medium"
            : "low",
      href: co.project_id ? `/projects/${co.project_id}` : "/change-orders",
      ctaLabel: "Approve / Reject",
    });
  }

  // RFIs awaiting response
  for (const rfi of rfisRes.data ?? []) {
    const age = daysSince(rfi.created_at);
    const overdue = rfi.due_date && new Date(rfi.due_date) < now;
    items.push({
      id: `rfi-${rfi.id}`,
      type: "rfi",
      typeLabel: "RFI",
      title: rfi.subject,
      projectName: pName(rfi.project_id),
      projectId: rfi.project_id,
      createdAt: rfi.created_at,
      ageDays: age,
      impactCents: rfi.cost_impact_cents ?? undefined,
      impactDays: rfi.schedule_impact_days ?? undefined,
      impactLabel: overdue
        ? `Overdue${rfi.cost_impact_cents ? ` · ${formatCentsCurrency(rfi.cost_impact_cents)}` : ""}`
        : rfi.schedule_impact_days
          ? `${rfi.schedule_impact_days}d schedule impact`
          : rfi.cost_impact_cents
            ? formatCentsCurrency(rfi.cost_impact_cents)
            : "Awaiting response",
      severity:
        overdue || rfi.priority === "urgent"
          ? "high"
          : rfi.priority === "high" || age > 5
            ? "medium"
            : "low",
      href: rfi.project_id ? `/projects/${rfi.project_id}` : "/",
      ctaLabel: "Respond",
    });
  }

  // Submittals awaiting review
  for (const sub of submittalsRes.data ?? []) {
    const age = daysSince(sub.created_at);
    const overdue = sub.due_date && new Date(sub.due_date) < now;
    items.push({
      id: `sub-${sub.id}`,
      type: "submittal",
      typeLabel: "Submittal",
      title: sub.title,
      projectName: pName(sub.project_id),
      projectId: sub.project_id,
      createdAt: sub.created_at,
      ageDays: age,
      impactDays: sub.lead_time_days ?? undefined,
      impactLabel: overdue
        ? `Overdue${sub.lead_time_days ? ` · ${sub.lead_time_days}d lead` : ""}`
        : sub.lead_time_days
          ? `${sub.lead_time_days}d lead time`
          : "Review needed",
      severity: overdue ? "high" : age > 7 ? "medium" : "low",
      href: sub.project_id ? `/projects/${sub.project_id}` : "/",
      ctaLabel: "Review",
    });
  }

  // Vendor bills awaiting approval
  for (const bill of vendorBillsRes.data ?? []) {
    const age = daysSince(bill.created_at);
    items.push({
      id: `bill-${bill.id}`,
      type: "vendor_bill",
      typeLabel: "Bill",
      title: `Bill #${bill.bill_number ?? "—"}`,
      projectName: pName(bill.project_id),
      projectId: bill.project_id,
      createdAt: bill.created_at,
      ageDays: age,
      impactCents: bill.amount_cents ?? undefined,
      impactLabel: bill.amount_cents
        ? formatCentsCurrency(bill.amount_cents)
        : "Pending",
      severity: age > 14 ? "high" : age > 7 ? "medium" : "low",
      href: bill.project_id ? `/projects/${bill.project_id}/payables` : "/",
      ctaLabel: "Approve",
    });
  }

  // High-severity punch items
  for (const pi of punchRes.data ?? []) {
    const age = daysSince(pi.created_at);
    items.push({
      id: `punch-${pi.id}`,
      type: "punch_item",
      typeLabel: "Punch",
      title: pi.title,
      projectName: pName(pi.project_id),
      projectId: pi.project_id,
      createdAt: pi.created_at,
      ageDays: age,
      impactLabel: pi.severity === "urgent" ? "Urgent" : "High priority",
      severity: pi.severity === "urgent" ? "high" : "medium",
      href: pi.project_id ? `/projects/${pi.project_id}` : "/",
      ctaLabel: "Resolve",
    });
  }

  const visibleItems = items.filter(
    (i) => !i.projectId || !excludedProjects.has(i.projectId),
  );

  // Sort by severity (high first), then by age (oldest first)
  const severityOrder = { high: 0, medium: 1, low: 2 };
  visibleItems.sort((a, b) => {
    const sDiff = severityOrder[a.severity] - severityOrder[b.severity];
    if (sDiff !== 0) return sDiff;
    return b.ageDays - a.ageDays;
  });

  return visibleItems.slice(0, 7);
}

// --- Drift & Trend ---

export interface DriftTrend {
  blockers: {
    current: number;
    previous: number;
    direction: "up" | "down" | "flat";
  };
  overdue: {
    current: number;
    previous: number;
    direction: "up" | "down" | "flat";
  };
  completed: {
    current: number;
    previous: number;
    direction: "up" | "down" | "flat";
  };
  created: {
    current: number;
    previous: number;
    direction: "up" | "down" | "flat";
  };
}

function calcDirection(
  current: number,
  previous: number,
): "up" | "down" | "flat" {
  if (current > previous) return "up";
  if (current < previous) return "down";
  return "flat";
}

export async function getDriftTrend(orgId?: string): Promise<DriftTrend> {
  const context = await requireOrgContext(orgId);
  const { supabase, orgId: resolvedOrgId } = context;

  const now = new Date();
  const d7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const d14 = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const d7Str = d7.toISOString();
  const d14Str = d14.toISOString();

  const [
    // Blockers: open RFIs + pending COs + blocked tasks
    rfisNowRes,
    cosNowRes,
    blockedTasksNowRes,
    // Items created in each 7-day window
    rfisRecent7Res,
    rfisPrev7Res,
    // Overdue tasks current vs created before each window
    overdueTasksRes,
    // Completed tasks in each window
    completedRecent7Res,
    completedPrev7Res,
    // Total tasks created in each window
    createdRecent7Res,
    createdPrev7Res,
  ] = await Promise.all([
    supabase
      .from("rfis")
      .select("id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId)
      .in("status", ["open", "pending"]),
    supabase
      .from("change_orders")
      .select("id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId)
      .eq("status", "pending"),
    supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId)
      .eq("status", "blocked"),

    // RFIs opened in last 7 days vs previous 7 days (proxy for blocker trend)
    supabase
      .from("rfis")
      .select("id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId)
      .gte("created_at", d7Str),
    supabase
      .from("rfis")
      .select("id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId)
      .gte("created_at", d14Str)
      .lt("created_at", d7Str),

    // Overdue tasks (due before now, not done)
    supabase
      .from("tasks")
      .select("id, due_date, status, created_at")
      .eq("org_id", resolvedOrgId)
      .neq("status", "done")
      .not("due_date", "is", null)
      .lt("due_date", now.toISOString().split("T")[0]),

    // Tasks completed in each window
    supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId)
      .eq("status", "done")
      .gte("updated_at", d7Str),
    supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId)
      .eq("status", "done")
      .gte("updated_at", d14Str)
      .lt("updated_at", d7Str),

    // Tasks created in each window
    supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId)
      .gte("created_at", d7Str),
    supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId)
      .gte("created_at", d14Str)
      .lt("created_at", d7Str),
  ]);

  const blockersNow =
    (rfisNowRes.count ?? 0) +
    (cosNowRes.count ?? 0) +
    (blockedTasksNowRes.count ?? 0);
  const newBlockers7 = rfisRecent7Res.count ?? 0;
  const newBlockersPrev7 = rfisPrev7Res.count ?? 0;

  const overdueNow = overdueTasksRes.data?.length ?? 0;
  // Approximate previous overdue: items that were already overdue 7 days ago
  const overduePrev =
    overdueTasksRes.data?.filter((t) => {
      const due = new Date(t.due_date);
      return due < d7;
    }).length ?? 0;

  const completedRecent = completedRecent7Res.count ?? 0;
  const completedPrev = completedPrev7Res.count ?? 0;
  const createdRecent = createdRecent7Res.count ?? 0;
  const createdPrev = createdPrev7Res.count ?? 0;

  return {
    blockers: {
      current: blockersNow,
      previous: blockersNow - newBlockers7 + newBlockersPrev7,
      direction: calcDirection(newBlockers7, newBlockersPrev7),
    },
    overdue: {
      current: overdueNow,
      previous: overduePrev,
      direction: calcDirection(overdueNow, overduePrev),
    },
    completed: {
      current: completedRecent,
      previous: completedPrev,
      direction: calcDirection(completedRecent, completedPrev),
    },
    created: {
      current: createdRecent,
      previous: createdPrev,
      direction: calcDirection(createdRecent, createdPrev),
    },
  };
}

// --- Watchlist ---

export interface WatchlistSignal {
  key: "schedule" | "cost" | "docs";
  label: string;
  status: "ok" | "warn" | "critical";
  detail: string;
}

export interface WatchlistProject {
  id: string;
  name: string;
  riskScore: number;
  signals: WatchlistSignal[];
}

// Cached: the KPI strip and the watch panel are separate Suspense bands that
// both read the watchlist, and they must not become two queries.
export const getWatchlist = cache(async (
  orgId?: string,
): Promise<WatchlistProject[]> => {
  const context = await requireOrgContext(orgId);
  const { supabase, orgId: resolvedOrgId } = context;

  const now = new Date();

  // Get active projects
  const excludedProjectIds = await getReportingExcludedProjectIds(supabase, resolvedOrgId);
  const { data: projects } = await applyProjectReportingScope(supabase
    .from("projects")
    .select("id, name, status, total_value")
    .eq("org_id", resolvedOrgId)
    .in("status", ["active", "on_hold"]), excludedProjectIds);

  if (!projects || projects.length === 0) return [];

  const projectIds = projects.map((p) => p.id);

  const [
    scheduleRes,
    tasksRes,
    invoicesRes,
    vendorBillsRes,
    changeOrdersRes,
    rfisRes,
    submittalsRes,
    closeoutRes,
  ] = await Promise.all([
    supabase
      .from("schedule_items")
      .select("id, project_id, status, is_critical_path")
      .in("project_id", projectIds)
      .neq("status", "cancelled"),
    supabase
      .from("tasks")
      .select("id, project_id, status, due_date")
      .in("project_id", projectIds)
      .neq("status", "done"),
    supabase
      .from("invoices")
      .select("id, project_id, status, balance_due_cents, due_date")
      .in("project_id", projectIds)
      .in("status", ["sent", "partial", "overdue"]),
    supabase
      .from("vendor_bills")
      .select("id, project_id, status, amount_cents")
      .in("project_id", projectIds)
      .in("status", ["pending", "approved"]),
    supabase
      .from("change_orders")
      .select("id, project_id, status, total_cents")
      .in("project_id", projectIds)
      .eq("status", "pending"),
    supabase
      .from("rfis")
      .select("id, project_id, status, due_date")
      .in("project_id", projectIds)
      .in("status", ["open", "pending"]),
    supabase
      .from("submittals")
      .select("id, project_id, status, due_date")
      .in("project_id", projectIds)
      .in("status", ["pending", "submitted", "revise_resubmit"]),
    supabase
      .from("closeout_items")
      .select("id, project_id, status")
      .in("project_id", projectIds)
      .eq("status", "missing"),
  ]);

  const scored: WatchlistProject[] = projects.map((project) => {
    const pid = project.id;
    let riskScore = 0;
    const signals: WatchlistSignal[] = [];

    // --- Schedule signal ---
    const schedItems = (scheduleRes.data ?? []).filter(
      (s) => s.project_id === pid,
    );
    const atRisk = schedItems.filter(
      (s) => s.status === "at_risk" || s.status === "blocked",
    ).length;
    const criticalBehind = schedItems.filter(
      (s) =>
        s.is_critical_path &&
        (s.status === "at_risk" || s.status === "blocked"),
    ).length;
    const overdueTasks = (tasksRes.data ?? []).filter(
      (t) => t.project_id === pid && t.due_date && new Date(t.due_date) < now,
    ).length;
    const openRfis = (rfisRes.data ?? []).filter(
      (r) => r.project_id === pid,
    ).length;
    const overdueRfis = (rfisRes.data ?? []).filter(
      (r) => r.project_id === pid && r.due_date && new Date(r.due_date) < now,
    ).length;
    const pendingSubs = (submittalsRes.data ?? []).filter(
      (s) => s.project_id === pid,
    ).length;

    const schedRisk =
      criticalBehind * 3 + atRisk * 2 + overdueTasks + overdueRfis * 2;
    riskScore += schedRisk;

    if (criticalBehind > 0) {
      signals.push({
        key: "schedule",
        label: "Schedule",
        status: "critical",
        detail: `${criticalBehind} critical path item${criticalBehind > 1 ? "s" : ""} behind`,
      });
    } else if (atRisk > 0 || overdueTasks > 2) {
      signals.push({
        key: "schedule",
        label: "Schedule",
        status: "warn",
        detail: `${atRisk + overdueTasks} items at risk or overdue`,
      });
    } else {
      signals.push({
        key: "schedule",
        label: "Schedule",
        status: "ok",
        detail: "On track",
      });
    }

    // --- Cost signal ---
    const overdueAR = (invoicesRes.data ?? []).filter(
      (inv) =>
        inv.project_id === pid &&
        inv.due_date &&
        new Date(inv.due_date) < now &&
        (inv.balance_due_cents ?? 0) > 0,
    );
    const overdueARCents = overdueAR.reduce(
      (sum, inv) => sum + (inv.balance_due_cents ?? 0),
      0,
    );
    const pendingBills = (vendorBillsRes.data ?? []).filter(
      (b) => b.project_id === pid && b.status === "pending",
    );
    const pendingBillCents = pendingBills.reduce(
      (sum, b) => sum + (b.amount_cents ?? 0),
      0,
    );
    const pendingCOs = (changeOrdersRes.data ?? []).filter(
      (co) => co.project_id === pid,
    );
    const pendingCOCents = pendingCOs.reduce(
      (sum, co) => sum + Math.abs(co.total_cents ?? 0),
      0,
    );
    const cashExposure = overdueARCents + pendingBillCents;

    const costRisk =
      (overdueARCents > 0 ? 3 : 0) +
      (pendingCOCents > 500_000 ? 2 : pendingCOCents > 0 ? 1 : 0) +
      (pendingBills.length > 3 ? 2 : pendingBills.length > 0 ? 1 : 0);
    riskScore += costRisk;

    if (overdueARCents > 0 && pendingCOs.length > 0) {
      signals.push({
        key: "cost",
        label: "Cost",
        status: "critical",
        detail: `${formatCentsCurrency(overdueARCents)} AR overdue · ${pendingCOs.length} CO pending`,
      });
    } else if (overdueARCents > 0 || pendingBillCents > 0) {
      signals.push({
        key: "cost",
        label: "Cost",
        status: "warn",
        detail:
          cashExposure > 0
            ? `${formatCentsCurrency(cashExposure)} exposure`
            : "Bills pending",
      });
    } else {
      signals.push({
        key: "cost",
        label: "Cost",
        status: "ok",
        detail: "Healthy",
      });
    }

    // --- Docs/Compliance signal ---
    const missingCloseout = (closeoutRes.data ?? []).filter(
      (c) => c.project_id === pid,
    ).length;
    const docsRisk =
      missingCloseout +
      (pendingSubs > 3 ? 2 : pendingSubs > 0 ? 1 : 0) +
      (openRfis > 5 ? 2 : openRfis > 0 ? 1 : 0);
    riskScore += docsRisk;

    if (missingCloseout > 3 || (openRfis > 3 && pendingSubs > 2)) {
      signals.push({
        key: "docs",
        label: "Docs",
        status: "critical",
        detail: `${missingCloseout} missing docs · ${openRfis} RFIs · ${pendingSubs} submittals`,
      });
    } else if (missingCloseout > 0 || openRfis > 0 || pendingSubs > 0) {
      const parts: string[] = [];
      if (openRfis > 0) parts.push(`${openRfis} RFI${openRfis > 1 ? "s" : ""}`);
      if (pendingSubs > 0)
        parts.push(`${pendingSubs} submittal${pendingSubs > 1 ? "s" : ""}`);
      if (missingCloseout > 0) parts.push(`${missingCloseout} missing`);
      signals.push({
        key: "docs",
        label: "Docs",
        status: "warn",
        detail: parts.join(" · "),
      });
    } else {
      signals.push({
        key: "docs",
        label: "Docs",
        status: "ok",
        detail: "Complete",
      });
    }

    return { id: pid, name: project.name, riskScore, signals };
  });

  // Only include projects with at least one non-ok signal
  return scored
    .filter((p) => p.signals.some((s) => s.status !== "ok"))
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, 5);
});

function formatCentsCurrency(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function formatEventTitle(
  eventType: string,
  payload: Record<string, any> | null,
): string {
  const name = payload?.name ?? payload?.title ?? "";
  const labels: Record<string, string> = {
    project_created: `Project created: ${name}`,
    project_updated: `Project updated: ${name}`,
    task_created: `Task created: ${name}`,
    task_updated: `Task updated: ${name}`,
    task_completed: `Task completed: ${name}`,
    invoice_created: `Invoice created: ${name}`,
    invoice_sent: `Invoice sent: ${name}`,
    invoice_paid: `Invoice paid: ${name}`,
    daily_log_created: `Daily log added: ${name}`,
    rfi_created: `RFI opened: ${name}`,
    submittal_created: `Submittal created: ${name}`,
    change_order_created: `Change order created: ${name}`,
    payment_received: `Payment received: ${name}`,
  };
  return labels[eventType] ?? eventType.replace(/_/g, " ");
}
