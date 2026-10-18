import { z } from "zod"

import { DILIGENCE_CATEGORIES } from "@/lib/land/diligence"

const isoDate = z.string().date().optional().nullable()
const optionalId = z.string().uuid().optional().nullable()
const cents = z.number().int().min(0).max(100_000_000_000)

export const landOpportunityInputSchema = z.object({
  name: z.string().trim().min(1, "Deal name is required").max(200),
  code: z.string().trim().max(24).optional().nullable(),
  divisionId: optionalId,
  sellerCompanyId: optionalId,
  address: z.string().trim().max(500).optional().nullable(),
  city: z.string().trim().max(120).optional().nullable(),
  state: z.string().trim().max(80).optional().nullable(),
  county: z.string().trim().max(120).optional().nullable(),
  acreage: z.number().min(0).max(1_000_000).optional().nullable(),
  plannedLotCount: z.number().int().min(0).max(100_000).optional().nullable(),
  purchasePriceCents: cents.optional().nullable(),
  depositCents: cents.default(0),
  contractExecutedOn: isoDate,
  diligenceEndsOn: isoDate,
  closingTargetOn: isoDate,
  leadUserId: optionalId,
  notes: z.string().trim().max(4000).optional().nullable(),
})
export type LandOpportunityInput = z.input<typeof landOpportunityInputSchema>

export const landOpportunityUpdateSchema = landOpportunityInputSchema.partial()
export type LandOpportunityUpdate = z.input<typeof landOpportunityUpdateSchema>

export const landOpportunityDropSchema = z.object({
  reason: z.string().trim().min(10, "Say why the deal is dropped (at least 10 characters)").max(2000),
})

export const landDealStageFilterSchema = z.enum(["screening", "diligence", "in_review", "approved", "acquired", "dropped"])

export const landOpportunityListSchema = z.object({
  divisionId: z.string().uuid().optional(),
  stage: landDealStageFilterSchema.optional(),
  search: z.string().trim().max(120).optional(),
  page: z.number().int().min(1).max(10_000).default(1),
  pageSize: z.number().int().min(1).max(100).default(50),
})
export type LandOpportunityListInput = z.input<typeof landOpportunityListSchema>

export const diligenceItemInputSchema = z.object({
  title: z.string().trim().min(1, "Item title is required").max(200),
  category: z.enum(DILIGENCE_CATEGORIES).default("other"),
  ownerUserId: optionalId,
  ownerCompanyId: optionalId,
  dueOn: isoDate,
})
export type DiligenceItemInput = z.input<typeof diligenceItemInputSchema>

export const diligenceItemUpdateSchema = diligenceItemInputSchema.partial()

/** A resolution says what was found; a waiver says why the risk is accepted. */
export const diligenceResolutionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("satisfied"), finding: z.string().trim().max(4000).optional().nullable() }),
  z.object({ status: z.literal("issue"), finding: z.string().trim().min(1, "Describe the issue found").max(4000) }),
  z.object({
    status: z.literal("waived"),
    waivedReason: z.string().trim().min(10, "Say why the item is waived (at least 10 characters)").max(2000),
    finding: z.string().trim().max(4000).optional().nullable(),
  }),
])
export type DiligenceResolution = z.input<typeof diligenceResolutionSchema>

export const acquisitionReviewSubmitSchema = z.object({
  decision: z.enum(["acquire", "terminate"]),
  summary: z.string().trim().max(4000).optional().nullable(),
  approvers: z
    .array(z.object({ userId: z.string().uuid(), label: z.string().trim().max(80).optional().nullable() }))
    .min(1, "Name at least one approver")
    .max(5, "Name at most five approvers")
    .refine((approvers) => new Set(approvers.map((approver) => approver.userId)).size === approvers.length, {
      message: "Each approver can be named once",
    }),
})
export type AcquisitionReviewSubmit = z.input<typeof acquisitionReviewSubmitSchema>

export const acquisitionDecisionSchema = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    reason: z.string().trim().max(2000).optional().nullable(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/, "The reviewed version is not recognised"),
  })
  .superRefine((value, context) => {
    if (value.decision === "rejected" && (value.reason ?? "").length < 10) {
      context.addIssue({ code: "custom", path: ["reason"], message: "Say why the version is returned (at least 10 characters)" })
    }
  })
export type AcquisitionDecisionInput = z.input<typeof acquisitionDecisionSchema>

export const landCommunityLinkSchema = z.object({ communityId: z.string().uuid() })
