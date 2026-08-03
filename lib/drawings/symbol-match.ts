/**
 * Count by example — find every symbol on a sheet that matches the one clicked.
 *
 * The estimator clicks ONE outlet and asks for the rest. That framing is the
 * whole design: the exemplar is a point on their drawing, not a name from a
 * catalogue, so the result is defensible to a sub in a way "the model thinks
 * these are outlets" never is. The count that comes back is a proposal, and
 * nothing reaches a quantity until a human accepts it.
 *
 * Method is geometric hashing over the extracted PDF linework:
 *
 *   1. Collect the segments around the click — that is the exemplar.
 *   2. Pick its RAREST segment (by length and angle). Every real occurrence of
 *      the symbol must contain one, so this turns a whole-sheet search into a
 *      short candidate list.
 *   3. For each candidate, derive the implied translation and check how much of
 *      the rest of the exemplar actually appears there.
 *   4. Keep the placements where enough of it does — including the exemplar's
 *      own, which matches at zero translation. See `SymbolMatchResult.matches`.
 *
 * Rotation is handled by running the same search at 0/90/180/270°, because a
 * switch drawn on a vertical wall is the same switch. Angles are compared
 * direction-agnostically (mod 180°), so a segment drawn either way round
 * matches itself.
 *
 * Coordinate contract matches `vector-snap.ts`: segments arrive NORMALIZED
 * 0..1, y-down, and everything internal works in rendered-image pixels.
 *
 * Client-safe and pure — this runs in the viewer, so a match costs no round
 * trip, no tokens, and no waiting. The vision path exists only for sheets where
 * this finds nothing.
 */

export interface ImageSize {
  width: number
  height: number
}

export interface NormPoint {
  x: number
  y: number
}

export interface SymbolMatch {
  /** Centre of the matched symbol, normalized 0..1. */
  point: NormPoint
  /** Share of the exemplar's segments found at this placement, 0..1. */
  score: number
  /** Degrees clockwise the match is rotated from the exemplar. */
  rotation: 0 | 90 | 180 | 270
}

export interface SymbolMatchOptions {
  /** Half-size of the exemplar box, in image pixels. */
  radiusPx?: number
  /** Reject placements below this share of the exemplar's segments. */
  minScore?: number
  /** Stop after this many, so a hatched sheet cannot produce ten thousand. */
  maxMatches?: number
  /** Restrict the search to this normalized box. */
  region?: { x0: number; y0: number; x1: number; y1: number } | null
}

export interface SymbolMatchResult {
  /**
   * EVERY occurrence found, including the one that was clicked — its own
   * placement matches at a translation of zero, so it falls out of the search
   * naturally.
   *
   * That is deliberate and the caller must not add the click back on top: the
   * exemplar is one of the things being counted, and counting it twice is an
   * off-by-one in a number that ends up on an estimate. It also gives a better
   * point than the raw click, since a match is centred on the symbol's own
   * centroid rather than wherever the mouse happened to land.
   */
  matches: SymbolMatch[]
  /** Segments that made up the exemplar. Under 2 and there was nothing to match. */
  exemplarSegmentCount: number
  /** True when the cap stopped the search — the caller MUST disclose this. */
  truncated: boolean
  /** Bounding box of the exemplar in normalized space, for drawing the outline. */
  exemplarBox: { x0: number; y0: number; x1: number; y1: number } | null
}

/** Default exemplar half-size. Wide enough for a receptacle, tight enough to miss the wall. */
const DEFAULT_RADIUS_PX = 28
/** Placements must reproduce at least this share of the exemplar. */
const DEFAULT_MIN_SCORE = 0.7
const DEFAULT_MAX_MATCHES = 400

/** Length buckets, in image px. Two segments in one bucket are "the same length". */
const LENGTH_BUCKET_PX = 2.5
/** Angle buckets, in degrees, over a 0..180 range. */
const ANGLE_BUCKET_DEG = 6
/** How far a segment midpoint may sit from where the exemplar predicts it. */
const POSITION_TOLERANCE_PX = 3
/** Matches closer than this to an existing one are the same symbol. */
const DEDUPE_RADIUS_PX = 6
/**
 * A symbol built from more segments than this is not a symbol — it is a region
 * of the plan. Matching it would be slow and would find nothing.
 */
