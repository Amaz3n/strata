import "server-only"

import { calendarDaysBetween, normalizeWorkGroupKey } from "@/lib/starts/even-flow-math"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { updateScheduleItem } from "@/lib/services/schedule"

export interface MyHouseDTO {
  projectId: string
  lotLabel: string
  communityId: string
  communityName: string
  planCode: string | null
  elevationCode: string | null
  startDate: string | null
  targetDays: number | null
  daysInProgress: number
  percentComplete: number
  currentPhase: string | null
  lateCount: number
  openPunch: number
  openTasks: number
  lastDailyLogDate: string | null
}

export interface MyHouseTaskGroupDTO {
  groupKey: string
  groupLabel: string
  items: Array<{
    scheduleItemId: string
    projectId: string
    lotLabel: string
    communityName: string
    name: string
    trade: string | null
    status: string
    startDate: string | null
    endDate: string | null
    daysLate: number
  }>
}

function one(value: unknown): Record<string, unknown> | null {
  const row = Array.isArray(value) ? value[0] : value
  return row && typeof row === "object" ? row as Record<string, unknown> : null
}

function lotLabel(lot: Record<string, unknown> | null) {
  if (!lot) return "Lot"
  return lot.block ? `${lot.block}-${lot.lot_number}` : String(lot.lot_number ?? "Lot")
}

export async function listMyHouses(
  opts: { userId?: string; divisionId?: string; page?: number; pageSize?: number } = {},
  orgId?: string,
): Promise<{ houses: MyHouseDTO[]; total: number }> {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.read", context)
  const userId = opts.userId ?? context.userId
  const page = Math.max(1, opts.page ?? 1)
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 25))
  let projectQuery = context.supabase.from("projects").select(`
    id,start_date,metadata,
    lot:lots!lots_project_id_fkey(id,lot_number,block,community_id,house_plan_id,house_plan_elevation_id,
      community:communities(name),plan:house_plans(code),elevation:house_plan_elevations(code))
  `, { count: "exact" }).eq("org_id", context.orgId).eq("superintendent_id", userId)
    .eq("property_type", "production").eq("status", "active")
  if (opts.divisionId) projectQuery = projectQuery.eq("division_id", opts.divisionId)
  const { data: projects, error, count } = await projectQuery.order("start_date", { ascending: true, nullsFirst: false })
    .range((page - 1) * pageSize, page * pageSize - 1)
  if (error) throw new Error(`Failed to load assigned houses: ${error.message}`)
  const projectIds = (projects ?? []).map((project) => project.id)
  if (!projectIds.length) return { houses: [], total: count ?? 0 }
  const today = new Date().toISOString().slice(0, 10)
  const [schedule, punch, tasks, logs] = await Promise.all([
    context.supabase.from("schedule_items").select("project_id,status,progress,phase,start_date,end_date")
      .eq("org_id", context.orgId).in("project_id", projectIds).limit(5000),
    context.supabase.from("punch_items").select("project_id,status").eq("org_id", context.orgId).in("project_id", projectIds).limit(5000),
    context.supabase.from("tasks").select("project_id,status").eq("org_id", context.orgId).in("project_id", projectIds).limit(5000),
    context.supabase.from("daily_logs").select("project_id,log_date").eq("org_id", context.orgId).in("project_id", projectIds).order("log_date", { ascending: false }).limit(5000),
  ])
  for (const result of [schedule, punch, tasks, logs]) {
    if (result.error) throw new Error(`Failed to load My Houses rollups: ${result.error.message}`)
  }
  return {
    total: count ?? 0,
    houses: (projects ?? []).map((project) => {
      const lot = one(project.lot)
      const community = one(lot?.community)
      const plan = one(lot?.plan)
      const elevation = one(lot?.elevation)
      const items = (schedule.data ?? []).filter((item) => item.project_id === project.id)
      const open = items.filter((item) => item.status !== "completed")
      const current = [...open].sort((a, b) => String(a.start_date ?? "9999").localeCompare(String(b.start_date ?? "9999")))[0]
      const endDates = items.flatMap((item) => item.end_date ? [item.end_date] : [])
      const targetEnd = endDates.sort().at(-1)
      return {
        projectId: project.id, lotLabel: lotLabel(lot), communityId: String(lot?.community_id ?? ""),
        communityName: String(community?.name ?? "Community"), planCode: typeof plan?.code === "string" ? plan.code : null,
        elevationCode: typeof elevation?.code === "string" ? elevation.code : null, startDate: project.start_date,
        targetDays: project.start_date && targetEnd ? calendarDaysBetween(project.start_date, targetEnd) : null,
        daysInProgress: project.start_date ? calendarDaysBetween(project.start_date, today) : 0,
        percentComplete: items.length ? Math.round(items.reduce((sum, item) => sum + Number(item.progress ?? (item.status === "completed" ? 100 : 0)), 0) / items.length) : 0,
        currentPhase: current?.phase ?? null,
        lateCount: open.filter((item) => item.end_date && item.end_date < today).length,
        openPunch: (punch.data ?? []).filter((item) => item.project_id === project.id && !["closed", "completed"].includes(item.status)).length,
        openTasks: (tasks.data ?? []).filter((item) => item.project_id === project.id && item.status !== "completed").length,
        lastDailyLogDate: (logs.data ?? []).find((log) => log.project_id === project.id)?.log_date ?? null,
      }
    }),
  }
}

