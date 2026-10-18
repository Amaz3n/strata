import type { BuildingObject } from "./architectural-model";
import { interiorPoint } from "./architectural-polygon";
import { furnitureModel } from "./furniture-catalog";
import type { Level, Room, Wall } from "./floorplan-model";

/**
 * Where furniture can go, in level feet (the frame objects are stored in).
 *
 * Pure and tested: snapping a piece's back to the nearest wall, centring it in
 * its room, and the clearance rules a designer would check by eye — pieces
 * overlapping, a piece in a door's swing, a sofa with no room in front of it,
 * a piece straddling a wall. The scene and the design panel only ask.
 *
 * Object convention (`furniture-catalog.ts`): local x is width, local z is
 * depth, the BACK is +z. A footprint corner at local (x, z) sits at
 * (xFt + x·cos − z·sin, yFt + x·sin + z·cos).
 */

type Point = [number, number];

/** An oriented rectangle: centre, half extents, and its local x axis. */
interface Box {
  cx: number;
  cy: number;
  hw: number;
  hd: number;
  ux: number;
  uy: number;
}

const DEG = Math.PI / 180;

function objectBox(object: Pick<BuildingObject, "xFt" | "yFt" | "widthFt" | "depthFt" | "rotationDeg">): Box {
  return {
    cx: object.xFt,
    cy: object.yFt,
    hw: object.widthFt / 2,
    hd: object.depthFt / 2,
    ux: Math.cos(object.rotationDeg * DEG),
    uy: Math.sin(object.rotationDeg * DEG),
  };
}

function corners(box: Box): Point[] {
  const vx = -box.uy;
  const vy = box.ux;
  return [
    [box.cx - box.ux * box.hw - vx * box.hd, box.cy - box.uy * box.hw - vy * box.hd],
    [box.cx + box.ux * box.hw - vx * box.hd, box.cy + box.uy * box.hw - vy * box.hd],
    [box.cx + box.ux * box.hw + vx * box.hd, box.cy + box.uy * box.hw + vy * box.hd],
    [box.cx - box.ux * box.hw + vx * box.hd, box.cy - box.uy * box.hw + vy * box.hd],
  ];
}

