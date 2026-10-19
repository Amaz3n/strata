// One single-storey house, in feet, plan coordinates (x right, y down the
// sheet). The 2D sheet and the 3D model are both drawn from this one
// description, the same way Arc's model is built from the sheet's own linework.

export const HOUSE = { width: 56, depth: 40, wallHeight: 9 };
export const EXTERIOR_T = 0.75;
export const INTERIOR_T = 0.42;

export type OpeningKind = "door" | "window" | "slider";
export type Opening = { from: number; to: number; kind: OpeningKind };

// Every wall is axis-aligned: `x1,y1 → x2,y2` along its centreline, with its
// openings measured from the start point.
export type Wall = { id: string; x1: number; y1: number; x2: number; y2: number; exterior: boolean; openings: Opening[] };

export const SILL = { door: 0, window: 3, slider: 0 } as const;
export const HEAD = { door: 7, window: 7.25, slider: 8 } as const;

export const WALLS: Wall[] = [
  // Exterior, clockwise from the top-left corner.
  {
    id: "north",
    x1: 0, y1: 0, x2: 56, y2: 0, exterior: true,
    openings: [
      { from: 6, to: 12, kind: "window" },
      { from: 23.5, to: 27, kind: "door" },
      { from: 29, to: 37, kind: "window" },
      { from: 42, to: 50, kind: "slider" },
    ],
  },
  { id: "east", x1: 56, y1: 0, x2: 56, y2: 40, exterior: true, openings: [{ from: 33, to: 38, kind: "window" }] },
  {
    id: "south",
    x1: 0, y1: 40, x2: 56, y2: 40, exterior: true,
    openings: [
      { from: 6, to: 12, kind: "window" },
      { from: 28, to: 34, kind: "window" },
    ],
  },
  { id: "west", x1: 0, y1: 0, x2: 0, y2: 40, exterior: true, openings: [{ from: 18.5, to: 21.5, kind: "window" }] },
  // Interior.
  { id: "bed1-living", x1: 22, y1: 0, x2: 22, y2: 16, exterior: false, openings: [] },
  { id: "bed1-hall", x1: 0, y1: 16, x2: 22, y2: 16, exterior: false, openings: [{ from: 15, to: 18, kind: "door" }] },
  { id: "bath-hall", x1: 12, y1: 16, x2: 12, y2: 24, exterior: false, openings: [{ from: 2, to: 5, kind: "door" }] },
  { id: "bed2-hall", x1: 0, y1: 24, x2: 22, y2: 24, exterior: false, openings: [{ from: 15, to: 18, kind: "door" }] },
  { id: "bed2-kitchen", x1: 22, y1: 24, x2: 22, y2: 40, exterior: false, openings: [] },
  { id: "laundry-living", x1: 44, y1: 22, x2: 56, y2: 22, exterior: false, openings: [{ from: 3, to: 6, kind: "door" }] },
  { id: "kitchen-office", x1: 44, y1: 22, x2: 44, y2: 40, exterior: false, openings: [{ from: 11, to: 14, kind: "door" }] },
  { id: "laundry-office", x1: 44, y1: 30, x2: 56, y2: 30, exterior: false, openings: [] },
];

export type Finish = "oak" | "tile";
export type Room = { name: string; x: number; y: number; w: number; h: number; finish: Finish };

export const ROOMS: Room[] = [
  { name: "Bedroom", x: 0, y: 0, w: 22, h: 16, finish: "oak" },
  { name: "Bath", x: 0, y: 16, w: 12, h: 8, finish: "tile" },
  { name: "Hall", x: 12, y: 16, w: 10, h: 8, finish: "oak" },
  { name: "Bedroom 2", x: 0, y: 24, w: 22, h: 16, finish: "oak" },
  { name: "Living", x: 22, y: 0, w: 34, h: 22, finish: "oak" },
  { name: "Kitchen & dining", x: 22, y: 22, w: 22, h: 18, finish: "tile" },
  { name: "Laundry", x: 44, y: 22, w: 12, h: 8, finish: "tile" },
  { name: "Office", x: 44, y: 30, w: 12, h: 10, finish: "oak" },
];

// A placed catalogue piece from public/models/furniture. `rot` is degrees
// about the vertical: 0 faces the piece's front down the sheet (+y).
export type Placement = { id: string; x: number; y: number; rot: number; z?: number };

export const FURNITURE: Placement[] = [
  // Living
  { id: "sofa_03", x: 44, y: 11, rot: 90 },
  { id: "modern_coffee_table_01", x: 49, y: 11, rot: 90 },
  { id: "modern_wooden_cabinet", x: 55, y: 11, rot: -90 },
  { id: "mid_century_lounge_chair", x: 30.5, y: 9, rot: 70 },
  { id: "side_table_01", x: 44, y: 17.4, rot: 0 },
  { id: "potted_plant_02", x: 24.5, y: 19.5, rot: 0 },
  { id: "ArmChair_01", x: 50, y: 4.2, rot: 20 },
  // Kitchen & dining
  { id: "round_wooden_table_01", x: 26.8, y: 33.5, rot: 0 },
  { id: "dining_chair_02", x: 26.8, y: 30.3, rot: 0 },
  { id: "dining_chair_02", x: 26.8, y: 36.7, rot: 180 },
  { id: "dining_chair_02", x: 23.7, y: 33.5, rot: 90 },
  { id: "dining_chair_02", x: 29.9, y: 33.5, rot: -90 },
  { id: "bar_chair_round_01", x: 32, y: 28.6, rot: 0 },
  { id: "bar_chair_round_01", x: 34.5, y: 28.6, rot: 0 },
  { id: "bar_chair_round_01", x: 37, y: 28.6, rot: 0 },
  { id: "potted_plant_04", x: 37.8, y: 31.6, rot: 0, z: 3 },
  // Bedroom
  { id: "ClassicNightstand_01", x: 1.4, y: 3.4, rot: 90 },
  { id: "ClassicNightstand_01", x: 1.4, y: 12.6, rot: 90 },
  { id: "drawer_cabinet", x: 21, y: 7, rot: -90 },
  { id: "potted_plant_02", x: 19.8, y: 13.6, rot: 0 },
  // Bedroom 2
  { id: "ClassicNightstand_01", x: 1.4, y: 27.4, rot: 90 },
  { id: "metal_office_desk", x: 16, y: 38.3, rot: 180 },
  // Office
  { id: "metal_office_desk", x: 54.2, y: 35, rot: -90 },
  { id: "wooden_display_shelves_01", x: 49, y: 39.2, rot: 180 },
  { id: "ArmChair_01", x: 47.6, y: 33, rot: 120 },
];

