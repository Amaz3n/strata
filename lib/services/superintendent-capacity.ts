import "server-only"

import { readAllRows } from "@/lib/land/paging"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { getDivisionAccessForUser } from "@/lib/services/authorization"
import { requireAnyPermission, requirePermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { DEFAULT_SUPERINTENDENT_LIMITS, resolveSuperintendentLimits, superintendentLoad, type SuperintendentLimits, type SuperintendentLoad } from "@/lib/starts/superintendent-load"
import { superintendentLimitSchema } from "@/lib/validation/starts"

/** The limits every superintendent without their own follows. */
export async function getSuperintendentDefaultLimits(orgId?: string): Promise<SuperintendentLimits & { configured: boolean }> {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.read", context)
  const { data, error } = await context.supabase.from("superintendent_capacity").select("warn_houses,max_houses")
    .eq("org_id", context.orgId).is("user_id", null).maybeSingle()
  if (error) throw new Error(`Failed to load the superintendent limits: ${error.message}`)
  return data ? { warn: Number(data.warn_houses), max: Number(data.max_houses), configured: true } : { ...DEFAULT_SUPERINTENDENT_LIMITS, configured: false }
}

/**
 * Sets how many houses a superintendent runs before they are stretched (warn)
 * and before another house needs a releaser's reason (max). A null `userId` is
 * the org default. Written by the server only, by someone who can release
 * starts, since the limit is what an assignment is held to.
 */
export async function setSuperintendentLimits(
  input: { userId: string | null; warnHouses: number; maxHouses: number; notes?: string | null },
  orgId?: string,
) {
  const parsed = superintendentLimitSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("start.release", context)
  // The org default is every division's superintendents' limit: only someone whose reach is the whole org sets it.
  if (parsed.userId === null && (await getDivisionAccessForUser({ orgId: context.orgId, userId: context.userId })).assignedOnly) {
    throw new Error("The organization default is set by someone whose reach is the whole organization")
  }
  if (parsed.userId) {
    const { data: member } = await context.supabase.from("memberships").select("id")
      .eq("org_id", context.orgId).eq("user_id", parsed.userId).eq("status", "active").maybeSingle()
    if (!member) throw new Error("Superintendent must be an active organization member.")
  }
  const service = createServiceSupabaseClient()
  let existing = service.from("superintendent_capacity").select("*").eq("org_id", context.orgId)
  existing = parsed.userId === null ? existing.is("user_id", null) : existing.eq("user_id", parsed.userId)
  const { data: before, error: beforeError } = await existing.maybeSingle()
  if (beforeError) throw new Error(`Failed to read the superintendent limits: ${beforeError.message}`)
  const { data, error } = await service.from("superintendent_capacity").upsert({
    org_id: context.orgId, user_id: parsed.userId, warn_houses: parsed.warnHouses, max_houses: parsed.maxHouses,
    notes: parsed.notes ?? null, updated_by: context.userId,
  }, { onConflict: "org_id,user_key" }).select("*").single()
  if (error) throw new Error(`Failed to save the superintendent limits: ${error.message}`)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "superintendent_capacity.updated", entityType: "superintendent_capacity", entityId: data.id, payload: { user_id: parsed.userId, warn_houses: parsed.warnHouses, max_houses: parsed.maxHouses } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: before ? "update" : "insert", entityType: "superintendent_capacity", entityId: data.id, before: before ?? undefined, after: data }),
  ])
}

/** Back to the org default for one person, by removing their own row. */
export async function clearSuperintendentLimits(userId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.release", context)
  const service = createServiceSupabaseClient()
  const { data: before, error: beforeError } = await service.from("superintendent_capacity").select("*")
    .eq("org_id", context.orgId).eq("user_id", userId).maybeSingle()
  if (beforeError) throw new Error(`Failed to read the superintendent limits: ${beforeError.message}`)
  if (!before) return
  const { error } = await service.from("superintendent_capacity").delete().eq("org_id", context.orgId).eq("id", before.id)
  if (error) throw new Error(`Failed to clear the superintendent limits: ${error.message}`)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "superintendent_capacity.cleared", entityType: "superintendent_capacity", entityId: before.id, payload: { user_id: userId } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "delete", entityType: "superintendent_capacity", entityId: before.id, before }),
  ])
}

export interface ProjectSuperintendentLoad {
  projectId: string
  superintendentId: string | null
  /** Houses the superintendent runs now, this one included. */
  activeHouses: number
  warnAt: number
  limit: number
  load: SuperintendentLoad
}

const LOAD_CAP = 50_000

/**
 * Where each house's superintendent stands against their limit, for callers
 * that move work on those houses (a bulk reschedule) and must say when it lands
 * on someone at or past their limit. A house with no superintendent reports
 * `superintendentId: null`. Counts are org-wide and read by the server, like the
 * assignment's, so they agree with it; the caller has already authorized the
 * houses it asks about.
 */
export async function getProjectSuperintendentLoads(projectIds: string[], orgId?: string): Promise<ProjectSuperintendentLoad[]> {
  const context = await requireOrgContext(orgId)
  await requireAnyPermission(["start.read", "schedule.edit"], context)
  const service = createServiceSupabaseClient()
  const ids = Array.from(new Set(projectIds))
  if (!ids.length) return []
  const [projects, capacities, assigned] = await Promise.all([
    // A hundred houses per request keeps the id list inside the request URL.
    Promise.all(Array.from({ length: Math.ceil(ids.length / 100) }, (_, index) => readAllRows((from, to) => service.from("projects").select("id,superintendent_id")
      .eq("org_id", context.orgId).in("id", ids.slice(index * 100, (index + 1) * 100)).order("id").range(from, to), { cap: 101, label: "Failed to load the houses' superintendents" })))
      .then((pages) => ({ rows: pages.flatMap((page) => page.rows), truncated: pages.some((page) => page.truncated) })),
    readAllRows((from, to) => service.from("superintendent_capacity").select("id,user_id,warn_houses,max_houses")
      .eq("org_id", context.orgId).order("id").range(from, to), { cap: LOAD_CAP, label: "Failed to load superintendent limits" }),
    readAllRows((from, to) => service.from("projects").select("id,superintendent_id")
      .eq("org_id", context.orgId).not("status", "in", "(completed,cancelled)").not("superintendent_id", "is", null).order("id").range(from, to), { cap: LOAD_CAP, label: "Failed to count assigned houses" }),
  ])
  if (projects.truncated || capacities.truncated || assigned.truncated) throw new Error("Too many houses to resolve superintendent load")
  const toLimits = (row: { warn_houses: unknown; max_houses: unknown }) => ({ warn: Number(row.warn_houses), max: Number(row.max_houses) })
  const orgRow = capacities.rows.find((row) => row.user_id === null)
  const own = new Map(capacities.rows.flatMap((row) => (row.user_id ? [[row.user_id as string, toLimits(row)] as const] : [])))
  const houses = new Map<string, number>()
  for (const row of assigned.rows) if (row.superintendent_id) houses.set(row.superintendent_id, (houses.get(row.superintendent_id) ?? 0) + 1)
  return projects.rows.map((project) => {
    const userId = project.superintendent_id as string | null
    const limits = resolveSuperintendentLimits(userId ? own.get(userId) : null, orgRow ? toLimits(orgRow) : null)
    const activeHouses = userId ? houses.get(userId) ?? 0 : 0
    return { projectId: project.id as string, superintendentId: userId, activeHouses, warnAt: limits.warn, limit: limits.max, load: superintendentLoad(activeHouses, limits) }
  })
}
