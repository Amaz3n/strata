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
  wallDirection,
  wallLengthFt,
  wallSolidSpans,
  type FloorplanModel,
  type Level,
  type Wall,
  type WallSpan,
} from "@/lib/drawings/floorplan-model";
import {
  interiorPoint,
  triangulatePolygon,
} from "@/lib/drawings/architectural-polygon";
import type {
  BuildingObject,
  SurfaceFinish,
} from "@/lib/drawings/architectural-model";

/** Gap between stacked levels — the floor assembly a plan never draws. */
export const FLOOR_ASSEMBLY_FT = 1;
/** Slab thickness under each level, so a floor reads as a solid, not a plane. */
const SLAB_THICKNESS_FT = 0.35;
/** Eye height for walk mode: a 5'6" viewpoint reads as "standing in it". */
export const EYE_HEIGHT_FT = 5.5;
/**
 * Dollhouse cut height above a floor. Chest height, not waist: door leaves and
 * window sills stay in the cut so the rooms still read as rooms, while
 * everything that hides the plan from above is gone.
 */
export const DOLLHOUSE_CUT_FT = 4.2;

/** Door leaves render slightly ajar — a closed door reads as a wall. */
const DOOR_SWING_RAD = Math.PI * 0.24;
const DOOR_LEAF_THICKNESS_FT = 0.12;
/** Jamb posts flank every opening, slightly proud of the wall face. */
const JAMB_WIDTH_FT = 0.16;
const JAMB_PROUD_FT = 0.06;
const GLASS_THICKNESS_FT = 0.06;
/** Generated finish carpentry: a 4½" base, 3½" casings, a ¾" proud face. */
const BASEBOARD_HEIGHT_FT = 0.375;
const BASEBOARD_THICKNESS_FT = 0.06;
const CASING_WIDTH_FT = 0.29;
const CASING_PROUD_FT = 0.05;
const PANEL_INSET_FT = 0.28;
const PANEL_RAISE_FT = 0.025;

/**
 * A wall piece blocks walking when it rises from below chest height: full
 * walls and window sills stop the capsule, door and cased-opening headers do
 * not — which is what finally lets walk mode pass through a doorway.
 */
const BLOCKING_BOTTOM_FT = 3.5;
const BLOCKING_MIN_TOP_FT = 1.5;

export interface MeshData {
  uvs?: Float32Array;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Per-vertex RGB, present only on meshes that tint by room (floors). */
  colors?: Float32Array;
}

export interface RoomLabelAnchor {
  id: string;
  text: string;
  areaSqft: number;
  /** World position of the label billboard. */
  x: number;
  y: number;
  z: number;
  /** World Y of the floor surface, for labels painted onto it. */
  floorY: number;
  /** Rotation about Y for a floor-painted label — along the room's long axis. */
  angle: number;
  /** Widest a floor-painted label can be without leaving the room, in feet. */
  fitFt: number;
}

/** A wall footprint in world XZ, for capsule collision in walk mode. */
export interface CollisionSegment {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  halfThickness: number;
}

export interface LevelGeometry {
  surfaces: Array<{
    id: string;
    kind: "wall" | "room" | "object" | "roof";
    mesh: MeshData;
    finish?: SurfaceFinish;
    color?: string;
  }>;
  walkable: Array<{
    polygon: Array<[number, number]>;
    holes: Array<Array<[number, number]>>;
  }>;
  levelId: string;
  name: string;
  order: number;
  /** World Y of this level's floor surface. */
  baseY: number;
  ceilingHeightFt: number;
  /** Interior partitions. */
  walls: MeshData;
  /** Perimeter walls — rendered a shade darker so the envelope reads. */
  exteriorWalls: MeshData;
  /** Door leaves, jambs and window frames — the painted joinery. */
  trim: MeshData;
  /**
   * Finish carpentry: baseboards, casings, raised door panels. Separate from
   * `trim` so the scene can drop it at a distance, where it is sub-pixel.
   */
  detail: MeshData;
  /** Window panes, rendered translucent. */
  glass: MeshData;
  floor: MeshData;
  ceiling: MeshData;
  labels: RoomLabelAnchor[];
  collision: CollisionSegment[];
  /** A point known to be inside the largest room — where walk mode starts. */
  spawn: { x: number; z: number } | null;
  roomCount: number;
  wallCount: number;
  floorAreaSqft: number;
}

export interface SceneGeometry {
  levels: LevelGeometry[];
  /** Footprint half-extent in feet, for framing the orbit camera. */
  radiusFt: number;
  widthFt: number;
  depthFt: number;
  totalFloorAreaSqft: number;
  /** Plan point (after placement) that world (0, 0) sits on. */
  centerX: number;
  centerY: number;
}

// ---------------------------------------------------------------------------
// Mesh assembly
// ---------------------------------------------------------------------------

