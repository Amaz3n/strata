import "server-only"

import { addWeeks, calendarDaysBetween, cycleTrendDelta, median, mondayOfIsoWeek, percentile } from "@/lib/starts/even-flow-math"
import { recordAudit } from "@/lib/services/audit"
import {
  getDivisionAccessForUser,
  getDivisionScopedProjectIds,
} from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { slotSchema } from "@/lib/validation/starts"

function settingsNumber(settings: unknown, key: string, fallback: number, max: number) {
  if (!settings || typeof settings !== "object") return fallback
  const value = Reflect.get(settings, key)
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(0, Math.trunc(value))) : fallback
}

async function ensureSlotsWithClient(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  orgId: string,
  community: { id: string; settings: unknown },
) {
  const target = settingsNumber(community.settings, "starts_per_week", 2, 20)
  const horizon = settingsNumber(community.settings, "release_horizon_weeks", 16, 104)
  const current = mondayOfIsoWeek(new Date())
  const rows = Array.from({ length: horizon }, (_, index) => ({
    org_id: orgId, community_id: community.id, week_start: addWeeks(current, index), target_starts: target,
  }))
  const { error } = await supabase.from("community_release_slots").upsert(rows, { onConflict: "community_id,week_start", ignoreDuplicates: true })
  if (error) throw new Error(`Failed to seed release slots: ${error.message}`)
}

export async function ensureReleaseSlots(communityId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.read", context)
  const { data: community, error } = await context.supabase.from("communities").select("id,settings")
    .eq("org_id", context.orgId).eq("id", communityId).maybeSingle()
  if (error || !community) throw new Error("Community not found")
  await ensureSlotsWithClient(createServiceSupabaseClient(), context.orgId, community)
}

/**
 * The start target for one community-week, seeding it from the community's
 * cadence when the background seeder has not reached that far out yet.
 *
 * A missing slot row is NOT a zero-start week. Reading it as one made the
 * over-target confirmation fire on every release beyond the 16-week seeded
 * horizon, which trains coordinators to click through the one dialog that is
 * supposed to mean something. A community that genuinely wants no starts sets
 * `starts_per_week: 0` and gets a target of 0 — a real constraint, honoured.
 *
 * Callers must have already permission-checked; this runs on the service client
 * so a `start.release` holder without `start.slots` can still be measured.
 */
export async function getReleaseSlotTarget(orgId: string, communityId: string, weekStart: string): Promise<number> {
  const supabase = createServiceSupabaseClient()
  const { data: slot, error } = await supabase.from("community_release_slots").select("target_starts")
    .eq("org_id", orgId).eq("community_id", communityId).eq("week_start", weekStart).maybeSingle()
  if (error) throw new Error(`Failed to load the week's start target: ${error.message}`)
  if (slot) return Number(slot.target_starts)
  const { data: community, error: communityError } = await supabase.from("communities").select("settings")
    .eq("org_id", orgId).eq("id", communityId).maybeSingle()
  if (communityError || !community) throw new Error("Community not found")
  const target = settingsNumber(community.settings, "starts_per_week", 2, 20)
  const { error: seedError } = await supabase.from("community_release_slots")
    .upsert({ org_id: orgId, community_id: communityId, week_start: weekStart, target_starts: target }, { onConflict: "community_id,week_start", ignoreDuplicates: true })
  if (seedError) throw new Error(`Failed to seed the week's start target: ${seedError.message}`)
  return target
}

export async function ensureReleaseSlotsForActiveCommunities(limit = 200) {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase.from("communities").select("id,org_id,settings")
    .eq("status", "active").is("archived_at", null).order("updated_at").limit(Math.min(200, Math.max(1, limit)))
  if (error) throw new Error(`Failed to load slot communities: ${error.message}`)
  await Promise.all((data ?? []).map((community) => ensureSlotsWithClient(supabase, community.org_id, community)))
}

