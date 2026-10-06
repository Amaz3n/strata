import type { AreaEvidence, AreaPoint, EvidencePath } from "./area-evidence";
import { flattenEvidencePath } from "./area-evidence";
import { rasterBoundaryIntervals } from "./raster-boundary-intervals";
import { rasterInkThreshold } from "./raster-evidence";

export const RASTER_STRAIGHT_RUN_PROFILE = "pixel-supported-straight-3";
export interface RasterStraightRunSupport {
  profile: typeof RASTER_STRAIGHT_RUN_PROFILE;
  sampleCount: number;
  boundaryFraction: number;
  maximumDeviationPixels: number;
  /** A measured ink run, not an architectural label or probability. */
  continuousInk: true;
}

/** Long faces are observed directly in pixels instead of following a skeleton
 * through every hatch crossing. Gaps stop a run. Axis scans find exact ink
 * intervals; non-axis directions come from measured contour spans, never a
 * assumed building orientation. No wall role is assigned here. */
export function extractRasterStraightRuns(input: {
  pixels: Uint8Array;
  width: number;
  height: number;
  feetPerPixel: number;
  region: { x0: number; y0: number; x1: number; y1: number };
  contours: AreaEvidence;
  maximumPaths?: number;
  maximumWork?: number;
  maximumObservationSamples?: number;
}): { paths: EvidencePath[]; limited: boolean; inspectedSamples: number } {
  const { pixels, width, height, feetPerPixel, region } = input;
  const maximum = input.maximumPaths ?? 4000,
    workLimit = input.maximumWork ?? 60_000_000,
    sampleLimit = input.maximumObservationSamples ?? 2_000_000;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    width > 8192 ||
    height > 8192 ||
    height < 2 ||
    width * height > 25_000_000 ||
    pixels.length !== width * height ||
    !Number.isFinite(feetPerPixel) ||
    feetPerPixel <= 0 ||
    ![region.x0, region.y0, region.x1, region.y1].every(Number.isFinite) ||
    region.x1 <= region.x0 ||
    region.y1 <= region.y0 ||
    !Number.isInteger(maximum) ||
    maximum < 1 ||
    maximum > 12000 ||
    !Number.isInteger(workLimit) ||
    workLimit < 1 ||
    workLimit > 100_000_000 ||
    !Number.isInteger(sampleLimit) ||
    sampleLimit < 1 ||
    sampleLimit > 2_000_000
  )
    throw new Error("Invalid direct raster run frame or budget");
  const threshold = rasterInkThreshold(pixels),
    minimum = Math.max(12, Math.ceil(1 / feetPerPixel));
  let retainedSamples = 0;
  let work = 0,
    limited = false;
  const ink = (x: number, y: number) => {
    if (++work > workLimit) {
      limited = true;
      return false;
    }
    return (
      x >= 0 &&
      y >= 0 &&
      x < width &&
      y < height &&
      pixels[y * width + x] <= threshold
    );
  };
  const candidates: {
    a: AreaPoint;
    b: AreaPoint;
    support: RasterStraightRunSupport;
    length: number;
    points: AreaPoint[];
    boundaries: boolean[];
  }[] = [];
  const save = (
    points: AreaPoint[],
    direction: AreaPoint,
    exactAxis = false,
  ) => {
    if (limited || points.length < minimum) return;
    const mean: AreaPoint = [
      points.reduce((n, p) => n + p[0], 0) / points.length,
      points.reduce((n, p) => n + p[1], 0) / points.length,
    ];
    let u = direction;
    if (!exactAxis) {
      let xx = 0,
        xy = 0,
        yy = 0;
      for (const p of points) {
        const x = p[0] - mean[0],
          y = p[1] - mean[1];
        xx += x * x;
        xy += x * y;
        yy += y * y;
      }
      const theta = 0.5 * Math.atan2(2 * xy, xx - yy);
      u = [Math.cos(theta), Math.sin(theta)];
    }
    if (u[0] < -1e-9 || (Math.abs(u[0]) <= 1e-9 && u[1] < 0))
      u = [-u[0], -u[1]];
    const n: AreaPoint = [-u[1], u[0]],
      project = (p: AreaPoint) =>
        (p[0] - mean[0]) * u[0] + (p[1] - mean[1]) * u[1];
    const ts = points.map(project),
      lo = Math.min(...ts),
      hi = Math.max(...ts);
    if ((hi - lo) * feetPerPixel < 1) return;
    const deviation = Math.max(
      ...points.map((p) =>
        Math.abs((p[0] - mean[0]) * n[0] + (p[1] - mean[1]) * n[1]),
      ),
    );
    if (deviation > 1.5 + 1e-8) return;
    // Reject arbitrary lines inside solid paint. Most samples must observe a
    // paint boundary; a hatch intersection may hide it locally, without breaking
    // the actual continuous ink. This does not classify the enclosure as a wall.
    let boundary = 0;
    const boundaries: boolean[] = [];
    for (const p of points) {
      const onBoundary =
        !ink(Math.floor(p[0] + n[0] * 2.5), Math.floor(p[1] + n[1] * 2.5)) ||
        !ink(Math.floor(p[0] - n[0] * 2.5), Math.floor(p[1] - n[1] * 2.5));
      boundaries.push(onBoundary);
      if (onBoundary) boundary++;
    }
    if (limited) return;
    const at = (t: number): AreaPoint => [
      mean[0] + u[0] * t,
      mean[1] + u[1] * t,
    ];
    const order = points.map((_, i) => i).sort((a, b) => ts[a] - ts[b]),
      orderedPoints = order.map((i) => points[i]),
      orderedBoundaries = order.map((i) => boundaries[i]);
    // A crossing may hide the boundary on part of continuous observed ink.
    // Preserve independently qualified pieces rather than rejecting its entire
    // parent. Short pieces are allowed only within an already observed long run;
    // the same 90% boundary, fit, sampling and downstream assembly checks apply.
    const intervals =
      boundary / points.length >= 0.9
        ? {
            ranges: [[0, points.length]] as Array<[number, number]>,
            limited: false,
          }
        : rasterBoundaryIntervals(
            orderedBoundaries,
            Math.max(12, Math.ceil(0.18 / feetPerPixel) + 1),
            () => {
              if (++work > workLimit) {
                limited = true;
                return false;
              }
              return true;
            },
          );
    if (intervals.limited) {
      limited = true;
      return;
    }
    for (const [start, end] of intervals.ranges) {
      const observed = orderedPoints.slice(start, end),
        observedBoundaries = orderedBoundaries.slice(start, end),
        from = ts[order[start]],
        to = ts[order[end - 1]];
      if (retainedSamples + observed.length > sampleLimit) {
        limited = true;
        return;
      }
      retainedSamples += observed.length;
      candidates.push({
        a: at(from),
        b: at(to),
        length: to - from,
        points: observed,
        boundaries: observedBoundaries,
        support: {
          profile: RASTER_STRAIGHT_RUN_PROFILE,
          sampleCount: observed.length,
          boundaryFraction:
            observedBoundaries.filter(Boolean).length / observed.length,
          maximumDeviationPixels: deviation,
          continuousInk: true,
        },
      });
    }
    if (candidates.length > maximum * 8) limited = true;
  };
  // Exact axis runs remain straight across source hatch junctions. Only ink
  // on this row/column counts; positive white intervals are never joined.
  for (const vertical of [false, true]) {
    const across = vertical ? width : height,
      along = vertical ? height : width;
    for (let q = 2; q < across - 2 && !limited; q++) {
      let start = -1;
      for (let t = 0; t <= along && !limited; t++) {
        const on = vertical ? ink(q, t) : ink(t, q);
        if (on && start < 0) start = t;
        if (!on && start >= 0) {
          if (t - start >= minimum)
            save(
              Array.from(
                { length: t - start },
                (_, i): AreaPoint =>
                  vertical
                    ? [q + 0.5, start + i + 0.5]
                    : [start + i + 0.5, q + 0.5],
              ),
              vertical ? [0, 1] : [1, 0],
              true,
            );
          start = -1;
        }
      }
    }
  }
  const pixel = ([x, y]: AreaPoint): AreaPoint => [
    ((x - region.x0) * width) / (region.x1 - region.x0),
    ((y - region.y0) * height) / (region.y1 - region.y0),
  ];
  const seeds: { a: AreaPoint; b: AreaPoint; length: number }[] = [];
  // Oblique digital boundaries can be staircases whose individual simplified
  // edges are all short. Fit bounded windows of the connected contour, rather
  // than assuming that a long face must contain one long command.
  contourWindows: for (const path of input.contours.paths)
    for (const ring of flattenEvidencePath(path)) {
      const points = ring.map(pixel);
      for (let start = 0; start < points.length - 2; start += 8)
        for (const size of [16, 32, 64]) {
          const window = points.slice(
            start,
            Math.min(points.length, start + size),
          );
          if (window.length < 3) continue;
          const mean: AreaPoint = [
            window.reduce((n, p) => n + p[0], 0) / window.length,
            window.reduce((n, p) => n + p[1], 0) / window.length,
          ];
          let xx = 0,
            xy = 0,
            yy = 0;
          for (const p of window) {
            const x = p[0] - mean[0],
              y = p[1] - mean[1];
            xx += x * x;
            xy += x * y;
            yy += y * y;
          }
          const angle = 0.5 * Math.atan2(2 * xy, xx - yy),
            u: AreaPoint = [Math.cos(angle), Math.sin(angle)],
            ts = window.map(
              (p) => (p[0] - mean[0]) * u[0] + (p[1] - mean[1]) * u[1],
            );
          const lo = Math.min(...ts),
            hi = Math.max(...ts),
            length = hi - lo;
          if (
            length * feetPerPixel < 0.5 ||
            Math.min(Math.abs(u[0]), Math.abs(u[1])) < 1e-7
          )
            continue;
          if (
            window.some(
              (p) =>
                Math.abs((p[0] - mean[0]) * u[1] - (p[1] - mean[1]) * u[0]) >
                2.5,
            )
          )
            continue;
          const at = (t: number): AreaPoint => [
            mean[0] + u[0] * t,
            mean[1] + u[1] * t,
          ];
          seeds.push({ a: at(lo), b: at(hi), length });
          if (seeds.length >= 12000) {
            limited = true;
            break contourWindows;
          }
        }
    }
  seedSources: for (const path of input.contours.paths)
    for (const ring of flattenEvidencePath(path))
      for (let i = 1; i < ring.length; i++) {
        const a = pixel(ring[i - 1]),
          b = pixel(ring[i]),
          length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (
          length * feetPerPixel >= 0.5 &&
          Math.abs(b[0] - a[0]) > 1e-7 &&
          Math.abs(b[1] - a[1]) > 1e-7
        )
          seeds.push({ a, b, length });
        if (seeds.length >= 12000) {
          limited = true;
          break seedSources;
        }
      }
  const seeded = new Set<string>();
  for (const seed of seeds.sort((a, b) => b.length - a.length)) {
    if (limited) break;
    const dx = seed.b[0] - seed.a[0],
      dy = seed.b[1] - seed.a[1],
      majorX = Math.abs(dx) >= Math.abs(dy);
    const value = (t: number) =>
      majorX
        ? seed.a[1] + ((t + 0.5 - seed.a[0]) * dy) / dx
        : seed.a[0] + ((t + 0.5 - seed.a[1]) * dx) / dy;
    const middle = Math.floor(
        majorX ? (seed.a[0] + seed.b[0]) / 2 : (seed.a[1] + seed.b[1]) / 2,
      ),
      along = majorX ? width : height;
    const observe = (t: number): AreaPoint | null => {
      const expected = value(t),
        center = Math.floor(expected);
      const choices = [center, center - 1, center + 1].sort(
        (a, b) => Math.abs(a + 0.5 - expected) - Math.abs(b + 0.5 - expected),
      );
      for (const q of choices)
        if (
          Math.abs(q + 0.5 - expected) <= 1.5 &&
          (majorX ? ink(t, q) : ink(q, t))
        )
          return majorX ? [t + 0.5, q + 0.5] : [q + 0.5, t + 0.5];
      return null;
    };
    const origin = observe(middle);
    if (!origin || limited) continue;
    // Repeated seeds on the same observed digital line need no duplicate walk.
    const seedKey = [
      majorX,
      Math.round(Math.atan2(dy, dx) * 10000),
      Math.round((seed.a[0] * dy - seed.a[1] * dx) / seed.length),
    ].join(":");
    if (seeded.has(seedKey)) continue;
    seeded.add(seedKey);
    const left: AreaPoint[] = [],
      right: AreaPoint[] = [];
    for (const sign of [-1, 1])
      for (let t = middle + sign; t >= 0 && t < along && !limited; t += sign) {
        const p = observe(t);
        if (!p) break;
        (sign < 0 ? left : right).push(p);
      }
    save(
      [...left.reverse(), origin, ...right],
      [dx / seed.length, dy / seed.length],
    );
  }
  const selected: typeof candidates = [];
  let consolidationWork = 0;
  // Multiple contour seeds can observe the same ink with slightly different
  // fits. Partition their measured samples against previously observed spans.
  // Keep the first fit and every uncovered tail; never union faces, extend a
  // boundary, bridge white gaps or average the observations into a new line.
  for (const candidate of candidates.sort(
    (a, b) =>
      b.length - a.length ||
      a.support.maximumDeviationPixels - b.support.maximumDeviationPixels ||
      a.a[0] - b.a[0] ||
      a.a[1] - b.a[1],
  )) {
    const u: AreaPoint = [
      (candidate.b[0] - candidate.a[0]) / candidate.length,
      (candidate.b[1] - candidate.a[1]) / candidate.length,
    ];
    const project = (p: AreaPoint) =>
      (p[0] - candidate.a[0]) * u[0] + (p[1] - candidate.a[1]) * u[1];
    const at = (t: number): AreaPoint => [
      candidate.a[0] + u[0] * t,
      candidate.a[1] + u[1] * t,
    ];
    const covered = new Uint8Array(candidate.points.length);
    const projections = candidate.points.map(project);
    for (const old of selected) {
      if (++consolidationWork > 16_000_000) {
        limited = true;
        break;
      }
      const ts = [project(old.a), project(old.b)].sort((a, b) => a - b),
        lo = Math.max(0, ts[0]),
        hi = Math.min(candidate.length, ts[1]);
      if (hi <= lo) continue;
      const ou: AreaPoint = [
        (old.b[0] - old.a[0]) / old.length,
        (old.b[1] - old.a[1]) / old.length,
      ];
      if (
        Math.abs(u[0] * ou[1] - u[1] * ou[0]) *
          Math.min(candidate.length, old.length) >
        3 +
          candidate.support.maximumDeviationPixels +
          old.support.maximumDeviationPixels
      )
        continue;
      const distance = (p: AreaPoint) =>
        Math.abs((p[0] - old.a[0]) * ou[1] - (p[1] - old.a[1]) * ou[0]);
      if (
        Math.max(distance(at(lo)), distance(at(hi))) >
        3 +
          candidate.support.maximumDeviationPixels +
          old.support.maximumDeviationPixels
      )
        continue;
      const sameStroke = new Uint8Array(candidate.points.length);
      for (let i = 0; i < candidate.points.length && !limited; i++) {
        if (++consolidationWork > 16_000_000) {
          limited = true;
          break;
        }
        if (
          covered[i] ||
          projections[i] < lo - 1e-7 ||
          projections[i] > hi + 1e-7
        )
          continue;
        const p = candidate.points[i],
          t = (p[0] - old.a[0]) * ou[0] + (p[1] - old.a[1]) * ou[1];
        const index = Math.round((t / old.length) * (old.points.length - 1));
        for (
          let k = Math.max(0, index - 2);
          k <= Math.min(old.points.length - 1, index + 2);
          k++
        ) {
          if (++consolidationWork > 16_000_000) {
            limited = true;
            break;
          }
          const q = old.points[k],
            dx = q[0] - p[0],
            dy = q[1] - p[1];
          // Only nearby source pixels connected by dark ink can belong to the
          // same measured stroke band. White separation preserves close rails.
          if (Math.hypot(dx, dy) > 3 + 1e-7) continue;
          const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)));
          let connected = true;
          for (let j = 0; j <= steps; j++)
            if (
              !ink(
                Math.floor(p[0] + dx * (steps ? j / steps : 0)),
                Math.floor(p[1] + dy * (steps ? j / steps : 0)),
              )
            ) {
              connected = false;
              break;
            }
          if (connected) {
            sameStroke[i] = 1;
            break;
          }
        }
      }
      // A lone hatch junction can connect distinct close rails. Only sustained
      // connected observations establish equivalent stroke coverage.
      let sameStart = -1;
      for (let i = 0; i <= sameStroke.length; i++) {
        if (i < sameStroke.length && sameStroke[i] && sameStart < 0)
          sameStart = i;
        if ((i === sameStroke.length || !sameStroke[i]) && sameStart >= 0) {
          if (i - sameStart >= 12) covered.fill(1, sameStart, i);
          sameStart = -1;
        }
      }
    }
    if (limited) break;
    let start = -1;
    const keep = (end: number) => {
      if (start < 0) return;
      const points = candidate.points.slice(start, end),
        boundaries = candidate.boundaries.slice(start, end);
      start = -1;
      if (points.length < 2) return; // Single pixels remain in the contour evidence.
      const ts = points.map(project),
        lo = Math.min(...ts),
        hi = Math.max(...ts);
      if (hi - lo < 1e-7) return;
      selected.push({
        ...candidate,
        a: at(lo),
        b: at(hi),
        length: hi - lo,
        points,
        boundaries,
        support: {
          ...candidate.support,
          sampleCount: points.length,
          boundaryFraction: boundaries.filter(Boolean).length / points.length,
        },
      });
    };
    for (let i = 0; i <= candidate.points.length; i++) {
      const observed = i < candidate.points.length && !covered[i];
      if (observed && start < 0) start = i;
      if (!observed) keep(i);
    }
    if (selected.length >= maximum) {
      selected.length = maximum;
      limited = true;
      break;
    }
  }
  const normalized = ([x, y]: AreaPoint): AreaPoint => [
    region.x0 + (x / width) * (region.x1 - region.x0),
    region.y0 + (y / height) * (region.y1 - region.y0),
  ];
  return {
    paths: selected.map((run, id) => ({
      id,
      kind: "stroke",
      rasterFeature: "linework",
      rasterLine: run.support,
      commands: [
        ["M", ...normalized(run.a)],
        ["L", ...normalized(run.b)],
      ],
      color: [0],
      colorSpace: "DeviceGray",
      opacity: 1,
      width: 1,
      dashes: [],
      layer: [],
      groups: [],
      clips: [],
      evenOdd: false,
    })),
    limited,
    inspectedSamples: work,
  };
}