class MeshBuilder {
  private positions: number[] = [];
  private normals: number[] = [];
  private indices: number[] = [];
  private colors: number[] | null;

  constructor(withColors = false) {
    this.colors = withColors ? [] : null;
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
    const base = this.positions.length / 3;
    for (const point of [a, b, c, d]) {
      this.positions.push(point[0], point[1], point[2]);
      this.normals.push(normal[0], normal[1], normal[2]);
      if (this.colors) this.colors.push(...(color ?? [1, 1, 1]));
    }
    this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** Add a horizontal polygon at height `y`, fan-triangulated from a point. */
  polygonFan(
    points: Array<[number, number]>,
    y: number,
    up: boolean,
    color?: [number, number, number],
    holes: Array<Array<[number, number]>> = [],
  ): void {
    if (points.length < 3) return;
    const triangulated = triangulatePolygon(points, holes);
    const base = this.positions.length / 3;
    const normal: [number, number, number] = up ? [0, 1, 0] : [0, -1, 0];
    for (const [x, z] of triangulated.points) {
      this.positions.push(x, y, z);
      this.normals.push(...normal);
      if (this.colors) this.colors.push(...(color ?? [1, 1, 1]));
    }
    for (let i = 0; i < triangulated.indices.length; i += 3) {
      const [a, b, c] = triangulated.indices.slice(i, i + 3);
      if (up) this.indices.push(base + a, base + c, base + b);
      else this.indices.push(base + a, base + b, base + c);
    }
  }

  build(): MeshData {
    const uvs: number[] = [];
    for (let i = 0; i < this.positions.length; i += 3) {
      const [x, y, z] = this.positions.slice(i, i + 3);
      const [nx, ny, nz] = this.normals.slice(i, i + 3);
      uvs.push(
        Math.abs(ny) > 0.5 ? x : Math.abs(nx) > Math.abs(nz) ? z : x,
        Math.abs(ny) > 0.5 ? z : y,
      );
    }
    return {
      uvs: Float32Array.from(uvs),
      positions: Float32Array.from(this.positions),
      normals: Float32Array.from(this.normals),
      indices: Uint32Array.from(this.indices),
      ...(this.colors ? { colors: Float32Array.from(this.colors) } : {}),
    };
  }

  get isEmpty(): boolean {
    return this.indices.length === 0;
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
  const dx = x1 - x0;
  const dz = z1 - z0;
  const length = Math.hypot(dx, dz);
  if (!(length > 0) || topY - bottomY <= 0.001) return;
  const ux = dx / length;
  const uz = dz / length;
  const nx = -uz * halfThickness;
  const nz = ux * halfThickness;

  // Four corners of the footprint, in order around the rectangle.
  const p00: [number, number] = [x0 + nx, z0 + nz];
  const p01: [number, number] = [x1 + nx, z1 + nz];
  const p11: [number, number] = [x1 - nx, z1 - nz];
  const p10: [number, number] = [x0 - nx, z0 - nz];

  const at = (p: [number, number], y: number): [number, number, number] => [
    p[0],
    y,
    p[1],
  ];

  builder.quad(
    at(p00, bottomY),
    at(p01, bottomY),
    at(p01, topY),
    at(p00, topY),
    [-uz, 0, ux],
  );
  builder.quad(
    at(p11, bottomY),
    at(p10, bottomY),
    at(p10, topY),
    at(p11, topY),
    [uz, 0, -ux],
  );
  builder.quad(
    at(p01, bottomY),
    at(p11, bottomY),
    at(p11, topY),
    at(p01, topY),
    [ux, 0, uz],
  );
  builder.quad(
    at(p10, bottomY),
    at(p00, bottomY),
    at(p00, topY),
    at(p10, topY),
    [-ux, 0, -uz],
  );
  builder.quad(
    at(p00, topY),
    at(p01, topY),
    at(p11, topY),
    at(p10, topY),
    [0, 1, 0],
  );
  builder.quad(
    at(p10, bottomY),
    at(p11, bottomY),
    at(p01, bottomY),
    at(p00, bottomY),
    [0, -1, 0],
  );
}

// ---------------------------------------------------------------------------
// Room floor tint
// ---------------------------------------------------------------------------

function rgb(hex: number): [number, number, number] {
  return [
    ((hex >> 16) & 0xff) / 255,
    ((hex >> 8) & 0xff) / 255,
    (hex & 0xff) / 255,
  ];
}

const FLOOR_BASE = rgb(0xcfccc5);
const FLOOR_WOOD = rgb(0xd9cbb0);
const FLOOR_TILE = rgb(0xc5cdd2);
const FLOOR_CONCRETE = rgb(0xbcb9b2);
const FLOOR_OUTDOOR = rgb(0xc7c2b7);

/**
 * A subtle material read per room type, keyed off the label the interpreter
 * already extracted: wet rooms cool, garages concrete, living spaces warm.
 * Unnamed rooms keep the neutral base — the tint is information, and a room
 * we know nothing about must not pretend otherwise.
 */
export function roomFloorTint(label: string | null): [number, number, number] {
  if (!label) return FLOOR_BASE;
  const name = label.toUpperCase();
  if (/BATH|KITCHEN|LAUNDRY|UTILITY|POWDER|MUD|PANTRY|W\.?C\b/.test(name))
    return FLOOR_TILE;
  if (/GARAGE|CARPORT|STORAGE|MECH|SHOP/.test(name)) return FLOOR_CONCRETE;
  if (/LANAI|PORCH|PATIO|DECK|BALCON|TERRACE/.test(name)) return FLOOR_OUTDOOR;
  return FLOOR_WOOD;
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
  if (rooms.length === 0) return false;
  const { ux, uy } = wallDirection(wall);
  const midX = (wall.x0 + wall.x1) / 2;
  const midY = (wall.y0 + wall.y1) / 2;
  const probe = wall.thicknessFt / 2 + 0.8;
  const sideA: [number, number] = [midX - uy * probe, midY + ux * probe];
  const sideB: [number, number] = [midX + uy * probe, midY - ux * probe];
  const insideA = rooms.some((room) => pointInPolygon(sideA, room.polygon));
  const insideB = rooms.some((room) => pointInPolygon(sideB, room.polygon));
  return insideA !== insideB;
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
  const placed = model.levels.map(placeLevel);
  const all = placed.map((level) => levelBounds(level));
  const minX = Math.min(...all.map((bounds) => bounds.minX), 0);
  const minY = Math.min(...all.map((bounds) => bounds.minY), 0);
  const maxX = Math.max(...all.map((bounds) => bounds.maxX), 0);
  const maxY = Math.max(...all.map((bounds) => bounds.maxY), 0);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  const ordered = [...placed].sort((a, b) => a.order - b.order);
  let baseY = 0;
  const levels: LevelGeometry[] = [];
  for (const level of ordered) {
    baseY = level.placement?.elevationFt ?? baseY;
    levels.push(buildLevelGeometry(level, { centerX, centerY, baseY }));
    baseY +=
      level.ceilingHeightFt +
      (level.placement?.assemblyFt ?? FLOOR_ASSEMBLY_FT);
  }

  const widthFt = maxX - minX;
  const depthFt = maxY - minY;
  return {
    levels,
    radiusFt: Math.max(10, Math.hypot(widthFt, depthFt) / 2),
    widthFt,
    depthFt,
    totalFloorAreaSqft: levels.reduce(
      (total, level) => total + level.floorAreaSqft,
      0,
    ),
    centerX,
    centerY,
  };
}

/**
 * World XZ → the level's own plan feet: the exact inverse of `placeLevel`
 * followed by the scene centring. Furniture dragged in 3D is saved through
 * this, so a sofa lands where it was dropped whatever the level's registration.
 */
export function worldToLevelPoint(
  level: Level,
  scene: Pick<SceneGeometry, "centerX" | "centerY">,
  x: number,
  z: number,
): [number, number] {
  const px = x + scene.centerX;
  const py = z + scene.centerY;
  const p = level.placement;
  if (!p) return [px, py];
  const angle = (-p.rotationDeg * Math.PI) / 180,
    c = Math.cos(angle),
    s = Math.sin(angle);
  const dx = px - p.xFt,
    dy = py - p.yFt;
  return [dx * c - dy * s, dx * s + dy * c];
}

export function buildLevelGeometry(
  level: Level,
  frame: { centerX: number; centerY: number; baseY: number },
): LevelGeometry {
  const interior = new MeshBuilder();
  const exterior = new MeshBuilder();
  const trim = new MeshBuilder();
  const detail = new MeshBuilder();
  const glass = new MeshBuilder();
  const floor = new MeshBuilder(true);
  const ceiling = new MeshBuilder();
  const collision: CollisionSegment[] = [];
  const surfaces: LevelGeometry["surfaces"] = [];
  const walkable: LevelGeometry["walkable"] = [];
  const { centerX, centerY, baseY } = frame;
  const toWorld = (x: number, y: number): [number, number] => [
    x - centerX,
    y - centerY,
  ];

  for (const wall of level.walls) {
    const surface = new MeshBuilder();
    const length = wallLengthFt(wall);
    if (!(length > 0)) continue;
    const { ux, uy } = wallDirection(wall);
    const half = Math.max(0.1, wall.thicknessFt) / 2;
    const walls = wallIsExterior(wall, level.rooms) ? exterior : interior;
    const at = (distanceFt: number): [number, number] =>
      toWorld(wall.x0 + ux * distanceFt, wall.y0 + uy * distanceFt);

    const spans = wallSolidSpans(
      wall,
      level.openings,
      wall.heightFt ?? level.ceilingHeightFt,
    );
    for (const span of spans) {
      const [x0, z0] = at(span.startFt);
      const [x1, z1] = at(span.endFt);
      box(
        walls,
        x0,
        z0,
        x1,
        z1,
        half,
        baseY + span.bottomFt,
        baseY + span.topFt,
      );
      box(
        surface,
        x0,
        z0,
        x1,
        z1,
        half,
        baseY + span.bottomFt,
        baseY + span.topFt,
      );
    }
    surfaces.push({
      id: wall.id,
      kind: "wall",
      mesh: surface.build(),
      finish: wall.finish,
    });

    // Collision follows the built solids, not the drawn centerline: a piece
    // that rises from below chest height blocks the capsule, a door header
    // does not — walking through a doorway works because the doorway is a
    // genuine gap in what got built.
    const blocking: Array<[number, number]> = spans
      .filter(
        (span) =>
          span.bottomFt < BLOCKING_BOTTOM_FT &&
          span.topFt > BLOCKING_MIN_TOP_FT,
      )
      .map((span): [number, number] => [span.startFt, span.endFt])
      .sort((a, b) => a[0] - b[0]);
    let interval: [number, number] | null = null;
    const flush = () => {
      if (!interval) return;
      const [start, end] = interval;
      const [x0, z0] = at(start);
      const [x1, z1] = at(end);
      collision.push({ x0, z0, x1, z1, halfThickness: half });
      interval = null;
    };
    for (const [start, end] of blocking) {
      if (interval && start <= interval[1] + 0.05)
        interval[1] = Math.max(interval[1], end);
      else {
        flush();
        interval = [start, end];
      }
    }
    flush();

    // Room boundaries from takeoff stop at wall faces. Bridge only the real
    // doorway threshold so walking can cross between those room polygons.
    for (const opening of level.openings.filter(
      (o) => o.wallId === wall.id && o.kind !== "window" && o.sillFt === 0,
    )) {
      const mid = opening.offsetFt + opening.widthFt / 2;
      const cx = wall.x0 + ux * mid,
        cy = wall.y0 + uy * mid;
      if (
        ![1, -1].every((side) =>
          level.rooms.some((room) =>
            pointInPolygon(
              [cx - uy * (half + 0.02) * side, cy + ux * (half + 0.02) * side],
              room.polygon,
            ),
          ),
        )
      )
        continue;
      const a = at(opening.offsetFt),
        b = at(opening.offsetFt + opening.widthFt);
      const depth = half + 0.02;
      const polygon: Array<[number, number]> = [
        [a[0] - uy * depth, a[1] + ux * depth],
        [b[0] - uy * depth, b[1] + ux * depth],
        [b[0] + uy * depth, b[1] - ux * depth],
        [a[0] + uy * depth, a[1] - ux * depth],
      ];
      walkable.push({ polygon, holes: [] });
      floor.polygonFan(polygon, baseY, true);
    }
    buildOpeningJoinery(trim, detail, glass, wall, level, { at, ux, uy, half, baseY });
    buildBaseboards(detail, wall, level, spans, { at, ux, uy, half, baseY });
  }

  const labels: RoomLabelAnchor[] = [];
  let floorAreaSqft = 0;
  let largest: { area: number; x: number; z: number } | null = null;

  for (const room of level.rooms) {
    const ring = room.polygon.map(([x, y]) => toWorld(x, y));
    const holes = (room.holes ?? []).map((h) =>
      h.map(([x, y]) => toWorld(x, y)),
    );
    walkable.push({ polygon: ring, holes });
    if (ring.length < 3) continue;
    const area =
      polygonArea(ring) - holes.reduce((sum, h) => sum + polygonArea(h), 0);
    floorAreaSqft += area;
    const tint = roomFloorTint(room.label);

    // A slab under the room, not a plane: seen from the floor below, a
    // zero-thickness surface disappears entirely at grazing angles.
    floor.polygonFan(ring, baseY, true, tint, holes);
    floor.polygonFan(ring, baseY - SLAB_THICKNESS_FT, false, tint, holes);
    const roomSurface = new MeshBuilder(true);
    roomSurface.polygonFan(
      ring,
      baseY + 0.002,
      true,
      room.finish ? [1, 1, 1] : tint,
      holes,
    );
    surfaces.push({
      id: room.id,
      kind: "room",
      mesh: roomSurface.build(),
      finish: room.finish,
    });
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const edge = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (edge < 1e-6) continue;
      const ux = (b[0] - a[0]) / edge;
      const uz = (b[1] - a[1]) / edge;
      floor.quad(
        [a[0], baseY - SLAB_THICKNESS_FT, a[1]],
        [b[0], baseY - SLAB_THICKNESS_FT, b[1]],
        [b[0], baseY, b[1]],
        [a[0], baseY, a[1]],
        [uz, 0, -ux],
        tint,
      );
    }
    ceiling.polygonFan(
      ring,
      baseY + (room.ceilingHeightFt ?? level.ceilingHeightFt),
      false,
      undefined,
      holes,
    );

    const [cx, cz] = interiorPoint(ring, holes);
    if (room.label) {
      const bounds = boundsOf(ring);
      const width = bounds.maxX - bounds.minX;
      const depth = bounds.maxY - bounds.minY;
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
        fitFt: Math.max(
          3,
          Math.min(
            14,
            Math.max(width, depth) * 0.7,
            Math.min(width, depth) * 1.6,
          ),
        ),
      });
    }
    if (!largest || area > largest.area) largest = { area, x: cx, z: cz };
  }

  for (const object of level.objects ?? []) {
    const mesh = buildObject(object, baseY, centerX, centerY);
    surfaces.push({ id: object.id, kind: "object", mesh, color: object.color });
  }
  if (level.roof)
    surfaces.push({
      id: "roof",
      kind: "roof",
      mesh: buildRoof(level, frame),
      color: level.roof.color,
    });
  return {
    surfaces,
    walkable,
    levelId: level.id,
    name: level.name,
    order: level.order,
    baseY,
    ceilingHeightFt: level.ceilingHeightFt,
    walls: interior.build(),
    exteriorWalls: exterior.build(),
    trim: trim.build(),
    detail: detail.build(),
    glass: glass.build(),
    floor: floor.build(),
    ceiling: ceiling.build(),
    labels,
    collision,
    spawn: largest ? { x: largest.x, z: largest.z } : null,
    roomCount: level.rooms.length,
    wallCount: level.walls.length,
    floorAreaSqft: Math.round(floorAreaSqft),
  };
}

