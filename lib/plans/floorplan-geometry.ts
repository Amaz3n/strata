/**
 * Floorplan model → 3D geometry.
 *
 * Everything Three.js needs, computed without Three.js: vertex and index
 * buffers for walls, joinery, floor slabs and ceilings, plus the collision
 * segments walk mode tests against. Keeping the maths here means the 700KB
 * renderer loads only when somebody opens the viewer, and the geometry itself
 * stays unit-testable.
 *
 * World axes: model (x, y) plan feet map to world (x, z) — y is UP in the
 * scene, as it is in every 3D convention, while y is SOUTH in a floorplan. The
 * model is centred on the origin so the orbit camera has nothing to learn
 * about where the house happens to sit on its sheet.
 */

import {
  boundsOf,
  levelBounds,
  pointInPolygon,
  polygonArea,
  polygonCentroid,
  wallDirection,
  wallLengthFt,
  wallSolidSpans,
  type FloorplanModel,
  type Level,
  type Wall,
} from "@/lib/drawings/floorplan-model"

/** Gap between stacked levels — the floor assembly a plan never draws. */
export const FLOOR_ASSEMBLY_FT = 1
/** Slab thickness under each level, so a floor reads as a solid, not a plane. */
const SLAB_THICKNESS_FT = 0.35
/** Eye height for walk mode: a 5'6" viewpoint reads as "standing in it". */
export const EYE_HEIGHT_FT = 5.5
/**
 * Dollhouse cut height above a floor. Chest height, not waist: door leaves and
 * window sills stay in the cut so the rooms still read as rooms, while
 * everything that hides the plan from above is gone.
 */
export const DOLLHOUSE_CUT_FT = 4.2

/** Door leaves render slightly ajar — a closed door reads as a wall. */
const DOOR_SWING_RAD = Math.PI * 0.24
const DOOR_LEAF_THICKNESS_FT = 0.12
/** Jamb posts flank every opening, slightly proud of the wall face. */
const JAMB_WIDTH_FT = 0.16
const JAMB_PROUD_FT = 0.06
const GLASS_THICKNESS_FT = 0.06

/**
 * A wall piece blocks walking when it rises from below chest height: full
 * walls and window sills stop the capsule, door and cased-opening headers do
 * not — which is what finally lets walk mode pass through a doorway.
 */
const BLOCKING_BOTTOM_FT = 3.5
const BLOCKING_MIN_TOP_FT = 1.5

export interface MeshData {
  positions: Float32Array
  normals: Float32Array
  indices: Uint32Array
  /** Per-vertex RGB, present only on meshes that tint by room (floors). */
  colors?: Float32Array
}

export interface RoomLabelAnchor {
  id: string
  text: string
  areaSqft: number
  /** World position of the label billboard. */
  x: number
  y: number
  z: number
  /** World Y of the floor surface, for labels painted onto it. */
  floorY: number
  /** Rotation about Y for a floor-painted label — along the room's long axis. */
  angle: number
  /** Widest a floor-painted label can be without leaving the room, in feet. */
  fitFt: number
}

/** A wall footprint in world XZ, for capsule collision in walk mode. */
export interface CollisionSegment {
  x0: number
  z0: number
  x1: number
  z1: number
  halfThickness: number
}

export interface LevelGeometry {
  levelId: string
  name: string
  order: number
  /** World Y of this level's floor surface. */
  baseY: number
  ceilingHeightFt: number
  /** Interior partitions. */
  walls: MeshData
  /** Perimeter walls — rendered a shade darker so the envelope reads. */
  exteriorWalls: MeshData
  /** Door leaves, jambs and window frames — the painted joinery. */
  trim: MeshData
  /** Window panes, rendered translucent. */
  glass: MeshData
  floor: MeshData
  ceiling: MeshData
  labels: RoomLabelAnchor[]
  collision: CollisionSegment[]
  /** A point known to be inside the largest room — where walk mode starts. */
  spawn: { x: number; z: number } | null
  roomCount: number
  wallCount: number
  floorAreaSqft: number
}

