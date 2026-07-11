import { z } from "zod"

export const commitmentStatusEnum = z
  .enum(["draft", "approved", "complete", "canceled"])
  .default("draft")

export const commitmentInputSchema = z.object({
  project_id: z.string().uuid(),
  company_id: z.string().uuid(),
  title: z.string().min(2, "Title is required"),
  total_cents: z.number().int().min(0),
  contract_number: z.string().max(100).nullable().optional(),
  scope: z.string().max(5000).nullable().optional(),
  terms: z.string().max(10000).nullable().optional(),
  retainage_percent: z.number().min(0).max(100).nullable().optional(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  status: commitmentStatusEnum.optional(),
  prequal_override_note: z.string().trim().max(1000).optional(),
})

export const commitmentUpdateSchema = commitmentInputSchema.partial().omit({ project_id: true, company_id: true })

export const commitmentLineInputSchema = z.object({
  cost_code_id: z.string().uuid().nullable().optional(),
  budget_line_id: z.string().uuid().nullable().optional(),
  description: z.string().min(1, "Description is required"),
  quantity: z.number().min(0),
  unit: z.string().min(1, "Unit is required"),
  unit_cost_cents: z.number().int().min(0),
  scheduled_value_cents: z.number().int().min(0).nullable().optional(),
  retainage_percent: z.number().min(0).max(100).nullable().optional(),
})

export const commitmentLineUpdateSchema = commitmentLineInputSchema.partial()

export type CommitmentInput = z.infer<typeof commitmentInputSchema>
export type CommitmentUpdateInput = z.infer<typeof commitmentUpdateSchema>
export type CommitmentLineInput = z.infer<typeof commitmentLineInputSchema>
export type CommitmentLineUpdateInput = z.infer<typeof commitmentLineUpdateSchema>
