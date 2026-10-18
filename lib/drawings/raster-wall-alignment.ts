import type { AreaPoint } from "./area-evidence";

/** A continuous measured raster polyline can wobble around one straight face
 * at ink junctions. Fit only that already-connected run, within four source
 * pixels and 0.04 feet. Separate rings/paths must never be passed as one run.
 * The immutable source remains the evidence; this is a reviewable projection. */
export function alignRasterWallRun(points: AreaPoint[], feetPerPixel: number): {
  points: [AreaPoint, AreaPoint]; maximumDeviationFt: number;
} | null {
  if (points.length < 3 || !Number.isFinite(feetPerPixel) || feetPerPixel <= 0 || points.some(p => p.some(n => !Number.isFinite(n)))) return null;
  const tolerance = Math.min(.04, feetPerPixel * 4);
  const segments = points.slice(1).map((b, i) => {
    let a = points[i];
    if (a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])) [a, b] = [b, a];
    return { a, b, length: Math.hypot(b[0] - a[0], b[1] - a[1]) };
  }).sort((a, b) => b.length - a.length || a.a[0] - b.a[0] || a.a[1] - b.a[1]);
  const longest = segments[0];
  if (longest.length < .75) return null;
  const u: AreaPoint = [(longest.b[0] - longest.a[0]) / longest.length, (longest.b[1] - longest.a[1]) / longest.length];
  const project = (p: AreaPoint) => (p[0] - longest.a[0]) * u[0] + (p[1] - longest.a[1]) * u[1];
  const deviation = (p: AreaPoint) => Math.abs((p[0] - longest.a[0]) * u[1] - (p[1] - longest.a[1]) * u[0]);
  const maximumDeviationFt = Math.max(...points.map(deviation));
  if (maximumDeviationFt > tolerance + 1e-9) return null;
  const ts = points.map(project), first = ts[0], last = ts[ts.length - 1], sign = Math.sign(last - first);
  if (Math.abs(last - first) < .75) return null;
  // Allow tiny junction detours, not a reversal or an out-and-back outline.
  let furthest = first * sign;
  for (const t of ts) {
    if (t * sign < furthest - tolerance - 1e-9) return null;
    furthest = Math.max(furthest, t * sign);
  }
  const at = (t: number): AreaPoint => [longest.a[0] + u[0] * t, longest.a[1] + u[1] * t];
  return { points: [at(first), at(last)], maximumDeviationFt };
}