export interface SceneGeometry {
  levels: LevelGeometry[]
  /** Footprint half-extent in feet, for framing the orbit camera. */
  radiusFt: number
  widthFt: number
  depthFt: number
  totalFloorAreaSqft: number
}

// ---------------------------------------------------------------------------
// Mesh assembly
// ---------------------------------------------------------------------------

class MeshBuilder {
  private positions: number[] = []
  private normals: number[] = []
  private indices: number[] = []
  private colors: number[] | null

  constructor(withColors = false) {
    this.colors = withColors ? [] : null
  }

  /** Add one quad, wound counter-clockwise when seen from `normal`. */
  quad(
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    d: [number, number, number],
    normal: [number, number, number],
    color?: [number, number, number],
  ): void {
    const base = this.positions.length / 3
    for (const point of [a, b, c, d]) {
      this.positions.push(point[0], point[1], point[2])
      this.normals.push(normal[0], normal[1], normal[2])
      if (this.colors) this.colors.push(...(color ?? [1, 1, 1]))
    }
    this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }

  /** Add a horizontal polygon at height `y`, fan-triangulated from a point. */
  polygonFan(
    points: Array<[number, number]>,
    y: number,
    up: boolean,
    color?: [number, number, number],
  ): void {
    if (points.length < 3) return
    const [cx, cz] = polygonCentroid(points)
    const base = this.positions.length / 3
    const normal: [number, number, number] = up ? [0, 1, 0] : [0, -1, 0]
    this.positions.push(cx, y, cz)
    this.normals.push(...normal)
    if (this.colors) this.colors.push(...(color ?? [1, 1, 1]))
    for (const [x, z] of points) {
      this.positions.push(x, y, z)
      this.normals.push(...normal)
      if (this.colors) this.colors.push(...(color ?? [1, 1, 1]))
    }
    for (let i = 0; i < points.length; i++) {
      const next = ((i + 1) % points.length) + 1
      if (up) this.indices.push(base, base + i + 1, base + next)
      else this.indices.push(base, base + next, base + i + 1)
    }
  }

  build(): MeshData {
    return {
      positions: Float32Array.from(this.positions),
      normals: Float32Array.from(this.normals),
      indices: Uint32Array.from(this.indices),
      ...(this.colors ? { colors: Float32Array.from(this.colors) } : {}),
    }
  }

  get isEmpty(): boolean {
    return this.indices.length === 0
  }
}

/** A closed box between two plan points, at a given thickness and height band. */
function box(
  builder: MeshBuilder,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  halfThickness: number,
  bottomY: number,
  topY: number,
): void {
  const dx = x1 - x0
  const dz = z1 - z0
  const length = Math.hypot(dx, dz)
  if (!(length > 0) || topY - bottomY <= 0.001) return
  const ux = dx / length
  const uz = dz / length
  const nx = -uz * halfThickness
  const nz = ux * halfThickness

  // Four corners of the footprint, in order around the rectangle.
  const p00: [number, number] = [x0 + nx, z0 + nz]
  const p01: [number, number] = [x1 + nx, z1 + nz]
  const p11: [number, number] = [x1 - nx, z1 - nz]
  const p10: [number, number] = [x0 - nx, z0 - nz]

  const at = (p: [number, number], y: number): [number, number, number] => [p[0], y, p[1]]

  builder.quad(at(p00, bottomY), at(p01, bottomY), at(p01, topY), at(p00, topY), [-uz, 0, ux])
  builder.quad(at(p11, bottomY), at(p10, bottomY), at(p10, topY), at(p11, topY), [uz, 0, -ux])
  builder.quad(at(p01, bottomY), at(p11, bottomY), at(p11, topY), at(p01, topY), [ux, 0, uz])
  builder.quad(at(p10, bottomY), at(p00, bottomY), at(p00, topY), at(p10, topY), [-ux, 0, -uz])
  builder.quad(at(p00, topY), at(p01, topY), at(p11, topY), at(p10, topY), [0, 1, 0])
  builder.quad(at(p10, bottomY), at(p11, bottomY), at(p01, bottomY), at(p00, bottomY), [0, -1, 0])
}

