import { z } from "zod"

export const decisionStatusSchema = z.enum(["requested", "pending", "approved", "revised"]).default("requested")

export const decisionInputSchema = z.object({
  project_id: z.string().uuid("Project is required"),
  title: z.string().min(1, "Title is required").max(200),
  description: z.string().max(2000).optional().nullable(),
  status: decisionStatusSchema.optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format").optional().nullable(),
})

export const decisionUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional().nullable(),
  status: decisionStatusSchema.optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format").optional().nullable(),
})

export type DecisionInput = z.infer<typeof decisionInputSchema>
export type DecisionUpdateInput = z.infer<typeof decisionUpdateSchema>
