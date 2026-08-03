import { z } from "zod"

import { CONDITION_COLORS } from "@/lib/drawings/takeoff-palette"

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
 * What a condition reports. Wider than `measureUomSchema` (what a markup can
 * measure) because a condition may carry its measurement along the axis the
 * drawing does not show. Kept in lockstep with the DB check constraint and
 * `ConditionUom` in lib/drawings/measure.ts — those three are the enum.
 */
export const conditionUomSchema = z.enum(["lf", "sf", "ea", "cy", "sy", "sq", "ton"])

/**
 * The four factors, and the rules about which unit each belongs to.
 *
 * These mirror `takeoff_conditions_factor_units` in SQL exactly. Duplicated on
 * purpose: the constraint is what makes a bad row impossible, and this is what
 * makes the user read a sentence instead of a constraint name.
 */
const factorFields = {
  /** Slab/base thickness in inches. Required for cy and ton. */
  depth_in: z.number().positive().max(240).optional().nullable(),
  /** Wall height in feet. Set it and the condition sums LF runs instead of SF. */
  height_ft: z.number().positive().max(200).optional().nullable(),
  /** Roof rise per 12 of run. 8 means 8/12. */
  pitch_rise: z.number().positive().max(24).optional().nullable(),
  /** Bulk density, tons per cubic yard. */
  tons_per_cy: z.number().positive().max(10).optional().nullable(),
}

type FactorShape = {
  uom?: z.infer<typeof conditionUomSchema>
  depth_in?: number | null
  height_ft?: number | null
  pitch_rise?: number | null
  tons_per_cy?: number | null
}

/**
 * Applied to every shape that carries a uom and factors together. Returns the
 * complaint an estimator can act on, or null.
 */
export function factorRuleViolation(value: FactorShape): string | null {
  const { uom, depth_in, height_ft, pitch_rise, tons_per_cy } = value
  if (!uom) return null

  if (height_ft != null && uom !== "sf") {
    return "A wall height only applies to a condition reported in SF"
  }
  if (pitch_rise != null && uom !== "sf" && uom !== "sq") {
    return "A roof pitch only applies to a condition reported in SF or squares"
  }
  if (depth_in != null && uom !== "cy" && uom !== "ton") {
    return "A depth only applies to a condition reported in CY or tons"
  }
  if (tons_per_cy != null && uom !== "ton") {
    return "A density only applies to a condition reported in tons"
  }
  if ((uom === "cy" || uom === "ton") && depth_in == null) {
    return `A ${uom === "cy" ? "cubic-yard" : "tonnage"} condition needs a depth — the plan cannot supply one`
  }
  if (uom === "ton" && tons_per_cy == null) {
    return "A tonnage condition needs a density in tons per cubic yard"
  }
  if (height_ft != null && pitch_rise != null) {
    return "A condition carries a wall height or a roof pitch, not both"
  }
  return null
}

function withFactorRules<T extends z.ZodTypeAny>(schema: T) {
  return schema.superRefine((value: FactorShape, ctx: z.RefinementCtx) => {
    const violation = factorRuleViolation(value)
    if (violation) ctx.addIssue({ code: z.ZodIssueCode.custom, message: violation })
  })
}

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

export const createTakeoffConditionSchema = withFactorRules(
  z
    .object({
      project_id: z.string().uuid().optional().nullable(),
      house_plan_version_id: z.string().uuid().optional().nullable(),
      name: z.string().trim().min(1).max(120),
      uom: conditionUomSchema,
      ...factorFields,
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
    ),
)

export type CreateTakeoffConditionInput = z.infer<typeof createTakeoffConditionSchema>

export const updateTakeoffConditionSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  ...factorFields,
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
//
// The factors ARE updatable, including `height_ft`, even though setting or
// clearing it flips which unit members must measure in. The service refuses that
// particular edit while the condition still has members, for the same reason —
// it would orphan them. Every other factor only changes the arithmetic, and
// nothing is stored, so the rollup simply reports a different number.

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
// CONDITION TEMPLATES — the org's reusable library
// ============================================================================

/** Flat, one level. "Concrete", "Framing" — not a WBS. */
const groupNameSchema = z.string().trim().max(60).optional().nullable()

export const createConditionTemplateSchema = withFactorRules(
  z.object({
    name: z.string().trim().min(1).max(120),
    uom: conditionUomSchema,
    ...factorFields,
    cost_code_id: z.string().uuid().optional().nullable(),
    color: colorSchema.optional().nullable(),
    waste_pct: z.number().min(0).max(100).optional(),
    unit_cost_cents: z.number().int().min(0).optional().nullable(),
    share_with_clients: z.boolean().optional(),
    notes: z.string().max(2000).optional().nullable(),
    group_name: groupNameSchema,
  }),
)

export type CreateConditionTemplateInput = z.infer<typeof createConditionTemplateSchema>

export const updateConditionTemplateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  ...factorFields,
  cost_code_id: z.string().uuid().optional().nullable(),
  color: colorSchema.optional().nullable(),
  waste_pct: z.number().min(0).max(100).optional(),
  unit_cost_cents: z.number().int().min(0).optional().nullable(),
  share_with_clients: z.boolean().optional(),
  notes: z.string().max(2000).optional().nullable(),
  group_name: groupNameSchema,
  sort_order: z.number().int().min(0).optional(),
})

