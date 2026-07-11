import { z } from "zod"

export const changeOrderLineInputSchema = z.object({
  cost_code_id: z.string().uuid().optional(),
  budget_line_id: z.string().uuid().optional(),
  description: z.string().min(2, "Description is required"),
  quantity: z
    .number({ invalid_type_error: "Quantity is required" })
    .min(0.01, "Quantity must be greater than zero"),
  unit: z.string().max(20).optional().default("unit"),
  unit_cost: z.number({ invalid_type_error: "Unit cost is required" }),
  internal_cost_cents: z.number().int().nullable().optional(),
  commitment_change_order_id: z.string().uuid().nullable().optional(),
  allowance: z.number().default(0),
  taxable: z.boolean().default(true),
  gmp_classification: z.enum(["inside_gmp", "outside_gmp"]).default("inside_gmp"),
  gmp_impact: z.enum(["none", "increase_gmp", "decrease_gmp", "outside_gmp"]).default("none"),
})

export const changeOrderInputSchema = z.object({
  project_id: z.string().uuid("Project is required"),
  title: z.string().min(3, "Title is required"),
  summary: z.string().min(3, "Summary is required"),
  description: z
    .string()
    .max(2000, "Description is too long")
    .optional()
    .transform((val) => (val && val.trim().length > 0 ? val : undefined)),
  intro: z.string().max(4000, "Cover note is too long").optional(),
  terms: z.string().max(8000, "Terms are too long").optional(),
  pricing_display: z.enum(["itemized", "subtotals", "lump_sum"]).optional().default("itemized"),
  days_impact: z.number().int().min(-365).max(365).nullable().optional(),
  requires_signature: z.boolean().default(true),
  tax_rate: z.number().min(0).max(20).default(0),
  markup_percent: z.number().min(0).max(100).default(0),
  markup_mode: z.enum(["percent", "manual"]).default("percent"),
  lifecycle: z.enum(["draft", "pricing", "proposed", "approved", "rejected", "void"]).default("draft"),
  owner_response_due: z.string().date().nullable().optional(),
  zero_dollar: z.boolean().default(false),
  status: z.enum(["draft", "pending", "sent", "approved", "requested_changes", "cancelled"]).default("draft"),
  client_visible: z.boolean().default(false),
  lines: z.array(changeOrderLineInputSchema).min(1, "Add at least one line item"),
})

export type ChangeOrderLineInput = z.infer<typeof changeOrderLineInputSchema>
export type ChangeOrderInput = z.infer<typeof changeOrderInputSchema>


