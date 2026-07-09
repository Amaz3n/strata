import { z } from "zod"

export const submittalStatusSchema = z.enum([
  "draft",
  "pending",
  "submitted",
  "in_review",
  "approved",
  "approved_as_noted",
  "revise_resubmit",
  "rejected",
])

export const submittalInputSchema = z.object({
  project_id: z.string().uuid("Project is required"),
  submittal_number: z.coerce.number().positive("Submittal number must be positive").optional(),
  title: z.string().min(3, "Title is required"),
  description: z.string().optional(),
  status: submittalStatusSchema.default("submitted"),
  spec_section: z.string().optional(),
  submittal_type: z.string().optional(),
  due_date: z.string().optional(),
  required_on_site: z.string().optional().nullable(),
  lead_time_days: z.coerce.number().int().min(0).max(730).optional().nullable(),
  assigned_company_id: z.string().uuid().optional().nullable(),
  attachment_file_id: z.string().uuid().optional().nullable(),
})

export type SubmittalInput = z.infer<typeof submittalInputSchema>

export const submittalUpdateSchema = z.object({
  submittal_id: z.string().uuid(),
  title: z.string().min(3).optional(),
  description: z.string().optional().nullable(),
  status: submittalStatusSchema.optional(),
  spec_section: z.string().optional().nullable(),
  submittal_type: z.string().optional().nullable(),
  due_date: z.string().optional().nullable(),
  required_on_site: z.string().optional().nullable(),
  lead_time_days: z.coerce.number().int().min(0).max(730).optional().nullable(),
  assigned_company_id: z.string().uuid().optional().nullable(),
})

export type SubmittalUpdateInput = z.infer<typeof submittalUpdateSchema>

export const submittalItemInputSchema = z.object({
  submittal_id: z.string().uuid("Submittal is required"),
  description: z.string().min(2, "Description is required"),
  manufacturer: z.string().optional(),
  model_number: z.string().optional(),
  file_id: z.string().uuid().optional().nullable(),
  portal_token_id: z.string().uuid().optional().nullable(),
  created_via_portal: z.boolean().default(false),
  responder_user_id: z.string().uuid().optional().nullable(),
  responder_contact_id: z.string().uuid().optional().nullable(),
})

export type SubmittalItemInput = z.infer<typeof submittalItemInputSchema>

export const submittalDecisionSchema = z.object({
  submittal_id: z.string().uuid(),
  decision_status: z.enum(["approved", "approved_as_noted", "revise_resubmit", "rejected"]),
  decision_note: z.string().optional().nullable(),
})

export type SubmittalDecisionInput = z.infer<typeof submittalDecisionSchema>

export const portalSubmittalItemSchema = z.object({
  submittal_id: z.string().uuid("Submittal is required"),
  description: z.string().min(2, "Description is required"),
  manufacturer: z.string().optional(),
  model_number: z.string().optional(),
})

export type PortalSubmittalItemInput = z.infer<typeof portalSubmittalItemSchema>
