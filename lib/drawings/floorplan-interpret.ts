/**
 * Floorplan interpretation: PDF linework → a walkable model.
 *
 * The drawings pipeline already writes every stroked and filled path of a
 * sheet into `vectors.bin`, co-registered with the sheet's calibration, and
 * (since VECTOR_EXTRACT_ALGO 4) every text line's position into
 * `text-runs.json`. This module reads that exhaust and answers the questions a
 * 3D model needs: where are the walls, where are the holes in them, what
 * encloses a room, and what is that room called.
 *
 * Everything is expressed in REAL-WORLD FEET from the first step. A drafting
 * convention is a physical fact — a stud wall is 3½" to 12" thick, a door is
 * 2' to 3½' wide, a window sits 2½' off the floor — and those facts only
 * discriminate once page units are behind us. The tolerances below are all
 * building tolerances, which is why they transfer across drafting styles and
 * render DPIs.
 *
 * LOW CONFIDENCE IS A VALID RESULT. Every element carries its own score and
 * the review UI exists to fix what geometry could not settle; a wrong wall a
 * human deletes in two seconds beats a missing wall nobody can see.
 *
 * Pure and client-safe: no imports beyond sibling geometry types, no DOM, no
 * database, no MuPDF. Unit-tested in tests/floorplan-interpret.test.js.
 */

import {
  DEFAULT_CEILING_HEIGHT_FT,
  DEFAULT_WALL_THICKNESS_FT,
  extractRoomPolygons,
  levelConfidence,
  openingProfile,
  pointInPolygon,
  polygonArea,
  FLOORPLAN_MODEL_VERSION,
  type FloorplanModel,
  type FloorplanSource,
  type Level,
  type OpeningKind,
  type Room,
  type Wall,
} from "@/lib/drawings/floorplan-model"
import { textRunCenter, type TextRun } from "@/lib/drawings/text-runs"

// ---------------------------------------------------------------------------
// Building tolerances (feet unless noted)
// ---------------------------------------------------------------------------

/** Shorter than 6" and it is a hatch tick, an arrowhead, or text outline. */
const MIN_SEGMENT_FT = 0.5
/** Interior partitions start at 3½"; anything over 14" is a chase or a pour. */
const MIN_WALL_THICKNESS_FT = 0.25
const MAX_WALL_THICKNESS_FT = 1.2
/** Two wall faces must run alongside each other for at least this far. */
const MIN_PAIR_OVERLAP_FT = 2.5
/** Lines within this angle of the sheet's dominant grid snap onto it. */
const AXIS_SNAP_RAD = (2 * Math.PI) / 180
/** Collinear pieces closer than this along their line are one line. */
const COLLINEAR_JOIN_GAP_FT = 0.35
/** Perpendicular spread within which two lines are the same line. */
const COLLINEAR_OFFSET_FT = 0.12
/** Wall ends this close to another wall snap onto it (T and L junctions). */
const JUNCTION_SNAP_FT = 0.9
/** A gap in a wall run between these is a doorway, window, or cased opening. */
const MIN_OPENING_FT = 1.5
const MAX_OPENING_FT = 20
/** Door leaves run 2'0" to 3'6"; wider gaps need other evidence to be doors. */
const TYPICAL_DOOR_MIN_FT = 1.9
const TYPICAL_DOOR_MAX_FT = 3.6
/** Beyond this a gap is an opening between spaces, never a hung door. */
const CASED_MIN_FT = 7
/** No hung door is wider than this, whatever the linework suggests. */
const MAX_DOOR_FT = 4.2
/** A window wider than this is a storefront or a mis-read; leave it cased. */
const MAX_WINDOW_FT = 12
/** A wall run shorter than this is casework, a callout, or a schedule cell. */
const MIN_WALL_RUN_FT = 2
/** Keep any structure at least this share of the biggest one's total length. */
const COMPONENT_KEEP_RATIO = 0.25
/** Segments this short can belong to a sampled curve (arcs come in 8 chords). */
const ARC_CHORD_MAX_FT = 1.6
/** A door swing turns a quarter circle; allow generous drafting slop. */
const ARC_MIN_TURN_RAD = (50 * Math.PI) / 180
const ARC_MAX_TURN_RAD = (115 * Math.PI) / 180
const ARC_MIN_CHORDS = 4
/** Working set cap. Real sheets land far under this; malformed ones do not. */
const MAX_WORKING_LINES = 24_000
/** Two collinear open wall ends this far apart can be bridged shut. */
const MAX_COLLINEAR_BRIDGE_FT = 14
/** An open end extends up to this far to meet the wall it was headed for. */
const MAX_CORNER_EXTEND_FT = 5
/** Confidence of an inferred bridge — low enough that the review UI flags it. */
const BRIDGE_CONFIDENCE = 0.3

// vectors.bin v2 attribute flags.
const FLAG_DASHED = 1
const FLAG_FILLED = 2

// ---------------------------------------------------------------------------
// Room-name lexicon
// ---------------------------------------------------------------------------

/**
 * Words that make a text run a room name.
 *
 * Deliberately a lexicon and not a model call: a floorplan sheet is dense with
 * text — dimension strings, keynotes, schedules, north arrows — and the only
 * runs that matter are the fifteen or so that name spaces. Matching against
 * known nouns is exact, free, and testable, and an unmatched room simply ends
 * up unlabelled for a human to name.
 */
export const ROOM_NAME_LEXICON: readonly string[] = [
  "ATTIC", "BALCONY", "BAR", "BASEMENT", "BATH", "BATHROOM", "BEDROOM", "BONUS", "BREAKFAST",
  "CABANA", "CLOSET", "COURTYARD", "COVERED", "DECK", "DEN", "DINETTE", "DINING", "ENTRY",
  "EXERCISE", "FAMILY", "FLEX", "FOYER", "GALLERY", "GAME", "GARAGE", "GREAT", "GUEST", "GYM",
  "HALL", "KITCHEN", "LANAI", "LAUNDRY", "LIBRARY", "LIVING", "LOFT", "MASTER", "MECH",
  "MECHANICAL", "MEDIA", "MUD", "MUDROOM", "NOOK", "NURSERY", "OFFICE", "OWNER", "PANTRY",
  "PATIO", "PLAYROOM", "PORCH", "POWDER", "PRIMARY", "SITTING", "STAIR", "STORAGE", "STUDY",
  "SUITE", "SUNROOM", "TERRACE", "THEATER", "UTILITY", "VESTIBULE", "WIC", "WORKSHOP",
] as const

const LEXICON_SET = new Set(ROOM_NAME_LEXICON)

