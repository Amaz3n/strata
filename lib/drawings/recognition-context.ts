import type { AreaInput } from './area-takeoff'
import type { AreaRecognitionRequest } from './area-engine'
import { visualPathCatalogue } from './area-semantics'

export const RECOGNITION_CONTEXT_PATH_LIMIT = 32

/** Give observed swings complete nearby source anchors even when the wall
 * classification belongs to another batch. Context is nonvoting: it does not
 * spend an ID, resolve its role, or authorize a threshold through wall paint.
 * Only original paths fully visible in the same crop may accompany a request. */
export function withRecognitionContext(input: AreaInput, requests: AreaRecognitionRequest[]): AreaRecognitionRequest[] {
  if (!input.evidence || input.evidence.truncated) return requests
  const wallIds = new Set(requests.flatMap(r => (r.assemblies ?? [])
    .filter(a => ['paired-wall-faces', 'wall-material', 'unfilled-pair-context'].includes(a.hypothesis))
    .flatMap(a => a.pathIds)))
  const sx = input.imageWidth * input.feetPerImagePx, sy = input.imageHeight * input.feetPerImagePx
  return requests.map(request => {
    const swings = request.assemblies?.filter(a => a.hypothesis === 'quarter-arc-context') ?? []
    if (!swings.length || !wallIds.size) return request
    const targets = new Set(request.catalogue.map(p => p.id)), region = request.region
    const dx = (region.x1 - region.x0) * sx, dy = (region.y1 - region.y0) * sy
    const distance = (bounds: number[]) => Math.min(...swings.map(s => {
      // Distances between actual source bounds; no proximity joins geometry.
      const x = Math.max(0, bounds[0] - s.bounds[2], s.bounds[0] - bounds[2]) * dx
      const y = Math.max(0, bounds[1] - s.bounds[3], s.bounds[1] - bounds[3]) * dy
      return Math.hypot(x, y)
    }))
    const contextCatalogue = visualPathCatalogue(input.evidence!, region, Infinity, { sx, sy })
      .filter(p => wallIds.has(p.id) && !targets.has(p.id))
      .map(p => ({ path: p, distance: distance(p.bounds) }))
      .filter(p => p.distance <= 1.5)
      .sort((a, b) => a.distance - b.distance || a.path.id - b.path.id)
      .slice(0, RECOGNITION_CONTEXT_PATH_LIMIT).map(p => p.path)
    return contextCatalogue.length ? { ...request, contextCatalogue } : request
  })
}
