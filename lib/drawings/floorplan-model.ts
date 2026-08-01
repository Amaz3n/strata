/**
 * The floorplan model: what a 2D plan sheet means in three dimensions.
 *
 * This module owns the SHAPE of an interpreted plan and every pure operation
 * over it — coordinate mapping back to the source sheet, planar face
 * extraction (walls → rooms), wall-run splitting at openings, and the edit
 * reducer the review UI drives. Interpretation itself (segments → walls) lives
 * in `floorplan-interpret.ts`; the 3D mesh build lives in
 * `lib/plans/floorplan-geometry.ts`. Both depend on this; this depends on
 * nothing.
 *
 * Coordinate contract:
 *   - Model coordinates are REAL-WORLD FEET, y-down (the plan's own reading
 *     orientation), origin at the level's bounding-box minimum.
 *   - `Level.source` carries the transform back to the sheet: a model point is
 *     `originPx + feet / feetPerImagePx` in rendered-image pixels, which is
 *     the space `vector-snap` and `measure` already speak. The review overlay
 *     round-trips through `modelToImagePx` / `imagePxToModel`; nothing else
 *     may reimplement it.
 *   - Heights are feet above the level's floor. Y in the model is a PLAN axis,
 *     not elevation — the 3D build maps (x, y) → world (x, z).
 *
 * Client-safe and pure: no imports, no DOM, no database.
 */

export const FLOORPLAN_MODEL_VERSION = 1

/** How a wall entered the model. Drives confidence and the review tint. */
export type WallSource = "paired" | "single" | "manual"

export type OpeningKind = "door" | "window" | "cased"

export const OPENING_KINDS: readonly OpeningKind[] = ["door", "window", "cased"] as const

/** Defaults in feet. Openings carry their own sill/head once classified. */
export const DEFAULT_CEILING_HEIGHT_FT = 9
export const DEFAULT_WALL_THICKNESS_FT = 0.4583 // 5.5" — a 2×6 exterior stud wall
export const DEFAULT_DOOR_HEAD_FT = 6.75
export const DEFAULT_WINDOW_SILL_FT = 2.5
export const DEFAULT_WINDOW_HEAD_FT = 6.75

/** Vertices this close (feet) are the same point everywhere in this module. */
export const VERTEX_EPSILON_FT = 0.12

/** A face smaller than this is a closet detail or a symbol, not a room. */
export const MIN_ROOM_AREA_SQFT = 12
/** A face larger than this is the building footprint, not a room. */
export const MAX_ROOM_AREA_SQFT = 4000

export interface FloorplanSource {
  sheetVersionId: string
  sheetNumber: string | null
  sheetTitle: string | null
  /** Rendered-image dimensions the normalized vector space was built against. */
  imageWidth: number
  imageHeight: number
  /** Real-world feet per rendered-image pixel (the sheet's calibration). */
  feetPerImagePx: number
  /** Image-pixel position of the model origin. */
  originPxX: number
  originPxY: number
}

export interface Wall {
  id: string
  x0: number
  y0: number
  x1: number
  y1: number
  thicknessFt: number
  /** 0..1. Below 0.5 the review overlay tints it for attention. */
  confidence: number
  source: WallSource
}

export interface Opening {
  id: string
  wallId: string
  kind: OpeningKind
  /** Distance along the wall centerline from (x0, y0), in feet. */
  offsetFt: number
  widthFt: number
  /** Feet above the floor. A door sits on it; a window floats. */
  sillFt: number
  headFt: number
  confidence: number
}

export interface Room {
  id: string
  /** Closed ring in model feet; the last point does NOT repeat the first. */
  polygon: Array<[number, number]>
  label: string | null
  areaSqft: number
  confidence: number
}

export interface LevelConfidence {
  walls: number
  openings: number
  rooms: number
}

export interface Level {
  id: string
  name: string
  /** Ground floor is 0; the viewer stacks levels by this. */
  order: number
  ceilingHeightFt: number
  source: FloorplanSource
  walls: Wall[]
  openings: Opening[]
  rooms: Room[]
  confidence: LevelConfidence
}