// ---------------------------------------------------------------------------
// Room floor tint
// ---------------------------------------------------------------------------

function rgb(hex: number): [number, number, number] {
  return [((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255]
}

const FLOOR_BASE = rgb(0xcfccc5)
const FLOOR_WOOD = rgb(0xd9cbb0)
const FLOOR_TILE = rgb(0xc5cdd2)
const FLOOR_CONCRETE = rgb(0xbcb9b2)
const FLOOR_OUTDOOR = rgb(0xc7c2b7)

/**
 * A subtle material read per room type, keyed off the label the interpreter
 * already extracted: wet rooms cool, garages concrete, living spaces warm.
 * Unnamed rooms keep the neutral base — the tint is information, and a room
 * we know nothing about must not pretend otherwise.
 */
export function roomFloorTint(label: string | null): [number, number, number] {
  if (!label) return FLOOR_BASE
  const name = label.toUpperCase()
  if (/BATH|KITCHEN|LAUNDRY|UTILITY|POWDER|MUD|PANTRY|W\.?C\b/.test(name)) return FLOOR_TILE
  if (/GARAGE|CARPORT|STORAGE|MECH|SHOP/.test(name)) return FLOOR_CONCRETE
  if (/LANAI|PORCH|PATIO|DECK|BALCON|TERRACE/.test(name)) return FLOOR_OUTDOOR
  return FLOOR_WOOD
}

// ---------------------------------------------------------------------------
// Wall classification
// ---------------------------------------------------------------------------

/**
 * A wall is exterior when exactly one of its sides is inside a room: the other
 * side faces the outside world. With no rooms traced there is no inside to
 * speak of, so everything renders as interior rather than guessing.
 */
export function wallIsExterior(wall: Wall, rooms: Level["rooms"]): boolean {
  if (rooms.length === 0) return false
  const { ux, uy } = wallDirection(wall)
  const midX = (wall.x0 + wall.x1) / 2
  const midY = (wall.y0 + wall.y1) / 2
  const probe = wall.thicknessFt / 2 + 0.8
  const sideA: [number, number] = [midX - uy * probe, midY + ux * probe]
  const sideB: [number, number] = [midX + uy * probe, midY - ux * probe]
  const insideA = rooms.some((room) => pointInPolygon(sideA, room.polygon))
  const insideB = rooms.some((room) => pointInPolygon(sideB, room.polygon))
  return insideA !== insideB
}

// ---------------------------------------------------------------------------
// Scene build
// ---------------------------------------------------------------------------

/**
 * Build every level's geometry.
 *
 * `centerOn` is the whole model's bounds, so a second storey drawn on its own
 * sheet lands over the first rather than beside it — the two sheets share a
 * building, not a coordinate system, and this is where they are reconciled.
 */
export function buildSceneGeometry(model: FloorplanModel): SceneGeometry {
  const all = model.levels.map((level) => levelBounds(level))
  const minX = Math.min(...all.map((bounds) => bounds.minX), 0)
  const minY = Math.min(...all.map((bounds) => bounds.minY), 0)
  const maxX = Math.max(...all.map((bounds) => bounds.maxX), 0)
  const maxY = Math.max(...all.map((bounds) => bounds.maxY), 0)
  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2

  const ordered = [...model.levels].sort((a, b) => a.order - b.order)
  let baseY = 0
  const levels: LevelGeometry[] = []
  for (const level of ordered) {
    levels.push(buildLevelGeometry(level, { centerX, centerY, baseY }))
    baseY += level.ceilingHeightFt + FLOOR_ASSEMBLY_FT
  }

  const widthFt = maxX - minX
  const depthFt = maxY - minY
  return {
    levels,
    radiusFt: Math.max(10, Math.hypot(widthFt, depthFt) / 2),
    widthFt,
    depthFt,
    totalFloorAreaSqft: levels.reduce((total, level) => total + level.floorAreaSqft, 0),
  }
}

export function buildLevelGeometry(
  level: Level,
  frame: { centerX: number; centerY: number; baseY: number },
): LevelGeometry {
  const interior = new MeshBuilder()
  const exterior = new MeshBuilder()
  const trim = new MeshBuilder()
  const glass = new MeshBuilder()
  const floor = new MeshBuilder(true)
  const ceiling = new MeshBuilder()
  const collision: CollisionSegment[] = []
  const { centerX, centerY, baseY } = frame
  const toWorld = (x: number, y: number): [number, number] => [x - centerX, y - centerY]

  for (const wall of level.walls) {
    const length = wallLengthFt(wall)
    if (!(length > 0)) continue
    const { ux, uy } = wallDirection(wall)
    const half = Math.max(0.1, wall.thicknessFt) / 2
    const walls = wallIsExterior(wall, level.rooms) ? exterior : interior
    const at = (distanceFt: number): [number, number] =>
      toWorld(wall.x0 + ux * distanceFt, wall.y0 + uy * distanceFt)

    const spans = wallSolidSpans(wall, level.openings, level.ceilingHeightFt)
    for (const span of spans) {
      const [x0, z0] = at(span.startFt)
      const [x1, z1] = at(span.endFt)
      box(walls, x0, z0, x1, z1, half, baseY + span.bottomFt, baseY + span.topFt)
    }

    // Collision follows the built solids, not the drawn centerline: a piece
    // that rises from below chest height blocks the capsule, a door header
    // does not — walking through a doorway works because the doorway is a
    // genuine gap in what got built.
    const blocking: Array<[number, number]> = spans
      .filter((span) => span.bottomFt < BLOCKING_BOTTOM_FT && span.topFt > BLOCKING_MIN_TOP_FT)
      .map((span): [number, number] => [span.startFt, span.endFt])
      .sort((a, b) => a[0] - b[0])
    let interval: [number, number] | null = null
    const flush = () => {
      if (!interval) return
      const [start, end] = interval
      const [x0, z0] = at(start)
      const [x1, z1] = at(end)
      collision.push({ x0, z0, x1, z1, halfThickness: half })
      interval = null
    }
    for (const [start, end] of blocking) {
      if (interval && start <= interval[1] + 0.05) interval[1] = Math.max(interval[1], end)
      else {
        flush()
        interval = [start, end]
      }
    }
    flush()

    buildOpeningJoinery(trim, glass, wall, level, { at, ux, uy, half, baseY })
  }

  const labels: RoomLabelAnchor[] = []
  let floorAreaSqft = 0
  let largest: { area: number; x: number; z: number } | null = null

  for (const room of level.rooms) {
    const ring = room.polygon.map(([x, y]) => toWorld(x, y))
    if (ring.length < 3) continue
    const area = polygonArea(ring)
    floorAreaSqft += area
    const tint = roomFloorTint(room.label)

    // A slab under the room, not a plane: seen from the floor below, a
    // zero-thickness surface disappears entirely at grazing angles.
    floor.polygonFan(ring, baseY, true, tint)
    floor.polygonFan(ring, baseY - SLAB_THICKNESS_FT, false, tint)
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % ring.length]
      const edge = Math.hypot(b[0] - a[0], b[1] - a[1])
      if (edge < 1e-6) continue
      const ux = (b[0] - a[0]) / edge
      const uz = (b[1] - a[1]) / edge
      floor.quad(
        [a[0], baseY - SLAB_THICKNESS_FT, a[1]],
        [b[0], baseY - SLAB_THICKNESS_FT, b[1]],
        [b[0], baseY, b[1]],
        [a[0], baseY, a[1]],
        [uz, 0, -ux],
        tint,
      )
    }
    ceiling.polygonFan(ring, baseY + level.ceilingHeightFt, false)

    const [cx, cz] = polygonCentroid(ring)
    if (room.label) {
      const bounds = boundsOf(ring)
      const width = bounds.maxX - bounds.minX
      const depth = bounds.maxY - bounds.minY
      labels.push({
        id: room.id,
        text: room.label,
        areaSqft: room.areaSqft,
        x: cx,
        y: baseY + Math.min(4.5, level.ceilingHeightFt / 2),
        z: cz,
        floorY: baseY,
        // Painted along the room's long axis, the way a plan annotates it.
        angle: depth > width ? Math.PI / 2 : 0,
        fitFt: Math.max(3, Math.min(14, Math.max(width, depth) * 0.7, Math.min(width, depth) * 1.6)),
      })
    }
    if (!largest || area > largest.area) largest = { area, x: cx, z: cz }
  }

  return {
    levelId: level.id,
    name: level.name,
    order: level.order,
    baseY,
    ceilingHeightFt: level.ceilingHeightFt,
    walls: interior.build(),
    exteriorWalls: exterior.build(),
    trim: trim.build(),
    glass: glass.build(),
    floor: floor.build(),
    ceiling: ceiling.build(),
    labels,
    collision,
    spawn: largest ? { x: largest.x, z: largest.z } : null,
    roomCount: level.rooms.length,
    wallCount: level.walls.length,
    floorAreaSqft: Math.round(floorAreaSqft),
  }
}

