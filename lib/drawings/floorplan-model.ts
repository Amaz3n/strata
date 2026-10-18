import { detectAreas } from "./area-takeoff";
import type { EvidencePath } from "./area-evidence";
import type { BuildingReconstruction } from "./building-reconstruction";
/**
 * The floorplan model: what a 2D plan sheet means in three dimensions.
 *
 * This module owns the SHAPE of an interpreted plan and every pure operation
 * over it — coordinate mapping back to the source sheet, planar face
 * extraction (walls → rooms), wall-run splitting at openings, and the edit
 * reducer the review UI drives. Interpretation itself is the shared building
 * engine (`building-reconstruction.ts`, projected by `building-floorplan.ts`);
 * the 3D mesh build lives in `lib/plans/floorplan-geometry.ts`.
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

import type {
  ArchitecturalEvidence,
  BuildingObject,
  FloorPlacement,
  RoofDefinition,
  SavedModelView,
  SiteOrientation,
  SurfaceFinish,
} from "./architectural-model";
import { interiorPoint } from "./architectural-polygon";

export const FLOORPLAN_MODEL_VERSION = 1;

/** How a wall entered the model. Drives confidence and the review tint. */
export type WallSource = "paired" | "single" | "manual";

export type OpeningKind = "door" | "window" | "cased";

export const OPENING_KINDS: readonly OpeningKind[] = [
  "door",
  "window",
  "cased",
] as const;

/** Defaults in feet. Openings carry their own sill/head once classified. */
export const DEFAULT_CEILING_HEIGHT_FT = 9;
export const DEFAULT_WALL_THICKNESS_FT = 0.4583; // 5.5" — a 2×6 exterior stud wall
export const DEFAULT_DOOR_HEAD_FT = 6.75;
export const DEFAULT_WINDOW_SILL_FT = 2.5;
export const DEFAULT_WINDOW_HEAD_FT = 6.75;

/** Vertices this close (feet) are the same point everywhere in this module. */
export const VERTEX_EPSILON_FT = 0.12;

/** A face smaller than this is a closet detail or a symbol, not a room. */
export const MIN_ROOM_AREA_SQFT = 1;
/** A face larger than this is the building footprint, not a room. */
export const MAX_ROOM_AREA_SQFT = 4000;

export interface FloorplanSource {
  scaleConfirmed?: boolean;
  region?: { x0: number; y0: number; x1: number; y1: number };
  sheetVersionId: string;
  sheetNumber: string | null;
  sheetTitle: string | null;
  /** Rendered-image dimensions the normalized vector space was built against. */
  imageWidth: number;
  imageHeight: number;
  /** Real-world feet per rendered-image pixel (the sheet's calibration). */
  feetPerImagePx: number;
  /** Image-pixel position of the model origin. */
  originPxX: number;
  originPxY: number;
}

export interface Wall {
  heightFt?: number;
  finish?: SurfaceFinish;
  evidence?: ArchitecturalEvidence;
  id: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  thicknessFt: number;
  /** 0..1. Below 0.5 the review overlay tints it for attention. */
  confidence: number;
  source: WallSource;
}

export interface Opening {
  /** Independent source dimensions, not replacements for the host aperture. */
  clearWidthFt?: number;
  leafWidthFt?: number;
  /** Source measurement, distinct from a scheduled nominal unit dimension. */
  widthBasis?: import("./opening-dimensions").OpeningWidthBasis;
  handing?: "left" | "right";
  swing?: "in" | "out";
  style?: "hinged" | "double" | "sliding" | "pocket" | "garage" | "fixed";
  evidence?: ArchitecturalEvidence;
  id: string;
  wallId: string;
  kind: OpeningKind;
  /** Distance along the wall centerline from (x0, y0), in feet. */
  offsetFt: number;
  widthFt: number;
  /** Feet above the floor. A door sits on it; a window floats. */
  sillFt: number;
  headFt: number;
  confidence: number;
}

export interface Room {
  holes?: Array<Array<[number, number]>>;
  finish?: SurfaceFinish;
  ceilingHeightFt?: number;
  evidence?: ArchitecturalEvidence;
  id: string;
  /** Closed ring in model feet; the last point does NOT repeat the first. */
  polygon: Array<[number, number]>;
  label: string | null;
  areaSqft: number;
  confidence: number;
}

export interface LevelConfidence {
  walls: number;
  openings: number;
  rooms: number;
}

export interface Level {
  reconstruction?: Pick<
    BuildingReconstruction,
    "version" | "issues" | "source" | "status" | "scheduleAssociations" | "unmatchedScheduleTags"
  > & { resolutions?: Array<{ issueId: string; note: string }> };
  placement?: FloorPlacement;
  objects?: BuildingObject[];
  roof?: RoofDefinition;
  reviewed?: boolean;
  id: string;
  name: string;
  /** Ground floor is 0; the viewer stacks levels by this. */
  order: number;
  ceilingHeightFt: number;
  source: FloorplanSource;
  walls: Wall[];
  openings: Opening[];
  rooms: Room[];
  confidence: LevelConfidence;
}

