import type { AreaPoint } from "./area-evidence";
import { segmentIndex } from "./segment-index";

interface WindowSpan { a: AreaPoint; b: AreaPoint; pathIds: number[] }
interface OpeningSpan { a: AreaPoint; b: AreaPoint; thicknessFt: number }
const dot = (a: AreaPoint, b: AreaPoint) => a[0] * b[0] + a[1] * b[1];
const sub = (a: AreaPoint, b: AreaPoint): AreaPoint => [a[0] - b[0], a[1] - b[1]];
const length = (p: AreaPoint) => Math.hypot(...p);

/** Track recognized paired panes that did not become openings. Grouping only
 * places a review marker; it must never create a host or enlarge an opening.
 * All coordinates are feet. A lone line/tag is insufficient window evidence. */
export function unrepresentedWindows(sources: WindowSpan[], openings: OpeningSpan[]): WindowSpan[] {
  const spans = sources.filter(s => length(sub(s.b, s.a)) >= 1.25).map(s => {
    const v = sub(s.b, s.a), span = length(v);
    return { ...s, span, u: [v[0] / span, v[1] / span] as AreaPoint };
  });
  const near = segmentIndex(spans);
  const coordinates = (a: typeof spans[number], b: { a: AreaPoint; b: AreaPoint }) => {
    const v = sub(b.b, b.a), span = length(v), q = sub(b.a, a.a), n: AreaPoint = [-a.u[1], a.u[0]];
    if (!span || Math.abs(dot(v, n)) / span > .02) return null;
    const t = [dot(q, a.u), dot(sub(b.b, a.a), a.u)].sort((x, y) => x - y);
    return { t, span, offset: Math.max(Math.abs(dot(q, n)), Math.abs(dot(sub(b.b, a.a), n))) };
  };
  const pending = spans.filter((s, i) => {
    const paired = near(s, .3).some(j => {
      if (i === j) return false;
      const c = coordinates(s, spans[j]);
      return c && c.offset >= .03 && c.offset <= .3 && Math.min(s.span, c.t[1]) - Math.max(0, c.t[0]) >= Math.min(s.span, c.span) * .8;
    });
    if (!paired) return false;
    const intervals = openings.flatMap(o => {
      const c = coordinates(s, o);
      return c && c.offset <= o.thicknessFt / 2 + .05 ? [[Math.max(0, c.t[0]), Math.min(s.span, c.t[1])]] : [];
    }).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
    let end = 0, covered = 0;
    for (const [a, b] of intervals) { covered += Math.max(0, b - Math.max(end, a)); end = Math.max(end, b); }
    return covered < s.span * .9;
  });
  const nearbyPending = segmentIndex(pending), visited = new Set<number>(), result: WindowSpan[] = [];
  for (let i = 0; i < pending.length; i++) {
    if (visited.has(i)) continue;
    const group = [i]; visited.add(i);
    for (let k = 0; k < group.length; k++) for (const j of nearbyPending(pending[group[k]], .3)) {
      if (visited.has(j)) continue;
      const a = pending[group[k]], c = coordinates(a, pending[j]);
      if (!c || c.offset > .3 || c.t[0] > a.span + .3 || c.t[1] < -.3) continue;
      visited.add(j); group.push(j);
    }
    const first = pending[i], points = group.flatMap(j => [pending[j].a, pending[j].b]);
    const ts = points.map(p => dot(sub(p, first.a), first.u));
    const at = (t: number): AreaPoint => [first.a[0] + t * first.u[0], first.a[1] + t * first.u[1]];
    result.push({ a: at(Math.min(...ts)), b: at(Math.max(...ts)), pathIds: [...new Set(group.flatMap(j => pending[j].pathIds))].sort((a, b) => a - b) });
  }
  return result;
}
