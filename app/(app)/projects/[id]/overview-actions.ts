"use server"

import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { getBudgetWithActuals } from "@/lib/services/budgets"
import { getProjectContract } from "@/lib/services/contracts"
import type { Project, ScheduleItem, Task, DrawSchedule, Rfi, Submittal, PunchItem, CloseoutItem, WarrantyRequest, FileMetadata, PortalAccessToken, Proposal, Contract } from "@/lib/types"
import { differenceInCalendarDays, parseISO, isBefore, isAfter, addDays, subDays } from "date-fns"
import type { ProjectActivity } from "./actions"

// ============================================================================
// Types
// ============================================================================

export interface HealthCounts {
  tasks: { open: number; overdue: number }
  schedule: { progress: number; atRisk: number; overdue: number }
  rfis: { open: number; overdue: number }
  submittals: { pending: number; overdue: number }
  punch: { open: number; overdue: number }
  warranty: { open: number }
  closeout: { missing: number; total: number }
  financial: {
    budgetVariancePercent: number
    contractTotalCents: number
    invoicedCents: number
    nextDrawAmountCents: number | null
    nextDrawTitle: string | null
  }
}

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

export interface RecentFile {
  id: string
  name: string
  mime_type?: string | null
  size?: number | null
  uploaded_at: string
  link: string
}

export interface ProjectOverviewDTO {
  project: Project
  health: HealthCounts
  attentionRequired: AttentionItem[]
  comingUp: ComingUpItem[]
  recentFiles: RecentFile[]
  recentActivity: ProjectActivity[]
  // Setup checklist data
  proposals: Proposal[]
  contract: Contract | null
  draws: DrawSchedule[]
  scheduleItemCount: number
  portalTokens: PortalAccessToken[]
  // Timeline data
  daysRemaining: number
  daysElapsed: number
  totalDays: number
  scheduleProgress: number
  // Budget data (if available)
  budgetSummary?: {
    adjustedBudgetCents: number
    totalCommittedCents: number
    totalActualCents: number
    totalInvoicedCents: number
    varianceCents: number
    variancePercent: number
    grossMarginPercent: number
    trendPercent?: number
    status: "ok" | "warning" | "over"
  }
  // Approved change orders total
  approvedChangeOrdersTotalCents: number
}

// ============================================================================
// Main aggregated action
// ============================================================================

