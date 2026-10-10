import { z } from "zod"

import { MobileAPIError } from "@/lib/mobile/api"
import type { MobileOrgContext } from "@/lib/mobile/auth"
import type { MobilePunchItemDTO, MobileTaskDTO } from "@/lib/mobile/contracts"
import { revisionMatches, staleRevisionError } from "@/lib/mobile/revision"
import { listProjects } from "@/lib/services/projects"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"

const TASK_STATUSES = ["todo", "in_progress", "blocked", "done"] as const
const PUNCH_STATUSES = ["open", "in_progress", "ready_for_review", "closed"] as const

async function requireProject(context: MobileOrgContext, projectId: string) {
  const project = (await listProjects(context.orgId, context.serviceContext)).find((item) => item.id === projectId)
  if (!project) throw new MobileAPIError(404, "project_not_found", "Project not found.")
  return project
}

const TASK_SELECT =
  "id, project_id, title, description, status, priority, due_date, completed_at, created_at, updated_at, " +
        "task_assignments(user:app_users!task_assignments_user_id_fkey(full_name, email), contact:contacts!task_assignments_contact_id_fkey(full_name))"

function mapTask(row: any): MobileTaskDTO {
  const assignees: string[] = []
  for (const assignment of (row.task_assignments ?? []) as any[]) {
    const user = Array.isArray(assignment.user) ? assignment.user[0] : assignment.user
    const contact = Array.isArray(assignment.contact) ? assignment.contact[0] : assignment.contact
    const name = user?.full_name ?? user?.email ?? contact?.full_name ?? null
    if (typeof name === "string" && name) assignees.push(name)
  }
  return {
    id: row.id,
    project_id: row.project_id,
    title: row.title,
    description: row.description ?? null,
    status: row.status ?? "todo",
    priority: row.priority ?? null,
    due_date: row.due_date ?? null,
    completed_at: row.completed_at ?? null,
    assignees: [...new Set(assignees)],
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export async function listMobileTasks(context: MobileOrgContext, projectId: string): Promise<MobileTaskDTO[]> {
  await requireProject(context, projectId)
  const { data, error } = await context.serviceSupabase
    .from("tasks")
    .select(TASK_SELECT)
    .eq("org_id", context.orgId)
    .eq("project_id", projectId)
    .order("status", { ascending: true })
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(500)
  if (error) throw new MobileAPIError(500, "tasks_unavailable", "Tasks could not be loaded.")
  return (data ?? []).map(mapTask)
}

const taskUpdateSchema = z.object({
  status: z.enum(TASK_STATUSES),
  // The task's `updated_at` as the app last read it. Optional so builds that
  // predate it keep working; when present, a stale write is refused with 409.
  expected_revision: z.string().max(100).optional(),
})

async function readTaskRow(context: MobileOrgContext, projectId: string, taskId: string) {
  const { data, error } = await context.serviceSupabase
    .from("tasks")
    .select(TASK_SELECT)
    .eq("org_id", context.orgId)
    .eq("project_id", projectId)
    .eq("id", taskId)
    .maybeSingle()
  if (error) throw new MobileAPIError(500, "task_update_failed", "The task could not be updated.")
  return data
}

export async function updateMobileTaskStatus(
  context: MobileOrgContext,
  projectId: string,
  taskId: string,
  input: unknown,
): Promise<MobileTaskDTO> {
  await requireProject(context, projectId)
  const parsed = taskUpdateSchema.safeParse(input)
  if (!parsed.success) throw new MobileAPIError(422, "invalid_task", "A valid task status is required.")

  const update: Record<string, unknown> = { status: parsed.data.status }
  update.completed_at = parsed.data.status === "done" ? new Date().toISOString() : null

  // With an expected revision the write is compare-and-swap on the stored
  // `updated_at`, so a change landing between the check and the write loses.
  let guard: string | null = null
  if (parsed.data.expected_revision) {
    const current = await readTaskRow(context, projectId, taskId)
    if (!current) throw new MobileAPIError(404, "task_not_found", "Task not found.")
    if (!revisionMatches(parsed.data.expected_revision, current.updated_at)) throw staleRevisionError("task", mapTask(current))
    guard = current.updated_at
  }

  let query = context.serviceSupabase
    .from("tasks")
    .update(update)
    .eq("org_id", context.orgId)
    .eq("project_id", projectId)
    .eq("id", taskId)
  if (guard) query = query.eq("updated_at", guard)
  const { data, error } = await query.select(TASK_SELECT).maybeSingle()
  if (error) throw new MobileAPIError(500, "task_update_failed", "The task could not be updated.")
  if (!data) {
    const current = guard ? await readTaskRow(context, projectId, taskId) : null
    if (current) throw staleRevisionError("task", mapTask(current))
    throw new MobileAPIError(404, "task_not_found", "Task not found.")
  }

  await Promise.all([
    recordAudit({ orgId: context.orgId, actorId: context.user.id, action: "update", entityType: "task", entityId: taskId, after: { status: parsed.data.status } }),
    recordEvent({ orgId: context.orgId, eventType: "task_status_changed", entityType: "task", entityId: taskId, payload: { project_id: projectId, status: parsed.data.status } }),
  ])
  return mapTask(data)
}

const PUNCH_SELECT = "id, project_id, title, description, status, due_date, severity, location, resolved_at, updated_at"

function mapPunch(row: any): MobilePunchItemDTO {
  return {
    id: row.id,
    project_id: row.project_id,
    title: row.title,
    description: row.description ?? null,
    status: row.status ?? "open",
    severity: row.severity ?? null,
    location: row.location ?? null,
    due_date: row.due_date ?? null,
    resolved_at: row.resolved_at ?? null,
    updated_at: row.updated_at ?? null,
  }
}

export async function listMobilePunchItems(context: MobileOrgContext, projectId: string): Promise<MobilePunchItemDTO[]> {
  await requireProject(context, projectId)
  const { data, error } = await context.serviceSupabase
    .from("punch_items")
    .select(PUNCH_SELECT)
    .eq("org_id", context.orgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(500)
  if (error) throw new MobileAPIError(500, "punch_items_unavailable", "Punch items could not be loaded.")
  return (data ?? []).map(mapPunch)
}

const punchUpdateSchema = z.object({
  status: z.enum(PUNCH_STATUSES),
  // The punch item's `updated_at` as the app last read it; see taskUpdateSchema.
  expected_revision: z.string().max(100).optional(),
})

export async function updateMobilePunchStatus(
  context: MobileOrgContext,
  projectId: string,
  punchItemId: string,
  input: unknown,
): Promise<MobilePunchItemDTO> {
  await requireProject(context, projectId)
  const parsed = punchUpdateSchema.safeParse(input)
  if (!parsed.success) throw new MobileAPIError(422, "invalid_punch_item", "A valid status is required.")

  if (parsed.data.expected_revision) {
    const { data: current, error } = await context.serviceSupabase
      .from("punch_items")
      .select(PUNCH_SELECT)
      .eq("org_id", context.orgId)
      .eq("project_id", projectId)
      .eq("id", punchItemId)
      .maybeSingle()
    if (error) throw new MobileAPIError(500, "punch_update_failed", "The punch item could not be updated.")
    if (!current) throw new MobileAPIError(404, "punch_item_not_found", "Punch item not found.")
    if (!revisionMatches(parsed.data.expected_revision, current.updated_at)) throw staleRevisionError("punch item", mapPunch(current))
  }

  // Use the web's canonical lifecycle so verification stamps, rejected work,
  // audit history and dispatch behavior remain consistent across devices.
  const { runWithServiceOrgContext } = await import("@/lib/services/context")
  return runWithServiceOrgContext(context.serviceContext, async () => {
    const result = await (await import("@/app/(app)/projects/[id]/actions")).updateProjectPunchItemAction(projectId, punchItemId, { status: parsed.data.status })
    if (!result.success) throw new MobileAPIError(422, "punch_update_failed", result.error)
    return mapPunch(result.data)
  })
}
