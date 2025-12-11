import { z } from "zod"

export const changeOrderLineInputSchema = z.object({
  description: z.string().min(2, "Description is required"),
  quantity: z
    .number({ invalid_type_error: "Quantity is required" })
    .min(0.01, "Quantity must be greater than zero"),
  unit: z.string().max(20).optional().default("unit"),
  unit_cost: z.number({ invalid_type_error: "Unit cost is required" }).min(0, "Unit cost must be positive"),
  allowance: z.number().min(0).default(0),
  taxable: z.boolean().default(true),
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
  days_impact: z.number().int().min(0).max(365).nullable().optional(),
  requires_signature: z.boolean().default(true),
  tax_rate: z.number().min(0).max(20).default(0),
  markup_percent: z.number().min(0).max(100).default(0),
  status: z.enum(["draft", "pending", "sent", "approved", "requested_changes", "cancelled"]).default("draft"),
  client_visible: z.boolean().default(false),
  lines: z.array(changeOrderLineInputSchema).min(1, "Add at least one line item"),
})

export type ChangeOrderLineInput = z.infer<typeof changeOrderLineInputSchema>
export type ChangeOrderInput = z.infer<typeof changeOrderInputSchema>



