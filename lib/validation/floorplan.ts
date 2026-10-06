import { validRecognitionImageSource, type RecognitionImageSource } from "@/lib/drawings/recognition-image-source";
import { z } from "zod";
import { validRasterGeometryTiling, type RasterGeometryTiling } from "@/lib/drawings/raster-geometry-tiles";
import { RASTER_CONTEXT_PROFILE, validRasterContext } from "@/lib/drawings/raster-context";

import { OPENING_KINDS } from "@/lib/drawings/floorplan-model";
import { OPENING_WIDTH_BASES } from "@/lib/drawings/opening-dimensions";
import { windowScheduleAssociationSchema, unmatchedWindowScheduleTagSchema } from "./window-schedules";
import { SOURCE_REVIEW_GROUP_SIZE } from "@/lib/drawings/reconstruction-review-groups";
import { MAX_TOUR_POINTS } from "@/lib/plans/camera-tour";

/**
 * Validation for floorplan models and the corrections applied to them.
 *
 * The model document round-trips through `jsonb`, so it is re-validated on the
 * way back OUT as well as in: a row written by an older algorithm revision, or
 * hand-edited in the database, must not reach the 3D viewer as a half-shape
 * that throws inside a render loop.
 */

const finite = z.number().finite();
const point = z.tuple([finite, finite]);
const contextRegion = z.object({x0:finite.min(0).max(1),y0:finite.min(0).max(1),x1:finite.min(0).max(1),y1:finite.min(0).max(1)});
const rasterContextSchema = z.object({
  profile:z.literal(RASTER_CONTEXT_PROFILE), requestedRegion:contextRegion, initialRegion:contextRegion, effectiveRegion:contextRegion,
  initialEvidenceSha256:z.string().regex(/^[a-f0-9]{64}$/), triggerPathIds:z.array(z.number().int().min(0)).max(64), edges:z.array(z.enum(['left','top','right','bottom'])).max(4),
  attempts:z.union([z.literal(0),z.literal(1)]),status:z.enum(['unchanged','expanded','unresolved']),reason:z.enum(['page-edge','geometry-budget','source-unverified','remaining-clipping','read-failed']).optional(),
}).refine(v=>validRasterContext(v,v.requestedRegion,v.effectiveRegion), 'Invalid scan source context');

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const finishSchema = z.object({
  color,
  pattern: z.enum(["solid", "wood", "tile", "stone"]),
  scaleFt: finite.positive().max(100),
  roughness: finite.min(0).max(1),
  rotationDeg: finite.optional(),
});
const evidenceSchema = z.object({
  basis: z.enum([
    "vector",
    "raster",
    "vision",
    "dimension",
    "default",
    "manual",
  ]),
  sheetVersionId: z.string().optional(),
  pathIds: z.array(z.number().int()).max(2000).optional(),
  reviewed: z.boolean().optional(),
});
export const placementSchema = z.object({
  xFt: finite,
  yFt: finite,
  rotationDeg: finite,
  elevationFt: finite,
  assemblyFt: finite.min(0).max(10),
  confirmed: z.boolean(),
});
export const objectSchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.enum([
    "sofa",
    "table",
    "chair",
    "bed",
    "cabinet",
    "counter",
    "sink",
    "toilet",
    "tub",
    "appliance",
    "stairs",
    "column",
  ]),
  name: z.string().min(1).max(100),
  xFt: finite,
  yFt: finite,
  widthFt: finite.positive().max(100),
  depthFt: finite.positive().max(100),
  heightFt: finite.positive().max(100),
  elevationFt: finite,
  rotationDeg: finite,
  color,
  targetLevelId: z.string().optional(),
  modelId: z.string().min(1).max(80).optional(),
});

export const siteSchema = z.object({
  northDeg: finite.min(-360).max(360),
  latitudeDeg: finite.min(-66).max(66),
});
export const roofSchema = z.object({
  kind: z.enum(["flat", "gable", "hip"]),
  riseFt: finite.min(0).max(50),
  overhangFt: finite.min(0).max(10),
  rotationDeg: finite,
  color,
});
export const viewSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  levelId: z.string(),
  mode: z.enum(["orbit", "walk"]),
  position: z.tuple([finite, finite, finite]),
  target: z.tuple([finite, finite, finite]),
  /** A recorded walkthrough: position then target, every ~0.25 s. */
  path: z.array(z.tuple([finite, finite, finite, finite, finite, finite])).max(MAX_TOUR_POINTS).optional(),
});
const regionSchema = z
  .object({
    x0: finite.min(0).max(1),
    y0: finite.min(0).max(1),
    x1: finite.min(0).max(1),
    y1: finite.min(0).max(1),
  })
  .refine((r) => r.x1 > r.x0 && r.y1 > r.y0, "Choose a nonempty plan region");
