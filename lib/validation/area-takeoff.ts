import { z } from "zod"
import { areasOverlap, validateAreaGeometry, validRing } from "@/lib/drawings/area-takeoff"

export const areaPointSchema = z.tuple([z.number().finite().min(0).max(1), z.number().finite().min(0).max(1)])
export const areaRingSchema = z.array(areaPointSchema).min(3).max(500).refine(validRing, "Area boundary must be a simple, non-intersecting polygon")
export const areaRegionSchema = z.object({ x0: z.number().min(0).max(1), y0: z.number().min(0).max(1), x1: z.number().min(0).max(1), y1: z.number().min(0).max(1) })
  .refine((r) => r.x1 > r.x0 && r.y1 > r.y0, "Choose a region with positive width and height")
export const areaBoundarySchema = z.object({ a: areaPointSchema, b: areaPointSchema, source: z.enum(["drawn", "doorway", "window", "user"]), pathId: z.number().int().optional(), observationId: z.string().max(200).optional() })
export const detectAreasSchema = z.object({
  sheet_version_id: z.string().uuid(),
  region: areaRegionSchema.optional(),
  boundaries: z.array(areaBoundarySchema).max(100).default([]),
  vision: z.boolean().default(false),
  interpretation: z.enum(["hybrid", "vector"]).default("hybrid"),
  finish_policy: z.enum(["drawn", "include-fixtures"]).default("drawn"),
})
export const acceptedAreaSchema = z.object({
  id: z.string().min(1).max(2000), label: z.string().max(200), points: areaRingSchema,
  originalPoints: areaRingSchema, holes: z.array(areaRingSchema).max(20),
  finishScopeNote: z.string().trim().max(500).optional(),
  finishPolicy: z.enum(["drawn", "include-fixtures"]).optional(),
  boundary: z.array(areaBoundarySchema).max(500), source: z.enum(["vector", "vision", "user"]), edited: z.boolean(),
}).superRefine((area, ctx) => {
  try { validateAreaGeometry(area) } catch (error) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : "Invalid area" }) }
})
export const acceptAreasSchema = z.object({
  sheet_version_id: z.string().uuid(), condition_id: z.string().uuid(),
  expected_scale: z.number().finite().positive(),
  areas: z.array(acceptedAreaSchema).min(1).max(50),
  elapsed_ms: z.number().int().min(0).max(86_400_000),
  reviewed: z.literal(true),
}).superRefine((value, ctx) => {
  for (let i = 0; i < value.areas.length; i++) for (let j = 0; j < i; j++) {
    if (areasOverlap(value.areas[i], value.areas[j])) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Selected areas overlap. Split or deselect them before accepting." })
  }
})
export type DetectAreasInput = z.input<typeof detectAreasSchema>
export type AcceptAreasInput = z.infer<typeof acceptAreasSchema>
