import "server-only"

import { readAllRows } from "@/lib/land/paging"
import { calendarDaysBetween, normalizeWorkGroupKey } from "@/lib/starts/even-flow-math"
import { getProjectReadScopeForUser } from "@/lib/services/authorization"
import { requireOrgContext, type OrgServiceContext } from "@/lib/services/context"
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
  /** Photos uploaded after the day of the last daily log, within PHOTO_LOOKBACK_DAYS. */
  newPhotoCount: number
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

type AssignedHouseRow = { id: string; start_date: string | null; lot: unknown }

/**
 * A superintendent assignment is a pointer, not a grant: it outlives a move to
 * another division or removal from the job. The houses list keeps only the
 * assigned houses the VIEWER may still read — division scope, and project
 * membership for an assigned-only member — so a stale assignment drops out.
 */
function assignedHousesQuery(
  context: OrgServiceContext,
  scope: Awaited<ReturnType<typeof getProjectReadScopeForUser>>,
  select: string,
  userId: string,
  divisionId?: string,
) {
  const relations = scope.projectMembershipRequired ? ",access:project_members!project_members_project_id_fkey!inner()" : ""
  const columns: string = `${select}${relations}`
  let query = context.supabase.from("projects").select(columns, { count: "exact" })
    .eq("org_id", context.orgId).eq("phase", "delivery").eq("superintendent_id", userId)
    .eq("property_type", "production").eq("status", "active")
  if (divisionId) query = query.eq("division_id", divisionId)
  if (scope.divisionIds) query = query.in("division_id", scope.divisionIds)
  if (scope.projectMembershipRequired) {
    query = query.eq("access.org_id", context.orgId).eq("access.user_id", context.userId).eq("access.status", "active")
  }
  return query
}

/** Rows read per fact for one page of houses; hitting it is an error, never a quiet undercount. */
const ROLLUP_ROW_CAP = 100_000
/** Photos older than this are history, not news, even on a home that has never logged. */
export const PHOTO_LOOKBACK_DAYS = 7
/** PostgREST puts `in()` filters in the URL. */
const PROJECT_ID_BATCH = 200

