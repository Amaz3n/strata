import "server-only"

/**
 * Server-side measurement of drawing markups.
 *
 * Lives apart from `drawing-markups.ts` so `drawings.ts` (which recomputes
 * quantities whenever a sheet is calibrated) can reach it without the two
 * services importing each other. The math itself is in `lib/drawings/measure.ts`;
 * this module only supplies the sheet context and writes the results.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import {
  computeMarkupQuantity,
  conditionSourceUom,
  isMeasuringMarkupType,
  MEASURE_UOM_LABELS,
  MEASURING_MARKUP_TYPES,
  MEASURING_TYPE_UOM,
  type ConditionFactors,
  type ConditionUom,
  type ImageSize,
  type MeasureUom,
} from "@/lib/drawings/measure"
import type { MarkupData } from "@/lib/validation/drawings"


/**
 * The two things a measurement needs beyond its own geometry: the pixel
 * dimensions of the rendered sheet the points are normalized against, and the
 * scale of that sheet.
 */
export interface MeasurementContext {
  imageSize: ImageSize | null
  feetPerImagePx: number | null
}

/**
 * Load the measurement context for a sheet version. Image dimensions come from
 * the tile manifest (authoritative for tiled sheets) and fall back to the
 * stored render size; calibration comes from the version's extracted metadata.
 *
 * Uses the caller's scoped client so RLS still applies.
 */
export async function loadMeasurementContext(
  supabase: SupabaseClient,
  orgId: string,
  sheetVersionId: string,
): Promise<MeasurementContext> {
  const { data } = await supabase
    .from("drawing_sheet_versions")
    .select("id, image_width, image_height, tile_manifest, calibration:extracted_metadata->calibration")
    .eq("org_id", orgId)
    .eq("id", sheetVersionId)
    .maybeSingle()

  if (!data) return { imageSize: null, feetPerImagePx: null }

  const manifestSize = (data.tile_manifest as any)?.Image?.Size
  const width = Number(manifestSize?.Width ?? data.image_width ?? 0)
  const height = Number(manifestSize?.Height ?? data.image_height ?? 0)
  const calibration = data.calibration as { feet_per_image_px?: unknown } | null

  const feetPerImagePx =
    typeof calibration?.feet_per_image_px === "number" && calibration.feet_per_image_px > 0
      ? calibration.feet_per_image_px
      : null

  return {
    imageSize: width > 0 && height > 0 ? { width, height } : null,
    feetPerImagePx,
  }
}

/**
 * Resolve `{ quantity, uom }` for a markup. Non-measuring markups get nulls;
 * a measuring markup on an uncalibrated sheet keeps its unit but has no
 * quantity yet, so the takeoff panel can say "measured, awaiting scale"
 * instead of pretending the markup is an annotation.
 */
export function measureMarkup(
  data: MarkupData,
  context: MeasurementContext,
): { quantity: number | null; uom: MeasureUom | null } {
  if (!isMeasuringMarkupType(data.type)) return { quantity: null, uom: null }
  const measured = computeMarkupQuantity(
    // `style` carries the deduction flag, which decides the SIGN of an area —
    // dropping it here is how a window silently starts adding to the wall.
    { type: data.type, points: data.points, style: data.style ?? null },
    context.imageSize,
    context.feetPerImagePx,
  )
  if (measured) return { quantity: measured.quantity, uom: measured.uom }

  // Unmeasurable for now (no scale, or too few points) — still typed.
  return { quantity: null, uom: MEASURING_TYPE_UOM[data.type] }
}

/**
 * A condition sums its members, so every member must measure in the condition's
 * SOURCE unit — which is not always the unit it reports. A cubic-yard condition
 * is measured in square feet and carried down through a depth; a square-foot
 * condition with a wall height is measured in linear feet. Refusing the
 * assignment here is the only thing stopping square feet from being added to
 * linear feet and priced.
 */
