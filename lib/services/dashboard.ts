import type { SupabaseClient } from "@supabase/supabase-js"

import { requireOrgContext } from "@/lib/services/context"
import { listProjectsWithClient } from "@/lib/services/projects"
import { listTasksWithClient } from "@/lib/services/tasks"
import type { DashboardStats, Project, Task } from "@/lib/types"

export interface DashboardSnapshot {
  projects: Project[]
  tasks: Task[]
  stats: DashboardStats
}

export async function getDashboardSnapshot(orgId?: string): Promise<DashboardSnapshot> {
  const context = await requireOrgContext(orgId)

  const [projects, tasks, approvalsCount, photosCount] = await Promise.all([
    listProjectsWithClient(context.supabase, context.orgId),
    listTasksWithClient(context.supabase, context.orgId),
    countPendingApprovals(context),
    countRecentPhotos(context),
  ])

  const stats: DashboardStats = {
    activeProjects: projects.filter((p) => p.status === "active" || p.status === "planning" || p.status === "on_hold").length,
    tasksThisWeek: tasks.filter((task) => isDueThisWeek(task.due_date)).length,
    pendingApprovals: approvalsCount,
    recentPhotos: photosCount,
  }

  return { projects, tasks, stats }
}

async function countPendingApprovals(context: { supabase: SupabaseClient; orgId: string }) {
  const { count, error } = await context.supabase
    .from("approvals")
    .select("id", { count: "exact", head: true })
    .eq("org_id", context.orgId)
    .eq("status", "pending")

  if (error) {
    console.error("Failed to count approvals", error)
    return 0
  }

  return count ?? 0
}

async function countRecentPhotos(context: { supabase: SupabaseClient; orgId: string }) {
  const sevenDaysAgo = new Date()
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)

  const { count, error } = await context.supabase
    .from("photos")
    .select("id", { count: "exact", head: true })
    .eq("org_id", context.orgId)
    .gte("created_at", sevenDaysAgo.toISOString())

  if (error) {
    console.error("Failed to count recent photos", error)
    return 0
  }

  return count ?? 0
}

function isDueThisWeek(dueDate?: string) {
  if (!dueDate) return false
  const due = new Date(dueDate)
  const now = new Date()
  const diff = due.getTime() - now.getTime()
  const days = diff / (1000 * 60 * 60 * 24)
  return days >= -7 && days <= 7
}

// --- Control Tower ---

export interface PortfolioHealth {
  activeProjects: number
  projectsAtRisk: number
  cashRiskCents: number
  overdueARCents: number
  unpaidApprovedBillsCents: number
  totalBlockers: number
  itemsDueNext7Days: number
}

export interface ControlTowerData {
  portfolioHealth: PortfolioHealth
  projects: {
    total: number
    byStatus: Record<string, number>
    active: Array<{ id: string; name: string; status: string; start_date?: string; end_date?: string; total_value?: number }>
  }
  tasks: {
    total: number
    dueThisWeek: number
    overdue: number
    byStatus: Record<string, number>
  }
  financials: {
    totalInvoiced: number
    totalCollected: number
    totalOverdue: number
    outstandingAR: number
  }
  openItems: {
    rfis: number
    submittals: number
    changeOrders: number
    punchItems: number
  }
  schedule: {
    totalItems: number
    completedItems: number
    criticalPathItems: number
    atRiskItems: number
    behindItems: number
  }
  pipeline: {
    byStatus: Record<string, number>
    totalValue: number
  }
  activity: Array<{
    id: string
    type: string
    title: string
    meta?: string
    createdAt: string
  }>
}