const MAX_EXEMPLAR_SEGMENTS = 240
/** Below this an exemplar is a stray tick; there is nothing distinctive to find. */
const MIN_EXEMPLAR_SEGMENTS = 2
/**
 * Anchors more common than this are structure, not symbol detail — chasing every
 * occurrence of a 4px wall tick would scan the whole sheet for nothing.
 */
const MAX_ANCHOR_CANDIDATES = 4000

interface Segment {
  x0: number
  y0: number
  x1: number
  y1: number
  mx: number
  my: number
  key: string
}

function bucketKey(length: number, angleDeg: number): string {
  const lengthBucket = Math.round(length / LENGTH_BUCKET_PX)
  // mod 180: a segment drawn right-to-left is the same segment.
  const normalized = ((angleDeg % 180) + 180) % 180
  const angleBucket = Math.round(normalized / ANGLE_BUCKET_DEG) % Math.round(180 / ANGLE_BUCKET_DEG)
  return `${lengthBucket}:${angleBucket}`
}

function buildSegments(segments: Float32Array, imageSize: ImageSize): Segment[] {
  const out: Segment[] = []
  for (let i = 0; i + 3 < segments.length; i += 4) {
    const x0 = segments[i] * imageSize.width
    const y0 = segments[i + 1] * imageSize.height
    const x1 = segments[i + 2] * imageSize.width
    const y1 = segments[i + 3] * imageSize.height
    const dx = x1 - x0
    const dy = y1 - y0
    const length = Math.hypot(dx, dy)
    if (!(length > 0)) continue
    out.push({
      x0,
      y0,
      x1,
      y1,
      mx: (x0 + x1) / 2,
      my: (y0 + y1) / 2,
      key: bucketKey(length, (Math.atan2(dy, dx) * 180) / Math.PI),
    })
  }
  return out
}

/** Rotating by a right angle permutes the offset and leaves lengths alone. */
function rotateOffset(dx: number, dy: number, rotation: number): { dx: number; dy: number } {
  switch (rotation) {
    case 90:
      return { dx: -dy, dy: dx }
    case 180:
      return { dx: -dx, dy: -dy }
    case 270:
      return { dx: dy, dy: -dx }
    default:
      return { dx, dy }
  }
}

/**
 * A right-angle rotation moves a segment's angle bucket by a fixed amount, so
 * the exemplar's keys can be re-derived without re-measuring anything.
 */
function rotateKey(key: string, rotation: number): string {
  if (rotation === 0 || rotation === 180) return key
  const [lengthBucket, angleBucket] = key.split(":")
  const buckets = Math.round(180 / ANGLE_BUCKET_DEG)
  const rotated = (Number(angleBucket) + buckets / 2) % buckets
  return `${lengthBucket}:${Math.round(rotated)}`
}

/** A uniform grid keyed by cell, so a placement check is local rather than global. */
const GRID_CELL_PX = 32

function cellKey(x: number, y: number): string {
  return `${Math.floor(x / GRID_CELL_PX)}:${Math.floor(y / GRID_CELL_PX)}`
}

/**
 * Find every placement of the symbol around `click`.
 *
 * Returns an empty match list — never null — when the geometry is too sparse to
 * work with. That is the signal to fall through to the vision path, and the
 * caller should say so rather than reporting a count of zero.
 */