export async function listMyHouseWork(
  opts: { window: "today" | "week" | "twoweek"; userId?: string; divisionId?: string },
  orgId?: string,
): Promise<MyHouseTaskGroupDTO[]> {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.read", context)
  const userId = opts.userId ?? context.userId
  let projectQuery = context.supabase.from("projects").select(`
    id,lot:lots!lots_project_id_fkey(lot_number,block,community:communities(name))
  `).eq("org_id", context.orgId).eq("superintendent_id", userId).eq("property_type", "production").eq("status", "active")
  if (opts.divisionId) projectQuery = projectQuery.eq("division_id", opts.divisionId)
  const { data: projects, error: projectError } = await projectQuery.limit(100)
  if (projectError) throw new Error(`Failed to load assigned houses: ${projectError.message}`)
  const projectIds = (projects ?? []).map((project) => project.id)
  if (!projectIds.length) return []
  const start = new Date()
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + (opts.window === "today" ? 0 : opts.window === "week" ? 7 : 14))
  const startDate = start.toISOString().slice(0, 10)
  const endDate = end.toISOString().slice(0, 10)
  const { data, error } = await context.supabase.from("schedule_items").select("id,project_id,name,trade,status,start_date,end_date")
    .eq("org_id", context.orgId).in("project_id", projectIds).not("start_date", "is", null)
    .lte("start_date", endDate).gte("end_date", startDate).neq("status", "completed").order("start_date").limit(500)
  if (error) throw new Error(`Failed to load house work: ${error.message}`)
  const projectById = new Map((projects ?? []).map((project) => [project.id, project]))
  const groups = new Map<string, MyHouseTaskGroupDTO>()
  for (const item of data ?? []) {
    const key = normalizeWorkGroupKey(item.name)
    const project = projectById.get(item.project_id)
    const lot = one(project?.lot)
    const community = one(lot?.community)
    const group: MyHouseTaskGroupDTO = groups.get(key) ?? { groupKey: key, groupLabel: item.name.trim(), items: [] }
    group.items.push({
      scheduleItemId: item.id, projectId: item.project_id, lotLabel: lotLabel(lot),
      communityName: String(community?.name ?? "Community"), name: item.name, trade: item.trade,
      status: item.status, startDate: item.start_date, endDate: item.end_date,
      daysLate: item.end_date && item.end_date < startDate ? calendarDaysBetween(item.end_date, startDate) : 0,
    })
    groups.set(key, group)
  }
  return Array.from(groups.values()).sort((a, b) => b.items.length - a.items.length || a.groupLabel.localeCompare(b.groupLabel))
}

export async function completeMyHouseScheduleItem(scheduleItemId: string, orgId?: string, progress = 100) {
  const context = await requireOrgContext(orgId)
  const { data: item, error } = await context.supabase.from("schedule_items").select("id,project_id")
    .eq("org_id", context.orgId).eq("id", scheduleItemId).maybeSingle()
  if (error || !item) throw new Error("Schedule item not found")
  const { data: project } = await context.supabase.from("projects").select("superintendent_id").eq("org_id", context.orgId).eq("id", item.project_id).maybeSingle()
  if (project?.superintendent_id !== context.userId) await requirePermission("schedule.edit", context)
  await updateScheduleItem({ itemId: scheduleItemId, input: { status: "completed", progress }, orgId: context.orgId })
}