export interface FloorplanModel {
  version: typeof FLOORPLAN_MODEL_VERSION
  units: "feet"
  levels: Level[]
  /** Human corrections applied since the last interpretation run. */
  correctionCount: number
  /**
   * What the last interpretation could NOT use.
   *
   * A partial result is the dangerous outcome: a two-storey house whose upper
   * sheet had no scale comes back as a perfectly plausible one-storey model,
   * and nothing about the geometry says a floor is missing. These travel with
   * the document so the panel can say so out loud.
   */
  warnings?: string[]
}

// ---------------------------------------------------------------------------
// Coordinate mapping (model feet ↔ the source sheet)
// ---------------------------------------------------------------------------

export interface PxPoint {
  x: number
  y: number
}

/** Model feet → rendered-image pixels on the source sheet. */
export function modelToImagePx(source: FloorplanSource, x: number, y: number): PxPoint {
  const scale = source.feetPerImagePx > 0 ? 1 / source.feetPerImagePx : 1
  return { x: source.originPxX + x * scale, y: source.originPxY + y * scale }
}

/** Rendered-image pixels → model feet. */
export function imagePxToModel(source: FloorplanSource, px: number, py: number): { x: number; y: number } {
  return {
    x: (px - source.originPxX) * source.feetPerImagePx,
    y: (py - source.originPxY) * source.feetPerImagePx,
  }
}

/** Model feet → normalized 0..1 image coordinates (what an SVG overlay wants). */
export function modelToNormalized(source: FloorplanSource, x: number, y: number): PxPoint {
  const px = modelToImagePx(source, x, y)
  return {
    x: source.imageWidth > 0 ? px.x / source.imageWidth : 0,
    y: source.imageHeight > 0 ? px.y / source.imageHeight : 0,
  }
}

/** Normalized 0..1 image coordinates → model feet. */
export function normalizedToModel(source: FloorplanSource, nx: number, ny: number): { x: number; y: number } {
  return imagePxToModel(source, nx * source.imageWidth, ny * source.imageHeight)
}

// ---------------------------------------------------------------------------
// Primitive geometry
// ---------------------------------------------------------------------------

export function wallLengthFt(wall: Wall): number {
  return Math.hypot(wall.x1 - wall.x0, wall.y1 - wall.y0)
}

/** Unit direction along a wall centerline. Degenerate walls report +x. */
export function wallDirection(wall: Wall): { ux: number; uy: number } {
  const length = wallLengthFt(wall)
  if (!(length > 0)) return { ux: 1, uy: 0 }
  return { ux: (wall.x1 - wall.x0) / length, uy: (wall.y1 - wall.y0) / length }
}

/** Shoelace area of a closed ring (implicitly closed; sign preserved). */
export function signedPolygonArea(points: Array<[number, number]>): number {
  if (points.length < 3) return 0
  let twice = 0
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i]
    const [bx, by] = points[(i + 1) % points.length]
    twice += ax * by - bx * ay
  }
  return twice / 2
}

export function polygonArea(points: Array<[number, number]>): number {
  return Math.abs(signedPolygonArea(points))
}

/** Area-weighted centroid; falls back to the vertex mean on a degenerate ring. */
export function polygonCentroid(points: Array<[number, number]>): [number, number] {
  const area = signedPolygonArea(points)
  if (Math.abs(area) < 1e-9) {
    let sx = 0
    let sy = 0
    for (const [x, y] of points) {
      sx += x
      sy += y
    }
    const n = Math.max(1, points.length)
    return [sx / n, sy / n]
  }
  let cx = 0
  let cy = 0
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i]
    const [bx, by] = points[(i + 1) % points.length]
    const cross = ax * by - bx * ay
    cx += (ax + bx) * cross
    cy += (ay + by) * cross
  }
  return [cx / (6 * area), cy / (6 * area)]
}

/** Even-odd point-in-polygon. Points exactly on an edge are unspecified. */
export function pointInPolygon(point: [number, number], polygon: Array<[number, number]>): boolean {
  const [px, py] = point
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    const straddles = yi > py !== yj > py
    if (!straddles) continue
    const x = ((xj - xi) * (py - yi)) / (yj - yi) + xi
    if (px < x) inside = !inside
  }
  return inside
}