/**
 * The joinery that turns a hole in a wall into a door or a window: jamb posts
 * either side of every opening, a leaf hung ajar on doors, a framed
 * translucent pane on windows. All of it is boxes — same discipline as the
 * walls, no CSG.
 */
function buildOpeningJoinery(
  trim: MeshBuilder,
  glass: MeshBuilder,
  wall: Wall,
  level: Level,
  context: {
    at: (distanceFt: number) => [number, number]
    ux: number
    uy: number
    half: number
    baseY: number
  },
): void {
  const { at, ux, uy, half, baseY } = context
  const length = wallLengthFt(wall)

  for (const opening of level.openings) {
    if (opening.wallId !== wall.id) continue
    const start = Math.max(0, Math.min(length, opening.offsetFt))
    const end = Math.max(0, Math.min(length, opening.offsetFt + opening.widthFt))
    const width = end - start
    if (width < 0.5) continue
    const sill = opening.kind === "door" ? 0 : Math.max(0, opening.sillFt)
    const head = Math.min(level.ceilingHeightFt, Math.max(opening.headFt, sill + 0.5))
    const jambDepth = half + JAMB_PROUD_FT

    // Jamb posts across the wall thickness at both ends of the opening.
    for (const distance of [start + JAMB_WIDTH_FT / 2, end - JAMB_WIDTH_FT / 2]) {
      const [px, pz] = at(distance)
      box(
        trim,
        px - -uy * jambDepth,
        pz - ux * jambDepth,
        px + -uy * jambDepth,
        pz + ux * jambDepth,
        JAMB_WIDTH_FT / 2,
        baseY + sill,
        baseY + head,
      )
    }
    // Head trim over the opening.
    {
      const [x0, z0] = at(start)
      const [x1, z1] = at(end)
      box(trim, x0, z0, x1, z1, jambDepth, baseY + head, baseY + head + 0.12)
    }

    if (opening.kind === "door") {
      // Leaf hung on the start jamb, swung part-open into the roomward side.
      const [hx, hz] = at(start + JAMB_WIDTH_FT)
      const swing = doorSwingSign(wall, level, start + width / 2)
      const cos = Math.cos(DOOR_SWING_RAD * swing)
      const sin = Math.sin(DOOR_SWING_RAD * swing)
      const dx = ux * cos - uy * sin
      const dy = uy * cos + ux * sin
      const leaf = Math.max(0.5, width - JAMB_WIDTH_FT * 2)
      box(
        trim,
        hx,
        hz,
        hx + dx * leaf,
        hz + dy * leaf,
        DOOR_LEAF_THICKNESS_FT / 2,
        baseY + 0.05,
        baseY + head - 0.08,
      )
    } else if (opening.kind === "window") {
      const [x0, z0] = at(start)
      const [x1, z1] = at(end)
      // Sill board, slightly proud of both faces.
      box(trim, x0, z0, x1, z1, half + 0.1, baseY + sill - 0.1, baseY + sill + 0.05)
      // The pane itself.
      box(
        glass,
        x0,
        z0,
        x1,
        z1,
        GLASS_THICKNESS_FT / 2,
        baseY + sill + 0.05,
        baseY + head - 0.05,
      )
    }
  }
}

