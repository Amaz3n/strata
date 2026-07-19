import type { DivisionInput } from "@/lib/validation/divisions"
import { divisionInputSchema, divisionUpdateSchema } from "@/lib/validation/divisions"
import { recordAudit } from "@/lib/services/audit"
import { getDivisionAccessForUser } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"

export interface DivisionDTO {
  id: string
  name: string
  code: string | null
  region: string | null
  archived: boolean
  communityCount: number
  activeProjectCount: number
}

type DivisionRow = {
  id: string
  name: string
  code: string | null
  region: string | null
  archived_at: string | null
}

function mapDivision(
  row: DivisionRow,
  communityCounts: Map<string, number>,
  projectCounts: Map<string, number>,
): DivisionDTO {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    region: row.region,
    archived: Boolean(row.archived_at),
    communityCount: communityCounts.get(row.id) ?? 0,
    activeProjectCount: projectCounts.get(row.id) ?? 0,
  }
}

function countByDivision(rows: Array<{ division_id: string | null }>) {
  const counts = new Map<string, number>()
  for (const row of rows) {
    if (!row.division_id) continue
    counts.set(row.division_id, (counts.get(row.division_id) ?? 0) + 1)
  }
  return counts
}

export async function listDivisions(orgId?: string): Promise<DivisionDTO[]> {
  const context = await requireOrgContext(orgId)
  await requirePermission("org.member", context)
  const scope = await getDivisionAccessForUser({ orgId: context.orgId, userId: context.userId })
  if (scope.assignedOnly && scope.divisionIds.length === 0) return []
  let divisionsQuery = context.supabase
    .from("divisions")
    .select("id, name, code, region, archived_at")
    .eq("org_id", context.orgId)
    .order("archived_at", { ascending: true, nullsFirst: true })
    .order("name")
  if (scope.assignedOnly) divisionsQuery = divisionsQuery.in("id", scope.divisionIds)
  const [divisionsResult, communitiesResult, projectsResult] = await Promise.all([
    divisionsQuery,
    context.supabase
      .from("communities")
      .select("division_id")
      .eq("org_id", context.orgId)
      .is("archived_at", null),
    context.supabase
      .from("projects")
      .select("division_id")
      .eq("org_id", context.orgId)
      .eq("status", "active"),
  ])
  if (divisionsResult.error) throw new Error(`Failed to list divisions: ${divisionsResult.error.message}`)
  if (communitiesResult.error) throw new Error(`Failed to count division communities: ${communitiesResult.error.message}`)
  if (projectsResult.error) throw new Error(`Failed to count division projects: ${projectsResult.error.message}`)
  const communityCounts = countByDivision(communitiesResult.data ?? [])
  const projectCounts = countByDivision(projectsResult.data ?? [])
  return (divisionsResult.data ?? []).map((row) =>
    mapDivision(row as DivisionRow, communityCounts, projectCounts),
  )
}

export async function orgHasDivisions(orgId?: string): Promise<boolean> {
  const context = await requireOrgContext(orgId)
  await requirePermission("org.member", context)
  const { count, error } = await context.supabase
    .from("divisions")
    .select("id", { count: "exact", head: true })
    .eq("org_id", context.orgId)
    .is("archived_at", null)
  if (error) throw new Error(`Failed to check divisions: ${error.message}`)
  return (count ?? 0) > 0
}

async function getDivisionDTO(id: string, orgId?: string) {
  const divisions = await listDivisions(orgId)
  const division = divisions.find((candidate) => candidate.id === id)
  if (!division) throw new Error("Division not found")
  return division
}

export async function createDivision(input: DivisionInput, orgId?: string): Promise<DivisionDTO> {
  const parsed = divisionInputSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("division.manage", context)
  const { data, error } = await context.supabase
    .from("divisions")
    .insert({
      org_id: context.orgId,
      name: parsed.name,
      code: parsed.code || null,
      region: parsed.region || null,
      settings: parsed.settings ?? {},
    })
    .select("id, name, code, region, archived_at")
    .single()
  if (error) throw new Error(`Failed to create division: ${error.message}`)
  await Promise.all([
    recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: "division.created",
      entityType: "division",
      entityId: data.id,
      payload: { name: data.name },
    }),
    recordAudit({
      orgId: context.orgId,
      actorId: context.userId,
      action: "insert",
      entityType: "division",
      entityId: data.id,
      after: data,
    }),
  ])
  return mapDivision(data as DivisionRow, new Map(), new Map())
}

export async function updateDivision(
  id: string,
  input: Partial<DivisionInput>,
  orgId?: string,
): Promise<DivisionDTO> {
  const parsed = divisionUpdateSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("division.manage", context)
  const { data: before, error: beforeError } = await context.supabase
    .from("divisions")
    .select("id, name, code, region, settings, archived_at")
    .eq("org_id", context.orgId)
    .eq("id", id)
    .maybeSingle()
  if (beforeError || !before) throw new Error("Division not found")
  const patch: Record<string, unknown> = {}
  if (parsed.name !== undefined) patch.name = parsed.name
  if (parsed.code !== undefined) patch.code = parsed.code || null
  if (parsed.region !== undefined) patch.region = parsed.region || null
  if (parsed.settings !== undefined) patch.settings = parsed.settings
  const { data, error } = await context.supabase
    .from("divisions")
    .update(patch)
    .eq("org_id", context.orgId)
    .eq("id", id)
    .select("id, name, code, region, settings, archived_at")
    .single()
  if (error) throw new Error(`Failed to update division: ${error.message}`)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "division.updated", entityType: "division", entityId: id, payload: { name: data.name } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "division", entityId: id, before, after: data }),
  ])
  return getDivisionDTO(id, context.orgId)
}

export async function archiveDivision(id: string, orgId?: string): Promise<void> {
  const context = await requireOrgContext(orgId)
  await requirePermission("division.manage", context)
  const { count, error: countError } = await context.supabase
    .from("communities")
    .select("id", { count: "exact", head: true })
    .eq("org_id", context.orgId)
    .eq("division_id", id)
    .is("archived_at", null)
  if (countError) throw new Error(`Failed to check division use: ${countError.message}`)
  if ((count ?? 0) > 0) throw new Error("Move or archive this division's communities before archiving it.")
  const { data: before, error: beforeError } = await context.supabase
    .from("divisions")
    .select("id, name, code, region, archived_at")
    .eq("org_id", context.orgId)
    .eq("id", id)
    .maybeSingle()
  if (beforeError || !before) throw new Error("Division not found")
  const archivedAt = new Date().toISOString()
  const { error } = await context.supabase
    .from("divisions")
    .update({ archived_at: archivedAt })
    .eq("org_id", context.orgId)
    .eq("id", id)
  if (error) throw new Error(`Failed to archive division: ${error.message}`)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "division.archived", entityType: "division", entityId: id, payload: { name: before.name } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "division", entityId: id, before, after: { ...before, archived_at: archivedAt } }),
  ])
}
