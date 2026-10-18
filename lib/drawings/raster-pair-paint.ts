import { rasterFaceOverlap } from "./raster-face-overlap";
import { segmentIndex } from "./segment-index";
import type { AreaPoint, EvidencePath } from "./area-evidence";

export const RASTER_PAIR_PAINT_PROFILE = "measured-pair-paint-4";
export interface RasterPairPaint {
  profile: typeof RASTER_PAIR_PAINT_PROFILE | "measured-pair-paint-3";
  /** Signed source-face separation at the common span endpoints, in this observation bitmap. */
  normalDepthPixels?: [number, number];
  pathIds: [number, number];
  sections: number;
  fullSections: number;
  separatedBands: number;
  inkFraction: number;
  pattern: "solid-paint" | "transverse-ink" | "unresolved";
}

/** Inspect the actual interior of a paired span. Parallel window rails and
 * empty dimension bands cannot qualify solely through line spacing. Hatch/
 * solid paint is a source cue, not an architectural role or confidence score;
 * geometric network/context checks remain required. */
export function measureRasterPairPaint(input: {
  pixels: Uint8Array;
  width: number;
  height: number;
  feetPerPixel: number;
  threshold: number;
  region: { x0: number; y0: number; x1: number; y1: number };
  paths: EvidencePath[];
  maximumWork?: number;
}): { pairs: RasterPairPaint[]; limited: boolean; inspectedPixels: number } {
  const { width, height, pixels, region, feetPerPixel, threshold } = input,
    limit = input.maximumWork ?? 40_000_000;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height < 2 ||
    width > 8192 ||
    height > 8192 ||
    width * height > 25_000_000 ||
    pixels.length !== width * height ||
    !Number.isFinite(feetPerPixel) ||
    feetPerPixel <= 0 ||
    !Number.isInteger(threshold) ||
    threshold < 0 ||
    threshold > 255 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100_000_000 ||
    ![region.x0, region.y0, region.x1, region.y1].every(Number.isFinite) ||
    region.x1 <= region.x0 ||
    region.y1 <= region.y0 ||
    input.paths.length > 4000
  )
    throw new Error("Invalid raster pair-paint frame or budget");
  const pixel = ([x, y]: AreaPoint): AreaPoint => [
    ((x - region.x0) * width) / (region.x1 - region.x0),
    ((y - region.y0) * height) / (region.y1 - region.y0),
  ];
  const faces = input.paths.flatMap((p) => {
    if (
      !p.rasterLine ||
      p.rasterLine.profile !== "pixel-supported-straight-3" ||
      !Number.isFinite(p.rasterLine.maximumDeviationPixels) ||
      p.rasterLine.maximumDeviationPixels < 0 ||
      p.rasterLine.maximumDeviationPixels > 1.5 ||
      p.commands.length !== 2 ||
      p.commands[0][0] !== "M" ||
      p.commands[1][0] !== "L"
    )
      return [];
    let a = pixel([p.commands[0][1], p.commands[0][2]]),
      b = pixel([p.commands[1][1], p.commands[1][2]]);
    if (a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])) [a, b] = [b, a];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    // Consolidated or boundary-qualified fragments can be shorter than the
    // long run that established them. Measure their actual interior; wall/door
    // admission still needs independently supported faces and assemblies.
    if (length * feetPerPixel < .18 || p.rasterLine.sampleCount < 12) return [];
    const u: AreaPoint = [(b[0] - a[0]) / length, (b[1] - a[1]) / length],
      n: AreaPoint = [-u[1], u[0]];
    return [
      {
        a,
        b,
        length,
        u,
        n,
        id: p.id,
        fitError: p.rasterLine.maximumDeviationPixels,
      },
    ];
  });
  const nearby = segmentIndex(faces),
    pairs: RasterPairPaint[] = [];
  let work = 0,
    limited = false;
  facesLoop: for (let i = 0; i < faces.length; i++)
    for (const j of nearby(faces[i], 1.5 / feetPerPixel)) {
      if (j <= i) continue;
      const a = faces[i],
        b = faces[j];
      // Raster fits differ within their measured residuals and half-pixel
      // quantization per face. This bound is source uncertainty, not a grid
      // snapping tolerance; genuinely diverging faces remain unsupported.
      const fitError = a.fitError + b.fitError + 1;
      const overlap = rasterFaceOverlap(a, b, fitError);
      if (
        !overlap ||
        overlap.depths.some(
          (d) =>
            Math.abs(d) * feetPerPixel < 0.2 ||
            Math.abs(d) * feetPerPixel > 1.5,
        )
      )
        continue;
      const { lo, hi } = overlap,
        d = overlap.depth;
      if ((hi - lo) * feetPerPixel < 0.18) continue;
      const pad = 2.5,
        depth = Math.abs(d) - 2 * pad;
      if (depth < 2) continue;
      const start = Math.ceil(lo + 3),
        end = Math.floor(hi - 3),
        sign = Math.sign(d);
      let sections = 0,
        fullSections = 0,
        total = 0,
        dark = 0,
        bands = 0,
        lastFull = -10;
      // One source-pixel step prevents regular hatch spacing aliasing. Requiring
      // several separated transverse bands rejects isolated end caps or ticks.
      for (let t = start; t <= end; t++) {
        let sectionTotal = 0,
          sectionDark = 0;
        const sectionDepth =
          overlap.depths[0] +
          ((overlap.depths[1] - overlap.depths[0]) * (t - lo)) / (hi - lo);
        for (
          let normal = pad;
          normal <= Math.abs(sectionDepth) - pad;
          normal++
        ) {
          if (++work > limit) {
            limited = true;
            break facesLoop;
          }
          const x = Math.floor(a.a[0] + a.u[0] * t + a.n[0] * normal * sign),
            y = Math.floor(a.a[1] + a.u[1] * t + a.n[1] * normal * sign);
          if (x < 0 || y < 0 || x >= width || y >= height) continue;
          sectionTotal++;
          if (pixels[y * width + x] <= threshold) sectionDark++;
        }
        if (!sectionTotal) continue;
        sections++;
        total += sectionTotal;
        dark += sectionDark;
        if (sectionDark / sectionTotal >= 0.9) {
          fullSections++;
          if (t - lastFull > 2) bands++;
          lastFull = t;
        }
      }
      const inkFraction = total ? dark / total : 0,
        fullFraction = sections ? fullSections / sections : 0;
      const pattern: RasterPairPaint["pattern"] =
        sections >= 12 && inkFraction >= 0.8 && fullFraction >= 0.8
          ? "solid-paint"
          : sections >= 12 &&
              inkFraction >= 0.06 &&
              fullFraction >= 0.08 &&
              bands >= 4
            ? "transverse-ink"
            : "unresolved";
      pairs.push({
        profile: RASTER_PAIR_PAINT_PROFILE,
        pathIds: [a.id, b.id],
        normalDepthPixels: overlap.depths,
        sections,
        fullSections,
        separatedBands: bands,
        inkFraction,
        pattern,
      });
      if (pairs.length >= 12000) {
        limited = true;
        break facesLoop;
      }
    }
  return { pairs, limited, inspectedPixels: work };
}
