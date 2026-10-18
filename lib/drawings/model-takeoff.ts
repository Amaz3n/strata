/**
 * The model and the takeoff, read against each other.
 *
 * A level of the 3D model is traced from one sheet; the takeoff is measured on
 * that same sheet. Neither stores a link to the other, so this module derives
 * one from geometry: an area measurement that covers a room counts that room,
 * a wall-height run laid along a wall counts that wall. It is pure so the
 * "Takeoff" look in 3D, the room finish picker and the sheet ↔ model hover all
 * agree, and so the matching rules are tested without a browser.
 *
 * Coordinates: measurements are normalized 0..1 on the sheet image; the model
 * is in level feet. `normalizedToModel` (floorplan-model.ts) is the only
 * conversion, so a mismatch here can never be a units bug.
 */

import {
  normalizedToModel,
  modelToNormalized,
  pointInPolygon,
  polygonArea,
  type FloorplanSource,
  type Level,
} from "./floorplan-model"

/** The slice of a measurement this module needs. */
export interface TakeoffMarkupShape {
  id: string
  type: string
  points: Array<[number, number]>
  conditionId: string | null
  /** Deductions never count a room. */
  deduction?: boolean
}

/** The slice of a condition this module needs. */
export interface TakeoffConditionShape {
  id: string
  color: string
  /** Set on a wall-area condition: the run is measured in LF, priced in SF. */
  heightFt: number | null
}

export interface SurfaceTakeoff {
  conditionId: string
  color: string
  /** The measurements that put this surface in the takeoff. */
  markupIds: string[]
}

/** surface id (room or wall) → the condition that counts it. */
export type SurfaceTakeoffMap = Record<string, SurfaceTakeoff>

/** An area measurement within this share of a room's area is the same room. */
const ROOM_AREA_TOLERANCE = 0.15
/** A run within this many feet of a wall's centerline is laid along it. */
const WALL_OFFSET_SLACK_FT = 0.75
/** Max angle between a run and a wall, in radians (~6°). */
const WALL_ANGLE_TOLERANCE = 0.105
/** A wall is counted when runs cover at least this share of its length. */
const WALL_COVERAGE = 0.5

const toModel = (source: FloorplanSource, [x, y]: [number, number]): [number, number] => {
  const point = normalizedToModel(source, x, y)
  return [point.x, point.y]
}

function centroid(points: Array<[number, number]>): [number, number] {
  let x = 0
  let y = 0
  for (const [px, py] of points) {
    x += px
    y += py
  }
  return [x / points.length, y / points.length]
}

/** Which takeoff condition counts each room and wall of a level. */
export function matchLevelTakeoff(
  level: Level,
  markups: TakeoffMarkupShape[],
  conditions: TakeoffConditionShape[],
): SurfaceTakeoffMap {
  const byId = new Map(conditions.map((condition) => [condition.id, condition]))
  const result: SurfaceTakeoffMap = {}
  const claim = (surfaceId: string, condition: TakeoffConditionShape, markupId: string) => {
    const existing = result[surfaceId]
    if (existing && existing.conditionId !== condition.id) return
    if (existing) existing.markupIds.push(markupId)
    else result[surfaceId] = { conditionId: condition.id, color: condition.color, markupIds: [markupId] }
  }

  for (const markup of markups) {
    if (markup.type !== "area" || markup.deduction || !markup.conditionId) continue
    const condition = byId.get(markup.conditionId)
    if (!condition || markup.points.length < 3) continue
    const ring = markup.points.map((point) => toModel(level.source, point))
    const area = polygonArea(ring)
    const center = centroid(ring)
    const room = level.rooms.find(
      (candidate) =>
        pointInPolygon(center, candidate.polygon) &&
        Math.abs(area - candidate.areaSqft) <= candidate.areaSqft * ROOM_AREA_TOLERANCE,
    )
    if (room) claim(room.id, condition, markup.id)
  }

  const coverage = new Map<string, Map<string, { length: number; ids: string[] }>>()
  for (const markup of markups) {
    if (markup.type !== "polyline" || !markup.conditionId) continue
    const condition = byId.get(markup.conditionId)
    if (!condition?.heightFt) continue
    const run = markup.points.map((point) => toModel(level.source, point))
    for (let i = 1; i < run.length; i++) {
      for (const wall of level.walls) {
        const covered = segmentAlongWall(run[i - 1], run[i], wall)
        if (covered <= 0) continue
        const perWall = coverage.get(wall.id) ?? new Map()
        const entry = perWall.get(condition.id) ?? { length: 0, ids: [] }
        entry.length += covered
        if (!entry.ids.includes(markup.id)) entry.ids.push(markup.id)
        perWall.set(condition.id, entry)
        coverage.set(wall.id, perWall)
      }
    }
  }
  for (const wall of level.walls) {
    const length = Math.hypot(wall.x1 - wall.x0, wall.y1 - wall.y0)
    const perWall = coverage.get(wall.id)
    if (!perWall || length <= 0) continue
    let best: { conditionId: string; length: number; ids: string[] } | null = null
    for (const [conditionId, entry] of perWall) {
      if (!best || entry.length > best.length) best = { conditionId, ...entry }
    }
    const condition = best && byId.get(best.conditionId)
    if (best && condition && best.length >= length * WALL_COVERAGE) {
      result[wall.id] = { conditionId: condition.id, color: condition.color, markupIds: best.ids }
    }
  }
  return result
}

