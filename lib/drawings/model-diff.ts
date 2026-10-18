import type { Level, Room, Wall } from "./floorplan-model";

/**
 * What changed between two revisions of the same floor.
 *
 * Both sides must be in the same frame (feet on the same sheet geometry); the
 * caller aligns them. Rooms match when each one's centroid falls inside the
 * other, walls when both ends land within `WALL_MATCH_FT` (either way round).
 * A lengthened wall therefore reads as one removed and one added — which is
 * exactly how it is built.
 *
 * Pricing is deliberately narrow: only takeoff items that report in SF are
 * priced from an area change (Δ SF × (1 + waste) × unit cost); anything else
 * is reported as "quantity moves, not priced" rather than guessed at.
 */

const WALL_MATCH_FT = 0.6;
const AREA_CHANGE_SQFT = 1;

export type RoomChangeStatus = "added" | "removed" | "changed";

export interface RoomChange {
  /** The current room's id; the old room's id when it was removed. */
  roomId: string;
  status: RoomChangeStatus;
  label: string | null;
  beforeSqft: number;
  afterSqft: number;
  /** The removed room's outline, so it can be drawn as a ghost. */
  polygon: Array<[number, number]>;
}

export interface LevelDiff {
  rooms: RoomChange[];
  addedWalls: Wall[];
  removedWalls: Wall[];
}

type Shape = Pick<Level, "rooms" | "walls">;

function centroid(ring: Array<[number, number]>): [number, number] {
  let area = 0;
  let x = 0;
  let y = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    area += cross;
    x += (ring[j][0] + ring[i][0]) * cross;
    y += (ring[j][1] + ring[i][1]) * cross;
  }
  if (Math.abs(area) < 1e-9) return ring[0] ?? [0, 0];
  return [x / (3 * area), y / (3 * area)];
}

function inside(ring: Array<[number, number]>, [x, y]: [number, number]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function sameRoom(a: Room, b: Room): boolean {
  return inside(b.polygon, centroid(a.polygon)) && inside(a.polygon, centroid(b.polygon));
}

function sameWall(a: Wall, b: Wall): boolean {
  const d = (x0: number, y0: number, x1: number, y1: number) => Math.hypot(x1 - x0, y1 - y0);
  const forward = d(a.x0, a.y0, b.x0, b.y0) <= WALL_MATCH_FT && d(a.x1, a.y1, b.x1, b.y1) <= WALL_MATCH_FT;
  const reverse = d(a.x0, a.y0, b.x1, b.y1) <= WALL_MATCH_FT && d(a.x1, a.y1, b.x0, b.y0) <= WALL_MATCH_FT;
  return forward || reverse;
}

export function diffLevel(before: Shape, after: Shape): LevelDiff {
  const rooms: RoomChange[] = [];
  const matched = new Set<string>();
  for (const room of after.rooms) {
    const previous = before.rooms.find((candidate) => !matched.has(candidate.id) && sameRoom(candidate, room));
    if (!previous) {
      rooms.push({ roomId: room.id, status: "added", label: room.label, beforeSqft: 0, afterSqft: room.areaSqft, polygon: room.polygon });
      continue;
    }
    matched.add(previous.id);
    if (Math.abs(previous.areaSqft - room.areaSqft) >= AREA_CHANGE_SQFT) {
      rooms.push({ roomId: room.id, status: "changed", label: room.label ?? previous.label, beforeSqft: previous.areaSqft, afterSqft: room.areaSqft, polygon: room.polygon });
    }
  }
  for (const room of before.rooms) {
    if (!matched.has(room.id)) rooms.push({ roomId: room.id, status: "removed", label: room.label, beforeSqft: room.areaSqft, afterSqft: 0, polygon: room.polygon });
  }
  return {
    rooms,
    addedWalls: after.walls.filter((wall) => !before.walls.some((old) => sameWall(old, wall))),
    removedWalls: before.walls.filter((wall) => !after.walls.some((next) => sameWall(wall, next))),
  };
}

export interface PricedCondition {
  conditionId: string;
  name: string;
  uom: string;
  wastePct: number;
  unitCostCents: number | null;
}

export interface EstimateDelta {
  lines: Array<{ conditionId: string; name: string; deltaSqft: number; deltaCents: number | null }>;
  /** Sum of the priced lines only. */
  totalCents: number;
  /** Items whose quantity moves but that this diff will not price. */
  unpriced: string[];
}

/**
 * What the change does to the estimate: each room change, through the items
 * that count that room. `countedBy` maps a room id (current id for added and
 * changed rooms, old id for removed ones) to the takeoff items counting it.
 */
export function estimateDelta(diff: LevelDiff, countedBy: Map<string, string[]>, conditions: PricedCondition[]): EstimateDelta {
  const byId = new Map(conditions.map((condition) => [condition.conditionId, condition]));
  const deltas = new Map<string, number>();
  for (const change of diff.rooms) {
    for (const conditionId of countedBy.get(change.roomId) ?? []) {
      deltas.set(conditionId, (deltas.get(conditionId) ?? 0) + change.afterSqft - change.beforeSqft);
    }
  }
  const lines: EstimateDelta["lines"] = [];
  const unpriced: string[] = [];
  let totalCents = 0;
  for (const [conditionId, deltaSqft] of deltas) {
    const condition = byId.get(conditionId);
    if (!condition || Math.abs(deltaSqft) < AREA_CHANGE_SQFT) continue;
    const priceable = condition.uom === "sf" && condition.unitCostCents !== null;
    const deltaCents = priceable ? Math.round(deltaSqft * (1 + condition.wastePct / 100) * (condition.unitCostCents ?? 0)) : null;
    if (deltaCents === null) unpriced.push(condition.name);
    else totalCents += deltaCents;
    lines.push({ conditionId, name: condition.name, deltaSqft: Math.round(deltaSqft), deltaCents });
  }
  return { lines, totalCents, unpriced };
}