/** Dimension strings, scale notes, and keynotes are never room names. */
const DIMENSION_PATTERN = /\d+\s*['’]\s*-?\s*\d*\s*(?:["”]|$)/
const SCALE_PATTERN = /scale|=\s*1['’]|n\.?t\.?s\.?/i
const KEYNOTE_PATTERN = /^[A-Z]?\d+(\.\d+)?$/

/**
 * Does this text run name a room? Returns the cleaned label, or null.
 *
 * Room tags carry their size on the same or the next line ("BEDROOM 2
 * 12'-0" × 11'-6""), so a trailing dimension is stripped rather than
 * disqualifying — but a run that is ONLY a dimension is rejected outright.
 */
export function roomLabelFromText(raw: string): string | null {
  const text = raw.replace(/\s+/g, " ").trim()
  if (!text || text.length > 40) return null
  if (SCALE_PATTERN.test(text)) return null
  if (KEYNOTE_PATTERN.test(text)) return null

  const cleaned = text
    .replace(/\s*\d+\s*['’]\s*-?\s*\d*\s*["”]?\s*[x×]\s*\d+\s*['’]\s*-?\s*\d*\s*["”]?\s*$/i, "")
    .replace(/[.,:;]+$/, "")
    .trim()
  if (!cleaned) return null
  if (DIMENSION_PATTERN.test(cleaned)) return null

  const words = cleaned.toUpperCase().split(/[^A-Z]+/).filter(Boolean)
  if (words.length === 0 || words.length > 4) return null
  const matched = words.some((word) => LEXICON_SET.has(word) || (word.length > 3 && LEXICON_SET.has(word.slice(0, -1))))
  if (!matched) return null
  return cleaned.slice(0, 40)
}

// ---------------------------------------------------------------------------
// Working geometry
// ---------------------------------------------------------------------------

interface Line {
  x0: number
  y0: number
  x1: number
  y1: number
  /** Unit direction, normalized into the upper half-plane. */
  ux: number
  uy: number
  /** Signed perpendicular offset of the line from the origin. */
  offset: number
  /** Projections of the endpoints onto the direction. */
  start: number
  end: number
  angleBucket: number
  filled: boolean
}

export interface InterpretLevelInput {
  sheetVersionId: string
  sheetNumber: string | null
  sheetTitle: string | null
  name: string
  order: number
  imageWidth: number
  imageHeight: number
  /** Real-world feet per rendered-image pixel; required and must be > 0. */
  feetPerImagePx: number
  /** Flat normalized [x0, y0, x1, y1, ...] exactly as `vectors.bin` stores it. */
  segments: ArrayLike<number>
  /** Per-segment attribute flags from vectors.bin v2, or null for v1. */
  flags: ArrayLike<number> | null
  textRuns: TextRun[]
  ceilingHeightFt?: number
}

/** Angle buckets are 1° wide; a wall pair must share one (or a neighbour). */
function angleBucketOf(angle: number): number {
  return Math.round((angle * 180) / Math.PI)
}

function makeLine(x0: number, y0: number, x1: number, y1: number, filled: boolean): Line | null {
  let dx = x1 - x0
  let dy = y1 - y0
  const length = Math.hypot(dx, dy)
  if (!(length >= MIN_SEGMENT_FT)) return null
  let ux = dx / length
  let uy = dy / length
  // Direction-agnostic: every line is normalized into the same half-plane so
  // a wall drawn left-to-right pairs with its face drawn right-to-left.
  if (ux < 0 || (Math.abs(ux) < 1e-9 && uy < 0)) {
    ux = -ux
    uy = -uy
    dx = -dx
    dy = -dy
  }
  const nx = -uy
  const ny = ux
  const offset = x0 * nx + y0 * ny
  const p0 = x0 * ux + y0 * uy
  const p1 = x1 * ux + y1 * uy
  return {
    x0,
    y0,
    x1,
    y1,
    ux,
    uy,
    offset,
    start: Math.min(p0, p1),
    end: Math.max(p0, p1),
    angleBucket: angleBucketOf(Math.atan2(uy, ux)),
    filled,
  }
}

/**
 * The sheet's own drafting grid.
 *
 * Almost every plan is drawn on one orthogonal grid, but it is not always the
 * page's grid — a lot-fitted plan can be drawn at 14°, and a plan rotated on
 * the sheet certainly is. Finding the dominant direction by total line length
 * (mod 90°, since the grid's two axes are equivalent) lets the snap below
 * straighten a rotated plan exactly as well as an axis-aligned one.
 */
export function dominantGridAngle(lines: Line[]): number {
  const BUCKETS = 900 // 0.1° resolution over the 90° period
  const weight = new Float64Array(BUCKETS)
  for (const line of lines) {
    const length = line.end - line.start
    const angle = Math.atan2(line.uy, line.ux)
    const wrapped = ((angle % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2)
    const bucket = Math.min(BUCKETS - 1, Math.floor((wrapped / (Math.PI / 2)) * BUCKETS))
    weight[bucket] += length
  }
  let best = 0
  let bestScore = -1
  for (let i = 0; i < BUCKETS; i++) {
    // Smooth over ±0.3° so drafting jitter does not split the peak.
    let score = 0
    for (let k = -3; k <= 3; k++) score += weight[(i + k + BUCKETS) % BUCKETS]
    if (score > bestScore) {
      bestScore = score
      best = i
    }
  }
  return ((best + 0.5) / BUCKETS) * (Math.PI / 2)
}

/** Rotate a line onto the nearest grid axis when it is already within 2°. */
function snapToGrid(line: Line, gridAngle: number): Line {
  const angle = Math.atan2(line.uy, line.ux)
  const relative = angle - gridAngle
  const steps = Math.round(relative / (Math.PI / 2))
  const target = gridAngle + steps * (Math.PI / 2)
  let delta = angle - target
  while (delta > Math.PI / 2) delta -= Math.PI
  while (delta < -Math.PI / 2) delta += Math.PI
  if (Math.abs(delta) > AXIS_SNAP_RAD) return line

  // Rotate about the midpoint so the line keeps its position and length.
  const mx = (line.x0 + line.x1) / 2
  const my = (line.y0 + line.y1) / 2
  const half = (line.end - line.start) / 2
  const ux = Math.cos(target)
  const uy = Math.sin(target)
  const snapped = makeLine(mx - ux * half, my - uy * half, mx + ux * half, my + uy * half, line.filled)
  return snapped ?? line
}

/**
 * Fuse collinear pieces into whole lines.
 *
 * `encodeVectors` already merges end-to-end runs at extraction, but that pass
 * works in page units before the grid is known; after snapping, pieces that
 * were 0.3° apart are exactly collinear and can finally join. Bucketing by
 * (angle, perpendicular offset) keeps it near-linear on six-figure exports.
 */
function fuseCollinear(lines: Line[]): Line[] {
  const groups = new Map<string, Line[]>()
  for (const line of lines) {
    const key = `${line.angleBucket}:${Math.round(line.offset / COLLINEAR_OFFSET_FT)}`
    const group = groups.get(key)
    if (group) group.push(line)
    else groups.set(key, [line])
  }

  const fused: Line[] = []
  for (const group of groups.values()) {
    group.sort((a, b) => a.start - b.start)
    let current = group[0]
    for (let i = 1; i < group.length; i++) {
      const next = group[i]
      if (next.start <= current.end + COLLINEAR_JOIN_GAP_FT) {
        if (next.end > current.end) {
          // Rebuilt from projections, not raw endpoints: the two pieces may
          // have been drawn in opposite directions.
          current = rebuildFromProjection(current, current.start, next.end)
        }
        continue
      }
      fused.push(current)
      current = next
    }
    fused.push(current)
  }
  return fused
}

/** Rebuild a line spanning [start, end] on its own infinite line. */
function rebuildFromProjection(line: Line, start: number, end: number): Line {
  const nx = -line.uy
  const ny = line.ux
  const baseX = nx * line.offset
  const baseY = ny * line.offset
  const rebuilt = makeLine(
    baseX + line.ux * start,
    baseY + line.uy * start,
    baseX + line.ux * end,
    baseY + line.uy * end,
    line.filled,
  )
  return rebuilt ?? line
}

// ---------------------------------------------------------------------------
// Step 1 — wall candidates from parallel face pairs
// ---------------------------------------------------------------------------

interface WallCandidate {
  ux: number
  uy: number
  offset: number
  start: number
  end: number
  thicknessFt: number
  angleBucket: number
  confidence: number
  source: "paired" | "single"
}

/**
 * A wall is two parallel lines a stud-thickness apart.
 *
 * That is the whole idea, and it is what makes this tractable: a plan is full
 * of long lines — dimension strings, property lines, hatch boundaries, roof
 * overhangs — and the only ones that are walls come in PAIRS at a plausible
 * thickness with a real overlap. Filled wall pours satisfy this too, because a
 * filled rectangle emits its two long edges as exactly such a pair.
 */
function pairWalls(lines: Line[]): { candidates: WallCandidate[]; consumedLines: number } {
  const byBucket = new Map<number, Line[]>()
  for (const line of lines) {
    const group = byBucket.get(line.angleBucket)
    if (group) group.push(line)
    else byBucket.set(line.angleBucket, [line])
  }

  const candidates: WallCandidate[] = []
  const paired = new Set<Line>()

  for (const [bucket, group] of byBucket) {
    // A 1° bucket boundary must not separate two faces of the same wall, so
    // each bucket is matched against itself and its immediate neighbours.
    const pool = [...group, ...(byBucket.get(bucket + 1) ?? []), ...(byBucket.get(bucket - 1) ?? [])]
    pool.sort((a, b) => a.offset - b.offset)

    for (let i = 0; i < pool.length; i++) {
      const a = pool[i]
      if (paired.has(a)) continue
      let best: { line: Line; overlap: number; thickness: number; score: number } | null = null

      for (let j = i + 1; j < pool.length; j++) {
        const b = pool[j]
        const thickness = Math.abs(b.offset - a.offset)
        if (thickness < MIN_WALL_THICKNESS_FT) continue
        if (thickness > MAX_WALL_THICKNESS_FT) break // sorted by offset
        if (paired.has(b)) continue

        const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start)
        if (overlap < MIN_PAIR_OVERLAP_FT) continue
        const shorter = Math.min(a.end - a.start, b.end - b.start)
        // Filled faces are wall poché almost by definition, so they may pair
        // on a smaller shared fraction: an L-shaped filled band emits inner
        // and outer edges of very different lengths.
        const bothFilled = a.filled && b.filled
        if (overlap < shorter * (bothFilled ? 0.3 : 0.45)) continue

        // Prefer long shared runs at a common stud thickness (4"–8" covers
        // 2×4 and 2×6 framing with finishes).
        let thicknessScore = thickness >= 0.28 && thickness <= 0.7 ? 1.4 : 1
        if (bothFilled) thicknessScore *= 1.15
        const score = overlap * thicknessScore
        if (!best || score > best.score) best = { line: b, overlap, thickness, score }
      }

      if (!best) continue
      paired.add(a)
      paired.add(best.line)
      const b = best.line
      const start = Math.max(a.start, b.start)
      const end = Math.min(a.end, b.end)
      const shorter = Math.min(a.end - a.start, b.end - b.start)
      candidates.push({
        ux: a.ux,
        uy: a.uy,
        offset: (a.offset + b.offset) / 2,
        start,
        end,
        thicknessFt: best.thickness,
        angleBucket: a.angleBucket,
        // Confidence rises with how completely the two faces track each other
        // and how ordinary the resulting thickness is.
        confidence: clamp(
          0.55 + 0.35 * (best.overlap / Math.max(shorter, 0.01)) + (best.thickness <= 0.75 ? 0.1 : 0),
          0.5,
          0.98,
        ),
        source: "paired",
      })
    }
  }
  return { candidates, consumedLines: paired.size }
}

/**
 * Schematic plans — marketing floorplans, early concept sheets — draw walls as
 * single lines, and pairing finds nothing on them.
 *
 * The trigger is the SHARE of long lines that paired, not their count. A small
 * but properly drafted plan can produce only a handful of pairs while still
 * being double-line drafting; what actually distinguishes a single-line sheet
 * is that almost none of its long linework has a partner. Getting this wrong
 * in the other direction would bury real walls under every dimension string on
 * the sheet.
 */
function singleLineWalls(lines: Line[], consumedLines: number): WallCandidate[] {
  const long = lines.filter((line) => line.end - line.start >= 3)
  if (long.length < 8 || long.length > 600) return []
  if (consumedLines >= long.length * 0.25) return []
  return long.map((line) => ({
    ux: line.ux,
    uy: line.uy,
    offset: line.offset,
    start: line.start,
    end: line.end,
    thicknessFt: DEFAULT_WALL_THICKNESS_FT,
    angleBucket: line.angleBucket,
    confidence: 0.4,
    source: "single" as const,
  }))
}

/** Fuse wall candidates that describe the same centerline. */
function fuseCandidates(candidates: WallCandidate[]): WallCandidate[] {
  const groups = new Map<string, WallCandidate[]>()
  for (const candidate of candidates) {
    const key = `${candidate.angleBucket}:${Math.round(candidate.offset / 0.25)}`
    const group = groups.get(key)
    if (group) group.push(candidate)
    else groups.set(key, [candidate])
  }
  const fused: WallCandidate[] = []
  for (const group of groups.values()) {
    group.sort((a, b) => a.start - b.start)
    let current = { ...group[0] }
    for (let i = 1; i < group.length; i++) {
      const next = group[i]
      if (next.start <= current.end + 0.1 && Math.abs(next.thicknessFt - current.thicknessFt) < 0.25) {
        current.end = Math.max(current.end, next.end)
        current.confidence = Math.max(current.confidence, next.confidence)
        continue
      }
      fused.push(current)
      current = { ...next }
    }
    fused.push(current)
  }
  return fused
}

// ---------------------------------------------------------------------------
// Step 2 — openings: the gaps between collinear wall runs
// ---------------------------------------------------------------------------

interface ArcSignature {
  cx: number
  cy: number
  radius: number
}

/**
 * Find door-swing arcs.
 *
 * `walkPageSegments` flattens every curve into 8 chords, so a quarter-circle
 * swing arrives as a short chain that turns consistently in one direction. A
 * chain that turns roughly 90° in total, whose points sit on a common circle,
 * is a door: its centre is the hinge and its radius is the leaf width.
 */
export function detectDoorArcs(chords: Array<{ x0: number; y0: number; x1: number; y1: number }>): ArcSignature[] {
  const QUANT = 0.05
  const key = (x: number, y: number) => `${Math.round(x / QUANT)}:${Math.round(y / QUANT)}`

  const byStart = new Map<string, number[]>()
  for (let i = 0; i < chords.length; i++) {
    const k = key(chords[i].x0, chords[i].y0)
    const list = byStart.get(k)
    if (list) list.push(i)
    else byStart.set(k, [i])
  }

  const used = new Uint8Array(chords.length)
  const arcs: ArcSignature[] = []

  for (let seed = 0; seed < chords.length; seed++) {
    if (used[seed]) continue
    const chain = [seed]
    used[seed] = 1
    let cursor = seed
    let totalTurn = 0
    let turnSign = 0

    for (;;) {
      const current = chords[cursor]
      const candidates = byStart.get(key(current.x1, current.y1)) ?? []
      let advanced = false
      for (const next of candidates) {
        if (used[next]) continue
        const a = chords[cursor]
        const b = chords[next]
        const turn = angleBetween(a.x1 - a.x0, a.y1 - a.y0, b.x1 - b.x0, b.y1 - b.y0)
        if (Math.abs(turn) < 1e-4 || Math.abs(turn) > (35 * Math.PI) / 180) continue
        const sign = Math.sign(turn)
        if (turnSign !== 0 && sign !== turnSign) continue
        turnSign = sign
        totalTurn += Math.abs(turn)
        used[next] = 1
        chain.push(next)
        cursor = next
        advanced = true
        break
      }
      if (!advanced) break
      if (totalTurn > ARC_MAX_TURN_RAD) break
    }

    if (chain.length < ARC_MIN_CHORDS) continue
    if (totalTurn < ARC_MIN_TURN_RAD || totalTurn > ARC_MAX_TURN_RAD) continue

    const points: Array<[number, number]> = [[chords[chain[0]].x0, chords[chain[0]].y0]]
    for (const index of chain) points.push([chords[index].x1, chords[index].y1])
    const circle = fitCircle(points)
    if (!circle) continue
    if (circle.radius < TYPICAL_DOOR_MIN_FT * 0.8 || circle.radius > 6) continue
    arcs.push(circle)
  }
  return arcs
}

/** Signed turn from vector a to vector b, in (-π, π]. */
function angleBetween(ax: number, ay: number, bx: number, by: number): number {
  return Math.atan2(ax * by - ay * bx, ax * bx + ay * by)
}

/**
 * Least-squares circle through sampled arc points (Kåsa's linearization).
 *
 * Returns null when the points are collinear or the residual is too large to
 * be a circle — a polyline corner must never read as a door swing.
 */
function fitCircle(points: Array<[number, number]>): ArcSignature | null {
  const n = points.length
  if (n < 3) return null
  let sx = 0
  let sy = 0
  for (const [x, y] of points) {
    sx += x
    sy += y
  }
  const mx = sx / n
  const my = sy / n

  let suu = 0
  let suv = 0
  let svv = 0
  let suuu = 0
  let svvv = 0
  let suvv = 0
  let svuu = 0
  for (const [x, y] of points) {
    const u = x - mx
    const v = y - my
    suu += u * u
    svv += v * v
    suv += u * v
    suuu += u * u * u
    svvv += v * v * v
    suvv += u * v * v
    svuu += v * u * u
  }
  const det = suu * svv - suv * suv
  if (Math.abs(det) < 1e-9) return null
  const c1 = (suuu + suvv) / 2
  const c2 = (svvv + svuu) / 2
  const uc = (c1 * svv - c2 * suv) / det
  const vc = (c2 * suu - c1 * suv) / det
  const radius = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n)
  if (!Number.isFinite(radius) || radius <= 0) return null

  const cx = uc + mx
  const cy = vc + my
  let residual = 0
  for (const [x, y] of points) residual += Math.abs(Math.hypot(x - cx, y - cy) - radius)
  if (residual / n > radius * 0.08) return null
  return { cx, cy, radius }
}

interface OpeningSpan {
  wallIndex: number
  offsetFt: number
  widthFt: number
  kind: OpeningKind
  confidence: number
}

/**
 * Classify a gap between two collinear wall runs.
 *
 * The evidence, strongest first: a door-swing arc hinged at the gap; glazing
 * lines drawn along the opening (a window's two or three thin parallel lines);
 * then width alone, because a 2'8" hole in a wall is a door far more often
 * than it is anything else.
 */
function classifyOpening(
  gapMidX: number,
  gapMidY: number,
  widthFt: number,
  jambs: Array<[number, number]>,
  arcs: ArcSignature[],
  glazing: (x: number, y: number, ux: number, uy: number, width: number) => boolean,
  ux: number,
  uy: number,
): { kind: OpeningKind; confidence: number } {
  // A swing arc only certifies a DOOR-SIZED gap. Without this an arc drawn
  // near a 17' opening promoted the whole thing to a door, and the 3D build
  // then punched a 17' hole with a door header across it.
  if (widthFt <= MAX_DOOR_FT) {
    for (const arc of arcs) {
      const nearJamb = jambs.some(([jx, jy]) => Math.hypot(arc.cx - jx, arc.cy - jy) <= 1.2)
      if (!nearJamb) continue
      if (Math.abs(arc.radius - widthFt) > Math.max(0.75, widthFt * 0.4)) continue
      return { kind: "door", confidence: 0.95 }
    }
  }

  if (widthFt <= MAX_WINDOW_FT && glazing(gapMidX, gapMidY, ux, uy, widthFt)) {
    return { kind: "window", confidence: 0.8 }
  }
  if (widthFt >= CASED_MIN_FT) return { kind: "cased", confidence: 0.6 }
  if (widthFt >= TYPICAL_DOOR_MIN_FT && widthFt <= TYPICAL_DOOR_MAX_FT) {
    return { kind: "door", confidence: 0.55 }
  }
  return { kind: "cased", confidence: 0.4 }
}

// ---------------------------------------------------------------------------
// Interpretation
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Interpret one floorplan sheet into one model level.
 *
 * Order matters and each step feeds the next: grid → clean lines → wall pairs
 * → junction closure → openings (which MERGE the runs they sit between) →
 * rooms from the closed graph → labels from positioned text.
 */
export function interpretLevel(input: InterpretLevelInput): Level {
  const feetPerPx = input.feetPerImagePx
  const source: FloorplanSource = {
    sheetVersionId: input.sheetVersionId,
    sheetNumber: input.sheetNumber,
    sheetTitle: input.sheetTitle,
    imageWidth: input.imageWidth,
    imageHeight: input.imageHeight,
    feetPerImagePx: feetPerPx,
    originPxX: 0,
    originPxY: 0,
  }
  const ceilingHeightFt = input.ceilingHeightFt ?? DEFAULT_CEILING_HEIGHT_FT
  const emptyLevel = (): Level => ({
    id: `L${input.order}`,
    name: input.name,
    order: input.order,
    ceilingHeightFt,
    source,
    walls: [],
    openings: [],
    rooms: [],
    confidence: { walls: 0, openings: 0, rooms: 0 },
  })

  if (!(feetPerPx > 0) || !(input.imageWidth > 0) || !(input.imageHeight > 0)) return emptyLevel()
  const segmentCount = Math.floor(input.segments.length / 4)
  if (segmentCount === 0) return emptyLevel()

  // ---- Segments → feet, dropping dashed drafting and sub-6" detail ----
  const lines: Line[] = []
  const chords: Array<{ x0: number; y0: number; x1: number; y1: number }> = []
  const scaleX = input.imageWidth * feetPerPx
  const scaleY = input.imageHeight * feetPerPx
  for (let i = 0; i < segmentCount; i++) {
    const flag = input.flags ? input.flags[i] : 0
    const x0 = input.segments[i * 4] * scaleX
    const y0 = input.segments[i * 4 + 1] * scaleY
    const x1 = input.segments[i * 4 + 2] * scaleX
    const y1 = input.segments[i * 4 + 3] * scaleY
    const length = Math.hypot(x1 - x0, y1 - y0)
    // Arc chords are shorter than the wall filter allows, so they are gathered
    // before it — a door swing is only ever built from sub-foot pieces.
    if (length > 0.02 && length <= ARC_CHORD_MAX_FT) chords.push({ x0, y0, x1, y1 })
    if ((flag & FLAG_DASHED) !== 0) continue
    const line = makeLine(x0, y0, x1, y1, (flag & FLAG_FILLED) !== 0)
    if (line) lines.push(line)
  }
  if (lines.length === 0) return emptyLevel()

  const working = lines.length > MAX_WORKING_LINES
    ? [...lines].sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, MAX_WORKING_LINES)
    : lines

  const gridAngle = dominantGridAngle(working)
  const straightened = fuseCollinear(working.map((line) => snapToGrid(line, gridAngle)))

  // ---- Walls ----
  const paired = pairWalls(straightened)
  const candidates = fuseCandidates([
    ...paired.candidates,
    ...singleLineWalls(straightened, paired.consumedLines),
  ])
  if (candidates.length === 0) return emptyLevel()

  // ---- Openings: gaps between collinear runs, which then merge ----
  const arcs = detectDoorArcs(chords)
  const glazing = buildGlazingProbe(straightened)
  const { runs, openings } = mergeAcrossOpenings(candidates, arcs, glazing)

  // ---- Junction closure, perimeter bridging, then isolate the building ----
  // Bridging runs BEFORE the component filter: a perimeter break can split a
  // wing into its own component, and the filter would then throw the wing away
  // before the bridge that reconnects it ever existed.
  // Stubs go first (a dangler never connects anything, and must not attract a
  // bridge), then bridges, then the component filter sees the mended graph.
  const { walls: joined, startShiftFt } = closeJunctions(runs)
  const walls = keepBuildingStructures(closePerimeterGaps(dropDanglingStubs(joined)))
  const rooms = buildRooms(walls, input.textRuns, input)

  const wallById = new Map(walls.map((wall) => [wall.id, wall]))
  const level: Level = {
    id: `L${input.order}`,
    name: input.name,
    order: input.order,
    ceilingHeightFt,
    source,
    walls,
    openings: openings
      .map((span, index) => {
        // Junction closure moved wall ends; an opening measured from the old
        // start would slide by up to a foot, which on a 3' door is a hole in
        // the wrong place.
        const wallId = `w${span.wallIndex + 1}`
        const wall = wallById.get(wallId)
        if (!wall) return null
        const offsetFt = span.offsetFt - (startShiftFt.get(wallId) ?? 0)
        const length = Math.hypot(wall.x1 - wall.x0, wall.y1 - wall.y0)
        if (offsetFt < 0 || offsetFt + span.widthFt > length + 0.5) return null
        return {
          id: `o${index + 1}`,
          wallId,
          kind: span.kind,
          offsetFt: round2(Math.max(0, offsetFt)),
          widthFt: round2(span.widthFt),
          ...openingProfile(span.kind),
          confidence: span.confidence,
        }
      })
      .filter((opening): opening is NonNullable<typeof opening> => opening !== null),
    rooms,
    confidence: { walls: 0, openings: 0, rooms: 0 },
  }
  const normalized = recenter(level)
  normalized.confidence = levelConfidence(normalized)
  return normalized
}

/**
 * Probe for the parallel glazing lines drawn inside a window opening.
 *
 * A window is not an empty gap: the drafter fills it with two or three thin
 * lines running the length of the opening. Finding them is what separates a
 * window from a cased opening of the same width.
 */
function buildGlazingProbe(lines: Line[]) {
  const byBucket = new Map<number, Line[]>()
  for (const line of lines) {
    const group = byBucket.get(line.angleBucket)
    if (group) group.push(line)
    else byBucket.set(line.angleBucket, [line])
  }
  return (x: number, y: number, ux: number, uy: number, width: number): boolean => {
    const bucket = angleBucketOf(Math.atan2(uy, ux))
    const nx = -uy
    const ny = ux
    const centerOffset = x * nx + y * ny
    const centerAlong = x * ux + y * uy
    let hits = 0
    for (const delta of [-1, 0, 1]) {
      for (const line of byBucket.get(bucket + delta) ?? []) {
        // Inside the opening: within a wall's depth of the centerline and
        // spanning most of the gap.
        if (Math.abs(line.offset - centerOffset) > MAX_WALL_THICKNESS_FT) continue
        if (line.start > centerAlong - width * 0.2) continue
        if (line.end < centerAlong + width * 0.2) continue
        if (line.end - line.start > width * 1.6) continue
        hits++
        if (hits >= 2) return true
      }
    }
    return false
  }
}

/**
 * Merge collinear runs across their gaps, recording each gap as an opening.
 *
 * This is the step that makes the 3D build simple: after it, a wall is one
 * continuous run carrying a list of holes, which `wallSolidSpans` slices into
 * plain boxes. Doing it the other way round — keeping the runs separate and
 * inferring openings later — loses the fact that the two pieces are one wall.
 */
function mergeAcrossOpenings(
  candidates: WallCandidate[],
  arcs: ArcSignature[],
  glazing: (x: number, y: number, ux: number, uy: number, width: number) => boolean,
): { runs: WallCandidate[]; openings: OpeningSpan[] } {
  const groups = new Map<string, WallCandidate[]>()
  for (const candidate of candidates) {
    const key = `${candidate.angleBucket}:${Math.round(candidate.offset / 0.4)}`
    const group = groups.get(key)
    if (group) group.push(candidate)
    else groups.set(key, [candidate])
  }

  const runs: WallCandidate[] = []
  const openings: OpeningSpan[] = []

  for (const group of groups.values()) {
    group.sort((a, b) => a.start - b.start)
    let current = { ...group[0] }
    let currentOpenings: Array<{ offsetFt: number; widthFt: number; kind: OpeningKind; confidence: number }> = []
    const flush = () => {
      const index = runs.length
      runs.push(current)
      for (const opening of currentOpenings) {
        openings.push({ wallIndex: index, ...opening })
      }
      currentOpenings = []
    }

    for (let i = 1; i < group.length; i++) {
      const next = group[i]
      const gap = next.start - current.end
      const thicknessMatch = Math.abs(next.thicknessFt - current.thicknessFt) <= 0.3
      if (gap >= MIN_OPENING_FT && gap <= MAX_OPENING_FT && thicknessMatch) {
        const nx = -current.uy
        const ny = current.ux
        const baseX = nx * current.offset
        const baseY = ny * current.offset
        const jambA: [number, number] = [baseX + current.ux * current.end, baseY + current.uy * current.end]
        const jambB: [number, number] = [baseX + current.ux * next.start, baseY + current.uy * next.start]
        const midX = (jambA[0] + jambB[0]) / 2
        const midY = (jambA[1] + jambB[1]) / 2
        const classified = classifyOpening(
          midX,
          midY,
          gap,
          [jambA, jambB],
          arcs,
          glazing,
          current.ux,
          current.uy,
        )
        currentOpenings.push({
          offsetFt: current.end - current.start,
          widthFt: gap,
          kind: classified.kind,
          confidence: classified.confidence,
        })
        current = {
          ...current,
          end: next.end,
          confidence: Math.min(current.confidence, next.confidence),
        }
        continue
      }
      if (gap < MIN_OPENING_FT && thicknessMatch) {
        current = { ...current, end: Math.max(current.end, next.end) }
        continue
      }
      flush()
      current = { ...next }
    }
    flush()
  }

  return { runs, openings }
}

/**
 * Snap wall ends onto the walls they nearly touch.
 *
 * Drafters leave hairline gaps at corners and stop partition walls a fraction
 * short of the wall they die into. Face extraction is unforgiving about it:
 * one unclosed corner merges two rooms into one L. Closing gaps under 11" is
 * the single highest-value repair in the whole pipeline.
 */
function closeJunctions(runs: WallCandidate[]): { walls: Wall[]; startShiftFt: Map<string, number> } {
  const walls = runs.map((run, index) => {
    const nx = -run.uy
    const ny = run.ux
    const baseX = nx * run.offset
    const baseY = ny * run.offset
    return {
      id: `w${index + 1}`,
      x0: baseX + run.ux * run.start,
      y0: baseY + run.uy * run.start,
      x1: baseX + run.ux * run.end,
      y1: baseY + run.uy * run.end,
      thicknessFt: Math.round(run.thicknessFt * 1000) / 1000,
      confidence: Math.round(run.confidence * 100) / 100,
      source: run.source,
    } satisfies Wall
  })
  const originalStart = walls.map((wall) => ({ x: wall.x0, y: wall.y0 }))

  // Pass 1 — corner closure: two ends that nearly meet become one point.
  const ends: Array<{ wall: number; which: 0 | 1 }> = []
  for (let i = 0; i < walls.length; i++) ends.push({ wall: i, which: 0 }, { wall: i, which: 1 })
  const pointOf = (end: { wall: number; which: 0 | 1 }): [number, number] =>
    end.which === 0 ? [walls[end.wall].x0, walls[end.wall].y0] : [walls[end.wall].x1, walls[end.wall].y1]
  const setPoint = (end: { wall: number; which: 0 | 1 }, x: number, y: number) => {
    const wall = walls[end.wall]
    if (end.which === 0) {
      wall.x0 = x
      wall.y0 = y
    } else {
      wall.x1 = x
      wall.y1 = y
    }
  }

  const cell = JUNCTION_SNAP_FT
  const grid = new Map<string, number[]>()
  for (let i = 0; i < ends.length; i++) {
    const [x, y] = pointOf(ends[i])
    const key = `${Math.floor(x / cell)}:${Math.floor(y / cell)}`
    const bucket = grid.get(key)
    if (bucket) bucket.push(i)
    else grid.set(key, [i])
  }
  const clusterOf = new Int32Array(ends.length).fill(-1)
  const clusters: number[][] = []
  for (let i = 0; i < ends.length; i++) {
    if (clusterOf[i] !== -1) continue
    const [x, y] = pointOf(ends[i])
    const members = [i]
    clusterOf[i] = clusters.length
    const cx = Math.floor(x / cell)
    const cy = Math.floor(y / cell)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of grid.get(`${cx + dx}:${cy + dy}`) ?? []) {
          if (clusterOf[j] !== -1) continue
          const [jx, jy] = pointOf(ends[j])
          if (Math.hypot(jx - x, jy - y) > JUNCTION_SNAP_FT) continue
          clusterOf[j] = clusters.length
          members.push(j)
        }
      }
    }
    clusters.push(members)
  }
  for (const members of clusters) {
    if (members.length < 2) continue
    let sx = 0
    let sy = 0
    for (const index of members) {
      const [x, y] = pointOf(ends[index])
      sx += x
      sy += y
    }
    const mx = sx / members.length
    const my = sy / members.length
    for (const index of members) setPoint(ends[index], mx, my)
  }

  // Pass 2 — T-junctions: an end that stops just short of another wall's body
  // is extended onto it, so the face walk can turn the corner.
  for (const end of ends) {
    const [x, y] = pointOf(end)
    let best: { x: number; y: number; distance: number } | null = null
    for (let j = 0; j < walls.length; j++) {
      if (j === end.wall) continue
      const other = walls[j]
      const dx = other.x1 - other.x0
      const dy = other.y1 - other.y0
      const lenSq = dx * dx + dy * dy
      if (lenSq < 1e-9) continue
      const t = clamp(((x - other.x0) * dx + (y - other.y0) * dy) / lenSq, 0, 1)
      // Only interior hits: an end near another end was already clustered.
      if (t < 0.02 || t > 0.98) continue
      const px = other.x0 + t * dx
      const py = other.y0 + t * dy
      const distance = Math.hypot(px - x, py - y)
      if (distance > JUNCTION_SNAP_FT) continue
      if (!best || distance < best.distance) best = { x: px, y: py, distance }
    }
    if (best) setPoint(end, best.x, best.y)
  }

  // How far each wall's start slid ALONG its own direction, so openings
  // measured from the old start can be rebased onto the new one.
  const startShiftFt = new Map<string, number>()
  for (let i = 0; i < walls.length; i++) {
    const wall = walls[i]
    const run = runs[i]
    const shift = (wall.x0 - originalStart[i].x) * run.ux + (wall.y0 - originalStart[i].y) * run.uy
    startShiftFt.set(wall.id, shift)
  }

  return {
    walls: walls.filter((wall) => Math.hypot(wall.x1 - wall.x0, wall.y1 - wall.y0) >= MIN_SEGMENT_FT),
    startShiftFt,
  }
}