async function readComplete<Row>(
  label: string,
  read: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>,
  cap = ROLLUP_ROW_CAP,
): Promise<Row[]> {
  const { rows, truncated } = await readAllRows<Row>(read, { cap, label: `Failed to load ${label}` })
  if (truncated) throw new Error(`Too many ${label} to total accurately; narrow the division and retry`)
  return rows
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
  const scope = await getProjectReadScopeForUser({ orgId: context.orgId, userId: context.userId })
  if (scope.divisionIds?.length === 0) return { houses: [], total: 0 }
  const projectQuery = assignedHousesQuery(context, scope, `
    id,start_date,metadata,
    lot:lots!lots_project_id_fkey(id,lot_number,block,community_id,house_plan_id,house_plan_elevation_id,
      community:communities(name),plan:house_plans(code),elevation:house_plan_elevations(code))
  `, userId, opts.divisionId)
  const { data: projects, error, count } = await projectQuery.order("start_date", { ascending: true, nullsFirst: false })
    .range((page - 1) * pageSize, page * pageSize - 1).returns<AssignedHouseRow[]>()
  if (error) throw new Error(`Failed to load assigned houses: ${error.message}`)
  const projectIds = (projects ?? []).map((project) => project.id)
  if (!projectIds.length) return { houses: [], total: count ?? 0 }
  const today = new Date().toISOString().slice(0, 10)
  const photoSince = new Date(Date.now() - PHOTO_LOOKBACK_DAYS * 86_400_000).toISOString()
  const [scheduleRows, punchRows, taskRows, logRows, photoRows] = await Promise.all([
    readComplete("schedule items", (from, to) => context.supabase.from("schedule_items").select("id,project_id,status,progress,phase,start_date,end_date")
      .eq("org_id", context.orgId).in("project_id", projectIds).order("id").range(from, to)),
    readComplete("punch items", (from, to) => context.supabase.from("punch_items").select("id,project_id,status")
      .eq("org_id", context.orgId).in("project_id", projectIds).order("id").range(from, to)),
    readComplete("tasks", (from, to) => context.supabase.from("tasks").select("id,project_id,status")
      .eq("org_id", context.orgId).in("project_id", projectIds).order("id").range(from, to)),
    readComplete("daily logs", (from, to) => context.supabase.from("daily_logs").select("id,project_id,log_date")
      .eq("org_id", context.orgId).in("project_id", projectIds).order("log_date", { ascending: false }).order("id").range(from, to)),
    readComplete("photos", (from, to) => context.supabase.from("project_photo_entries").select("file_id,project_id,uploaded_at")
      .eq("org_id", context.orgId).in("project_id", projectIds).gte("uploaded_at", photoSince).order("file_id").range(from, to)),
  ])
  return {
    total: count ?? 0,
    houses: (projects ?? []).map((project) => {
      const lot = one(project.lot)
      const community = one(lot?.community)
      const plan = one(lot?.plan)
      const elevation = one(lot?.elevation)
      const items = scheduleRows.filter((item) => item.project_id === project.id)
      const open = items.filter((item) => item.status !== "completed")
      const current = [...open].sort((a, b) => String(a.start_date ?? "9999").localeCompare(String(b.start_date ?? "9999")))[0]
      const endDates = items.flatMap((item) => item.end_date ? [item.end_date] : [])
      const targetEnd = endDates.sort().at(-1)
      const lastLogDate = logRows.find((log) => log.project_id === project.id)?.log_date ?? null
      return {
        projectId: project.id, lotLabel: lotLabel(lot), communityId: String(lot?.community_id ?? ""),
        communityName: String(community?.name ?? "Community"), planCode: typeof plan?.code === "string" ? plan.code : null,
        elevationCode: typeof elevation?.code === "string" ? elevation.code : null, startDate: project.start_date,
        targetDays: project.start_date && targetEnd ? calendarDaysBetween(project.start_date, targetEnd) : null,
        daysInProgress: project.start_date ? calendarDaysBetween(project.start_date, today) : 0,
        percentComplete: items.length ? Math.round(items.reduce((sum, item) => sum + Number(item.progress ?? (item.status === "completed" ? 100 : 0)), 0) / items.length) : 0,
        currentPhase: current?.phase ?? null,
        lateCount: open.filter((item) => item.end_date && item.end_date < today).length,
        openPunch: punchRows.filter((item) => item.project_id === project.id && !["closed", "completed"].includes(item.status)).length,
        openTasks: taskRows.filter((item) => item.project_id === project.id && item.status !== "completed").length,
        lastDailyLogDate: lastLogDate,
        newPhotoCount: photoRows.filter((photo) => photo.project_id === project.id && (!lastLogDate || photo.uploaded_at.slice(0, 10) > lastLogDate)).length,
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
  const scope = await getProjectReadScopeForUser({ orgId: context.orgId, userId: context.userId })
  if (scope.divisionIds?.length === 0) return []
  const projectQuery = assignedHousesQuery(context, scope, `
    id,lot:lots!lots_project_id_fkey(lot_number,block,community:communities(name))
  `, userId, opts.divisionId)
  const projects = await readComplete("assigned houses", (from, to) =>
    projectQuery.order("id").range(from, to).returns<Pick<AssignedHouseRow, "id" | "lot">[]>(), 5_000)
  const projectIds = projects.map((project) => project.id)
  if (!projectIds.length) return []
  const start = new Date()
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + (opts.window === "today" ? 0 : opts.window === "week" ? 7 : 14))
  const startDate = start.toISOString().slice(0, 10)
  const endDate = end.toISOString().slice(0, 10)
  // Project ids ride in the URL, so a long assignment list is read in batches.
  const batches = Array.from({ length: Math.ceil(projectIds.length / PROJECT_ID_BATCH) }, (_, index) => projectIds.slice(index * PROJECT_ID_BATCH, (index + 1) * PROJECT_ID_BATCH))
  const data = (await Promise.all(batches.map((batch) => readComplete("house work", (from, to) => context.supabase.from("schedule_items").select("id,project_id,name,trade,status,start_date,end_date")
    .eq("org_id", context.orgId).in("project_id", batch).not("start_date", "is", null)
    .lte("start_date", endDate).gte("end_date", startDate).neq("status", "completed").order("start_date").order("id").range(from, to), 20_000)))).flat()
    .sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)))
  const projectById = new Map(projects.map((project) => [project.id, project]))
  const groups = new Map<string, MyHouseTaskGroupDTO>()
  for (const item of data) {
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

/**
 * Being the house's superintendent is not itself a grant — the assignment
 * outlives a division move or removal from the job. Completing work is
 * `schedule.edit` on the item's project, checked by `updateScheduleItem` with
 * membership and division scope, for the superintendent like anyone else.
 */
export async function completeMyHouseScheduleItem(scheduleItemId: string, orgId?: string, progress = 100) {
  await updateScheduleItem({ itemId: scheduleItemId, input: { status: "completed", progress }, orgId })
}
