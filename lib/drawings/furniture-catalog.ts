import { MODEL_MATERIAL_COLORS, type BuildingObject } from "./architectural-model";

/**
 * Real furniture, scanned and modelled — Poly Haven, CC0
 * (`public/models/furniture/CREDITS.md`).
 *
 * A placed piece is still a `BuildingObject`: its box is the footprint every
 * layout rule, clearance check and procedural fallback reads, and `modelId`
 * says which real piece to draw inside it. Sizes are the models' measured
 * bounds in feet, so a sofa dropped in a room takes the floor it really takes.
 *
 * Object convention: the BACK of a piece is local +z (the side that goes
 * against a wall), the front faces −z. Every model here was authored facing
 * +Z, so the scene turns it half a turn; `yawOffsetDeg` covers any that differ.
 */

export type FurnitureCategory = "living" | "dining" | "bedroom" | "office" | "storage" | "decor";

export interface FurnitureModel {
  id: string;
  name: string;
  category: FurnitureCategory;
  /** The procedural kind drawn while the model loads, or if it cannot. */
  kind: BuildingObject["kind"];
  widthFt: number;
  depthFt: number;
  heightFt: number;
  /** Sits with its back to a wall when placed (sofas, cabinets, shelves). */
  againstWall: boolean;
  /** Clear floor the piece needs in front of it to be usable, in feet. */
  frontClearanceFt: number;
  yawOffsetDeg?: number;
}

export const FURNITURE_CATEGORY_LABELS: Record<FurnitureCategory, string> = {
  living: "Living",
  dining: "Dining",
  bedroom: "Bedroom",
  office: "Office",
  storage: "Storage",
  decor: "Plants",
};

const piece = (
  id: string,
  name: string,
  category: FurnitureCategory,
  kind: BuildingObject["kind"],
  [widthFt, depthFt, heightFt]: [number, number, number],
  againstWall: boolean,
  frontClearanceFt: number,
): FurnitureModel => ({ id, name, category, kind, widthFt, depthFt, heightFt, againstWall, frontClearanceFt });

export const FURNITURE_CATALOG: readonly FurnitureModel[] = [
  piece("sofa_03", "Sectional sofa", "living", "sofa", [8.96, 3.04, 3.67], true, 2.5),
  piece("sofa_02", "Three-seat sofa", "living", "sofa", [5.93, 2.68, 2.33], true, 2.5),
  piece("Sofa_01", "Loveseat", "living", "sofa", [5.16, 2.16, 2.61], true, 2.5),
  piece("ArmChair_01", "Armchair", "living", "chair", [2.78, 2.51, 3.49], false, 2),
  piece("mid_century_lounge_chair", "Lounge chair", "living", "chair", [3.31, 3.91, 3.84], false, 2),
  piece("Ottoman_01", "Ottoman", "living", "table", [2.9, 2.04, 2.05], false, 1),
  piece("modern_coffee_table_01", "Coffee table", "living", "table", [3.94, 1.97, 1.28], false, 1.5),
  piece("coffee_table_round_01", "Round coffee table", "living", "table", [4.27, 4.27, 1.61], false, 1.5),
  piece("side_table_01", "Side table", "living", "table", [1.8, 1.48, 1.81], false, 0),
  piece("round_wooden_table_01", "Round dining table", "dining", "table", [4.59, 4.59, 3.3], false, 3),
  piece("dining_chair_02", "Dining chair", "dining", "chair", [1.42, 1.89, 3.19], false, 1.5),
  piece("bar_chair_round_01", "Bar stool", "dining", "chair", [1.59, 1.59, 2.46], false, 1),
  piece("WoodenTable_02", "Stool table", "dining", "table", [0.99, 0.99, 1.37], false, 0),
  piece("ClassicNightstand_01", "Nightstand", "bedroom", "cabinet", [1.86, 1.39, 2.3], true, 1),
  piece("metal_office_desk", "Desk", "office", "table", [6.56, 3.11, 2.58], true, 3),
  piece("modern_wooden_cabinet", "Media console", "storage", "cabinet", [8.01, 1.71, 2.23], true, 3),
  piece("drawer_cabinet", "Tall dresser", "storage", "cabinet", [3.74, 1.6, 6.17], true, 2.5),
  piece("wooden_display_shelves_01", "Display shelves", "storage", "cabinet", [3.54, 1.22, 5.11], true, 2.5),
  piece("potted_plant_02", "Floor plant", "decor", "appliance", [2.3, 2.16, 2.76], false, 0),
  piece("potted_plant_04", "Table plant", "decor", "appliance", [0.55, 0.61, 0.88], false, 0),
];

const BY_ID = new Map(FURNITURE_CATALOG.map((model) => [model.id, model]));

export function furnitureModel(id: string | undefined): FurnitureModel | null {
  return id ? (BY_ID.get(id) ?? null) : null;
}

/** Where the scene fetches a model. Ids are catalogue keys, never user text. */
export function furnitureModelUrl(model: FurnitureModel): string {
  return `/models/furniture/${model.id}/${model.id}.gltf`;
}

/** A fresh object for a catalogue piece, at its real size. */
export function furnitureObject(model: FurnitureModel, at: { xFt: number; yFt: number; rotationDeg?: number }): BuildingObject {
  return {
    id: crypto.randomUUID(),
    kind: model.kind,
    name: model.name,
    xFt: at.xFt,
    yFt: at.yFt,
    widthFt: model.widthFt,
    depthFt: model.depthFt,
    heightFt: model.heightFt,
    elevationFt: 0,
    rotationDeg: at.rotationDeg ?? 0,
    color: MODEL_MATERIAL_COLORS.furniture,
    modelId: model.id,
  };
}