/**
 * Bridge the gaps interpretation could not see across.
 *
 * A house's envelope is a closed loop — that is not a heuristic, it is what a
 * house IS — yet a hatched pour, a dimension tick through a face, or a jamb
 * drawn over the wall line routinely breaks the perimeter into fragments, and
 * one break costs every room on that side of the plan. This pass adds
 * low-confidence bridge walls (it never moves or edits existing ones, so
 * opening offsets stay valid):
 *
 * - Two collinear open ends facing each other across a gap join up.
 * - An open end aimed at another wall's body extends until it hits it.
 *
 * Every bridge carries `BRIDGE_CONFIDENCE`, under the review UI's attention
 * threshold: an inferred wall must LOOK inferred to the human who checks it.
 */
export function closePerimeterGaps(walls: Wall[]): Wall[] {
  if (walls.length < 2) return walls
  const key = (x: number, y: number) =>
    `${Math.round(x / JUNCTION_SNAP_FT)}:${Math.round(y / JUNCTION_SNAP_FT)}`
  const degree = new Map<string, number>()
  for (const wall of walls) {
    for (const cell of [key(wall.x0, wall.y0), key(wall.x1, wall.y1)]) {
      degree.set(cell, (degree.get(cell) ?? 0) + 1)
    }
  }

  interface OpenEnd {
    wall: Wall
    x: number
    y: number
    /** Unit direction pointing OUT of the wall through this end. */
    ox: number
    oy: number
  }
  const openEnds: OpenEnd[] = []
  for (const wall of walls) {
    const length = Math.hypot(wall.x1 - wall.x0, wall.y1 - wall.y0)
    if (!(length > 0)) continue
    const ux = (wall.x1 - wall.x0) / length
    const uy = (wall.y1 - wall.y0) / length
    if ((degree.get(key(wall.x0, wall.y0)) ?? 0) <= 1) {
      openEnds.push({ wall, x: wall.x0, y: wall.y0, ox: -ux, oy: -uy })
    }
    if ((degree.get(key(wall.x1, wall.y1)) ?? 0) <= 1) {
      openEnds.push({ wall, x: wall.x1, y: wall.y1, ox: ux, oy: uy })
    }
  }
  if (openEnds.length === 0) return walls

  const bridges: Wall[] = []
  const bridged = new Set<OpenEnd>()
  const addBridge = (x0: number, y0: number, x1: number, y1: number, thicknessFt: number) => {
    if (Math.hypot(x1 - x0, y1 - y0) < 0.05) return
    bridges.push({
      id: `wb${bridges.length + 1}`,
      x0,
      y0,
      x1,
      y1,
      thicknessFt: Math.round(thicknessFt * 1000) / 1000,
      confidence: BRIDGE_CONFIDENCE,
      source: "single",
    })
  }

  // Rule 1 — collinear facing ends: a straight run with a bite out of it.
  for (let i = 0; i < openEnds.length; i++) {
    const a = openEnds[i]
    if (bridged.has(a)) continue
    let best: { end: OpenEnd; gap: number } | null = null
    for (let j = i + 1; j < openEnds.length; j++) {
      const b = openEnds[j]
      if (bridged.has(b) || b.wall === a.wall) continue
      const gx = b.x - a.x
      const gy = b.y - a.y
      const gap = Math.hypot(gx, gy)
      if (gap < 0.05 || gap > MAX_COLLINEAR_BRIDGE_FT) continue
      // The two walls run the same way…
      if (Math.abs(a.ox * b.oy - a.oy * b.ox) > Math.sin((4 * Math.PI) / 180)) continue
      // …their open ends face each other…
      if ((a.ox * gx + a.oy * gy) / gap < 0.98) continue
      if ((b.ox * -gx + b.oy * -gy) / gap < 0.98) continue
      // …and the far end sits on this wall's line, not on a parallel one.
      if (Math.abs(a.ox * gy - a.oy * gx) > 0.6) continue
      if (!best || gap < best.gap) best = { end: b, gap }
    }
    if (!best) continue
    bridged.add(a)
    bridged.add(best.end)
    addBridge(a.x, a.y, best.end.x, best.end.y, (a.wall.thicknessFt + best.end.wall.thicknessFt) / 2)
  }

  // Rule 2 — an end aimed at another wall's body: extend until it lands.
  for (const end of openEnds) {
    if (bridged.has(end)) continue
    let best: { x: number; y: number; distance: number } | null = null
    for (const other of walls) {
      if (other === end.wall) continue
      const dx = other.x1 - other.x0
      const dy = other.y1 - other.y0
      const denominator = end.ox * dy - end.oy * dx
      if (Math.abs(denominator) < 1e-6) continue
      // Ray from the open end against the other wall's segment.
      const t = ((other.x0 - end.x) * dy - (other.y0 - end.y) * dx) / denominator
      if (t < 0.05 || t > MAX_CORNER_EXTEND_FT) continue
      const hx = end.x + end.ox * t
      const hy = end.y + end.oy * t
      const lenSq = dx * dx + dy * dy
      const s = ((hx - other.x0) * dx + (hy - other.y0) * dy) / lenSq
      if (s < -0.05 || s > 1.05) continue
      if (!best || t < best.distance) best = { x: hx, y: hy, distance: t }
    }
    if (!best) continue
    bridged.add(end)
    addBridge(end.x, end.y, best.x, best.y, end.wall.thicknessFt)
  }

  return bridges.length > 0 ? [...walls, ...bridges] : walls
}

