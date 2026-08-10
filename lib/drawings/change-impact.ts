/**
 * Turning "these pixels moved" into "this costs money".
 *
 * The pixel diff in `change-detection.ts` answers *whether* a sheet changed and
 * *where*. That is genuinely useful and genuinely not enough: a superintendent
 * looking at eleven red boxes on A-201 still has to open both sheets and work
 * out which of them matter. Two of those boxes are a revised date stamp and a
 * moved north arrow; one of them moved a wall that four takeoff measurements
 * and an open RFI depend on.
 *
 * This module holds the part of that judgement code can make on its own: which
 * of Arc's records geometrically sit inside a changed region. A vision model
 * classifies what KIND of change each region is; nothing here asks it what the
 * change touches, because Arc already knows where every measurement, pin and
 * callout lives on the sheet, and a join is not a thing to guess at.
 *
 * Pure — no I/O, no Supabase, no provider. Unit-tested in
 * tests/change-impact.test.js.
 */

/** Bump when the classification or matching rules change. */
export const CHANGE_SEMANTICS_ALGO = "change-semantics-v1"

/**
 * What a changed region turned out to be.
 *
 * The distinction that earns its keep is `annotation` vs everything else: a
 * revision cloud, a new note, or a stamped date changes pixels and changes no
 * quantity. Reporting those with the same weight as moved linework is how a
 * change report trains people to ignore it.
 */
export const CHANGE_KINDS = [
  "added",
  "removed",
  "modified",
  "annotation",
  "titleblock",
  "noise",
] as const
export type ChangeKind = (typeof CHANGE_KINDS)[number]

export const CHANGE_KIND_LABELS: Record<ChangeKind, string> = {
  added: "Added",
  removed: "Removed",
  modified: "Modified",
  annotation: "Annotation",
  titleblock: "Title block",
  noise: "No real change",
}

/** Kinds that can move a quantity. The rest are informational. */
const QUANTITY_BEARING = new Set<ChangeKind>(["added", "removed", "modified"])

export function isQuantityBearing(kind: ChangeKind): boolean {
  return QUANTITY_BEARING.has(kind)
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Tolerance when testing whether a record sits in a changed region.
 *
 * The diff grid is 16px cells at a downsampled level, so a region's edge is
 * already coarse; a measurement whose endpoint lands just outside one is far
 * more likely to be affected than not. Missing a real impact is much worse than
 * flagging a near miss, and the reviewer sees both sheets either way.
 */
export const DEFAULT_MATCH_PAD = 0.01

export function boundsOfPoints(points: Array<[number, number]>): Box | null {
  if (points.length === 0) return null

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  for (const [x, y] of points) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export function padBox(box: Box, pad: number): Box {
  return {
    x: box.x - pad,
    y: box.y - pad,
    w: box.w + pad * 2,
    h: box.h + pad * 2,
  }
}

export function boxesIntersect(a: Box, b: Box): boolean {
  return (
    a.x <= b.x + b.w &&
    b.x <= a.x + a.w &&
    a.y <= b.y + b.h &&
    b.y <= a.y + a.h
  )
}

/** Share of the sheet a box covers. Used to rank and to sanity-check a region. */
export function boxArea(box: Box): number {
  return Math.max(0, box.w) * Math.max(0, box.h)
}

export interface RegionMatch<T> {
  item: T
  /** Indexes into the region list, in region order. Never empty. */
  regionIndexes: number[]
}

/**
 * Which records fall inside which changed regions.
 *
 * A single record can be hit by several regions (a long wall run crossing two
 * separate edits), and a single region typically hits several records. Both
 * directions are kept rather than collapsed, because the report reads one way
 * ("this region affects these four measurements") and the impact summary reads
 * the other ("this measurement is affected").
 */
export function matchItemsToRegions<T>(
  regions: Box[],
  items: Array<{ item: T; box: Box | null }>,
  pad: number = DEFAULT_MATCH_PAD,
): Array<RegionMatch<T>> {
  const padded = regions.map((region) => padBox(region, pad))
  const matches: Array<RegionMatch<T>> = []

  for (const entry of items) {
    if (!entry.box) continue
    const regionIndexes: number[] = []
    for (const [index, region] of padded.entries()) {
      if (boxesIntersect(region, entry.box)) regionIndexes.push(index)
    }
    if (regionIndexes.length > 0) matches.push({ item: entry.item, regionIndexes })
  }

  return matches
}

export type ChangeSeverity = "high" | "medium" | "low"

/**
 * How loudly to report one region.
 *
 * Impact on a real record outranks size every time. A hand-sized region that
 * moved a wall four measurements price off it is the most important thing on
 * the sheet; a quarter-page region that turned out to be a revision cloud is
 * not, however much of the page it covers.
 */
export function changeSeverity(input: {
  kind: ChangeKind
  /** Arc records geometrically inside this region. */
  affectedRecords: number
  /** Share of the sheet this region covers, 0..1. */
  areaShare: number
}): ChangeSeverity {
  if (input.kind === "noise") return "low"
  if (!isQuantityBearing(input.kind)) {
    // An annotation over something priced is still worth a look — that is how a
    // "see revised detail 4" cloud reads — but it is never the top of the list.
    return input.affectedRecords > 0 ? "medium" : "low"
  }
  if (input.affectedRecords > 0) return "high"
  return input.areaShare >= 0.01 ? "medium" : "low"
}

const SEVERITY_ORDER: Record<ChangeSeverity, number> = { high: 0, medium: 1, low: 2 }

export interface ClassifiedRegion {
  region: Box
  kind: ChangeKind
  summary: string
  severity: ChangeSeverity
  affectedRecords: number
}

/**
 * Report order: severity first, then how much of the sheet moved. Sorting by
 * area alone — which is all the pixel diff could do — routinely put a re-plotted
 * title block above the one wall that moved.
 */
export function rankClassifiedRegions<T extends ClassifiedRegion>(regions: T[]): T[] {
  return [...regions].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    if (bySeverity !== 0) return bySeverity
    return boxArea(b.region) - boxArea(a.region)
  })
}

export interface RevisionImpactSummary {
  /** Regions the diff found, after classification. */
  totalRegions: number
  /** Regions that can move a quantity. */
  substantiveRegions: number
  /** Regions that turned out to be annotation, title block, or noise. */
  incidentalRegions: number
  highSeverity: number
  /** Distinct Arc records touched by any substantive region. */
  affectedRecords: number
  /**
   * True when every region classified as incidental. The headline a reviewer
   * most wants and the pixel diff could never give: "this re-issue moved
   * nothing you price off".
   */
  noSubstantiveChange: boolean
}

export function summarizeRevisionImpact(
  regions: ClassifiedRegion[],
  distinctAffectedRecords: number,
): RevisionImpactSummary {
  const substantive = regions.filter((region) => isQuantityBearing(region.kind))
  return {
    totalRegions: regions.length,
    substantiveRegions: substantive.length,
    incidentalRegions: regions.length - substantive.length,
    highSeverity: regions.filter((region) => region.severity === "high").length,
    affectedRecords: distinctAffectedRecords,
    noSubstantiveChange: regions.length > 0 && substantive.length === 0,
  }
}
