import { z } from "zod"

import { MIN_FIT_OVERRIDE_REASON_LENGTH } from "@/lib/land/lot-fit"
import { LOT_STATUSES, MIN_DELIVERY_EXCEPTION_REASON_LENGTH } from "@/lib/land/lot-lifecycle"

export const lotStatusValueSchema = z.enum(LOT_STATUSES)
export const lotSwingSchema = z.enum(["left", "right", "either"])

export const lotDeliveryExceptionSchema = z.object({
  reason: z.string().trim().min(MIN_DELIVERY_EXCEPTION_REASON_LENGTH, "Say why a house may start on an undelivered lot.").max(1000),
})

const setbackFeet = z.number().min(0).max(1000)

/** Setbacks in feet, the same shape for a community's defaults and a lot's own. */
export const setbacksSchema = z.object({
  frontSetbackFt: setbackFeet.optional(),
  rearSetbackFt: setbackFeet.optional(),
  sideSetbackFt: setbackFeet.optional(),
  cornerSideSetbackFt: setbackFeet.optional(),
})

/** Form shape. `lots.dimensions` is stored snake_case; `lib/land/lot-dimensions.ts` owns the translation. */
const lotDimensionsSchema = setbacksSchema.extend({
  widthFt: z.number().positive().optional(),
  depthFt: z.number().positive().optional(),
  acreage: z.number().positive().optional(),
  irregular: z.boolean().optional(),
  corner: z.boolean().optional(),
})

export const lotCreateSchema = z.object({
  lotNumber: z.string().trim().min(1, "Lot number is required").max(40),
  block: z.string().trim().max(40).optional().nullable(),
  phaseId: z.string().uuid().optional().nullable(),
  status: lotStatusValueSchema.default("controlled"),
  address: z.string().trim().max(500).optional().nullable(),
  dimensions: lotDimensionsSchema.default({}),
  swing: lotSwingSchema.default("either"),
  premiumCents: z.number().int().min(0).default(0),
  costBasisCents: z.number().int().min(0).optional().nullable(),
  takedownId: z.string().uuid().optional().nullable(),
  acquiredDate: z.string().date().optional().nullable(),
  notes: z.string().trim().max(5000).optional().nullable(),
})

export const lotUpdateSchema = lotCreateSchema.partial()

export const createLotsInputSchema = z.object({
  lots: z.array(lotCreateSchema).min(1).max(500),
})

export const bulkLotPatchSchema = z.object({
  lotIds: z.array(z.string().uuid()).min(1).max(500),
  patch: z.object({
    status: lotStatusValueSchema.optional(),
    phaseId: z.string().uuid().optional().nullable(),
    takedownId: z.string().uuid().optional().nullable(),
    premiumCents: z.number().int().min(0).optional(),
    swing: lotSwingSchema.optional(),
  }).refine((value) => Object.keys(value).length > 0, "At least one field is required"),
})

export const lotRangeSchema = z.object({
  fromNumber: z.number().int().min(0),
  toNumber: z.number().int().min(0),
  block: z.string().trim().max(40).optional().nullable(),
  phaseId: z.string().uuid().optional().nullable(),
  takedownId: z.string().uuid().optional().nullable(),
  status: lotStatusValueSchema.default("controlled"),
  street: z.string().trim().max(200).optional().nullable(),
  addressFrom: z.number().int().min(0).optional().nullable(),
  addressStep: z.number().int().min(1).max(100).default(1),
  widthFt: z.number().positive().optional().nullable(),
  depthFt: z.number().positive().optional().nullable(),
  costBasisCents: z.number().int().min(0).optional().nullable(),
}).refine((value) => value.toNumber >= value.fromNumber, {
  message: "The ending lot number must be greater than or equal to the starting number.",
  path: ["toNumber"],
}).refine((value) => value.toNumber - value.fromNumber + 1 <= 500, {
  message: "A lot range may contain at most 500 lots.",
  path: ["toNumber"],
})

export const lotStatusSchema = z.object({
  status: lotStatusValueSchema,
  force: z.boolean().default(false),
})

/** The handing chosen for the pinned home; the lot's own swing (what it takes) is a land edit. */
export const lotPlanAssignmentSchema = z.object({
  versionId: z.string().uuid(),
  elevationId: z.string().uuid(),
  swing: z.enum(["left", "right"]).optional(),
})

export const lotFitOverrideSchema = z.object({
  lotId: z.string().uuid(),
  housePlanId: z.string().uuid(),
  elevationId: z.string().uuid().nullable(),
  swing: z.enum(["left", "right"]).nullable(),
  reason: z.string().trim().min(MIN_FIT_OVERRIDE_REASON_LENGTH, "Say why this home may stand on a lot it does not fit.").max(1000),
  evidenceFileId: z.string().uuid({ message: "Attach the evidence — a plot plan, a variance or an architectural approval." }),
})

export const lotAllowedElevationsSchema = z.object({
  elevationIds: z.array(z.string().uuid()).max(500),
})

export type LotPlanAssignmentInput = z.infer<typeof lotPlanAssignmentSchema>
export type LotCreateInput = z.infer<typeof lotCreateSchema>
export type LotUpdateInput = z.infer<typeof lotUpdateSchema>
export type LotFitOverrideInput = z.infer<typeof lotFitOverrideSchema>
export type SetbacksInput = z.infer<typeof setbacksSchema>
