import { z } from "zod"

import { COST_TYPES } from "@/lib/cost-types"

const nullableMetric = z.number().min(0).optional().nullable()

export const housePlanInputSchema = z.object({
  code: z.string().trim().min(1).max(32).transform((value) => value.toUpperCase()),
  name: z.string().trim().min(1).max(160),
  series: z.string().trim().max(120).optional().nullable(),
  divisionId: z.string().uuid().optional().nullable(),
  status: z.enum(["draft", "active", "retired"]).default("draft"),
  heatedSqft: z.number().int().positive().optional().nullable(),
  totalSqft: z.number().int().positive().optional().nullable(),
  beds: nullableMetric,
  baths: nullableMetric,
  stories: z.number().positive().optional().nullable(),
  garageBays: nullableMetric,
  description: z.string().trim().max(5000).optional().nullable(),
  coverFileId: z.string().uuid().optional().nullable(),
  metadata: z.record(z.unknown()).optional(),
})

export const housePlanUpdateSchema = housePlanInputSchema.partial()

export const elevationInputSchema = z.object({
  id: z.string().uuid().optional(),
  code: z.string().trim().regex(/^[A-Z][A-Z0-9]?$/, "Use A-Z followed by an optional letter or number"),
  name: z.string().trim().max(160).optional().nullable(),
  swingApplicable: z.boolean().default(true),
  heatedSqftDelta: z.number().int().default(0),
  isActive: z.boolean().default(true),
  coverFileId: z.string().uuid().optional().nullable(),
  sortOrder: z.number().int().min(0).default(0),
  metadata: z.record(z.unknown()).optional(),
})

export const takeoffLineInputSchema = z.object({
  elevationId: z.string().uuid().optional().nullable(),
  costCodeId: z.string().uuid(),
  costType: z.enum(COST_TYPES).optional().nullable(),
  description: z.string().trim().min(1).max(500),
  quantity: z.number().min(0),
  uom: z.string().trim().min(1).max(24),
  unitCostCents: z.number().int().min(0).optional().nullable(),
  metadata: z.record(z.unknown()).optional(),
})

export const planVersionInputSchema = z.object({
  label: z.string().trim().max(160).optional().nullable(),
  notes: z.string().trim().max(5000).optional().nullable(),
  budgetTemplateId: z.string().uuid().optional().nullable(),
  scheduleTemplateId: z.string().uuid().optional().nullable(),
  drawingSourceFileId: z.string().uuid().optional().nullable(),
  checklistTemplateIds: z.array(z.string().uuid()).max(100).default([]),
  selectionCategoryIds: z.array(z.string().uuid()).max(100).default([]),
  metadata: z.record(z.unknown()).optional(),
})

export const availabilityInputSchema = z.object({
  communityId: z.string().uuid(),
  housePlanId: z.string().uuid(),
  elevationId: z.string().uuid().optional().nullable(),
  isAvailable: z.boolean().default(true),
  basePriceCents: z.number().int().min(0),
  effectiveStart: z.string().date().optional().nullable(),
  effectiveEnd: z.string().date().optional().nullable(),
  metadata: z.record(z.unknown()).optional(),
}).refine(
  (value) => !value.effectiveStart || !value.effectiveEnd || value.effectiveEnd >= value.effectiveStart,
  { message: "Effective end must be on or after effective start", path: ["effectiveEnd"] },
)

export type HousePlanInput = z.infer<typeof housePlanInputSchema>
export type ElevationInput = z.infer<typeof elevationInputSchema>
export type TakeoffLineInput = z.infer<typeof takeoffLineInputSchema>
export type PlanVersionInput = z.infer<typeof planVersionInputSchema>
export type AvailabilityInput = z.infer<typeof availabilityInputSchema>
