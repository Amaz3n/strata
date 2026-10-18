import type { AreaPoint } from "./area-evidence";

export interface MeasuredRasterFace {
  a: AreaPoint;
  b: AreaPoint;
  u: AreaPoint;
  length: number;
}

/** Common source span and signed separation at its ends. A uniform separation
 * is compatible with bounded per-position errors only when their intervals
 * intersect. Testing a remote endpoint or the full end-to-end range against a
 * single endpoint error discards otherwise supported local measurements.
 * Neither original face is snapped, extrapolated, or replaced here. */
export function rasterFaceOverlap(
  a: MeasuredRasterFace,
  b: MeasuredRasterFace,
  error: number,
) {
  if (
    !Number.isFinite(error) ||
    error < 0 ||
    ![...a.a, ...a.b, ...a.u, a.length, ...b.a, ...b.b, ...b.u, b.length].every(
      Number.isFinite,
    ) ||
    a.length <= 0 ||
    b.length <= 0
  )
    return null;
  const along = (p: AreaPoint) =>
    (p[0] - a.a[0]) * a.u[0] + (p[1] - a.a[1]) * a.u[1];
  const normal = (p: AreaPoint) =>
    -(p[0] - a.a[0]) * a.u[1] + (p[1] - a.a[1]) * a.u[0];
  const start = along(b.a),
    end = along(b.b),
    delta = end - start;
  if (Math.abs(delta) < 1e-9) return null;
  const lo = Math.max(0, Math.min(start, end)),
    hi = Math.min(a.length, Math.max(start, end));
  if (hi <= lo) return null;
  const depth = (t: number) =>
    normal(b.a) + ((normal(b.b) - normal(b.a)) * (t - start)) / delta;
  const depths: [number, number] = [depth(lo), depth(hi)];
  // Crossing faces do not describe one material strip, even if their centers
  // happen to be close or their error intervals include zero.
  if (depths[0] * depths[1] <= 0) return null;
  const low = Math.max(...depths) - error,
    high = Math.min(...depths) + error;
  if (low > high) return null;
  return {
    lo,
    hi,
    depths,
    depth: (depths[0] + depths[1]) / 2,
    depthInterval: [low, high] as [number, number],
  };
}
