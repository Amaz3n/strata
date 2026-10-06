import type { AreaBoundary } from "./area-takeoff"
import type { AreaEvidence, AreaPoint } from "./area-evidence"
import type { TextRun } from "./text-runs"
import { normalizeFeetInchesText, parseFeetInches } from "@/lib/validation/drawings"
import { authoritativeDimensionText } from './raster-text'

type Point = AreaPoint
const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]]
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1]
const length = (v: Point) => Math.hypot(...v)
const at = (a: Point, u: Point, t: number): Point => [a[0] + u[0] * t, a[1] + u[1] * t]

/** Physical-coordinate annotation filter. Text alone never deletes a boundary.
 * Requires a dimension-only label, two ticks/arrow legs, and a measured span
 * agreeing with the printed value. Deletes supported intervals, not whole PDF
 * paths (CAD exports often batch walls and annotations into one path).
 */
export function filterAreaDimensions(edges: AreaBoundary[], runs: TextRun[], sx: number, sy: number, evidence?: AreaEvidence | null) {
  const paths = new Map(evidence?.paths.map((p) => [p.id, p]) ?? [])
  const cuts = new Map<number, Array<[number, number]>>()
  const removedMarks = new Set<number>()
  let dimensions = 0
  const sizes = edges.map((e) => length(sub(e.b, e.a)))
  const style = (i: number) => paths.get(edges[i].pathId ?? -1)
  const removable = (i: number, reference: number) => style(i)?.kind !== "fill" &&
    !(style(i)?.layer.some((l) => /(?:^|[-_ ])walls?(?:$|[-_ ])/i.test(l))) &&
    !(style(i)?.width && style(reference)?.width && style(i)!.width > style(reference)!.width * 1.6)
  const cut = (i: number, lo: number, hi: number) => {
    cuts.set(i, [...(cuts.get(i) ?? []), [Math.max(0, lo), Math.min(1, hi)]])
  }
  for (const run of runs) {
    if (!authoritativeDimensionText(run)) continue
    const text = normalizeFeetInchesText(run.text)
      .replace(/^(\d+)\s*-\s*(\d+(?:\s+\d+\/\d+)?\s*")$/, "$1'-$2")
    // Excludes room numbers, notes, scale equations and dimensions embedded in prose.
    if (!/^\d+(?:\.\d+)?(?:\s+\d+\/\d+)?(?:\s*'\s*(?:-?\s*\d+(?:\s+\d+\/\d+)?\s*"?)?|\s*")$/.test(text)) continue
    const value = parseFeetInches(text)
    if (!value || value < .25) continue
    const w = run.w * sx, h = run.h * sy
    if (!(w > 0 && h > 0)) continue
    const center: Point = [(run.x + run.w / 2) * sx, (run.y + run.h / 2) * sy]
    const textHeight = Math.min(w, h), textSpan = Math.max(w, h)
    const proximity = Math.max(.12, textHeight * 2)
    let best: { score: number; base: number; u: Point; n: Point; lo: number; hi: number; marks: number[]; collinear: number[] } | null = null
    for (let i = 0; i < edges.length; i++) {
      if (sizes[i] < .5 || !removable(i, i)) continue
      const base = edges[i], u = sub(base.b, base.a).map((v) => v / sizes[i]) as Point, n: Point = [-u[1], u[0]]
      // Text boxes retain vertical orientation. Arbitrarily rotated text lacks
      // baseline metadata; leave it untouched rather than guess from its AABB.
      if ((w > h * 1.4 && Math.abs(u[0]) < .98) || (h > w * 1.4 && Math.abs(u[1]) < .98)) continue
      const c = dot(sub(center, base.a), u), offset = Math.abs(dot(sub(center, base.a), n))
      if (offset > proximity || c < -textSpan || c > sizes[i] + textSpan) continue
      const marks: Array<{ t: number; index: number }> = []
      const collinear: number[] = []
      for (let j = 0; j < edges.length; j++) {
        const e = edges[j], v = sub(e.b, e.a), parallel = Math.abs(dot(v, n)) / sizes[j]
        const a = sub(e.a, base.a), b = sub(e.b, base.a)
        if (parallel < .015 && Math.abs(dot(a, n)) < .025 && removable(j, i)) collinear.push(j)
        if (j === i || sizes[j] > Math.max(.8, textHeight * 4) || sizes[j] < .08 || parallel < .3 || parallel > .95) continue
        const na = dot(a, n), nb = dot(b, n)
        // Slash crosses the baseline; arrow legs end on it.
        if (Math.min(na, nb) > .025 || Math.max(na, nb) < -.025 || Math.abs(na - nb) < .01) continue
        const t = dot(a, u) + (dot(b, u) - dot(a, u)) * (-na / (nb - na))
        if (Math.abs(t - c) <= value + textSpan) marks.push({ t, index: j })
      }
      const left = marks.filter((m) => m.t < c - textHeight), right = marks.filter((m) => m.t > c + textHeight)
      for (const a of left) for (const b of right) {
        if (!removable(i, a.index) || !removable(i, b.index)) continue
        const span = b.t - a.t, error = Math.abs(span - value)
        if (error > Math.max(.12, value * .04) || Math.abs((a.t + b.t) / 2 - c) > Math.max(textSpan, span * .15)) continue
        // The entire span must be drawn, except a gap occupied by its label.
        const intervals = collinear.map((j) => [dot(sub(edges[j].a, base.a), u), dot(sub(edges[j].b, base.a), u)].sort((x, y) => x - y))
          .filter(([lo, hi]) => hi >= a.t && lo <= b.t).sort((x, y) => x[0] - y[0])
        let end = a.t, covered = true
        for (const [lo, hi] of intervals) {
          if (lo > end + .04 && !(end >= c - textSpan / 2 - textHeight && lo <= c + textSpan / 2 + textHeight)) { covered = false; break }
          end = Math.max(end, hi)
        }
        if (!covered || end < b.t - .04) continue
        const score = error + offset + Math.abs((a.t + b.t) / 2 - c) * .1
        if (!best || score < best.score) best = { score, base: i, u, n, lo: a.t, hi: b.t,
          marks: marks.filter((m) => Math.abs(m.t - a.t) < .04 || Math.abs(m.t - b.t) < .04).map((m) => m.index), collinear }
      }
    }
    if (!best) continue
    dimensions++
    const { base: i, u, n, lo, hi } = best, origin = edges[i].a
    for (const j of best.collinear) {
      const start = dot(sub(edges[j].a, origin), u), finish = dot(sub(edges[j].b, origin), u), delta = finish - start
      const ts = [(lo - .025 - start) / delta, (hi + .025 - start) / delta].sort((a, b) => a - b)
      if (ts[1] > 0 && ts[0] < 1) cut(j, ts[0], ts[1])
    }
    best.marks.forEach((j) => removedMarks.add(j))
    // Witness lines terminate just beyond a confirmed dimension endpoint.
    // Keep paired wall faces and lines continuing through the annotation.
    for (let j = 0; j < edges.length; j++) {
      if (!removable(j, i) || sizes[j] < .1) continue
      const e = edges[j], v = sub(e.b, e.a)
      if (Math.abs(dot(v, u)) / sizes[j] > .015) continue
      const along = dot(sub(e.a, origin), u)
      if (Math.min(Math.abs(along - lo), Math.abs(along - hi)) > .04) continue
      const na = dot(sub(e.a, origin), n), nb = dot(sub(e.b, origin), n)
      if (na * nb >= 0 || Math.min(Math.abs(na), Math.abs(nb)) > Math.max(.15, textHeight * 2)) continue
      // A witness overshoot has a free tip. A connected corner is wall evidence,
      // even when its short distance beyond the dimension resembles an overshoot.
      const tip = Math.abs(na) < Math.abs(nb) ? e.a : e.b
      const connected = edges.some((other, k) => {
        if (k === j || best.marks.includes(k) || best.collinear.includes(k)) return false
        const d = sub(other.b, other.a), sizeSq = dot(d, d)
        const t = sizeSq ? dot(sub(tip, other.a), d) / sizeSq : -1
        return t >= 0 && t <= 1 && length(sub(tip, at(other.a, d, t))) < .025
      })
      if (connected) continue
      const paired = edges.some((other, k) => {
        if (j === k || sizes[k] < sizes[j] * .6) return false
        const d = sub(other.b, other.a), off = Math.abs(dot(sub(other.a, e.a), u))
        if (Math.abs(dot(d, u)) / sizes[k] > .015 || off < .25 || off > 1.5) return false
        const p = [dot(sub(other.a, e.a), n), dot(sub(other.b, e.a), n)].sort((a, b) => a - b)
        const q = [0, dot(v, n)].sort((a, b) => a - b)
        return Math.min(p[1], q[1]) - Math.max(p[0], q[0]) > Math.min(sizes[j], sizes[k]) * .6
      })
      if (!paired) cut(j, 0, 1)
    }
  }
  const filtered = edges.flatMap((edge, i) => {
    if (removedMarks.has(i)) return []
    // Unrelated short jamb/finish returns must survive an annotation pass.
    if (!cuts.has(i)) return [edge]
    let intervals: Array<[number, number]> = [[0, 1]]
    for (const [lo, hi] of cuts.get(i) ?? []) intervals = intervals.flatMap(([a, b]) =>
      hi <= a || lo >= b ? [[a, b]] : [...(lo > a ? [[a, lo]] : []), ...(hi < b ? [[hi, b]] : [])] as Array<[number, number]>)
    const v = sub(edge.b, edge.a)
    return intervals.filter(([a, b]) => (b - a) * sizes[i] >= .08).map(([a, b]) => ({ ...edge, a: at(edge.a, v, a), b: at(edge.a, v, b) }))
  })
  return { edges: filtered, dimensions }
}