export async function getControlTowerData(orgId?: string): Promise<ControlTowerData> {
  const context = await requireOrgContext(orgId)
  const { supabase, orgId: resolvedOrgId } = context

  const [
    projectsResult,
    tasksResult,
    invoicesResult,
    rfisResult,
    submittalsResult,
    changeOrdersResult,
    punchResult,
    scheduleResult,
    opportunitiesResult,
    vendorBillsResult,
    eventsResult,
  ] = await Promise.all([
    supabase
      .from("projects")
      .select("id, name, status, start_date, end_date, total_value")
      .eq("org_id", resolvedOrgId),
    supabase
      .from("tasks")
      .select("id, status, due_date")
      .eq("org_id", resolvedOrgId),
    supabase
      .from("invoices")
      .select("id, status, total_cents, balance_due_cents, due_date")
      .eq("org_id", resolvedOrgId)
      .neq("status", "void"),
    supabase
      .from("rfis")
      .select("id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId)
      .in("status", ["open", "pending", "in_review"]),
    supabase
      .from("submittals")
      .select("id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId)
      .in("status", ["open", "pending", "in_review", "submitted"]),
    supabase
      .from("change_orders")
      .select("id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId)
      .eq("status", "pending"),
    supabase
      .from("punch_items")
      .select("id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId)
      .in("status", ["open", "in_progress"]),
    supabase
      .from("schedule_items")
      .select("id, status, is_critical_path, progress")
      .eq("org_id", resolvedOrgId)
      .neq("status", "cancelled"),
    supabase
      .from("opportunities")
      .select("id, status, budget_range")
      .eq("org_id", resolvedOrgId),
    supabase
      .from("vendor_bills")
      .select("id, status, amount_cents, balance_due_cents")
      .eq("org_id", resolvedOrgId)
      .in("status", ["approved", "partial"]),
    supabase
      .from("events")
      .select("id, event_type, payload, created_at")
      .eq("org_id", resolvedOrgId)
      .order("created_at", { ascending: false })
      .limit(20),
  ])

  const projects = projectsResult.data ?? []
  const tasks = tasksResult.data ?? []
  const invoices = invoicesResult.data ?? []
  const scheduleItems = scheduleResult.data ?? []
  const opportunities = opportunitiesResult.data ?? []
  const vendorBills = vendorBillsResult.data ?? []
  const events = eventsResult.data ?? []

  const now = new Date()
  const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)

  // Projects
  const projectsByStatus: Record<string, number> = {}
  for (const p of projects) {
    projectsByStatus[p.status] = (projectsByStatus[p.status] ?? 0) + 1
  }
  const activeProjects = projects.filter((p) =>
    ["active", "planning", "on_hold"].includes(p.status),
  )

  // Tasks
  const tasksByStatus: Record<string, number> = {}
  let tasksDueThisWeek = 0
  let tasksOverdue = 0
  for (const t of tasks) {
    tasksByStatus[t.status] = (tasksByStatus[t.status] ?? 0) + 1
    if (t.due_date) {
      const due = new Date(t.due_date)
      if (due < now && t.status !== "done") tasksOverdue++
      if (due >= now && due <= weekFromNow) tasksDueThisWeek++
    }
  }

  // Financials
  let totalInvoiced = 0
  let totalCollected = 0
  let totalOverdue = 0
  for (const inv of invoices) {
    const total = inv.total_cents ?? 0
    const balance = inv.balance_due_cents ?? 0
    totalInvoiced += total
    totalCollected += total - balance
    if (inv.status === "overdue" || (inv.due_date && new Date(inv.due_date) < now && balance > 0)) {
      totalOverdue += balance
    }
  }
  const outstandingAR = totalInvoiced - totalCollected

  // Schedule
  let completedItems = 0
  let criticalPathItems = 0
  let atRiskItems = 0
  let behindItems = 0
  for (const s of scheduleItems) {
    if (s.status === "completed") completedItems++
    if (s.is_critical_path) criticalPathItems++
    if (s.status === "at_risk") atRiskItems++
    if (s.status === "blocked") behindItems++
  }

  // Vendor bills — unpaid approved
  let unpaidApprovedBillsCents = 0
  for (const bill of vendorBills) {
    unpaidApprovedBillsCents += bill.balance_due_cents ?? bill.amount_cents ?? 0
  }

  // Portfolio health
  const projectsAtRisk = atRiskItems > 0 || behindItems > 0
    ? new Set(scheduleItems.filter((s) => s.status === "at_risk" || s.status === "blocked").map((s) => (s as any).project_id)).size
    : 0
  const totalBlockers = (rfisResult.count ?? 0) + (changeOrdersResult.count ?? 0) + tasksOverdue
  const itemsDueNext7Days = tasksDueThisWeek + scheduleItems.filter((s) => {
    if (s.status === "completed") return false
    const end = (s as any).end_date
    if (!end) return false
    const endDate = new Date(end)
    return endDate >= now && endDate <= weekFromNow
  }).length

  const portfolioHealth: PortfolioHealth = {
    activeProjects: activeProjects.length,
    projectsAtRisk,
    cashRiskCents: totalOverdue + unpaidApprovedBillsCents,
    overdueARCents: totalOverdue,
    unpaidApprovedBillsCents,
    totalBlockers,
    itemsDueNext7Days,
  }

  // Pipeline
  const pipelineByStatus: Record<string, number> = {}
  for (const o of opportunities) {
    pipelineByStatus[o.status] = (pipelineByStatus[o.status] ?? 0) + 1
  }

  // Activity
  const activity = events.map((e) => ({
    id: e.id,
    type: e.event_type,
    title: formatEventTitle(e.event_type, e.payload),
    meta: e.payload?.name ?? e.payload?.title ?? undefined,
    createdAt: e.created_at,
  }))

  return {
    portfolioHealth,
    projects: {
      total: projects.length,
      byStatus: projectsByStatus,
      active: activeProjects,
    },
    tasks: {
      total: tasks.length,
      dueThisWeek: tasksDueThisWeek,
      overdue: tasksOverdue,
      byStatus: tasksByStatus,
    },
    financials: {
      totalInvoiced,
      totalCollected,
      totalOverdue,
      outstandingAR,
    },
    openItems: {
      rfis: rfisResult.count ?? 0,
      submittals: submittalsResult.count ?? 0,
      changeOrders: changeOrdersResult.count ?? 0,
      punchItems: punchResult.count ?? 0,
    },
    schedule: {
      totalItems: scheduleItems.length,
      completedItems,
      criticalPathItems,
      atRiskItems,
      behindItems,
    },
    pipeline: {
      byStatus: pipelineByStatus,
      totalValue: 0,
    },
    activity,
  }
}

// --- Lifecycle Stage Board ---

export interface LifecycleItem {
  id: string
  label: string
  detail: string
  entity: string
  entityId: string
  projectName?: string
  severity: "info" | "warn" | "critical"
  href?: string
}

export interface LifecycleStage {
  key: string
  label: string
  items: LifecycleItem[]
}

export async function getLifecycleBoard(orgId?: string): Promise<LifecycleStage[]> {
  const context = await requireOrgContext(orgId)
  const { supabase, orgId: resolvedOrgId } = context

  const now = new Date()

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
      .in("status", ["new", "contacted", "qualified", "estimating", "proposed"]),
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
      .in("status", ["planning", "bidding", "active", "on_hold", "completed"]),
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
      .select("id, project_id, status, total_cents, balance_due_cents, due_date, invoice_number")
      .eq("org_id", resolvedOrgId)
      .in("status", ["sent", "partial", "overdue"]),
    // Commercials: bills awaiting approval
    supabase
      .from("vendor_bills")
      .select("id, project_id, status, amount_cents, balance_due_cents, bill_number")
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
  ])

  // Build project name map
  const projects = projectsRes.data ?? []
  const projectMap = new Map(projects.map((p) => [p.id, p.name]))
  const pName = (pid?: string) => (pid ? projectMap.get(pid) : undefined)

  // --- PRECON ---
  const preconItems: LifecycleItem[] = []

  // Stalled opportunities (no update in 7+ days)
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  for (const opp of opportunitiesRes.data ?? []) {
    const stale = opp.updated_at && new Date(opp.updated_at) < sevenDaysAgo
    if (stale) {
      preconItems.push({
        id: `opp-${opp.id}`,
        label: opp.name,
        detail: `${opp.status} · no activity 7+ days`,
        entity: "opportunity",
        entityId: opp.id,
        severity: opp.status === "proposed" ? "warn" : "info",
        href: `/pipeline`,
      })
    }
  }

  // Unsigned proposals
  for (const prop of proposalsRes.data ?? []) {
    const opp = (opportunitiesRes.data ?? []).find((o) => o.id === prop.opportunity_id)
    preconItems.push({
      id: `prop-${prop.id}`,
      label: opp?.name ?? "Proposal",
      detail: prop.status === "draft" ? "Proposal not sent" : "Awaiting signature",
      entity: "proposal",
      entityId: prop.id,
      severity: prop.status === "sent" ? "warn" : "info",
    })
  }

  // --- SETUP / MOBILIZATION ---
  const setupItems: LifecycleItem[] = []

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
    })
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
      href: cm.project_id ? `/projects/${cm.project_id}/commitments` : undefined,
    })
  }

  // --- EXECUTION ---
  const execItems: LifecycleItem[] = []

  for (const rfi of rfisRes.data ?? []) {
    const overdue = rfi.due_date && new Date(rfi.due_date) < now
    execItems.push({
      id: `rfi-${rfi.id}`,
      label: rfi.subject,
      detail: overdue ? "RFI overdue" : `RFI ${rfi.status}`,
      entity: "rfi",
      entityId: rfi.id,
      projectName: pName(rfi.project_id),
      severity: overdue ? "critical" : rfi.priority === "urgent" ? "critical" : "warn",
      href: rfi.project_id ? `/projects/${rfi.project_id}` : undefined,
    })
  }

  for (const sub of submittalsRes.data ?? []) {
    const overdue = sub.due_date && new Date(sub.due_date) < now
    execItems.push({
      id: `sub-${sub.id}`,
      label: sub.title,
      detail: overdue ? "Submittal overdue" : sub.status === "revise_resubmit" ? "Revise & resubmit" : `Submittal ${sub.status}`,
      entity: "submittal",
      entityId: sub.id,
      projectName: pName(sub.project_id),
      severity: overdue || sub.status === "revise_resubmit" ? "critical" : "warn",
      href: sub.project_id ? `/projects/${sub.project_id}` : undefined,
    })
  }

  for (const si of scheduleRes.data ?? []) {
    execItems.push({
      id: `sched-${si.id}`,
      label: si.title ?? "Schedule item",
      detail: si.status === "blocked" ? "Blocked" : si.is_critical_path ? "Critical path at risk" : "At risk",
      entity: "schedule_item",
      entityId: si.id,
      projectName: pName(si.project_id),
      severity: si.status === "blocked" || si.is_critical_path ? "critical" : "warn",
      href: si.project_id ? `/projects/${si.project_id}` : undefined,
    })
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
      })
    }
  }

  // --- COMMERCIALS ---
  const commercialItems: LifecycleItem[] = []

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
    })
  }

  for (const inv of invoicesRes.data ?? []) {
    const overdue = inv.due_date && new Date(inv.due_date) < now && (inv.balance_due_cents ?? 0) > 0
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
      })
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
      href: bill.project_id ? `/projects/${bill.project_id}/payables` : undefined,
    })
  }

  // --- CLOSEOUT / WARRANTY ---
  const closeoutItems: LifecycleItem[] = []

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
    })
  }

  for (const pi of punchRes.data ?? []) {
    closeoutItems.push({
      id: `punch-${pi.id}`,
      label: pi.title,
      detail: `Punch ${pi.status}${pi.severity ? ` · ${pi.severity}` : ""}`,
      entity: "punch_item",
      entityId: pi.id,
      projectName: pName(pi.project_id),
      severity: pi.severity === "high" || pi.severity === "urgent" ? "critical" : "warn",
      href: pi.project_id ? `/projects/${pi.project_id}` : undefined,
    })
  }

  for (const wr of warrantyRes.data ?? []) {
    closeoutItems.push({
      id: `warranty-${wr.id}`,
      label: wr.title,
      detail: `Warranty ${wr.status}${wr.priority === "high" || wr.priority === "urgent" ? " · urgent" : ""}`,
      entity: "warranty",
      entityId: wr.id,
      projectName: pName(wr.project_id),
      severity: wr.priority === "high" || wr.priority === "urgent" ? "critical" : "warn",
      href: wr.project_id ? `/projects/${wr.project_id}` : undefined,
    })
  }

  return [
    { key: "precon", label: "Pre-Construction", items: preconItems },
    { key: "setup", label: "Setup & Mobilization", items: setupItems },
    { key: "execution", label: "Execution", items: execItems },
    { key: "commercials", label: "Commercials", items: commercialItems },
    { key: "closeout", label: "Closeout & Warranty", items: closeoutItems },
  ]
}