export function boundsOf(points: Array<[number, number]>): {
  minX: number
  minY: number
  maxX: number
  maxY: number
} {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of points) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  return { minX, minY, maxX, maxY }
}

export function levelBounds(level: Level): { minX: number; minY: number; maxX: number; maxY: number } {
  const points: Array<[number, number]> = []
  for (const wall of level.walls) {
    points.push([wall.x0, wall.y0], [wall.x1, wall.y1])
  }
  for (const room of level.rooms) points.push(...room.polygon)
  return boundsOf(points)
}

// ---------------------------------------------------------------------------
// Planar face extraction: walls → rooms
// ---------------------------------------------------------------------------

interface HalfEdge {
  from: number
  to: number
  angle: number
  /** Index of the opposite half-edge. */
  twin: number
}

function quantKey(x: number, y: number): string {
  return `${Math.round(x / VERTEX_EPSILON_FT)}:${Math.round(y / VERTEX_EPSILON_FT)}`
}

/**
 * Split every wall centerline at its crossings with the others.
 *
 * Face extraction needs a planar subdivision: two walls that cross must share
 * a vertex, or the traversal walks straight through the junction and reports
 * one enormous face instead of four rooms. T-junctions are already shared
 * (interpretation snaps them); genuine X-crossings are not.
 */
function planarizeWalls(walls: Wall[]): Array<[number, number, number, number]> {
  const cuts: number[][] = walls.map(() => [0, 1])

  for (let i = 0; i < walls.length; i++) {
    const a = walls[i]
    const ax = a.x1 - a.x0
    const ay = a.y1 - a.y0
    for (let j = i + 1; j < walls.length; j++) {
      const b = walls[j]
      const bx = b.x1 - b.x0
      const by = b.y1 - b.y0
      const denom = ax * by - ay * bx
      if (Math.abs(denom) < 1e-9) continue
      const qx = b.x0 - a.x0
      const qy = b.y0 - a.y0
      const t = (qx * by - qy * bx) / denom
      const u = (qx * ay - qy * ax) / denom
      // Interior×interior is an X-crossing; interior×endpoint is a T-junction.
      // BOTH have to become shared vertices — a T left unsplit lets the face
      // walk run straight past the partition and merge two rooms into one.
      const tInterior = t > 1e-6 && t < 1 - 1e-6
      const uInterior = u > 1e-6 && u < 1 - 1e-6
      const tEnd = t >= -1e-6 && t <= 1 + 1e-6
      const uEnd = u >= -1e-6 && u <= 1 + 1e-6
      if (tInterior && uEnd) cuts[i].push(t)
      if (uInterior && tEnd) cuts[j].push(u)
    }
  }

  const edges: Array<[number, number, number, number]> = []
  for (let i = 0; i < walls.length; i++) {
    const wall = walls[i]
    const ts = Array.from(new Set(cuts[i].map((t) => Math.round(t * 1e6) / 1e6))).sort((p, q) => p - q)
    for (let k = 1; k < ts.length; k++) {
      const t0 = ts[k - 1]
      const t1 = ts[k]
      const x0 = wall.x0 + (wall.x1 - wall.x0) * t0
      const y0 = wall.y0 + (wall.y1 - wall.y0) * t0
      const x1 = wall.x0 + (wall.x1 - wall.x0) * t1
      const y1 = wall.y0 + (wall.y1 - wall.y0) * t1
      if (Math.hypot(x1 - x0, y1 - y0) < VERTEX_EPSILON_FT) continue
      edges.push([x0, y0, x1, y1])
    }
  }
  return edges
}

/**
 * Extract the interior faces of the wall graph — the rooms.
 *
 * Standard half-edge face traversal: from each half-edge, the next one is the
 * neighbour immediately clockwise from the reverse direction at the far
 * vertex. That walks every face exactly once. Interior faces all come out with
 * one orientation and each connected component's outer face with the other, so
 * the majority sign identifies the interiors without any area heuristics.
 *
 * Dead-end walls (a stub into a room) are traversed out and back, contributing
 * zero area — they neither create nor destroy a face.
 */
