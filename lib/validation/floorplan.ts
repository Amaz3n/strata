import { z } from "zod"

import { OPENING_KINDS } from "@/lib/drawings/floorplan-model"

/**
 * Validation for floorplan models and the corrections applied to them.
 *
 * The model document round-trips through `jsonb`, so it is re-validated on the
 * way back OUT as well as in: a row written by an older algorithm revision, or
 * hand-edited in the database, must not reach the 3D viewer as a half-shape
 * that throws inside a render loop.
 */

const finite = z.number().finite()
const point = z.tuple([finite, finite])

export const floorplanSourceSchema = z.object({
  sheetVersionId: z.string(),
  sheetNumber: z.string().nullable(),
  sheetTitle: z.string().nullable(),
  imageWidth: finite.positive(),
  imageHeight: finite.positive(),
  feetPerImagePx: finite.positive(),
  originPxX: finite,
  originPxY: finite,
})

export const wallSchema = z.object({
  id: z.string().min(1),
  x0: finite,
  y0: finite,
  x1: finite,
  y1: finite,
  thicknessFt: finite.positive().max(4),
  confidence: finite.min(0).max(1),
  source: z.enum(["paired", "single", "manual"]),
})

export const openingSchema = z.object({
  id: z.string().min(1),
  wallId: z.string().min(1),
  kind: z.enum(OPENING_KINDS as unknown as [string, ...string[]]),
  offsetFt: finite.min(0),
  widthFt: finite.positive().max(40),
  sillFt: finite.min(0).max(30),
  headFt: finite.min(0).max(30),
  confidence: finite.min(0).max(1),
})

export const roomSchema = z.object({
  id: z.string().min(1),
  polygon: z.array(point).min(3),
  label: z.string().nullable(),
  areaSqft: finite.min(0),
  confidence: finite.min(0).max(1),
})

export const levelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  order: z.number().int(),
  ceilingHeightFt: finite.min(6).max(20),
  source: floorplanSourceSchema,
  walls: z.array(wallSchema),
  openings: z.array(openingSchema),
  rooms: z.array(roomSchema),
  confidence: z.object({
    walls: finite.min(0).max(1),
    openings: finite.min(0).max(1),
    rooms: finite.min(0).max(1),
  }),
})

export const floorplanModelSchema = z.object({
  version: z.literal(1),
  units: z.literal("feet"),
  levels: z.array(levelSchema),
  correctionCount: z.number().int().min(0),
  // Optional: models written before partial-result reporting existed have none.
  warnings: z.array(z.string().max(300)).max(20).optional(),
})

/**
 * Which house a model belongs to. Mirrors `FloorplanTarget`.
 *
 * A discriminated union rather than two optional ids, so "both set" and
 * "neither set" are unrepresentable at the edge as well as in the database.
 */
export const floorplanTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plan"), housePlanVersionId: z.string().uuid() }),
  z.object({ kind: z.literal("project"), projectId: z.string().uuid() }),
])

/** One correction from the review UI. Mirrors `FloorplanEdit`. */
export const floorplanEditSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("wall.add"),
    levelId: z.string().min(1),
    x0: finite,
    y0: finite,
    x1: finite,
    y1: finite,
    thicknessFt: finite.positive().max(4).optional(),
  }),
  z.object({ type: z.literal("wall.delete"), levelId: z.string().min(1), wallId: z.string().min(1) }),
  z.object({
    type: z.literal("opening.set"),
    levelId: z.string().min(1),
    openingId: z.string().min(1),
    kind: z.enum(OPENING_KINDS as unknown as [string, ...string[]]),
  }),
  z.object({ type: z.literal("opening.delete"), levelId: z.string().min(1), openingId: z.string().min(1) }),
  z.object({
    type: z.literal("room.label"),
    levelId: z.string().min(1),
    roomId: z.string().min(1),
    label: z.string().max(40).nullable(),
  }),
  z.object({ type: z.literal("level.height"), levelId: z.string().min(1), ceilingHeightFt: finite.min(6).max(20) }),
  z.object({ type: z.literal("level.name"), levelId: z.string().min(1), name: z.string().min(1).max(60) }),
])

export const floorplanEditsSchema = z.array(floorplanEditSchema).min(1).max(50)

export type FloorplanEditInput = z.infer<typeof floorplanEditSchema>
