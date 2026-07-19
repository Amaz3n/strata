import "server-only"

import { addWeeks, calendarDaysBetween, median, mondayOfIsoWeek, percentile, releaseSlotVariance } from "@/lib/starts/even-flow-math"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { slotSchema } from "@/lib/validation/starts"

export interface ReleaseBoardWeekDTO {
  weekStart: string
  targetStarts: number
  slotNoteId: string | null
  released: number
  targeted: number
  variance: number
}

export interface ReleaseBoardCommunityDTO {
  communityId: string
  communityName: string
  weeks: ReleaseBoardWeekDTO[]
  precon: { open: number; ready: number; attention: number; oldestAgeDays: number }
  underConstruction: number
}

function settingsNumber(settings: unknown, key: string, fallback: number, max: number) {
  if (!settings || typeof settings !== "object") return fallback
  const value = Reflect.get(settings, key)
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(0, Math.trunc(value))) : fallback
}

function daysOld(createdAt: string) {
  return Math.max(0, Math.floor((Date.now() - Date.parse(createdAt)) / 86_400_000))
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

export async function getReleaseBoard(
  opts: { communityId?: string; divisionId?: string; weeksBack?: number; weeksAhead?: number } = {},
  orgId?: string,
): Promise<ReleaseBoardCommunityDTO[]> {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.read", context)
  let communitiesQuery = context.supabase.from("communities").select("id,name,settings")
    .eq("org_id", context.orgId).eq("status", "active").is("archived_at", null).order("name").limit(50)
  if (opts.communityId) communitiesQuery = communitiesQuery.eq("id", opts.communityId)
  if (opts.divisionId) communitiesQuery = communitiesQuery.eq("division_id", opts.divisionId)
  const { data: communities, error } = await communitiesQuery
  if (error) throw new Error(`Failed to load communities: ${error.message}`)
  await Promise.all((communities ?? []).map((community) => ensureSlotsWithClient(createServiceSupabaseClient(), context.orgId, community)))
  const communityIds = (communities ?? []).map((community) => community.id)
  if (!communityIds.length) return []
  const currentWeek = mondayOfIsoWeek(new Date())
  const from = addWeeks(currentWeek, -Math.min(52, Math.max(0, opts.weeksBack ?? 4)))
  const to = addWeeks(currentWeek, Math.min(104, Math.max(1, opts.weeksAhead ?? 12)))
  const [slotsResult, packagesResult, lotsResult] = await Promise.all([
    context.supabase.from("community_release_slots").select("id,community_id,week_start,target_starts,notes")
      .eq("org_id", context.orgId).in("community_id", communityIds).gte("week_start", from).lte("week_start", to).order("week_start"),
    context.supabase.from("start_packages").select("id,community_id,status,target_week,created_at")
      .eq("org_id", context.orgId).in("community_id", communityIds).limit(10_000),
    context.supabase.from("lots").select("id,community_id,status").eq("org_id", context.orgId).in("community_id", communityIds).eq("status", "started").limit(10_000),
  ])
  for (const result of [slotsResult, packagesResult, lotsResult]) {
    if (result.error) throw new Error(`Failed to load release board: ${result.error.message}`)
  }
  const today = new Date().toISOString().slice(0, 10)
  return (communities ?? []).map((community) => {
    const packages = (packagesResult.data ?? []).filter((pkg) => pkg.community_id === community.id)
    const weeks = (slotsResult.data ?? []).filter((slot) => slot.community_id === community.id).map((slot) => {
      const targeted = packages.filter((pkg) => pkg.target_week === slot.week_start && pkg.status !== "cancelled").length
      const released = packages.filter((pkg) => pkg.target_week === slot.week_start && pkg.status === "released").length
      const target = Number(slot.target_starts)
      return { weekStart: slot.week_start, targetStarts: target, slotNoteId: slot.notes ? slot.id : null, released, targeted, variance: releaseSlotVariance({ weekStart: slot.week_start, today, target, released, targeted }) }
    })
    const precon = packages.filter((pkg) => ["open", "ready", "attention"].includes(pkg.status))
    return {
      communityId: community.id, communityName: community.name, weeks,
      precon: {
        open: precon.filter((pkg) => pkg.status === "open").length,
        ready: precon.filter((pkg) => pkg.status === "ready").length,
        attention: precon.filter((pkg) => pkg.status === "attention").length,
        oldestAgeDays: precon.reduce((oldest, pkg) => Math.max(oldest, daysOld(pkg.created_at)), 0),
      },
      underConstruction: (lotsResult.data ?? []).filter((lot) => lot.community_id === community.id).length,
    }
  })
}

export interface CycleTimeRow {
  groupKey: string
  groupLabel: string
  count: number
  medianDays: number
  p80Days: number
  trendDelta: number
}

export async function getCycleTimeReport(
  opts: { groupBy: "plan" | "community" | "superintendent"; from?: string; to?: string; communityId?: string },
  orgId?: string,
): Promise<CycleTimeRow[]> {
  const context = await requireOrgContext(orgId)
  await requirePermission("report.read", context)
  let query = context.supabase.from("start_packages").select(`
    actual_start_date,community_id,project_id,
    lot:lots(house_plan_id,plan:house_plans(id,name,code)),community:communities(name),
    project:projects(end_date,status,superintendent_id,superintendent:app_users!projects_superintendent_id_fkey(full_name))
  `).eq("org_id", context.orgId).eq("status", "released").not("actual_start_date", "is", null).limit(10_000)
  if (opts.communityId) query = query.eq("community_id", opts.communityId)
  if (opts.from) query = query.gte("actual_start_date", opts.from)
  if (opts.to) query = query.lte("actual_start_date", opts.to)
  const { data, error } = await query
  if (error) throw new Error(`Failed to load cycle-time report: ${error.message}`)
  const groups = new Map<string, { label: string; days: number[] }>()
  for (const row of data ?? []) {
    const project = Array.isArray(row.project) ? row.project[0] : row.project
    if (!project?.end_date || project.status !== "completed") continue
    const community = Array.isArray(row.community) ? row.community[0] : row.community
    const lotJoin = Array.isArray(row.lot) ? row.lot[0] : row.lot
    const plan = Array.isArray(lotJoin?.plan) ? lotJoin.plan[0] : lotJoin?.plan
    const superintendent = Array.isArray(project.superintendent) ? project.superintendent[0] : project.superintendent
    const key = opts.groupBy === "community" ? row.community_id : opts.groupBy === "plan" ? plan?.id : project.superintendent_id
    const label = opts.groupBy === "community" ? community?.name : opts.groupBy === "plan" ? [plan?.code, plan?.name].filter(Boolean).join(" — ") : superintendent?.full_name
    if (!key || !label) continue
    const group: { label: string; days: number[] } = groups.get(key) ?? { label, days: [] }
    group.days.push(calendarDaysBetween(row.actual_start_date, project.end_date))
    groups.set(key, group)
  }
  return Array.from(groups, ([groupKey, group]) => ({ groupKey, groupLabel: group.label, count: group.days.length, medianDays: median(group.days), p80Days: percentile(group.days, 0.8), trendDelta: 0 }))
}

export async function getEvenFlowAdherence(
  opts: { communityId?: string; from: string; to: string },
  orgId?: string,
) {
  const context = await requireOrgContext(orgId)
  await requirePermission("report.read", context)
  let slotsQuery = context.supabase.from("community_release_slots").select("community_id,week_start,target_starts")
    .eq("org_id", context.orgId).gte("week_start", opts.from).lte("week_start", opts.to)
  let startsQuery = context.supabase.from("start_packages").select("community_id,target_week")
    .eq("org_id", context.orgId).eq("status", "released").gte("target_week", opts.from).lte("target_week", opts.to)
  if (opts.communityId) { slotsQuery = slotsQuery.eq("community_id", opts.communityId); startsQuery = startsQuery.eq("community_id", opts.communityId) }
  const [slots, starts] = await Promise.all([slotsQuery, startsQuery])
  if (slots.error || starts.error) throw new Error("Failed to load even-flow adherence")
  return (slots.data ?? []).map((slot) => ({
    weekStart: slot.week_start, communityId: slot.community_id, plannedStarts: Number(slot.target_starts),
    actualStarts: (starts.data ?? []).filter((start) => start.community_id === slot.community_id && start.target_week === slot.week_start).length,
    plannedClosings: null, actualClosings: 0,
  }))
}

export async function getWipCounts(opts: { divisionId?: string } = {}, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("report.read", context)
  let communitiesQuery = context.supabase.from("communities").select("id,name").eq("org_id", context.orgId).eq("status", "active").limit(50)
  if (opts.divisionId) communitiesQuery = communitiesQuery.eq("division_id", opts.divisionId)
  const { data: communities, error } = await communitiesQuery
  if (error) throw new Error(`Failed to load WIP communities: ${error.message}`)
  const ids = (communities ?? []).map((community) => community.id)
  if (!ids.length) return []
  const [packages, lots] = await Promise.all([
    context.supabase.from("start_packages").select("community_id,status").eq("org_id", context.orgId).in("community_id", ids).limit(10_000),
    context.supabase.from("lots").select("community_id,status").eq("org_id", context.orgId).in("community_id", ids).eq("status", "started").limit(10_000),
  ])
  return (communities ?? []).map((community) => {
    const scoped = (packages.data ?? []).filter((pkg) => pkg.community_id === community.id)
    return { communityId: community.id, communityName: community.name, precon: scoped.filter((pkg) => ["open", "ready", "attention"].includes(pkg.status)).length, underConstruction: (lots.data ?? []).filter((lot) => lot.community_id === community.id).length, readyBacklog: scoped.filter((pkg) => pkg.status === "ready").length, attention: scoped.filter((pkg) => pkg.status === "attention").length }
  })
}

export async function listReleasedStartMarkers(projectIds: string[], orgId?: string) {
  if (!projectIds.length) return new Map<string, string>()
  const context = await requireOrgContext(orgId)
  await requirePermission("schedule.read", context)
  const { data, error } = await context.supabase.from("start_packages")
    .select("project_id,actual_start_date").eq("org_id", context.orgId).eq("status", "released")
    .in("project_id", projectIds.slice(0, 500)).not("actual_start_date", "is", null).limit(500)
  if (error) throw new Error(`Failed to load portfolio start markers: ${error.message}`)
  return new Map((data ?? []).flatMap((row) => row.project_id && row.actual_start_date ? [[row.project_id, row.actual_start_date] as const] : []))
}

export async function getLateTaskHeatmap(opts: { communityId?: string; superintendentId?: string } = {}, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("report.read", context)
  let projectsQuery = context.supabase.from("projects").select("id")
    .eq("org_id", context.orgId).eq("property_type", "production").eq("status", "active").limit(500)
  if (opts.superintendentId) projectsQuery = projectsQuery.eq("superintendent_id", opts.superintendentId)
  const { data: projects } = await projectsQuery
  let projectIds = (projects ?? []).map((project) => project.id)
  if (opts.communityId && projectIds.length) {
    const { data: lots } = await context.supabase.from("lots").select("project_id").eq("org_id", context.orgId).eq("community_id", opts.communityId).in("project_id", projectIds)
    projectIds = (lots ?? []).flatMap((lot) => lot.project_id ? [lot.project_id] : [])
  }
  if (!projectIds.length) return []
  const [items, lots] = await Promise.all([
    context.supabase.from("schedule_items").select("project_id,phase,end_date,status").eq("org_id", context.orgId).in("project_id", projectIds).lt("end_date", new Date().toISOString().slice(0, 10)).neq("status", "completed").limit(10_000),
    context.supabase.from("lots").select("project_id,lot_number,block").eq("org_id", context.orgId).in("project_id", projectIds),
  ])
  const today = new Date().toISOString().slice(0, 10)
  const groups = new Map<string, { projectId: string; phase: string | null; lateCount: number; maxDaysLate: number }>()
  for (const item of items.data ?? []) {
    const key = `${item.project_id}:${item.phase ?? ""}`
    const current = groups.get(key) ?? { projectId: item.project_id, phase: item.phase, lateCount: 0, maxDaysLate: 0 }
    current.lateCount += 1
    current.maxDaysLate = Math.max(current.maxDaysLate, calendarDaysBetween(item.end_date, today))
    groups.set(key, current)
  }
  return Array.from(groups.values()).map((group) => {
    const lot = (lots.data ?? []).find((row) => row.project_id === group.projectId)
    return { ...group, lotLabel: lot?.block ? `${lot.block}-${lot.lot_number}` : lot?.lot_number ?? "Lot" }
  })
}