export type UpdateConditionTemplateInput = z.infer<typeof updateConditionTemplateSchema>

/** How many templates one org may hold, so the picker is never unbounded. */
export const TEMPLATE_LIST_CAP = 500

export const applyConditionTemplatesSchema = z
  .object({
    project_id: z.string().uuid().optional().nullable(),
    house_plan_version_id: z.string().uuid().optional().nullable(),
    template_ids: z.array(z.string().uuid()).min(1).max(200),
  })
  .refine(
    (value) => Boolean(value.project_id) !== Boolean(value.house_plan_version_id),
    { message: "Templates land on either a project or a house plan version, not both" },
  )

export type ApplyConditionTemplatesInput = z.infer<typeof applyConditionTemplatesSchema>

export const saveConditionsAsTemplatesSchema = z.object({
  condition_ids: z.array(z.string().uuid()).min(1).max(200),
  group_name: groupNameSchema,
})

export type SaveConditionsAsTemplatesInput = z.infer<typeof saveConditionsAsTemplatesSchema>

// ============================================================================
// SHEET COVERAGE
// ============================================================================

/**
 * What a human declared about a sheet. Whether a sheet HAS measurements is
 * derived from the markups and never stored here — this is only the part the
 * drawings cannot tell you.
 */
export const takeoffSheetStatusSchema = z.enum(["complete", "not_applicable"])

export type TakeoffSheetStatusValue = z.infer<typeof takeoffSheetStatusSchema>

export const setTakeoffSheetStatusSchema = z
  .object({
    project_id: z.string().uuid().optional().nullable(),
    house_plan_version_id: z.string().uuid().optional().nullable(),
    drawing_sheet_id: z.string().uuid(),
    /** Null clears the declaration and returns the sheet to "not started". */
    status: takeoffSheetStatusSchema.nullable(),
    note: z.string().max(500).optional().nullable(),
  })
  .refine(
    (value) => Boolean(value.project_id) !== Boolean(value.house_plan_version_id),
    { message: "A sheet status belongs to either a project or a house plan version, not both" },
  )

export type SetTakeoffSheetStatusInput = z.infer<typeof setTakeoffSheetStatusSchema>

// ============================================================================
// COUNT BY EXAMPLE — symbol matching
// ============================================================================

/** Model coordinates come back on this integer grid — easier than floats. */
export const ASSIST_COORD_GRID = 1000
/** Refuse to propose more than this many symbol matches in one pass. */
export const ASSIST_MAX_SYMBOL_MATCHES = 400

/**
 * One [x, y] pair on the assist grid. Extra trailing values are tolerated (some
 * models append a confidence), but every value must be a finite on-grid number —
 * a NaN or an off-grid coordinate means the answer is not trustworthy.
 */
const assistGridPointSchema = z
  .array(z.number().finite().min(0).max(ASSIST_COORD_GRID))
  .min(2)
  .transform((entry) => [entry[0], entry[1]] as [number, number])

/** Shape of the vision symbol-count answer. An empty list is a valid "not confident". */
export const assistSymbolPointsSchema = z.object({
  points: z.array(assistGridPointSchema),
})

/** Click coordinates arriving from the viewer, in sheet-normalized space. */
export const assistSheetPointSchema = z.object({
  sheet_version_id: z.string().uuid(),
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
})

/**
 * "Find everything that looks like the thing I just clicked."
 *
 * The exemplar is a point on the sheet, not a symbol name, because the
 * estimator's own legend is the only definition of "an outlet" that is
 * defensible to a sub. `search_radius_px` bounds the exemplar's extent — the
 * caller sends what the viewer's snap index found around the click.
 */
export const findSymbolMatchesSchema = assistSheetPointSchema.extend({
  drawing_sheet_id: z.string().uuid(),
  /** Half-size of the exemplar box in rendered-image pixels. */
  search_radius_px: z.number().finite().min(4).max(400).optional(),
  /** Restrict matching to a region the user rubber-banded, in normalized space. */
  region: z
    .object({
      x0: z.number().finite().min(0).max(1),
      y0: z.number().finite().min(0).max(1),
      x1: z.number().finite().min(0).max(1),
      y1: z.number().finite().min(0).max(1),
    })
    .optional()
    .nullable(),
})

export type FindSymbolMatchesInput = z.infer<typeof findSymbolMatchesSchema>

/**
 * Accepting a proposal is a separate, explicit act. The client sends back only
 * the points it kept, and the server re-derives the quantity from them — a
 * count that flows into money is never a number the client supplied.
 */
export const acceptSymbolMatchesSchema = z.object({
  drawing_sheet_id: z.string().uuid(),
  sheet_version_id: z.string().uuid(),
  condition_id: z.string().uuid().nullable(),
  points: z
    .array(
      z.tuple([
        z.number().finite().min(0).max(1),
        z.number().finite().min(0).max(1),
      ]),
    )
    .min(1)
    .max(ASSIST_MAX_SYMBOL_MATCHES),
  label: z.string().trim().max(120).optional().nullable(),
})

export type AcceptSymbolMatchesInput = z.infer<typeof acceptSymbolMatchesSchema>
