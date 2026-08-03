/**
 * Measurement geometry for drawing markups.
 *
 * The single home for every px↔normalized↔feet conversion in the drawings
 * stack. The viewer overlay, the markup service, and the as-built PDF export
 * all call in here, so a measured quantity reads the same on screen, in the
 * database, and on the flattened page.
 *
 * Coordinate contract (unchanged from the existing markup model):
 *   - `data.points` are normalized [x, y] in 0..1 against the RENDERED image,
 *     y pointing down.
 *   - `feetPerImagePx` converts a rendered-image pixel into real feet, and is
 *     stored per sheet version at extracted_metadata.calibration.
 *
 * Client-safe: no imports beyond the shared validation helpers.
 */

import { formatFeetInches } from "@/lib/validation/drawings"

/**
 * What a piece of geometry measures. Deliberately narrow: a drawing is flat, so
 * clicking on one can only ever produce a length, an area, or a count. Every
 * richer unit a condition reports (CY, SY, squares, tons) is one of these three
 * carried through a factor — see `ConditionUom` below.
 */
export type MeasureUom = "lf" | "sf" | "ea"

/**
 * Two quantities within this are the same number. Quantities round-trip
 * through Postgres `numeric` (string) and 2-decimal rounding, so comparisons
 * anywhere in the takeoff stack must use this, never `===`.
 */
export const QUANTITY_EPSILON = 0.005

export const MEASURE_UOMS: readonly MeasureUom[] = ["lf", "sf", "ea"] as const

/**
 * What a CONDITION reports, which is what lands on an estimate line. A drawing
 * only ever yields `MeasureUom`; the rest are that measurement carried along
 * the axis the plan does not show (a slab's depth, a wall's height, a roof's
 * pitch) or restated in the unit the trade actually buys in.
 */
export type ConditionUom = MeasureUom | "cy" | "sy" | "sq" | "ton"

export const CONDITION_UOMS: readonly ConditionUom[] = [
  "lf",
  "sf",
  "ea",
  "cy",
  "sy",
  "sq",
  "ton",
] as const

export const MEASURE_UOM_LABELS: Record<ConditionUom, string> = {
  lf: "LF",
  sf: "SF",
  ea: "EA",
  cy: "CY",
  sy: "SY",
  sq: "SQ",
  ton: "TON",
}

/** Long-form unit names, for the condition editor's picker. */
export const CONDITION_UOM_DESCRIPTIONS: Record<ConditionUom, string> = {
  lf: "Linear feet — measured by walking the run",
  sf: "Square feet — measured as an area, or a run times a wall height",
  ea: "Each — one click per item",
  cy: "Cubic yards — a plan area carried down through a depth",
  sy: "Square yards — a plan area, restated for flooring",
  sq: "Squares — 100 SF of roof, sloped if a pitch is set",
  ton: "Tons — a plan area through a depth, at a material density",
}

/** Markup types that carry a real-world quantity. */
export const MEASURING_MARKUP_TYPES = ["dimension", "polyline", "area", "count"] as const
export type MeasuringMarkupType = (typeof MEASURING_MARKUP_TYPES)[number]

/** The unit each measuring type produces. */
export const MEASURING_TYPE_UOM: Record<MeasuringMarkupType, MeasureUom> = {
  dimension: "lf",
  polyline: "lf",
  area: "sf",
  count: "ea",
}

export function isMeasuringMarkupType(type: unknown): type is MeasuringMarkupType {
  return (
    typeof type === "string" &&
    (MEASURING_MARKUP_TYPES as readonly string[]).includes(type)
  )
}

export interface ImageSize {
  width: number
  height: number
}

export interface PxPoint {
  x: number
  y: number
}

/** Normalized point → rendered-image pixels. */
export function toImagePx(point: [number, number], imageSize: ImageSize): PxPoint {
  return { x: point[0] * imageSize.width, y: point[1] * imageSize.height }
}

export function toImagePxAll(points: Array<[number, number]>, imageSize: ImageSize): PxPoint[] {
  return points.map((p) => toImagePx(p, imageSize))
}

