import type { AreaPoint, AreaEvidence, EvidencePath } from "./area-evidence";
import { flattenEvidencePath } from "./area-evidence";

export const RASTER_ARC_PROFILE = "observed-circle-run-3";
export interface RasterArcSupport {
  profile: typeof RASTER_ARC_PROFILE;
  sampleCount: number;
  maximumDeviationPixels: number;
  sweepRadians: number;
  continuousInk: true;
  clipped: boolean;
}

/** Least-squares circle seed from measured stroke vertices, translated near
 * the origin to keep architectural sheet coordinates well-conditioned. */
export function fitRasterCircle(points: AreaPoint[]) {
  if (points.length < 7 || points.length > 512) return null;
  const origin: AreaPoint = [
    points.reduce((s, p) => s + p[0], 0) / points.length,
    points.reduce((s, p) => s + p[1], 0) / points.length,
  ];
  const matrix = Array.from({ length: 3 }, () => [0, 0, 0, 0]);
  for (const p of points) {
    const x = p[0] - origin[0],
      y = p[1] - origin[1],
      row = [2 * x, 2 * y, 1],
      value = x * x + y * y;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) matrix[i][j] += row[i] * row[j];
      matrix[i][3] += row[i] * value;
    }
  }
  for (let column = 0; column < 3; column++) {
    let pivot = column;
    for (let row = column + 1; row < 3; row++)
      if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column]))
        pivot = row;
    if (Math.abs(matrix[pivot][column]) < 1e-10) return null;
    [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
    const divisor = matrix[column][column];
    for (let j = column; j < 4; j++) matrix[column][j] /= divisor;
    for (let row = 0; row < 3; row++)
      if (row !== column) {
        const factor = matrix[row][column];
        for (let j = column; j < 4; j++)
          matrix[row][j] -= factor * matrix[column][j];
      }
  }
  const center: AreaPoint = [
    origin[0] + matrix[0][3],
    origin[1] + matrix[1][3],
  ];
  const radius = Math.sqrt(
    matrix[2][3] + matrix[0][3] ** 2 + matrix[1][3] ** 2,
  );
  if (!Number.isFinite(radius) || radius <= 0) return null;
  const error = Math.max(
    ...points.map((p) =>
      Math.abs(Math.hypot(p[0] - center[0], p[1] - center[1]) - radius),
    ),
  );
  return { center, radius, error };
}

/** Extend a curved source seed only where every sampled arc step still has
 * nearby observed dark ink. A missing arc is never completed across white
 * pixels. Circular shapes are hypotheses; classification/jamb checks follow. */
