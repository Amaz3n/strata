import { z } from "zod"

export const primeSovLineInputSchema = z.object({
  id: z.string().uuid().optional(),
  description: z.string().min(1, "Description is required").max(500),
  cost_code_id: z.string().uuid().optional().nullable(),
  budget_line_id: z.string().uuid().optional().nullable(),
  scheduled_value_cents: z.number().int(),
  retainage_percent_override: z.number().min(0).max(100).optional().nullable(),
})

export const primeSovLinesUpsertSchema = z.object({
  lines: z.array(primeSovLineInputSchema).max(500, "Too many SOV lines"),
})

export const payApplicationCreateSchema = z.object({
  period_start: z.string().optional().nullable(),
  period_end: z.string().min(1, "Period end is required"),
})

export const payApplicationLineEntrySchema = z
  .object({
    prime_sov_line_id: z.string().uuid(),
    this_period_cents: z.number().int().optional(),
    percent_complete: z.number().min(0).max(100).optional(),
    stored_materials_cents: z.number().int().min(0).default(0),
  })
  .refine((entry) => entry.this_period_cents != null || entry.percent_complete != null, {
    message: "Enter a this-period amount or a percent complete",
  })

export const payApplicationLinesUpdateSchema = z.object({
  entries: z.array(payApplicationLineEntrySchema).min(1, "Enter at least one line"),
  allow_overbilling: z.boolean().default(false),
})

export const retainageReleaseInputSchema = z.object({
  amount_cents: z.number().int().min(1).optional(),
  full: z.boolean().default(false),
})

export const retainageScheduleStepSchema = z.object({
  until_percent_complete: z.number().gt(0).max(100),
  retainage_percent: z.number().min(0).max(100),
})

export const retainageScheduleSchema = z
  .array(retainageScheduleStepSchema)
  .max(10, "Too many retainage steps")
  .optional()
  .nullable()

export type PrimeSovLineInput = z.infer<typeof primeSovLineInputSchema>
export type PayApplicationLineEntry = z.infer<typeof payApplicationLineEntrySchema>
export type RetainageReleaseInput = z.infer<typeof retainageReleaseInputSchema>
