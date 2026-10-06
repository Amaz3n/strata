import "server-only"
import { isDeepStrictEqual } from "node:util"
import { z } from "zod"

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
  type ImageSize,
  type MeasureUom,
} from "@/lib/drawings/measure"
import { drawingMarkupRevisionSchema, markupDataSchema, measureUomSchema, storedSheetCalibrationSchema, storedDrawingManifestSchema, type MarkupData } from "@/lib/validation/drawings"
import { storedConditionMeasurementSchema, storedMeasurementQuantitySchema } from "@/lib/validation/takeoff"
import { readAllRowsById } from "@/lib/land/paging"


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
 * Uses the caller's client and validates the source ancestry. Caller-specific
 * authorization still belongs to the owning workflow, including worker paths.
 */
export async function loadMeasurementContext(
  supabase: SupabaseClient,
  orgId: string,
  sheetVersionId: string,
  expectedSheetId?: string,
): Promise<MeasurementContext> {
  z.string().uuid().parse(orgId)
  z.string().uuid().parse(sheetVersionId)
  if (expectedSheetId !== undefined) z.string().uuid().parse(expectedSheetId)
  const { data, error } = await supabase
    .from("drawing_sheet_versions")
    .select("id,org_id,drawing_sheet_id,drawing_revision_id,image_width,image_height,tile_manifest,extracted_metadata,drawing_sheets!inner(id,org_id,project_id),drawing_revisions!inner(id,org_id,project_id)")
    .eq("org_id", orgId)
    .eq("id", sheetVersionId)
    .maybeSingle()

  if (error) throw new Error(`Failed to load measurement source: ${error.message}`)
  if (!data) throw new Error("Measurement source unavailable. Reload the drawing before retrying.")
  const parentSchema = z.object({ id: z.string().uuid(), org_id: z.string().uuid(), project_id: z.string().uuid() })
  const source = z.object({
    id: z.string().uuid(), org_id: z.string().uuid(), drawing_sheet_id: z.string().uuid(), drawing_revision_id: z.string().uuid(),
    image_width: z.number().int().nonnegative().safe().nullable(), image_height: z.number().int().nonnegative().safe().nullable(),
    tile_manifest: storedDrawingManifestSchema, extracted_metadata: z.record(z.unknown()).nullable(),
    drawing_sheets: z.union([parentSchema, z.array(parentSchema).length(1)]),
    drawing_revisions: z.union([parentSchema, z.array(parentSchema).length(1)]),
  }).parse(data)
  const sheet = Array.isArray(source.drawing_sheets) ? source.drawing_sheets[0] : source.drawing_sheets
  const revision = Array.isArray(source.drawing_revisions) ? source.drawing_revisions[0] : source.drawing_revisions
  if (source.id !== sheetVersionId || source.org_id !== orgId || (expectedSheetId !== undefined && source.drawing_sheet_id !== expectedSheetId) || sheet.id !== source.drawing_sheet_id || sheet.org_id !== orgId ||
    revision.id !== source.drawing_revision_id || revision.org_id !== orgId || revision.project_id !== sheet.project_id) throw new Error("Measurement source scope unavailable. Reload the drawing before retrying.")

  const metadata = source.extracted_metadata ?? {}
  const calibration = storedSheetCalibrationSchema.nullish().parse(metadata.calibration)
  const manifestSize = source.tile_manifest?.Image?.Size
  const width = manifestSize?.Width ?? source.image_width ?? 0
  const height = manifestSize?.Height ?? source.image_height ?? 0

  return {
    imageSize: width > 0 && height > 0 ? { width, height } : null,
    feetPerImagePx: calibration?.feet_per_image_px ?? null,
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
    .select("id, org_id, name, uom, depth_in, height_ft, pitch_rise, tons_per_cy")
    .eq("org_id", orgId)
    .eq("id", conditionId)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to load takeoff condition: ${error.message}`)
  }
  if (!condition || condition.id !== conditionId || condition.org_id !== orgId) {
    throw new Error("Takeoff condition not found")
  }
  if (!uom) {
    throw new Error("Only measurements (linear, area, or count) can belong to a takeoff condition")
  }

  const measured = storedConditionMeasurementSchema.parse(condition)
  const expected = conditionSourceUom(measured.uom, measured)

  if (expected !== uom) {
    const reports = MEASURE_UOM_LABELS[measured.uom]
    const measures = MEASURE_UOM_LABELS[expected]
    throw new Error(
      expected === measured.uom
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
const RECOMPUTE_VALIDATION_CAP = 200_000

export async function recomputeMarkupQuantitiesForVersion(
  supabase: SupabaseClient,
  orgId: string,
  sheetVersionId: string,
): Promise<number> {
  const context = await loadMeasurementContext(supabase, orgId, sheetVersionId)

  // Only an empty page proves exhaustion: a transport may cap responses below
  // the requested page size. Inspect the complete supported set before writing.
  const rows = await readAllRowsById(async (afterId, limit) => {
    let query = supabase.from("drawing_markups")
      .select("id,org_id,sheet_version_id,drawing_sheet_id,condition_id,created_by,updated_at,data,quantity,uom")
      .eq("org_id", orgId).eq("sheet_version_id", sheetVersionId)
      .in("data->>type", [...MEASURING_MARKUP_TYPES]).order("id", { ascending: true }).limit(limit)
    if (afterId) query = query.gt("id", afterId)
    const result = await query
    if (result.data?.some((row) => row.org_id !== orgId || row.sheet_version_id !== sheetVersionId)) {
      throw new Error("Recompute measurement scope unavailable. Reload before retrying.")
    }
    return result
  }, { cap: RECOMPUTE_VALIDATION_CAP, pageSize: RECOMPUTE_PAGE_SIZE, label: "Unable to load all measurements for recompute" })

  const pending: Array<{ source: (typeof rows)[number]; quantity: number | null; uom: MeasureUom | null }> = []
  const conditions = new Map<string, Set<MeasureUom>>()
  for (const row of rows) {
    drawingMarkupRevisionSchema.parse(row)
    const geometry = markupDataSchema.parse(row.data)
    if (!isMeasuringMarkupType(geometry.type)) throw new Error("Unexpected nonmeasuring recompute source")
    const next = measureMarkup(geometry, context)
    const previousQuantity = storedMeasurementQuantitySchema.parse(row.quantity)
    const previousUom = measureUomSchema.nullable().parse(row.uom)
    if (row.condition_id !== null) {
      if (typeof row.condition_id !== "string" || !row.condition_id) throw new Error("Recompute condition source unavailable")
      if (!next.uom) throw new Error("Assigned recompute source is not a measurement")
      const units = conditions.get(row.condition_id) ?? new Set<MeasureUom>()
      units.add(next.uom)
      conditions.set(row.condition_id, units)
    }
    const sameQuantity = previousQuantity === null
      ? next.quantity === null
      : next.quantity !== null && Math.abs(previousQuantity - next.quantity) < 1e-9
    if (!sameQuantity || previousUom !== next.uom) pending.push({ source: row, ...next })
  }

  // Validate all assigned units before the first quantity write, including
  // members whose quantity already matches. Deduplicate repeated conditions.
  const targets = [...conditions].flatMap(([conditionId, units]) => [...units].map((uom) => ({ conditionId, uom })))
  for (let offset = 0; offset < targets.length; offset += RECOMPUTE_WRITE_CONCURRENCY) {
    await Promise.all(targets.slice(offset, offset + RECOMPUTE_WRITE_CONCURRENCY)
      .map(({ conditionId, uom }) => assertConditionAcceptsUom(supabase, orgId, conditionId, uom)))
  }

  // Existing bounded per-row writes now fence the source revision and verify
  // the returned measurement. This still needs atomic calibration recovery.
  for (let offset = 0; offset < pending.length; offset += RECOMPUTE_WRITE_CONCURRENCY) {
    const results = await Promise.allSettled(pending.slice(offset, offset + RECOMPUTE_WRITE_CONCURRENCY).map(async (item) => {
      const { data, error } = await supabase.from("drawing_markups")
        .update({ quantity: item.quantity, uom: item.uom })
        .eq("org_id", orgId).eq("sheet_version_id", sheetVersionId)
        .eq("id", item.source.id).eq("updated_at", item.source.updated_at)
        .select("id,org_id,sheet_version_id,drawing_sheet_id,condition_id,created_by,updated_at,data,quantity,uom")
        .maybeSingle()
      if (error) throw new Error(`Failed to recompute markup quantity: ${error.message}`)
      if (!data) throw new Error("Measurement changed during recalibration. Reload before retrying.")
      if (data.id !== item.source.id || data.org_id !== orgId || data.sheet_version_id !== sheetVersionId ||
        data.drawing_sheet_id !== item.source.drawing_sheet_id || data.condition_id !== item.source.condition_id ||
        data.created_by !== item.source.created_by || !isDeepStrictEqual(data.data, item.source.data) ||
        storedMeasurementQuantitySchema.parse(data.quantity) !== item.quantity || data.uom !== item.uom ||
        !drawingMarkupRevisionSchema.safeParse(data).success) {
        throw new Error("Recomputed measurement could not be confirmed. Reload before retrying.")
      }
    }))
    const failed = results.find((result) => result.status === "rejected")
    if (failed?.status === "rejected") {
      throw failed.reason instanceof Error ? failed.reason : new Error("Unable to confirm recalibrated measurements")
    }
  }
  return pending.length
}
