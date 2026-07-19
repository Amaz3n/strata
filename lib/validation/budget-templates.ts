import { z } from "zod"

import { COST_TYPES } from "@/lib/cost-types"

export const budgetTemplateLineInputSchema = z.object({
  costCodeId: z.string().uuid().optional().nullable(),
  costType: z.enum(COST_TYPES).optional().nullable(),
  description: z.string().trim().min(1, "Description is required").max(500),
  amountCents: z.number().int().min(0).optional().nullable(),
  quantity: z.number().min(0).optional().nullable(),
  uom: z.string().trim().min(1).max(24).optional().nullable(),
  unitCostCents: z.number().int().min(0).optional().nullable(),
  metadata: z.record(z.unknown()).optional(),
}).superRefine((line, context) => {
  const hasFixedAmount = line.amountCents !== null && line.amountCents !== undefined
  const hasQuantityBasis = line.quantity !== null && line.quantity !== undefined
    && line.unitCostCents !== null && line.unitCostCents !== undefined
  if (!hasFixedAmount && !hasQuantityBasis) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Enter an amount or quantity and unit cost" })
  }
})

export const budgetTemplateInputSchema = z.object({
  name: z.string().trim().min(1, "Template name is required").max(160),
  description: z.string().trim().max(2000).optional().nullable(),
  divisionId: z.string().uuid().optional().nullable(),
  propertyType: z.string().trim().max(80).optional().nullable(),
  metadata: z.record(z.unknown()).optional(),
  lines: z.array(budgetTemplateLineInputSchema).min(1, "Add at least one line").max(1000),
})

export type BudgetTemplateInput = z.infer<typeof budgetTemplateInputSchema>
export type BudgetTemplateLineInput = z.infer<typeof budgetTemplateLineInputSchema>