export function extractRoomPolygons(walls: Wall[]): Array<Array<[number, number]>> {
  const segments = planarizeWalls(walls.filter((wall) => wallLengthFt(wall) >= VERTEX_EPSILON_FT))
  if (segments.length === 0) return []

  const vertexIds = new Map<string, number>()
  const vertexX: number[] = []
  const vertexY: number[] = []
  const vertexOut: number[][] = []
  const touch = (x: number, y: number): number => {
    const key = quantKey(x, y)
    const existing = vertexIds.get(key)
    if (existing !== undefined) return existing
    const id = vertexX.length
    vertexIds.set(key, id)
    vertexX.push(x)
    vertexY.push(y)
    vertexOut.push([])
    return id
  }

  const halfEdges: HalfEdge[] = []
  const seen = new Set<string>()
  for (const [x0, y0, x1, y1] of segments) {
    const a = touch(x0, y0)
    const b = touch(x1, y1)
    if (a === b) continue
    const pairKey = a < b ? `${a}-${b}` : `${b}-${a}`
    if (seen.has(pairKey)) continue
    seen.add(pairKey)

    const forward = halfEdges.length
    const backward = forward + 1
    halfEdges.push({
      from: a,
      to: b,
      angle: Math.atan2(vertexY[b] - vertexY[a], vertexX[b] - vertexX[a]),
      twin: backward,
    })
    halfEdges.push({
      from: b,
      to: a,
      angle: Math.atan2(vertexY[a] - vertexY[b], vertexX[a] - vertexX[b]),
      twin: forward,
    })
    vertexOut[a].push(forward)
    vertexOut[b].push(backward)
  }
  if (halfEdges.length === 0) return []

  // Outgoing half-edges sorted by angle, plus each one's slot, so "the edge
  // before the reverse direction" is an index lookup rather than a scan.
  const slotOf = new Int32Array(halfEdges.length)
  for (const out of vertexOut) {
    out.sort((p, q) => halfEdges[p].angle - halfEdges[q].angle)
    for (let i = 0; i < out.length; i++) slotOf[out[i]] = i
  }

  const nextOf = new Int32Array(halfEdges.length)
  for (let index = 0; index < halfEdges.length; index++) {
    const twin = halfEdges[index].twin
    const out = vertexOut[halfEdges[index].to]
    // The twin leaves `to` heading back the way we came; the face continues
    // through the neighbour just clockwise of it.
    const slot = slotOf[twin]
    nextOf[index] = out[(slot - 1 + out.length) % out.length]
  }

  const visited = new Uint8Array(halfEdges.length)
  const faces: Array<{ ring: Array<[number, number]>; signedArea: number }> = []
  for (let start = 0; start < halfEdges.length; start++) {
    if (visited[start]) continue
    const ring: Array<[number, number]> = []
    let cursor = start
    let guard = 0
    while (!visited[cursor] && guard++ <= halfEdges.length) {
      visited[cursor] = 1
      ring.push([vertexX[halfEdges[cursor].from], vertexY[halfEdges[cursor].from]])
      cursor = nextOf[cursor]
    }
    if (ring.length < 3) continue
    faces.push({ ring, signedArea: signedPolygonArea(ring) })
  }

  // Orientation is decided by the traversal rule, not by counting: taking the
  // neighbour clockwise of the twin always walks an enclosed face in the
  // positive direction and each component's outer boundary in the negative
  // one. So a positive signed area IS an interior face — no heuristics, and
  // it holds for a lone room as surely as for forty.
  return faces
    .filter((face) => face.signedArea > 0)
    .map((face) => dedupeRing(face.ring))
    .filter((ring) => {
      const area = polygonArea(ring)
      return ring.length >= 3 && area >= MIN_ROOM_AREA_SQFT && area <= MAX_ROOM_AREA_SQFT
    })
}

