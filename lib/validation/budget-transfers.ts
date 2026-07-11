import { z } from "zod"

export const budgetTransferLineInputSchema = z.object({
  budget_line_id: z.string().uuid(),
  amount_cents: z.number().int().refine((value) => value !== 0, "Amount cannot be zero"),
})

export const budgetTransferInputSchema = z.object({
  project_id: z.string().uuid(),
  reason: z.string().trim().min(3).max(1000),
  lines: z.array(budgetTransferLineInputSchema).min(2),
  allow_override: z.boolean().default(false),
  override_reason: z.string().trim().max(1000).nullable().optional(),
})

export type BudgetTransferInput = z.infer<typeof budgetTransferInputSchema>
