import { z } from "zod"

export const submittalInputSchema = z.object({
  project_id: z.string().uuid("Project is required"),
  submittal_number: z.coerce.number().positive("Submittal number is required"),
  title: z.string().min(3, "Title is required"),
  description: z.string().optional(),
  status: z
    .enum(["draft", "pending", "submitted", "in_review", "approved", "approved_as_noted", "revise_resubmit", "rejected"])
    .default("submitted"),
  spec_section: z.string().optional(),
  submittal_type: z.string().optional(),
  due_date: z.string().optional(),
  attachment_file_id: z.string().uuid().optional().nullable(),
})

export type SubmittalInput = z.infer<typeof submittalInputSchema>

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
  decision_by_user_id: z.string().uuid().optional().nullable(),
  decision_by_contact_id: z.string().uuid().optional().nullable(),
  portal_token_id: z.string().uuid().optional().nullable(),
  actor_ip: z.string().optional().nullable(),
})

export type SubmittalDecisionInput = z.infer<typeof submittalDecisionSchema>
