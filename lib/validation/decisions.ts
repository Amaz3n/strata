import { z } from "zod"

export const decisionStatusSchema = z
  .enum(["requested", "pending", "approved", "declined", "revised"])
  .default("requested")

export const decisionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1, "Option label is required").max(200),
  description: z.string().max(1000).optional().nullable(),
  cost_delta_cents: z.coerce.number().int().optional().nullable(),
})

export type DecisionOption = z.infer<typeof decisionOptionSchema>

export const decisionInputSchema = z.object({
  project_id: z.string().uuid("Project is required"),
  title: z.string().min(1, "Title is required").max(200),
  description: z.string().max(2000).optional().nullable(),
  status: decisionStatusSchema.optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format").optional().nullable(),
  options: z.array(decisionOptionSchema).max(10).optional(),
  notify_contact_id: z.string().uuid().optional().nullable(),
})

export const decisionUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional().nullable(),
  status: decisionStatusSchema.optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format").optional().nullable(),
  options: z.array(decisionOptionSchema).max(10).optional(),
  notify_contact_id: z.string().uuid().optional().nullable(),
})

export const portalDecisionSchema = z.object({
  decision_id: z.string().uuid(),
  approve: z.boolean(),
  selected_option_id: z.string().optional().nullable(),
  note: z.string().max(2000).optional().nullable(),
})

export type DecisionInput = z.infer<typeof decisionInputSchema>
export type DecisionUpdateInput = z.infer<typeof decisionUpdateSchema>
export type PortalDecisionInput = z.infer<typeof portalDecisionSchema>
