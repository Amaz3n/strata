/**
 * Where on the page a extracted value came from.
 *
 * Provenance is the one part of extraction that code cannot verify. A total can
 * be checked against the lines; a claim that the total sits at (0.71, 0.88) can
 * only be checked by a human looking at it. So this module does the one thing
 * that IS decidable — throwing out boxes that are structurally useless — and
 * everything that survives is treated as a hint for the reviewer's eye, never as
 * data anything depends on.
 *
 * Two rejections do most of the work:
 *
 * - A DEGENERATE box (zero-width, or a few pixels across) is a model that had
 *   nothing to say emitting coordinates anyway.
 * - A NEAR-FULL-PAGE box is the same failure wearing a disguise: "the total is
 *   somewhere on this page" is not provenance, and highlighting the whole sheet
 *   is worse than highlighting nothing, because it looks like an answer.
 *
 * Pure, so the rules can be tested without a provider.
 */

export interface DocumentRegion {
  /** 1-based, matching what a reviewer sees in the page control. */
  page: number
  /** Normalized 0..1, origin top-left. */
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Header fields a reviewer can click through to the page. */
export const PROVENANCE_FIELDS = [
  "vendor_name",
  "bill_number",
  "bill_date",
  "due_date",
  "subtotal",
  "tax",
  "total",
] as const
export type ProvenanceField = (typeof PROVENANCE_FIELDS)[number]

/** Below this fraction of the page a box is too small to be a real citation. */
const MIN_AREA = 0.00002
/** At or above this fraction, the box is a shrug rather than a location. */
const MAX_AREA = 0.9

function clamp01(value: number) {
  if (!Number.isFinite(value)) return null
  return Math.min(1, Math.max(0, value))
}

/**
 * Turn whatever the model returned into a region, or null.
 *
 * Coordinates arrive normalized because asking for pixels means asking the model
 * to know the render resolution, which it does not. Inverted boxes are repaired
 * rather than rejected: models transpose corners often enough that discarding
 * those would throw away good citations for a fixable clerical error.
 */
export function normalizeRegion(
  raw: {
    page?: number | null
    x0?: number | null
    y0?: number | null
    x1?: number | null
    y1?: number | null
  } | null
  | undefined,
  options: { pageCount?: number | null } = {},
): DocumentRegion | null {
  if (!raw) return null

  const x0 = clamp01(raw.x0 ?? Number.NaN)
  const y0 = clamp01(raw.y0 ?? Number.NaN)
  const x1 = clamp01(raw.x1 ?? Number.NaN)
  const y1 = clamp01(raw.y1 ?? Number.NaN)
  if (x0 === null || y0 === null || x1 === null || y1 === null) return null

  const left = Math.min(x0, x1)
  const right = Math.max(x0, x1)
  const top = Math.min(y0, y1)
  const bottom = Math.max(y0, y1)

  const area = (right - left) * (bottom - top)
  if (!(area > MIN_AREA) || area >= MAX_AREA) return null

  const rawPage = raw.page
  const page = Number.isFinite(rawPage) ? Math.floor(rawPage as number) : 1
  if (page < 1) return null
  if (options.pageCount != null && options.pageCount > 0 && page > options.pageCount) return null

  return { page, x0: left, y0: top, x1: right, y1: bottom }
}

/**
 * Collapse the model's list into one region per field, keeping the first valid
 * claim. A field named twice is a model contradicting itself, and the later
 * entry has no more standing than the earlier one.
 */
export function collectFieldProvenance(
  entries: Array<{
    field: string
    page?: number | null
    x0?: number | null
    y0?: number | null
    x1?: number | null
    y1?: number | null
  }>,
  options: { pageCount?: number | null } = {},
): Partial<Record<ProvenanceField, DocumentRegion>> {
  const known = new Set<string>(PROVENANCE_FIELDS)
  const result: Partial<Record<ProvenanceField, DocumentRegion>> = {}

  for (const entry of entries) {
    if (!known.has(entry.field)) continue
    const field = entry.field as ProvenanceField
    if (result[field]) continue
    const region = normalizeRegion(entry, options)
    if (region) result[field] = region
  }

  return result
}

/** Pad a region slightly so the highlight frames the value instead of clipping it. */
export function padRegion(region: DocumentRegion, pad = 0.006): DocumentRegion {
  return {
    page: region.page,
    x0: Math.max(0, region.x0 - pad),
    y0: Math.max(0, region.y0 - pad),
    x1: Math.min(1, region.x1 + pad),
    y1: Math.min(1, region.y1 + pad),
  }
}
