import type { SupabaseClient } from "@supabase/supabase-js"

import type { Task } from "@/lib/types"
import type { TaskInput } from "@/lib/validation/tasks"
import { taskUpdateSchema } from "@/lib/validation/tasks"
import { recordEvent } from "@/lib/services/events"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"

function mapTask(row: any): Task {
  const assignments = Array.isArray(row.task_assignments) ? row.task_assignments : []
  const assignee = assignments.find((assignment) => assignment?.user_id)

  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    title: row.title,
    description: row.description ?? undefined,
    status: row.status,
    priority: row.priority,
    due_date: row.due_date ?? undefined,
    assignee_id: assignee?.user_id ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export async function listTasks(orgId?: string): Promise<Task[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  return listTasksWithClient(supabase, resolvedOrgId)
}

export async function listTasksWithClient(supabase: SupabaseClient, orgId: string): Promise<Task[]> {
  const { data, error } = await supabase
    .from("tasks")
    .select("id, org_id, project_id, title, description, status, priority, due_date, created_at, updated_at, task_assignments(user_id)")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to list tasks: ${error.message}`)
  }

  return (data ?? []).map(mapTask)
}

export async function createTask({ input, orgId }: { input: TaskInput; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("tasks")
    .insert({
      org_id: resolvedOrgId,
      project_id: input.project_id,
      title: input.title,
      description: input.description,
      status: input.status ?? "todo",
      priority: input.priority ?? "normal",
      due_date: input.due_date,
      created_by: userId,
    })
    .select("id, org_id, project_id, title, description, status, priority, due_date, created_at, updated_at")
    .single()

  if (error) {
    throw new Error(`Failed to create task: ${error.message}`)
  }

  if (input.assignee_id) {
    const { error: assignmentError } = await supabase.from("task_assignments").upsert({
      org_id: resolvedOrgId,
      task_id: data.id,
      user_id: input.assignee_id,
      assigned_by: userId,
      due_date: input.due_date,
    })

    if (assignmentError) {
      console.error("Failed to assign task", assignmentError)
    }
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "task_created",
    entityType: "task",
    entityId: data.id as string,
    payload: { title: input.title, project_id: input.project_id },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "task",
    entityId: data.id as string,
    after: data,
  })

  return mapTask(data)
}

export async function updateTask({
  taskId,
  input,
  orgId,
}: {
  taskId: string
  input: Partial<TaskInput>
  orgId?: string
}) {
  const parsed = taskUpdateSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const existing = await supabase
    .from("tasks")
    .select("id, org_id, project_id, title, description, status, priority, due_date, created_at, updated_at, task_assignments(user_id)")
    .eq("org_id", resolvedOrgId)
    .eq("id", taskId)
    .single()

  if (existing.error || !existing.data) {
    throw new Error("Task not found or not accessible")
  }

  const { data, error } = await supabase
    .from("tasks")
    .update({
      title: parsed.title,
      description: parsed.description,
      status: parsed.status,
      priority: parsed.priority,
      due_date: parsed.due_date,
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", taskId)
    .select("id, org_id, project_id, title, description, status, priority, due_date, created_at, updated_at, task_assignments(user_id)")
    .single()

  if (error || !data) {
    throw new Error(`Failed to update task: ${error?.message}`)
  }

  if (parsed.assignee_id) {
    const { error: assignmentError } = await supabase.from("task_assignments").upsert({
      org_id: resolvedOrgId,
      task_id: data.id,
      user_id: parsed.assignee_id,
      assigned_by: userId,
      due_date: parsed.due_date ?? data.due_date,
    })

    if (assignmentError) {
      console.error("Failed to assign task", assignmentError)
    }
  }

  if (parsed.status === "done" && !existing.data.completed_at) {
    await supabase.from("tasks").update({ completed_at: new Date().toISOString() }).eq("id", data.id)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "task_updated",
    entityType: "task",
    entityId: data.id as string,
    payload: { title: data.title, status: data.status },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "task",
    entityId: data.id as string,
    before: existing.data,
    after: data,
  })

  return mapTask(data)
}
