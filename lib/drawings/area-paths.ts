import type { EvidencePath } from './area-evidence'

export type AreaPathRole = 'structure' | 'fixture' | 'decoration' | 'unknown'

/** CAD semantics precede visual weight. Never assume that all thin paths are
 * annotations, or that every path on a wall layer is a wall face. */
export function areaPathRole(path: Pick<EvidencePath, 'layer'>): AreaPathRole {
  const words = path.layer.join(' ').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  const has = (...names: string[]) => names.some(name => words.includes(name))
  if (has('hatch', 'hatching', 'dimension', 'dimensions', 'dim', 'dims', 'annotation', 'annotations', 'anno', 'text', 'callouts')) return 'decoration'
  if (has('wall', 'walls', 'column', 'columns', 'cols', 'door', 'doors', 'window', 'windows', 'wdw', 'wnd', 'glaz')) return 'structure'
  if (has('plumb', 'plumbing', 'fixture', 'fixtures', 'pfix')) return 'fixture'
  if (has('furniture', 'furn', 'millwork', 'mil', 'clg', 'ceiling', 'casework', 'case', 'woodwork', 'cabinet', 'cabinets', 'cabinetry', 'kitchen', 'equipment', 'eqmt', 'driveway', 'landscape', 'landscaping', 'hardscape', 'paving', 'floor', 'flooring', 'mark', 'roof', 'roofs', 'beam', 'beams', 'setback', 'setbacks')) return 'decoration'
  return 'unknown'
}