export const sourceSelectionsSchema = z
  .array(
    z.object({
      sheetVersionId: z.string().uuid(),
      name: z.string().min(1).max(60),
      order: z.number().int().min(-10).max(100),
      region: regionSchema,
      feetPerImagePx: finite.positive().max(100),
      ceilingHeightFt: finite.min(6).max(20),
    }),
  )
  .min(1)
  .max(30)
  .refine(
    (sources) =>
      new Set(sources.map((source) => source.order)).size === sources.length,
    "Each floor must have a unique order",
  );

export const floorplanSourceSchema = z.object({
  scaleConfirmed: z.boolean().optional(),
  region: regionSchema.optional(),
  sheetVersionId: z.string(),
  sheetNumber: z.string().nullable(),
  sheetTitle: z.string().nullable(),
  imageWidth: finite.positive(),
  imageHeight: finite.positive(),
  feetPerImagePx: finite.positive(),
  originPxX: finite,
  originPxY: finite,
});

export const wallSchema = z.object({
  heightFt: finite.min(0.5).max(40).optional(),
  finish: finishSchema.optional(),
  evidence: evidenceSchema.optional(),
  id: z.string().min(1),
  x0: finite,
  y0: finite,
  x1: finite,
  y1: finite,
  thicknessFt: finite.positive().max(4),
  confidence: finite.min(0).max(1),
  source: z.enum(["paired", "single", "manual"]),
});

export const openingSchema = z.object({
  clearWidthFt: finite.positive().max(40).optional(),
  leafWidthFt: finite.positive().max(40).optional(),
  widthBasis: z.enum(OPENING_WIDTH_BASES).optional(),
  handing: z.enum(["left", "right"]).optional(),
  swing: z.enum(["in", "out"]).optional(),
  style: z
    .enum(["hinged", "double", "sliding", "pocket", "garage", "fixed"])
    .optional(),
  evidence: evidenceSchema.optional(),
  id: z.string().min(1),
  wallId: z.string().min(1),
  kind: z.enum(OPENING_KINDS as unknown as [string, ...string[]]),
  offsetFt: finite.min(0),
  widthFt: finite.positive().max(40),
  sillFt: finite.min(0).max(30),
  headFt: finite.min(0).max(30),
  confidence: finite.min(0).max(1),
});

export const roomSchema = z.object({
  holes: z.array(z.array(point).min(3).max(2000)).max(100).optional(),
  finish: finishSchema.optional(),
  ceilingHeightFt: finite.min(6).max(40).optional(),
  evidence: evidenceSchema.optional(),
  id: z.string().min(1),
  polygon: z.array(point).min(3),
  label: z.string().nullable(),
  areaSqft: finite.min(0),
  confidence: finite.min(0).max(1),
});

export const levelSchema = z.object({
  reconstruction: z
    .object({
      resolutions: z
        .array(
          z.object({
            issueId: z.string(),
            note: z.string().trim().min(8).max(500),
          }),
        )
        .max(10000)
        .optional(),
      version: z.literal(1),
      scheduleAssociations: z.array(windowScheduleAssociationSchema).max(2000).optional(),
      unmatchedScheduleTags: z.array(unmatchedWindowScheduleTagSchema).max(2000).optional(),
      status: z.enum(["needs-review", "incomplete"]),
      source: z.object({
        kind: z.enum(["vector", "raster"]).optional(),
        rasterContext: rasterContextSchema.optional(),
        recognitionImages: z.array(z.object({observationId:z.string().min(1).max(200),image:z.custom<RecognitionImageSource>(validRecognitionImageSource)})).max(1024).optional(),
        rasterTiling: z.custom<RasterGeometryTiling>(value=>!!value && typeof value==='object' && validRasterGeometryTiling(value,(value as RasterGeometryTiling).requestedRegion)).optional(),
        wallPathCount: z.number().int().min(0),
        representedWallPathCount: z.number().int().min(0),
        excludedPathCount: z.number().int().min(0),
      }),
      issues: z
        .array(
          z.object({
            id: z.string(),
            code: z.string(),
            message: z.string(),
            severity: z.enum(["error", "review"]),
            pathIds: z.array(z.number().int()),
            point: point.optional(),
            objectId: z.string().optional(),
            members: z.array(z.object({id:z.string(),message:z.string(),point:point.optional()})).min(2).max(SOURCE_REVIEW_GROUP_SIZE).optional(),
          }),
        )
        .max(10000),
    })
    .optional(),
  placement: placementSchema.optional(),
  objects: z.array(objectSchema).max(1000).optional(),
  roof: roofSchema.optional(),
  reviewed: z.boolean().optional(),
  id: z.string().min(1),
  name: z.string().min(1),
  order: z.number().int(),
  ceilingHeightFt: finite.min(6).max(20),
  source: floorplanSourceSchema,
  walls: z.array(wallSchema),
  openings: z.array(openingSchema),
  rooms: z.array(roomSchema),
  confidence: z.object({
    walls: finite.min(0).max(1),
    openings: finite.min(0).max(1),
    rooms: finite.min(0).max(1),
  }),
});

