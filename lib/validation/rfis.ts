import { z } from "zod"

export const rfiStatusSchema = z.enum(["draft", "open", "answered", "closed"])
export const rfiPrioritySchema = z.enum(["low", "normal", "high", "urgent"])

export const rfiInputSchema = z.object({
  project_id: z.string().uuid("Project is required"),
  rfi_number: z.coerce.number().positive().optional(),
  subject: z.string().min(3, "Subject is required"),
  question: z.string().min(5, "Question is required"),
  status: rfiStatusSchema.default("open"),
  priority: rfiPrioritySchema.default("normal"),
  due_date: z.string().optional().nullable(),
  attachment_file_id: z.string().uuid().optional().nullable(),
  notify_contact_id: z.string().uuid().optional().nullable(),
  assigned_to: z.string().uuid().optional().nullable(),
  assigned_company_id: z.string().uuid().optional().nullable(),
  submitted_by_company_id: z.string().uuid().optional().nullable(),
  location: z.string().optional().nullable(),
  drawing_reference: z.string().optional().nullable(),
  spec_reference: z.string().optional().nullable(),
  cost_impact_cents: z.coerce.number().int().optional().nullable(),
  schedule_impact_days: z.coerce.number().int().optional().nullable(),
})

export type RfiInput = z.infer<typeof rfiInputSchema>

export const createRfiRequestSchema = rfiInputSchema.extend({
  send_now: z.boolean().optional().default(true),
})

export type CreateRfiRequestInput = z.infer<typeof createRfiRequestSchema>

export const rfiResponseInputSchema = z.object({
  rfi_id: z.string().uuid("RFI is required"),
  body: z.string().min(2, "Response is required"),
  response_type: z.enum(["answer", "clarification", "comment"]).default("comment"),
  responder_contact_id: z.string().uuid().optional().nullable(),
  responder_user_id: z.string().uuid().optional().nullable(),
  file_id: z.string().uuid().optional().nullable(),
  portal_token_id: z.string().uuid().optional().nullable(),
  actor_ip: z.string().optional().nullable(),
  created_via_portal: z.boolean().default(false),
})

export type RfiResponseInput = z.infer<typeof rfiResponseInputSchema>

export const rfiDecisionSchema = z.object({
  rfi_id: z.string().uuid(),
  decision_status: z.enum(["approved", "revisions_requested", "rejected"]),
  decision_note: z.string().optional().nullable(),
  decided_by_user_id: z.string().uuid().optional().nullable(),
  decided_by_contact_id: z.string().uuid().optional().nullable(),
  portal_token_id: z.string().uuid().optional().nullable(),
  actor_ip: z.string().optional().nullable(),
})

export type RfiDecisionInput = z.infer<typeof rfiDecisionSchema>

export const portalRfiInputSchema = z.object({
  subject: z.string().min(3, "Subject is required"),
  question: z.string().min(5, "Question is required"),
  priority: rfiPrioritySchema.default("normal"),
  due_date: z.string().optional().nullable(),
})

export type PortalRfiInput = z.infer<typeof portalRfiInputSchema>