/**
 * How many feet of segment a→b run along the wall's centerline: zero unless
 * the two are parallel and close, otherwise the overlap of their projections.
 */
export function segmentAlongWall(
  a: [number, number],
  b: [number, number],
  wall: { x0: number; y0: number; x1: number; y1: number; thicknessFt: number },
): number {
  const wx = wall.x1 - wall.x0
  const wy = wall.y1 - wall.y0
  const wallLength = Math.hypot(wx, wy)
  const sx = b[0] - a[0]
  const sy = b[1] - a[1]
  const segLength = Math.hypot(sx, sy)
  if (wallLength <= 0 || segLength <= 0) return 0
  const ux = wx / wallLength
  const uy = wy / wallLength
  const cross = Math.abs((sx * uy - sy * ux) / segLength)
  if (Math.asin(Math.min(1, cross)) > WALL_ANGLE_TOLERANCE) return 0
  const offset = (px: number, py: number) => Math.abs((px - wall.x0) * uy - (py - wall.y0) * ux)
  const slack = wall.thicknessFt / 2 + WALL_OFFSET_SLACK_FT
  if (offset(a[0], a[1]) > slack || offset(b[0], b[1]) > slack) return 0
  const along = (px: number, py: number) => (px - wall.x0) * ux + (py - wall.y0) * uy
  const t0 = along(a[0], a[1])
  const t1 = along(b[0], b[1])
  const lo = Math.max(0, Math.min(t0, t1))
  const hi = Math.min(wallLength, Math.max(t0, t1))
  return Math.max(0, hi - lo)
}

/** The room under a normalized sheet point, for sheet → model hover. */
export function roomAtSheetPoint(
  level: Level,
  point: { x: number; y: number },
): Level["rooms"][number] | null {
  const model = normalizedToModel(level.source, point.x, point.y)
  const hits = level.rooms.filter((room) => pointInPolygon([model.x, model.y], room.polygon))
  if (hits.length === 0) return null
  return hits.reduce((smallest, room) => (room.areaSqft < smallest.areaSqft ? room : smallest))
}

/** A room's outline on its source sheet, normalized — for model → sheet hover. */
export function roomOutlineOnSheet(
  level: Level,
  roomId: string,
): Array<[number, number]> | null {
  const room = level.rooms.find((candidate) => candidate.id === roomId)
  if (!room) return null
  return room.polygon.map(([x, y]) => {
    const point = modelToNormalized(level.source, x, y)
    return [point.x, point.y]
  })
}

/** A wall's centerline on its source sheet, normalized. */
export function wallOutlineOnSheet(
  level: Level,
  wallId: string,
): Array<[number, number]> | null {
  const wall = level.walls.find((candidate) => candidate.id === wallId)
  if (!wall) return null
  const a = modelToNormalized(level.source, wall.x0, wall.y0)
  const b = modelToNormalized(level.source, wall.x1, wall.y1)
  return [
    [a.x, a.y],
    [b.x, b.y],
  ]
}
