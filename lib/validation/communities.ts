import { z } from "zod"

export const communityStatusSchema = z.enum(["planning", "active", "sold_out", "closed"])
export const communityPhaseStatusSchema = z.enum(["planned", "open", "built_out"])
export const takedownStatusSchema = z.enum(["scheduled", "closed", "cancelled"])

const nullableText = z.string().trim().max(500).optional().nullable()
const isoDate = z.string().date().optional().nullable()

export const communityInputSchema = z.object({
  name: z.string().trim().min(1, "Community name is required").max(160),
  divisionId: z.string().uuid().optional().nullable(),
  code: z.string().trim().max(12).transform((value) => value.toUpperCase()).optional().nullable(),
  status: communityStatusSchema.default("active"),
  address: nullableText,
  city: z.string().trim().max(120).optional().nullable(),
  state: z.string().trim().max(80).optional().nullable(),
  postalCode: z.string().trim().max(20).optional().nullable(),
  description: z.string().trim().max(5000).optional().nullable(),
  plannedLotCount: z.number().int().min(0).optional().nullable(),
  settings: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
})

export const communityUpdateSchema = communityInputSchema.partial()

export const phaseInputSchema = z.object({
  name: z.string().trim().min(1, "Phase name is required").max(160),
  phaseNumber: z.number().int().positive(),
  status: communityPhaseStatusSchema.default("planned"),
  targetOpenDate: isoDate,
  notes: z.string().trim().max(5000).optional().nullable(),
})

export const phaseUpdateSchema = phaseInputSchema.partial()

export const takedownInputSchema = z.object({
  name: z.string().trim().min(1, "Takedown name is required").max(160),
  communityPhaseId: z.string().uuid().optional().nullable(),
  scheduledDate: isoDate,
  actualDate: isoDate,
  lotCount: z.number().int().min(0).default(0),
  pricePerLotCents: z.number().int().min(0).optional().nullable(),
  depositCents: z.number().int().min(0).default(0),
  status: takedownStatusSchema.default("scheduled"),
  sellerCompanyId: z.string().uuid().optional().nullable(),
  notes: z.string().trim().max(5000).optional().nullable(),
})

export const takedownUpdateSchema = takedownInputSchema.partial()

export type CommunityInput = z.infer<typeof communityInputSchema>
export type PhaseInput = z.infer<typeof phaseInputSchema>
export type TakedownInput = z.infer<typeof takedownInputSchema>