/**
 * Keep the building; drop the rest of the sheet.
 *
 * A plan sheet is not just a plan. It carries a title block, door and window
 * schedules, detail bubbles, keynote boxes and a border — and at 1/4" = 1'-0"
 * every one of those is drawn with parallel lines a few page-points apart,
 * which in REAL terms is 3"–14": exactly the range a stud wall occupies. The
 * pair detector cannot tell them apart, and should not try.
 *
 * What separates them is connectivity. The house is one large connected run of
 * walls; a schedule table is its own little island, as is the title block. So
 * group walls into connected components and keep only the substantial ones —
 * the biggest, plus anything within `COMPONENT_KEEP_RATIO` of it so a detached
 * garage or a second wing on the same sheet survives.
 */
function keepBuildingStructures(walls: Wall[]): Wall[] {
  if (walls.length === 0) return walls

  const parent = walls.map((_, index) => index)
  const find = (i: number): number => {
    let root = i
    while (parent[root] !== root) root = parent[root]
    while (parent[i] !== root) {
      const next = parent[i]
      parent[i] = root
      i = next
    }
    return root
  }
  const union = (a: number, b: number) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }

  // Connectivity is endpoint-to-SEGMENT, not endpoint-to-endpoint. A partition
  // tees into the middle of the wall it dies against and shares no endpoint
  // with it; testing only endpoints made every interior partition its own
  // island, and the ratio filter then deleted them.
  const bounds = walls.map((wall) => ({
    minX: Math.min(wall.x0, wall.x1) - JUNCTION_SNAP_FT,
    maxX: Math.max(wall.x0, wall.x1) + JUNCTION_SNAP_FT,
    minY: Math.min(wall.y0, wall.y1) - JUNCTION_SNAP_FT,
    maxY: Math.max(wall.y0, wall.y1) + JUNCTION_SNAP_FT,
  }))

  for (let i = 0; i < walls.length; i++) {
    const wall = walls[i]
    for (const [px, py] of [
      [wall.x0, wall.y0],
      [wall.x1, wall.y1],
    ]) {
      for (let j = 0; j < walls.length; j++) {
        if (i === j || find(i) === find(j)) continue
        const box = bounds[j]
        if (px < box.minX || px > box.maxX || py < box.minY || py > box.maxY) continue
        const other = walls[j]
        const dx = other.x1 - other.x0
        const dy = other.y1 - other.y0
        const lenSq = dx * dx + dy * dy
        if (lenSq < 1e-9) continue
        const t = clamp(((px - other.x0) * dx + (py - other.y0) * dy) / lenSq, 0, 1)
        const distance = Math.hypot(other.x0 + t * dx - px, other.y0 + t * dy - py)
        if (distance <= JUNCTION_SNAP_FT) union(i, j)
      }
    }
  }

  const totals = new Map<number, number>()
  for (let i = 0; i < walls.length; i++) {
    const root = find(i)
    const length = Math.hypot(walls[i].x1 - walls[i].x0, walls[i].y1 - walls[i].y0)
    totals.set(root, (totals.get(root) ?? 0) + length)
  }
  const largest = Math.max(...totals.values())
  if (!(largest > 0)) return walls

  return walls.filter((_, index) => (totals.get(find(index)) ?? 0) >= largest * COMPONENT_KEEP_RATIO)
}