/**
 * The joinery that turns a hole in a wall into a door or a window: jamb posts
 * either side of every opening, a leaf hung ajar on doors, a framed
 * translucent pane on windows. All of it is boxes — same discipline as the
 * walls, no CSG.
 */
function buildOpeningJoinery(
  trim: MeshBuilder,
  detail: MeshBuilder,
  glass: MeshBuilder,
  wall: Wall,
  level: Level,
  context: {
    at: (distanceFt: number) => [number, number];
    ux: number;
    uy: number;
    half: number;
    baseY: number;
  },
): void {
  const { at, ux, uy, half, baseY } = context;
  const length = wallLengthFt(wall);

  for (const opening of level.openings) {
    if (opening.wallId !== wall.id) continue;
    const start = Math.max(0, Math.min(length, opening.offsetFt));
    const end = Math.max(
      0,
      Math.min(length, opening.offsetFt + opening.widthFt),
    );
    const width = end - start;
    if (width < 0.5) continue;
    const sill = opening.kind === "door" ? 0 : Math.max(0, opening.sillFt);
    const head = Math.min(
      wall.heightFt ?? level.ceilingHeightFt,
      Math.max(opening.headFt, sill + 0.5),
    );
    const jambDepth = half + JAMB_PROUD_FT;

    // Jamb posts across the wall thickness at both ends of the opening.
    for (const distance of [
      start + JAMB_WIDTH_FT / 2,
      end - JAMB_WIDTH_FT / 2,
    ]) {
      const [px, pz] = at(distance);
      box(
        trim,
        px - -uy * jambDepth,
        pz - ux * jambDepth,
        px + -uy * jambDepth,
        pz + ux * jambDepth,
        JAMB_WIDTH_FT / 2,
        baseY + sill,
        baseY + head,
      );
    }
    // Head trim over the opening.
    {
      const [x0, z0] = at(start);
      const [x1, z1] = at(end);
      box(trim, x0, z0, x1, z1, jambDepth, baseY + head, baseY + head + 0.12);
    }
    // Casings on every face that looks into a room: two legs and a head.
    for (const side of roomSides(wall, level, start + width / 2)) {
      const offset = (half + CASING_PROUD_FT / 2) * side;
      const face = (distance: number): [number, number] => {
        const [px, pz] = at(distance);
        return [px - uy * offset, pz + ux * offset];
      };
      const legs = opening.kind === "window" ? sill - 0.1 : 0;
      for (const [from, to] of [
        [start - CASING_WIDTH_FT, start],
        [end, end + CASING_WIDTH_FT],
      ]) {
        const [x0, z0] = face(from);
        const [x1, z1] = face(to);
        box(detail, x0, z0, x1, z1, CASING_PROUD_FT / 2, baseY + legs, baseY + head + CASING_WIDTH_FT);
      }
      const [x0, z0] = face(start - CASING_WIDTH_FT);
      const [x1, z1] = face(end + CASING_WIDTH_FT);
      box(detail, x0, z0, x1, z1, CASING_PROUD_FT / 2, baseY + head, baseY + head + CASING_WIDTH_FT);
    }

    if (opening.kind === "door") {
      const style = opening.style ?? "hinged";
      const leaf = Math.max(0.5, width - JAMB_WIDTH_FT * 2);
      const swing =
        doorSwingSign(wall, level, start + width / 2) *
        (opening.swing === "out" ? -1 : 1);
      const makeLeaf = (right: boolean, leafWidth: number) => {
        const [hx, hz] = at(
          right ? end - JAMB_WIDTH_FT : start + JAMB_WIDTH_FT,
        );
        const direction = right ? -1 : 1;
        const angle = DOOR_SWING_RAD * swing * direction;
        const dx = direction * (ux * Math.cos(angle) - uy * Math.sin(angle));
        const dy = direction * (uy * Math.cos(angle) + ux * Math.sin(angle));
        box(
          trim,
          hx,
          hz,
          hx + dx * leafWidth,
          hz + dy * leafWidth,
          DOOR_LEAF_THICKNESS_FT / 2,
          baseY + 0.05,
          baseY + head - 0.08,
        );
        // Two raised panels, proud of both faces of the leaf.
        if (leafWidth > PANEL_INSET_FT * 3) {
          const leafHeight = head - 0.13;
          for (const [bottom, top] of [
            [0.1, 0.46],
            [0.54, 0.9],
          ]) {
            box(
              detail,
              hx + dx * PANEL_INSET_FT,
              hz + dy * PANEL_INSET_FT,
              hx + dx * (leafWidth - PANEL_INSET_FT),
              hz + dy * (leafWidth - PANEL_INSET_FT),
              DOOR_LEAF_THICKNESS_FT / 2 + PANEL_RAISE_FT,
              baseY + 0.05 + leafHeight * bottom,
              baseY + 0.05 + leafHeight * top,
            );
          }
        }
      };
      if (style === "hinged") makeLeaf(opening.handing === "right", leaf);
      else if (style === "double") {
        makeLeaf(false, leaf / 2);
        makeLeaf(true, leaf / 2);
      } else if (style === "garage") {
        const [x0, z0] = at(start),
          [x1, z1] = at(end);
        box(
          trim,
          x0,
          z0,
          x1,
          z1,
          Math.max(half, head / 2),
          baseY + head - 0.08,
          baseY + head,
        );
      } else if (style !== "pocket") {
        const [x0, z0] = at(start + JAMB_WIDTH_FT),
          [x1, z1] = at(end - JAMB_WIDTH_FT);
        box(
          style === "fixed" ? glass : trim,
          x0,
          z0,
          x1,
          z1,
          DOOR_LEAF_THICKNESS_FT / 2,
          baseY + 0.05,
          baseY + head - 0.08,
        );
        if (style === "sliding") {
          const [mx, mz] = at(start + width / 2);
          box(
            trim,
            mx,
            mz,
            x1,
            z1,
            DOOR_LEAF_THICKNESS_FT,
            baseY + 0.05,
            baseY + head - 0.08,
          );
        }
      }
    } else if (opening.kind === "window") {
      const [x0, z0] = at(start);
      const [x1, z1] = at(end);
      // Sill board, slightly proud of both faces.
      box(
        trim,
        x0,
        z0,
        x1,
        z1,
        half + 0.1,
        baseY + sill - 0.1,
        baseY + sill + 0.05,
      );
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
      );
    }
  }
}