export interface FloorplanModel {
  views?: SavedModelView[];
  /** Changes to geometry invalidate review; views and finishes do not. */
  schemaRevision?: number;
  version: typeof FLOORPLAN_MODEL_VERSION;
  units: "feet";
  levels: Level[];
  /** North and latitude, for a sun in the right place. Absent: plan-up is north at 35°. */
  site?: SiteOrientation;
  /** Human corrections applied since the last interpretation run. */
  correctionCount: number;
  /**
   * What the last interpretation could NOT use.
   *
   * A partial result is the dangerous outcome: a two-storey house whose upper
   * sheet had no scale comes back as a perfectly plausible one-storey model,
   * and nothing about the geometry says a floor is missing. These travel with
   * the document so the panel can say so out loud.
   */
  acknowledgedWarnings?: string[];
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Coordinate mapping (model feet ↔ the source sheet)
// ---------------------------------------------------------------------------

export interface PxPoint {
  x: number;
  y: number;
}

/** Model feet → rendered-image pixels on the source sheet. */
export function modelToImagePx(
  source: FloorplanSource,
  x: number,
  y: number,
): PxPoint {
  const scale = source.feetPerImagePx > 0 ? 1 / source.feetPerImagePx : 1;
  return { x: source.originPxX + x * scale, y: source.originPxY + y * scale };
}

/** Rendered-image pixels → model feet. */
export function imagePxToModel(
  source: FloorplanSource,
  px: number,
  py: number,
): { x: number; y: number } {
  return {
    x: (px - source.originPxX) * source.feetPerImagePx,
    y: (py - source.originPxY) * source.feetPerImagePx,
  };
}

/** Model feet → normalized 0..1 image coordinates (what an SVG overlay wants). */
export function modelToNormalized(
  source: FloorplanSource,
  x: number,
  y: number,
): PxPoint {
  const px = modelToImagePx(source, x, y);
  return {
    x: source.imageWidth > 0 ? px.x / source.imageWidth : 0,
    y: source.imageHeight > 0 ? px.y / source.imageHeight : 0,
  };
}

/** Normalized 0..1 image coordinates → model feet. */
export function normalizedToModel(
  source: FloorplanSource,
  nx: number,
  ny: number,
): { x: number; y: number } {
  return imagePxToModel(
    source,
    nx * source.imageWidth,
    ny * source.imageHeight,
  );
}

// ---------------------------------------------------------------------------
// Primitive geometry
// ---------------------------------------------------------------------------

export function wallLengthFt(wall: Wall): number {
  return Math.hypot(wall.x1 - wall.x0, wall.y1 - wall.y0);
}

/** Unit direction along a wall centerline. Degenerate walls report +x. */
export function wallDirection(wall: Wall): { ux: number; uy: number } {
  const length = wallLengthFt(wall);
  if (!(length > 0)) return { ux: 1, uy: 0 };
  return { ux: (wall.x1 - wall.x0) / length, uy: (wall.y1 - wall.y0) / length };
}

/** Shoelace area of a closed ring (implicitly closed; sign preserved). */
export function signedPolygonArea(points: Array<[number, number]>): number {
  if (points.length < 3) return 0;
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[(i + 1) % points.length];
    twice += ax * by - bx * ay;
  }
  return twice / 2;
}

export function polygonArea(points: Array<[number, number]>): number {
  return Math.abs(signedPolygonArea(points));
}

/** Area-weighted centroid; falls back to the vertex mean on a degenerate ring. */
export function polygonCentroid(
  points: Array<[number, number]>,
): [number, number] {
  const area = signedPolygonArea(points);
  if (Math.abs(area) < 1e-9) {
    let sx = 0;
    let sy = 0;
    for (const [x, y] of points) {
      sx += x;
      sy += y;
    }
    const n = Math.max(1, points.length);
    return [sx / n, sy / n];
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[(i + 1) % points.length];
    const cross = ax * by - bx * ay;
    cx += (ax + bx) * cross;
    cy += (ay + by) * cross;
  }
  return [cx / (6 * area), cy / (6 * area)];
}

/** Even-odd point-in-polygon. Points exactly on an edge are unspecified. */
export function pointInPolygon(
  point: [number, number],
  polygon: Array<[number, number]>,
): boolean {
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const straddles = yi > py !== yj > py;
    if (!straddles) continue;
    const x = ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (px < x) inside = !inside;
  }
  return inside;
}

export function boundsOf(points: Array<[number, number]>): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

export function levelBounds(level: Level): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  const points: Array<[number, number]> = [];
  for (const wall of level.walls) {
    points.push([wall.x0, wall.y0], [wall.x1, wall.y1]);
  }
  for (const room of level.rooms) points.push(...room.polygon);
  return boundsOf(points);
}

// ---------------------------------------------------------------------------
// Planar face extraction: walls → rooms
// ---------------------------------------------------------------------------

interface HalfEdge {
  from: number;
  to: number;
  angle: number;
  /** Index of the opposite half-edge. */
  twin: number;
}

function quantKey(x: number, y: number): string {
  return `${Math.round(x / VERTEX_EPSILON_FT)}:${Math.round(y / VERTEX_EPSILON_FT)}`;
}

/**
 * Split every wall centerline at its crossings with the others.
 *
 * Face extraction needs a planar subdivision: two walls that cross must share
 * a vertex, or the traversal walks straight through the junction and reports
 * one enormous face instead of four rooms. T-junctions are already shared
 * (interpretation snaps them); genuine X-crossings are not.
 */
