import { z } from "zod"

export const UNIFIED_ESIGN_PHASE0_VERSION = "2026-02-07.phase0" as const
export const UNIFIED_ESIGN_FEATURE_FLAG_KEY = "unified_esign" as const
export const UNIFIED_ESIGN_SIGNING_ROUTE_TEMPLATE = "/d/[token]" as const

export const unifiedSignableEntityTypeSchema = z.enum([
  "proposal",
  "change_order",
  "lien_waiver",
  "selection",
  "subcontract",
  "closeout",
  "other",
])

export const envelopeLifecycleStatusSchema = z.enum([
  "draft",
  "sent",
  "partially_signed",
  "executed",
  "voided",
  "expired",
])

export const envelopeRecipientTypeSchema = z.enum(["external_email", "contact", "internal_user"])
export const envelopeRecipientRoleSchema = z.enum(["signer", "cc"])

const legacyDocumentStatusSchema = z.enum(["draft", "sent", "signed", "voided", "expired"])

const draftEnvelopeRecipientSchema = z.object({
  type: envelopeRecipientTypeSchema.default("external_email"),
  name: z.string().optional(),
  email: z.string().optional(),
  contact_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
  role: envelopeRecipientRoleSchema.default("signer"),
  signer_role: z.string().optional(),
  sequence: z.number().int().min(1).optional(),
  required: z.boolean().optional(),
})

const sendEnvelopeRecipientSchema = draftEnvelopeRecipientSchema.superRefine((recipient, ctx) => {
  const email = recipient.email?.trim()
  const signerRole = recipient.signer_role?.trim()

  if (!email) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["email"],
      message: "Email is required to send signing requests",
    })
  }

  if (recipient.type === "contact" && !recipient.contact_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["contact_id"],
      message: "Contact recipients require contact_id",
    })
  }

  if (recipient.type === "internal_user" && !recipient.user_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["user_id"],
      message: "Internal recipients require user_id",
    })
  }

  if (recipient.role === "signer" && !signerRole) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["signer_role"],
      message: "signer_role is required for signer recipients",
    })
  }
})

export type UnifiedSignableEntityType = z.infer<typeof unifiedSignableEntityTypeSchema>
export type EnvelopeLifecycleStatus = z.infer<typeof envelopeLifecycleStatusSchema>
export type EnvelopeRecipientType = z.infer<typeof envelopeRecipientTypeSchema>
export type EnvelopeRecipientRole = z.infer<typeof envelopeRecipientRoleSchema>
export type LegacyDocumentStatus = z.infer<typeof legacyDocumentStatusSchema>

export type DraftEnvelopeRecipientInput = z.input<typeof draftEnvelopeRecipientSchema>
export type SendEnvelopeRecipientInput = z.input<typeof sendEnvelopeRecipientSchema>

export type NormalizedEnvelopeRecipient = {
  type: EnvelopeRecipientType
  name: string
  email?: string
  contact_id?: string
  user_id?: string
  role: EnvelopeRecipientRole
  signer_role?: string
  sequence?: number
  required: boolean
}

export const ENVELOPE_EVENT_TYPES = {
  created: "envelope_created",
  sent: "envelope_sent",
  viewed: "envelope_viewed",
  recipientSigned: "recipient_signed",
  executed: "envelope_executed",
  voided: "envelope_voided",
} as const

export const completionEventByEntityType: Record<
  Extract<UnifiedSignableEntityType, "proposal" | "change_order" | "lien_waiver" | "selection">,
  string
> = {
  proposal: "proposal.accepted_contract_created",
  change_order: "change_order.approved",
  lien_waiver: "lien_waiver.signed",
  selection: "selection.confirmed",
}

export function buildUnifiedSigningUrl(token: string) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ""
  const route = UNIFIED_ESIGN_SIGNING_ROUTE_TEMPLATE.replace("[token]", token)
  return appUrl ? `${appUrl}${route}` : route
}

export function normalizeDraftEnvelopeRecipients(
  recipients: DraftEnvelopeRecipientInput[],
): NormalizedEnvelopeRecipient[] {
  const parsed = z.array(draftEnvelopeRecipientSchema).parse(recipients ?? [])
  return parsed.map((recipient, index) => {
    const fallbackSignerRole = `signer_${index + 1}`
    const email = recipient.email?.trim() || undefined
    return {
      type: recipient.type,
      name: recipient.name?.trim() ?? "",
      email,
      contact_id: recipient.contact_id,
      user_id: recipient.user_id,
      role: recipient.role,
      signer_role: recipient.role === "signer" ? recipient.signer_role?.trim() || fallbackSignerRole : undefined,
      sequence: recipient.sequence,
      required: recipient.required ?? recipient.role === "signer",
    }
  })
}

export function normalizeSendEnvelopeRecipients(
  recipients: SendEnvelopeRecipientInput[],
): NormalizedEnvelopeRecipient[] {
  const parsed = z.array(sendEnvelopeRecipientSchema).parse(recipients ?? [])
  return parsed.map((recipient, index) => {
    const email = recipient.email?.trim() || undefined
    return {
      type: recipient.type,
      name: recipient.name?.trim() ?? "",
      email,
      contact_id: recipient.contact_id,
      user_id: recipient.user_id,
      role: recipient.role,
      signer_role: recipient.role === "signer" ? recipient.signer_role?.trim() || `signer_${index + 1}` : undefined,
      sequence: recipient.sequence,
      required: recipient.required ?? recipient.role === "signer",
    }
  })
}

export function resolveEnvelopeLifecycleStatus(input: {
  documentStatus: LegacyDocumentStatus
  requiredSignerCount: number
  requiredSignedCount: number
}): EnvelopeLifecycleStatus {
  if (input.documentStatus === "draft") return "draft"
  if (input.documentStatus === "voided") return "voided"
  if (input.documentStatus === "expired") return "expired"
  if (input.documentStatus === "signed") return "executed"

  const hasSignedRecipients = input.requiredSignedCount > 0
  const hasUnsignedRecipients = input.requiredSignedCount < input.requiredSignerCount
  if (hasSignedRecipients && hasUnsignedRecipients) {
    return "partially_signed"
  }

  if (input.requiredSignerCount > 0 && !hasUnsignedRecipients) {
    return "executed"
  }

  return "sent"
}
