import type { AreaPoint } from './area-evidence'

/** Fit an existing tessellated swing, never synthesize a curve across a gap.
 * Physical coordinates are feet. Callers must independently verify jamb support
 * before removing these segments or introducing a doorway threshold. */
export function fitOpeningArc(points: AreaPoint[], toleranceFt = .015): { center: AreaPoint; ends: [AreaPoint, AreaPoint] } | null {
  const tolerance = Math.min(.1, Math.max(.015, toleranceFt));
  if (points.length < 7 || points.length > 512) return null
  const a = points[0], b = points[Math.floor(points.length / 2)], c = points[points.length - 1]
  const vx = b[0] - a[0], vy = b[1] - a[1], wx = c[0] - a[0], wy = c[1] - a[1]
  const det = 2 * (vx * wy - vy * wx)
  if (Math.abs(det) < 1e-8) return null
  const vv = vx * vx + vy * vy, ww = wx * wx + wy * wy
  const center: AreaPoint = [a[0] + (vv * wy - ww * vy) / det, a[1] + (vx * ww - wx * vv) / det]
  const radius = Math.hypot(a[0] - center[0], a[1] - center[1])
  if (radius < 1.5 || radius > 4.5 || points.some(p => Math.abs(Math.hypot(p[0] - center[0], p[1] - center[1]) - radius) > tolerance)) return null
  let sweep = 0, direction = 0
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1], q = points[i]
    let step = Math.atan2(q[1] - center[1], q[0] - center[0]) - Math.atan2(p[1] - center[1], p[0] - center[0])
    if (step > Math.PI) step -= 2 * Math.PI
    if (step < -Math.PI) step += 2 * Math.PI
    if (Math.abs(step) < 1e-6 || Math.abs(step) > Math.PI / 8) return null
    if (direction && Math.sign(step) !== direction) return null
    direction = Math.sign(step); sweep += Math.abs(step)
  }
  if (!((sweep >= Math.PI * .38 && sweep <= Math.PI * .62) || (sweep >= Math.PI * .9 && sweep <= Math.PI * 1.1))) return null
  return { center, ends: [a, c] }
}

/** A dimension crossing splits a scan swing at its ink junction. Reassemble
 * only source-connected, tangent continuations. Tiny unclassified junction
 * strokes may connect classified door pieces; no unobserved gap is bridged.
 * The caller must still verify both jambs before accepting a threshold. */
export function joinOpeningStrokes(strokes: Array<{ pathId: number; points: AreaPoint[]; kind: string }>, toleranceFt: number) {
  const distance = (a: AreaPoint, b: AreaPoint) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const candidates = strokes.filter(s => s.points.length >= 2 && (s.kind === 'door' || (s.kind === 'unknown'
    && s.points.slice(1).reduce((n, p, i) => n + distance(p, s.points[i]), 0) <= Math.min(.1, toleranceFt * 2))));
  const key = (p: AreaPoint) => p.map(n => n.toFixed(7)).join(',');
  const ends = new Map<string, Array<{ index: number; reverse: boolean }>>();
  candidates.forEach((s, index) => {
    for (const reverse of [false, true]) {
      const k = key(reverse ? s.points[s.points.length - 1] : s.points[0]);
      ends.set(k, [...(ends.get(k) ?? []), { index, reverse }]);
    }
  });
  const results: Array<{ center: AreaPoint; ends: [AreaPoint, AreaPoint]; pathIds: number[] }> = [], seen = new Set<string>();
  for (let seed = 0; seed < candidates.length; seed++) {
    if (candidates[seed].kind !== 'door') continue;
    const points = [...candidates[seed].points];
    const used = new Set([seed]);
    for (let direction = 0; direction < 2; direction++) {
      points.reverse();
      while (points.length < 500 && used.size < 64) {
        const end = points[points.length - 1];
        // A few raster stair steps do not establish the tangent. Look back
        // over several pixels, retaining short observed junction connectors.
        const behind = [...points].reverse().find(p => distance(p, end) >= Math.max(.08, toleranceFt * 3)) ?? points[0];
        const length = distance(behind, end);
        if (!length) break;
        const choices = (ends.get(key(end)) ?? []).filter(e => !used.has(e.index)).map(e => {
          const p = e.reverse ? [...candidates[e.index].points].reverse() : candidates[e.index].points;
          const ahead = p.find(q => distance(q, end) >= Math.max(.08, toleranceFt * 3)) ?? p[p.length - 1];
          const span = distance(ahead, end);
          return { ...e, points: p, alignment: span ? ((end[0] - behind[0]) * (ahead[0] - end[0]) + (end[1] - behind[1]) * (ahead[1] - end[1])) / (length * span) : -1 };
        }).filter(e => e.alignment >= .65).sort((a, b) => b.alignment - a.alignment);
        // Competing plausible continuations remain ambiguous.
        if (!choices.length || (choices[1] && choices[0].alignment - choices[1].alignment < .15)) break;
        used.add(choices[0].index);
        points.push(...choices[0].points.slice(1));
      }
    }
    if (used.size < 2) continue;
    const signature = [...used].sort((a, b) => a - b).join(',');
    if (seen.has(signature)) continue;
    seen.add(signature);
    const arc = fitOpeningArc(points, toleranceFt);
    if (arc) results.push({ ...arc, pathIds: [...used].map(i => candidates[i].pathId) });
  }
  return results;
}