// Real sizes in feet, from lib/drawings/furniture-catalog.ts.
export const CATALOG: Record<string, { w: number; d: number; h: number }> = {
  sofa_03: { w: 8.96, d: 3.04, h: 3.67 },
  ArmChair_01: { w: 2.78, d: 2.51, h: 3.49 },
  mid_century_lounge_chair: { w: 3.31, d: 3.91, h: 3.84 },
  modern_coffee_table_01: { w: 3.94, d: 1.97, h: 1.28 },
  side_table_01: { w: 1.8, d: 1.48, h: 1.81 },
  round_wooden_table_01: { w: 4.59, d: 4.59, h: 3.3 },
  dining_chair_02: { w: 1.42, d: 1.89, h: 3.19 },
  bar_chair_round_01: { w: 1.59, d: 1.59, h: 2.46 },
  ClassicNightstand_01: { w: 1.86, d: 1.39, h: 2.3 },
  metal_office_desk: { w: 6.56, d: 3.11, h: 2.58 },
  modern_wooden_cabinet: { w: 8.01, d: 1.71, h: 2.23 },
  drawer_cabinet: { w: 3.74, d: 1.6, h: 6.17 },
  wooden_display_shelves_01: { w: 3.54, d: 1.22, h: 5.11 },
  potted_plant_02: { w: 2.3, d: 2.16, h: 2.76 },
  potted_plant_04: { w: 0.55, d: 0.61, h: 0.88 },
};

// Built-ins with no catalogue model, drawn as simple blocks.
export type Block = { kind: "bed" | "counter" | "island" | "tub" | "vanity" | "appliance" | "rug"; x: number; y: number; w: number; d: number; h: number };

export const BLOCKS: Block[] = [
  { kind: "bed", x: 0.4, y: 4.6, w: 7.2, d: 6.8, h: 2 },
  { kind: "bed", x: 0.4, y: 28.6, w: 6.8, d: 5.2, h: 2 },
  { kind: "rug", x: 41, y: 5.5, w: 12, d: 11, h: 0.05 },
  { kind: "rug", x: 6, y: 3.5, w: 7, d: 9, h: 0.05 },
  { kind: "counter", x: 23.5, y: 37.7, w: 19, d: 2.1, h: 3 },
  { kind: "counter", x: 41.8, y: 30, w: 2.1, d: 7.7, h: 3 },
  { kind: "island", x: 30.5, y: 29.8, w: 8.5, d: 3.6, h: 3 },
  { kind: "tub", x: 0.5, y: 16.4, w: 5.4, d: 2.6, h: 1.8 },
  { kind: "vanity", x: 6.6, y: 21.8, w: 4.8, d: 1.8, h: 2.9 },
  { kind: "appliance", x: 52.8, y: 22.6, w: 2.6, d: 2.5, h: 3.2 },
  { kind: "appliance", x: 52.8, y: 25.3, w: 2.6, d: 2.5, h: 3.2 },
];

// A wall broken into the solid pieces around its openings: each piece is a
// run along the wall from `a` to `b` and a height band `z0..z1`.
export type WallPiece = { a: number; b: number; z0: number; z1: number; glass?: boolean };

export function wallLength(w: Wall) {
  return Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
}

export function wallPieces(w: Wall): WallPiece[] {
  const len = wallLength(w);
  const H = HOUSE.wallHeight;
  const openings = [...w.openings].sort((p, q) => p.from - q.from);
  const pieces: WallPiece[] = [];
  let cursor = 0;
  for (const o of openings) {
    if (o.from > cursor) pieces.push({ a: cursor, b: o.from, z0: 0, z1: H });
    if (SILL[o.kind] > 0) pieces.push({ a: o.from, b: o.to, z0: 0, z1: SILL[o.kind] });
    pieces.push({ a: o.from, b: o.to, z0: HEAD[o.kind], z1: H });
    if (o.kind !== "door") pieces.push({ a: o.from, b: o.to, z0: SILL[o.kind], z1: HEAD[o.kind], glass: true });
    cursor = o.to;
  }
  if (cursor < len) pieces.push({ a: cursor, b: len, z0: 0, z1: H });
  return pieces;
}

// Plan-space point at distance `t` along a wall.
export function along(w: Wall, t: number) {
  const len = wallLength(w);
  return { x: w.x1 + ((w.x2 - w.x1) * t) / len, y: w.y1 + ((w.y2 - w.y1) * t) / len };
}

export const roomArea = (r: Room) => Math.round(r.w * r.h);
