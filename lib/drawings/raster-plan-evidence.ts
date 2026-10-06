import type { AreaEvidence } from "./area-evidence";
import { extractRasterEvidence } from "./raster-evidence";
import { extractRasterStraightRuns } from "./raster-straight-runs";
import { extractRasterStrokeEvidence } from "./raster-strokes";
import { extractRasterArcEvidence } from "./raster-arcs";
import { measureRasterPairPaint } from "./raster-pair-paint";

export const RASTER_PLAN_PROFILE = "raster-plan-primitives-12";

/** Pixel contours, direct straight ink runs, and observed arcs share one frame.
 * These are measured primitives only. Parallel lines do not become walls until
 * source assembly and architectural context have been established separately. */
export function extractRasterPlanEvidence(
  input: Parameters<typeof extractRasterEvidence>[0],
): AreaEvidence {
  const contours = extractRasterEvidence(input),
    straight = extractRasterStraightRuns({
      ...input,
      region: contours.raster!.region,
      contours,
      maximumPaths: 4000,
    }),
    strokes = extractRasterStrokeEvidence({...input,purpose:"arc-seeds"}),
    arcs = extractRasterArcEvidence({ ...input, strokes });
  const maximum = input.maximumPaths ?? 12000;
  const paint = measureRasterPairPaint({
    ...input,
    region: contours.raster!.region,
    threshold: contours.raster!.threshold,
    paths: straight.paths,
  });
  // Supply classifiable runs first; keep paint contours as distinct source
  // observations, so source topology and unresolved curved/decorative ink remain.
  const paths = [
    ...straight.paths,
    ...arcs.paths.map((p) => ({
      ...p,
      rasterFeature: "circular-arc" as const,
    })),
    ...contours.paths.map((p) => ({
      ...p,
      rasterFeature: "paint-boundary" as const,
    })),
  ];
  return {
    ...contours,
    extractionProfile: RASTER_PLAN_PROFILE,
    paths: paths.slice(0, maximum).map((p, id) => ({ ...p, id })),
    rasterPairPaint: paint.pairs.filter((p) =>
      p.pathIds.every((id) => id < Math.min(straight.paths.length, maximum)),
    ),
    truncated:
      contours.truncated ||
      straight.limited ||
      paint.limited ||
      strokes.truncated ||
      arcs.limited ||
      paths.length > maximum,
    raster: {
      ...contours.raster!,
      diagnostics: {
        contoursLimited: contours.truncated,
        straightLimited: straight.limited,
        paintLimited: paint.limited,
        strokesLimited: strokes.truncated,
        arcsLimited: arcs.limited,
        combinedPathLimit: paths.length > maximum,
      },
      maximumDeviationPixels: Math.max(
        contours.raster!.maximumDeviationPixels,
        2.5,
      ),
    },
  };
}