/** Which faces of a wall (+1 left of its run, −1 right) look into a room at a point along it. */
function roomSides(wall: Wall, level: Level, atFt: number): Array<1 | -1> {
  const { ux, uy } = wallDirection(wall);
  const px = wall.x0 + ux * atFt;
  const py = wall.y0 + uy * atFt;
  const probe = wall.thicknessFt / 2 + 0.6;
  const sides: Array<1 | -1> = [];
  for (const side of [1, -1] as const) {
    const point: [number, number] = [px - uy * probe * side, py + ux * probe * side];
    if (level.rooms.some((room) => pointInPolygon(point, room.polygon))) sides.push(side);
  }
  return sides;
}

/**
 * A baseboard along every stretch of wall that meets the floor, on each face
 * that looks into a room. Doorways are already gaps in the spans, so the base
 * stops at them by construction; under a window it runs straight through.
 */
function buildBaseboards(
  detail: MeshBuilder,
  wall: Wall,
  level: Level,
  spans: WallSpan[],
  context: {
    at: (distanceFt: number) => [number, number];
    ux: number;
    uy: number;
    half: number;
    baseY: number;
  },
): void {
  const { at, ux, uy, half, baseY } = context;
  for (const span of spans) {
    if (span.bottomFt > 0.01 || span.endFt - span.startFt < 0.25) continue;
    for (const side of roomSides(wall, level, (span.startFt + span.endFt) / 2)) {
      const offset = (half + BASEBOARD_THICKNESS_FT / 2) * side;
      const [ax, az] = at(span.startFt);
      const [bx, bz] = at(span.endFt);
      box(
        detail,
        ax - uy * offset,
        az + ux * offset,
        bx - uy * offset,
        bz + ux * offset,
        BASEBOARD_THICKNESS_FT / 2,
        baseY,
        baseY + Math.min(BASEBOARD_HEIGHT_FT, span.topFt),
      );
    }
  }
}