export async function setReleaseSlot(
  communityId: string,
  weekStart: string,
  input: { targetStarts: number; notes?: string | null },
  orgId?: string,
) {
  const parsed = slotSchema.parse({ weekStart, ...input })
  const context = await requireOrgContext(orgId)
  await requirePermission("start.slots", context)
  const { data: community } = await context.supabase.from("communities").select("id").eq("org_id", context.orgId).eq("id", communityId).maybeSingle()
  if (!community) throw new Error("Community not found")
  const { data, error } = await context.supabase.from("community_release_slots").upsert({
    org_id: context.orgId, community_id: communityId, week_start: parsed.weekStart,
    target_starts: parsed.targetStarts, notes: parsed.notes ?? null,
  }, { onConflict: "community_id,week_start" }).select("*").single()
  if (error) throw new Error(`Failed to update release slot: ${error.message}`)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "release_slot.updated", entityType: "community_release_slot", entityId: data.id, payload: { community_id: communityId, week_start: parsed.weekStart, target_starts: parsed.targetStarts } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "community_release_slot", entityId: data.id, after: data }),
  ])
}

export interface CommunityReleaseSlotsDTO {
  communityId: string
  communityName: string
  weeks: Array<{ weekStart: string; targetStarts: number }>
}

/**
 * The weekly start capacity each community has committed to, seeding any slots
 * that do not exist yet. Only the target is returned — what actually fills a
 * week is counted from the packages the caller can see, so the meter on the
 * lane can never disagree with the cards under it.
 */
export async function getCommunityReleaseSlots(
  opts: { communityId?: string; divisionId?: string; weeksBack?: number; weeksAhead?: number } = {},
  orgId?: string,
): Promise<CommunityReleaseSlotsDTO[]> {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.read", context)
  const divisionAccess = await getDivisionAccessForUser({
    orgId: context.orgId,
    userId: context.userId,
  })
  if (opts.divisionId && divisionAccess.assignedOnly && !divisionAccess.divisionIds.includes(opts.divisionId)) {
    return []
  }
  let communitiesQuery = context.supabase.from("communities").select("id,name,settings")
    .eq("org_id", context.orgId).eq("status", "active").is("archived_at", null).order("name").limit(50)
  if (opts.communityId) communitiesQuery = communitiesQuery.eq("id", opts.communityId)
  if (opts.divisionId) communitiesQuery = communitiesQuery.eq("division_id", opts.divisionId)
  else if (divisionAccess.assignedOnly) {
    if (divisionAccess.divisionIds.length === 0) return []
    communitiesQuery = communitiesQuery.in("division_id", divisionAccess.divisionIds)
  }
  const { data: communities, error } = await communitiesQuery
  if (error) throw new Error(`Failed to load communities: ${error.message}`)
  await Promise.all((communities ?? []).map((community) => ensureSlotsWithClient(createServiceSupabaseClient(), context.orgId, community)))
  const communityIds = (communities ?? []).map((community) => community.id)
  if (!communityIds.length) return []
  const currentWeek = mondayOfIsoWeek(new Date())
  const from = addWeeks(currentWeek, -Math.min(52, Math.max(0, opts.weeksBack ?? 4)))
  const to = addWeeks(currentWeek, Math.min(104, Math.max(1, opts.weeksAhead ?? 12)))
  const { data: slots, error: slotsError } = await context.supabase.from("community_release_slots")
    .select("community_id,week_start,target_starts")
    .eq("org_id", context.orgId).in("community_id", communityIds)
    .gte("week_start", from).lte("week_start", to).order("week_start")
  if (slotsError) throw new Error(`Failed to load release slots: ${slotsError.message}`)
  return (communities ?? []).map((community) => ({
    communityId: community.id,
    communityName: community.name,
    weeks: (slots ?? [])
      .filter((slot) => slot.community_id === community.id)
      .map((slot) => ({ weekStart: slot.week_start, targetStarts: Number(slot.target_starts) })),
  }))
}

export interface CycleTimeRow {
  groupKey: string
  groupLabel: string
  count: number
  medianDays: number
  p80Days: number
  /**
   * Median of the most recent half minus the earlier half, in days. Negative is
   * improving. Null when there are not enough completed homes to compare —
   * this used to be a hardcoded 0, which reads as a confident "flat".
   */
  trendDelta: number | null
  /** Homes started in this group that have not closed, so are not in the medians. */
  inProgress: number
}

