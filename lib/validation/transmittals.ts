import { z } from "zod"

export const transmittalPurposeSchema = z.enum(["for_review", "for_approval", "for_record", "for_construction", "as_requested"])

export const transmittalItemSchema = z.object({
  file_id: z.string().uuid().optional().nullable(),
  entity_type: z.enum(["drawing_sheet", "submittal", "rfi", "file"]).optional().nullable(),
  entity_id: z.string().uuid().optional().nullable(),
  description: z.string().min(1).max(500),
  copies: z.number().int().min(1).max(999).default(1),
})

export const transmittalRecipientSchema = z.object({
  contact_id: z.string().uuid().optional().nullable(),
  email: z.string().email(),
  display_name: z.string().min(1).max(200),
  company_name: z.string().max(200).optional().nullable(),
})

export const createTransmittalSchema = z.object({
  project_id: z.string().uuid(),
  subject: z.string().min(2).max(240),
  purpose: transmittalPurposeSchema.default("for_review"),
  notes: z.string().max(10000).optional().nullable(),
  items: z.array(transmittalItemSchema).min(1),
  recipients: z.array(transmittalRecipientSchema).min(1),
})

export type CreateTransmittalInput = z.infer<typeof createTransmittalSchema>