/** Drop repeated and collinear vertices so a room reads as its real corners. */
function dedupeRing(ring: Array<[number, number]>): Array<[number, number]> {
  const points: Array<[number, number]> = []
  for (const point of ring) {
    const last = points[points.length - 1]
    if (last && Math.hypot(last[0] - point[0], last[1] - point[1]) < VERTEX_EPSILON_FT) continue
    points.push(point)
  }
  while (
    points.length > 1 &&
    Math.hypot(points[0][0] - points[points.length - 1][0], points[0][1] - points[points.length - 1][1]) <
      VERTEX_EPSILON_FT
  ) {
    points.pop()
  }
  if (points.length < 3) return points

  const simplified: Array<[number, number]> = []
  for (let i = 0; i < points.length; i++) {
    const previous = points[(i - 1 + points.length) % points.length]
    const current = points[i]
    const next = points[(i + 1) % points.length]
    const cross =
      (current[0] - previous[0]) * (next[1] - current[1]) - (current[1] - previous[1]) * (next[0] - current[0])
    if (Math.abs(cross) < 1e-4) continue
    simplified.push(current)
  }
  return simplified.length >= 3 ? simplified : points
}

// ---------------------------------------------------------------------------
// Wall runs: solid spans and openings, for the 3D build
// ---------------------------------------------------------------------------

export interface WallSpan {
  /** Distance along the centerline from the wall's start, in feet. */
  startFt: number
  endFt: number
  /** Bottom and top of the solid piece, in feet above the floor. */
  bottomFt: number
  topFt: number
}

/**
 * Split a wall into the solid boxes that actually get built.
 *
 * The gameplan's decision, and the right one: subtracting an opening prism
 * from a wall is a CSG problem only if you insist on one mesh per wall. Split
 * the run at the opening instead and every piece is an axis-aligned box — a
 * full-height solid between openings, a header above each one, and a sill
 * block under a window. No CSG library, no boolean robustness problems.
 */
