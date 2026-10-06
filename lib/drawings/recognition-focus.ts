import {
  flattenEvidencePath,
  type AreaEvidence,
  type AreaPoint,
} from "./area-evidence";
/** Prioritize likely plan content over notes/title borders. Parallel ink spans
 * rank where to LOOK; they never classify a path or create a wall themselves. */
export function recognitionFocus(
  evidence: AreaEvidence,
  sx: number,
  sy: number,
): AreaPoint[] {
  const lines = evidence.paths
    .filter((p) => p.kind !== "clip")
    .flatMap((p) =>
      flattenEvidencePath(p).flatMap((r) =>
        r.slice(1).flatMap((b, i) => {
          const a: AreaPoint = [r[i][0] * sx, r[i][1] * sy],
            end: AreaPoint = [b[0] * sx, b[1] * sy],
            dx = end[0] - a[0],
            dy = end[1] - a[1],
            length = Math.hypot(dx, dy);
          return length >= 2
            ? [{ a, b: end, length, ux: dx / length, uy: dy / length }]
            : [];
        }),
      ),
    )
    .sort((a, b) => b.length - a.length)
    .slice(0, 3000);
  const cells = new Map<string, { point: AreaPoint; score: number }>();
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i],
        b = lines[j];
      if (Math.abs(a.ux * b.uy - a.uy * b.ux) > 0.02) continue;
      const ox = b.a[0] - a.a[0],
        oy = b.a[1] - a.a[1],
        distance = Math.abs(-a.uy * ox + a.ux * oy);
      if (distance < 0.25 || distance > 1.25) continue;
      const t0 = ox * a.ux + oy * a.uy,
        t1 = (b.b[0] - a.a[0]) * a.ux + (b.b[1] - a.a[1]) * a.uy;
      const lo = Math.max(0, Math.min(t0, t1)),
        hi = Math.min(a.length, Math.max(t0, t1)),
        overlap = hi - lo;
      if (overlap < 2.5) continue;
      const x = a.a[0] + (a.ux * (lo + hi)) / 2,
        y = a.a[1] + (a.uy * (lo + hi)) / 2,
        key = `${Math.floor(x / 18)}:${Math.floor(y / 18)}`;
      const found = cells.get(key);
      if (found) found.score += overlap;
      else cells.set(key, { point: [x / sx, y / sy], score: overlap });
    }
  return [...cells.values()]
    .sort((a, b) => b.score - a.score)
    .map((c) => c.point);
}