export const floorplanModelSchema = z.object({
  schemaRevision: z.number().int().optional(),
  views: z.array(viewSchema).max(30).optional(),
  version: z.literal(1),
  units: z.literal("feet"),
  levels: z.array(levelSchema),
  site: siteSchema.optional(),
  correctionCount: z.number().int().min(0),
  // Optional: models written before partial-result reporting existed have none.
  acknowledgedWarnings: z.array(z.string().max(300)).max(20).optional(),
  warnings: z.array(z.string().max(300)).max(20).optional(),
});

/**
 * Which house a model belongs to. Mirrors `FloorplanTarget`.
 *
 * A discriminated union rather than two optional ids, so "both set" and
 * "neither set" are unrepresentable at the edge as well as in the database.
 */
export const floorplanTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plan"), housePlanVersionId: z.string().uuid() }),
  z.object({ kind: z.literal("project"), projectId: z.string().uuid() }),
]);

/** One correction from the review UI. Mirrors `FloorplanEdit`. */
export const floorplanEditSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("wall.update"),
    levelId: z.string(),
    wallId: z.string(),
    changes: wallSchema
      .pick({
        x0: true,
        y0: true,
        x1: true,
        y1: true,
        thicknessFt: true,
        heightFt: true,
        finish: true,
      })
      .partial(),
  }),
  z.object({
    type: z.literal("opening.upsert"),
    levelId: z.string(),
    opening: openingSchema,
  }),
  z.object({
    type: z.literal("room.update"),
    levelId: z.string(),
    roomId: z.string(),
    changes: roomSchema
      .pick({ polygon: true, holes: true, finish: true, ceilingHeightFt: true })
      .partial(),
  }),
  z.object({
    type: z.literal("level.placement"),
    levelId: z.string(),
    placement: placementSchema,
  }),
  z.object({
    type: z.literal("source.review"),
    levelId: z.string(),
    warning: z.string().max(300),
    acknowledged: z.boolean(),
  }),
  z.object({
    type: z.literal("reconstruction.resolve"),
    levelId: z.string(),
    issueId: z.string(),
    note: z.string().trim().min(8).max(500).nullable(),
  }),
  z.object({
    type: z.literal("level.review"),
    levelId: z.string(),
    reviewed: z.boolean(),
  }),
  z.object({
    type: z.literal("level.scale"),
    levelId: z.string(),
    feetPerImagePx: finite.positive().max(100),
  }),
  z.object({
    type: z.literal("object.upsert"),
    levelId: z.string(),
    object: objectSchema,
  }),
  z.object({
    type: z.literal("object.delete"),
    levelId: z.string(),
    objectId: z.string(),
  }),
  z.object({
    type: z.literal("roof.set"),
    levelId: z.string(),
    roof: roofSchema.nullable(),
  }),
  z.object({
    type: z.literal("view.save"),
    levelId: z.string(),
    view: viewSchema,
  }),
  z.object({
    type: z.literal("wall.add"),
    levelId: z.string().min(1),
    x0: finite,
    y0: finite,
    x1: finite,
    y1: finite,
    thicknessFt: finite.positive().max(4).optional(),
  }),
  z.object({
    type: z.literal("wall.delete"),
    levelId: z.string().min(1),
    wallId: z.string().min(1),
  }),
  z.object({
    type: z.literal("opening.set"),
    levelId: z.string().min(1),
    openingId: z.string().min(1),
    kind: z.enum(OPENING_KINDS as unknown as [string, ...string[]]),
  }),
  z.object({
    type: z.literal("opening.delete"),
    levelId: z.string().min(1),
    openingId: z.string().min(1),
  }),
  z.object({
    type: z.literal("room.label"),
    levelId: z.string().min(1),
    roomId: z.string().min(1),
    label: z.string().max(40).nullable(),
  }),
  z.object({
    type: z.literal("level.height"),
    levelId: z.string().min(1),
    ceilingHeightFt: finite.min(6).max(20),
  }),
  z.object({
    type: z.literal("level.name"),
    levelId: z.string().min(1),
    name: z.string().min(1).max(60),
  }),
  z.object({
    type: z.literal("site.set"),
    site: siteSchema,
  }),
]);

export const floorplanEditsSchema = z.array(floorplanEditSchema).min(1).max(50);

export type FloorplanEditInput = z.infer<typeof floorplanEditSchema>;