function planarizeWalls(
  walls: Wall[],
): Array<[number, number, number, number]> {
  const cuts: number[][] = walls.map(() => [0, 1]);

  for (let i = 0; i < walls.length; i++) {
    const a = walls[i];
    const ax = a.x1 - a.x0;
    const ay = a.y1 - a.y0;
    for (let j = i + 1; j < walls.length; j++) {
      const b = walls[j];
      const bx = b.x1 - b.x0;
      const by = b.y1 - b.y0;
      const denom = ax * by - ay * bx;
      if (Math.abs(denom) < 1e-9) continue;
      const qx = b.x0 - a.x0;
      const qy = b.y0 - a.y0;
      const t = (qx * by - qy * bx) / denom;
      const u = (qx * ay - qy * ax) / denom;
      // Interior×interior is an X-crossing; interior×endpoint is a T-junction.
      // BOTH have to become shared vertices — a T left unsplit lets the face
      // walk run straight past the partition and merge two rooms into one.
      const tInterior = t > 1e-6 && t < 1 - 1e-6;
      const uInterior = u > 1e-6 && u < 1 - 1e-6;
      const tEnd = t >= -1e-6 && t <= 1 + 1e-6;
      const uEnd = u >= -1e-6 && u <= 1 + 1e-6;
      if (tInterior && uEnd) cuts[i].push(t);
      if (uInterior && tEnd) cuts[j].push(u);
    }
  }

  const edges: Array<[number, number, number, number]> = [];
  for (let i = 0; i < walls.length; i++) {
    const wall = walls[i];
    const ts = Array.from(
      new Set(cuts[i].map((t) => Math.round(t * 1e6) / 1e6)),
    ).sort((p, q) => p - q);
    for (let k = 1; k < ts.length; k++) {
      const t0 = ts[k - 1];
      const t1 = ts[k];
      const x0 = wall.x0 + (wall.x1 - wall.x0) * t0;
      const y0 = wall.y0 + (wall.y1 - wall.y0) * t0;
      const x1 = wall.x0 + (wall.x1 - wall.x0) * t1;
      const y1 = wall.y0 + (wall.y1 - wall.y0) * t1;
      if (Math.hypot(x1 - x0, y1 - y0) < VERTEX_EPSILON_FT) continue;
      edges.push([x0, y0, x1, y1]);
    }
  }
  return edges;
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
export function extractRoomPolygons(
  walls: Wall[],
): Array<Array<[number, number]>> {
  const segments = planarizeWalls(
    walls.filter((wall) => wallLengthFt(wall) >= VERTEX_EPSILON_FT),
  );
  if (segments.length === 0) return [];

  const vertexIds = new Map<string, number>();
  const vertexX: number[] = [];
  const vertexY: number[] = [];
  const vertexOut: number[][] = [];
  const touch = (x: number, y: number): number => {
    const key = quantKey(x, y);
    const existing = vertexIds.get(key);
    if (existing !== undefined) return existing;
    const id = vertexX.length;
    vertexIds.set(key, id);
    vertexX.push(x);
    vertexY.push(y);
    vertexOut.push([]);
    return id;
  };

  const halfEdges: HalfEdge[] = [];
  const seen = new Set<string>();
  for (const [x0, y0, x1, y1] of segments) {
    const a = touch(x0, y0);
    const b = touch(x1, y1);
    if (a === b) continue;
    const pairKey = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);

    const forward = halfEdges.length;
    const backward = forward + 1;
    halfEdges.push({
      from: a,
      to: b,
      angle: Math.atan2(vertexY[b] - vertexY[a], vertexX[b] - vertexX[a]),
      twin: backward,
    });
    halfEdges.push({
      from: b,
      to: a,
      angle: Math.atan2(vertexY[a] - vertexY[b], vertexX[a] - vertexX[b]),
      twin: forward,
    });
    vertexOut[a].push(forward);
    vertexOut[b].push(backward);
  }
  if (halfEdges.length === 0) return [];

  // Outgoing half-edges sorted by angle, plus each one's slot, so "the edge
  // before the reverse direction" is an index lookup rather than a scan.
  const slotOf = new Int32Array(halfEdges.length);
  for (const out of vertexOut) {
    out.sort((p, q) => halfEdges[p].angle - halfEdges[q].angle);
    for (let i = 0; i < out.length; i++) slotOf[out[i]] = i;
  }

  const nextOf = new Int32Array(halfEdges.length);
  for (let index = 0; index < halfEdges.length; index++) {
    const twin = halfEdges[index].twin;
    const out = vertexOut[halfEdges[index].to];
    // The twin leaves `to` heading back the way we came; the face continues
    // through the neighbour just clockwise of it.
    const slot = slotOf[twin];
    nextOf[index] = out[(slot - 1 + out.length) % out.length];
  }

  const visited = new Uint8Array(halfEdges.length);
  const faces: Array<{ ring: Array<[number, number]>; signedArea: number }> =
    [];
  for (let start = 0; start < halfEdges.length; start++) {
    if (visited[start]) continue;
    const ring: Array<[number, number]> = [];
    let cursor = start;
    let guard = 0;
    while (!visited[cursor] && guard++ <= halfEdges.length) {
      visited[cursor] = 1;
      ring.push([
        vertexX[halfEdges[cursor].from],
        vertexY[halfEdges[cursor].from],
      ]);
      cursor = nextOf[cursor];
    }
    if (ring.length < 3) continue;
    faces.push({ ring, signedArea: signedPolygonArea(ring) });
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
      const area = polygonArea(ring);
      return (
        ring.length >= 3 &&
        area >= MIN_ROOM_AREA_SQFT &&
        area <= MAX_ROOM_AREA_SQFT
      );
    });
}