// ---------------------------------------------------------------------------
// Primitive geometry (rendered-image pixel space)
// ---------------------------------------------------------------------------

/** Straight-line distance between two points. */
export function segmentLengthPx(a: PxPoint, b: PxPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

/** Total length of an open polyline. Returns 0 for fewer than two points. */
export function polylineLengthPx(points: PxPoint[]): number {
  let total = 0
  for (let i = 1; i < points.length; i++) {
    total += segmentLengthPx(points[i - 1], points[i])
  }
  return total
}

/**
 * Area of a simple polygon by the shoelace formula. The polygon is treated as
 * implicitly closed (last point joins the first), so callers must not repeat
 * the start point. Returns 0 for degenerate rings.
 */
export function polygonAreaPx(points: PxPoint[]): number {
  if (points.length < 3) return 0
  let twiceArea = 0
  for (let i = 0; i < points.length; i++) {
    const current = points[i]
    const next = points[(i + 1) % points.length]
    twiceArea += current.x * next.y - next.x * current.y
  }
  return Math.abs(twiceArea) / 2
}

/** Perimeter of the closed ring described by `points`. */
export function polygonPerimeterPx(points: PxPoint[]): number {
  if (points.length < 2) return 0
  return polylineLengthPx(points) + segmentLengthPx(points[points.length - 1], points[0])
}

/** Arithmetic centroid — good enough for placing a label inside a room. */
export function centroidPx(points: PxPoint[]): PxPoint | null {
  if (points.length === 0) return null
  let sx = 0
  let sy = 0
  for (const p of points) {
    sx += p.x
    sy += p.y
  }
  return { x: sx / points.length, y: sy / points.length }
}

// ---------------------------------------------------------------------------
// Quantity computation
// ---------------------------------------------------------------------------

export interface MeasuredQuantity {
  quantity: number
  uom: MeasureUom
}

export interface MarkupGeometry {
  type: string
  points: Array<[number, number]>
  style?: Record<string, unknown> | null
}

/**
 * A deduction is an ordinary area that counts against its condition: the window
 * cut out of a drywall wall, the stairwell missing from a slab. It is a flag on
 * the area rather than a markup type of its own so that every downstream
 * summation — rollup, per-sheet breakdown, sync, drift — keeps working by
 * simply adding a negative number.
 */
export function isDeductionGeometry(markup: MarkupGeometry): boolean {
  return markup.type === "area" && markup.style?.deduction === true
}

/**
 * Real-world quantity for a measuring markup.
 *
 * Counts need no scale (a point is a point). Length and area need calibration;
 * without it the caller gets null and the UI falls back to pixel labels.
 * Returns null for non-measuring types and for geometry too sparse to measure.
 *
 * A deduction area returns a NEGATIVE quantity — see `isDeductionGeometry`.
 */
export function computeMarkupQuantity(
  markup: MarkupGeometry,
  imageSize: ImageSize | null,
  feetPerImagePx: number | null | undefined,
): MeasuredQuantity | null {
  if (!isMeasuringMarkupType(markup.type)) return null
  const points = Array.isArray(markup.points) ? markup.points : []

  if (markup.type === "count") {
    if (points.length === 0) return null
    return { quantity: points.length, uom: "ea" }
  }

  if (!imageSize || imageSize.width <= 0 || imageSize.height <= 0) return null
  if (!feetPerImagePx || feetPerImagePx <= 0) return null

  const px = toImagePxAll(points, imageSize)

  switch (markup.type) {
    case "dimension": {
      if (px.length < 2) return null
      return { quantity: segmentLengthPx(px[0], px[1]) * feetPerImagePx, uom: "lf" }
    }
    case "polyline": {
      if (px.length < 2) return null
      return { quantity: polylineLengthPx(px) * feetPerImagePx, uom: "lf" }
    }
    case "area": {
      if (px.length < 3) return null
      // Area scales with the square of a linear scale factor.
      const area = polygonAreaPx(px) * feetPerImagePx * feetPerImagePx
      return { quantity: isDeductionGeometry(markup) ? -area : area, uom: "sf" }
    }
  }
}

// ---------------------------------------------------------------------------
// Axis factors — the unmeasured dimension
// ---------------------------------------------------------------------------

/**
 * The three things a plan view cannot show, plus the one material property that
 * turns volume into a purchase unit.
 *
 * Each is a distinct real-world quantity in its own unit, which is why they are
 * four named fields and not a generic `(kind, value)` pair — an estimator typing
 * `8` needs to know whether the box means inches, feet, or rise-per-twelve.
 */
export interface ConditionFactors {
  /** Thickness along the unmeasured axis, in INCHES. Slab depth, base course. */
  depth_in?: number | null
  /** Wall height, in FEET. Turns a run walked in plan into a vertical area. */
  height_ft?: number | null
  /** Roof rise per 12 of run. Turns plan area into sloped surface area. */
  pitch_rise?: number | null
  /** Bulk density, tons per cubic yard. Gravel ≈ 1.4, asphalt ≈ 2.0. */
  tons_per_cy?: number | null
}

/**
 * Slope multiplier for a roof pitch given as rise per 12 of run. An 8/12 roof
 * covers ~1.202× its plan area, which is exactly the number a plan-view
 * measurement is missing.
 */
export function pitchFactor(rise: number): number {
  if (!Number.isFinite(rise) || rise <= 0) return 1
  const slope = rise / 12
  return Math.sqrt(1 + slope * slope)
}

/**
 * The single measure unit a condition's members must be in.
 *
 * A condition has exactly ONE source unit, derived from its output unit and its
 * factors — never a mix. Letting an SF condition sum both SF polygons and
 * height-factored LF runs would make "1,240 LF → 9,920 SF" a lie the moment
 * someone added a gable polygon, and there would be no honest way to show the
 * conversion. One source unit keeps the arithmetic inspectable.
 */
export function conditionSourceUom(
  uom: ConditionUom,
  factors: ConditionFactors | null | undefined,
): MeasureUom {
  switch (uom) {
    case "lf":
      return "lf"
    case "ea":
      return "ea"
    case "sf":
      return factors?.height_ft != null ? "lf" : "sf"
    case "cy":
    case "sy":
    case "sq":
    case "ton":
      return "sf"
  }
}

/** True when this condition converts its members rather than reporting them as measured. */
export function conditionHasConversion(
  uom: ConditionUom,
  factors: ConditionFactors | null | undefined,
): boolean {
  return conditionSourceUom(uom, factors) !== uom || factors?.pitch_rise != null
}

/**
 * Carry one measured quantity into the condition's reporting unit.
 *
 * Every conversion here is a linear multiplier, so applying it per member and
 * summing gives the same answer as summing and applying it once — which is why
 * the per-sheet breakdown can be shown in the reporting unit without drifting
 * from the total.
 */
export function convertToConditionUom(
  quantity: number,
  uom: ConditionUom,
  factors: ConditionFactors | null | undefined,
): number {
  if (!Number.isFinite(quantity)) return 0
  const pitch = factors?.pitch_rise != null ? pitchFactor(factors.pitch_rise) : 1

  switch (uom) {
    case "lf":
    case "ea":
      return quantity
    case "sf":
      return factors?.height_ft != null
        ? quantity * factors.height_ft
        : quantity * pitch
    case "sy":
      return quantity / 9
    case "sq":
      return (quantity * pitch) / 100
    case "cy":
      return cubicYards(quantity, factors?.depth_in)
    case "ton":
      return cubicYards(quantity, factors?.depth_in) * (factors?.tons_per_cy ?? 0)
  }
}

/** Plan area in SF carried down through a depth in inches, as cubic yards. */
export function cubicYards(squareFeet: number, depthInches: number | null | undefined): number {
  if (!depthInches || !Number.isFinite(depthInches) || depthInches <= 0) return 0
  return (squareFeet * (depthInches / 12)) / 27
}

/**
 * The sentence the panel shows under a converted condition, so the estimator
 * can check the arithmetic without leaving the sheet. Null when the condition
 * reports exactly what it measured.
 */
export function conversionSummary(
  sourceQuantity: number,
  uom: ConditionUom,
  factors: ConditionFactors | null | undefined,
): string | null {
  if (!conditionHasConversion(uom, factors)) return null
  const source = conditionSourceUom(uom, factors)
  const parts: string[] = [`${formatQuantity(sourceQuantity)} ${MEASURE_UOM_LABELS[source]}`]

  if (factors?.height_ft != null) parts.push(`× ${formatQuantity(factors.height_ft)}′ high`)
  if (factors?.depth_in != null) parts.push(`× ${formatQuantity(factors.depth_in)}″ deep`)
  if (factors?.pitch_rise != null) {
    parts.push(`× ${formatQuantity(factors.pitch_rise)}/12 pitch`)
  }
  if (factors?.tons_per_cy != null) {
    parts.push(`× ${formatQuantity(factors.tons_per_cy)} t/CY`)
  }

  const converted = convertToConditionUom(sourceQuantity, uom, factors)
  parts.push(`= ${formatQuantity(converted)} ${MEASURE_UOM_LABELS[uom]}`)
  return parts.join(" ")
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const QUANTITY_FORMAT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
})

