import { z } from "zod"

import { LOT_STATUSES } from "@/lib/land/lot-lifecycle"

export const lotStatusValueSchema = z.enum(LOT_STATUSES)
export const lotSwingSchema = z.enum(["left", "right", "either"])

const lotDimensionsSchema = z.object({
  widthFt: z.number().positive().optional(),
  depthFt: z.number().positive().optional(),
  acreage: z.number().positive().optional(),
  irregular: z.boolean().optional(),
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
  prefix: z.string().trim().max(20).optional(),
  phaseId: z.string().uuid().optional().nullable(),
  takedownId: z.string().uuid().optional().nullable(),
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

export const lotListFiltersSchema = z.object({
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().min(1).max(100).default(100),
  status: lotStatusValueSchema.optional(),
  phaseId: z.string().uuid().optional(),
  search: z.string().trim().max(100).optional(),
})

export type LotCreateInput = z.infer<typeof lotCreateSchema>
export type LotUpdateInput = z.infer<typeof lotUpdateSchema>
export type LotListFilters = z.infer<typeof lotListFiltersSchema>
