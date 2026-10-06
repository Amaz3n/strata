import { flattenEvidencePath, type AreaEvidence, type AreaPoint } from './area-evidence'
import type { TextRun } from './text-runs'

export interface AreaExclusion { bounds: { x0: number; y0: number; x1: number; y1: number }; reason: string }
const text = (s: string) => s.toUpperCase().replace(/\s+/g, ' ').trim()
const inside = (p: AreaPoint, b: AreaExclusion['bounds']) => p[0] >= b.x0 && p[0] <= b.x1 && p[1] >= b.y0 && p[1] <= b.y1

/** Source-drawn annotation/view frames, never synthetic room boundaries.
 * Only anchored frames are excluded; a sheet border is not a plan classifier. */
export function areaViewExclusions(evidence: AreaEvidence | null | undefined, runs: TextRun[]): AreaExclusion[] {
  const boxes: AreaExclusion['bounds'][] = []
  for (const path of evidence?.paths ?? []) {
    if (path.kind === 'clip' || path.commands.some(c => c[0] === 'C')) continue
    for (const raw of flattenEvidencePath(path)) {
      const ring = raw.filter((p, i) => i !== raw.length - 1 || Math.hypot(p[0] - raw[0][0], p[1] - raw[0][1]) > 1e-8)
      if (ring.length !== 4) continue
      const xs = ring.map(p => p[0]), ys = ring.map(p => p[1])
      const b = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
      const area = (b.x1 - b.x0) * (b.y1 - b.y0)
      if (area < .0001 || area > .45 || ring.some(p => Math.min(Math.abs(p[0] - b.x0), Math.abs(p[0] - b.x1)) > 1e-7 || Math.min(Math.abs(p[1] - b.y0), Math.abs(p[1] - b.y1)) > 1e-7)) continue
      boxes.push(b)
    }
  }
  const exclusions: AreaExclusion[] = []
  const anchors = runs.filter(r => /^(?:NOT TO SCALE|N\.?T\.?S\.?|(?:GENERAL|PLAN|KITCHEN|STRUCTURAL|SITE|CONSTRUCTION) NOTES|(?:SITE PLAN |PLAN )?LEGEND|AREA CALCULATIONS?|GARAGE FLOOD VENT CALCULATION:?|FLOOD VENT CALCULATION:?)$/i.test(text(r.text)))
  for (const anchor of anchors) {
    const point: AreaPoint = [anchor.x + anchor.w / 2, anchor.y + anchor.h / 2]
    const candidates = boxes.filter(b => inside(point, b)).sort((a, b) => (a.x1 - a.x0) * (a.y1 - a.y0) - (b.x1 - b.x0) * (b.y1 - b.y0))
    const chosen = candidates[0]
    if (!chosen) continue
    exclusions.push({ bounds: chosen, reason: text(anchor.text) })
    // A header cell and its text body are frequently separate source rectangles.
    // Include only exactly aligned adjoining cells, not nearby plan geometry.
    for (const b of boxes) if (Math.abs(b.x0 - chosen.x0) < .0001 && Math.abs(b.x1 - chosen.x1) < .0001 && Math.abs(b.y0 - chosen.y1) < .0001) exclusions.push({ bounds: b, reason: text(anchor.text) })
  }
  // Office addresses in a source-framed title block are not architectural rooms.
  for (const run of runs.filter(r => /^SUITE\s*#?\s*\d+/i.test(r.text) && (r.x > .85 || r.y > .9))) {
    const point: AreaPoint = [run.x + run.w / 2, run.y + run.h / 2]
    const boxesHere = boxes.filter(b => inside(point, b)).sort((a, b) => (a.x1 - a.x0) * (a.y1 - a.y0) - (b.x1 - b.x0) * (b.y1 - b.y0))
    if (boxesHere[0]) exclusions.push({ bounds: boxesHere[0], reason: 'Title-block address' })
  }
  return [...new Map(exclusions.map(e => [JSON.stringify(e.bounds), e])).values()]
}

export function textOutsideAreaExclusions(runs: TextRun[], exclusions: AreaExclusion[]): TextRun[] {
  return runs.filter(r => !exclusions.some(e => inside([r.x + r.w / 2, r.y + r.h / 2], e.bounds)))
}

/** Keep negated scope phrases distinct: OPEN TO ABOVE still has a floor. */
export function floorExclusionLabels(runs: TextRun[]): TextRun[] {
  const joined = [...runs]
  for (const first of runs) {
    if (!/^(?:OPEN(?: TO)?|NOT IN|OUT OF|ROOF)$/i.test(text(first.text))) continue
    for (const second of runs) {
      const dy = second.y - first.y
      if (dy > 0 && dy < Math.max(first.h, second.h) * 2 && Math.abs(first.x + first.w / 2 - second.x - second.w / 2) < Math.max(first.w, second.w) * .5) {
        joined.push({ ...first, text: text(first.text + ' ' + second.text), h: dy + second.h })
      }
    }
  }
  return joined.filter(r => /^(?:OPEN(?: TO)? BELOW|(?:NEW|EXISTING|LOWER) ROOF|ROOF BELOW|(?:AREA )?NOT IN (?:THE )?SCOPE(?: OF WORK)?|(?:AREA )?OUT OF SCOPE)$/i.test(text(r.text)))
}