/** Swing a door toward a side that is inside a room; +1 when unknowable. */
function doorSwingSign(wall: Wall, level: Level, atFt: number): 1 | -1 {
  if (level.rooms.length === 0) return 1;
  const { ux, uy } = wallDirection(wall);
  const px = wall.x0 + ux * atFt;
  const py = wall.y0 + uy * atFt;
  const probe = wall.thicknessFt / 2 + 1.2;
  const positive: [number, number] = [px - uy * probe, py + ux * probe];
  if (level.rooms.some((room) => pointInPolygon(positive, room.polygon)))
    return 1;
  const negative: [number, number] = [px + uy * probe, py - ux * probe];
  if (level.rooms.some((room) => pointInPolygon(negative, room.polygon)))
    return -1;
  return 1;
}

// ---------------------------------------------------------------------------
// Walk-mode collision
// ---------------------------------------------------------------------------

/** Body radius in feet — a shoulder-width capsule, not a point. */
export const WALK_RADIUS_FT = 0.9;

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
  let x = to.x;
  let z = to.z;
  for (let pass = 0; pass < 2; pass++) {
    let moved = false;
    for (const segment of segments) {
      const dx = segment.x1 - segment.x0;
      const dz = segment.z1 - segment.z0;
      const lenSq = dx * dx + dz * dz;
      if (lenSq < 1e-9) continue;
      const t = Math.min(
        1,
        Math.max(0, ((x - segment.x0) * dx + (z - segment.z0) * dz) / lenSq),
      );
      const px = segment.x0 + t * dx;
      const pz = segment.z0 + t * dz;
      const offsetX = x - px;
      const offsetZ = z - pz;
      const distance = Math.hypot(offsetX, offsetZ);
      const clearance = segment.halfThickness + WALK_RADIUS_FT;
      if (distance >= clearance) continue;

      if (distance < 1e-6) {
        // Dead centre in a wall (only reachable by spawning badly): back out
        // the way we came rather than picking an arbitrary direction.
        const backX = from.x - px;
        const backZ = from.z - pz;
        const backLength = Math.hypot(backX, backZ) || 1;
        x = px + (backX / backLength) * clearance;
        z = pz + (backZ / backLength) * clearance;
      } else {
        x = px + (offsetX / distance) * clearance;
        z = pz + (offsetZ / distance) * clearance;
      }
      moved = true;
    }
    if (!moved) break;
  }
  return { x, z };
}

