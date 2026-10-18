import type { AreaEvidence } from "./area-evidence";
import type { AreaRegion } from "./area-takeoff";
import { RASTER_ARC_PROFILE } from "./raster-arcs";

export const RASTER_CONTEXT_PROFILE = "clipped-swing-context-1";
export type RasterContextEdge = "left" | "top" | "right" | "bottom";
export interface RasterContextEvidence {
  profile: typeof RASTER_CONTEXT_PROFILE;
  requestedRegion: AreaRegion;
  initialRegion: AreaRegion;
  effectiveRegion: AreaRegion;
  initialEvidenceSha256: string;
  triggerPathIds: number[];
  edges: RasterContextEdge[];
  attempts: 0 | 1;
  status: "unchanged" | "expanded" | "unresolved";
  reason?:
    | "page-edge"
    | "geometry-budget"
    | "source-unverified"
    | "remaining-clipping"
    | "read-failed";
}
const edges: RasterContextEdge[] = ["left", "top", "right", "bottom"];
export function validRasterContextRegion(value: unknown): value is AreaRegion {
  if (!value || typeof value !== "object") return false;
  const r = value as AreaRegion;
  return (
    [r.x0, r.y0, r.x1, r.y1].every(Number.isFinite) &&
    r.x0 >= 0 &&
    r.y0 >= 0 &&
    r.x1 <= 1 &&
    r.y1 <= 1 &&
    r.x1 > r.x0 &&
    r.y1 > r.y0
  );
}
const sameRegion = (a: AreaRegion, b: AreaRegion) =>
  a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1;
export function validRasterContext(
  value: unknown,
  requested: AreaRegion,
  effective: AreaRegion,
): value is RasterContextEvidence {
  if (!value || typeof value !== "object") return false;
  const v = value as RasterContextEvidence;
  return (
    validRasterContextRegion(requested) &&
    validRasterContextRegion(effective) &&
    v.profile === RASTER_CONTEXT_PROFILE &&
    validRasterContextRegion(v.requestedRegion) &&
    validRasterContextRegion(v.initialRegion) &&
    validRasterContextRegion(v.effectiveRegion) &&
    sameRegion(v.requestedRegion, requested) &&
    sameRegion(v.effectiveRegion, effective) &&
    v.initialRegion.x0 <= requested.x0 &&
    v.initialRegion.y0 <= requested.y0 &&
    v.initialRegion.x1 >= requested.x1 &&
    v.initialRegion.y1 >= requested.y1 &&
    v.effectiveRegion.x0 <= requested.x0 &&
    v.effectiveRegion.y0 <= requested.y0 &&
    v.effectiveRegion.x1 >= requested.x1 &&
    v.effectiveRegion.y1 >= requested.y1 &&
    /^[a-f0-9]{64}$/.test(v.initialEvidenceSha256) &&
    Array.isArray(v.triggerPathIds) &&
    v.triggerPathIds.length <= 64 &&
    v.triggerPathIds.every((n) => Number.isInteger(n) && n >= 0) &&
    Array.isArray(v.edges) &&
    v.edges.length <= 4 &&
    new Set(v.edges).size === v.edges.length &&
    v.edges.every((e) => edges.includes(e)) &&
    ((v.status === "unchanged" &&
      v.attempts === 0 &&
      !v.reason &&
      !v.triggerPathIds.length &&
      !v.edges.length &&
      sameRegion(v.initialRegion, v.effectiveRegion)) ||
      (v.status === "expanded" &&
        v.attempts === 1 &&
        !v.reason &&
        v.triggerPathIds.length > 0 &&
        v.edges.length > 0 &&
        !sameRegion(v.initialRegion, v.effectiveRegion) &&
        v.effectiveRegion.x0 <= v.initialRegion.x0 &&
        v.effectiveRegion.y0 <= v.initialRegion.y0 &&
        v.effectiveRegion.x1 >= v.initialRegion.x1 &&
        v.effectiveRegion.y1 >= v.initialRegion.y1) ||
      (v.status === "unresolved" &&
        [0, 1].includes(v.attempts) &&
        [
          "page-edge",
          "geometry-budget",
          "source-unverified",
          "remaining-clipping",
          "read-failed",
        ].includes(v.reason ?? "")))
  );
}

/** A source-acquisition request, never architectural classification or geometry
 * completion. Only measured clipped quarter-circle ink can trigger one halo.
 * The 4.5ft halo covers the assembler's maximum leaf radius; five pixels retain
 * quantization context. It never resizes or snaps the existing observations. */
