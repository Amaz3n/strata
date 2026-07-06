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
  mentioned_user_ids: z.array(z.string().uuid()).optional(),
})

export type DailyLogEntryInput = z.infer<typeof dailyLogEntrySchema>
export type DailyLogInput = z.infer<typeof dailyLogInputSchema>

const weatherSchema = z.union([
  z.string(),
  z.object({
    conditions: z.string().optional(),
    temperature: z.string().optional(),
    notes: z.string().optional(),
  }),
])

export const dayTypeSchema = z.enum(["work_day", "rain_day", "weekend", "holiday", "no_work"])

/** Manpower row: at least one of company/trade must be present. */
export const manpowerInputSchema = z
  .object({
    company: z.string().trim().optional(),
    trade: z.string().trim().optional(),
    workers: z.number().int().min(0).optional(),
    hours: z.number().min(0).optional(),
    notes: z.string().optional(),
  })
  .refine((v) => Boolean(v.company?.length || v.trade?.length), {
    message: "Enter a company or trade",
    path: ["company"],
  })

export type ManpowerInput = z.infer<typeof manpowerInputSchema>

/** Editable day-level fields on the report itself (not a contribution). */
export const dailyReportUpdateSchema = z.object({
  weather: weatherSchema.optional(),
  day_type: dayTypeSchema.optional(),
  share_with_client: z.boolean().optional(),
})

export type DailyReportUpdateInput = z.infer<typeof dailyReportUpdateSchema>
