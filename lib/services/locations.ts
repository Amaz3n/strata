import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"
import { enqueueReindex } from "@/lib/services/search-index"
import {
  bulkCreateLocationsSchema,
  createLocationSchema,
  locationNameSchema,
  updateLocationSchema,
} from "@/lib/validation/locations"

export type ProjectLocation = {
  id: string
  org_id: string
  project_id: string
  parent_id: string | null
  name: string
  full_path: string
  sort_order: number
  is_active: boolean
  created_at: string
  updated_at: string
  depth: number
}

const LOCATION_SELECT = "id, org_id, project_id, parent_id, name, full_path, sort_order, is_active, created_at, updated_at"

export async function resolveProjectLocation(projectId: string, locationId: string | null | undefined, orgId?: string) {
  if (!locationId) return null
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const { data, error } = await supabase.from("project_locations").select("id, full_path")
    .eq("org_id", resolvedOrgId).eq("project_id", projectId).eq("id", locationId).eq("is_active", true).maybeSingle()
  if (error || !data) throw new Error("Location not found or inactive")
  return data
}

function orderLocationTree(rows: Omit<ProjectLocation, "depth">[], includeInactive: boolean): ProjectLocation[] {
  const byParent = new Map<string | null, Omit<ProjectLocation, "depth">[]>()
  for (const row of rows) {
    const siblings = byParent.get(row.parent_id) ?? []
    siblings.push(row)
    byParent.set(row.parent_id, siblings)
  }
  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
  }
  const result: ProjectLocation[] = []
  const visit = (parentId: string | null, depth: number, ancestorsActive: boolean) => {
    for (const row of byParent.get(parentId) ?? []) {
      const visible = ancestorsActive && row.is_active
      if (includeInactive || visible) result.push({ ...row, depth })
      visit(row.id, depth + 1, visible)
    }
  }
  visit(null, 0, true)
  return result
}

export async function listProjectLocations(
  projectId: string,
  options?: { includeInactive?: boolean },
  orgId?: string,
): Promise<ProjectLocation[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const { data, error } = await supabase
    .from("project_locations")
    .select(LOCATION_SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
  if (error) throw new Error(`Failed to load project locations: ${error.message}`)
  return orderLocationTree((data ?? []) as Omit<ProjectLocation, "depth">[], options?.includeInactive ?? false)
}

export async function createLocation(input: unknown, orgId?: string): Promise<ProjectLocation> {
  const parsed = createLocationSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })

  let parent: { id: string; full_path: string } | null = null
  if (parsed.parent_id) {
    const { data } = await supabase.from("project_locations").select("id, full_path")
      .eq("org_id", resolvedOrgId).eq("project_id", parsed.project_id).eq("id", parsed.parent_id).maybeSingle()
    if (!data) throw new Error("Parent location not found")
    parent = data
  }
  const { data, error } = await supabase.from("project_locations").insert({
    org_id: resolvedOrgId,
    project_id: parsed.project_id,
    parent_id: parent?.id ?? null,
    name: parsed.name,
    full_path: parent ? `${parent.full_path} > ${parsed.name}` : parsed.name,
    sort_order: parsed.sort_order ?? 0,
  }).select(LOCATION_SELECT).single()
  if (error || !data) throw new Error(`Failed to create location: ${error?.message}`)
  await Promise.all([
    recordEvent({ orgId: resolvedOrgId, eventType: "project_location_created", entityType: "project_location", entityId: data.id, payload: { project_id: parsed.project_id, full_path: data.full_path } }),
    recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "project_location", entityId: data.id, after: data }),
  ])
  return { ...data, depth: parent ? parent.full_path.split(" > ").length : 0 } as ProjectLocation
}

export async function updateLocation(locationId: string, input: unknown, orgId?: string): Promise<ProjectLocation> {
  const parsed = updateLocationSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })
  const { data: before } = await supabase.from("project_locations").select(LOCATION_SELECT)
    .eq("org_id", resolvedOrgId).eq("id", locationId).maybeSingle()
  if (!before) throw new Error("Location not found")
  const { error } = await supabase.rpc("rename_project_location", {
    p_org_id: resolvedOrgId, p_project_id: before.project_id, p_location_id: locationId, p_name: parsed.name,
  })
  if (error) throw new Error(`Failed to rename location: ${error.message}`)
  const { data: after, error: loadError } = await supabase.from("project_locations").select(LOCATION_SELECT)
    .eq("org_id", resolvedOrgId).eq("id", locationId).single()
  if (loadError || !after) throw new Error(`Failed to load renamed location: ${loadError?.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "project_location", entityId: locationId, before, after })
  return { ...after, depth: after.full_path.split(" > ").length - 1 } as ProjectLocation
}

export async function setLocationActive(locationId: string, isActive: boolean, orgId?: string): Promise<void> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })
  const { data: before } = await supabase.from("project_locations").select(LOCATION_SELECT)
    .eq("org_id", resolvedOrgId).eq("id", locationId).maybeSingle()
  if (!before) throw new Error("Location not found")
  const { error } = await supabase.from("project_locations").update({ is_active: isActive })
    .eq("org_id", resolvedOrgId).eq("id", locationId)
  if (error) throw new Error(`Failed to update location: ${error.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "project_location", entityId: locationId, before, after: { ...before, is_active: isActive } })
}

export async function bulkCreateLocations(input: unknown, orgId?: string): Promise<ProjectLocation[]> {
  const parsed = bulkCreateLocationsSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })
  const lines = parsed.text.split(/\r?\n/).filter((line) => line.trim())
  const parents = new Map<number, { id: string; full_path: string }>()
  const rows: Array<{ id: string; org_id: string; project_id: string; parent_id: string | null; name: string; full_path: string; sort_order: number }> = []
  for (const [index, line] of lines.entries()) {
    const spaces = line.match(/^ */)?.[0].length ?? 0
    if (spaces % 2 !== 0) throw new Error(`Line ${index + 1} must use two spaces per level`)
    const depth = spaces / 2
    const name = locationNameSchema.parse(line.trim())
    if (depth > 0 && !parents.has(depth - 1)) throw new Error(`Line ${index + 1} has no parent at the previous level`)
    const parent = depth === 0 ? null : parents.get(depth - 1) ?? null
    const fullPath = parent ? `${parent.full_path} > ${name}` : name
    const id = crypto.randomUUID()
    rows.push({ id, org_id: resolvedOrgId, project_id: parsed.project_id, parent_id: parent?.id ?? null, name, full_path: fullPath, sort_order: index })
    parents.set(depth, { id, full_path: fullPath })
    for (const key of [...parents.keys()]) if (key > depth) parents.delete(key)
  }
  const { data: created, error } = await supabase.from("project_locations").insert(rows).select(LOCATION_SELECT)
  if (error || !created) throw new Error(`Failed to create locations: ${error?.message}`)
  await Promise.all([
    recordEvent({ orgId: resolvedOrgId, eventType: "project_locations_bulk_created", entityType: "project", entityId: parsed.project_id, payload: { count: created.length } }),
    recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "project_location", entityId: parsed.project_id, after: { count: created.length, ids: created.map((row) => row.id) } }),
    ...created.map((row) =>
      enqueueReindex({ orgId: resolvedOrgId, entityType: "project_location", entityId: row.id, op: "upsert" }, supabase),
    ),
  ])
  return orderLocationTree(created, true)
}