export function planRasterContext(input: {
  evidence: AreaEvidence;
  imageWidth: number;
  imageHeight: number;
  feetPerImagePx: number;
}) {
  const { evidence, imageWidth, imageHeight, feetPerImagePx } = input,
    r = evidence.raster;
  const empty = {
    pathIds: [] as number[],
    edges: [] as RasterContextEdge[],
    region: null as AreaRegion | null,
    reason: undefined as RasterContextEvidence["reason"],
  };
  if (
    !r ||
    evidence.truncated ||
    !Number.isInteger(r.width) ||
    !Number.isInteger(r.height) ||
    r.width < 2 ||
    r.height < 2 ||
    !validRasterContextRegion(r.region) ||
    ![imageWidth, imageHeight, feetPerImagePx, r.feetPerPixel].every(
      (n) => Number.isFinite(n) && n > 0,
    ) ||
    evidence.paths.length > 12000
  )
    return empty;
  const touched = new Set<RasterContextEdge>(),
    pathIds: number[] = [];
  for (const p of evidence.paths) {
    const a = p.rasterArc;
    if (
      p.rasterFeature !== "circular-arc" ||
      a?.profile !== RASTER_ARC_PROFILE ||
      a.clipped !== true ||
      a.continuousInk !== true ||
      !Number.isInteger(a.sampleCount) ||
      a.sampleCount < 7 ||
      a.sampleCount > 16384 ||
      !Number.isFinite(a.maximumDeviationPixels) ||
      a.maximumDeviationPixels < 0 ||
      a.maximumDeviationPixels > 2.5 ||
      !(a.sweepRadians >= Math.PI * 0.38 && a.sweepRadians <= Math.PI * 0.62) ||
      p.kind !== "stroke" ||
      p.clips.length ||
      p.dashes.length ||
      p.opacity < 0.95 ||
      p.commands.length < 7 ||
      p.commands.length > 128 ||
      p.commands.some(
        (c) =>
          !["M", "L"].includes(c[0]) || ![c[1], c[2]].every(Number.isFinite),
      )
    )
      continue;
    const nearX = (2 * (r.region.x1 - r.region.x0)) / r.width,
      nearY = (2 * (r.region.y1 - r.region.y0)) / r.height;
    const local = new Set<RasterContextEdge>();
    for (const c of p.commands) {
      const x = c[1]!,
        y = c[2]!;
      if (
        x < r.region.x0 ||
        x > r.region.x1 ||
        y < r.region.y0 ||
        y > r.region.y1
      ) {
        local.clear();
        break;
      }
      if (x - r.region.x0 <= nearX) local.add("left");
      if (r.region.x1 - x <= nearX) local.add("right");
      if (y - r.region.y0 <= nearY) local.add("top");
      if (r.region.y1 - y <= nearY) local.add("bottom");
    }
    if (local.size) {
      pathIds.push(p.id);
      for (const e of local) touched.add(e);
    }
    if (pathIds.length === 64) break;
  }
  const selected = edges.filter((e) => touched.has(e));
  if (!selected.length) return empty;
  const halo = 4.5 + 5 * r.feetPerPixel,
    dx = halo / (imageWidth * feetPerImagePx),
    dy = halo / (imageHeight * feetPerImagePx),
    region = {
      x0: Math.max(0, r.region.x0 - (touched.has("left") ? dx : 0)),
      y0: Math.max(0, r.region.y0 - (touched.has("top") ? dy : 0)),
      x1: Math.min(1, r.region.x1 + (touched.has("right") ? dx : 0)),
      y1: Math.min(1, r.region.y1 + (touched.has("bottom") ? dy : 0)),
    };
  if (sameRegion(region, r.region))
    return { ...empty, pathIds, edges: selected, reason: "page-edge" as const };
  const width =
      (r.width * (region.x1 - region.x0)) / (r.region.x1 - r.region.x0),
    height = (r.height * (region.y1 - region.y0)) / (r.region.y1 - r.region.y0);
  if (
    Math.ceil(width) > 4096 ||
    Math.ceil(height) > 4096 ||
    width * height > 4 * r.width * r.height
  )
    return {
      ...empty,
      pathIds,
      edges: selected,
      reason: "geometry-budget" as const,
    };
  return { pathIds, edges: selected, region, reason: undefined };
}
