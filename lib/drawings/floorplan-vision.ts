/**
 * Vision-assisted floorplan interpretation: reconcile what a vision model SEES
 * with what the vector geometry PROVES.
 *
 * The division of labour is the whole design. Vector interpretation has
 * precision — exact coordinates, exact thicknesses — but its recall dies on
 * drafting styles it has no rule for: hatched poché, walls interrupted by
 * dimension ticks, scanned sheets with no vectors at all. A vision model is
 * the opposite: it recognises a wall however it is drawn, but its coordinates
 * wobble. So the model PROPOSES topology in normalized image space, and this
 * module keeps only what the vectors do not already prove, snapped onto the
 * vector-derived graph wherever it can reach.
 *
 * Confidence is agreement: a wall both sources found gets a boost, a wall only
 * the vision model saw arrives at `VISION_WALL_CONFIDENCE` — under the review
 * UI's attention threshold, because an unproven wall must look unproven.
 *
 * Pure and client-safe: the network call lives in the service layer; this
 * module only parses and reconciles. Unit-tested in
 * tests/floorplan-vision.test.js.
 */

import {
  levelConfidence,
  normalizedToModel,
  pointInPolygon,
  recomputeRooms,
  DEFAULT_WALL_THICKNESS_FT,
  type Level,
  type Wall,
} from "@/lib/drawings/floorplan-model"
import { roomLabelFromText } from "@/lib/drawings/floorplan-interpret"

/** A wall only the vision model saw. Low on purpose — review must flag it. */
export const VISION_WALL_CONFIDENCE = 0.45
/** Confidence added to a vector wall the vision model independently confirmed. */
const AGREEMENT_BOOST = 0.08
/** Share of a vision wall that must lie on vector walls to count as "seen". */
const AGREEMENT_COVERAGE = 0.6
/** Below this coverage a vision wall is genuinely new linework. */
const NOVEL_COVERAGE = 0.3
/** Lateral slack when matching vision strokes to vector centerlines. */
const MATCH_TOLERANCE_FT = 1.0
/** Vision endpoints snap onto vector wall ends within this reach. */
const SNAP_REACH_FT = 1.5
/** Anything shorter is a stroke artifact, not a wall. */
const MIN_VISION_WALL_FT = 3
/** Proposal caps — a hallucinating model must not flood the level. */
const MAX_PROPOSAL_WALLS = 400
const MAX_PROPOSAL_ROOMS = 120

export interface VisionWallProposal {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface VisionRoomProposal {
  x: number
  y: number
  label: string
}

export interface FloorplanVisionProposal {
  walls: VisionWallProposal[]
  rooms: VisionRoomProposal[]
}

/**
 * The prompt the service sends with the sheet image. Coordinates are demanded
 * in the same normalized image space `vectors.bin` uses, so the proposal drops
 * straight into `normalizedToModel` with no bespoke mapping.
 */
export function buildFloorplanVisionPrompt(levelName: string): string {
  return [
    `You are reading one architectural floor plan sheet ("${levelName}") from a residential construction drawing set.`,
    "Trace the plan's WALLS and name its ROOMS.",
    "Coordinates: normalized to the image, x 0..1 left→right, y 0..1 top→bottom.",
    "Walls: one straight centerline per wall run (exterior and interior). Follow the drawn walls only — never dimension lines, roof overhangs, property lines, cabinets, or the title block.",
    "Rooms: one entry per named room, positioned at the room name's printed location, label copied exactly as printed (e.g. \"BEDROOM 2\", \"GREAT ROOM\").",
    "Return ONLY JSON: {\"walls\":[{\"x0\":0.1,\"y0\":0.2,\"x1\":0.4,\"y1\":0.2}],\"rooms\":[{\"x\":0.3,\"y\":0.4,\"label\":\"KITCHEN\"}]}",
    "Omit anything you cannot see clearly. An omitted wall is recoverable; an invented one is not.",
  ].join("\n")
}

/** Parse the model's reply, tolerating code fences and leading prose. */
export function parseFloorplanVisionProposal(raw: string): FloorplanVisionProposal | null {
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start === -1 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const record = parsed as Record<string, unknown>

  const walls: VisionWallProposal[] = []
  if (Array.isArray(record.walls)) {
    for (const entry of record.walls.slice(0, MAX_PROPOSAL_WALLS)) {
      if (!entry || typeof entry !== "object") continue
      const wall = entry as Record<string, unknown>
      const values = [wall.x0, wall.y0, wall.x1, wall.y1]
      if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) continue
      const [x0, y0, x1, y1] = (values as number[]).map((value) => Math.min(1, Math.max(0, value)))
      walls.push({ x0, y0, x1, y1 })
    }
  }

  const rooms: VisionRoomProposal[] = []
  if (Array.isArray(record.rooms)) {
    for (const entry of record.rooms.slice(0, MAX_PROPOSAL_ROOMS)) {
      if (!entry || typeof entry !== "object") continue
      const room = entry as Record<string, unknown>
      if (typeof room.x !== "number" || typeof room.y !== "number") continue
      if (!Number.isFinite(room.x) || !Number.isFinite(room.y)) continue
      if (typeof room.label !== "string") continue
      const label = room.label.replace(/\s+/g, " ").trim().slice(0, 40)
      if (!label) continue
      rooms.push({
        x: Math.min(1, Math.max(0, room.x)),
        y: Math.min(1, Math.max(0, room.y)),
        label,
      })
    }
  }

