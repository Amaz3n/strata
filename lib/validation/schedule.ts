import { z } from "zod"

export const scheduleItemInputSchema = z.object({
  project_id: z.string().uuid("Project is required"),
  name: z.string().min(2, "Name is required"),
  item_type: z.string().default("task"),
  status: z.string().default("planned"),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  progress: z.number().int().min(0).max(100).optional(),
  assigned_to: z.string().uuid().optional(),
  metadata: z.record(z.any()).optional(),
  dependencies: z.array(z.string().uuid()).optional(),
  notes: z.string().optional(),
})

export const scheduleItemUpdateSchema = scheduleItemInputSchema.partial()

export type ScheduleItemInput = z.infer<typeof scheduleItemInputSchema>