/** Explicit registration, shared by all derived surfaces and object positions. */
export function placeLevel(level: Level): Level {
  const p = level.placement;
  if (!p) return level;
  const angle = (p.rotationDeg * Math.PI) / 180,
    c = Math.cos(angle),
    s = Math.sin(angle);
  const point = ([x, y]: [number, number]): [number, number] => [
    x * c - y * s + p.xFt,
    x * s + y * c + p.yFt,
  ];
  return {
    ...level,
    walls: level.walls.map((w) => {
      const a = point([w.x0, w.y0]),
        b = point([w.x1, w.y1]);
      return { ...w, x0: a[0], y0: a[1], x1: b[0], y1: b[1] };
    }),
    rooms: level.rooms.map((r) => ({
      ...r,
      polygon: r.polygon.map(point),
      holes: r.holes?.map((h) => h.map(point)),
    })),
    objects: level.objects?.map((o) => {
      const [xFt, yFt] = point([o.xFt, o.yFt]);
      return { ...o, xFt, yFt, rotationDeg: o.rotationDeg + p.rotationDeg };
    }),
  };
}

/** Compact procedural catalogue: real dimensions, editable parts, no network assets. */
function buildObject(
  o: BuildingObject,
  baseY: number,
  centerX: number,
  centerY: number,
): MeshData {
  const mesh = new MeshBuilder();
  const angle = (o.rotationDeg * Math.PI) / 180,
    c = Math.cos(angle),
    s = Math.sin(angle);
  const at = (x: number, z: number): [number, number] => [
    o.xFt - centerX + x * c - z * s,
    o.yFt - centerY + x * s + z * c,
  ];
  const block = (
    x: number,
    z: number,
    w: number,
    d: number,
    bottom: number,
    top: number,
  ) => {
    const a = at(x - w / 2, z),
      b = at(x + w / 2, z);
    box(
      mesh,
      a[0],
      a[1],
      b[0],
      b[1],
      d / 2,
      baseY + o.elevationFt + bottom,
      baseY + o.elevationFt + top,
    );
  };
  const { widthFt: w, depthFt: d, heightFt: h } = o;
  if (o.kind === "stairs") {
    const steps = Math.max(2, Math.ceil(h / (7 / 12)));
    for (let i = 0; i < steps; i++)
      block(
        0,
        -d / 2 + (d * (i + 0.5)) / steps,
        w,
        d / steps,
        0,
        (h * (i + 1)) / steps,
      );
  } else if (o.kind === "table" || o.kind === "chair") {
    const seat = o.kind === "chair" ? h * 0.52 : h;
    block(0, 0, w, d, seat - 0.15, seat);
    for (const x of [-w / 2 + 0.15, w / 2 - 0.15])
      for (const z of [-d / 2 + 0.15, d / 2 - 0.15])
        block(x, z, 0.15, 0.15, 0, seat - 0.15);
    if (o.kind === "chair") block(0, d / 2 - 0.1, w, 0.2, seat, h);
  } else if (o.kind === "sofa" || o.kind === "bed") {
    block(0, 0, w, d, 0.2, h * 0.65);
    block(0, d / 2 - 0.2, w, 0.4, 0, h);
    if (o.kind === "sofa")
      for (const x of [-w / 2 + 0.25, w / 2 - 0.25])
        block(x, 0, 0.5, d, 0.2, h * 0.9);
    else
      for (const x of [-w / 4, w / 4])
        block(x, d / 2 - 0.9, w * 0.4, 1, h * 0.65, h * 0.8);
  } else if (o.kind === "tub" || o.kind === "sink") {
    block(0, 0, w, d, 0, h * 0.3);
    for (const x of [-w / 2 + 0.1, w / 2 - 0.1])
      block(x, 0, 0.2, d, h * 0.3, h);
    for (const z of [-d / 2 + 0.1, d / 2 - 0.1])
      block(0, z, w, 0.2, h * 0.3, h);
  } else if (o.kind === "toilet") {
    block(0, d * 0.3, w * 0.8, d * 0.35, 0, h);
    block(0, -d * 0.1, w, d * 0.65, 0, h * 0.6);
  } else {
    block(0, 0, w, d, 0, h);
    if (o.kind === "cabinet" || o.kind === "counter")
      block(0, 0, w + 0.12, d + 0.12, h, h + 0.1);
  }
  return mesh.build();
}

