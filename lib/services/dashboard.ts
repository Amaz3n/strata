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
