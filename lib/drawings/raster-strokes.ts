import type { AreaEvidence, AreaPoint, EvidencePath } from "./area-evidence";
import { rasterInkThreshold, simplifyContour } from "./raster-evidence";

export const RASTER_STROKE_PROFILE = "raster-strokes-experimental-1";

/** Guo–Hall thinning of observed ink; no dilation or gap closing. The local
 * neighbourhood criterion follows the algorithm documented by OpenCV:
 * https://github.com/opencv/opencv_contrib/blob/4.x/modules/ximgproc/src/thinning.cpp
 * This is a stroke extraction experiment, not a semantic wall detector. */
export function thinRasterInk(input: Uint8Array, width: number, height: number, maximumPasses = 128) {
  if (input.length !== width * height || width < 2 || height < 2 || !Number.isInteger(width) || !Number.isInteger(height) || width * height > 25_000_000 || !Number.isInteger(maximumPasses) || maximumPasses < 1)
    throw new Error("Invalid raster ink dimensions");
  const stride = width + 2, mask = new Uint8Array(stride * (height + 2));
  let active: number[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (input[y * width + x]) {
    const i = (y + 1) * stride + x + 1;
    mask[i] = 1;
    active.push(i);
  }
  const delta = [-stride, -stride + 1, 1, stride + 1, stride, stride - 1, -1, -stride - 1];
  let converged = false, passes = 0;
  for (; passes < maximumPasses; passes++) {
    let removed = 0;
    for (let phase = 0; phase < 2; phase++) {
      const remove: number[] = [];
      for (const i of active) {
        if (!mask[i]) continue;
        const p = delta.map(d => mask[i + d]);
        let transitions = 0, pairsA = 0, pairsB = 0;
        for (let k = 0; k < 8; k += 2) {
          if (!p[k] && (p[(k + 1) % 8] || p[(k + 2) % 8])) transitions++;
          pairsA += p[(k + 7) % 8] | p[k];
          pairsB += p[k] | p[k + 1];
        }
        const neighbours = Math.min(pairsA, pairsB);
        const preserve = phase === 0 ? p[6] && (p[4] || p[5] || !p[7]) : p[2] && (p[0] || p[1] || !p[3]);
        if (transitions === 1 && neighbours >= 2 && neighbours <= 3 && !preserve) remove.push(i);
      }
      for (const i of remove) mask[i] = 0;
      removed += remove.length;
    }
    if (!removed) { converged = true; break; }
    active = active.filter(i => mask[i]);
  }
  const pixels = new Uint8Array(width * height);
  for (const i of active) if (mask[i]) pixels[(Math.floor(i / stride) - 1) * width + i % stride - 1] = 1;
  return { pixels, converged, passes };
}

/** Trace centre lines between observed ink junctions. Pixel centres stay in
 * source coordinates; corners are simplified only within a subpixel bound.
 * Poche/filled-wall recognition is deliberately not inferred from skeletons. */
export function extractRasterStrokeEvidence(input: {
  pixels: Uint8Array; width: number; height: number; feetPerPixel: number;
  region?: { x0: number; y0: number; x1: number; y1: number };
  maximumPaths?: number;
  purpose?: "linework" | "arc-seeds";
}): AreaEvidence {
  const { pixels, width, height, feetPerPixel } = input;
  const region = input.region ?? { x0: 0, y0: 0, x1: 1, y1: 1 }, maximum = input.maximumPaths ?? 12000;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2
    || width * height > 25_000_000 || pixels.length !== width * height || !Number.isFinite(feetPerPixel) || feetPerPixel <= 0
    || !Number.isInteger(maximum) || maximum < 1 || maximum > 50000
    || ![region.x0, region.y0, region.x1, region.y1].every(Number.isFinite)
    || region.x1 <= region.x0 || region.y1 <= region.y0)
    throw new Error("Invalid scan pixels or stroke extraction budget");
  const threshold = rasterInkThreshold(pixels), binary = Uint8Array.from(pixels, p => p <= threshold ? 1 : 0);
  const thinned = thinRasterInk(binary, width, height), ink = thinned.pixels;
  const dx = [0, 1, 1, 1, 0, -1, -1, -1], dy = [-1, -1, 0, 1, 1, 1, 0, -1];
  const neighbours = (i: number) => {
    const x = i % width, y = Math.floor(i / width), found: Array<{ i: number; d: number }> = [];
    for (let d = 0; d < 8; d++) {
      const xx = x + dx[d], yy = y + dy[d];
      if (xx < 0 || xx >= width || yy < 0 || yy >= height || !ink[yy * width + xx]) continue;
      // Do not create a shortcut triangle across a square ink corner.
      if (d % 2 && (ink[y * width + xx] || ink[yy * width + x])) continue;
      found.push({ i: yy * width + xx, d });
    }
    return found;
  };
  const degree = new Uint8Array(ink.length), visited = new Uint8Array(ink.length), components = new Uint8Array(ink.length);
  const eligible: number[] = [];
  for (let start = 0; start < ink.length; start++) {
    if (!ink[start] || components[start]) continue;
    const component = [start]; components[start] = 1;
    let x0 = start % width, x1 = x0, y0 = Math.floor(start / width), y1 = y0;
    for (let at = 0; at < component.length; at++) {
      const i = component[at], ns = neighbours(i), x = i % width, y = Math.floor(i / width);
      degree[i] = ns.length;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      for (const n of ns) if (!components[n.i]) { components[n.i] = 1; component.push(n.i); }
    }
    // Remove isolated glyph-sized components, retaining short jamb returns
    // attached to a larger observed network.
    if (Math.max(x1 - x0, y1 - y0) * feetPerPixel >= .75) for (const i of component) eligible.push(i);
  }
  const paths: EvidencePath[] = [];
  let truncated = !thinned.converged;
  const point = (i: number): AreaPoint => [i % width + .5, Math.floor(i / width) + .5];
  const emit = (points: AreaPoint[]) => {
    const simplified = simplifyContour(points, .6);
    // Production uses skeletons only to seed observed arcs. Straight two-point
    // hatch branches cannot supply the circle fitter's seven vertices; retaining
    // thousands of them exhausts its path budget before the actual curves.
    // All skeleton edges are still traversed. General stroke extraction retains
    // its original behavior; no architectural role is assigned here.
    if(input.purpose==='arc-seeds' && simplified.length<7)return;
    if (simplified.length < 2) return;
    const dense: AreaPoint[] = [simplified[0]];
    for (let i = 1; i < simplified.length; i++) {
      const a = simplified[i - 1], b = simplified[i], pieces = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * feetPerPixel / 12));
      for (let j = 1; j <= pieces; j++) dense.push([a[0] + (b[0] - a[0]) * j / pieces, a[1] + (b[1] - a[1]) * j / pieces]);
    }
    for (let start = 0; start < dense.length - 1;) {
      if (paths.length >= maximum) { truncated = true; return; }
      let end = start + 1;
      for (; end < dense.length && end - start < 40; end++)
        if (end > start + 1 && Math.hypot(dense[end][0] - dense[start][0], dense[end][1] - dense[start][1]) * feetPerPixel > 20) break;
      const points = dense.slice(start, end);
      paths.push({
        id: paths.length, kind: "stroke", layer: [], groups: [], clips: [], dashes: [], color: [0], colorSpace: "DeviceGray", opacity: 1, width: 1, evenOdd: false,
        commands: points.map(([x, y], i) => [i ? "L" : "M", region.x0 + x / width * (region.x1 - region.x0), region.y0 + y / height * (region.y1 - region.y0)]),
      });
      start = end - 1;
    }
  };
  const trace = (start: number, next: { i: number; d: number }) => {
    let current = start, step = next;
    const points = [point(start)];
    for (;;) {
      visited[current] |= 1 << step.d;
      visited[step.i] |= 1 << ((step.d + 4) % 8);
      current = step.i; points.push(point(current));
      if (degree[current] !== 2 || current === start) break;
      const n = neighbours(current).find(n => !(visited[current] & (1 << n.d)));
      if (!n) break;
      step = n;
      if (points.length >= 4096) {
        emit(points);
        points.splice(0, points.length, point(current));
        if (paths.length >= maximum) { truncated = true; return; }
      }
    }
    emit(points);
  };
  for (const junctions of [true, false]) for (const i of eligible) {
    if (junctions && degree[i] === 2) continue;
    for (const n of neighbours(i)) if (!(visited[i] & (1 << n.d))) trace(i, n);
    if (paths.length >= maximum) { truncated = true; break; }
  }
  return {
    version: 1, extractionProfile: RASTER_STROKE_PROFILE, paths, truncated, unrepresentedPaint: true,
    raster: { width, height, feetPerPixel, threshold, maximumDeviationPixels: 1.1, region },
  };
}
