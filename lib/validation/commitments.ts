import { z } from "zod"

export const commitmentStatusEnum = z
  .enum(["draft", "approved", "complete", "canceled"])
  .default("draft")

export const commitmentInputSchema = z.object({
  project_id: z.string().uuid(),
  company_id: z.string().uuid(),
  title: z.string().min(2, "Title is required"),
  total_cents: z.number().int().min(0),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  status: commitmentStatusEnum.optional(),
})

export const commitmentUpdateSchema = commitmentInputSchema.partial().omit({ project_id: true, company_id: true })

export const commitmentLineInputSchema = z.object({
  cost_code_id: z.string().uuid(),
  description: z.string().min(1, "Description is required"),
  quantity: z.number().min(0),
  unit: z.string().min(1, "Unit is required"),
  unit_cost_cents: z.number().int().min(0),
})

export const commitmentLineUpdateSchema = commitmentLineInputSchema.partial()

export type CommitmentInput = z.infer<typeof commitmentInputSchema>
export type CommitmentUpdateInput = z.infer<typeof commitmentUpdateSchema>
export type CommitmentLineInput = z.infer<typeof commitmentLineInputSchema>
export type CommitmentLineUpdateInput = z.infer<typeof commitmentLineUpdateSchema>