export function findSymbolMatches(
  vectorSegments: Float32Array,
  imageSize: ImageSize,
  click: NormPoint,
  options?: SymbolMatchOptions,
): SymbolMatchResult {
  const empty: SymbolMatchResult = {
    matches: [],
    exemplarSegmentCount: 0,
    truncated: false,
    exemplarBox: null,
  }
  if (!(imageSize.width > 0) || !(imageSize.height > 0)) return empty
  if (vectorSegments.length < 8) return empty

  const radius = options?.radiusPx ?? DEFAULT_RADIUS_PX
  const minScore = options?.minScore ?? DEFAULT_MIN_SCORE
  const maxMatches = options?.maxMatches ?? DEFAULT_MAX_MATCHES

  const all = buildSegments(vectorSegments, imageSize)
  if (all.length === 0) return empty

  const clickPx = { x: click.x * imageSize.width, y: click.y * imageSize.height }

  // 1. The exemplar: everything whose midpoint sits in the box around the click.
  const exemplar = all.filter(
    (segment) =>
      Math.abs(segment.mx - clickPx.x) <= radius && Math.abs(segment.my - clickPx.y) <= radius,
  )
  if (exemplar.length < MIN_EXEMPLAR_SEGMENTS || exemplar.length > MAX_EXEMPLAR_SEGMENTS) {
    return { ...empty, exemplarSegmentCount: exemplar.length }
  }

  // Centre on the exemplar's own centroid rather than the click, so two people
  // clicking different corners of the same outlet get the same answer.
  const cx = exemplar.reduce((sum, s) => sum + s.mx, 0) / exemplar.length
  const cy = exemplar.reduce((sum, s) => sum + s.my, 0) / exemplar.length
  const exemplarBox = {
    x0: Math.min(...exemplar.map((s) => Math.min(s.x0, s.x1))) / imageSize.width,
    y0: Math.min(...exemplar.map((s) => Math.min(s.y0, s.y1))) / imageSize.height,
    x1: Math.max(...exemplar.map((s) => Math.max(s.x0, s.x1))) / imageSize.width,
    y1: Math.max(...exemplar.map((s) => Math.max(s.y0, s.y1))) / imageSize.height,
  }

  // Index the sheet once: by bucket key for anchor lookup, by cell for
  // verification.
  const byKey = new Map<string, Segment[]>()
  const byCell = new Map<string, Segment[]>()
  for (const segment of all) {
    const keyed = byKey.get(segment.key)
    if (keyed) keyed.push(segment)
    else byKey.set(segment.key, [segment])

    const cell = cellKey(segment.mx, segment.my)
    const celled = byCell.get(cell)
    if (celled) celled.push(segment)
    else byCell.set(cell, [segment])
  }

  const region = options?.region ?? null
  const inRegion = (x: number, y: number) => {
    if (!region) return true
    const nx = x / imageSize.width
    const ny = y / imageSize.height
    return (
      nx >= Math.min(region.x0, region.x1) &&
      nx <= Math.max(region.x0, region.x1) &&
      ny >= Math.min(region.y0, region.y1) &&
      ny <= Math.max(region.y0, region.y1)
    )
  }

  const found: SymbolMatch[] = []
  let truncated = false

  for (const rotation of [0, 90, 180, 270] as const) {
    if (truncated) break

    // The exemplar as offsets from its centroid, rotated.
    const offsets = exemplar.map((segment) => {
      const rotated = rotateOffset(segment.mx - cx, segment.my - cy, rotation)
      return { ...rotated, key: rotateKey(segment.key, rotation) }
    })

    // 2. The rarest segment. Every genuine occurrence contains one, so its
    // occurrences are a complete candidate list — and a short one.
    let anchor = offsets[0]
    let anchorCount = Number.POSITIVE_INFINITY
    for (const offset of offsets) {
      const count = byKey.get(offset.key)?.length ?? 0
      if (count > 0 && count < anchorCount) {
        anchorCount = count
        anchor = offset
      }
    }
    if (anchorCount === Number.POSITIVE_INFINITY) continue
    if (anchorCount > MAX_ANCHOR_CANDIDATES) continue

    const required = Math.max(MIN_EXEMPLAR_SEGMENTS, Math.ceil(offsets.length * minScore))

    for (const candidate of byKey.get(anchor.key) ?? []) {
      // 3. Where the symbol's centre would be if this segment were the anchor.
      const centreX = candidate.mx - anchor.dx
      const centreY = candidate.my - anchor.dy
      if (!inRegion(centreX, centreY)) continue

      // 4. How much of the rest actually shows up there.
      let hits = 0
      let remaining = offsets.length
      for (const offset of offsets) {
        remaining -= 1
        const targetX = centreX + offset.dx
        const targetY = centreY + offset.dy
        if (hasSegmentNear(byCell, targetX, targetY, offset.key)) hits += 1
        // Bail as soon as a pass is arithmetically out of reach.
        else if (hits + remaining < required) break
      }
      if (hits < required) continue

      const point = { x: centreX / imageSize.width, y: centreY / imageSize.height }
      if (isDuplicate(found, point, imageSize)) continue

      found.push({ point, score: hits / offsets.length, rotation })
      if (found.length >= maxMatches) {
        truncated = true
        break
      }
    }
  }

  // Best first, so a user trimming false positives works from the bottom up.
  found.sort((a, b) => b.score - a.score)

  return {
    matches: found,
    exemplarSegmentCount: exemplar.length,
    truncated,
    exemplarBox,
  }
}