export async function getProjectOverviewAction(projectId: string): Promise<ProjectOverviewDTO | null> {
  const { supabase, orgId } = await requireOrgContext()
  const today = new Date()

  // Fetch project
  const { data: projectData, error: projectError } = await supabase
    .from("projects")
    .select("*")
    .eq("org_id", orgId)
    .eq("id", projectId)
    .single()

  if (projectError || !projectData) {
    console.error("Failed to fetch project:", projectError?.message)
    return null
  }

  const project = mapProject(projectData)

  // Parallel fetches for counts and preview data
  const [
    taskCounts,
    scheduleCounts,
    rfiCounts,
    submittalCounts,
    punchCounts,
    warrantyCounts,
    closeoutCounts,
    attentionData,
    comingUpData,
    recentFilesData,
    activityData,
    proposalsData,
    contractData,
    drawsData,
    scheduleItemCountData,
    portalTokensData,
    approvedCOTotal,
    budgetData,
  ] = await Promise.all([
    getTaskCounts(supabase, orgId, projectId, today),
    getScheduleCounts(supabase, orgId, projectId, today),
    getRfiCounts(supabase, orgId, projectId, today),
    getSubmittalCounts(supabase, orgId, projectId, today),
    getPunchCounts(supabase, orgId, projectId, today),
    getWarrantyCounts(supabase, orgId, projectId),
    getCloseoutCounts(supabase, orgId, projectId),
    getAttentionItems(supabase, orgId, projectId, today),
    getComingUpItems(supabase, orgId, projectId, today),
    getRecentFiles(supabase, orgId, projectId),
    getRecentActivity(supabase, orgId, projectId),
    getProposals(supabase, orgId, projectId),
    getProjectContract(projectId),
    getDraws(supabase, orgId, projectId),
    getScheduleItemCount(supabase, orgId, projectId),
    getPortalTokens(supabase, projectId),
    getApprovedChangeOrderTotal(supabase, orgId, projectId),
    getBudgetSummary(orgId, projectId),
  ])

  // Calculate timeline stats
  const startDate = project.start_date ? parseISO(project.start_date) : today
  const endDate = project.end_date ? parseISO(project.end_date) : today
  const totalDays = Math.max(1, differenceInCalendarDays(endDate, startDate))
  const daysElapsed = Math.max(0, Math.min(totalDays, differenceInCalendarDays(today, startDate)))
  const daysRemaining = Math.max(0, differenceInCalendarDays(endDate, today))

  // Calculate financial health data
  const nextDraw = drawsData.find(d => d.status === "pending" || d.status === "scheduled")

  const health: HealthCounts = {
    tasks: taskCounts,
    schedule: {
      progress: scheduleCounts.progress,
      atRisk: scheduleCounts.atRisk,
      overdue: scheduleCounts.overdue
    },
    rfis: rfiCounts,
    submittals: submittalCounts,
    punch: punchCounts,
    warranty: warrantyCounts,
    closeout: closeoutCounts,
    financial: {
      budgetVariancePercent: budgetData?.variancePercent ?? 0,
      contractTotalCents: contractData?.total_cents ?? 0,
      invoicedCents: budgetData?.totalInvoicedCents ?? 0,
      nextDrawAmountCents: nextDraw?.amount_cents ?? null,
      nextDrawTitle: nextDraw?.title ?? null,
    },
  }

  return {
    project,
    health,
    attentionRequired: attentionData,
    comingUp: comingUpData,
    recentFiles: recentFilesData,
    recentActivity: activityData,
    proposals: proposalsData,
    contract: contractData,
    draws: drawsData,
    scheduleItemCount: scheduleItemCountData,
    portalTokens: portalTokensData,
    daysRemaining,
    daysElapsed,
    totalDays,
    scheduleProgress: scheduleCounts.progress,
    budgetSummary: budgetData ?? undefined,
    approvedChangeOrdersTotalCents: approvedCOTotal,
  }
}

// ============================================================================
// Helper functions for counts
// ============================================================================

