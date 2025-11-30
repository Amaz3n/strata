import { z } from "zod"

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
})

export type DailyLogInput = z.infer<typeof dailyLogInputSchema>