export function wallSolidSpans(wall: Wall, openings: Opening[], ceilingHeightFt: number): WallSpan[] {
  const length = wallLengthFt(wall)
  if (!(length > 0)) return []
  const relevant = openings
    .filter((opening) => opening.wallId === wall.id)
    .map((opening) => ({
      start: Math.max(0, Math.min(length, opening.offsetFt)),
      end: Math.max(0, Math.min(length, opening.offsetFt + opening.widthFt)),
      sill: Math.max(0, Math.min(ceilingHeightFt, opening.sillFt)),
      head: Math.max(0, Math.min(ceilingHeightFt, opening.headFt)),
    }))
    .filter((opening) => opening.end - opening.start > 0.05)
    .sort((a, b) => a.start - b.start)

  const spans: WallSpan[] = []
  let cursor = 0
  for (const opening of relevant) {
    // Overlapping openings (a correction can create them) collapse into one.
    const start = Math.max(cursor, opening.start)
    if (start > cursor + 0.02) {
      spans.push({ startFt: cursor, endFt: start, bottomFt: 0, topFt: ceilingHeightFt })
    }
    if (opening.end <= start) continue
    if (opening.sill > 0.02) {
      spans.push({ startFt: start, endFt: opening.end, bottomFt: 0, topFt: opening.sill })
    }
    if (opening.head < ceilingHeightFt - 0.02) {
      spans.push({ startFt: start, endFt: opening.end, bottomFt: opening.head, topFt: ceilingHeightFt })
    }
    cursor = Math.max(cursor, opening.end)
  }
  if (cursor < length - 0.02) {
    spans.push({ startFt: cursor, endFt: length, bottomFt: 0, topFt: ceilingHeightFt })
  }
  return spans
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

/** Overall model confidence — the weakest link across every level. */
export function modelConfidence(model: FloorplanModel): number {
  if (model.levels.length === 0) return 0
  let total = 0
  for (const level of model.levels) {
    total += level.confidence.walls * 0.55 + level.confidence.rooms * 0.3 + level.confidence.openings * 0.15
  }
  return Math.round((total / model.levels.length) * 100) / 100
}

export function modelFloorAreaSqft(model: FloorplanModel): number {
  let total = 0
  for (const level of model.levels) {
    for (const room of level.rooms) total += room.areaSqft
  }
  return Math.round(total)
}

// ---------------------------------------------------------------------------
// Edits (the review UI's only way to change a model)
// ---------------------------------------------------------------------------

export type FloorplanEdit =
  | { type: "wall.add"; levelId: string; x0: number; y0: number; x1: number; y1: number; thicknessFt?: number }
  | { type: "wall.delete"; levelId: string; wallId: string }
  | { type: "opening.set"; levelId: string; openingId: string; kind: OpeningKind }
  | { type: "opening.delete"; levelId: string; openingId: string }
  | { type: "room.label"; levelId: string; roomId: string; label: string | null }
  | { type: "level.height"; levelId: string; ceilingHeightFt: number }
  | { type: "level.name"; levelId: string; name: string }

/** Deterministic ids: a correction must produce the same model on replay. */
function nextId(prefix: string, existing: Array<{ id: string }>): string {
  let max = 0
  for (const item of existing) {
    const match = /(\d+)$/.exec(item.id)
    if (match) max = Math.max(max, Number.parseInt(match[1], 10))
  }
  return `${prefix}${max + 1}`
}

/** A drawn wall end this far from existing linework lands on it instead. */
const ADD_WALL_SNAP_FT = 1.25

/**
 * Pull a hand-drawn wall end onto the wall it was aimed at.
 *
 * A correction is two clicks on a zoomed-out sheet, so "close enough" is the
 * best a human can do — and a wall that stops three inches short of the one it
 * meets divides nothing, which is exactly the failure the correction was
 * meant to fix. Endpoints win over mid-wall hits: aiming at a corner is
 * deliberate.
 */
function snapToWalls(x: number, y: number, walls: Wall[]): { x: number; y: number } {
  let best: { x: number; y: number; distance: number; corner: boolean } | null = null
  for (const wall of walls) {
    for (const [cx, cy] of [
      [wall.x0, wall.y0],
      [wall.x1, wall.y1],
    ]) {
      const distance = Math.hypot(cx - x, cy - y)
      if (distance > ADD_WALL_SNAP_FT) continue
      if (!best || best.corner === false || distance < best.distance) {
        best = { x: cx, y: cy, distance, corner: true }
      }
    }
    if (best?.corner) continue
    const dx = wall.x1 - wall.x0
    const dy = wall.y1 - wall.y0
    const lenSq = dx * dx + dy * dy
    if (lenSq < 1e-9) continue
    const t = Math.min(1, Math.max(0, ((x - wall.x0) * dx + (y - wall.y0) * dy) / lenSq))
    const px = wall.x0 + t * dx
    const py = wall.y0 + t * dy
    const distance = Math.hypot(px - x, py - y)
    if (distance > ADD_WALL_SNAP_FT) continue
    if (!best || distance < best.distance) best = { x: px, y: py, distance, corner: false }
  }
  return best ? { x: best.x, y: best.y } : { x, y }
}

const OPENING_PROFILES: Record<OpeningKind, { sillFt: number; headFt: number }> = {
  door: { sillFt: 0, headFt: DEFAULT_DOOR_HEAD_FT },
  window: { sillFt: DEFAULT_WINDOW_SILL_FT, headFt: DEFAULT_WINDOW_HEAD_FT },
  cased: { sillFt: 0, headFt: DEFAULT_DOOR_HEAD_FT },
}

/** Height profile for an opening kind — one home, used by interpret and edits. */
export function openingProfile(kind: OpeningKind): { sillFt: number; headFt: number } {
  return OPENING_PROFILES[kind]
}

/**
 * Rebuild a level's rooms from its walls, carrying labels across.
 *
 * A label survives if the old room's centroid still lands inside a new face —
 * an estimator who names the kitchen and then deletes a false wall inside it
 * must not lose the name.
 */
export function recomputeRooms(level: Level): Room[] {
  const previous = level.rooms
  const polygons = extractRoomPolygons(level.walls)
  return polygons.map((polygon, index) => {
    let label: string | null = null
    let labelConfidence = 0
    for (const room of previous) {
      if (!room.label) continue
      if (!pointInPolygon(polygonCentroid(room.polygon), polygon)) continue
      label = room.label
      labelConfidence = room.confidence
      break
    }
    return {
      id: `r${index + 1}`,
      polygon,
      label,
      areaSqft: Math.round(polygonArea(polygon)),
      confidence: label ? Math.max(0.6, labelConfidence) : 0.5,
    }
  })
}

/**
 * Apply one correction. Pure: returns a new model, never mutates the input.
 *
 * Unknown level/wall/room ids are a no-op returning the SAME reference, so the
 * caller can tell a real edit from a stale click and skip the write.
 */
export function applyFloorplanEdit(model: FloorplanModel, edit: FloorplanEdit): FloorplanModel {
  const index = model.levels.findIndex((level) => level.id === edit.levelId)
  if (index === -1) return model
  const level = model.levels[index]
  let next: Level | null = null

  switch (edit.type) {
    case "wall.add": {
      if (Math.hypot(edit.x1 - edit.x0, edit.y1 - edit.y0) < 0.5) return model
      const start = snapToWalls(edit.x0, edit.y0, level.walls)
      const end = snapToWalls(edit.x1, edit.y1, level.walls)
      const wall: Wall = {
        id: nextId("w", level.walls),
        x0: start.x,
        y0: start.y,
        x1: end.x,
        y1: end.y,
        thicknessFt: edit.thicknessFt && edit.thicknessFt > 0 ? edit.thicknessFt : DEFAULT_WALL_THICKNESS_FT,
        confidence: 1,
        source: "manual",
      }
      const walls = [...level.walls, wall]
      next = { ...level, walls }
      next.rooms = recomputeRooms(next)
      break
    }
    case "wall.delete": {
      if (!level.walls.some((wall) => wall.id === edit.wallId)) return model
      const walls = level.walls.filter((wall) => wall.id !== edit.wallId)
      const openings = level.openings.filter((opening) => opening.wallId !== edit.wallId)
      next = { ...level, walls, openings }
      next.rooms = recomputeRooms(next)
      break
    }
    case "opening.set": {
      const target = level.openings.find((opening) => opening.id === edit.openingId)
      if (!target || target.kind === edit.kind) return model
      const profile = openingProfile(edit.kind)
      next = {
        ...level,
        openings: level.openings.map((opening) =>
          opening.id === edit.openingId ? { ...opening, kind: edit.kind, ...profile, confidence: 1 } : opening,
        ),
      }
      break
    }
    case "opening.delete": {
      if (!level.openings.some((opening) => opening.id === edit.openingId)) return model
      next = { ...level, openings: level.openings.filter((opening) => opening.id !== edit.openingId) }
      break
    }
    case "room.label": {
      const target = level.rooms.find((room) => room.id === edit.roomId)
      if (!target) return model
      const label = edit.label?.trim() ? edit.label.trim().slice(0, 40) : null
      if (label === target.label) return model
      next = {
        ...level,
        rooms: level.rooms.map((room) =>
          room.id === edit.roomId ? { ...room, label, confidence: label ? 1 : 0.5 } : room,
        ),
      }
      break
    }
    case "level.height": {
      const height = Math.min(20, Math.max(6, edit.ceilingHeightFt))
      if (Math.abs(height - level.ceilingHeightFt) < 0.01) return model
      next = { ...level, ceilingHeightFt: height }
      break
    }
    case "level.name": {
      const name = edit.name.trim().slice(0, 60)
      if (!name || name === level.name) return model
      next = { ...level, name }
      break
    }
  }

  if (!next) return model
  const levels = [...model.levels]
  levels[index] = { ...next, confidence: levelConfidence(next) }
  return { ...model, levels, correctionCount: model.correctionCount + 1 }
}

/**
 * Score a level after an edit.
 *
 * Confidence is evidence, not decoration: it decides which walls the review
 * overlay tints and whether the model is worth publishing. Manual walls score
 * 1 — a human drew them.
 */
export function levelConfidence(level: Level): LevelConfidence {
  const walls = level.walls.length
    ? level.walls.reduce((total, wall) => total + wall.confidence, 0) / level.walls.length
    : 0
  const openings = level.openings.length
    ? level.openings.reduce((total, opening) => total + opening.confidence, 0) / level.openings.length
    : level.walls.length
      ? 0.4
      : 0
  const labelled = level.rooms.filter((room) => room.label).length
  const rooms = level.rooms.length ? (0.4 + 0.6 * (labelled / level.rooms.length)) : 0
  return {
    walls: Math.round(walls * 100) / 100,
    openings: Math.round(openings * 100) / 100,
    rooms: Math.round(rooms * 100) / 100,
  }
}