function mapProject(row: any): Project {
  const location = (row.location ?? {}) as Record<string, unknown>
  const address = typeof location.address === "string" ? location.address : (location.formatted as string | undefined)

  return {
    id: row.id,
    org_id: row.org_id,
    name: row.name,
    status: row.status,
    start_date: row.start_date ?? undefined,
    end_date: row.end_date ?? undefined,
    budget: row.budget ?? undefined,
    address,
    client_id: row.client_id ?? undefined,
    property_type: row.property_type ?? undefined,
    project_type: row.project_type ?? undefined,
    description: row.description ?? undefined,
    total_value: row.total_value ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

async function getTaskCounts(supabase: any, orgId: string, projectId: string, today: Date) {
  const todayStr = today.toISOString().split("T")[0]

  // Get open count
  const { count: openCount } = await supabase
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .neq("status", "done")

  // Get overdue count
  const { count: overdueCount } = await supabase
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .neq("status", "done")
    .lt("due_date", todayStr)

  return { open: openCount ?? 0, overdue: overdueCount ?? 0 }
}

async function getScheduleCounts(supabase: any, orgId: string, projectId: string, today: Date) {
  const todayStr = today.toISOString().split("T")[0]

  // Get all schedule items for progress calculation
  const { data: items } = await supabase
    .from("schedule_items")
    .select("id, status, end_date, progress")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .not("status", "in", "(cancelled)")

  const total = items?.length ?? 0
  const completed = items?.filter((i: any) => i.status === "completed").length ?? 0
  const progress = total > 0 ? Math.round((completed / total) * 100) : 0

  const atRisk = items?.filter((i: any) =>
    i.status === "at_risk" || i.status === "blocked"
  ).length ?? 0

  const overdue = items?.filter((i: any) => {
    if (!i.end_date) return false
    return i.status !== "completed" && isBefore(parseISO(i.end_date), today)
  }).length ?? 0

  return { progress, atRisk, overdue }
}

async function getRfiCounts(supabase: any, orgId: string, projectId: string, today: Date) {
  const todayStr = today.toISOString().split("T")[0]

  const { count: openCount } = await supabase
    .from("rfis")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .in("status", ["open", "in_review"])

  const { count: overdueCount } = await supabase
    .from("rfis")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .in("status", ["open", "in_review"])
    .lt("due_date", todayStr)

  return { open: openCount ?? 0, overdue: overdueCount ?? 0 }
}

async function getSubmittalCounts(supabase: any, orgId: string, projectId: string, today: Date) {
  const todayStr = today.toISOString().split("T")[0]

  const { count: pendingCount } = await supabase
    .from("submittals")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .in("status", ["pending", "submitted", "in_review", "revise_resubmit"])

  const { count: overdueCount } = await supabase
    .from("submittals")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .in("status", ["pending", "submitted", "in_review", "revise_resubmit"])
    .lt("due_date", todayStr)

  return { pending: pendingCount ?? 0, overdue: overdueCount ?? 0 }
}

async function getPunchCounts(supabase: any, orgId: string, projectId: string, today: Date) {
  const todayStr = today.toISOString().split("T")[0]

  const { count: openCount } = await supabase
    .from("punch_items")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .neq("status", "closed")

  const { count: overdueCount } = await supabase
    .from("punch_items")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .neq("status", "closed")
    .lt("due_date", todayStr)

  return { open: openCount ?? 0, overdue: overdueCount ?? 0 }
}

async function getWarrantyCounts(supabase: any, orgId: string, projectId: string) {
  const { count: openCount } = await supabase
    .from("warranty_requests")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .in("status", ["open", "in_progress"])

  return { open: openCount ?? 0 }
}

async function getCloseoutCounts(supabase: any, orgId: string, projectId: string) {
  // Get closeout package for this project
  const { data: pkg } = await supabase
    .from("closeout_packages")
    .select("id")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .maybeSingle()

  if (!pkg) return { missing: 0, total: 0 }

  const { data: items } = await supabase
    .from("closeout_items")
    .select("status")
    .eq("org_id", orgId)
    .eq("closeout_package_id", pkg.id)

  const total = items?.length ?? 0
  const missing = items?.filter((i: any) => i.status === "missing").length ?? 0

  return { missing, total }
}

// ============================================================================
// Helper functions for previews
// ============================================================================

async function getAttentionItems(
  supabase: any,
  orgId: string,
  projectId: string,
  today: Date
): Promise<AttentionItem[]> {
  const todayStr = today.toISOString().split("T")[0]
  const items: AttentionItem[] = []

  // Overdue tasks
  const { data: overdueTasks } = await supabase
    .from("tasks")
    .select("id, title, due_date, status")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .neq("status", "done")
    .lt("due_date", todayStr)
    .order("due_date", { ascending: true })
    .limit(5)

  for (const task of overdueTasks ?? []) {
    items.push({
      id: task.id,
      type: "task",
      title: task.title,
      reason: "overdue",
      dueDate: task.due_date,
      status: task.status,
      link: `/projects/${projectId}/tasks?highlight=${task.id}`,
    })
  }

  // At-risk/blocked/overdue schedule items
  const { data: riskSchedule } = await supabase
    .from("schedule_items")
    .select("id, name, end_date, status")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .or(`status.in.(at_risk,blocked),and(end_date.lt.${todayStr},status.neq.completed,status.neq.cancelled)`)
    .order("end_date", { ascending: true })
    .limit(5)

  for (const item of riskSchedule ?? []) {
    const isOverdue = item.end_date && isBefore(parseISO(item.end_date), today) && item.status !== "completed"
    items.push({
      id: item.id,
      type: "schedule",
      title: item.name,
      reason: isOverdue ? "overdue" : item.status === "blocked" ? "blocked" : "at_risk",
      dueDate: item.end_date,
      status: item.status,
      link: `/projects/${projectId}/schedule?highlight=${item.id}`,
    })
  }

  // Overdue RFIs
  const { data: overdueRfis } = await supabase
    .from("rfis")
    .select("id, subject, due_date, status")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .in("status", ["open", "in_review"])
    .lt("due_date", todayStr)
    .order("due_date", { ascending: true })
    .limit(3)

  for (const rfi of overdueRfis ?? []) {
    items.push({
      id: rfi.id,
      type: "rfi",
      title: rfi.subject,
      reason: "overdue",
      dueDate: rfi.due_date,
      status: rfi.status,
      link: `/rfis?project=${projectId}&highlight=${rfi.id}`,
    })
  }

  // Overdue submittals
  const { data: overdueSubmittals } = await supabase
    .from("submittals")
    .select("id, title, due_date, status")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .in("status", ["pending", "submitted", "in_review", "revise_resubmit"])
    .lt("due_date", todayStr)
    .order("due_date", { ascending: true })
    .limit(3)

  for (const sub of overdueSubmittals ?? []) {
    items.push({
      id: sub.id,
      type: "submittal",
      title: sub.title,
      reason: "overdue",
      dueDate: sub.due_date,
      status: sub.status,
      link: `/submittals?project=${projectId}&highlight=${sub.id}`,
    })
  }

  // Overdue punch items
  const { data: overduePunch } = await supabase
    .from("punch_items")
    .select("id, title, due_date, status")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .neq("status", "closed")
    .lt("due_date", todayStr)
    .order("due_date", { ascending: true })
    .limit(3)

  for (const punch of overduePunch ?? []) {
    items.push({
      id: punch.id,
      type: "punch",
      title: punch.title,
      reason: "overdue",
      dueDate: punch.due_date,
      status: punch.status,
      link: `/projects/${projectId}/punch?highlight=${punch.id}`,
    })
  }

  // Sort by due date and return top 10
  return items
    .sort((a, b) => {
      if (!a.dueDate && !b.dueDate) return 0
      if (!a.dueDate) return 1
      if (!b.dueDate) return -1
      return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()
    })
    .slice(0, 10)
}

async function getComingUpItems(
  supabase: any,
  orgId: string,
  projectId: string,
  today: Date
): Promise<ComingUpItem[]> {
  const items: ComingUpItem[] = []
  const nextWeek = addDays(today, 7)
  const todayStr = today.toISOString().split("T")[0]
  const nextWeekStr = nextWeek.toISOString().split("T")[0]

  // Schedule items starting or ending in next 7 days
  const { data: scheduleItems } = await supabase
    .from("schedule_items")
    .select("id, name, start_date, end_date, status, progress, item_type")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .not("status", "in", "(completed,cancelled)")
    .or(`start_date.gte.${todayStr},end_date.gte.${todayStr}`)
    .lte("start_date", nextWeekStr)
    .order("start_date", { ascending: true })
    .limit(7)

  for (const item of scheduleItems ?? []) {
    const isMilestone = item.item_type === "milestone"
    items.push({
      id: item.id,
      type: isMilestone ? "milestone" : "schedule",
      title: item.name,
      date: item.start_date ?? item.end_date,
      status: item.status,
      progress: item.progress ?? 0,
      link: `/projects/${projectId}/schedule?highlight=${item.id}`,
    })
  }

  // Tasks due in next 7 days
  const { data: tasks } = await supabase
    .from("tasks")
    .select("id, title, due_date, status")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .neq("status", "done")
    .gte("due_date", todayStr)
    .lte("due_date", nextWeekStr)
    .order("due_date", { ascending: true })
    .limit(5)

  for (const task of tasks ?? []) {
    items.push({
      id: task.id,
      type: "task",
      title: task.title,
      date: task.due_date,
      status: task.status,
      link: `/projects/${projectId}/tasks?highlight=${task.id}`,
    })
  }

  // Upcoming draws
  const { data: draws } = await supabase
    .from("draw_schedules")
    .select("id, title, due_date, status")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .in("status", ["pending", "scheduled"])
    .gte("due_date", todayStr)
    .order("due_date", { ascending: true })
    .limit(2)

  for (const draw of draws ?? []) {
    if (draw.due_date) {
      items.push({
        id: draw.id,
        type: "draw",
        title: draw.title,
        date: draw.due_date,
        status: draw.status,
        link: `/projects/${projectId}/financials`,
      })
    }
  }

  // Sort by date and return top 7
  return items
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    .slice(0, 7)
}

async function getRecentFiles(supabase: any, orgId: string, projectId: string): Promise<RecentFile[]> {
  const { data } = await supabase
    .from("files")
    .select("id, name, mime_type, size, created_at")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(5)

  return (data ?? []).map((f: any) => ({
    id: f.id,
    name: f.name,
    mime_type: f.mime_type,
    size: f.size,
    uploaded_at: f.created_at,
    link: `/projects/${projectId}/files?highlight=${f.id}`,
  }))
}

async function getRecentActivity(supabase: any, orgId: string, projectId: string): Promise<ProjectActivity[]> {
  const { data } = await supabase
    .from("events")
    .select("id, event_type, entity_type, entity_id, payload, created_at")
    .eq("org_id", orgId)
    .or(`project_id.eq.${projectId},payload->>project_id.eq.${projectId}`)
    .order("created_at", { ascending: false })
    .limit(15)

  return (data ?? []).map((e: any) => ({
    id: e.id,
    event_type: e.event_type,
    entity_type: e.entity_type,
    entity_id: e.entity_id,
    payload: e.payload ?? {},
    created_at: e.created_at,
  }))
}

async function getProposals(supabase: any, orgId: string, projectId: string): Promise<Proposal[]> {
  const { data } = await supabase
    .from("proposals")
    .select("id, org_id, project_id, estimate_id, recipient_contact_id, number, title, summary, terms, status, total_cents, token_hash, valid_until, sent_at, accepted_at, signature_required, created_at, updated_at")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })

  return data ?? []
}

