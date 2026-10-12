import { z } from "zod"

export const LAND_CONTRACT_KINDS = ["purchase", "option"] as const
export const LAND_CONTRACT_STATUSES = ["draft", "executed", "terminated", "completed"] as const
export const LAND_DEPOSIT_REFUNDABILITY = ["refundable", "non_refundable", "refundable_until"] as const
export const LAND_DEPOSIT_STATUSES = ["scheduled", "paid", "applied", "refunded", "forfeited"] as const
export const LAND_AMENDMENT_KINDS = ["extension", "penalty", "other"] as const

/** Client-safe labels (the service module is server-only). */
export const LAND_CONTRACT_STATUS_LABELS: Record<(typeof LAND_CONTRACT_STATUSES)[number], string> = {
  draft: "Draft",
  executed: "Executed",
  terminated: "Terminated",
  completed: "Completed",
}
export const LAND_DEPOSIT_STATUS_LABELS: Record<(typeof LAND_DEPOSIT_STATUSES)[number], string> = {
  scheduled: "Scheduled",
  paid: "Paid",
  applied: "Applied at close",
  refunded: "Refunded",
  forfeited: "Forfeited",
}
export const LAND_DEPOSIT_REFUNDABILITY_LABELS: Record<(typeof LAND_DEPOSIT_REFUNDABILITY)[number], string> = {
  refundable: "Refundable",
  non_refundable: "Non-refundable",
  refundable_until: "Refundable until",
}
export const LAND_AMENDMENT_KIND_LABELS: Record<(typeof LAND_AMENDMENT_KINDS)[number], string> = {
  extension: "Extension",
  penalty: "Penalty",
  other: "Amendment",
}

/** The same floor the database holds for an amendment's reason. */
export const MIN_LAND_AMENDMENT_REASON_LENGTH = 10

const isoDate = z.string().date()
const cents = z.number().int().min(0)
const optionalText = (max: number) => z.string().trim().max(max).optional().nullable()

export const landContractInputSchema = z.object({
  title: z.string().trim().min(1, "Contract title is required").max(160),
  contractNumber: optionalText(60),
  kind: z.enum(LAND_CONTRACT_KINDS).default("purchase"),
  sellerCompanyId: z.string().uuid().optional().nullable(),
  totalLots: z.number().int().min(0).default(0),
  basePricePerLotCents: cents.optional().nullable(),
  extensionTerms: optionalText(5000),
  penaltyTerms: optionalText(5000),
})
export type LandContractInput = z.input<typeof landContractInputSchema>

export const landContractUpdateSchema = landContractInputSchema.partial()

export const landContractExecutionSchema = z.object({
  executedOn: isoDate,
  executedFileId: z.string().uuid("Attach the signed contract"),
})

export const landContractCloseOutSchema = z.object({
  status: z.enum(["terminated", "completed"]),
})

export const landDepositInputSchema = z
  .object({
    label: optionalText(120),
    takedownId: z.string().uuid().optional().nullable(),
    dueOn: isoDate,
    amountCents: z.number().int().positive("A deposit is more than zero"),
    refundability: z.enum(LAND_DEPOSIT_REFUNDABILITY).default("refundable"),
    refundableUntil: isoDate.optional().nullable(),
  })
  .refine((value) => (value.refundability === "refundable_until") === Boolean(value.refundableUntil), {
    message: "Give the date refundability ends, and only for a deposit refundable until a date",
    path: ["refundableUntil"],
  })
export type LandDepositInput = z.input<typeof landDepositInputSchema>

export const landDepositPaymentSchema = z.object({
  paidOn: isoDate,
  paymentReference: optionalText(120),
  evidenceFileId: z.string().uuid("Attach the payment receipt"),
})

export const landDepositSettlementSchema = z.object({
  outcome: z.enum(["refunded", "forfeited"]),
})

export const landExtensionSchema = z
  .object({
    takedownId: z.string().uuid(),
    toDate: isoDate,
    feeCents: cents.default(0),
    feeDueOn: isoDate.optional().nullable(),
    reason: z.string().trim().min(MIN_LAND_AMENDMENT_REASON_LENGTH, "Say why the close date moved").max(2000),
    evidenceFileId: z.string().uuid("Attach the signed extension"),
  })
  .refine((value) => value.feeCents === 0 || Boolean(value.feeDueOn), {
    message: "Give the date the extension fee is due",
    path: ["feeDueOn"],
  })
export type LandExtensionInput = z.input<typeof landExtensionSchema>

export const landAmendmentSchema = z
  .object({
    kind: z.enum(["penalty", "other"]),
    takedownId: z.string().uuid().optional().nullable(),
    feeCents: cents.default(0),
    dueOn: isoDate.optional().nullable(),
    reason: z.string().trim().min(MIN_LAND_AMENDMENT_REASON_LENGTH, "Say what the amendment records").max(2000),
    evidenceFileId: z.string().uuid("Attach the signed amendment"),
  })
  .refine((value) => value.feeCents === 0 || Boolean(value.dueOn), {
    message: "Give the date the amount is due",
    path: ["dueOn"],
  })
export type LandAmendmentInput = z.input<typeof landAmendmentSchema>

export const phaseDevelopmentLinkSchema = z.object({
  developmentProjectId: z.string().uuid().nullable(),
})
