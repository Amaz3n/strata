import { z } from "zod"

export const documentTypeSchema = z.enum(["proposal", "contract", "change_order", "other"])
export const documentStatusSchema = z.enum(["draft", "sent", "signed", "voided", "expired"])

export const documentCreateInputSchema = z.object({
  project_id: z.string().uuid(),
  document_type: documentTypeSchema,
  title: z.string().min(1, "Title is required"),
  source_file_id: z.string().uuid(),
  source_entity_type: z
    .enum(["proposal", "change_order", "lien_waiver", "selection", "subcontract", "closeout", "other"])
    .optional(),
  source_entity_id: z.string().uuid().optional(),
  metadata: z.record(z.any()).optional(),
})

export const documentFieldInputSchema = z.object({
  page_index: z.number().int().min(0),
  field_type: z.enum(["signature", "initials", "text", "date", "checkbox", "name"]),
  label: z.string().optional(),
  required: z.boolean().optional(),
  signer_role: z.string().optional(),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().gt(0).max(1),
  h: z.number().gt(0).max(1),
  sort_order: z.number().int().optional(),
  metadata: z.record(z.any()).optional(),
})

export const documentSigningRequestInputSchema = z.object({
  document_id: z.string().uuid(),
  recipient_contact_id: z.string().uuid().optional(),
  sent_to_email: z.string().email().optional(),
  expires_at: z.string().optional(),
  max_uses: z.number().int().min(1).optional(),
  signer_role: z.string().optional(),
  sequence: z.number().int().min(1).optional(),
  required: z.boolean().optional(),
  group_id: z.string().uuid().optional(),
  envelope_id: z.string().uuid().optional(),
  envelope_recipient_id: z.string().uuid().optional(),
})

export type DocumentCreateInput = z.infer<typeof documentCreateInputSchema>
export type DocumentFieldInput = z.infer<typeof documentFieldInputSchema>
export type DocumentSigningRequestInput = z.infer<typeof documentSigningRequestInputSchema>

export const documentSigningGroupInputSchema = z.object({
  document_id: z.string().uuid(),
  envelope_id: z.string().uuid().optional(),
  signers: z.array(
    z.object({
      signer_role: z.string(),
      recipient_contact_id: z.string().uuid().optional(),
      sent_to_email: z.string().email().optional(),
      envelope_recipient_id: z.string().uuid().optional(),
      sequence: z.number().int().min(1).optional(),
      required: z.boolean().optional(),
      expires_at: z.string().optional(),
      max_uses: z.number().int().min(1).optional(),
    })
  ).min(1, "At least one signer is required"),
})

export type DocumentSigningGroupInput = z.infer<typeof documentSigningGroupInputSchema>

export const envelopeCreateInputSchema = z.object({
  document_id: z.string().uuid(),
  source_entity_type: z
    .enum(["proposal", "change_order", "lien_waiver", "selection", "subcontract", "closeout", "other"])
    .optional(),
  source_entity_id: z.string().uuid().optional(),
  document_revision: z.number().int().min(1).optional(),
  subject: z.string().max(500).optional(),
  message: z.string().max(5000).optional(),
  expires_at: z.string().optional(),
  metadata: z.record(z.any()).optional(),
})

export const envelopeRecipientInputSchema = z.object({
  recipient_type: z.enum(["external_email", "contact", "internal_user"]),
  contact_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
  name: z.string().optional(),
  email: z.string().email().optional(),
  role: z.enum(["signer", "cc"]),
  signer_role: z.string().optional(),
  sequence: z.number().int().min(1).optional(),
  required: z.boolean().optional(),
  metadata: z.record(z.any()).optional(),
})

export const envelopeSigningRequestCreateInputSchema = z.object({
  envelope_id: z.string().uuid(),
  expires_at: z.string().optional(),
  max_uses: z.number().int().min(1).optional(),
})

export type EnvelopeCreateInput = z.infer<typeof envelopeCreateInputSchema>
export type EnvelopeRecipientInput = z.infer<typeof envelopeRecipientInputSchema>
export type EnvelopeSigningRequestCreateInput = z.infer<typeof envelopeSigningRequestCreateInputSchema>