  if (walls.length === 0 && rooms.length === 0) return null
  return { walls, rooms }
}

export interface VisionReconciliation {
  level: Level
  /** Walls only the vision model saw, added at low confidence. */
  addedWalls: number
  /** Vector walls the vision model independently confirmed. */
  confirmedWalls: number
  /** Rooms that got a name they did not have. */
  labeledRooms: number
}

function distanceToWallFt(x: number, y: number, wall: Wall): number {
  const dx = wall.x1 - wall.x0
  const dy = wall.y1 - wall.y0
  const lenSq = dx * dx + dy * dy
  if (lenSq < 1e-9) return Math.hypot(x - wall.x0, y - wall.y0)
  const t = Math.min(1, Math.max(0, ((x - wall.x0) * dx + (y - wall.y0) * dy) / lenSq))
  return Math.hypot(x - (wall.x0 + t * dx), y - (wall.y0 + t * dy))
}

function snapToWallEnds(x: number, y: number, walls: Wall[]): { x: number; y: number } {
  let best: { x: number; y: number; distance: number } | null = null
  for (const wall of walls) {
    for (const [px, py] of [
      [wall.x0, wall.y0],
      [wall.x1, wall.y1],
    ]) {
      const distance = Math.hypot(px - x, py - y)
      if (distance <= SNAP_REACH_FT && (!best || distance < best.distance)) {
        best = { x: px, y: py, distance }
      }
    }
  }
  return best ?? { x, y }
}

/**
 * Fold a vision proposal into an interpreted level.
 *
 * `acceptAllWalls` is the vision-ONLY path — a scanned sheet with no vectors
 * at all, where coverage against an empty wall set would mark everything
 * novel anyway but the coverage gate on partially-traced sheets must not
 * apply.
 */
export function applyVisionProposal(
  level: Level,
  proposal: FloorplanVisionProposal,
  options: { acceptAllWalls?: boolean } = {},
): VisionReconciliation {
  const source = level.source
  const toFeet = (nx: number, ny: number) => normalizedToModel(source, nx, ny)

  const walls = level.walls.map((wall) => ({ ...wall }))
  const confirmed = new Set<string>()
  let added = 0

  for (const stroke of proposal.walls) {
    const a = toFeet(stroke.x0, stroke.y0)
    const b = toFeet(stroke.x1, stroke.y1)
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    if (length < MIN_VISION_WALL_FT) continue

    // Length-weighted agreement between this stroke and the vector walls.
    const steps = Math.max(2, Math.ceil(length))
    let covered = 0
    const touched = new Set<string>()
    for (let i = 0; i <= steps; i++) {
      const x = a.x + ((b.x - a.x) * i) / steps
      const y = a.y + ((b.y - a.y) * i) / steps
      for (const wall of walls) {
        if (distanceToWallFt(x, y, wall) <= MATCH_TOLERANCE_FT) {
          covered++
          touched.add(wall.id)
          break
        }
      }
    }
    const coverage = covered / (steps + 1)

    if (coverage >= AGREEMENT_COVERAGE) {
      for (const id of touched) confirmed.add(id)
      continue
    }
    if (!options.acceptAllWalls && coverage > NOVEL_COVERAGE) continue

    const start = snapToWallEnds(a.x, a.y, walls)
    const end = snapToWallEnds(b.x, b.y, walls)
    if (Math.hypot(end.x - start.x, end.y - start.y) < MIN_VISION_WALL_FT) continue
    added++
    walls.push({
      id: `wv${added}`,
      x0: round2(start.x),
      y0: round2(start.y),
      x1: round2(end.x),
      y1: round2(end.y),
      thicknessFt: DEFAULT_WALL_THICKNESS_FT,
      confidence: VISION_WALL_CONFIDENCE,
      source: "single",
    })
  }

  for (const wall of walls) {
    if (confirmed.has(wall.id)) {
      wall.confidence = Math.min(0.98, round2(wall.confidence + AGREEMENT_BOOST))
    }
  }

  let next: Level = { ...level, walls }
  // New walls change the face graph, so rooms are rebuilt (labels survive by
  // centroid, the same rule the correction reducer uses).
  if (added > 0) next = { ...next, rooms: recomputeRooms(next) }

  // Name what the sheet's own text could not. The lexicon still gates the
  // label — a vision model that reads "12'-0" x 10'-6"" as a name is filtered
  // exactly like a text run would be.
  let labeled = 0
  const rooms = next.rooms.map((room) => {
    if (room.label) return room
    for (const candidate of proposal.rooms) {
      const label = roomLabelFromText(candidate.label)
      if (!label) continue
      const point = toFeet(candidate.x, candidate.y)
      if (!pointInPolygon([point.x, point.y], room.polygon)) continue
      labeled++
      return { ...room, label, confidence: Math.max(room.confidence, 0.7) }
    }
    return room
  })
  next = { ...next, rooms }
  next.confidence = levelConfidence(next)

  return { level: next, addedWalls: added, confirmedWalls: confirmed.size, labeledRooms: labeled }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
