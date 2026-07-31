import { z } from "zod"

import { CONDITION_COLORS } from "@/lib/drawings/takeoff-palette"
import { measureUomSchema } from "@/lib/validation/drawings"

// ============================================================================
// CONDITIONS
// ============================================================================

const colorSchema = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/)
  .refine((value) => CONDITION_COLORS.includes(value.toUpperCase()), {
    message: "Color must come from the takeoff palette",
  })

/**
 * A condition belongs to exactly one home: a project (residential/commercial)
 * or a house plan version (production). The DB enforces it too; validating here
 * means the caller gets a sentence instead of a constraint name.
 */
export const takeoffConditionScopeSchema = z
  .object({
    project_id: z.string().uuid().optional().nullable(),
    house_plan_version_id: z.string().uuid().optional().nullable(),
  })
  .refine(
    (value) => Boolean(value.project_id) !== Boolean(value.house_plan_version_id),
    { message: "A condition belongs to either a project or a house plan version, not both" },
  )

export type TakeoffConditionScope = z.infer<typeof takeoffConditionScopeSchema>

export const createTakeoffConditionSchema = z
  .object({
    project_id: z.string().uuid().optional().nullable(),
    house_plan_version_id: z.string().uuid().optional().nullable(),
    name: z.string().trim().min(1).max(120),
    uom: measureUomSchema,
    cost_code_id: z.string().uuid().optional().nullable(),
    color: colorSchema.optional(),
    waste_pct: z.number().min(0).max(100).optional(),
    unit_cost_cents: z.number().int().min(0).optional().nullable(),
    share_with_clients: z.boolean().optional(),
    notes: z.string().max(2000).optional().nullable(),
  })
  .refine(
    (value) => Boolean(value.project_id) !== Boolean(value.house_plan_version_id),
    { message: "A condition belongs to either a project or a house plan version, not both" },
  )

export type CreateTakeoffConditionInput = z.infer<typeof createTakeoffConditionSchema>

export const updateTakeoffConditionSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  cost_code_id: z.string().uuid().optional().nullable(),
  color: colorSchema.optional(),
  waste_pct: z.number().min(0).max(100).optional(),
  unit_cost_cents: z.number().int().min(0).optional().nullable(),
  share_with_clients: z.boolean().optional(),
  notes: z.string().max(2000).optional().nullable(),
  sort_order: z.number().int().min(0).optional(),
})

export type UpdateTakeoffConditionInput = z.infer<typeof updateTakeoffConditionSchema>

// `uom` is deliberately NOT updatable: changing it would orphan every member
// measurement. Users delete and re-create instead, which forces the reassign.

export const assignMarkupsToConditionSchema = z.object({
  condition_id: z.string().uuid().nullable(),
  markup_ids: z.array(z.string().uuid()).min(1).max(500),
})

export type AssignMarkupsToConditionInput = z.infer<typeof assignMarkupsToConditionSchema>

// ============================================================================
// SYNC TO A MONEY SURFACE
// ============================================================================

/**
 * Where a condition's quantity lands. Which of these are offered is decided by
 * project posture at the call site — the engine itself never branches on it.
 */
export const takeoffDestinationSchema = z.enum([
  "estimate",
  "bid_scope",
  "plan_takeoff",
])

export type TakeoffDestination = z.infer<typeof takeoffDestinationSchema>

/** What to do when a synced line's quantity was hand-edited after the sync. */
export const driftResolutionSchema = z.enum(["overwrite", "skip"])

export type DriftResolution = z.infer<typeof driftResolutionSchema>

export const syncConditionsSchema = z.object({
  destination: takeoffDestinationSchema,
  /** Estimate id, bid package id, or house plan version id, per destination. */
  target_id: z.string().uuid(),
  condition_ids: z.array(z.string().uuid()).min(1).max(200),
  /**
   * Per-condition instruction for lines whose quantity drifted from the last
   * sync. Absent = skip, because silently overwriting a hand-edit is the one
   * failure mode an estimator will never forgive.
   */
  drift_resolution: z.record(z.string().uuid(), driftResolutionSchema).optional(),
})

export type SyncConditionsInput = z.infer<typeof syncConditionsSchema>

export const conditionRollupFiltersSchema = z.object({
  project_id: z.string().uuid().optional(),
  house_plan_version_id: z.string().uuid().optional(),
  /** Restrict the per-sheet breakdown; the totals always cover the whole scope. */
  drawing_sheet_id: z.string().uuid().optional(),
})

export type ConditionRollupFilters = z.infer<typeof conditionRollupFiltersSchema>

// ============================================================================
// AI ASSIST — vision output
// ============================================================================

/** Model coordinates come back on this integer grid — easier than floats. */
export const ASSIST_COORD_GRID = 1000
/** Under three vertices is not a region. */
export const ASSIST_MIN_POLYGON_VERTICES = 3
/** Over forty is the model rambling; the prompt asks for this same ceiling. */
export const ASSIST_MAX_POLYGON_VERTICES = 40
/** Refuse to propose more than this many symbol matches in one pass. */
export const ASSIST_MAX_SYMBOL_MATCHES = 200

/**
 * One [x, y] pair on the assist grid. Extra trailing values are tolerated (some
 * models append a confidence), but every value must be a finite on-grid number —
 * a NaN or an off-grid coordinate means the answer is not trustworthy.
 */
const assistGridPointSchema = z
  .array(z.number().finite().min(0).max(ASSIST_COORD_GRID))
  .min(2)
  .transform((entry) => [entry[0], entry[1]] as [number, number])

/** Shape of the traced-region answer. An empty polygon is a valid "no region". */
export const assistTracePolygonSchema = z.object({
  polygon: z
    .array(assistGridPointSchema)
    .max(ASSIST_MAX_POLYGON_VERTICES),
})

/** Shape of the symbol-count answer. An empty list is a valid "not confident". */
export const assistSymbolPointsSchema = z.object({
  points: z.array(assistGridPointSchema),
})

/** Click coordinates arriving from the viewer, in sheet-normalized space. */
export const assistSheetPointSchema = z.object({
  sheet_version_id: z.string().uuid(),
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
})