/** Drop repeated and collinear vertices so a room reads as its real corners. */
function dedupeRing(ring: Array<[number, number]>): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (const point of ring) {
    const last = points[points.length - 1];
    if (
      last &&
      Math.hypot(last[0] - point[0], last[1] - point[1]) < VERTEX_EPSILON_FT
    )
      continue;
    points.push(point);
  }
  while (
    points.length > 1 &&
    Math.hypot(
      points[0][0] - points[points.length - 1][0],
      points[0][1] - points[points.length - 1][1],
    ) < VERTEX_EPSILON_FT
  ) {
    points.pop();
  }
  if (points.length < 3) return points;

  const simplified: Array<[number, number]> = [];
  for (let i = 0; i < points.length; i++) {
    const previous = points[(i - 1 + points.length) % points.length];
    const current = points[i];
    const next = points[(i + 1) % points.length];
    const cross =
      (current[0] - previous[0]) * (next[1] - current[1]) -
      (current[1] - previous[1]) * (next[0] - current[0]);
    if (Math.abs(cross) < 1e-4) continue;
    simplified.push(current);
  }
  return simplified.length >= 3 ? simplified : points;
}

// ---------------------------------------------------------------------------
// Wall runs: solid spans and openings, for the 3D build
// ---------------------------------------------------------------------------

