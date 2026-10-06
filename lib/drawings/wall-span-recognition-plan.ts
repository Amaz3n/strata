import type { AreaRecognitionRequest } from './area-engine'
import type { AreaRegion } from './area-takeoff'
import type { RecognitionAssembly } from './recognition-assemblies'
import type { WallHypothesisBinding } from './wall-hypothesis-semantics'

export const WALL_SPAN_REQUEST_LIMIT = 16

/** Schedule exact physical spans independently of whole-parent voting. A
 * cropped parent's commands are never presented as a complete role target. */
export function planUnassignedWallSpans(input: {
  assemblies: readonly RecognitionAssembly[]
  requests: readonly AreaRecognitionRequest[]
  region: AreaRegion
  sx: number
  sy: number
  capacity: {x: number; y: number}
  remainingWork: number
}): {requests: AreaRecognitionRequest[]; unframedIds: string[]; work: number; limited: boolean} {
  if (![input.sx,input.sy,input.capacity.x,input.capacity.y].every(n=>Number.isFinite(n)&&n>0) ||
    !Number.isInteger(input.remainingWork) || input.remainingWork < 0 || input.remainingWork > 2_000_000)
    throw Error('Invalid wall span recognition frame or source-work allowance')
  const requests: AreaRecognitionRequest[] = [], unframedIds: string[] = []
  let work = 0, limited = false
  const offered = new Set(input.requests.flatMap(r => r.wallHypotheses?.map(h => h.binding.id) ?? []))
  const candidates = new Map<string, WallHypothesisBinding>(), ambiguous = new Set<string>()
  for (const a of input.assemblies) {
    const b = a.wallHypothesis
    if (!b) continue
    const prior = candidates.get(b.id)
    if (prior && prior.witness !== b.witness) ambiguous.add(b.id)
    else candidates.set(b.id, b)
  }
  const axis = (lo: number, hi: number, lower: number, upper: number, capacity: number, scale: number) => {
    if (lo < lower || hi > upper || hi - lo > capacity + 1e-12) return null
    const width = Math.min(capacity, upper - lower, Math.max(12 / scale, hi - lo + 8 / scale))
    const start = Math.max(lower, Math.min((lo + hi - width) / 2, upper - width, lo))
    const end = Math.min(upper, Math.max(start + width, hi))
    return start <= lo && end >= hi && end - start <= capacity + 1e-12 ? [start, end] : null
  }
  const pending = [...candidates.values()].filter(b => !offered.has(b.id))
  for (const seed of pending) {
    if (offered.has(seed.id)) continue
    if (ambiguous.has(seed.id)) {unframedIds.push(seed.id); continue}
    const b = seed.region, r = input.region
    const x = axis(b.x0, b.x1, r.x0, r.x1, input.capacity.x, input.sx)
    const y = axis(b.y0, b.y1, r.y0, r.y1, input.capacity.y, input.sy)
    if (!x || !y) {unframedIds.push(seed.id); continue}
    const region = {x0:x[0], y0:y[0], x1:x[1], y1:y[1]}
    const wallHypotheses: NonNullable<AreaRecognitionRequest['wallHypotheses']> = []
    for (const binding of pending) {
      if (++work > input.remainingWork) {limited = true; break}
      if (offered.has(binding.id) || ambiguous.has(binding.id)) continue
      const s = binding.region
      if (s.x0 < region.x0 || s.y0 < region.y0 || s.x1 > region.x1 || s.y1 > region.y1) continue
      const bounds = [(s.x0-region.x0)/(region.x1-region.x0), (s.y0-region.y0)/(region.y1-region.y0),
        (s.x1-region.x0)/(region.x1-region.x0), (s.y1-region.y0)/(region.y1-region.y0)]
      wallHypotheses.push({binding, bounds}); offered.add(binding.id)
      if (wallHypotheses.length === WALL_SPAN_REQUEST_LIMIT) break
    }
    if (wallHypotheses.length) requests.push({region, catalogue:[], wallHypotheses})
    if (limited) break
  }
  unframedIds.push(...pending.filter(b => !offered.has(b.id)).map(b => b.id))
  return {requests, unframedIds:[...new Set(unframedIds)], work, limited}
}
