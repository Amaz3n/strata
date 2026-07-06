import { z } from "zod"

import { MobileAPIError } from "@/lib/mobile/api"
import type { MobileOrgContext } from "@/lib/mobile/auth"
import type { MobilePunchItemDTO, MobileTaskDTO } from "@/lib/mobile/contracts"
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
    .select(
      "id, project_id, title, description, status, priority, due_date, completed_at, created_at, updated_at, " +
        "task_assignments(user:app_users!task_assignments_user_id_fkey(full_name, email), contact:contacts!task_assignments_contact_id_fkey(full_name))",
    )
    .eq("org_id", context.orgId)
    .eq("project_id", projectId)
    .order("status", { ascending: true })
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(500)
  if (error) throw new MobileAPIError(500, "tasks_unavailable", "Tasks could not be loaded.")
  return (data ?? []).map(mapTask)
}

const taskUpdateSchema = z.object({ status: z.enum(TASK_STATUSES) })

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

  const { data, error } = await context.serviceSupabase
    .from("tasks")
    .update(update)
    .eq("org_id", context.orgId)
    .eq("project_id", projectId)
    .eq("id", taskId)
    .select(
      "id, project_id, title, description, status, priority, due_date, completed_at, created_at, updated_at, " +
        "task_assignments(user:app_users!task_assignments_user_id_fkey(full_name, email), contact:contacts!task_assignments_contact_id_fkey(full_name))",
    )
    .maybeSingle()
  if (error) throw new MobileAPIError(500, "task_update_failed", "The task could not be updated.")
  if (!data) throw new MobileAPIError(404, "task_not_found", "Task not found.")

  await Promise.all([
    recordAudit({ orgId: context.orgId, actorId: context.user.id, action: "update", entityType: "task", entityId: taskId, after: { status: parsed.data.status } }),
    recordEvent({ orgId: context.orgId, eventType: "task_status_changed", entityType: "task", entityId: taskId, payload: { project_id: projectId, status: parsed.data.status } }),
  ])
  return mapTask(data)
}

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
  }
}

export async function listMobilePunchItems(context: MobileOrgContext, projectId: string): Promise<MobilePunchItemDTO[]> {
  await requireProject(context, projectId)
  const { data, error } = await context.serviceSupabase
    .from("punch_items")
    .select("id, project_id, title, description, status, due_date, severity, location, resolved_at")
    .eq("org_id", context.orgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(500)
  if (error) throw new MobileAPIError(500, "punch_items_unavailable", "Punch items could not be loaded.")
  return (data ?? []).map(mapPunch)
}

const punchUpdateSchema = z.object({ status: z.enum(PUNCH_STATUSES) })

export async function updateMobilePunchStatus(
  context: MobileOrgContext,
  projectId: string,
  punchItemId: string,
  input: unknown,
): Promise<MobilePunchItemDTO> {
  await requireProject(context, projectId)
  const parsed = punchUpdateSchema.safeParse(input)
  if (!parsed.success) throw new MobileAPIError(422, "invalid_punch_item", "A valid status is required.")

  const closing = parsed.data.status === "closed"
  const update: Record<string, unknown> = {
    status: parsed.data.status,
    resolved_at: closing ? new Date().toISOString() : null,
    resolved_by: closing ? context.user.id : null,
  }

  const { data, error } = await context.serviceSupabase
    .from("punch_items")
    .update(update)
    .eq("org_id", context.orgId)
    .eq("project_id", projectId)
    .eq("id", punchItemId)
    .select("id, project_id, title, description, status, due_date, severity, location, resolved_at")
    .maybeSingle()
  if (error) throw new MobileAPIError(500, "punch_update_failed", "The punch item could not be updated.")
  if (!data) throw new MobileAPIError(404, "punch_item_not_found", "Punch item not found.")

  await recordEvent({ orgId: context.orgId, eventType: "punch_item_status_changed", entityType: "punch_item", entityId: punchItemId, payload: { project_id: projectId, status: parsed.data.status } })
  return mapPunch(data)
}