function hasSegmentNear(
  byCell: Map<string, Segment[]>,
  x: number,
  y: number,
  key: string,
): boolean {
  const cellX = Math.floor(x / GRID_CELL_PX)
  const cellY = Math.floor(y / GRID_CELL_PX)
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const bucket = byCell.get(`${cellX + dx}:${cellY + dy}`)
      if (!bucket) continue
      for (const segment of bucket) {
        if (segment.key !== key) continue
        if (
          Math.abs(segment.mx - x) <= POSITION_TOLERANCE_PX &&
          Math.abs(segment.my - y) <= POSITION_TOLERANCE_PX
        ) {
          return true
        }
      }
    }
  }
  return false
}

function isDuplicate(
  found: SymbolMatch[],
  point: NormPoint,
  imageSize: ImageSize,
): boolean {
  for (const match of found) {
    const dx = (match.point.x - point.x) * imageSize.width
    const dy = (match.point.y - point.y) * imageSize.height
    if (Math.hypot(dx, dy) <= DEDUPE_RADIUS_PX) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Text disambiguation
// ---------------------------------------------------------------------------

export interface LabelledPoint {
  x: number
  y: number
  text: string
}

/**
 * MEP symbols are composites, and the geometry is the smaller half of what
 * distinguishes them. A GFCI receptacle is a duplex symbol plus a "GFI" tag; a
 * three-way switch is the same S with a subscript. Matching linework alone will
 * happily merge all of them into one count, which reads as a working feature
 * right up until the electrician prices it.
 *
 * So a match whose nearby text differs from the exemplar's is demoted rather
 * than dropped: the estimator sees "12 matches, 3 with different labels" and
 * decides. Dropping them silently would hide exactly the thing they need to see.
 */
export function partitionByNearbyText(
  matches: SymbolMatch[],
  exemplar: NormPoint,
  labels: LabelledPoint[],
  imageSize: ImageSize,
  radiusPx = 34,
): { confirmed: SymbolMatch[]; differentLabel: SymbolMatch[] } {
  if (labels.length === 0) return { confirmed: matches, differentLabel: [] }

  const exemplarTags = tagsNear(exemplar, labels, imageSize, radiusPx)
  const confirmed: SymbolMatch[] = []
  const differentLabel: SymbolMatch[] = []

  for (const match of matches) {
    const tags = tagsNear(match.point, labels, imageSize, radiusPx)
    if (sameTags(exemplarTags, tags)) confirmed.push(match)
    else differentLabel.push(match)
  }
  return { confirmed, differentLabel }
}

function tagsNear(
  point: NormPoint,
  labels: LabelledPoint[],
  imageSize: ImageSize,
  radiusPx: number,
): Set<string> {
  const tags = new Set<string>()
  for (const label of labels) {
    const dx = (label.x - point.x) * imageSize.width
    const dy = (label.y - point.y) * imageSize.height
    if (Math.hypot(dx, dy) > radiusPx) continue
    const cleaned = label.text.trim().toUpperCase()
    // Bare dimensions and long sentences are page furniture, not symbol tags.
    if (!cleaned || cleaned.length > 12) continue
    tags.add(cleaned)
  }
  return tags
}

function sameTags(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const tag of a) {
    if (!b.has(tag)) return false
  }
  return true
}