/**
 * Drop stubs that enclose nothing.
 *
 * Casework edges, callout leaders and dimension witness lines survive pairing
 * as short runs dangling off one vertex. A real wall of that length is always
 * joined at BOTH ends — it is a jamb return or a closet side.
 */
function dropDanglingStubs(walls: Wall[]): Wall[] {
  const key = (x: number, y: number) =>
    `${Math.round(x / JUNCTION_SNAP_FT)}:${Math.round(y / JUNCTION_SNAP_FT)}`
  const degree = new Map<string, number>()
  for (const wall of walls) {
    for (const cell of [key(wall.x0, wall.y0), key(wall.x1, wall.y1)]) {
      degree.set(cell, (degree.get(cell) ?? 0) + 1)
    }
  }
  return walls.filter((wall) => {
    const length = Math.hypot(wall.x1 - wall.x0, wall.y1 - wall.y0)
    if (length >= MIN_WALL_RUN_FT) return true
    return (degree.get(key(wall.x0, wall.y0)) ?? 0) > 1 && (degree.get(key(wall.x1, wall.y1)) ?? 0) > 1
  })
}

/** Rooms from the closed wall graph, named from the sheet's own text. */
function buildRooms(walls: Wall[], textRuns: TextRun[], input: InterpretLevelInput): Room[] {
  const polygons = extractRoomPolygons(walls)
  const scaleX = input.imageWidth * input.feetPerImagePx
  const scaleY = input.imageHeight * input.feetPerImagePx

  const labels = textRuns
    .map((run) => {
      const label = roomLabelFromText(run.text)
      if (!label) return null
      const center = textRunCenter(run)
      return { label, x: center.x * scaleX, y: center.y * scaleY, size: run.h * scaleY }
    })
    .filter((item): item is { label: string; x: number; y: number; size: number } => item !== null)

  const claimed = new Set<number>()
  return polygons.map((polygon, index) => {
    const area = polygonArea(polygon)
    let chosen: { label: string; size: number } | null = null
    for (let i = 0; i < labels.length; i++) {
      if (claimed.has(i)) continue
      const candidate = labels[i]
      if (!pointInPolygon([candidate.x, candidate.y], polygon)) continue
      // The largest type inside a room is its name; smaller runs are notes.
      if (!chosen || candidate.size > chosen.size) {
        chosen = { label: candidate.label, size: candidate.size }
        claimed.add(i)
      }
    }
    return {
      id: `r${index + 1}`,
      polygon: polygon.map(([x, y]) => [round2(x), round2(y)] as [number, number]),
      label: chosen?.label ?? null,
      areaSqft: Math.round(area),
      confidence: chosen ? 0.85 : 0.5,
    }
  })
}