export async function getCycleTimeReport(
  opts: { groupBy: "plan" | "community" | "superintendent"; from?: string; to?: string; communityId?: string; divisionId?: string },
  orgId?: string,
): Promise<CycleTimeRow[]> {
  const context = await requireOrgContext(orgId)
  await requirePermission("report.read", context)
  const divisionAccess = await getDivisionAccessForUser({
    orgId: context.orgId,
    userId: context.userId,
  })
  if (opts.divisionId && divisionAccess.assignedOnly && !divisionAccess.divisionIds.includes(opts.divisionId)) {
    return []
  }
  let query = context.supabase.from("start_packages").select(`
    actual_start_date,community_id,project_id,
    lot:lots(house_plan_id,plan:house_plans(id,name,code)),community:communities!inner(name,division_id),
    project:projects(end_date,status,superintendent_id,superintendent:app_users!projects_superintendent_id_fkey(full_name))
  `).eq("org_id", context.orgId).eq("status", "released").not("actual_start_date", "is", null).limit(10_000)
  if (opts.communityId) query = query.eq("community_id", opts.communityId)
  if (opts.divisionId) query = query.eq("community.division_id", opts.divisionId)
  else if (divisionAccess.assignedOnly) {
    if (divisionAccess.divisionIds.length === 0) return []
    query = query.in("community.division_id", divisionAccess.divisionIds)
  }
  if (opts.from) query = query.gte("actual_start_date", opts.from)
  if (opts.to) query = query.lte("actual_start_date", opts.to)
  const { data, error } = await query
  if (error) throw new Error(`Failed to load cycle-time report: ${error.message}`)
  type CycleGroup = { label: string; completed: Array<{ start: string; days: number }>; inProgress: number }
  const groups = new Map<string, CycleGroup>()
  for (const row of data ?? []) {
    const project = Array.isArray(row.project) ? row.project[0] : row.project
    const community = Array.isArray(row.community) ? row.community[0] : row.community
    const lotJoin = Array.isArray(row.lot) ? row.lot[0] : row.lot
    const plan = Array.isArray(lotJoin?.plan) ? lotJoin.plan[0] : lotJoin?.plan
    const superintendent = Array.isArray(project?.superintendent) ? project.superintendent[0] : project?.superintendent
    const key = opts.groupBy === "community" ? row.community_id : opts.groupBy === "plan" ? plan?.id : project?.superintendent_id
    const label = opts.groupBy === "community" ? community?.name : opts.groupBy === "plan" ? [plan?.code, plan?.name].filter(Boolean).join(" — ") : superintendent?.full_name
    if (!key || !label) continue
    const group: CycleGroup = groups.get(key) ?? { label, completed: [], inProgress: 0 }
    // A cycle can only be measured once a home finishes. Houses still building
    // are counted separately so a young community reads as "nothing has closed
    // yet" rather than as an empty report with no explanation.
    if (project?.end_date && project.status === "completed") {
      group.completed.push({ start: row.actual_start_date, days: calendarDaysBetween(row.actual_start_date, project.end_date) })
    } else {
      group.inProgress += 1
    }
    groups.set(key, group)
  }
  return Array.from(groups)
    .filter(([, group]) => group.completed.length > 0)
    .map(([groupKey, group]) => {
      const days = [...group.completed].sort((a, b) => a.start.localeCompare(b.start)).map((entry) => entry.days)
      return {
        groupKey, groupLabel: group.label, count: days.length,
        medianDays: median(days), p80Days: percentile(days, 0.8),
        trendDelta: cycleTrendDelta(days), inProgress: group.inProgress,
      }
    })
}

export interface EvenFlowWeekDTO {
  weekStart: string
  communityId: string
  plannedStarts: number
  actualStarts: number
  /** Slots a PAST week was paced for and never filled. Zero for future weeks. */
  missedStarts: number
  /** Closings the week is scheduled to hold — the half builders pace against. */
  plannedClosings: number
  actualClosings: number
}

