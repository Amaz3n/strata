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

export type MeasureUom = "lf" | "sf" | "ea"

/**
 * Two quantities within this are the same number. Quantities round-trip
 * through Postgres `numeric` (string) and 2-decimal rounding, so comparisons
 * anywhere in the takeoff stack must use this, never `===`.
 */
export const QUANTITY_EPSILON = 0.005

export const MEASURE_UOMS: readonly MeasureUom[] = ["lf", "sf", "ea"] as const

export const MEASURE_UOM_LABELS: Record<MeasureUom, string> = {
  lf: "LF",
  sf: "SF",
  ea: "EA",
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
}

/**
 * Real-world quantity for a measuring markup.
 *
 * Counts need no scale (a point is a point). Length and area need calibration;
 * without it the caller gets null and the UI falls back to pixel labels.
 * Returns null for non-measuring types and for geometry too sparse to measure.
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
      return { quantity: polygonAreaPx(px) * feetPerImagePx * feetPerImagePx, uom: "sf" }
    }
  }
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
export function formatQuantityWithUom(quantity: number, uom: MeasureUom): string {
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
        return `${formatQuantity(measured.quantity)} SF`
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
