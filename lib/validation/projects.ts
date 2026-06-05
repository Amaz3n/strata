import { z } from "zod"

export const projectInputSchema = z.object({
  name: z.string().min(1, "Project name is required"),
  status: z.enum(["planning", "bidding", "active", "on_hold", "completed", "cancelled"]).optional(),
  start_date: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
  address: z.string().optional(),
  location: z.record(z.unknown()).optional(),
  client_id: z.string().uuid().optional().nullable(),
  description: z.string().optional(),
  property_type: z.enum(["residential", "commercial"]).optional(),
  project_type: z.enum(["new_construction", "remodel", "addition", "renovation", "repair"]).optional(),
  total_value: z.number().optional(),
  retainage_percent: z.number().min(0).max(100).optional(),
  total_contract_value_cents: z.number().int().nonnegative().optional().nullable(),
  contract_type: z.enum(["fixed", "cost_plus", "time_materials"]).optional(),
  billing_model: z
    .enum(["fixed_price", "cost_plus_percent", "cost_plus_fixed_fee", "cost_plus_gmp", "time_and_materials"])
    .optional(),
  markup_percent: z.number().min(0).max(200).optional().nullable(),
  gmp_cents: z.number().int().nonnegative().optional().nullable(),
  fixed_fee_cents: z.number().int().nonnegative().optional().nullable(),
  savings_split_owner_pct: z.number().min(0).max(100).optional().nullable(),
  savings_split_builder_pct: z.number().min(0).max(100).optional().nullable(),
  labor_burden_multiplier: z.number().min(1).optional().nullable(),
  requires_client_cost_approval: z.boolean().optional(),
  open_book: z.boolean().optional(),
  paid_costs_required: z.boolean().optional(),
  proof_required: z.boolean().optional(),
  cost_codes_enabled: z.boolean().optional(),
  prospect_id: z.string().uuid().optional().nullable(),
  qbo_class_id: z.string().optional().nullable(),
  qbo_class_name: z.string().optional().nullable(),
  qbo_customer_id: z.string().optional().nullable(),
  qbo_customer_name: z.string().optional().nullable(),
})

export const projectUpdateSchema = projectInputSchema.partial()

export type ProjectInput = z.infer<typeof projectInputSchema>
