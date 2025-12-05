import { z } from "zod"

export const rfiInputSchema = z.object({
  project_id: z.string().uuid("Project is required"),
  rfi_number: z.coerce.number().positive("RFI number is required"),
  subject: z.string().min(3, "Subject is required"),
  question: z.string().min(5, "Question is required"),
  status: z.enum(["draft", "open", "in_review", "answered", "closed"]).default("open"),
  priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
  due_date: z.string().optional().nullable(),
  attachment_file_id: z.string().uuid().optional().nullable(),
})

export type RfiInput = z.infer<typeof rfiInputSchema>

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
