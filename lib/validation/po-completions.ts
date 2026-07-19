import { z } from "zod"

export const reportPoCompletionSchema = z.object({
  commitment_id: z.string().uuid(),
  commitment_line_ids: z.array(z.string().uuid()).min(1).max(100).nullable().optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
  photo_file_ids: z.array(z.string().uuid()).max(20).default([]),
  reported_source: z.enum(["trade_portal", "super_mobile", "office"]),
})

export const rejectPoCompletionSchema = z.object({
  reason: z.string().trim().min(3).max(2000),
})

export type ReportPoCompletionInput = z.infer<typeof reportPoCompletionSchema>