export function extractRasterArcEvidence(input: {
  pixels: Uint8Array;
  width: number;
  height: number;
  feetPerPixel: number;
  strokes: AreaEvidence;
  paintMask?: Uint8Array;
  maximumArcs?: number;
  maximumWork?: number;
}): { paths: EvidencePath[]; limited: boolean } {
  const { pixels, width, height, feetPerPixel, strokes } = input,
    region = strokes.raster?.region;
  const maximum = input.maximumArcs ?? 64,
    workLimit = input.maximumWork ?? 50_000_000;
  if (
    !region ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height < 2 ||
    width * height > 25_000_000 ||
    pixels.length !== width * height ||
    !Number.isFinite(feetPerPixel) ||
    feetPerPixel <= 0 ||
    ![region.x0, region.y0, region.x1, region.y1].every(Number.isFinite) ||
    region.x1 <= region.x0 ||
    region.y1 <= region.y0 ||
    (input.paintMask && input.paintMask.length !== pixels.length) ||
    !Number.isInteger(maximum) ||
    maximum < 1 ||
    maximum > 256 ||
    !Number.isInteger(workLimit) ||
    workLimit < 1 ||
    workLimit > 100_000_000
  )
    throw new Error(
      "Arc extraction requires registered source pixels and a bounded budget",
    );
  const toPixel = (p: AreaPoint): AreaPoint => [
    ((p[0] - region.x0) / (region.x1 - region.x0)) * width,
    ((p[1] - region.y0) / (region.y1 - region.y0)) * height,
  ];
  const seeds: Array<{ center: AreaPoint; radius: number; error: number }> = [];
  const threshold = strokes.raster!.threshold;
  let limited = false,
    seedWork = 0;
  const saveSeed = (points: AreaPoint[]) => {
    if (++seedWork > 100000) {
      limited = true;
      return;
    }
    const seed = fitRasterCircle(points);
    if (
      !seed ||
      seed.radius * feetPerPixel < 1.5 ||
      seed.radius * feetPerPixel > 4.5 ||
      seed.radius > 2 * Math.hypot(width, height) ||
      seed.error > 2.5
    )
      return;
    const chord = Math.hypot(
      points[0][0] - points.at(-1)![0],
      points[0][1] - points.at(-1)![1],
    );
    if (chord < seed.radius * 0.3) return;
    if (
      seeds.some(
        (s) =>
          Math.hypot(
            s.center[0] - seed.center[0],
            s.center[1] - seed.center[1],
          ) < 3 && Math.abs(s.radius - seed.radius) < 3,
      )
    )
      return;
    if (seeds.length >= 256) {
      limited = true;
      return;
    }
    seeds.push(seed);
  };
  sources: for (const path of strokes.paths)
    for (const ring of flattenEvidencePath(path)) {
      const points = ring.map(toPixel);
      saveSeed(points);
      // A leaf/jamb junction can leave the swing attached to a straight source
      // branch. Seed bounded connected windows as well as complete strokes;
      // final recovery still requires ink at every arc sample, never a gap fill.
      for (let start = 0; start < points.length - 6; start += 4)
        for (const size of [8, 16, 32]) {
          const window = points.slice(start, start + size);
          if (window.length >= 7) saveSeed(window);
          if (limited) break sources;
        }
    }
  let pixelWork = 0;
  const dark = (x: number, y: number) => {
    if (++pixelWork > workLimit) {
      limited = true;
      return false;
    }
    return (
      x >= 0 &&
      y >= 0 &&
      x < width &&
      y < height &&
      !input.paintMask?.[y * width + x] &&
      pixels[y * width + x] <= threshold
    );
  };
  const connected = (a: AreaPoint, b: AreaPoint) => {
    const ax = Math.floor(a[0]),
      ay = Math.floor(a[1]),
      bx = Math.floor(b[0]),
      by = Math.floor(b[1]);
    if (Math.max(Math.abs(ax - bx), Math.abs(ay - by)) <= 1) return true;
    if (Math.max(Math.abs(ax - bx), Math.abs(ay - by)) > 4) return false;
    const x0 = Math.min(ax, bx) - 1,
      x1 = Math.max(ax, bx) + 1,
      y0 = Math.min(ay, by) - 1,
      y1 = Math.max(ay, by) + 1,
      queue: Array<[number, number]> = [[ax, ay]],
      seen = new Set([ay * width + ax]);
    for (let i = 0; i < queue.length && !limited; i++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = queue[i][0] + dx,
            y = queue[i][1] + dy,
            key = y * width + x;
          if (x < x0 || x > x1 || y < y0 || y > y1 || seen.has(key)) continue;
          seen.add(key);
          if (!dark(x, y)) continue;
          if (x === bx && y === by) return true;
          queue.push([x, y]);
        }
    return false;
  };
  const paths: EvidencePath[] = [];
  for (const seed of seeds.slice(0, 256)) {
    const count = Math.ceil((2 * Math.PI * seed.radius) / 0.7),
      samples: Array<AreaPoint | null> = [];
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * 2 * Math.PI,
        cosine = Math.cos(angle),
        sine = Math.sin(angle);
      let best: AreaPoint | null = null;
      for (const delta of [0, -0.5, 0.5, -1, 1, -1.5, 1.5, -2, 2]) {
        const x = Math.floor(seed.center[0] + (seed.radius + delta) * cosine),
          y = Math.floor(seed.center[1] + (seed.radius + delta) * sine);
        if (dark(x, y)) {
          best = [x + 0.5, y + 0.5];
          break;
        }
      }
      // Digital diagonal corners can put both nearby ink pixels beside the
      // radial ray. Inspect a sub-pixel tangent neighbourhood; connectivity
      // below must independently witness every continuation in source ink.
      if (!best) {
        const expected: AreaPoint = [
          seed.center[0] + seed.radius * cosine,
          seed.center[1] + seed.radius * sine,
        ];
        let score = Infinity;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            const x = Math.floor(expected[0]) + dx,
              y = Math.floor(expected[1]) + dy,
              rx = x + 0.5 - expected[0],
              ry = y + 0.5 - expected[1];
            if (
              Math.abs(-rx * sine + ry * cosine) > 0.8 ||
              Math.abs(rx * cosine + ry * sine) > 2.5 ||
              !dark(x, y)
            )
              continue;
            const d = rx * rx + ry * ry;
            if (d < score) {
              score = d;
              best = [x + 0.5, y + 0.5];
            }
          }
      }
      if (limited) break;
      samples.push(best);
    }
    if (limited) break;
    const observed = [...samples];
    for (let i = 0; i < samples.length && !limited; i++) {
      const a = observed[(i + observed.length - 1) % observed.length],
        b = observed[i];
      if (a && b && !connected(a, b)) samples[i] = null;
    }
    if (limited) break;
    const start = samples.findIndex((p) => !p);
    if (start < 0) continue; // A complete circle is not a door swing.
    let run: AreaPoint[] = [];
    const emit = () => {
      const sweep = (run.length / count) * 2 * Math.PI;
      if (sweep < Math.PI * 0.38 || sweep > Math.PI * 0.62 || run.length < 7)
        return;
      const fit = fitRasterCircle(
        run.filter(
          (_, i) => i % Math.max(1, Math.ceil(run.length / 100)) === 0,
        ),
      );
      if (!fit) return;
      const fullError = Math.max(
        ...run.map((p) =>
          Math.abs(
            Math.hypot(p[0] - fit.center[0], p[1] - fit.center[1]) - fit.radius,
          ),
        ),
      );
      if (fullError > 2.5) return;
      const endPoints = [run[0], run[run.length - 1]];
      if (
        paths.some((p) => {
          const q = p.commands
            .filter((c) => c.length === 3)
            .map((c) => toPixel([c[1]!, c[2]!]));
          return (
            q.length &&
            endPoints.every((e) =>
              [q[0], q[q.length - 1]].some(
                (v) => Math.hypot(v[0] - e[0], v[1] - e[1]) < 8,
              ),
            )
          );
        })
      )
        return;
      // Sample only observed pixels, retaining a bounded source path.
      const step = Math.max(1, Math.ceil(run.length / 60)),
        points = run.filter((_, i) => i % step === 0);
      if (points[points.length - 1] !== run[run.length - 1])
        points.push(run[run.length - 1]);
      paths.push({
        id: paths.length,
        kind: "stroke",
        rasterArc: {
          profile: RASTER_ARC_PROFILE,
          sampleCount: run.length,
          maximumDeviationPixels: fullError,
          sweepRadians: sweep,
          continuousInk: true,
          clipped: run.some(
            (p) =>
              p[0] <= 1.5 ||
              p[1] <= 1.5 ||
              p[0] >= width - 1.5 ||
              p[1] >= height - 1.5,
          ),
        },
        layer: [],
        groups: [],
        clips: [],
        dashes: [],
        color: [0],
        colorSpace: "DeviceGray",
        opacity: 1,
        width: 1,
        evenOdd: false,
        commands: points.map((p, i) => [
          i ? "L" : "M",
          region.x0 + (p[0] / width) * (region.x1 - region.x0),
          region.y0 + (p[1] / height) * (region.y1 - region.y0),
        ]),
      });
    };
    for (let n = 1; n <= count; n++) {
      const p = samples[(start + n) % count];
      if (p) run.push(p);
      else {
        emit();
        run = [];
      }
    }
    if (paths.length > maximum) {
      limited = true;
      break;
    }
  }
  return { paths: paths.slice(0, maximum), limited };
}

/** Compatibility entry point for local primitive experiments. The shared plan
 * extractor uses the structured result so source-budget exhaustion is explicit. */
export function extractRasterArcPaths(
  input: Parameters<typeof extractRasterArcEvidence>[0],
): EvidencePath[] {
  return extractRasterArcEvidence(input).paths;
}