export async function getEvenFlowAdherence(
  opts: { communityId?: string; divisionId?: string; from: string; to: string },
  orgId?: string,
): Promise<EvenFlowWeekDTO[]> {
  const context = await requireOrgContext(orgId)
  await requirePermission("report.read", context)
  const divisionAccess = await getDivisionAccessForUser({
    orgId: context.orgId,
    userId: context.userId,
  })
  if (opts.divisionId && divisionAccess.assignedOnly && !divisionAccess.divisionIds.includes(opts.divisionId)) {
    return []
  }
  let slotsQuery = context.supabase.from("community_release_slots").select("community_id,week_start,target_starts")
    .eq("org_id", context.orgId).gte("week_start", opts.from).lte("week_start", opts.to)
  let startsQuery = context.supabase.from("start_packages").select("community_id,target_week")
    .eq("org_id", context.orgId).eq("status", "released").gte("target_week", opts.from).lte("target_week", opts.to)
  if (opts.communityId) { slotsQuery = slotsQuery.eq("community_id", opts.communityId); startsQuery = startsQuery.eq("community_id", opts.communityId) }
  const scopedDivisionIds = opts.divisionId
    ? [opts.divisionId]
    : divisionAccess.assignedOnly
      ? divisionAccess.divisionIds
      : null
  if (scopedDivisionIds) {
    if (scopedDivisionIds.length === 0) return []
    const { data: communities, error } = await context.supabase.from("communities").select("id").eq("org_id", context.orgId).in("division_id", scopedDivisionIds)
    if (error) throw new Error(`Failed to scope even-flow report: ${error.message}`)
    const ids = (communities ?? []).map((community) => community.id)
    if (!ids.length) return []
    slotsQuery = slotsQuery.in("community_id", ids)
    startsQuery = startsQuery.in("community_id", ids)
  }
  const [slots, starts] = await Promise.all([slotsQuery, startsQuery])
  if (slots.error || starts.error) throw new Error("Failed to load even-flow adherence")
  // The closing half of even-flow is what a builder actually paces against, and
  // it used to be hardcoded `null` / `0`. Both halves are read from the closings
  // ledger here; `scheduled_date` is the plan, `actual_date` on a closed row is
  // what happened.
  const communityIds = Array.from(new Set((slots.data ?? []).map((slot) => slot.community_id as string)))
  const windowEnd = addWeeks(opts.to, 1)
  const closings = communityIds.length
    ? await context.supabase.from("closings").select("community_id,scheduled_date,actual_date,status")
      .eq("org_id", context.orgId).in("community_id", communityIds).neq("status", "cancelled")
      .or(`and(scheduled_date.gte.${opts.from},scheduled_date.lt.${windowEnd}),and(actual_date.gte.${opts.from},actual_date.lt.${windowEnd})`)
      .limit(10_000)
    : { data: [], error: null }
  if (closings.error) throw new Error(`Failed to load closings: ${closings.error.message}`)
  const planned = new Map<string, number>()
  const actual = new Map<string, number>()
  for (const closing of closings.data ?? []) {
    if (closing.scheduled_date) {
      const key = `${closing.community_id}:${mondayOfIsoWeek(closing.scheduled_date)}`
      planned.set(key, (planned.get(key) ?? 0) + 1)
    }
    if (closing.actual_date && closing.status === "closed") {
      const key = `${closing.community_id}:${mondayOfIsoWeek(closing.actual_date)}`
      actual.set(key, (actual.get(key) ?? 0) + 1)
    }
  }
  const currentWeek = mondayOfIsoWeek(new Date())
  return (slots.data ?? []).map((slot) => {
    const plannedStarts = Number(slot.target_starts)
    const actualStarts = (starts.data ?? []).filter((start) => start.community_id === slot.community_id && start.target_week === slot.week_start).length
    const key = `${slot.community_id}:${slot.week_start}`
    return {
      weekStart: slot.week_start, communityId: slot.community_id, plannedStarts, actualStarts,
      missedStarts: slot.week_start < currentWeek ? Math.max(0, plannedStarts - actualStarts) : 0,
      plannedClosings: planned.get(key) ?? 0,
      actualClosings: actual.get(key) ?? 0,
    }
  })
}

export interface MissedStartsDTO {
  /** Weeks measured, ending with the week before this one. */
  weeks: number
  /** Slots those weeks were paced for that never got a house. */
  missed: number
  from: string
  to: string
}