function buildRoof(
  level: Level,
  frame: { centerX: number; centerY: number; baseY: number },
): MeshData {
  const mesh = new MeshBuilder(),
    roof = level.roof!;
  const b = levelBounds(level),
    e = roof.overhangFt,
    y = frame.baseY + level.ceilingHeightFt;
  const x0 = b.minX - frame.centerX - e,
    x1 = b.maxX - frame.centerX + e;
  const z0 = b.minY - frame.centerY - e,
    z1 = b.maxY - frame.centerY + e;
  if (roof.kind === "flat") {
    box(mesh, x0, (z0 + z1) / 2, x1, (z0 + z1) / 2, (z1 - z0) / 2, y, y + 0.3);
    return mesh.build();
  }
  const a: [number, number, number] = [x0, y, z0],
    b0: [number, number, number] = [x1, y, z0],
    c: [number, number, number] = [x1, y, z1],
    d: [number, number, number] = [x0, y, z1];
  const across = Math.abs(Math.sin((roof.rotationDeg * Math.PI) / 180)) > 0.5;
  const inset =
    roof.kind === "hip" ? Math.min((x1 - x0) / 3, (z1 - z0) / 3) : 0;
  const r0: [number, number, number] = across
    ? [(x0 + x1) / 2, y + roof.riseFt, z0 + inset]
    : [x0 + inset, y + roof.riseFt, (z0 + z1) / 2];
  const r1: [number, number, number] = across
    ? [(x0 + x1) / 2, y + roof.riseFt, z1 - inset]
    : [x1 - inset, y + roof.riseFt, (z0 + z1) / 2];
  const face = (p: typeof a, q: typeof a, r: typeof a, s: typeof a) => {
    const u = q.map((v, i) => v - p[i]),
      v = r.map((n, i) => n - p[i]);
    const n: typeof a = [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ];
    const length = Math.hypot(...n) || 1;
    mesh.quad(p, q, r, s, n.map((x) => x / length) as typeof a);
  };
  if (across) {
    face(a, d, r1, r0);
    face(b0, r0, r1, c);
    face(a, r0, b0, b0);
    face(d, c, r1, r1);
  } else {
    face(a, r0, r1, b0);
    face(d, c, r1, r0);
    face(a, d, r0, r0);
    face(b0, r1, c, c);
  }
  return mesh.build();
}

export function isWalkable(
  level: LevelGeometry,
  x: number,
  z: number,
): boolean {
  if (
    level.walkable.some((r) => r.holes.some((h) => pointInPolygon([x, z], h)))
  )
    return false;
  return level.walkable.some(
    (r) =>
      pointInPolygon([x, z], r.polygon) &&
      !r.holes.some((h) => pointInPolygon([x, z], h)),
  );
}