// --- Decision Queue ---

export type DecisionType = "change_order" | "rfi" | "submittal" | "vendor_bill" | "proposal" | "punch_item"

export interface DecisionItem {
  id: string
  type: DecisionType
  typeLabel: string
  title: string
  projectName?: string
  projectId?: string
  createdAt: string
  ageDays: number
  impactCents?: number
  impactDays?: number
  impactLabel: string
  severity: "low" | "medium" | "high"
  href: string
  ctaLabel: string
}

export async function getDecisionQueue(orgId?: string): Promise<DecisionItem[]> {
  const context = await requireOrgContext(orgId)
  const { supabase, orgId: resolvedOrgId } = context

  const now = new Date()

  const [
    changeOrdersRes,
    rfisRes,
    submittalsRes,
    vendorBillsRes,
    proposalsRes,
    punchRes,
    projectsRes,
  ] = await Promise.all([
    supabase
      .from("change_orders")
      .select("id, project_id, title, status, total_cents, days_impact, created_at")
      .eq("org_id", resolvedOrgId)
      .eq("status", "pending"),
    supabase
      .from("rfis")
      .select("id, project_id, subject, status, due_date, priority, cost_impact_cents, schedule_impact_days, created_at")
      .eq("org_id", resolvedOrgId)
      .in("status", ["open", "pending"]),
    supabase
      .from("submittals")
      .select("id, project_id, title, status, due_date, lead_time_days, created_at")
      .eq("org_id", resolvedOrgId)
      .in("status", ["pending", "submitted"]),
    supabase
      .from("vendor_bills")
      .select("id, project_id, bill_number, status, amount_cents, created_at")
      .eq("org_id", resolvedOrgId)
      .eq("status", "pending"),
    supabase
      .from("proposals")
      .select("id, opportunity_id, status, created_at")
      .eq("org_id", resolvedOrgId)
      .eq("status", "sent"),
    supabase
      .from("punch_items")
      .select("id, project_id, title, status, severity, created_at")
      .eq("org_id", resolvedOrgId)
      .eq("status", "open")
      .in("severity", ["high", "urgent"]),
    supabase
      .from("projects")
      .select("id, name")
      .eq("org_id", resolvedOrgId),
  ])

  const projectMap = new Map((projectsRes.data ?? []).map((p) => [p.id, p.name]))
  const pName = (pid?: string) => (pid ? projectMap.get(pid) : undefined)
  const daysSince = (dateStr: string) => Math.max(0, Math.floor((now.getTime() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24)))

  const items: DecisionItem[] = []

  // Change orders pending approval
  for (const co of changeOrdersRes.data ?? []) {
    const age = daysSince(co.created_at)
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
        : co.days_impact ? `${co.days_impact} day impact` : "Pending review",
      severity: age > 7 || (co.total_cents ?? 0) > 1_000_000 ? "high" : age > 3 ? "medium" : "low",
      href: co.project_id ? `/projects/${co.project_id}` : "/change-orders",
      ctaLabel: "Approve / Reject",
    })
  }

  // RFIs awaiting response
  for (const rfi of rfisRes.data ?? []) {
    const age = daysSince(rfi.created_at)
    const overdue = rfi.due_date && new Date(rfi.due_date) < now
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
        : rfi.schedule_impact_days ? `${rfi.schedule_impact_days}d schedule impact` : rfi.cost_impact_cents ? formatCentsCurrency(rfi.cost_impact_cents) : "Awaiting response",
      severity: overdue || rfi.priority === "urgent" ? "high" : rfi.priority === "high" || age > 5 ? "medium" : "low",
      href: rfi.project_id ? `/projects/${rfi.project_id}` : "/",
      ctaLabel: "Respond",
    })
  }

  // Submittals awaiting review
  for (const sub of submittalsRes.data ?? []) {
    const age = daysSince(sub.created_at)
    const overdue = sub.due_date && new Date(sub.due_date) < now
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
        : sub.lead_time_days ? `${sub.lead_time_days}d lead time` : "Review needed",
      severity: overdue ? "high" : age > 7 ? "medium" : "low",
      href: sub.project_id ? `/projects/${sub.project_id}` : "/",
      ctaLabel: "Review",
    })
  }

  // Vendor bills awaiting approval
  for (const bill of vendorBillsRes.data ?? []) {
    const age = daysSince(bill.created_at)
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
      impactLabel: bill.amount_cents ? formatCentsCurrency(bill.amount_cents) : "Pending",
      severity: age > 14 ? "high" : age > 7 ? "medium" : "low",
      href: bill.project_id ? `/projects/${bill.project_id}/payables` : "/",
      ctaLabel: "Approve",
    })
  }

  // High-severity punch items
  for (const pi of punchRes.data ?? []) {
    const age = daysSince(pi.created_at)
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
    })
  }

  // Sort by severity (high first), then by age (oldest first)
  const severityOrder = { high: 0, medium: 1, low: 2 }
  items.sort((a, b) => {
    const sDiff = severityOrder[a.severity] - severityOrder[b.severity]
    if (sDiff !== 0) return sDiff
    return b.ageDays - a.ageDays
  })

  return items.slice(0, 7)
}