/**
 * Starts a community planned and never made. A week where three of four slots
 * went unfilled produced no signal anywhere — the lane only ever reported what
 * WAS released, so falling behind the drumbeat was invisible until the closing
 * schedule broke months later.
 */
export async function getMissedStarts(
  opts: { communityId?: string; divisionId?: string; weeksBack?: number } = {},
  orgId?: string,
): Promise<MissedStartsDTO> {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.read", context)
  const weeks = Math.min(26, Math.max(1, opts.weeksBack ?? 4))
  const currentWeek = mondayOfIsoWeek(new Date())
  const from = addWeeks(currentWeek, -weeks)
  const to = addWeeks(currentWeek, -1)
  const empty: MissedStartsDTO = { weeks, missed: 0, from, to }
  const divisionAccess = await getDivisionAccessForUser({ orgId: context.orgId, userId: context.userId })
  if (opts.divisionId && divisionAccess.assignedOnly && !divisionAccess.divisionIds.includes(opts.divisionId)) return empty
  let communitiesQuery = context.supabase.from("communities").select("id")
    .eq("org_id", context.orgId).eq("status", "active").is("archived_at", null).limit(200)
  if (opts.communityId) communitiesQuery = communitiesQuery.eq("id", opts.communityId)
  if (opts.divisionId) communitiesQuery = communitiesQuery.eq("division_id", opts.divisionId)
  else if (divisionAccess.assignedOnly) {
    if (divisionAccess.divisionIds.length === 0) return empty
    communitiesQuery = communitiesQuery.in("division_id", divisionAccess.divisionIds)
  }
  const { data: communities, error } = await communitiesQuery
  if (error) throw new Error(`Failed to scope missed starts: ${error.message}`)
  const communityIds = (communities ?? []).map((community) => community.id)
  if (!communityIds.length) return empty
  const [slots, released] = await Promise.all([
    context.supabase.from("community_release_slots").select("community_id,week_start,target_starts")
      .eq("org_id", context.orgId).in("community_id", communityIds).gte("week_start", from).lte("week_start", to),
    context.supabase.from("start_packages").select("community_id,target_week")
      .eq("org_id", context.orgId).in("community_id", communityIds).in("status", ["releasing", "released"])
      .gte("target_week", from).lte("target_week", to).limit(10_000),
  ])
  if (slots.error) throw new Error(`Failed to load release slots: ${slots.error.message}`)
  if (released.error) throw new Error(`Failed to load released starts: ${released.error.message}`)
  const filled = new Map<string, number>()
  for (const row of released.data ?? []) {
    const key = `${row.community_id}:${row.target_week}`
    filled.set(key, (filled.get(key) ?? 0) + 1)
  }
  const missed = (slots.data ?? []).reduce(
    (sum, slot) => sum + Math.max(0, Number(slot.target_starts) - (filled.get(`${slot.community_id}:${slot.week_start}`) ?? 0)),
    0,
  )
  return { ...empty, missed }
}

export async function listReleasedStartMarkers(projectIds: string[], orgId?: string) {
  if (!projectIds.length) return new Map<string, string>()
  const context = await requireOrgContext(orgId)
  await requirePermission("schedule.read", context)
  const authorizedProjectIds = await getDivisionScopedProjectIds({
    orgId: context.orgId,
    userId: context.userId,
    supabase: context.supabase,
  })
  const scopedProjectIds = authorizedProjectIds === null
    ? projectIds
    : projectIds.filter((projectId) => authorizedProjectIds.includes(projectId))
  if (scopedProjectIds.length === 0) return new Map<string, string>()
  const { data, error } = await context.supabase.from("start_packages")
    .select("project_id,actual_start_date").eq("org_id", context.orgId).eq("status", "released")
    .in("project_id", scopedProjectIds.slice(0, 500)).not("actual_start_date", "is", null).limit(500)
  if (error) throw new Error(`Failed to load portfolio start markers: ${error.message}`)
  return new Map((data ?? []).flatMap((row) => row.project_id && row.actual_start_date ? [[row.project_id, row.actual_start_date] as const] : []))
}
