import type { AreaBoundary } from './area-takeoff';
import type { AreaPoint } from './area-evidence';
import type { ArchitecturalKind } from './area-semantics';

const sub = (a: AreaPoint, b: AreaPoint): AreaPoint => [a[0] - b[0], a[1] - b[1]];
const length = (p: AreaPoint) => Math.hypot(...p);
const dot = (a: AreaPoint, b: AreaPoint) => a[0] * b[0] + a[1] * b[1];
const cross = (a: AreaPoint, b: AreaPoint) => a[0] * b[1] - a[1] * b[0];

/** A window interrupts plan linework but ordinarily retains a wall at floor
 * level. Propose its finish face only between aligned, returning wall ends,
 * with two explicit nearby window panes spanning the intervening region.
 * This inferred face remains reviewable; a gap alone is never sufficient. */
export function windowFloorBoundaries(edges: AreaBoundary[], kinds: ReadonlyMap<number, ArchitecturalKind>, uncertaintyFt = .02): AreaBoundary[] {
  const tolerance = Math.min(.1, Math.max(.02, uncertaintyFt));
  const walls = edges.filter(e => e.pathId !== undefined && kinds.get(e.pathId) === 'wall');
  const panes = edges.filter(e => e.pathId !== undefined && kinds.get(e.pathId) === 'window' && length(sub(e.b, e.a)) >= 1.5);
  if (panes.length < 2 || walls.length < 4) return [];
  const tips = walls.flatMap(e => {
    const v = sub(e.b, e.a), len = length(v);
    return len >= .3 ? [{ point: e.a, direction: v, len, id: e.pathId }, { point: e.b, direction: sub(e.a, e.b), len, id: e.pathId }] : [];
  }).sort((a, b) => a.point[0] - b.point[0]);
  const result: AreaBoundary[] = [];
  for (let i = 0; i < tips.length; i++) for (let j = i + 1; j < tips.length; j++) {
    const a = tips[i], b = tips[j], vector = sub(b.point, a.point), span = length(vector);
    if (vector[0] > 10) break;
    if (span < 1.5 || span > 10) continue;
    const u: AreaPoint = [vector[0] / span, vector[1] / span];
    if (Math.abs(cross(u, a.direction)) / a.len > .015 || Math.abs(cross(u, b.direction)) / b.len > .015 || dot(a.direction, u) >= 0 || dot(b.direction, u) <= 0) continue;
    const hasReturn = (p: AreaPoint) => walls.some(e => {
      const v = sub(e.b, e.a), len = length(v);
      return len >= .15 && Math.abs(dot(v, u)) / len < .02 && Math.min(length(sub(e.a, p)), length(sub(e.b, p))) <= tolerance;
    });
    if (!hasReturn(a.point) || !hasReturn(b.point)) continue;
    if (walls.some(e => {
      const v = sub(e.b, e.a), len = length(v);
      if (!len || Math.abs(cross(u, v)) / len > .015 || Math.abs(cross(u, sub(e.a, a.point))) > tolerance) return false;
      const ts = [dot(sub(e.a, a.point), u), dot(sub(e.b, a.point), u)].sort((x, y) => x - y);
      return Math.min(span, ts[1]) - Math.max(0, ts[0]) > .1;
    })) continue;
    const candidates = panes.flatMap(e => {
      const v = sub(e.b, e.a), len = length(v), offset = cross(u, sub(e.a, a.point));
      const ts = [dot(sub(e.a, a.point), u), dot(sub(e.b, a.point), u)].sort((x, y) => x - y);
      if (Math.abs(cross(u, v)) / len > .02 || Math.abs(offset) > 1.5 || ts[0] < -.1 || ts[1] > span + .1 || ts[0] > 1 || span - ts[1] > 1 || ts[1] - ts[0] < span * .6) return [];
      return [{ e, offset, ts }];
    });
    const supported = candidates.find(p => candidates.some(q => p !== q && Math.abs(p.offset - q.offset) >= .03 && Math.abs(p.offset - q.offset) <= .3
      && Math.min(p.ts[1], q.ts[1]) - Math.max(p.ts[0], q.ts[0]) >= Math.min(p.ts[1] - p.ts[0], q.ts[1] - q.ts[0]) * .9));
    if (!supported) continue;
    if (result.some(e => Math.min(length(sub(e.a, a.point)) + length(sub(e.b, b.point)), length(sub(e.b, a.point)) + length(sub(e.a, b.point))) < tolerance * 2)) continue;
    result.push({ a: a.point, b: b.point, source: 'window', pathId: supported.e.pathId });
  }
  return result;
}
