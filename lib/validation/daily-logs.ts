import { z } from "zod"

const dailyLogEntrySchema = z.object({
  entry_type: z.enum([
    "work",
    "constraint",
    "inspection",
    "safety",
    "delivery",
    "note",
    "task_update",
    "punch_update",
  ]),
  description: z.string().optional(),
  quantity: z.number().optional(),
  hours: z.number().optional(),
  progress: z.number().min(0).max(100).optional(),
  schedule_item_id: z.string().uuid().optional(),
  task_id: z.string().uuid().optional(),
  punch_item_id: z.string().uuid().optional(),
  cost_code_id: z.string().uuid().optional(),
  location: z.string().optional(),
  trade: z.string().optional(),
  labor_type: z.string().optional(),
  inspection_result: z.enum(["pass", "fail", "partial", "n_a"]).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
})

export const dailyLogInputSchema = z.object({
  project_id: z.string().uuid("Project is required"),
  date: z.string().min(1, "Date is required"),
  summary: z.string().optional(),
  weather: z
    .union([
      z.string(),
      z.object({
        conditions: z.string().optional(),
        temperature: z.string().optional(),
        notes: z.string().optional(),
      }),
    ])
    .optional(),
  entries: z.array(dailyLogEntrySchema).optional(),
})

export type DailyLogEntryInput = z.infer<typeof dailyLogEntrySchema>
export type DailyLogInput = z.infer<typeof dailyLogInputSchema>