async function getDraws(supabase: any, orgId: string, projectId: string): Promise<DrawSchedule[]> {
  const { data } = await supabase
    .from("draw_schedules")
    .select("*")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .order("draw_number", { ascending: true })

  return data ?? []
}

async function getScheduleItemCount(supabase: any, orgId: string, projectId: string): Promise<number> {
  const { count } = await supabase
    .from("schedule_items")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("project_id", projectId)

  return count ?? 0
}

async function getPortalTokens(supabase: any, projectId: string): Promise<PortalAccessToken[]> {
  const { data } = await supabase
    .from("portal_access_tokens")
    .select("id, project_id, portal_type, contact_id, label, expires_at, revoked_at, pin_required, created_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })

  return data ?? []
}

async function getApprovedChangeOrderTotal(supabase: any, orgId: string, projectId: string): Promise<number> {
  const { data } = await supabase
    .from("change_orders")
    .select("total_cents")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("status", "approved")

  return (data ?? []).reduce((sum: number, row: any) => sum + (row.total_cents ?? 0), 0)
}

async function getBudgetSummary(orgId: string, projectId: string) {
  try {
    const budgetData = await getBudgetWithActuals({ projectId, orgId })
    if (!budgetData) return null

    const adjustedBudget = budgetData.adjustedBudgetCents ?? budgetData.originalBudgetCents ?? 0
    const totalCommitted = budgetData.totalCommittedCents ?? 0
    const totalActual = budgetData.totalActualCents ?? 0
    const totalInvoiced = budgetData.totalInvoicedCents ?? 0
    const variance = adjustedBudget > 0 ? totalActual : 0
    const variancePercent = adjustedBudget > 0 ? Math.round((totalActual / adjustedBudget) * 100) : 0
    const grossMarginPercent = totalInvoiced > 0 ? Math.round(((totalInvoiced - totalActual) / totalInvoiced) * 100) : 0

    return {
      adjustedBudgetCents: adjustedBudget,
      totalCommittedCents: totalCommitted,
      totalActualCents: totalActual,
      totalInvoicedCents: totalInvoiced,
      varianceCents: variance,
      variancePercent,
      grossMarginPercent,
      trendPercent: budgetData.trendPercent,
      status: variancePercent > 100 ? "over" : variancePercent > 90 ? "warning" : "ok",
    } as const
  } catch (error) {
    console.warn("Failed to get budget summary", error)
    return null
  }
}
