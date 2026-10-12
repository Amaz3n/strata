import { z } from "zod"

const stateCode = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "Use two-letter state codes")

export const agreementTemplateKindSchema = z.enum(["agreement", "addendum"])

export const createAgreementTemplateSchema = z.object({
  kind: agreementTemplateKindSchema,
  name: z.string().trim().min(1).max(120),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
})

export const updateAgreementTemplateSchema = z.object({
  templateId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  sortOrder: z.number().int().min(0).max(10_000),
})

/** Applicability and labelling of a draft version; the PDF itself arrives as the upload. */
export const agreementTemplateDraftSchema = z.object({
  title: z.string().trim().min(1).max(200),
  required: z.boolean().default(false),
  states: z.array(stateCode).max(60).default([]),
  communityIds: z.array(z.string().uuid()).max(500).default([]),
  changeNote: z.string().trim().max(2000).optional().nullable(),
})

export const createAgreementTemplateVersionSchema = agreementTemplateDraftSchema.extend({
  templateId: z.string().uuid(),
})

export const updateAgreementTemplateDraftSchema = agreementTemplateDraftSchema.extend({
  versionId: z.string().uuid(),
})

export const agreementTemplateVersionRefSchema = z.object({ versionId: z.string().uuid() })

export const withdrawAgreementTemplateVersionSchema = z.object({
  versionId: z.string().uuid(),
  reason: z.string().trim().min(3).max(1000),
})

export const agreementTemplateRefSchema = z.object({ templateId: z.string().uuid() })

export const listAgreementTemplatesSchema = z.object({
  kind: agreementTemplateKindSchema.optional(),
  includeRetired: z.boolean().default(false),
})