export async function assertConditionAcceptsUom(
  supabase: SupabaseClient,
  orgId: string,
  conditionId: string,
  uom: MeasureUom | null,
): Promise<void> {
  const { data: condition, error } = await supabase
    .from("takeoff_conditions")
    .select("id, name, uom, depth_in, height_ft, pitch_rise, tons_per_cy")
    .eq("org_id", orgId)
    .eq("id", conditionId)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to load takeoff condition: ${error.message}`)
  }
  if (!condition) {
    throw new Error("Takeoff condition not found")
  }
  if (!uom) {
    throw new Error("Only measurements (linear, area, or count) can belong to a takeoff condition")
  }

  const factors: ConditionFactors = {
    depth_in: condition.depth_in === null ? null : Number(condition.depth_in),
    height_ft: condition.height_ft === null ? null : Number(condition.height_ft),
    pitch_rise: condition.pitch_rise === null ? null : Number(condition.pitch_rise),
    tons_per_cy: condition.tons_per_cy === null ? null : Number(condition.tons_per_cy),
  }
  const expected = conditionSourceUom(condition.uom as ConditionUom, factors)

  if (expected !== uom) {
    const reports = MEASURE_UOM_LABELS[condition.uom as ConditionUom]
    const measures = MEASURE_UOM_LABELS[expected]
    throw new Error(
      expected === (condition.uom as string)
        ? `"${condition.name}" measures in ${measures} — this markup measures in ${MEASURE_UOM_LABELS[uom]}`
        : `"${condition.name}" reports ${reports} and is measured in ${measures} — this markup measures in ${MEASURE_UOM_LABELS[uom]}`,
    )
  }
}

/**
 * Recompute every measuring markup on a sheet version. Called when the version
 * is calibrated or recalibrated — without this, a corrected scale would leave
 * every previously saved quantity wrong and there would be no signal that it
 * had happened. Returns the number of rows whose stored quantity changed.
 */
const RECOMPUTE_PAGE_SIZE = 1000
const RECOMPUTE_WRITE_CONCURRENCY = 20

export async function recomputeMarkupQuantitiesForVersion(
  supabase: SupabaseClient,
  orgId: string,
  sheetVersionId: string,
): Promise<number> {
  const context = await loadMeasurementContext(supabase, orgId, sheetVersionId)

  // Keyset-paginated: an uncapped select silently truncates at PostgREST's
  // default row limit, which would leave the tail of a dense sheet holding
  // quantities computed against the OLD scale with no signal at all.
  const rows: Array<{ id: string; data: unknown; quantity: unknown; uom: string | null }> = []
  let cursor: string | null = null
  for (;;) {
    let query = supabase
      .from("drawing_markups")
      .select("id, data, quantity, uom")
      .eq("org_id", orgId)
      .eq("sheet_version_id", sheetVersionId)
      .in("data->>type", [...MEASURING_MARKUP_TYPES])
      .order("id", { ascending: true })
      .limit(RECOMPUTE_PAGE_SIZE)
    if (cursor) query = query.gt("id", cursor)

    const { data: page, error } = await query
    if (error) {
      throw new Error(`Failed to load markups for recompute: ${error.message}`)
    }
    if (!page || page.length === 0) break
    rows.push(...page)
    if (page.length < RECOMPUTE_PAGE_SIZE) break
    cursor = page[page.length - 1].id as string
  }

  if (rows.length === 0) return 0

  const pending: Array<{ id: string; quantity: number | null; uom: string | null }> = []
  for (const row of rows) {
    const next = measureMarkup(row.data as MarkupData, context)
    const previousQuantity = row.quantity === null || row.quantity === undefined ? null : Number(row.quantity)
    const sameQuantity =
      previousQuantity === null
        ? next.quantity === null
        : next.quantity !== null && Math.abs(previousQuantity - next.quantity) < 1e-9
    if (sameQuantity && row.uom === next.uom) continue
    pending.push({ id: row.id, quantity: next.quantity, uom: next.uom })
  }

  // Each row gets a different value, so these are per-row updates by nature —
  // but they run in bounded parallel batches instead of one at a time.
  for (let i = 0; i < pending.length; i += RECOMPUTE_WRITE_CONCURRENCY) {
    const batch = pending.slice(i, i + RECOMPUTE_WRITE_CONCURRENCY)
    const results = await Promise.all(
      batch.map((item) =>
        supabase
          .from("drawing_markups")
          .update({ quantity: item.quantity, uom: item.uom })
          .eq("org_id", orgId)
          .eq("id", item.id),
      ),
    )
    const failed = results.find((result) => result.error)
    if (failed?.error) {
      throw new Error(`Failed to recompute markup quantity: ${failed.error.message}`)
    }
  }

  return pending.length
}
