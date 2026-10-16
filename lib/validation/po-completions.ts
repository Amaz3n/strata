import { z } from "zod"

export const reportPoCompletionSchema = z.object({
  commitment_id: z.string().uuid(),
  /** Null covers the whole order. An empty list covers no line: a completion for variance orders alone. */
  commitment_line_ids: z.array(z.string().uuid()).max(100).nullable().optional(),
  /** Approved variance orders this completion claims, billed with it. A whole-order completion bills every unclaimed one. */
  change_order_ids: z.array(z.string().uuid()).max(100).nullable().optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
  photo_file_ids: z.array(z.string().uuid()).max(20).default([]),
  reported_source: z.enum(["trade_portal", "super_mobile", "office"]),
}).refine((value) => value.commitment_line_ids == null || value.commitment_line_ids.length > 0 || (value.change_order_ids?.length ?? 0) > 0, {
  message: "Choose at least one line or variance order to report.",
  path: ["commitment_line_ids"],
})

export const rejectPoCompletionSchema = z.object({
  reason: z.string().trim().min(3).max(2000),
})

export type ReportPoCompletionInput = z.infer<typeof reportPoCompletionSchema>
