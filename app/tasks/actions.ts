"use server"

import { revalidatePath } from "next/cache"

import { createTask, listTasks, updateTask } from "@/lib/services/tasks"
import { taskInputSchema, taskUpdateSchema } from "@/lib/validation/tasks"

export async function listTasksAction() {
  return listTasks()
}

export async function createTaskAction(input: unknown) {
  const parsed = taskInputSchema.parse(input)
  const task = await createTask({ input: parsed })
  revalidatePath("/tasks")
  revalidatePath("/")
  return task
}

export async function updateTaskAction(taskId: string, input: unknown) {
  const parsed = taskUpdateSchema.parse(input)
  const task = await updateTask({ taskId, input: parsed })
  revalidatePath("/tasks")
  revalidatePath("/")
  return task
}