/**
 * Move the level onto its own origin.
 *
 * Interpretation works in sheet space, where a plan can sit anywhere on a
 * 36×24 sheet. The model is about the house, so its origin is the house's
 * corner — which also keeps the 3D scene centred without the viewer having to
 * know anything about sheets.
 */
function recenter(level: Level): Level {
  let minX = Infinity
  let minY = Infinity
  for (const wall of level.walls) {
    minX = Math.min(minX, wall.x0, wall.x1)
    minY = Math.min(minY, wall.y0, wall.y1)
  }
  for (const room of level.rooms) {
    for (const [x, y] of room.polygon) {
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return level

  const feetPerPx = level.source.feetPerImagePx
  return {
    ...level,
    source: {
      ...level.source,
      // The model origin now sits at (minX, minY) feet from the sheet origin.
      originPxX: minX / feetPerPx,
      originPxY: minY / feetPerPx,
    },
    walls: level.walls.map((wall) => ({
      ...wall,
      x0: round2(wall.x0 - minX),
      y0: round2(wall.y0 - minY),
      x1: round2(wall.x1 - minX),
      y1: round2(wall.y1 - minY),
    })),
    rooms: level.rooms.map((room) => ({
      ...room,
      polygon: room.polygon.map(([x, y]) => [round2(x - minX), round2(y - minY)] as [number, number]),
    })),
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** Interpret a whole plan — one level per floorplan sheet, in sheet order. */
export function interpretFloorplan(inputs: InterpretLevelInput[]): FloorplanModel {
  return {
    version: FLOORPLAN_MODEL_VERSION,
    units: "feet",
    levels: inputs.map((input) => interpretLevel(input)),
    correctionCount: 0,
  }
}

// ---------------------------------------------------------------------------
// Sheet selection
// ---------------------------------------------------------------------------

/** Sheet titles a floorplan goes by. Elevations and sections must not match. */
const FLOORPLAN_TITLE_PATTERN =
  /\b(?:floor\s*plan|first\s*floor|second\s*floor|third\s*floor|main\s*(?:floor|level)|upper\s*(?:floor|level)|lower\s*(?:floor|level)|ground\s*floor|basement\s*plan|loft\s*plan)\b/i
/** Sheets that mention a plan but are never one. */
const NOT_FLOORPLAN_PATTERN =
  /\b(?:roof|foundation|footing|site|plot|plat|electrical|plumbing|mechanical|hvac|framing|truss|reflected\s*ceiling|elevation|section|detail|schedule|landscape|drainage|grading)\b/i

export interface SheetCandidate {
  sheetVersionId: string
  sheetNumber: string | null
  sheetTitle: string | null
  discipline: string | null
  pageIndex: number
  roomSizedLoopCount: number
  hasVectors: boolean
}

export interface SelectedSheet extends SheetCandidate {
  levelName: string
  order: number
  /** Why it was picked — surfaced in the UI so a wrong pick is explicable. */
  reason: string
}

/** Level order implied by a sheet's title, lowest floor first. */
function levelOrderFromTitle(title: string): { order: number; name: string } | null {
  const text = title.toLowerCase()
  if (/basement|lower\s*(?:floor|level)/.test(text)) return { order: -1, name: "Basement" }
  if (/first\s*floor|main\s*(?:floor|level)|ground\s*floor/.test(text)) return { order: 0, name: "First Floor" }
  if (/second\s*floor|upper\s*(?:floor|level)/.test(text)) return { order: 1, name: "Second Floor" }
  if (/third\s*floor/.test(text)) return { order: 2, name: "Third Floor" }
  if (/loft/.test(text)) return { order: 2, name: "Loft" }
  return null
}

/**
 * Pick the floorplan sheets out of a plan set.
 *
 * Two independent signals have to agree: the sheet SAYS it is a floor plan
 * (discipline A, a title that names a floor, and no roof/electrical/elevation
 * word), and it LOOKS like one (the extractor already closed three or more
 * room-sized loops on it). Requiring both is what keeps the reflected ceiling
 * plan and the foundation plan out, and both of those would otherwise produce
 * a plausible, wrong house.
 */
export function selectFloorplanSheets(candidates: SheetCandidate[]): SelectedSheet[] {
  const scored = candidates
    .filter((candidate) => candidate.hasVectors)
    .map((candidate) => {
      const title = `${candidate.sheetNumber ?? ""} ${candidate.sheetTitle ?? ""}`.trim()
      const titled = FLOORPLAN_TITLE_PATTERN.test(title)
      const excluded = NOT_FLOORPLAN_PATTERN.test(title)
      const structural = candidate.roomSizedLoopCount >= 3
      const architectural = (candidate.discipline ?? "").toUpperCase().startsWith("A")
      return { candidate, title, titled, excluded, structural, architectural }
    })
    .filter((entry) => entry.titled && !entry.excluded && entry.structural)

  if (scored.length === 0) return []

  const used = new Set<number>()
  const selected: SelectedSheet[] = []
  for (const entry of scored) {
    const named = levelOrderFromTitle(entry.title)
    let order = named?.order ?? 0
    while (used.has(order)) order++
    used.add(order)
    selected.push({
      ...entry.candidate,
      levelName: named?.name ?? entry.candidate.sheetTitle ?? `Level ${order + 1}`,
      order,
      reason: `${entry.architectural ? "Discipline A, " : ""}title names a floor, ${entry.candidate.roomSizedLoopCount} room-sized loops`,
    })
  }

  return selected
    .sort((a, b) => a.order - b.order || a.pageIndex - b.pageIndex)
    .map((sheet, index) => ({ ...sheet, order: index }))
}
