"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { requireOrgContext } from "@/lib/services/context"

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
    const details = `${error?.message ?? ""} ${error?.details ?? ""}`.toLowerCase()
    if (details.includes("project_id") && details.includes("not-null")) {
      throw new Error(
        "Global tasks require DB migration `20260211133000_make_tasks_project_optional.sql` (tasks.project_id must allow NULL).",
      )
    }
    throw new Error(`Failed to create task: ${error?.message ?? "Unknown error"}`)
  }

  revalidatePath("/tasks")
  revalidatePath("/")
  return mapUserTask(data)
}

export async function updateTaskAction(taskId: string, input: unknown) {
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
}

export async function deleteTaskAction(taskId: string) {
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
}