// --- Drift & Trend ---

export interface DriftTrend {
  blockers: { current: number; previous: number; direction: "up" | "down" | "flat" }
  overdue: { current: number; previous: number; direction: "up" | "down" | "flat" }
  completed: { current: number; previous: number; direction: "up" | "down" | "flat" }
  created: { current: number; previous: number; direction: "up" | "down" | "flat" }
}

function calcDirection(current: number, previous: number): "up" | "down" | "flat" {
  if (current > previous) return "up"
  if (current < previous) return "down"
  return "flat"
}

export async function getDriftTrend(orgId?: string): Promise<DriftTrend> {
  const context = await requireOrgContext(orgId)
  const { supabase, orgId: resolvedOrgId } = context

  const now = new Date()
  const d7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const d14 = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000)
  const d7Str = d7.toISOString()
  const d14Str = d14.toISOString()

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
    supabase.from("rfis").select("id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId).in("status", ["open", "pending"]),
    supabase.from("change_orders").select("id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId).eq("status", "pending"),
    supabase.from("tasks").select("id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId).eq("status", "blocked"),

    // RFIs opened in last 7 days vs previous 7 days (proxy for blocker trend)
    supabase.from("rfis").select("id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId).gte("created_at", d7Str),
    supabase.from("rfis").select("id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId).gte("created_at", d14Str).lt("created_at", d7Str),

    // Overdue tasks (due before now, not done)
    supabase.from("tasks").select("id, due_date, status, created_at")
      .eq("org_id", resolvedOrgId).neq("status", "done").not("due_date", "is", null)
      .lt("due_date", now.toISOString().split("T")[0]),

    // Tasks completed in each window
    supabase.from("tasks").select("id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId).eq("status", "done").gte("updated_at", d7Str),
    supabase.from("tasks").select("id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId).eq("status", "done").gte("updated_at", d14Str).lt("updated_at", d7Str),

    // Tasks created in each window
    supabase.from("tasks").select("id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId).gte("created_at", d7Str),
    supabase.from("tasks").select("id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId).gte("created_at", d14Str).lt("created_at", d7Str),
  ])

  const blockersNow = (rfisNowRes.count ?? 0) + (cosNowRes.count ?? 0) + (blockedTasksNowRes.count ?? 0)
  const newBlockers7 = rfisRecent7Res.count ?? 0
  const newBlockersPrev7 = rfisPrev7Res.count ?? 0

  const overdueNow = overdueTasksRes.data?.length ?? 0
  // Approximate previous overdue: items that were already overdue 7 days ago
  const overduePrev = overdueTasksRes.data?.filter((t) => {
    const due = new Date(t.due_date)
    return due < d7
  }).length ?? 0

  const completedRecent = completedRecent7Res.count ?? 0
  const completedPrev = completedPrev7Res.count ?? 0
  const createdRecent = createdRecent7Res.count ?? 0
  const createdPrev = createdPrev7Res.count ?? 0

  return {
    blockers: { current: blockersNow, previous: blockersNow - newBlockers7 + newBlockersPrev7, direction: calcDirection(newBlockers7, newBlockersPrev7) },
    overdue: { current: overdueNow, previous: overduePrev, direction: calcDirection(overdueNow, overduePrev) },
    completed: { current: completedRecent, previous: completedPrev, direction: calcDirection(completedRecent, completedPrev) },
    created: { current: createdRecent, previous: createdPrev, direction: calcDirection(createdRecent, createdPrev) },
  }
}

// --- Watchlist ---

export interface WatchlistSignal {
  key: "schedule" | "cost" | "docs"
  label: string
  status: "ok" | "warn" | "critical"
  detail: string
}

export interface WatchlistProject {
  id: string
  name: string
  riskScore: number
  signals: WatchlistSignal[]
}

export async function getWatchlist(orgId?: string): Promise<WatchlistProject[]> {
  const context = await requireOrgContext(orgId)
  const { supabase, orgId: resolvedOrgId } = context

  const now = new Date()

  // Get active projects
  const { data: projects } = await supabase
    .from("projects")
    .select("id, name, status, total_value")
    .eq("org_id", resolvedOrgId)
    .in("status", ["active", "planning", "on_hold"])

  if (!projects || projects.length === 0) return []

  const projectIds = projects.map((p) => p.id)

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
    supabase.from("schedule_items")
      .select("id, project_id, status, is_critical_path")
      .in("project_id", projectIds)
      .neq("status", "cancelled"),
    supabase.from("tasks")
      .select("id, project_id, status, due_date")
      .in("project_id", projectIds)
      .neq("status", "done"),
    supabase.from("invoices")
      .select("id, project_id, status, balance_due_cents, due_date")
      .in("project_id", projectIds)
      .in("status", ["sent", "partial", "overdue"]),
    supabase.from("vendor_bills")
      .select("id, project_id, status, amount_cents")
      .in("project_id", projectIds)
      .in("status", ["pending", "approved"]),
    supabase.from("change_orders")
      .select("id, project_id, status, total_cents")
      .in("project_id", projectIds)
      .eq("status", "pending"),
    supabase.from("rfis")
      .select("id, project_id, status, due_date")
      .in("project_id", projectIds)
      .in("status", ["open", "pending"]),
    supabase.from("submittals")
      .select("id, project_id, status, due_date")
      .in("project_id", projectIds)
      .in("status", ["pending", "submitted", "revise_resubmit"]),
    supabase.from("closeout_items")
      .select("id, project_id, status")
      .in("project_id", projectIds)
      .eq("status", "missing"),
  ])

  const scored: WatchlistProject[] = projects.map((project) => {
    const pid = project.id
    let riskScore = 0
    const signals: WatchlistSignal[] = []

    // --- Schedule signal ---
    const schedItems = (scheduleRes.data ?? []).filter((s) => s.project_id === pid)
    const atRisk = schedItems.filter((s) => s.status === "at_risk" || s.status === "blocked").length
    const criticalBehind = schedItems.filter((s) => s.is_critical_path && (s.status === "at_risk" || s.status === "blocked")).length
    const overdueTasks = (tasksRes.data ?? []).filter((t) => t.project_id === pid && t.due_date && new Date(t.due_date) < now).length
    const openRfis = (rfisRes.data ?? []).filter((r) => r.project_id === pid).length
    const overdueRfis = (rfisRes.data ?? []).filter((r) => r.project_id === pid && r.due_date && new Date(r.due_date) < now).length
    const pendingSubs = (submittalsRes.data ?? []).filter((s) => s.project_id === pid).length

    const schedRisk = criticalBehind * 3 + atRisk * 2 + overdueTasks + overdueRfis * 2
    riskScore += schedRisk

    if (criticalBehind > 0) {
      signals.push({ key: "schedule", label: "Schedule", status: "critical", detail: `${criticalBehind} critical path item${criticalBehind > 1 ? "s" : ""} behind` })
    } else if (atRisk > 0 || overdueTasks > 2) {
      signals.push({ key: "schedule", label: "Schedule", status: "warn", detail: `${atRisk + overdueTasks} items at risk or overdue` })
    } else {
      signals.push({ key: "schedule", label: "Schedule", status: "ok", detail: "On track" })
    }

    // --- Cost signal ---
    const overdueAR = (invoicesRes.data ?? []).filter((inv) => inv.project_id === pid && inv.due_date && new Date(inv.due_date) < now && (inv.balance_due_cents ?? 0) > 0)
    const overdueARCents = overdueAR.reduce((sum, inv) => sum + (inv.balance_due_cents ?? 0), 0)
    const pendingBills = (vendorBillsRes.data ?? []).filter((b) => b.project_id === pid && b.status === "pending")
    const pendingBillCents = pendingBills.reduce((sum, b) => sum + (b.amount_cents ?? 0), 0)
    const pendingCOs = (changeOrdersRes.data ?? []).filter((co) => co.project_id === pid)
    const pendingCOCents = pendingCOs.reduce((sum, co) => sum + Math.abs(co.total_cents ?? 0), 0)
    const cashExposure = overdueARCents + pendingBillCents

    const costRisk = (overdueARCents > 0 ? 3 : 0) + (pendingCOCents > 500_000 ? 2 : pendingCOCents > 0 ? 1 : 0) + (pendingBills.length > 3 ? 2 : pendingBills.length > 0 ? 1 : 0)
    riskScore += costRisk

    if (overdueARCents > 0 && pendingCOs.length > 0) {
      signals.push({ key: "cost", label: "Cost", status: "critical", detail: `${formatCentsCurrency(overdueARCents)} AR overdue · ${pendingCOs.length} CO pending` })
    } else if (overdueARCents > 0 || pendingBillCents > 0) {
      signals.push({ key: "cost", label: "Cost", status: "warn", detail: cashExposure > 0 ? `${formatCentsCurrency(cashExposure)} exposure` : "Bills pending" })
    } else {
      signals.push({ key: "cost", label: "Cost", status: "ok", detail: "Healthy" })
    }

    // --- Docs/Compliance signal ---
    const missingCloseout = (closeoutRes.data ?? []).filter((c) => c.project_id === pid).length
    const docsRisk = missingCloseout + (pendingSubs > 3 ? 2 : pendingSubs > 0 ? 1 : 0) + (openRfis > 5 ? 2 : openRfis > 0 ? 1 : 0)
    riskScore += docsRisk

    if (missingCloseout > 3 || (openRfis > 3 && pendingSubs > 2)) {
      signals.push({ key: "docs", label: "Docs", status: "critical", detail: `${missingCloseout} missing docs · ${openRfis} RFIs · ${pendingSubs} submittals` })
    } else if (missingCloseout > 0 || openRfis > 0 || pendingSubs > 0) {
      const parts: string[] = []
      if (openRfis > 0) parts.push(`${openRfis} RFI${openRfis > 1 ? "s" : ""}`)
      if (pendingSubs > 0) parts.push(`${pendingSubs} submittal${pendingSubs > 1 ? "s" : ""}`)
      if (missingCloseout > 0) parts.push(`${missingCloseout} missing`)
      signals.push({ key: "docs", label: "Docs", status: "warn", detail: parts.join(" · ") })
    } else {
      signals.push({ key: "docs", label: "Docs", status: "ok", detail: "Complete" })
    }

    return { id: pid, name: project.name, riskScore, signals }
  })

  // Only include projects with at least one non-ok signal
  return scored
    .filter((p) => p.signals.some((s) => s.status !== "ok"))
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, 5)
}

function formatCentsCurrency(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100)
}

function formatEventTitle(eventType: string, payload: Record<string, any> | null): string {
  const name = payload?.name ?? payload?.title ?? ""
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
  }
  return labels[eventType] ?? eventType.replace(/_/g, " ")
}
