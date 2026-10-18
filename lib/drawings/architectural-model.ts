/** Editable building data shared by interpretation, quantities and presentation.
 * Geometry is derived from this document; never use rendered triangles as truth. */
export type PlanPoint = [number, number];
export type EvidenceBasis =
  | "vector"
  | "raster"
  | "vision"
  | "dimension"
  | "default"
  | "manual";
export interface ArchitecturalEvidence {
  basis: EvidenceBasis;
  sheetVersionId?: string;
  pathIds?: number[];
  reviewed?: boolean;
}
export interface FloorPlacement {
  xFt: number;
  yFt: number;
  rotationDeg: number;
  elevationFt: number;
  assemblyFt: number;
  confirmed: boolean;
}
export interface SurfaceFinish {
  color: string;
  pattern: "solid" | "wood" | "tile" | "stone";
  scaleFt: number;
  roughness: number;
  rotationDeg?: number;
}
export interface BuildingObject {
  id: string;
  kind:
    | "sofa"
    | "table"
    | "chair"
    | "bed"
    | "cabinet"
    | "counter"
    | "sink"
    | "toilet"
    | "tub"
    | "appliance"
    | "stairs"
    | "column";
  name: string;
  xFt: number;
  yFt: number;
  widthFt: number;
  depthFt: number;
  heightFt: number;
  elevationFt: number;
  rotationDeg: number;
  color: string;
  /** Stairs connect explicit levels, never inferred from array order. */
  targetLevelId?: string;
  /** A real furniture model from `FURNITURE_CATALOG`; the box is its footprint. */
  modelId?: string;
}

/**
 * Where the building sits: which way the plan's up points (degrees clockwise
 * from true north) and how far north it is. Together they put the sun where it
 * really is at a given date and hour.
 */
export interface SiteOrientation {
  northDeg: number;
  latitudeDeg: number;
}
export interface RoofDefinition {
  kind: "flat" | "gable" | "hip";
  riseFt: number;
  overhangFt: number;
  rotationDeg: number;
  color: string;
}
export interface SavedModelView {
  id: string;
  name: string;
  levelId: string;
  mode: "orbit" | "walk";
  position: [number, number, number];
  target: [number, number, number];
  /** A recorded walkthrough — position then target per sample — played from this view. */
  path?: Array<[number, number, number, number, number, number]>;
}
export interface ModelIssue {
  id: string;
  severity: "error" | "review";
  message: string;
  levelId?: string;
  objectId?: string;
}
export interface ModelSourceSelection {
  sheetVersionId: string;
  name: string;
  order: number;
  region: { x0: number; y0: number; x1: number; y1: number };
  feetPerImagePx: number;
  ceilingHeightFt: number;
}

export const OBJECT_PRESETS: Record<
  BuildingObject["kind"],
  { name: string; widthFt: number; depthFt: number; heightFt: number }
> = {
  sofa: { name: "Sofa", widthFt: 7, depthFt: 3, heightFt: 2.6 },
  table: { name: "Dining table", widthFt: 6, depthFt: 3, heightFt: 2.5 },
  chair: { name: "Chair", widthFt: 1.8, depthFt: 1.8, heightFt: 3 },
  bed: { name: "Bed", widthFt: 5, depthFt: 6.7, heightFt: 2 },
  cabinet: { name: "Base cabinet", widthFt: 3, depthFt: 2, heightFt: 3 },
  counter: { name: "Island", widthFt: 6, depthFt: 3, heightFt: 3 },
  sink: { name: "Sink", widthFt: 2.5, depthFt: 2, heightFt: 3 },
  toilet: { name: "Toilet", widthFt: 1.7, depthFt: 2.5, heightFt: 2.5 },
  tub: { name: "Bathtub", widthFt: 5, depthFt: 2.5, heightFt: 1.8 },
  appliance: { name: "Refrigerator", widthFt: 3, depthFt: 2.5, heightFt: 6 },
  stairs: { name: "Straight stairs", widthFt: 3.5, depthFt: 12, heightFt: 10 },
  column: { name: "Column", widthFt: 1, depthFt: 1, heightFt: 9 },
};

export const FINISH_PRESETS: Record<string, SurfaceFinish> = {
  plaster: { color: "#eee9df", pattern: "solid", scaleFt: 1, roughness: 0.85 },
  oak: { color: "#c5a47c", pattern: "wood", scaleFt: 4, roughness: 0.65 },
  walnut: { color: "#72523d", pattern: "wood", scaleFt: 4, roughness: 0.55 },
  limestone: { color: "#d8d2c4", pattern: "stone", scaleFt: 2, roughness: 0.8 },
  porcelain: { color: "#e2e0d9", pattern: "tile", scaleFt: 2, roughness: 0.35 },
  charcoal: { color: "#454847", pattern: "solid", scaleFt: 1, roughness: 0.7 },
  carpet: { color: "#cbbfad", pattern: "stone", scaleFt: 1.5, roughness: 1 },
  concrete: { color: "#b9b6af", pattern: "stone", scaleFt: 3, roughness: 0.9 },
};

/** Physical material colors, separate from application interface tokens. */
export const MODEL_MATERIAL_COLORS = {
  furniture: "#bfae98",
  roof: "#646963",
  plaster: "#eee9df",
  wall: "#eeeae2",
  floor: "#c3b292",
  textureBase: "#ffffff",
  grout: "#a5a5a5",
  woodSeam: "#b0a8a0",
} as const;
