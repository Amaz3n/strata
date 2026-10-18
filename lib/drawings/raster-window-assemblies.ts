import type { AreaInput } from "./area-takeoff";
import { evidencePathBounds, flattenEvidencePath, type AreaPoint } from "./area-evidence";
import { interpretArchitecturalElements } from "./area-semantics";

/** Assemble explicitly classified window ink into a frame candidate. Shared
 * source vertices establish connectivity; proximity never joins two windows.
 * The caller must still find a measured wall host for the entire frame. */
export function rasterWindowAssemblies(input: AreaInput): Array<{ a: AreaPoint; b: AreaPoint; pathIds: number[] }> {
  if (!input.evidence?.raster) return [];
  const sx = input.imageWidth * input.feetPerImagePx, sy = input.imageHeight * input.feetPerImagePx;
  const elements = new Map(interpretArchitecturalElements(input.evidence, input.visualObservations, {sx:input.imageWidth*input.feetPerImagePx,sy:input.imageHeight*input.feetPerImagePx}).map(e => [e.pathId, e]));
  const rings = input.evidence.paths.flatMap(p => {
    const e = elements.get(p.id), b = evidencePathBounds(p), r = input.region;
    if (e?.kind !== "window" || e.conflict || p.kind === "clip" || p.clips.length || p.dashes.length || p.opacity < .5 || p.commands.some(c => c[0] === "C") || !b || b.x0 < r.x0 || b.x1 > r.x1 || b.y0 < r.y0 || b.y1 > r.y1) return [];
    return flattenEvidencePath(p).filter(r => r.length > 1).map(points => ({ id: p.id, points: points.map(p => [p[0] * sx, p[1] * sy] as AreaPoint) }));
  });
  const key = (p: AreaPoint) => p.map(n => n.toFixed(8)).join(",");
  const at = new Map<string, number[]>();
  rings.forEach((r, i) => r.points.forEach(p => at.set(key(p), [...(at.get(key(p)) ?? []), i])));
  const seen = new Set<number>(), result: ReturnType<typeof rasterWindowAssemblies> = [];
  for (let i = 0; i < rings.length; i++) {
    if (seen.has(i)) continue;
    const group = [i]; seen.add(i);
    for (let q = 0; q < group.length; q++) for (const p of rings[group[q]].points) for (const j of at.get(key(p)) ?? []) {
      if (!seen.has(j)) { seen.add(j); group.push(j); }
    }
    if (group.length > 512) continue;
    const points = group.flatMap(j => rings[j].points);
    if (points.length > 4096) continue;
    const edges = group.flatMap(j => rings[j].points.slice(1).map((b, i) => ({ a: rings[j].points[i], b })));
    const lengths = edges.map(e => Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]));
    const index = lengths.indexOf(Math.max(...lengths)), seed = edges[index], longest = lengths[index];
    if (longest < 1.25) continue;
    const u: AreaPoint = [(seed.b[0] - seed.a[0]) / longest, (seed.b[1] - seed.a[1]) / longest];
    const t = (p: AreaPoint) => (p[0] - seed.a[0]) * u[0] + (p[1] - seed.a[1]) * u[1];
    const d = (p: AreaPoint) => -(p[0] - seed.a[0]) * u[1] + (p[1] - seed.a[1]) * u[0];
    const ts = points.map(t), ds = points.map(d), start = Math.min(...ts), end = Math.max(...ts), low = Math.min(...ds), high = Math.max(...ds), width = end - start, depth = high - low;
    if (width < 1.5 || width > 20 || depth < .2 || depth > 1.5 || width < depth * 2) continue;
    const sides = edges.map(e => ({ a: t(e.a), b: t(e.b), da: d(e.a), db: d(e.b) }));
    // Both ends need actual perpendicular frame returns, not just pane tips.
    if (![start, end].every(tip => {
      const returns = sides.filter(e => Math.abs(e.a - tip) <= .15 && Math.abs(e.b - tip) <= .15 && Math.abs(e.da - e.db) >= .15 && Math.abs(e.a - e.b) <= .04);
      return returns.length && Math.max(...returns.flatMap(e => [e.da, e.db])) - Math.min(...returns.flatMap(e => [e.da, e.db])) >= depth * .6;
    })) continue;
    const panes = sides.filter(e => Math.abs(e.b - e.a) >= .75 && Math.abs(e.da - e.db) <= .02 * Math.abs(e.b - e.a)).map(e => ({ start: Math.min(e.a, e.b), end: Math.max(e.a, e.b), offset: (e.da + e.db) / 2 }));
    const supported = panes.flatMap((p, i) => panes.slice(i + 1).flatMap(q => {
      const separation = Math.abs(p.offset - q.offset), a = Math.max(p.start, q.start), b = Math.min(p.end, q.end);
      return separation >= .03 && separation <= .3 && b - a >= Math.min(p.end - p.start, q.end - q.start) * .8 ? [[a, b]] : [];
    })).sort((a, b) => a[0] - b[0]);
    let covered = 0, last = start;
    for (const [a, b] of supported) { covered += Math.max(0, b - Math.max(last, a)); last = Math.max(last, b); }
    if (covered < width * .7) continue;
    const point = (x: number): AreaPoint => [seed.a[0] + u[0] * x - u[1] * (low + high) / 2, seed.a[1] + u[1] * x + u[0] * (low + high) / 2];
    result.push({ a: point(start), b: point(end), pathIds: [...new Set(group.map(j => rings[j].id))].sort((a, b) => a - b) });
  }
  return result;
}
