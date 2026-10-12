import { z } from "zod"
import { MAX_RESERVATION_DEPOSIT_CENTS } from "@/lib/sales/reservation-deposit"

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

export const sellableHomesQuerySchema = z.object({
  search: z.string().trim().max(60).default(""),
  availability: z.enum(["all", "spec", "tbb"]).default("all"),
  minBeds: z.number().int().min(1).max(10).optional(),
  minPriceCents: z.number().int().min(0).max(100_000_000_00).optional(),
  maxPriceCents: z.number().int().min(0).max(100_000_000_00).optional(),
  sort: z.enum(["lot", "price_asc", "price_desc", "aging"]).default("price_asc"),
  offset: z.number().int().min(0).max(100_000).default(0),
})

export const convertReservationSchema = z.object({
  reservationId: z.string().uuid(),
  depositCents: z.number().int().safe().min(0).max(MAX_RESERVATION_DEPOSIT_CENTS, "The deposit exceeds the supported invoice amount"),
  projectName: z.string().min(1).max(200).optional(),
})

/** Source evidence for conversion; partial embedded rows are never sellable holds. */
export const reservationConversionSourceSchema = z.object({
  id: z.string().uuid(), org_id: z.string().uuid(), community_id: z.string().uuid(), lot_id: z.string().uuid(),
  buyer_contact_id: z.string().uuid(), co_buyer_contact_id: z.string().uuid().nullable(), prospect_id: z.string().uuid().nullable(),
  status: z.literal("hold"), expires_at: z.string().datetime({ offset: true }).nullable(), updated_at: z.string().datetime({ offset: true }),
  deposit_invoice_id: z.string().uuid().nullable(), contract_id: z.string().uuid().nullable(),
  lot: z.object({ id: z.string().uuid(), org_id: z.string().uuid(), community_id: z.string().uuid(), division_id: z.string().uuid().nullable(),
    lot_number: z.string(), status: z.enum(["owned", "developed", "assigned", "started"]), project_id: z.string().uuid().nullable(), updated_at: z.string().datetime({ offset: true }),
  }),
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
  expectedQuoteHash: z.string().regex(/^[a-f0-9]{64}$/, "Review a current quote before creating the agreement"),
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
    /** The price each row showed the caller, by availability id. Targets are computed from it, so a replay lands on the same price. */
    basisCents: z.record(z.string().uuid(), z.number().int().min(0).max(100_000_000_00)),
  })
  .refine((input) => input.availabilityIds.every((id) => input.basisCents[id] !== undefined), {
    message: "Every plan needs the price it was repriced from.",
    path: ["basisCents"],
  })
  .refine((input) => (input.mode === "percent" ? Math.abs(input.value) <= 50 : Math.abs(input.value) <= 100_000_00), {
    message: "That is larger than a repricing. Set the prices individually if it is really intended.",
    path: ["value"],
  })

export type IncentiveInput = z.infer<typeof incentiveSchema>
export type AgreementConfigurationInput = z.infer<typeof agreementConfigurationSchema>