/** Swing a door toward a side that is inside a room; +1 when unknowable. */
function doorSwingSign(wall: Wall, level: Level, atFt: number): 1 | -1 {
  if (level.rooms.length === 0) return 1
  const { ux, uy } = wallDirection(wall)
  const px = wall.x0 + ux * atFt
  const py = wall.y0 + uy * atFt
  const probe = wall.thicknessFt / 2 + 1.2
  const positive: [number, number] = [px - uy * probe, py + ux * probe]
  if (level.rooms.some((room) => pointInPolygon(positive, room.polygon))) return 1
  const negative: [number, number] = [px + uy * probe, py - ux * probe]
  if (level.rooms.some((room) => pointInPolygon(negative, room.polygon))) return -1
  return 1
}

// ---------------------------------------------------------------------------
// Walk-mode collision
// ---------------------------------------------------------------------------

/** Body radius in feet — a shoulder-width capsule, not a point. */
export const WALK_RADIUS_FT = 0.9

/**
 * Slide a walker along the walls it runs into.
 *
 * Resolving each overlap by pushing straight out along the wall's normal, one
 * wall at a time, is what makes a corner feel right: you slide along the wall
 * you are pressed against instead of stopping dead or shooting through it.
 * Two passes settle the corner case where the first push creates a second
 * overlap.
 */
