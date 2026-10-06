import { flattenEvidencePath, type AreaEvidence, type AreaPoint } from './area-evidence'
import { fitRasterCircle, RASTER_ARC_PROFILE } from './raster-arcs'

export interface ObservedRasterSwing {
  id: number
  /** Measured source vertices, center and radius in the calibrated feet frame. */
  points: AreaPoint[]
  center: AreaPoint
  radius: number
  error: number
}

/** A measured quarter arc is an inspection cue, not a door or a wall gap.
 * Recognition scheduling and door assembly verification consume the same
 * source observation. Missing leaf/jamb/host evidence is never synthesized. */
export function observedRasterSwings(input: {
  evidence: AreaEvidence | null | undefined
  sx: number
  sy: number
  pathKinds: ReadonlyMap<number, string>
}): { arcs: ObservedRasterSwing[]; clippedPathIds: number[] } {
  const { evidence, sx, sy, pathKinds } = input
  const arcs: ObservedRasterSwing[] = [], clippedPathIds: number[] = []
  if (!evidence?.raster || evidence.truncated ||
    ![sx, sy, evidence.raster.feetPerPixel].every(n => Number.isFinite(n) && n > 0))
    return { arcs, clippedPathIds }
  for (const path of evidence.paths) {
    const support = path.rasterArc, kind = pathKinds.get(path.id) ?? 'unknown'
    if (!['unknown', 'door'].includes(kind) || path.kind !== 'stroke' ||
      path.clips.length || path.dashes.length || !Number.isFinite(path.opacity) || path.opacity < .95 ||
      path.rasterFeature !== 'circular-arc' || support?.profile !== RASTER_ARC_PROFILE ||
      support.continuousInk !== true || !Number.isInteger(support.sampleCount) ||
      support.sampleCount < 7 || support.sampleCount > 16384 ||
      !Number.isFinite(support.maximumDeviationPixels) || support.maximumDeviationPixels < 0 ||
      support.maximumDeviationPixels > 2.5 || !Number.isFinite(support.sweepRadians) ||
      support.sweepRadians < Math.PI * .38 || support.sweepRadians > Math.PI * .62 ||
      typeof support.clipped !== 'boolean') continue
    if (support.clipped) { clippedPathIds.push(path.id); continue }
    // Native observed arcs are bounded polylines, never provider-fit curves.
    if (path.commands.length < 7 || path.commands.length > 512 ||
      path.commands[0][0] !== 'M' || path.commands.slice(1).some(c => c[0] !== 'L')) continue
    const rings = flattenEvidencePath(path)
    if (rings.length !== 1) continue
    const points = rings[0].map(([x, y]): AreaPoint => [x * sx, y * sy])
    if (points.some(p => p.some(n => !Number.isFinite(n)))) continue
    const fit = fitRasterCircle(points), error = (support.maximumDeviationPixels + 1) * evidence.raster.feetPerPixel
    if (fit && fit.radius >= 1.5 && fit.radius <= 4.5 && fit.error <= error)
      arcs.push({ id: path.id, points, center: fit.center, radius: fit.radius, error })
  }
  arcs.sort((a, b) => a.id - b.id)
  clippedPathIds.sort((a, b) => a - b)
  return { arcs, clippedPathIds }
}
