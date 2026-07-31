import { z } from "zod"

export const createLotHoldSchema = z.object({
  lotId: z.string().uuid(),
  buyerContactId: z.string().uuid(),
  coBuyerContactId: z.string().uuid().optional().nullable(),
  prospectId: z.string().uuid().optional().nullable(),
  expiresAt: z.string().datetime({ offset: true }),
  notes: z.string().max(2000).optional().nullable(),
})

export const createProspectLotHoldSchema = z.object({
  prospectId: z.string().uuid(),
  lotId: z.string().uuid(),
  expiresAt: z.string().datetime({ offset: true }),
  notes: z.string().max(2000).optional().nullable(),
})
export type CreateProspectLotHoldInput = z.infer<typeof createProspectLotHoldSchema>

export const convertReservationSchema = z.object({
  reservationId: z.string().uuid(),
  depositCents: z.number().int().min(0),
  projectName: z.string().min(1).max(200).optional(),
})

export const releaseReservationSchema = z.object({
  reservationId: z.string().uuid(),
  reason: z.string().min(3).max(1000),
  depositDisposition: z.enum(["refund", "forfeit"]).optional(),
})

export const incentiveSchema = z.object({
  id: z.string().uuid().optional(),
  communityId: z.string().uuid().optional().nullable(),
  name: z.string().min(1).max(200),
  incentiveType: z.enum(["fixed_amount", "percent_of_base"]),
  amountCents: z.number().int().min(0).optional().nullable(),
  percent: z.number().min(0).max(100).optional().nullable(),
  appliesTo: z.enum(["price", "design_credit"]),
  status: z.enum(["draft", "active", "ended"]).default("active"),
  effectiveStart: z.string().date().optional().nullable(),
  effectiveEnd: z.string().date().optional().nullable(),
  maxUses: z.number().int().positive().optional().nullable(),
  requiresApproval: z.boolean().default(false),
  notes: z.string().max(2000).optional().nullable(),
}).superRefine((input, context) => {
  if (input.incentiveType === "fixed_amount" && input.amountCents == null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["amountCents"], message: "Amount is required" })
  }
  if (input.incentiveType === "percent_of_base" && input.percent == null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["percent"], message: "Percent is required" })
  }
})

export const agreementConfigurationSchema = z.object({
  lotId: z.string().uuid(),
  housePlanVersionId: z.string().uuid().optional(),
  elevationId: z.string().uuid().optional().nullable(),
  swing: z.enum(["left", "right"]).optional(),
  optionItems: z.array(z.object({
    optionId: z.string().uuid().optional(),
    packageId: z.string().uuid().optional(),
  }).refine((item) => Boolean(item.optionId) !== Boolean(item.packageId), "Choose one catalog item type")).max(200),
  incentiveIds: z.array(z.string().uuid()).max(50).default([]),
})

export const createPurchaseAgreementSchema = agreementConfigurationSchema.extend({
  reservationId: z.string().uuid(),
  terms: z.string().max(20_000).optional().nullable(),
  effectiveDate: z.string().date().optional(),
})

export const voidPurchaseAgreementSchema = z.object({
  contractId: z.string().uuid(),
  reason: z.string().min(3).max(1000),
  depositDisposition: z.enum(["refund", "forfeit"]),
})

export const communityPlanPriceSchema = z.object({
  availabilityId: z.string().uuid(),
  communityId: z.string().uuid(),
  basePriceCents: z.number().int().min(0).max(100_000_000_00),
})

/** A percentage move or a flat move, in cents, applied across a price sheet. */
export const communityBulkRepriceSchema = z
  .object({
    communityId: z.string().uuid(),
    availabilityIds: z.array(z.string().uuid()).min(1).max(200),
    mode: z.enum(["percent", "amount"]),
    value: z.number(),
  })
  .refine((input) => (input.mode === "percent" ? Math.abs(input.value) <= 50 : Math.abs(input.value) <= 100_000_00), {
    message: "That is larger than a repricing. Set the prices individually if it is really intended.",
    path: ["value"],
  })

export type IncentiveInput = z.infer<typeof incentiveSchema>
export type AgreementConfigurationInput = z.infer<typeof agreementConfigurationSchema>
