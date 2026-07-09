"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import type { AssignableResource } from "@/app/(app)/projects/[id]/actions"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import type { Task } from "@/lib/types"
import { taskInputSchema, taskUpdateSchema, type TaskInput } from "@/lib/validation/tasks"

import { actionError, type ActionResult } from "@/lib/action-result"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}

// ── Personal quick-capture list (header "My Tasks" sheet) ───────────────────
// Lightweight to-dos with no project. Kept separate from the full Tasks page so
// the header sheet stays a fast, single-field capture surface.

export type UserTask = {
  id: string
  org_id: string
  project_id: string | null
  title: string
  description: string | null
  status: "todo" | "in_progress" | "blocked" | "done"
  priority: "low" | "normal" | "high" | "urgent"
  due_date: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

const userTaskCreateSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
})

const userTaskUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    status: z.enum(["todo", "in_progress", "blocked", "done"]).optional(),
  })
  .refine((input) => input.title !== undefined || input.status !== undefined, {
    message: "Provide at least one field to update.",
  })

function mapUserTask(row: any): UserTask {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id ?? null,
    title: row.title,
    description: row.description ?? null,
    status: row.status,
    priority: row.priority,
    due_date: row.due_date ?? null,
    completed_at: row.completed_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export async function listTasksAction() {
      const { supabase, orgId, userId } = await requireOrgContext()

      const { data, error } = await supabase
        .from("tasks")
        .select("id, org_id, project_id, title, description, status, priority, due_date, completed_at, created_at, updated_at")
        .eq("org_id", orgId)
        .eq("created_by", userId)
        .is("project_id", null)
        .order("created_at", { ascending: false })

      if (error) {
        throw new Error(`Failed to list tasks: ${error.message}`)
      }

      return (data ?? []).map(mapUserTask)
}

export async function createTaskAction(input: unknown) {
  return run(async () => {
      const parsed = userTaskCreateSchema.parse(input)
      const { supabase, orgId, userId } = await requireOrgContext()

      const { data, error } = await supabase
        .from("tasks")
        .insert({
          org_id: orgId,
          project_id: null,
          title: parsed.title,
          description: null,
          status: "todo",
          priority: "normal",
          created_by: userId,
          assigned_by: null,
        })
        .select("id, org_id, project_id, title, description, status, priority, due_date, completed_at, created_at, updated_at")
        .single()

      if (error || !data) {
        throw new Error(`Failed to create task: ${error?.message ?? "Unknown error"}`)
      }

      revalidatePath("/tasks")
      revalidatePath("/")
      return mapUserTask(data)
  })
}

export async function updateTaskAction(taskId: string, input: unknown) {
  return run(async () => {
      const parsed = userTaskUpdateSchema.parse(input)
      const { supabase, orgId, userId } = await requireOrgContext()

      const updates: Record<string, unknown> = {}
      if (parsed.title !== undefined) updates.title = parsed.title
      if (parsed.status !== undefined) {
        updates.status = parsed.status
        updates.completed_at = parsed.status === "done" ? new Date().toISOString() : null
      }

      const { data, error } = await supabase
        .from("tasks")
        .update(updates)
        .eq("org_id", orgId)
        .eq("id", taskId)
        .eq("created_by", userId)
        .is("project_id", null)
        .select("id, org_id, project_id, title, description, status, priority, due_date, completed_at, created_at, updated_at")
        .single()

      if (error || !data) {
        throw new Error(`Failed to update task: ${error?.message ?? "Unknown error"}`)
      }

      revalidatePath("/tasks")
      revalidatePath("/")
      return mapUserTask(data)
  })
}

export async function deleteTaskAction(taskId: string) {
  return run(async () => {
      const { supabase, orgId, userId } = await requireOrgContext()

      const { error } = await supabase
        .from("tasks")
        .delete()
        .eq("org_id", orgId)
        .eq("id", taskId)
        .eq("created_by", userId)
        .is("project_id", null)

      if (error) {
        throw new Error(`Failed to delete task: ${error.message}`)
      }

      revalidatePath("/tasks")
      revalidatePath("/")
  })
}

// ── Full org-wide Tasks page ────────────────────────────────────────────────
// The Tasks page is the personal cross-project workbench: every task the user
// created or was assigned, across projects and personal to-dos, all in one.

const TASK_SELECT = `
  id, org_id, project_id, title, description, status, priority,
  start_date, due_date, reminder_at, reminder_sent_at, completed_at, metadata, created_by, assigned_by,
  created_at, updated_at,
  project:projects(id, name),
  task_assignments(
    user_id, contact_id,
    user:app_users!task_assignments_user_id_fkey(id, full_name, avatar_url, email),
    contact:contacts!task_assignments_contact_id_fkey(id, full_name, email, primary_company:companies!contacts_primary_company_id_fkey(name))
  ),
  creator:app_users!tasks_created_by_fkey(id, full_name)
`

function one<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

function mapFullTask(row: any): Task {
  const assignments = Array.isArray(row.task_assignments) ? row.task_assignments : []
  const assignment = assignments.find((a: any) => a?.user_id || a?.contact_id)
  const assigneeUser = assignment?.user ? one(assignment.user) : null
  const assigneeContact = assignment?.contact ? one(assignment.contact) : null
  const metadata = (row.metadata ?? {}) as Record<string, any>
  const project = one(row.project) as { id: string; name: string } | null
  const creator = one(row.creator) as { full_name?: string } | null

  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id ?? null,
    project_name: project?.name ?? undefined,
    title: row.title,
    description: row.description ?? undefined,
    status: row.status,
    priority: row.priority,
    assignee_id: assignment?.user_id ?? assignment?.contact_id ?? undefined,
    assignee_kind: assignment?.user_id ? "user" : assignment?.contact_id ? "contact" : undefined,
    assignee: assigneeUser
      ? {
          id: assigneeUser.id,
          full_name: assigneeUser.full_name ?? "Unknown",
          avatar_url: assigneeUser.avatar_url ?? undefined,
          email: assigneeUser.email ?? undefined,
        }
      : undefined,
    assignee_contact: assigneeContact
      ? {
          id: assigneeContact.id,
          full_name: assigneeContact.full_name,
          email: assigneeContact.email ?? undefined,
          company_name: (one(assigneeContact.primary_company) as { name?: string } | null)?.name ?? undefined,
        }
      : undefined,
    start_date: row.start_date ?? undefined,
    due_date: row.due_date ?? undefined,
    reminder_at: row.reminder_at ?? null,
    reminder_sent_at: row.reminder_sent_at ?? null,
    completed_at: row.completed_at ?? undefined,
    location: metadata.location ?? undefined,
    trade: metadata.trade ?? undefined,
    estimated_hours: metadata.estimated_hours ?? undefined,
    actual_hours: metadata.actual_hours ?? undefined,
    checklist: metadata.checklist ?? undefined,
    tags: metadata.tags ?? undefined,
    created_by: row.created_by ?? undefined,
    created_by_name: creator?.full_name ?? undefined,
    assigned_by: row.assigned_by ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/** Metadata (jsonb) holds the construction-specific fields not in dedicated columns. */
function buildMetadata(base: Record<string, any>, input: Partial<TaskInput>): Record<string, any> {
  const metadata = { ...base }
  if (input.location !== undefined) metadata.location = input.location || undefined
  if (input.trade !== undefined) metadata.trade = input.trade || undefined
  if (input.estimated_hours !== undefined) metadata.estimated_hours = input.estimated_hours
  if (input.tags !== undefined) metadata.tags = input.tags?.length ? input.tags : undefined
  if (input.checklist !== undefined) metadata.checklist = input.checklist?.length ? input.checklist : undefined
  for (const key of Object.keys(metadata)) {
    if (metadata[key] === undefined) delete metadata[key]
  }
  return metadata
}

async function fetchTaskById(
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"],
  orgId: string,
  taskId: string,
): Promise<Task> {
  const { data, error } = await supabase
    .from("tasks")
    .select(TASK_SELECT)
    .eq("org_id", orgId)
    .eq("id", taskId)
    .single()

  if (error || !data) {
    throw new Error(`Failed to load task: ${error?.message ?? "Unknown error"}`)
  }

  return mapFullTask(data)
}

/** Every task the current user created or is assigned to, across projects and personal. */
export async function listMyTasksAction(): Promise<Task[]> {
      const { supabase, orgId, userId } = await requireOrgContext()

      const { data: myAssignments } = await supabase
        .from("task_assignments")
        .select("task_id")
        .eq("org_id", orgId)
        .eq("user_id", userId)

      const assignedIds = [...new Set((myAssignments ?? []).map((row: any) => row.task_id as string))]

      let orClause = `created_by.eq.${userId}`
      if (assignedIds.length > 0) orClause += `,id.in.(${assignedIds.join(",")})`

      const { data, error } = await supabase
        .from("tasks")
        .select(TASK_SELECT)
        .eq("org_id", orgId)
        .or(orClause)
        .order("created_at", { ascending: false })

      if (error) {
        throw new Error(`Failed to list tasks: ${error.message}`)
      }

      return (data ?? []).map(mapFullTask)
}

async function applyAssignment(
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"],
  orgId: string,
  userId: string,
  taskId: string,
  input: { assignee_id?: string; assignee_kind?: "user" | "contact" | "company"; due_date?: string | null },
) {
  if (input.assignee_kind === "company") {
    throw new Error("Company assignments are not supported for tasks. Assign a person or contact.")
  }
  if (!input.assignee_id || !input.assignee_kind) return

  const payload: Record<string, unknown> = {
    org_id: orgId,
    task_id: taskId,
    assigned_by: userId,
    due_date: input.due_date ?? null,
    role: "assigned",
  }
  if (input.assignee_kind === "user") payload.user_id = input.assignee_id
  if (input.assignee_kind === "contact") payload.contact_id = input.assignee_id

  const { error } = await supabase.from("task_assignments").insert(payload)
  if (error) {
    throw new Error(`Failed to assign task: ${error.message}`)
  }
}

export async function createMyTaskAction(input: unknown): Promise<ActionResult<Task>> {
  return run(async () => {
      const parsed = taskInputSchema.parse(input)
      const { supabase, orgId, userId } = await requireOrgContext()

      const metadata = buildMetadata({}, parsed)

      const { data, error } = await supabase
        .from("tasks")
        .insert({
          org_id: orgId,
          project_id: parsed.project_id ?? null,
          title: parsed.title,
          description: parsed.description || null,
          status: parsed.status ?? "todo",
          priority: parsed.priority ?? "normal",
          start_date: parsed.start_date || null,
          due_date: parsed.due_date || null,
          reminder_at: parsed.reminder_at || null,
          metadata,
          created_by: userId,
          assigned_by: parsed.assignee_id ? userId : null,
        })
        .select("id")
        .single()

      if (error || !data) {
        throw new Error(`Failed to create task: ${error?.message ?? "Unknown error"}`)
      }

      await applyAssignment(supabase, orgId, userId, data.id, {
        assignee_id: parsed.assignee_id,
        assignee_kind: parsed.assignee_kind,
        due_date: parsed.due_date || null,
      })

      await recordEvent({
        orgId,
        eventType: "task_created",
        entityType: "task",
        entityId: data.id as string,
        payload: { title: parsed.title, project_id: parsed.project_id ?? null },
      })
      await recordAudit({ orgId, actorId: userId, action: "insert", entityType: "task", entityId: data.id as string, after: data })

      revalidatePath("/tasks")
      revalidatePath("/")
      return fetchTaskById(supabase, orgId, data.id)
  })
}

export async function updateMyTaskAction(taskId: string, input: Partial<TaskInput>): Promise<ActionResult<Task>> {
  return run(async () => {
      const parsed = taskUpdateSchema.parse(input)
      const { supabase, orgId, userId } = await requireOrgContext()

      const { data: existing, error: fetchError } = await supabase
        .from("tasks")
        .select("id, status, metadata, due_date, reminder_at")
        .eq("org_id", orgId)
        .eq("id", taskId)
        .single()

      if (fetchError || !existing) {
        throw new Error("Task not found or not accessible")
      }

      const updateData: Record<string, unknown> = {}
      if (parsed.title !== undefined) updateData.title = parsed.title
      if (parsed.description !== undefined) updateData.description = parsed.description || null
      if (parsed.priority !== undefined) updateData.priority = parsed.priority
      if (parsed.start_date !== undefined) updateData.start_date = parsed.start_date || null
      if (parsed.due_date !== undefined) updateData.due_date = parsed.due_date || null
      // Changing (or clearing) the reminder re-arms it: drop the sent stamp so the
      // cron can email the new time. Compare instants so timestamptz formatting
      // differences don't count as a change.
      if (parsed.reminder_at !== undefined) {
        const nextReminder = parsed.reminder_at || null
        updateData.reminder_at = nextReminder
        const prevMs = existing.reminder_at ? new Date(existing.reminder_at).getTime() : null
        const nextMs = nextReminder ? new Date(nextReminder).getTime() : null
        if (prevMs !== nextMs) {
          updateData.reminder_sent_at = null
        }
      }
      if (parsed.project_id !== undefined) updateData.project_id = parsed.project_id ?? null
      if (parsed.status !== undefined) {
        updateData.status = parsed.status
        if (parsed.status === "done" && existing.status !== "done") {
          updateData.completed_at = new Date().toISOString()
        } else if (parsed.status !== "done" && existing.status === "done") {
          updateData.completed_at = null
        }
      }
      updateData.metadata = buildMetadata((existing.metadata ?? {}) as Record<string, any>, parsed)

      const { error } = await supabase.from("tasks").update(updateData).eq("org_id", orgId).eq("id", taskId)
      if (error) {
        throw new Error(`Failed to update task: ${error.message}`)
      }

      // Reassignment: only touch assignments when an assignee was explicitly provided.
      if (parsed.assignee_id !== undefined && parsed.assignee_kind) {
        await supabase.from("task_assignments").delete().eq("org_id", orgId).eq("task_id", taskId)
        await applyAssignment(supabase, orgId, userId, taskId, {
          assignee_id: parsed.assignee_id,
          assignee_kind: parsed.assignee_kind,
          due_date: (updateData.due_date as string | null | undefined) ?? existing.due_date ?? null,
        })
      }

      await recordEvent({
        orgId,
        eventType: "task_updated",
        entityType: "task",
        entityId: taskId,
        payload: { title: parsed.title, status: parsed.status },
      })
      await recordAudit({ orgId, actorId: userId, action: "update", entityType: "task", entityId: taskId, after: updateData })

      revalidatePath("/tasks")
      revalidatePath("/")
      return fetchTaskById(supabase, orgId, taskId)
  })
}

export async function deleteMyTaskAction(taskId: string): Promise<ActionResult<void>> {
  return run(async () => {
      const { supabase, orgId, userId } = await requireOrgContext()

      const { data: existing, error: fetchError } = await supabase
        .from("tasks")
        .select("id, title")
        .eq("org_id", orgId)
        .eq("id", taskId)
        .single()

      if (fetchError || !existing) {
        throw new Error("Task not found")
      }

      await supabase.from("task_assignments").delete().eq("org_id", orgId).eq("task_id", taskId)

      const { error } = await supabase.from("tasks").delete().eq("org_id", orgId).eq("id", taskId)
      if (error) {
        throw new Error(`Failed to delete task: ${error.message}`)
      }

      await recordAudit({ orgId, actorId: userId, action: "delete", entityType: "task", entityId: taskId, before: existing })

      revalidatePath("/tasks")
      revalidatePath("/")
  })
}

/** Projects for the task's project picker/filter. */
export async function listTaskProjectsAction(): Promise<Array<{ id: string; name: string }>> {
      const { supabase, orgId } = await requireOrgContext()

      const { data, error } = await supabase
        .from("projects")
        .select("id, name")
        .eq("org_id", orgId)
        .order("name", { ascending: true })

      if (error) {
        throw new Error(`Failed to list projects: ${error.message}`)
      }

      return (data ?? []).map((row: any) => ({ id: row.id as string, name: String(row.name ?? "Untitled project") }))
}

/** Org-wide people a task can be assigned to: team members + contacts (no companies). */
export async function listOrgAssignableResourcesAction(): Promise<AssignableResource[]> {
      const { supabase, orgId } = await requireOrgContext()
      const resources: AssignableResource[] = []

      const { data: members } = await supabase
        .from("memberships")
        .select(`
          user_id,
          app_users!inner(id, full_name, email, avatar_url),
          roles!inner(key, label)
        `)
        .eq("org_id", orgId)
        .eq("status", "active")

      const seen = new Set<string>()
      for (const member of members ?? []) {
        const user = member.app_users as any
        if (!user?.id || seen.has(member.user_id)) continue
        seen.add(member.user_id)
        resources.push({
          id: member.user_id,
          name: user.full_name ?? "Unknown User",
          type: "user",
          email: user.email ?? undefined,
          avatar_url: user.avatar_url ?? undefined,
          role: (member.roles as any)?.label ?? undefined,
        })
      }

      const { data: contacts } = await supabase
        .from("contacts")
        .select(`
          id, full_name, email, role, contact_type, primary_company_id,
          companies!contacts_primary_company_id_fkey(name, company_type)
        `)
        .eq("org_id", orgId)

      for (const contact of contacts ?? []) {
        const company = contact.companies as any
        resources.push({
          id: contact.id,
          name: contact.full_name,
          type: "contact",
          email: contact.email ?? undefined,
          company_name: company?.name ?? undefined,
          role: contact.role ?? contact.contact_type ?? undefined,
          contact_type: contact.contact_type ?? undefined,
          company_type: company?.company_type ?? undefined,
        })
      }

      return resources
}