/** `1,240.5` — the on-screen number for a quantity, without its unit. */
export function formatQuantity(quantity: number): string {
  if (!Number.isFinite(quantity)) return "—"
  return QUANTITY_FORMAT.format(quantity)
}

/** `1,240.5 SF` — quantity plus unit, for panels and rollups. */
export function formatQuantityWithUom(quantity: number, uom: ConditionUom): string {
  return `${formatQuantity(quantity)} ${MEASURE_UOM_LABELS[uom]}`
}

/**
 * The label drawn on the sheet next to a measuring markup.
 *
 * Lengths read as feet-inches because that is how a builder reads a plan;
 * areas and counts read as decimal numbers. Uncalibrated length/area geometry
 * degrades to rendered pixels, which is what the viewer has always shown.
 */
export function measurementLabel(
  markup: MarkupGeometry,
  imageSize: ImageSize | null,
  feetPerImagePx: number | null | undefined,
): string | null {
  if (!isMeasuringMarkupType(markup.type)) return null
  const measured = computeMarkupQuantity(markup, imageSize, feetPerImagePx)

  if (measured) {
    switch (measured.uom) {
      case "lf":
        return formatFeetInches(measured.quantity)
      case "sf":
        // Deductions carry a real minus sign, not a hyphen — at label size on a
        // dense sheet the two are not the same glyph.
        return measured.quantity < 0
          ? `−${formatQuantity(Math.abs(measured.quantity))} SF`
          : `${formatQuantity(measured.quantity)} SF`
      case "ea":
        return `${measured.quantity}`
    }
  }

  // Uncalibrated fallback: raw rendered-image pixels.
  if (!imageSize) return null
  const px = toImagePxAll(Array.isArray(markup.points) ? markup.points : [], imageSize)
  switch (markup.type) {
    case "dimension":
      return px.length >= 2 ? `${Math.round(segmentLengthPx(px[0], px[1]))}px` : null
    case "polyline":
      return px.length >= 2 ? `${Math.round(polylineLengthPx(px))}px` : null
    case "area":
      return px.length >= 3 ? `${Math.round(polygonAreaPx(px)).toLocaleString("en-US")}px²` : null
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Waste and rollup math (shared by the service and the panel preview)
// ---------------------------------------------------------------------------

/**
 * Waste-adjusted quantity for a condition. Rounded to 2 decimals so the number
 * the panel shows is byte-identical to the one written to an estimate line.
 */
export function applyWaste(quantity: number, wastePct: number): number {
  const adjusted = quantity * (1 + (Number.isFinite(wastePct) ? wastePct : 0) / 100)
  return Math.round(adjusted * 100) / 100
}

/** Extended cost in integer cents for a quantity at a unit rate. */
export function extendedCents(quantity: number, unitCostCents: number | null | undefined): number {
  if (!unitCostCents || !Number.isFinite(quantity)) return 0
  return Math.round(quantity * unitCostCents)
}
