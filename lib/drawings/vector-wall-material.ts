import { evidencePathBounds, flattenEvidencePath, type AreaEvidence, type AreaPoint } from './area-evidence'
import { vectorSourceVisibility } from './vector-source-visibility'

export interface WallMaterialFootprint {
  pathId: number
  /** Exterior of existing paint; tessellation diagonals are not wall faces. */
  ring: AreaPoint[]
  thicknessFt: number
  lengthFt: number
}

/** Some CAD exports call both solid wall material and microscopic texture
 * A-WALL-HATCH. Layer identity alone cannot distinguish them. Admit only a
 * complete opaque rectangular footprint with measured wall dimensions. This
 * refines the ambiguous hatch prior; it cannot override another object role,
 * manufacture missing wall spans, or certify a drawing's calibration. */
export function wallMaterialFootprints(evidence: AreaEvidence | null | undefined, sx: number, sy: number): Map<number, WallMaterialFootprint> {
  const result = new Map<number, WallMaterialFootprint>()
  if (!evidence || evidence.truncated || evidence.raster || !(sx > 0 && sy > 0 && Number.isFinite(sx + sy))) return result
  const visible = vectorSourceVisibility(evidence)
  const masks = evidence.paths.filter(p => p.kind === 'fill' && p.opacity >= .99 &&
    ((p.colorSpace === 'DeviceGray' && p.color.length === 1 && p.color[0] >= .98) ||
      (p.colorSpace === 'DeviceRGB' && p.color.length === 3 && p.color.every(c => c >= .98))))
    .map(p => ({ id: p.id, bounds: evidencePathBounds(p) }))
  for (const path of evidence.paths) {
    const words = path.layer.join(' ').toLowerCase().split(/[^a-z0-9]+/)
    if (!words.some(w => ['wall', 'walls'].includes(w)) || !words.some(w => ['hatch', 'hatching'].includes(w)) ||
      words.some(w => ['dim', 'dims', 'dimension', 'dimensions', 'annotation', 'annotations', 'anno', 'text', 'callouts', 'demo', 'demolition', 'furniture', 'furn', 'cabinet', 'cabinets', 'cabinetry', 'casework', 'millwork', 'mil', 'fixture', 'fixtures', 'plumb', 'plumbing', 'pfix', 'kitchen', 'equipment', 'eqmt', 'door', 'doors', 'window', 'windows', 'wdw', 'wnd', 'glaz', 'column', 'columns', 'cols', 'floor', 'flooring', 'roof', 'roofs', 'ceiling', 'clg', 'beam', 'beams', 'landscape', 'paving'].includes(w)) ||
      path.kind !== 'fill' || path.opacity < .95 || path.dashes.length || path.commands.length > 12 || path.commands.some(c => c[0] === 'C') ||
      !((path.colorSpace === 'DeviceGray' && path.color.length === 1 && path.color[0] <= .8) ||
        (path.colorSpace === 'DeviceRGB' && path.color.length === 3 && path.color.every(c => c <= .8)))) continue
    const rings = flattenEvidencePath(path)
    if (!rings.length || rings.length > 2 || rings.some(r => r.length < 4 || r[0][0] !== r.at(-1)![0] || r[0][1] !== r.at(-1)![1])) continue
    const parts = rings.map(r => r.slice(0, -1))
    if (!(parts.length === 1 && parts[0].length === 4) && !(parts.length === 2 && parts.every(r => r.length === 3))) continue
    const points = [...new Map(parts.flat().map(p => [p.join(','), p])).values()]
    if (points.length !== 4) continue
    if (parts.length === 2) {
      const common = parts[0].filter(p => parts[1].some(q => p[0] === q[0] && p[1] === q[1]))
      if (common.length !== 2) continue
      const sides = parts.map(r => {
        const p = r.find(p => !common.some(q => p[0] === q[0] && p[1] === q[1]))!
        return (common[1][0]-common[0][0])*(p[1]-common[0][1])-(common[1][1]-common[0][1])*(p[0]-common[0][0])
      })
      if (!(sides[0]*sides[1] < 0)) continue
    }
    const center = [points.reduce((n,p) => n+p[0], 0)/4, points.reduce((n,p) => n+p[1], 0)/4]
    points.sort((a,b) => Math.atan2((a[1]-center[1])*sy,(a[0]-center[0])*sx)-Math.atan2((b[1]-center[1])*sy,(b[0]-center[0])*sx))
    const area = (r: AreaPoint[]) => Math.abs(r.reduce((n,p,i) => n+p[0]*r[(i+1)%r.length][1]-p[1]*r[(i+1)%r.length][0],0))*sx*sy/2
    if (Math.abs(area(points)-parts.reduce((n,r) => n+area(r),0)) > 1e-6) continue
    const edges = points.map((p,i) => [(points[(i+1)%4][0]-p[0])*sx,(points[(i+1)%4][1]-p[1])*sy])
    const lengths = edges.map(v => Math.hypot(...v)), short = Math.min(...lengths), long = Math.max(...lengths)
    if (short < .2 || short > 1.25 || long < 3 || long/short < 4 ||
      edges.some((v,i) => Math.abs(v[0]*edges[(i+1)%4][0]+v[1]*edges[(i+1)%4][1])/(lengths[i]*lengths[(i+1)%4]) > .005) ||
      edges.some((v,i) => Math.hypot(v[0]+edges[(i+2)%4][0],v[1]+edges[(i+2)%4][1]) > 1e-5)) continue
    const bounds = evidencePathBounds(path)!
    // A mask inside a filled body may erase no perimeter edge. Reject any later
    // overlapping opaque erase bounds, conservatively including unsupported clips.
    if (!visible(path) || masks.some(m => m.id > path.id && m.bounds && m.bounds.x1 > bounds.x0 && m.bounds.x0 < bounds.x1 && m.bounds.y1 > bounds.y0 && m.bounds.y0 < bounds.y1)) continue
    result.set(path.id, { pathId: path.id, ring: [...points, points[0]], thicknessFt: short, lengthFt: long })
  }
  return result
}