export interface WallSpan {
  /** Distance along the centerline from the wall's start, in feet. */
  startFt: number;
  endFt: number;
  /** Bottom and top of the solid piece, in feet above the floor. */
  bottomFt: number;
  topFt: number;
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
export function wallSolidSpans(
  wall: Wall,
  openings: Opening[],
  ceilingHeightFt: number,
): WallSpan[] {
  const length = wallLengthFt(wall);
  if (!(length > 0)) return [];
  const relevant = openings
    .filter((opening) => opening.wallId === wall.id)
    .map((opening) => ({
      start: Math.max(0, Math.min(length, opening.offsetFt)),
      end: Math.max(0, Math.min(length, opening.offsetFt + opening.widthFt)),
      sill: Math.max(0, Math.min(ceilingHeightFt, opening.sillFt)),
      head: Math.max(0, Math.min(ceilingHeightFt, opening.headFt)),
    }))
    .filter((opening) => opening.end - opening.start > 0.05)
    .sort((a, b) => a.start - b.start);

  const spans: WallSpan[] = [];
  let cursor = 0;
  for (const opening of relevant) {
    // Overlapping openings (a correction can create them) collapse into one.
    const start = Math.max(cursor, opening.start);
    if (start > cursor + 0.02) {
      spans.push({
        startFt: cursor,
        endFt: start,
        bottomFt: 0,
        topFt: ceilingHeightFt,
      });
    }
    if (opening.end <= start) continue;
    if (opening.sill > 0.02) {
      spans.push({
        startFt: start,
        endFt: opening.end,
        bottomFt: 0,
        topFt: opening.sill,
      });
    }
    if (opening.head < ceilingHeightFt - 0.02) {
      spans.push({
        startFt: start,
        endFt: opening.end,
        bottomFt: opening.head,
        topFt: ceilingHeightFt,
      });
    }
    cursor = Math.max(cursor, opening.end);
  }
  if (cursor < length - 0.02) {
    spans.push({
      startFt: cursor,
      endFt: length,
      bottomFt: 0,
      topFt: ceilingHeightFt,
    });
  }
  return spans;
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

/** Overall model confidence — the weakest link across every level. */
export function modelConfidence(model: FloorplanModel): number {
  if (model.levels.length === 0) return 0;
  let total = 0;
  for (const level of model.levels) {
    total +=
      level.confidence.walls * 0.55 +
      level.confidence.rooms * 0.3 +
      level.confidence.openings * 0.15;
  }
  return Math.round((total / model.levels.length) * 100) / 100;
}

export function modelFloorAreaSqft(model: FloorplanModel): number {
  let total = 0;
  for (const level of model.levels) {
    for (const room of level.rooms) total += room.areaSqft;
  }
  return Math.round(total);
}

// ---------------------------------------------------------------------------
// Edits (the review UI's only way to change a model)
// ---------------------------------------------------------------------------

export type FloorplanEdit =
  | {
      type: "wall.update";
      levelId: string;
      wallId: string;
      changes: Partial<
        Pick<
          Wall,
          "x0" | "y0" | "x1" | "y1" | "thicknessFt" | "heightFt" | "finish"
        >
      >;
    }
  | { type: "opening.upsert"; levelId: string; opening: Opening }
  | {
      type: "room.update";
      levelId: string;
      roomId: string;
      changes: Partial<
        Pick<Room, "polygon" | "holes" | "finish" | "ceilingHeightFt">
      >;
    }
  | { type: "level.placement"; levelId: string; placement: FloorPlacement }
  | {
      type: "source.review";
      levelId: string;
      warning: string;
      acknowledged: boolean;
    }
  | {
      type: "reconstruction.resolve";
      levelId: string;
      issueId: string;
      note: string | null;
    }
  | { type: "level.review"; levelId: string; reviewed: boolean }
  | { type: "level.scale"; levelId: string; feetPerImagePx: number }
  | { type: "object.upsert"; levelId: string; object: BuildingObject }
  | { type: "object.delete"; levelId: string; objectId: string }
  | { type: "roof.set"; levelId: string; roof: RoofDefinition | null }
  | { type: "view.save"; levelId: string; view: SavedModelView }
  | { type: "site.set"; site: SiteOrientation }
  | {
      type: "wall.add";
      levelId: string;
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      thicknessFt?: number;
    }
  | { type: "wall.delete"; levelId: string; wallId: string }
  | {
      type: "opening.set";
      levelId: string;
      openingId: string;
      kind: OpeningKind;
    }
  | { type: "opening.delete"; levelId: string; openingId: string }
  | {
      type: "room.label";
      levelId: string;
      roomId: string;
      label: string | null;
    }
  | { type: "level.height"; levelId: string; ceilingHeightFt: number }
  | { type: "level.name"; levelId: string; name: string };

/** Deterministic ids: a correction must produce the same model on replay. */
function nextId(prefix: string, existing: Array<{ id: string }>): string {
  let max = 0;
  for (const item of existing) {
    const match = /(\d+)$/.exec(item.id);
    if (match) max = Math.max(max, Number.parseInt(match[1], 10));
  }
  return `${prefix}${max + 1}`;
}

/** A drawn wall end this far from existing linework lands on it instead. */
const ADD_WALL_SNAP_FT = 1.25;

/**
 * Pull a hand-drawn wall end onto the wall it was aimed at.
 *
 * A correction is two clicks on a zoomed-out sheet, so "close enough" is the
 * best a human can do — and a wall that stops three inches short of the one it
 * meets divides nothing, which is exactly the failure the correction was
 * meant to fix. Endpoints win over mid-wall hits: aiming at a corner is
 * deliberate.
 */
function snapToWalls(
  x: number,
  y: number,
  walls: Wall[],
): { x: number; y: number } {
  let best: { x: number; y: number; distance: number; corner: boolean } | null =
    null;
  for (const wall of walls) {
    for (const [cx, cy] of [
      [wall.x0, wall.y0],
      [wall.x1, wall.y1],
    ]) {
      const distance = Math.hypot(cx - x, cy - y);
      if (distance > ADD_WALL_SNAP_FT) continue;
      if (!best || best.corner === false || distance < best.distance) {
        best = { x: cx, y: cy, distance, corner: true };
      }
    }
    if (best?.corner) continue;
    const dx = wall.x1 - wall.x0;
    const dy = wall.y1 - wall.y0;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-9) continue;
    const t = Math.min(
      1,
      Math.max(0, ((x - wall.x0) * dx + (y - wall.y0) * dy) / lenSq),
    );
    const px = wall.x0 + t * dx;
    const py = wall.y0 + t * dy;
    const distance = Math.hypot(px - x, py - y);
    if (distance > ADD_WALL_SNAP_FT) continue;
    if (!best || distance < best.distance)
      best = { x: px, y: py, distance, corner: false };
  }
  return best ? { x: best.x, y: best.y } : { x, y };
}

const OPENING_PROFILES: Record<
  OpeningKind,
  { sillFt: number; headFt: number }
> = {
  door: { sillFt: 0, headFt: DEFAULT_DOOR_HEAD_FT },
  window: { sillFt: DEFAULT_WINDOW_SILL_FT, headFt: DEFAULT_WINDOW_HEAD_FT },
  cased: { sillFt: 0, headFt: DEFAULT_DOOR_HEAD_FT },
};

/** Height profile for an opening kind — one home, used by interpret and edits. */
export function openingProfile(kind: OpeningKind): {
  sillFt: number;
  headFt: number;
} {
  return OPENING_PROFILES[kind];
}

/**
 * Rebuild a level's rooms from its walls, carrying labels across.
 *
 * A label survives if the old room's centroid still lands inside a new face —
 * an estimator who names the kitchen and then deletes a false wall inside it
 * must not lose the name.
 */
export function recomputeRooms(level: Level): Room[] {
  const previous = level.rooms;
  const sx = level.source.imageWidth * level.source.feetPerImagePx,
    sy = level.source.imageHeight * level.source.feetPerImagePx;
  // Shared reconstructions stay on finished wall faces after editing. Running
  // the legacy centreline loop finder here used to reintroduce giant rooms.
  const sourcePoint = (x: number, y: number): [number, number] => [
    (x + level.source.originPxX * level.source.feetPerImagePx) / sx,
    (y + level.source.originPxY * level.source.feetPerImagePx) / sy,
  ];
  const paths: EvidencePath[] = level.reconstruction
    ? level.walls.map((w, id) => {
        const { ux, uy } = wallDirection(w),
          nx = (-uy * w.thicknessFt) / 2,
          ny = (ux * w.thicknessFt) / 2;
        const points = [
          sourcePoint(w.x0 + nx, w.y0 + ny),
          sourcePoint(w.x1 + nx, w.y1 + ny),
          sourcePoint(w.x1 - nx, w.y1 - ny),
          sourcePoint(w.x0 - nx, w.y0 - ny),
        ];
        return {
          id,
          kind: "fill",
          commands: [
            ...points.map(
              (p, i) =>
                [i ? "L" : "M", p[0], p[1]] as EvidencePath["commands"][number],
            ),
            ["Z"],
          ],
          color: [0],
          colorSpace: "DeviceGray",
          opacity: 1,
          width: 0,
          dashes: [],
          layer: ["A_WALL"],
          groups: [],
          clips: [],
          evenOdd: false,
        };
      })
    : [];
  const detected = level.reconstruction
    ? detectAreas({
        segments: [],
        evidence: { version: 1, paths, truncated: false },
        imageWidth: level.source.imageWidth,
        imageHeight: level.source.imageHeight,
        feetPerImagePx: level.source.feetPerImagePx,
        region: level.source.region ?? { x0: 0, y0: 0, x1: 1, y1: 1 },
        finishPolicy: "include-fixtures",
        textRuns: previous
          .filter((r) => r.label)
          .map((r) => {
            const p = interiorPoint(r.polygon, r.holes),
              n = sourcePoint(p[0], p[1]);
            return { text: r.label!, x: n[0], y: n[1], w: 0, h: 0 };
          }),
      }).proposals
    : undefined;
  const polygons = detected
    ? detected.map((p) =>
        p.points.map(([x, y]): [number, number] => [
          x * sx - level.source.originPxX * level.source.feetPerImagePx,
          y * sy - level.source.originPxY * level.source.feetPerImagePx,
        ]),
      )
    : extractRoomPolygons(level.walls);
  const claimed = new Set<string>();
  const allocated = [...previous];
  return polygons.map((polygon) => {
    const match = previous
      .filter(
        (room) =>
          !claimed.has(room.id) &&
          pointInPolygon(interiorPoint(room.polygon, room.holes), polygon),
      )
      .sort(
        (a, b) =>
          Math.abs(polygonArea(a.polygon) - polygonArea(polygon)) -
          Math.abs(polygonArea(b.polygon) - polygonArea(polygon)),
      )[0];
    const id = match?.id ?? nextId("r", allocated);
    claimed.add(id);
    allocated.push({ id } as Room);
    const holes = match?.holes?.filter((hole) =>
      hole.every((p) => pointInPolygon(p, polygon)),
    );
    return {
      ...match,
      id,
      polygon,
      holes,
      label: match?.label ?? null,
      areaSqft:
        polygonArea(polygon) -
        (holes ?? []).reduce((sum, h) => sum + polygonArea(h), 0),
      confidence: match?.confidence ?? 0.5,
    };
  });
}

/**
 * Apply one correction. Pure: returns a new model, never mutates the input.
 *
 * Unknown level/wall/room ids are a no-op returning the SAME reference, so the
 * caller can tell a real edit from a stale click and skip the write.
 */
export function applyFloorplanEdit(
  model: FloorplanModel,
  edit: FloorplanEdit,
): FloorplanModel {
  if (edit.type === "source.review") {
    if (!model.warnings?.includes(edit.warning)) return model;
    const acknowledgedWarnings = (model.acknowledgedWarnings ?? []).filter(
      (w) => w !== edit.warning,
    );
    if (edit.acknowledged) acknowledgedWarnings.push(edit.warning);
    return {
      ...model,
      acknowledgedWarnings,
      correctionCount: model.correctionCount + 1,
    };
  }
  // Where the house sits is model-wide and cosmetic: it moves the sun, never a wall.
  if (edit.type === "site.set") {
    const current = model.site;
    if (current && current.northDeg === edit.site.northDeg && current.latitudeDeg === edit.site.latitudeDeg) return model;
    return { ...model, site: { ...edit.site }, correctionCount: model.correctionCount + 1 };
  }
  if (edit.type === "view.save")
    return {
      ...model,
      views: [
        ...(model.views ?? []).filter((v) => v.id !== edit.view.id),
        edit.view,
      ].slice(-30),
      correctionCount: model.correctionCount + 1,
    };
  const index = model.levels.findIndex((level) => level.id === edit.levelId);
  if (index === -1) return model;
  const level = model.levels[index];
  let next: Level | null = null;

  switch (edit.type) {
    case "wall.update": {
      const old = level.walls.find((w) => w.id === edit.wallId);
      if (!old) return model;
      const wall = {
        ...old,
        ...edit.changes,
        evidence: { basis: "manual" as const, reviewed: true },
      };
      if (
        wallLengthFt(wall) < 0.5 ||
        level.openings.some(
          (o) =>
            o.wallId === wall.id && o.offsetFt + o.widthFt > wallLengthFt(wall),
        )
      )
        return model;
      next = {
        ...level,
        walls: level.walls.map((w) => (w.id === wall.id ? wall : w)),
      };
      next.rooms = recomputeRooms(next);
      break;
    }
    case "opening.upsert": {
      const o = edit.opening;
      const previous = level.openings.find(opening => opening.id === o.id);
      const wall = level.walls.find((w) => w.id === o.wallId);
      if (
        !wall ||
        o.offsetFt < 0 ||
        o.widthFt <= 0 ||
        o.offsetFt + o.widthFt > wallLengthFt(wall) ||
        o.headFt <= o.sillFt ||
        o.headFt > (wall.heightFt ?? level.ceilingHeightFt)
      )
        return model;
      if (
        level.openings.some(
          (other) =>
            other.id !== o.id &&
            other.wallId === o.wallId &&
            other.offsetFt < o.offsetFt + o.widthFt &&
            other.offsetFt + other.widthFt > o.offsetFt,
        )
      )
        return model;
      next = {
        ...level,
        openings: [
          ...level.openings.filter((other) => other.id !== o.id),
          { ...o, widthBasis: previous?.widthFt === o.widthFt ? previous.widthBasis : "manual",
            evidence: { basis: "manual", reviewed: true } },
        ],
      };
      break;
    }
    case "room.update": {
      next = {
        ...level,
        rooms: level.rooms.map((r) => {
          if (r.id !== edit.roomId) return r;
          const room = { ...r, ...edit.changes };
          return {
            ...room,
            areaSqft:
              polygonArea(room.polygon) -
              (room.holes ?? []).reduce((sum, h) => sum + polygonArea(h), 0),
          };
        }),
      };
      break;
    }
    case "level.placement":
      next = { ...level, placement: edit.placement };
      break;
    case "reconstruction.resolve": {
      const issue = level.reconstruction?.issues.find(
        (i) => i.id === edit.issueId,
      );
      if (
        !issue ||
        issue.severity === "error" ||
        (edit.note !== null && edit.note.trim().length < 8)
      )
        return model;
      const resolutions = (level.reconstruction!.resolutions ?? []).filter(
        (r) => r.issueId !== edit.issueId,
      );
      if (edit.note !== null)
        resolutions.push({
          issueId: edit.issueId,
          note: edit.note.trim().slice(0, 500),
        });
      next = {
        ...level,
        reconstruction: { ...level.reconstruction!, resolutions },
      };
      break;
    }
    case "level.review":
      if (
        edit.reviewed &&
        level.reconstruction?.issues.some(
          (i) =>
            i.severity === "review" &&
            !level.reconstruction?.resolutions?.some((r) => r.issueId === i.id),
        )
      )
        return model;
      next = { ...level, reviewed: edit.reviewed };
      break;
    case "level.scale": {
      const ratio = edit.feetPerImagePx / level.source.feetPerImagePx;
      if (!(ratio > 0) || !Number.isFinite(ratio)) return model;
      const point = ([x, y]: [number, number]): [number, number] => [
        x * ratio,
        y * ratio,
      ];
      next = {
        ...level,
        source: {
          ...level.source,
          feetPerImagePx: edit.feetPerImagePx,
          scaleConfirmed: true,
        },
        walls: level.walls.map((w) => ({
          ...w,
          x0: w.x0 * ratio,
          y0: w.y0 * ratio,
          x1: w.x1 * ratio,
          y1: w.y1 * ratio,
          thicknessFt: w.thicknessFt * ratio,
        })),
        openings: level.openings.map((o) => ({
          ...o,
          offsetFt: o.offsetFt * ratio,
          widthFt: o.widthFt * ratio,
        })),
        rooms: level.rooms.map((r) => ({
          ...r,
          polygon: r.polygon.map(point),
          holes: r.holes?.map((h) => h.map(point)),
          areaSqft: r.areaSqft * ratio * ratio,
        })),
        objects: level.objects?.map((o) => ({
          ...o,
          xFt: o.xFt * ratio,
          yFt: o.yFt * ratio,
        })),
      };
      break;
    }
    case "object.upsert":
      next = {
        ...level,
        objects: [
          ...(level.objects ?? []).filter((o) => o.id !== edit.object.id),
          edit.object,
        ],
      };
      break;
    case "object.delete":
      next = {
        ...level,
        objects: (level.objects ?? []).filter((o) => o.id !== edit.objectId),
      };
      break;
    case "roof.set":
      next = { ...level, roof: edit.roof ?? undefined };
      break;
    case "wall.add": {
      if (Math.hypot(edit.x1 - edit.x0, edit.y1 - edit.y0) < 0.5) return model;
      const start = snapToWalls(edit.x0, edit.y0, level.walls);
      const end = snapToWalls(edit.x1, edit.y1, level.walls);
      if (Math.hypot(end.x - start.x, end.y - start.y) < 0.5) return model;
      const wall: Wall = {
        id: nextId("w", level.walls),
        x0: start.x,
        y0: start.y,
        x1: end.x,
        y1: end.y,
        thicknessFt:
          edit.thicknessFt && edit.thicknessFt > 0
            ? edit.thicknessFt
            : DEFAULT_WALL_THICKNESS_FT,
        confidence: 1,
        source: "manual",
      };
      const walls = [...level.walls, wall];
      next = { ...level, walls };
      next.rooms = recomputeRooms(next);
      break;
    }
    case "wall.delete": {
      if (!level.walls.some((wall) => wall.id === edit.wallId)) return model;
      const walls = level.walls.filter((wall) => wall.id !== edit.wallId);
      const openings = level.openings.filter(
        (opening) => opening.wallId !== edit.wallId,
      );
      next = { ...level, walls, openings };
      next.rooms = recomputeRooms(next);
      break;
    }
    case "opening.set": {
      const target = level.openings.find(
        (opening) => opening.id === edit.openingId,
      );
      if (!target || target.kind === edit.kind) return model;
      const profile = openingProfile(edit.kind);
      next = {
        ...level,
        openings: level.openings.map((opening) =>
          opening.id === edit.openingId
            ? { ...opening, kind: edit.kind, ...profile, confidence: 1 }
            : opening,
        ),
      };
      break;
    }
    case "opening.delete": {
      if (!level.openings.some((opening) => opening.id === edit.openingId))
        return model;
      next = {
        ...level,
        openings: level.openings.filter(
          (opening) => opening.id !== edit.openingId,
        ),
      };
      break;
    }
    case "room.label": {
      const target = level.rooms.find((room) => room.id === edit.roomId);
      if (!target) return model;
      const label = edit.label?.trim() ? edit.label.trim().slice(0, 40) : null;
      if (label === target.label) return model;
      next = {
        ...level,
        rooms: level.rooms.map((room) =>
          room.id === edit.roomId
            ? { ...room, label, confidence: label ? 1 : 0.5 }
            : room,
        ),
      };
      break;
    }
    case "level.height": {
      const height = Math.min(20, Math.max(6, edit.ceilingHeightFt));
      if (Math.abs(height - level.ceilingHeightFt) < 0.01) return model;
      next = { ...level, ceilingHeightFt: height };
      break;
    }
    case "level.name": {
      const name = edit.name.trim().slice(0, 60);
      if (!name || name === level.name) return model;
      next = { ...level, name };
      break;
    }
  }

  if (!next) return model;
  if (next.reconstruction?.scheduleAssociations?.length) {
    const changed = new Set<string>(), removed = new Set<string>();
    const unmatchedScheduleTags = [...(next.reconstruction.unmatchedScheduleTags ?? [])];
    const missingTagIssues: typeof next.reconstruction.issues = [];
    const signature = (l: Level, id: string) => {
      const opening = l.openings.find(o => o.id === id);
      const wall = opening && l.walls.find(w => w.id === opening.wallId);
      return JSON.stringify([opening?.kind,opening?.wallId,opening?.offsetFt,opening?.widthFt,opening?.sillFt,opening?.headFt,opening?.style,
        wall?.x0,wall?.y0,wall?.x1,wall?.y1,wall?.thicknessFt,wall?.heightFt,l.ceilingHeightFt]);
    };
    const scheduleAssociations = next.reconstruction.scheduleAssociations.flatMap(association => {
      if (!next!.openings.some(o => o.id === association.openingId)) {
        removed.add(`window-schedule:${association.openingId}`);
        // Removing a modeled opening must not erase its source tag. Keep that
        // location available for review or for a correctly redrawn opening.
        for (const {tag} of association.candidates) {
          changed.add(`window-tag:${tag.runIndex}:${tag.pathId}`);
          if (unmatchedScheduleTags.some(t=>t.planSourceId===association.planSourceId&&t.tag.runIndex===tag.runIndex&&t.tag.pathId===tag.pathId)) continue;
          unmatchedScheduleTags.push({planSourceId:association.planSourceId,tag,schedules:association.candidates.filter(c=>c.tag.runIndex===tag.runIndex&&c.tag.pathId===tag.pathId).map(c=>c.schedule)});
          missingTagIssues.push({id:`window-tag:${tag.runIndex}:${tag.pathId}`,code:'window-schedule-unrepresented',severity:'review',pathIds:[tag.pathId],
            point:[(tag.bounds.x0+tag.bounds.x1)/2,(tag.bounds.y0+tag.bounds.y1)/2],message:`Window tag ${tag.mark} remains in the source after its modeled opening was removed. Check the drawing or record why it does not apply.`});
        }
        return [];
      }
      if (signature(level,association.openingId) === signature(next!,association.openingId)) return [association];
      changed.add(`window-schedule:${association.openingId}`);
      return [{...association,status:'stale' as const,reason:'Opening or host geometry changed. Recheck the drawing tag and schedule before applying its dimensions.'}];
    });
    next = {...next,reconstruction:{...next.reconstruction,scheduleAssociations,unmatchedScheduleTags,
      issues:[...next.reconstruction.issues.filter(i=>!removed.has(i.id)&&!missingTagIssues.some(tagIssue=>tagIssue.id===i.id)).map(i=>changed.has(i.id)?{...i,message:'Opening or host geometry changed. Recheck the drawing tag and schedule before applying its dimensions.'}:i),...missingTagIssues],
      resolutions:next.reconstruction.resolutions?.filter(r=>!changed.has(r.issueId)&&!removed.has(r.issueId)),
    }};
  }
  const levels = [...model.levels];
  const cosmetic =
    edit.type === "room.label" ||
    edit.type === "level.name" ||
    edit.type.startsWith("object.") ||
    (edit.type === "room.update" &&
      !edit.changes.polygon &&
      !edit.changes.holes &&
      !edit.changes.ceilingHeightFt) ||
    (edit.type === "wall.update" &&
      Object.keys(edit.changes).every((key) => key === "finish"));
  levels[index] = {
    ...next,
    reviewed: edit.type === "level.review" || cosmetic ? next.reviewed : false,
    confidence: levelConfidence(next),
  };
  return { ...model, levels, correctionCount: model.correctionCount + 1 };
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
    ? level.walls.reduce((total, wall) => total + wall.confidence, 0) /
      level.walls.length
    : 0;
  const openings = level.openings.length
    ? level.openings.reduce((total, opening) => total + opening.confidence, 0) /
      level.openings.length
    : level.walls.length
      ? 0.4
      : 0;
  const labelled = level.rooms.filter((room) => room.label).length;
  const rooms = level.rooms.length
    ? 0.4 + 0.6 * (labelled / level.rooms.length)
    : 0;
  return {
    walls: Math.round(walls * 100) / 100,
    openings: Math.round(openings * 100) / 100,
    rooms: Math.round(rooms * 100) / 100,
  };
}
