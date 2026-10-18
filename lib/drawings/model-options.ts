import { z } from "zod";

import { FINISH_PRESETS } from "./architectural-model";
import { FURNITURE_CATALOG, furnitureModel, furnitureObject } from "./furniture-catalog";
import { placeInRoom } from "./furniture-layout";
import type { FloorplanModel, Level, Room, Wall } from "./floorplan-model";

/**
 * What a Design Studio option does to the house.
 *
 * An option in the catalogue can carry model changes: "oak floors in the
 * bedrooms", "walnut accent wall in the living room", "a sectional in the
 * family room". The 3D model applies them so a buyer sees the option, and the
 * price comes from the model's own quantities — floor SF of the rooms it
 * touches, wall SF of their walls, or a fixed price per piece — so an option
 * on a bigger plan costs more without anyone re-pricing it by hand.
 *
 * Rooms are matched by label (case-insensitive substring, any of the list);
 * an empty list means every room. Money is integer cents.
 */

export const roomMatchSchema = z.array(z.string().trim().min(1).max(40)).max(12);

const finishKey = z.enum(Object.keys(FINISH_PRESETS) as [string, ...string[]]);
const furnitureId = z.enum(FURNITURE_CATALOG.map((model) => model.id) as [string, ...string[]]);

export const modelChangeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("floor_finish"),
    finish: finishKey,
    rooms: roomMatchSchema,
    /** Per square foot of floor in the matched rooms. */
    unitPriceCents: z.number().int().min(0).max(10_000_00),
  }),
  z.object({
    kind: z.literal("wall_finish"),
    finish: finishKey,
    rooms: roomMatchSchema,
    /** Per square foot of wall around the matched rooms (perimeter × ceiling height). */
    unitPriceCents: z.number().int().min(0).max(10_000_00),
  }),
  z.object({
    kind: z.literal("furniture"),
    modelId: furnitureId,
    rooms: roomMatchSchema,
    /** Per piece placed. */
    priceCents: z.number().int().min(0).max(1_000_000_00),
  }),
]);

export const modelChangesSchema = z.array(modelChangeSchema).max(12);

export type ModelChange = z.infer<typeof modelChangeSchema>;

/** A catalogue option as the model sees it. */
export interface ModelOption {
  id: string;
  name: string;
  modelChanges: ModelChange[];
}

export interface PricedChange {
  change: ModelChange;
  quantity: number;
  uom: "sf" | "ea";
  totalCents: number;
  rooms: string[];
}

export function roomMatches(room: Pick<Room, "label">, labels: string[]): boolean {
  if (labels.length === 0) return true;
  const name = (room.label ?? "").toLowerCase();
  return labels.some((label) => name.includes(label.toLowerCase()));
}

function perimeterFt(ring: Array<[number, number]>): number {
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    total += Math.hypot(x1 - x0, y1 - y0);
  }
  return total;
}

function distanceToSegment(px: number, py: number, [x0, y0]: [number, number], [x1, y1]: [number, number]): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = dx * dx + dy * dy;
  const t = length < 1e-9 ? 0 : Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / length));
  return Math.hypot(px - (x0 + dx * t), py - (y0 + dy * t));
}

/** Walls that bound a room: their midpoint lies on (or within a wall's width of) its outline. */
export function wallsOfRoom(level: Pick<Level, "walls">, room: Room): Wall[] {
  const ring = room.polygon;
  return level.walls.filter((wall) => {
    const mx = (wall.x0 + wall.x1) / 2;
    const my = (wall.y0 + wall.y1) / 2;
    const reach = wall.thicknessFt / 2 + 0.35;
    return ring.some((point, index) => distanceToSegment(mx, my, point, ring[(index + 1) % ring.length]) <= reach);
  });
}

/**
 * What the change costs on THIS model: floor SF of the rooms it touches, the
 * gross wall SF around them (perimeter × ceiling height — the way a finish
 * sub prices paint or panelling), or a fixed price per piece.
 */
export function priceModelChange(model: Pick<FloorplanModel, "levels">, change: ModelChange): PricedChange {
  const rooms: string[] = [];
  let quantity = 0;
  for (const level of model.levels) {
    for (const room of level.rooms) {
      if (!roomMatches(room, change.rooms)) continue;
      rooms.push(room.label ?? "Room");
      if (change.kind === "floor_finish") quantity += room.areaSqft;
      else if (change.kind === "wall_finish") quantity += perimeterFt(room.polygon) * (room.ceilingHeightFt ?? level.ceilingHeightFt);
      else quantity += 1;
    }
  }
  if (change.kind === "furniture") return { change, quantity, uom: "ea", totalCents: quantity * change.priceCents, rooms };
  const sf = Math.round(quantity);
  return { change, quantity: sf, uom: "sf", totalCents: sf * change.unitPriceCents, rooms };
}

export function priceModelOption(model: Pick<FloorplanModel, "levels">, option: ModelOption): { lines: PricedChange[]; totalCents: number } {
  const lines = option.modelChanges.map((change) => priceModelChange(model, change));
  return { lines, totalCents: lines.reduce((sum, line) => sum + line.totalCents, 0) };
}

/**
 * The house with these options in it. Pure: the saved model is never edited —
 * the viewer shows this copy while options are on. Furniture ids are derived
 * from the option, change and room, so toggling an option on twice draws the
 * same pieces in the same places.
 */
export function applyModelOptions(model: FloorplanModel, options: ModelOption[]): FloorplanModel {
  if (options.length === 0) return model;
  const levels = model.levels.map((level) => {
    let rooms = level.rooms;
    let walls = level.walls;
    const objects = [...(level.objects ?? [])];
    for (const option of options) {
      option.modelChanges.forEach((change, index) => {
        const matched = rooms.filter((room) => roomMatches(room, change.rooms));
        if (matched.length === 0) return;
        if (change.kind === "floor_finish") {
          const ids = new Set(matched.map((room) => room.id));
          rooms = rooms.map((room) => (ids.has(room.id) ? { ...room, finish: { ...FINISH_PRESETS[change.finish] } } : room));
        } else if (change.kind === "wall_finish") {
          const ids = new Set(matched.flatMap((room) => wallsOfRoom({ walls }, room).map((wall) => wall.id)));
          walls = walls.map((wall) => (ids.has(wall.id) ? { ...wall, finish: { ...FINISH_PRESETS[change.finish] } } : wall));
        } else {
          const piece = furnitureModel(change.modelId);
          if (!piece) return;
          for (const room of matched) {
            const at = placeInRoom({ walls, rooms }, room, piece, piece.againstWall);
            objects.push({ ...furnitureObject(piece, at), id: `option:${option.id}:${index}:${room.id}` });
          }
        }
      });
    }
    return { ...level, rooms, walls, objects };
  });
  return { ...model, levels };
}
