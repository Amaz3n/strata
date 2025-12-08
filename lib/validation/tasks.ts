import { z } from "zod"

export const taskChecklistItemSchema = z.object({
  id: z.string(),
  text: z.string().min(1),
  completed: z.boolean().default(false),
  completed_at: z.string().optional(),
  completed_by: z.string().optional(),
})

export const taskTradeSchema = z.enum([
  "general",
  "demolition",
  "concrete",
  "framing",
  "roofing",
  "electrical",
  "plumbing",
  "hvac",
  "insulation",
  "drywall",
  "painting",
  "flooring",
  "cabinets",
  "tile",
  "landscaping",
  "other",
])

const baseTaskSchema = z.object({
  project_id: z.string().uuid("Project is required"),
  title: z.string().min(2, "Title is required"),
  description: z.string().optional(),
  status: z.enum(["todo", "in_progress", "blocked", "done"]).default("todo"),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  start_date: z.string().optional(),
  due_date: z.string().optional(),
  assignee_id: z.string().uuid().optional(),
  assignee_kind: z.enum(["user", "contact", "company"]).optional(),
  // Construction-specific
  location: z.string().optional(),
  trade: taskTradeSchema.optional(),
  estimated_hours: z.number().min(0).optional(),
  tags: z.array(z.string()).optional(),
  checklist: z.array(taskChecklistItemSchema).optional(),
})

const assigneeRefinement = (data: { assignee_id?: string; assignee_kind?: string }) => {
  if (data.assignee_kind) {
    return !!data.assignee_id
  }
  return true
}

export const taskInputSchema = baseTaskSchema.refine(assigneeRefinement, {
  message: "Assignee id is required when assignee type is set",
  path: ["assignee_id"],
})

export const taskUpdateSchema = baseTaskSchema
  .partial()
  .extend({
    status: z.enum(["todo", "in_progress", "blocked", "done"]).optional(),
    priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
    actual_hours: z.number().min(0).optional(),
  })
  .refine(assigneeRefinement, {
    message: "Assignee id is required when assignee type is set",
    path: ["assignee_id"],
  })

export type TaskInput = z.infer<typeof taskInputSchema>
export type TaskUpdate = z.infer<typeof taskUpdateSchema>
export type TaskChecklistItemInput = z.infer<typeof taskChecklistItemSchema>
