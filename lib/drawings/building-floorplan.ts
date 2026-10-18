import type { AreaArchitecture } from "./area-architecture";
import type { InterpretLevelInput } from "./floorplan-sheets";
import { polygonArea, type Level } from "./floorplan-model";

/** A projection of the shared building, never a second wall/room interpreter. */
export function buildingToFloorplan(
  input: InterpretLevelInput,
  architecture: AreaArchitecture,
): Level {
  const building = architecture.building;
  if (!building)
    throw new Error("Shared architectural reconstruction is missing");
  const sx = input.imageWidth * input.feetPerImagePx,
    sy = input.imageHeight * input.feetPerImagePx;
  const point = ([x, y]: [number, number]): [number, number] => [
    x * sx,
    y * sy,
  ];
  return {
    id: `L${input.order}`,
    name: input.name,
    order: input.order,
    ceilingHeightFt: input.ceilingHeightFt ?? 9,
    source: {
      sheetVersionId: input.sheetVersionId,
      sheetNumber: input.sheetNumber,
      sheetTitle: input.sheetTitle,
      imageWidth: input.imageWidth,
      imageHeight: input.imageHeight,
      feetPerImagePx: input.feetPerImagePx,
      originPxX: 0,
      originPxY: 0,
      scaleConfirmed: input.scaleConfirmed ?? false,
      region: input.region,
    },
    reconstruction: {
      version: building.version,
      issues: building.issues,
      source: building.source,
      status: building.status,
      scheduleAssociations: building.scheduleAssociations,
      unmatchedScheduleTags: building.unmatchedScheduleTags,
    },
    walls: building.walls.map((w) => ({
      id: w.id,
      x0: w.a[0] * sx,
      y0: w.a[1] * sy,
      x1: w.b[0] * sx,
      y1: w.b[1] * sy,
      thicknessFt: w.thicknessFt,
      source: "paired",
      confidence: 0.8,
      evidence: {
        basis:
          architecture.building?.source.kind === "raster" ? "raster" : "vector",
        sheetVersionId: input.sheetVersionId,
        pathIds: w.pathIds,
        reviewed: false,
      },
    })),
    openings: building.openings.map((o) => ({
      id: o.id,
      wallId: o.wallId,
      kind: o.kind,
      offsetFt: o.offsetFt,
      widthFt: o.widthFt,
      widthBasis: o.widthBasis,
      clearWidthFt: o.clearWidthFt,
      leafWidthFt: o.leafWidthFt,
      sillFt: o.kind === "window" ? 3 : 0,
      headFt: Math.min(7, input.ceilingHeightFt ?? 9),
      confidence: 0.7,
      style: o.style ?? (o.kind === "window" ? "fixed" : "hinged"),
      evidence: {
        basis:
          architecture.building?.source.kind === "raster" ? "raster" : "vector",
        sheetVersionId: input.sheetVersionId,
        pathIds: o.pathIds,
        reviewed: false,
      },
    })),
    rooms: architecture.spaces.map((s) => {
      const polygon = s.points.map(point),
        holes = s.holes.map((h) => h.map(point));
      return {
        id: s.id,
        polygon,
        holes,
        label: s.labels.length ? s.labels.join(" / ") : null,
        areaSqft:
          polygonArea(polygon) - holes.reduce((n, h) => n + polygonArea(h), 0),
        confidence: 0.7,
        evidence: {
          basis: building.source.kind === "raster" ? "raster" : s.boundary.visualFraction ? "vision" : "vector",
          sheetVersionId: input.sheetVersionId,
          reviewed: false,
        },
      };
    }),
    reviewed: false,
    confidence: { walls: 0, openings: 0, rooms: 0 },
  };
}
