import { z } from "zod"

export const estimateLineInputSchema = z.object({
  description: z.string().min(1, "Description is required"),
  quantity: z.number().min(0),
  unit_cost_cents: z.number().min(0),
  item_type: z.enum(["line", "group"]).default("line"),
  cost_code_id: z.string().uuid().optional(),
  markup_pct: z.number().optional(),
  unit: z.string().optional(),
  notes: z.string().optional(),
})

export const estimateInputSchema = z.object({
  title: z.string().min(1, "Title is required"),
  project_id: z.string().uuid().optional().nullable(),
  recipient_contact_id: z.string().uuid().optional().nullable(),
  summary: z.string().optional(),
  terms: z.string().optional(),
  valid_until: z.string().optional(),
  tax_rate: z.number().optional(),
  markup_percent: z.number().optional(),
  lines: z.array(estimateLineInputSchema).min(1, "At least one line is required"),
})

export type EstimateInput = z.infer<typeof estimateInputSchema>