/** Separating-axis test; touching edges (within `slop`) do not count. */
function boxesOverlap(a: Box, b: Box, slop = 0.05): boolean {
  const axes: Point[] = [
    [a.ux, a.uy],
    [-a.uy, a.ux],
    [b.ux, b.uy],
    [-b.uy, b.ux],
  ];
  const ca = corners(a);
  const cb = corners(b);
  for (const [ax, ay] of axes) {
    const project = (points: Point[]) => {
      let min = Infinity;
      let max = -Infinity;
      for (const [x, y] of points) {
        const value = x * ax + y * ay;
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
      return [min, max] as const;
    };
    const [aMin, aMax] = project(ca);
    const [bMin, bMax] = project(cb);
    if (aMax - slop <= bMin || bMax - slop <= aMin) return false;
  }
  return true;
}

function wallBox(wall: Wall): Box | null {
  const length = Math.hypot(wall.x1 - wall.x0, wall.y1 - wall.y0);
  if (length < 1e-6) return null;
  return {
    cx: (wall.x0 + wall.x1) / 2,
    cy: (wall.y0 + wall.y1) / 2,
    hw: length / 2,
    hd: wall.thicknessFt / 2,
    ux: (wall.x1 - wall.x0) / length,
    uy: (wall.y1 - wall.y0) / length,
  };
}

function insideRing(ring: Point[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function roomContaining(level: Pick<Level, "rooms">, xFt: number, yFt: number): Room | null {
  for (const room of level.rooms) {
    if (!insideRing(room.polygon, xFt, yFt)) continue;
    if (room.holes?.some((hole) => insideRing(hole, xFt, yFt))) continue;
    return room;
  }
  return null;
}

/** The room's centroid when that lands on its floor, otherwise a point well inside it. */
export function roomCenter(room: Room): Point {
  const ring = room.polygon;
  let area = 0;
  let x = 0;
  let y = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    area += cross;
    x += (ring[j][0] + ring[i][0]) * cross;
    y += (ring[j][1] + ring[i][1]) * cross;
  }
  if (Math.abs(area) > 1e-6) {
    const centroid: Point = [x / (3 * area), y / (3 * area)];
    if (roomContaining({ rooms: [room] }, centroid[0], centroid[1])) return centroid;
  }
  return interiorPoint(room.polygon, room.holes);
}

export interface WallSnap {
  xFt: number;
  yFt: number;
  rotationDeg: number;
  wallId: string;
}

const normalizeDeg = (deg: number) => Math.round((((deg % 360) + 540) % 360 - 180) * 10) / 10;

/**
 * The nearest wall within reach, with the piece turned so its back is flush
 * against that wall's face and slid along it so it stays on the wall.
 * `reachFt` is how far the piece's back may be from the wall face to snap.
 */
export function snapToWall(
  level: Pick<Level, "walls">,
  object: Pick<BuildingObject, "xFt" | "yFt" | "widthFt" | "depthFt">,
  reachFt = 2,
): WallSnap | null {
  let best: (WallSnap & { gap: number }) | null = null;
  for (const wall of level.walls) {
    const box = wallBox(wall);
    if (!box || box.hw * 2 < object.widthFt * 0.6) continue;
    const dx = object.xFt - box.cx;
    const dy = object.yFt - box.cy;
    const along = dx * box.ux + dy * box.uy;
    const across = -dx * box.uy + dy * box.ux;
    const gap = Math.abs(across) - box.hd - object.depthFt / 2;
    if (gap > reachFt || Math.abs(along) > box.hw + object.widthFt / 2) continue;
    if (best && gap >= best.gap) continue;
    // Normal from the wall toward the piece; the back (+z) must face back along it.
    const side = across >= 0 ? 1 : -1;
    const nx = -box.uy * side;
    const ny = box.ux * side;
    const slide = Math.max(-box.hw + object.widthFt / 2, Math.min(box.hw - object.widthFt / 2, along));
    const offset = box.hd + object.depthFt / 2;
    best = {
      gap,
      wallId: wall.id,
      xFt: box.cx + box.ux * slide + nx * offset,
      yFt: box.cy + box.uy * slide + ny * offset,
      // Back direction is (−sin θ, cos θ); set it to −n.
      rotationDeg: normalizeDeg(Math.atan2(nx, -ny) / DEG),
    };
  }
  return best && { xFt: best.xFt, yFt: best.yFt, rotationDeg: best.rotationDeg, wallId: best.wallId };
}

export type ClearanceCode = "overlap" | "door_swing" | "front_clearance" | "crosses_wall" | "outside";

export interface ClearanceIssue {
  objectId: string;
  code: ClearanceCode;
  message: string;
  /** The other piece, wall or opening involved. */
  otherId?: string;
}

/** The floor a hinged door sweeps, on both sides because swing is often unknown. */
function doorSwingBoxes(level: Pick<Level, "walls" | "openings">): Array<{ id: string; box: Box }> {
  const zones: Array<{ id: string; box: Box }> = [];
  for (const opening of level.openings) {
    if (opening.kind !== "door") continue;
    if (opening.style && opening.style !== "hinged" && opening.style !== "double") continue;
    const wall = level.walls.find((candidate) => candidate.id === opening.wallId);
    const box = wall ? wallBox(wall) : null;
    if (!wall || !box) continue;
    const reach = opening.style === "double" ? opening.widthFt / 2 : opening.widthFt;
    const mid = opening.offsetFt + opening.widthFt / 2 - box.hw;
    for (const side of [1, -1]) {
      const along = box.hd + reach / 2;
      zones.push({
        id: opening.id,
        box: {
          cx: box.cx + box.ux * mid - box.uy * along * side,
          cy: box.cy + box.uy * mid + box.ux * along * side,
          hw: opening.widthFt / 2,
          hd: reach / 2,
          ux: box.ux,
          uy: box.uy,
        },
      });
    }
  }
  return zones;
}

/** The strip in front of a piece it needs clear to be used. */
function frontBox(object: BuildingObject, clearanceFt: number): Box {
  const box = objectBox(object);
  // Front is −z: centre moves by −(depth/2 + clearance/2) along (−sin, cos).
  const shift = box.hd + clearanceFt / 2;
  return { ...box, cx: box.cx + box.uy * shift, cy: box.cy - box.ux * shift, hd: clearanceFt / 2 };
}

const label = (object: BuildingObject) => object.name || "This piece";

/**
 * Every problem with where the furniture is. Stairs and columns are building
 * elements, not furniture, and are only checked as obstacles.
 */
export function clearanceIssues(level: Pick<Level, "walls" | "openings" | "rooms" | "objects">): ClearanceIssue[] {
  const objects = level.objects ?? [];
  const issues: ClearanceIssue[] = [];
  const walls = level.walls.flatMap((wall) => {
    const box = wallBox(wall);
    return box ? [{ id: wall.id, box }] : [];
  });
  const doors = doorSwingBoxes(level);
  const furniture = objects.filter((object) => object.kind !== "stairs" && object.kind !== "column" && object.elevationFt < 0.5);

  for (const object of furniture) {
    const box = objectBox(object);
    const name = label(object);
    for (const other of objects) {
      if (other.id === object.id || other.elevationFt >= 0.5) continue;
      if (furniture.includes(other) && other.id < object.id) continue;
      if (boxesOverlap(box, objectBox(other))) {
        issues.push({ objectId: object.id, code: "overlap", otherId: other.id, message: `${name} overlaps ${label(other).toLowerCase()}.` });
      }
    }
    const crossed = walls.find((wall) => boxesOverlap(box, wall.box, 0.08));
    if (crossed) issues.push({ objectId: object.id, code: "crosses_wall", otherId: crossed.id, message: `${name} runs into a wall.` });
    const door = doors.find((zone) => boxesOverlap(box, zone.box));
    if (door) issues.push({ objectId: object.id, code: "door_swing", otherId: door.id, message: `${name} is in a door's swing.` });
    if (!corners(box).every(([x, y]) => roomContaining(level, x, y)) && !crossed) {
      issues.push({ objectId: object.id, code: "outside", message: `${name} sits outside the rooms.` });
    }
    const clearance = furnitureModel(object.modelId)?.frontClearanceFt ?? 0;
    if (clearance > 0) {
      const front = frontBox(object, clearance);
      const blocked =
        walls.find((wall) => boxesOverlap(front, wall.box)) ??
        objects.filter((other) => other.id !== object.id && furniture.includes(other)).map((other) => ({ id: other.id, box: objectBox(other) }))
          .find((other) => boxesOverlap(front, other.box) && !isCompanion(object, objects, other.id));
      if (blocked) {
        issues.push({ objectId: object.id, code: "front_clearance", otherId: blocked.id, message: `${name} needs ${formatFeet(clearance)} clear in front.` });
      }
    }
  }
  return issues;
}

/** A coffee table in front of a sofa or chairs at a table are meant to be close. */
function isCompanion(object: BuildingObject, objects: BuildingObject[], otherId: string): boolean {
  const other = objects.find((candidate) => candidate.id === otherId);
  if (!other) return false;
  const kinds = new Set([object.kind, other.kind]);
  return (kinds.has("table") && (kinds.has("sofa") || kinds.has("chair"))) || (object.kind === "chair" && other.kind === "chair");
}

function formatFeet(feet: number): string {
  const whole = Math.floor(feet);
  const inches = Math.round((feet - whole) * 12);
  return inches === 0 ? `${whole}′` : `${whole}′ ${inches}″`;
}

/**
 * Where a new piece goes in a room: against the longest wall it fits if it
 * belongs on a wall, otherwise in the middle of the room.
 */
export function placeInRoom(level: Pick<Level, "walls" | "rooms">, room: Room, object: Pick<BuildingObject, "widthFt" | "depthFt">, againstWall: boolean): { xFt: number; yFt: number; rotationDeg: number } {
  const [cx, cy] = roomCenter(room);
  if (!againstWall) return { xFt: cx, yFt: cy, rotationDeg: 0 };
  const ring = room.polygon;
  let bestEdge: { mx: number; my: number; length: number } | null = null;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    const length = Math.hypot(x1 - x0, y1 - y0);
    if (length < object.widthFt + 0.5) continue;
    if (!bestEdge || length > bestEdge.length) bestEdge = { mx: (x0 + x1) / 2, my: (y0 + y1) / 2, length };
  }
  if (!bestEdge) return { xFt: cx, yFt: cy, rotationDeg: 0 };
  // Start just inside the edge, then let the wall snap square it up.
  const toward = Math.hypot(cx - bestEdge.mx, cy - bestEdge.my) || 1;
  const inset = object.depthFt / 2 + 0.5;
  const start = {
    xFt: bestEdge.mx + ((cx - bestEdge.mx) / toward) * inset,
    yFt: bestEdge.my + ((cy - bestEdge.my) / toward) * inset,
    ...object,
  };
  const snap = snapToWall(level, start, 3);
  if (snap && roomContaining({ rooms: [room] }, snap.xFt, snap.yFt)) return { xFt: snap.xFt, yFt: snap.yFt, rotationDeg: snap.rotationDeg };
  return { xFt: cx, yFt: cy, rotationDeg: 0 };
}
