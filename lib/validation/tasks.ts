import { z } from "zod"

export const taskInputSchema = z.object({
  project_id: z.string().uuid("Project is required"),
  title: z.string().min(2, "Title is required"),
  description: z.string().optional(),
  status: z.enum(["todo", "in_progress", "blocked", "done"]).default("todo"),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  due_date: z.string().optional(),
  assignee_id: z.string().uuid().optional(),
})

export const taskUpdateSchema = taskInputSchema.partial().extend({
  status: z.enum(["todo", "in_progress", "blocked", "done"]).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
})

export type TaskInput = z.infer<typeof taskInputSchema>