export function resolveWalkCollision(
  from: { x: number; z: number },
  to: { x: number; z: number },
  segments: CollisionSegment[],
): { x: number; z: number } {
  let x = to.x
  let z = to.z
  for (let pass = 0; pass < 2; pass++) {
    let moved = false
    for (const segment of segments) {
      const dx = segment.x1 - segment.x0
      const dz = segment.z1 - segment.z0
      const lenSq = dx * dx + dz * dz
      if (lenSq < 1e-9) continue
      const t = Math.min(1, Math.max(0, ((x - segment.x0) * dx + (z - segment.z0) * dz) / lenSq))
      const px = segment.x0 + t * dx
      const pz = segment.z0 + t * dz
      const offsetX = x - px
      const offsetZ = z - pz
      const distance = Math.hypot(offsetX, offsetZ)
      const clearance = segment.halfThickness + WALK_RADIUS_FT
      if (distance >= clearance) continue

      if (distance < 1e-6) {
        // Dead centre in a wall (only reachable by spawning badly): back out
        // the way we came rather than picking an arbitrary direction.
        const backX = from.x - px
        const backZ = from.z - pz
        const backLength = Math.hypot(backX, backZ) || 1
        x = px + (backX / backLength) * clearance
        z = pz + (backZ / backLength) * clearance
      } else {
        x = px + (offsetX / distance) * clearance
        z = pz + (offsetZ / distance) * clearance
      }
      moved = true
    }
    if (!moved) break
  }
  return { x, z }
}
