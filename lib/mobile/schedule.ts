import { MobileAPIError } from "@/lib/mobile/api"
import type { MobileOrgContext } from "@/lib/mobile/auth"
import type { MobileScheduleItemDTO } from "@/lib/mobile/contracts"
import { listProjects } from "@/lib/services/projects"

async function requireProject(context: MobileOrgContext, projectId: string) {
  const project = (await listProjects(context.orgId, context.serviceContext)).find((item) => item.id === projectId)
  if (!project) throw new MobileAPIError(404, "project_not_found", "Project not found.")
  return project
}

// Resolve display names for the user assignees referenced by schedule items.
// Field crews care about "who is on this" far more than billing/contact records,
// so only app_user assignments (and the legacy single assigned_to) are surfaced.
async function loadAssigneeNames(
  context: MobileOrgContext,
  projectId: string,
  itemIds: string[],
  legacyAssignedTo: Map<string, string | null>,
): Promise<Map<string, string[]>> {
  const names = new Map<string, string[]>()
  if (!itemIds.length) return names

  const userIds = new Set<string>()
  for (const value of legacyAssignedTo.values()) {
    if (value) userIds.add(value)
  }

  const { data: assignments } = await context.serviceSupabase
    .from("schedule_assignments")
    .select("schedule_item_id, user_id, user:app_users(id, full_name, email)")
    .eq("org_id", context.orgId)
    .eq("project_id", projectId)
    .in("schedule_item_id", itemIds)

  const userNameById = new Map<string, string>()
  const assignmentsByItem = new Map<string, string[]>()
  for (const row of assignments ?? []) {
    if (!row.user_id) continue
    const user = Array.isArray(row.user) ? row.user[0] : row.user
    const name = user?.full_name ?? user?.email ?? null
    if (name) userNameById.set(row.user_id, name)
    assignmentsByItem.set(row.schedule_item_id, [...(assignmentsByItem.get(row.schedule_item_id) ?? []), row.user_id])
    userIds.add(row.user_id)
  }

  // Backfill names for legacy assigned_to ids that have no assignment row.
  const missing = [...userIds].filter((id) => !userNameById.has(id))
  if (missing.length) {
    const { data: users } = await context.serviceSupabase
      .from("app_users")
      .select("id, full_name, email")
      .in("id", missing)
    for (const user of users ?? []) {
      const name = user.full_name ?? user.email ?? null
      if (name) userNameById.set(user.id, name)
    }
  }

  for (const itemId of itemIds) {
    const ids = new Set(assignmentsByItem.get(itemId) ?? [])
    const legacy = legacyAssignedTo.get(itemId)
    if (legacy) ids.add(legacy)
    const resolved = [...ids].map((id) => userNameById.get(id)).filter((name): name is string => Boolean(name))
    if (resolved.length) names.set(itemId, [...new Set(resolved)])
  }

  return names
}

export async function listMobileScheduleItems(
  context: MobileOrgContext,
  projectId: string,
): Promise<MobileScheduleItemDTO[]> {
  await requireProject(context, projectId)

  const { data, error } = await context.serviceSupabase
    .from("schedule_items")
    .select(
      "id, project_id, name, item_type, status, start_date, end_date, progress, phase, trade, location, is_critical_path, assigned_to, sort_order, updated_at",
    )
    .eq("org_id", context.orgId)
    .eq("project_id", projectId)
    .order("start_date", { ascending: true, nullsFirst: false })
    .order("sort_order", { ascending: true })
    .limit(2000)

  if (error) throw new MobileAPIError(500, "schedule_unavailable", "The schedule could not be loaded.")

  const rows = data ?? []
  const legacyAssignedTo = new Map<string, string | null>(rows.map((row) => [row.id, row.assigned_to ?? null]))
  const assignees = await loadAssigneeNames(
    context,
    projectId,
    rows.map((row) => row.id),
    legacyAssignedTo,
  )

  return rows.map((row) => ({
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    item_type: row.item_type ?? "task",
    status: row.status ?? "planned",
    start_date: row.start_date ?? null,
    end_date: row.end_date ?? null,
    progress: Number(row.progress ?? 0),
    phase: row.phase ?? null,
    trade: row.trade ?? null,
    location: row.location ?? null,
    is_critical_path: Boolean(row.is_critical_path),
    assignees: assignees.get(row.id) ?? [],
    updated_at: row.updated_at,
  }))
}
