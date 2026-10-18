import { annotationLeaderIds } from './area-leaders'
import { flattenEvidencePath, type AreaEvidence, type AreaPoint } from "./area-evidence"
import { areaRoomLabel as roomLabelFromText, areaTextRuns } from "./area-labels"
import type { TextRun } from "./text-runs"
import { slidingDoorThresholds } from "./area-doorways"
import { filterAreaDimensions } from "./area-dimensions"
import { areaPathRole, type AreaPathRole } from "./area-paths"
import { geometricStructureIds } from './area-structure'
import { wallMaterialFootprints, type WallMaterialFootprint } from './vector-wall-material'
import { sourceWallNetwork, withDoorCorroboratedFlanks } from './vector-wall-network'
import type { VectorLeafDoorResult } from './vector-leaf-doors'
import { sourceLeafDoors } from './source-leaf-doors'
import { rasterSourceFaces } from './raster-source-faces'
import type { AreaCoverage } from "./area-coverage"
import { fitOpeningArc, joinOpeningStrokes } from './area-opening-curves'
import { floorExclusionLabels } from './area-context'
import { interpretArchitecturalElements, architecturalRole, type AreaVisualObservation, type ArchitecturalKind } from './area-semantics'
import type { AreaArchitecture } from './area-architecture'
import { reconcileAreaCandidates, type AreaConflict } from './area-candidates'
import { consolidateAreaDeductions } from './area-deduction-union'

export const AREA_ENGINE_VERSION = 61
export type AreaFinishPolicy = "drawn" | "include-fixtures"
export type Ring = AreaPoint[]
export interface AreaRegion { x0: number; y0: number; x1: number; y1: number }
export interface AreaBoundary { a: AreaPoint; b: AreaPoint; source: "drawn" | "doorway" | "window" | "user"; pathId?: number; observationId?: string }
export interface AreaProposal {
  id: string
  label: string
  points: Ring
  holes: Ring[]
  originalPoints: Ring
  boundary: AreaBoundary[]
  areaSqft: number
  warnings: string[]
  source: "vector" | "vision" | "user"
  edited: boolean
  finishScopeNote?: string
  finishPolicy?: AreaFinishPolicy
}
export interface AreaDetection {
  engine: number
  proposals: AreaProposal[]
  warnings: string[]
  segmentCount: number
  coverage?: AreaCoverage
  architecture?: AreaArchitecture
  /** Source-supported openings, including closed leaves already drawn as boundaries. */
  openingEvidence?: AreaBoundary[]
  /** Competing measured interpretations; not accepted quantities. */
  alternativeProposals?: AreaProposal[]
  boundaryConflicts?: AreaConflict[]
  diagnostic?: { inputHash: string; engine: number; recognition: string; replayPath?: string }
}
export interface AreaInput {
  /** Explicitly scoped schedule sources; omitted until the caller selected a revision. */
  windowScheduleContext?: { planSourceId: string; rows: import('./window-schedules').WindowScheduleRow[] }
  visualObservations?: AreaVisualObservation[]
  segments: ArrayLike<number>
  flags?: ArrayLike<number> | null
  evidence?: AreaEvidence | null
  textRuns: TextRun[]
  imageWidth: number
  imageHeight: number
  feetPerImagePx: number
  region: AreaRegion
  boundaries?: AreaBoundary[]
  finishPolicy?: AreaFinishPolicy
  /** Largest enclosure considered a floor area; defaults to DEFAULT_MAX_AREA_SQFT. */
  maxAreaSqft?: number
}
const EPS = 0.01 // feet: 0.12", never a multi-foot architectural guess
const MAX_EDGES = 24000
/** Faces longer than this are not traced; interior ones are reported, never silently lost. */
const MAX_FACE_EDGES = 1000
export const DEFAULT_MAX_AREA_SQFT = 100_000
const cross = (a: AreaPoint, b: AreaPoint) => a[0] * b[1] - a[1] * b[0]
const sub = (a: AreaPoint, b: AreaPoint): AreaPoint => [a[0] - b[0], a[1] - b[1]]
const distance = (a: AreaPoint, b: AreaPoint) => Math.hypot(a[0] - b[0], a[1] - b[1])
export const signedArea = (ring: Ring) => ring.reduce((sum, p, i) => sum + cross(p, ring[(i + 1) % ring.length]), 0) / 2
export const ringArea = (ring: Ring) => Math.abs(signedArea(ring))
export function containsPoint(p: AreaPoint, ring: Ring): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j]
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside
  }
  return inside
}

/** Explicit exterior floor fills can bound open finish zones. Admit only fills
 * with exterior tags in their painted interior and no interior room tags. This
 * does not promote floor hatch strokes, cabinetry fills, or the pool's void to
 * structural walls. Normal clipping and geometry checks still apply. */
export function exteriorFloorPathIds(input: Pick<AreaInput, "evidence" | "textRuns">): Set<number> {
  const labels = areaTextRuns(input.textRuns).flatMap(run => {
    const label = roomLabelFromText(run.text)
    return label ? [{ point: [run.x + run.w / 2, run.y + run.h / 2] as AreaPoint,
      exterior: /^(?:OUTDOOR |(?:COVERED )?(?:PATIO|PORCH|TERRACE|DECK|BALCONY|LANAI)\b)/.test(label.toUpperCase()) }] : []
  })
  const selected = new Set<number>()
  if (!labels.some(label => label.exterior)) return selected
  for (const path of input.evidence?.paths ?? []) {
    const words = path.layer.join(' ').toLowerCase().split(/[^a-z0-9]+/)
    if (path.kind !== 'fill' || path.opacity < .5 || path.dashes.length ||
      !words.some(w => w === 'floor' || w === 'flooring') ||
      words.some(w => ['hatch', 'hatching', 'annotation', 'annotations', 'text', 'dim', 'dims'].includes(w)) ||
      path.commands.some(c => c[0] === 'C')) continue
    const rings = flattenEvidencePath(path).map(ring => ring.filter((p, i) =>
      i !== ring.length - 1 || distance(p, ring[0]) > 1e-12))
    if (!rings.length || rings.some(ring => !validRing(ring))) continue
    const ordered = [...rings].sort((a, b) => ringArea(b) - ringArea(a))
    try { validateAreaGeometry({ points: ordered[0], holes: ordered.slice(1) }) } catch { continue }
    // The face graph interprets nested loops as voids. Do not admit a nonzero
    // fill whose nested loops actually paint solid material instead.
    if (!path.evenOdd && ordered.slice(1).some(ring => Math.sign(signedArea(ring)) === Math.sign(signedArea(ordered[0])))) continue
    const painted = (point: AreaPoint) => {
      const enclosing = rings.filter(ring => containsPoint(point, ring))
      return path.evenOdd ? enclosing.length % 2 === 1 : enclosing.reduce((sum, ring) => sum + Math.sign(signedArea(ring)), 0) !== 0
    }
    const inside = labels.filter(label => painted(label.point))
    if (inside.length && inside.every(label => label.exterior)) selected.add(path.id)
  }
  return selected
}
function intersection(a: AreaPoint, b: AreaPoint, c: AreaPoint, d: AreaPoint): [number, number] | null {
  const r = sub(b, a), s = sub(d, c), denominator = cross(r, s)
  if (Math.abs(denominator) < 1e-12) return null
  return [cross(sub(c, a), s) / denominator, cross(sub(c, a), r) / denominator]
}
export function validRing(ring: Ring): boolean {
  if (ring.length < 3 || ring.length > 1000 || ring.some((p) => p.some((n) => !Number.isFinite(n)))) return false
  if (ringArea(ring) < 1e-12) return false
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length]
    if (distance(a, b) < 1e-10) return false
    for (let j = i + 1; j < ring.length; j++) {
      if (j === i + 1 || (i === 0 && j === ring.length - 1)) continue
      const c = ring[j], d = ring[(j + 1) % ring.length]
      const hit = intersection(a, b, c, d)
      if (hit && hit[0] >= 0 && hit[0] <= 1 && hit[1] >= 0 && hit[1] <= 1) return false
      if (!hit && Math.abs(cross(sub(b, a), sub(c, a))) < 1e-12 &&
        Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0])) <= Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0])) &&
        Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1])) <= Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1]))) return false
    }
  }
  return true
}
function ringsCross(a: Ring, b: Ring, includeTouch: boolean): boolean {
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    const hit = intersection(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])
    if (hit && (includeTouch ? hit.every((t) => t >= -1e-10 && t <= 1 + 1e-10) : hit.every((t) => t > 1e-10 && t < 1 - 1e-10))) return true
  }
  return false
}
export function validateAreaGeometry(area: Pick<AreaProposal, "points" | "holes">): void {
  if (!validRing(area.points)) throw new Error("Area boundary is invalid")
  for (let i = 0; i < area.holes.length; i++) {
    const hole = area.holes[i]
    if (!validRing(hole) || !hole.every((p) => containsPoint(p, area.points)) || ringsCross(hole, area.points, true)) throw new Error("Deductions must stay entirely inside their area")
    for (let j = 0; j < i; j++) if (areasOverlap({ points: hole, holes: [] }, { points: area.holes[j], holes: [] })) throw new Error("Deductions must not overlap")
  }
}

export function areasOverlap(a: Pick<AreaProposal, "points" | "holes">, b: Pick<AreaProposal, "points" | "holes">): boolean {
  const inside = (p: AreaPoint, area: Pick<AreaProposal, "points" | "holes">) => containsPoint(p, area.points) && !area.holes.some((h) => containsPoint(p, h))
  if (ringsCross(a.points, b.points, false)) return true
  // Tiny inset samples distinguish coincident/shared edges from overlapping interiors.
  const samples = (ring: Ring) => ring.map((p, i): AreaPoint => {
    const q = ring[(i + 1) % ring.length], length = distance(p, q), sign = Math.sign(signedArea(ring))
    return [(p[0] + q[0]) / 2 - sign * (q[1] - p[1]) / length * 1e-9, (p[1] + q[1]) / 2 + sign * (q[0] - p[0]) / length * 1e-9]
  })
  return samples(a.points).some((p) => inside(p, a) && inside(p, b)) || samples(b.points).some((p) => inside(p, a) && inside(p, b))
}
function project(p: AreaPoint, a: AreaPoint, b: AreaPoint) {
  const v = sub(b, a), lengthSq = v[0] ** 2 + v[1] ** 2
  const t = lengthSq ? ((p[0] - a[0]) * v[0] + (p[1] - a[1]) * v[1]) / lengthSq : 0
  const q: AreaPoint = [a[0] + t * v[0], a[1] + t * v[1]]
  return { t, q, distance: distance(p, q) }
}

/** Planar subdivision. Collinear overlaps and T/X junctions share vertices. */
export function areaFaces(edges: AreaBoundary[], epsilon = EPS, onOversizedFace?: () => void): Array<{ points: Ring; boundary: AreaBoundary[] }> {
  if (edges.length > MAX_EDGES) throw new Error("Too much linework. Select a smaller plan region.")
  const cuts = edges.map(() => [0, 1])
  const order = edges.map((e, i) => ({ i, x0: Math.min(e.a[0], e.b[0]), x1: Math.max(e.a[0], e.b[0]), y0: Math.min(e.a[1], e.b[1]), y1: Math.max(e.a[1], e.b[1]) })).sort((a, b) => a.x0 - b.x0)
  for (let ai = 0; ai < order.length; ai++) for (let bi = ai + 1; bi < order.length; bi++) {
    const ab = order[ai], bb = order[bi]
    if (bb.x0 > ab.x1 + epsilon) break
    if (bb.y0 > ab.y1 + epsilon || ab.y0 > bb.y1 + epsilon) continue
    const i = ab.i, j = bb.i
    const a = edges[i], b = edges[j]
    const hit = intersection(a.a, a.b, b.a, b.b)
    if (hit && hit.every((t) => t >= 0 && t <= 1)) { cuts[i].push(hit[0]); cuts[j].push(hit[1]) }
    for (const [point, target, index] of [[a.a, b, j], [a.b, b, j], [b.a, a, i], [b.b, a, i]] as const) {
      const p = project(point, target.a, target.b)
      if (p.t > 0 && p.t < 1 && p.distance <= epsilon) cuts[index].push(p.t)
    }
  }
  const vertices: Ring = [], outgoing: number[][] = [], grid = new Map<string, number[]>()
  const vertex = (p: AreaPoint) => {
    const x = Math.floor(p[0] / epsilon), y = Math.floor(p[1] / epsilon)
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const id of grid.get(`${x + dx}:${y + dy}`) ?? []) if (distance(p, vertices[id]) <= epsilon) return id
    }
    const id = vertices.length, key = `${x}:${y}`
    vertices.push(p); outgoing.push([]); grid.set(key, [...(grid.get(key) ?? []), id]); return id
  }
  const arcs: Array<{ from: number; to: number; twin: number; edge: AreaBoundary }> = []
  const seen = new Set<string>()
  edges.forEach((edge, i) => {
    const ts = [...new Set(cuts[i])].sort((a, b) => a - b)
    for (let k = 1; k < ts.length; k++) {
      const at = (t: number): AreaPoint => [edge.a[0] + t * (edge.b[0] - edge.a[0]), edge.a[1] + t * (edge.b[1] - edge.a[1])]
      const a = vertex(at(ts[k - 1])), b = vertex(at(ts[k]))
      const key = `${Math.min(a, b)}:${Math.max(a, b)}`
      if (a === b || seen.has(key)) continue
      seen.add(key)
      const id = arcs.length
      arcs.push({ from: a, to: b, twin: id + 1, edge }, { from: b, to: a, twin: id, edge })
      outgoing[a].push(id); outgoing[b].push(id + 1)
    }
  })
  for (const list of outgoing) list.sort((a, b) => {
    const va = sub(vertices[arcs[a].to], vertices[arcs[a].from]), vb = sub(vertices[arcs[b].to], vertices[arcs[b].from])
    return Math.atan2(va[1], va[0]) - Math.atan2(vb[1], vb[0])
  })
  const visited = new Set<number>(), faces: Array<{ points: Ring; boundary: AreaBoundary[] }> = []
  for (let start = 0; start < arcs.length; start++) {
    if (visited.has(start)) continue
    const points: Ring = [], boundary: AreaBoundary[] = []
    let current = start
    do {
      if (visited.has(current)) break
      visited.add(current)
      const arc = arcs[current], next = outgoing[arc.to]
      points.push(vertices[arc.from]); boundary.push({ ...arc.edge, a: vertices[arc.from], b: vertices[arc.to] })
      current = next[(next.indexOf(arc.twin) + next.length - 1) % next.length]
    } while (current !== start)
    // The walk always terminates (each half-edge is visited once). An outer
    // face has negative orientation and is never a room; an interior face this
    // long is skipped but reported so a room is never lost silently.
    if (points.length > MAX_FACE_EDGES) {
      if (current === start && signedArea(points) > epsilon * epsilon) onOversizedFace?.()
      continue
    }
    // A dangling partition is walked out and back. Remove that zero-area spur
    // before validating the ring instead of losing the entire enclosing room.
    let changed = true
    while (changed && points.length >= 3) {
      changed = false
      for (let i = 0; i < points.length; i++) {
        const next = (i + 1) % points.length, after = (i + 2) % points.length
        if (distance(points[i], points[after]) <= epsilon) {
          const remove = new Set([i, next])
          const keptPoints = points.filter((_p, j) => !remove.has(j)), keptEdges = boundary.filter((_e, j) => !remove.has(j))
          points.splice(0, points.length, ...keptPoints); boundary.splice(0, boundary.length, ...keptEdges)
          changed = true; break
        }
      }
    }
    if (current !== start) continue
    // A face can revisit an articulation vertex when a closed fixture or wall
    // loop is attached by a spur. Split the walk into simple cycles; rejecting
    // the whole walk loses the enclosing room even though its perimeter closes.
    const stack: Ring = [], stackEdges: AreaBoundary[] = [], positions = new Map<string, number>()
    const key = (p: AreaPoint) => `${p[0]},${p[1]}`
    for (let i = 0; i <= points.length; i++) {
      const p = points[i % points.length], k = key(p), previous = positions.get(k)
      if (previous !== undefined) {
        const cycle = stack.slice(previous), cycleEdges = stackEdges.slice(previous)
        if (signedArea(cycle) > epsilon * epsilon && validRing(cycle)) faces.push({ points: cycle, boundary: cycleEdges })
        for (const removed of stack.splice(previous)) positions.delete(key(removed))
        stackEdges.splice(previous)
      }
      if (i < points.length) { positions.set(k, stack.length); stack.push(p); stackEdges.push(boundary[i]) }
    }
  }
  return faces
}

/** Internal sheet interpretation. IDs refer to the unmodified source evidence;
 * CAD roles and annotation identity are shared; geometric wall candidates may
 * remain local until global interpretation passes the corpus coverage gate. */
export interface AreaInterpretationContext {
  wallMaterials?: ReadonlyMap<number, WallMaterialFootprint>
  annotationLeaders: ReadonlySet<number>
  inferredStructure?: ReadonlySet<number>
  exteriorFloors?: ReadonlySet<number>
  pathRoles?: ReadonlyMap<number, AreaPathRole>
  pathKinds?: ReadonlyMap<number, ArchitecturalKind>
  leafDoors?: VectorLeafDoorResult
  rasterFaces?: AreaBoundary[]
  independentStructure?: ReadonlySet<number>
}
/** Source interpretation precedes the region graph. Unknown paths remain
 * unknown: labels or successful polygonization cannot promote them to walls. */
export function prepareAreaInterpretation(input: Omit<AreaInput, 'region'>): AreaInterpretationContext {
  const sx=input.imageWidth*input.feetPerImagePx,sy=input.imageHeight*input.feetPerImagePx
  if(!(sx>0&&sy>0&&Number.isFinite(sx+sy)))throw new Error('Calibrate the drawing before interpreting areas.')
  const elements = interpretArchitecturalElements(input.evidence, input.visualObservations, {sx,sy})
  const pathKinds=new Map(elements.map(e=>[e.pathId,e.conflict?'annotation' as const:e.kind]))
  const network=sourceWallNetwork({evidence:input.evidence,sx,sy,textRuns:input.textRuns,visualObservations:input.visualObservations,classifiedWallPathIds:new Set(elements.filter(e=>!e.conflict&&e.kind==='wall').map(e=>e.pathId)),excludedPathIds:new Set(elements.filter(e=>e.conflict||!['unknown','wall'].includes(e.kind)).map(e=>e.pathId))})
  const leafDoors=sourceLeafDoors({evidence:input.evidence,sx,sy,visualObservations:input.visualObservations,wallBodies:network.bodies,candidateWallBodies:network.candidates,pathKinds})
  const supportedNetwork=withDoorCorroboratedFlanks(network,new Set(leafDoors.doors.flatMap(d=>d.wallPathIds)),input.evidence?.raster?leafDoors.doors.flatMap(d=>d.wallSpans??[]):undefined)
  return {
    wallMaterials:wallMaterialFootprints(input.evidence,sx,sy),
    annotationLeaders:annotationLeaderIds(input.evidence,input.textRuns,sx,sy),
    inferredStructure:new Set([...geometricStructureIds(input.evidence,sx,sy),...network.pathIds,...leafDoors.doors.flatMap(d=>d.wallPathIds)]),
    exteriorFloors:exteriorFloorPathIds(input),
    pathRoles:new Map(elements.map(e=>[e.pathId,architecturalRole(e.kind)])),
    pathKinds:new Map(elements.map(e=>[e.pathId,e.kind])),
    leafDoors,
    rasterFaces:rasterSourceFaces(input.evidence,supportedNetwork,sx,sy),
    independentStructure:new Set([...network.pathIds,...leafDoors.doors.flatMap(d=>d.wallPathIds)]),
  }
}
export function detectAreas(input: AreaInput, context?: AreaInterpretationContext): AreaDetection {
  input = { ...input, textRuns: areaTextRuns(input.textRuns) }
  const output: AreaDetection = { engine: AREA_ENGINE_VERSION, proposals: [], warnings: [], segmentCount: 0 }
  const sx = input.imageWidth * input.feetPerImagePx, sy = input.imageHeight * input.feetPerImagePx
  if (!(sx > 0 && sy > 0 && Number.isFinite(sx + sy))) throw new Error("Calibrate the drawing before detecting areas.")
  if (input.finishPolicy === "include-fixtures") output.warnings.push("Fixture footprints included where identified fixture layers permit. Walls stay intact; review unclassified fixtures and built-ins.")
  const region = input.region
  if (!(region.x1 > region.x0 && region.y1 > region.y0)) throw new Error("Select the plan region first.")
  const inRegion = (p: AreaPoint) => p[0] >= region.x0 && p[0] <= region.x1 && p[1] >= region.y0 && p[1] <= region.y1
  const feet = (p: AreaPoint): AreaPoint => [p[0] * sx, p[1] * sy]
  const norm = (p: AreaPoint): AreaPoint => [p[0] / sx, p[1] / sy]
  const edges: AreaBoundary[] = [], doorArcs: Array<{ center: AreaPoint; ends: [AreaPoint, AreaPoint]; pathId?: number }> = []
  const tessellatedSwings: Array<{ pathId: number; pathIds?: number[]; center: AreaPoint; ends: [AreaPoint, AreaPoint] }> = []
  context = context ?? prepareAreaInterpretation(input)
  if(context.leafDoors?.limited)output.warnings.push('Door-leaf assembly analysis exceeded its source budget. Review unresolved openings.')
  const leafPathIds=new Set(context.leafDoors?.doors.flatMap(d=>d.doorPathIds)??[])
  const roleOf = (path: NonNullable<AreaInput["evidence"]>["paths"][number]) => context?.pathRoles?.get(path.id) ?? areaPathRole(path)
  const rasterTolerance = input.evidence?.raster ? Math.min(.1, Math.max(EPS, input.evidence.raster.feetPerPixel * (1 + input.evidence.raster.maximumDeviationPixels))) : EPS
  const leaderIds = context.annotationLeaders
  if (leaderIds.size) output.warnings.push("Source arrowheads and text identify annotation leaders excluded from room boundaries.")
  const exteriorFloors = context?.exteriorFloors ?? exteriorFloorPathIds(input)
  const inferredStructure = new Set([...(context?.inferredStructure ?? geometricStructureIds(input.evidence, sx, sy)),...(context.independentStructure??[])])
  const frameIds=new Set(context.leafDoors?.doors.flatMap(d=>d.framePathIds)??[])
  const evidencePaths=new Map(input.evidence?.paths.map(p=>[p.id,p])??[])
  const sourceEdges = new Map<string,number>()
  const provenancePriority=(id:number|undefined)=>{const path=id===undefined?undefined:evidencePaths.get(id);return path&&roleOf(path)==='structure'?3:id!==undefined&&(inferredStructure.has(id)||frameIds.has(id))?2:0}
  const push = (a: AreaPoint, b: AreaPoint, pathId?: number, minimumLength = EPS) => {
    // Never manufacture a closed boundary along the crop edge.
    // Clip existing linework to the search window, without ever adding a line
    // along the window edge. Long exterior walls must survive local searches.
    let lo = 0, hi = 1
    const delta = sub(b, a)
    for (const [p, q] of [[-delta[0], a[0] - region.x0], [delta[0], region.x1 - a[0]], [-delta[1], a[1] - region.y0], [delta[1], region.y1 - a[1]]]) {
      if (Math.abs(p) < 1e-14) { if (q < 0) return; continue }
      const t = q / p
      if (p < 0) lo = Math.max(lo, t); else hi = Math.min(hi, t)
      if (lo > hi) return
    }
    const origin = a
    a = [origin[0] + lo * delta[0], origin[1] + lo * delta[1]]
    b = [origin[0] + hi * delta[0], origin[1] + hi * delta[1]]
    if (distance(feet(a), feet(b)) < minimumLength) return
    const key = [feet(a), feet(b)].map(p => p.map(v => v.toFixed(6)).join(',')).sort().join('|')
    const existing=sourceEdges.get(key)
    if(existing!==undefined){
      // Paint exporters repeat the same edge in fill/detail/wall paths. Keep
      // corroborated source provenance before constructing the assembly graph;
      // first-painted incidental linework must not erase a measured wall face.
      if(provenancePriority(pathId)>provenancePriority(edges[existing].pathId))edges[existing].pathId=pathId
      return
    }
    sourceEdges.set(key,edges.length)
    edges.push({ a: feet(a), b: feet(b), source: "drawn", pathId })
    if (edges.length > MAX_EDGES) throw new Error("This region has more than 24,000 structural segments. Select a smaller region.")
  }
  if (input.evidence) {
    if (input.evidence.truncated) throw new Error("PDF path extraction was truncated. Use a smaller source drawing or manual takeoff.")
    if (input.evidence.unrepresentedPaint) output.warnings.push("This sheet includes image, shading or masking content that vector detection cannot interpret. Check for missing or obscured boundaries.")
    const paths = new Map(input.evidence.paths.map((p) => [p.id, p]))
    const clipRings = new Map<number, Ring | null>()
    let unsupportedClips = false
    for (const path of input.evidence.paths.filter((p) => p.kind === "clip")) {
      const rings = flattenEvidencePath(path)
      const ring = rings[0]?.filter((p, i, all) => i !== all.length - 1 || distance(p, all[0]) > 1e-12)
      // Only convex single-ring clips can be checked by their endpoints.
      // Curved/compound/nonzero-winding clips need an actual clipping operation.
      const turns = ring?.map((p, i) => cross(sub(ring[(i + 1) % ring.length], p), sub(ring[(i + 2) % ring.length], ring[(i + 1) % ring.length]))).filter((n) => Math.abs(n) > 1e-12) ?? []
      const supported = rings.length === 1 && ring && !path.commands.some((c) => c[0] === "C") && turns.length > 0 && turns.every((n) => Math.sign(n) === Math.sign(turns[0]))
      clipRings.set(path.id, supported ? ring : null)
    }
    for (const path of input.evidence.paths) {
      if(leafPathIds.has(path.id))continue
      const role = roleOf(path)
      if (input.evidence.raster && role === "unknown") continue
      if (leaderIds.has(path.id)) continue
      if (role === "decoration" && !exteriorFloors.has(path.id)) continue
      if (input.finishPolicy === "include-fixtures" && role === "fixture") continue
      if (path.kind === "clip" || path.opacity < 0.5 || path.dashes.length || (!context.wallMaterials?.has(path.id) && /hatch|dimension|(?:^|[-_ ])dims?(?:$|[-_ ])|furniture|(?:^|[-_ ])(?:mil|millwork|clg|ceiling|casework)(?:$|[-_ ])|annotation|text|callouts|door[-_ ]iden|room[-_ ]number/i.test(path.layer.join(" ")))) continue
      if (path.clips.some((id) => !paths.has(id) || !clipRings.get(id))) { unsupportedClips = true; continue }
      const visible = (p: AreaPoint) => path.clips.every((id) => {
        const ring = clipRings.get(id)
        if (!ring) return false
        return containsPoint(p, ring) || ring.some((a, i) => { const q = project(p, a, ring[(i + 1) % ring.length]); return q.t >= 0 && q.t <= 1 && q.distance < 1e-9 })
      })
      // CAD exporters commonly split one swing across multiple cubic commands,
      // sometimes slightly beyond 90 degrees. Fit the complete contiguous curve
      // and validate all samples instead of treating each cubic as a quarter arc.
      let cursor: AreaPoint | null = null
      const doorCommands = new Set<number>()
      for (let ci = 0; ci < path.commands.length; ci++) {
        const command = path.commands[ci]
        if (command[0] === "M" || command[0] === "L") { cursor = [command[1], command[2]]; continue }
        if (command[0] === "Z") { cursor = null; continue }
        if (command[0] !== "C" || !cursor) continue
        let last = ci
        while (path.commands[last + 1]?.[0] === "C") last++
        const curves = path.commands.slice(ci, last + 1)
        const samples = flattenEvidencePath({ ...path, commands: [["M", ...cursor], ...curves] })[0].map(feet)
        const start = samples[0], mid = samples[Math.floor(samples.length / 2)], end = samples[samples.length - 1]
        const v = sub(mid, start), w = sub(end, start), determinant = 2 * cross(v, w)
        if (Math.abs(determinant) > 1e-8) {
          const vv = v[0] ** 2 + v[1] ** 2, ww = w[0] ** 2 + w[1] ** 2
          const center: AreaPoint = [start[0] + (vv * w[1] - ww * v[1]) / determinant,
            start[1] + (v[0] * ww - w[0] * vv) / determinant]
          const r = distance(center, start), a = sub(start, center), b = sub(end, center)
          const angle = Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1]) / (r * r))))
          if (r >= 1.5 && r <= 4.5 && angle >= Math.PI * (path.layer.some(l => /(?:^|[^a-z])doors?(?:$|[^a-z])/i.test(l)) ? .2 : .38) && angle <= Math.PI * .62 &&
            samples.every((p) => Math.abs(distance(center, p) - r) < .025)) {
            if (inRegion(norm(center)) && visible(norm(center)) && samples.every((p) => visible(norm(p)))) {
              doorArcs.push({ center, ends: [start, end], pathId: path.id })
            }
            for (let index = ci; index <= last; index++) doorCommands.add(index)
          }
        }
        cursor = norm(end)
        ci = last
      }
      const material = context.wallMaterials?.get(path.id)
      const lines = material ? [material.ring] : flattenEvidencePath({ ...path, commands: path.commands.map((command, i) =>
        doorCommands.has(i) && command[0] === "C" ? ["M", command[5], command[6]] : command) })
      if (path.kind === 'stroke' && role !== 'fixture' && lines.length === 1 && path.commands.every(c => c[0] === 'M' || c[0] === 'L') && path.commands.filter(c => c[0] === 'M').length === 1) {
        const arc = input.evidence.raster && context.pathKinds?.get(path.id) !== 'door' ? null : fitOpeningArc(lines[0].map(feet), rasterTolerance)
        if (arc && visible(norm(arc.center)) && lines[0].every(visible)) tessellatedSwings.push({ pathId: path.id, ...arc })
      }
      for (const line of lines) {
        for (let i = 1; i < line.length; i++) {
          if (!visible(line[i - 1]) || !visible(line[i])) continue
          // Preserve sub-inch finish/frame returns on classified structure.
          // Unclassified micro-strokes still need a glyph/noise size floor.
          // Several individually sub-EPS raster junction steps can span a
          // meaningful distance together. Keep measured structural strokes;
          // the planar graph may merge nearby vertices, but must not lose
          // the source connection before it builds that graph.
          const structuralMinimum = input.evidence.raster ? Math.min(EPS, input.evidence.raster.feetPerPixel * .1) : EPS
          push(line[i - 1], line[i], path.id, role === "structure" || inferredStructure.has(path.id) ? structuralMinimum : .08)
        }
      }
    }
    if (unsupportedClips) output.warnings.push("Some paths use unsupported clipping and were excluded. Inspect for missing areas or use an image proposal.")
  } else {
    output.warnings.push("Legacy linework: original path and clipping evidence is unavailable. Check every boundary.")
    for (let i = 0; i < input.segments.length / 4; i++) {
      if ((input.flags?.[i] ?? 0) & 1) continue
      push([input.segments[i * 4], input.segments[i * 4 + 1]], [input.segments[i * 4 + 2], input.segments[i * 4 + 3]], i)
    }
  }
  if (input.evidence?.extractionProfile === 'raster-strokes-experimental-1') {
    const strokes = input.evidence.paths.filter(p => p.kind === 'stroke' && !p.clips.length && !p.dashes.length && p.opacity >= .5).flatMap(p => {
      const rings = flattenEvidencePath(p);
      return rings.length === 1 ? [{ pathId: p.id, points: rings[0].map(feet), kind: context.pathKinds?.get(p.id) ?? 'unknown' }] : [];
    });
    for (const arc of joinOpeningStrokes(strokes, rasterTolerance)) {
      const pathId = arc.pathIds.find(id => context.pathKinds?.get(id) === 'door');
      if (pathId !== undefined) tessellatedSwings.push({ ...arc, pathId });
    }
  }
  for(const face of context.rasterFaces??[])push(face.a,face.b,face.pathId,1e-7);
  for(const door of context.leafDoors?.doors??[])if(door.basis==='raster-swing-leaf')for(const jamb of door.jambs)push(jamb.a,jamb.b,jamb.pathIds[0],1e-7);
  const sourcePaths = new Map(input.evidence?.paths.map(p => [p.id, p]) ?? [])
  const swingIds = new Set<number>()
  for (const arc of tessellatedSwings) {
    const supported = (point: AreaPoint) => edges.some(e => {
      if (e.pathId === arc.pathId || (e.pathId !== undefined && arc.pathIds?.includes(e.pathId)) || distance(e.a, e.b) < .15) return false
      const hit = project(point, e.a, e.b)
      if (input.evidence?.raster) {
        const path = e.pathId === undefined ? undefined : sourcePaths.get(e.pathId);
        if (!path || roleOf(path) !== 'structure') return false;
        const t = Math.max(0, Math.min(1, hit.t));
        return distance(point, [e.a[0] + t * (e.b[0] - e.a[0]), e.a[1] + t * (e.b[1] - e.a[1])]) <= rasterTolerance;
      }
      return hit.t >= 0 && hit.t <= 1 && hit.distance <= rasterTolerance
    })
    if (supported(arc.center) && arc.ends.some(supported)) { for (const id of arc.pathIds ?? [arc.pathId]) swingIds.add(id); doorArcs.push(arc) }
  }
  if (swingIds.size) edges.splice(0, edges.length, ...edges.filter(e => e.pathId === undefined || !swingIds.has(e.pathId)))
  const annotations = filterAreaDimensions(edges, input.textRuns, sx, sy, input.evidence)
  edges.splice(0, edges.length, ...annotations.edges.filter((edge) => {
    const path = edge.pathId === undefined ? undefined : sourcePaths.get(edge.pathId)
    if (path && (roleOf(path) === 'structure' || inferredStructure.has(path.id))) return true
    const mid = norm([(edge.a[0] + edge.b[0]) / 2, (edge.a[1] + edge.b[1]) / 2])
    return !input.textRuns.some((t) => mid[0] >= t.x && mid[0] <= t.x + t.w && mid[1] >= t.y && mid[1] <= t.y + t.h &&
      distance(edge.a, edge.b) <= Math.hypot(t.w * sx, t.h * sy) * 1.5)
  }))
  if (annotations.dimensions) output.warnings.push(`Excluded ${annotations.dimensions} dimension annotations supported by labels and endpoint marks. Check the remaining boundaries.`)
  output.segmentCount = edges.length
  if (!edges.length) { output.warnings.push("No usable vector boundaries in this region. Try a detailed image proposal or trace manually."); return output }
  if (edges.length > MAX_EDGES) throw new Error("This region has more than 24,000 structural segments. Select a smaller region.")
  // Door-swing evidence supports a virtual threshold only when both endpoints
  // already lie on drawn boundaries. No closing arbitrary collinear gaps.
  const virtual: AreaBoundary[] = []
  for(const door of context.leafDoors?.doors??[])if(inRegion(door.a)&&inRegion(door.b)){
    virtual.push({a:feet(door.clearSpan?.[0]??door.a),b:feet(door.clearSpan?.[1]??door.b),source:'doorway',pathId:door.doorPathIds[0]})
    output.warnings.push(door.basis==='raster-swing-leaf'?'Observed swing, two leaf faces, its end cap, connected jambs and measured wall flanks support a provisional scan doorway. Clear passage and wall-flank span remain distinct; confirm architectural role and opening dimensions.':'A measured door leaf and both jamb frames support an arc-less opening. Confirm its host and rough-opening convention.')
  }
  const openingSupport = (point: AreaPoint, arc: typeof doorArcs[number]): AreaPoint | null => {
    const source = arc.pathId === undefined ? undefined : sourcePaths.get(arc.pathId)
    const cadDoor = source?.layer.some(l => /(?:^|[^a-z])doors?(?:$|[^a-z])/i.test(l)) ?? false
    // Drafted swing centers can sit inside the hinge/stop rather than exactly
    // on its face. Project only to actual CAD structure within one inch; this
    // tolerance never joins arbitrary wall gaps or moves a drawn wall.
    let best: { point: AreaPoint; distance: number } | null = null
    for (const edge of edges) {
      if (edge.pathId === arc.pathId || distance(edge.a, edge.b) <= .15) continue
      const projection = project(point, edge.a, edge.b)
      const t = Math.max(0, Math.min(1, projection.t))
      const q: AreaPoint = [edge.a[0] + t * (edge.b[0] - edge.a[0]), edge.a[1] + t * (edge.b[1] - edge.a[1])]
      const hit = { q, distance: distance(point, q) }
      const support = edge.pathId === undefined ? undefined : sourcePaths.get(edge.pathId)
      const classifiedScanDoor = input.evidence?.raster && arc.pathId !== undefined && context?.pathKinds?.get(arc.pathId) === 'door'
      const tolerance = support && roleOf(support) === 'structure' ? cadDoor ? 1 / 12 : classifiedScanDoor ? rasterTolerance : EPS : EPS
      if (hit.distance <= tolerance && (!best || hit.distance < best.distance)) best = { point: hit.q, distance: hit.distance }
    }
    return best ? (best.distance <= EPS ? point : best.point) : null
  }
  for (const arc of doorArcs) for (const end of arc.ends) {
    const a = openingSupport(arc.center, arc), b = openingSupport(end, arc)
    if (!a || !b) continue
    const middle: AreaPoint = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    if(inRegion(norm(a))&&inRegion(norm(b)))(output.openingEvidence??=[]).push({a:norm(a),b:norm(b),source:"doorway",pathId:arc.pathId})
    const alreadyDrawn = edges.some((e) => { const p = project(middle, e.a, e.b); return p.t >= 0 && p.t <= 1 && p.distance < 0.08 })
    if (!alreadyDrawn && inRegion(norm(a)) && inRegion(norm(b))) virtual.push({ a, b, source: "doorway" })
  }
  // Paired leaves meet at a free endpoint: no jamb exists at the middle of a
  // double doorway. Two source swings and supported hinge centers establish it.
  for(let i=0;i<doorArcs.length;i++)for(let j=i+1;j<doorArcs.length;j++){
    const a=doorArcs[i],b=doorArcs[j]
    const joint=a.ends.find(p=>b.ends.some(q=>distance(p,q)<=EPS))
    if(!joint||Math.abs(distance(a.center,joint)+distance(b.center,joint)-distance(a.center,b.center))>EPS)continue
    if(distance(a.center,b.center)<3||distance(a.center,b.center)>9)continue
    const start = openingSupport(a.center, a), end = openingSupport(b.center, b)
    if (!start || !end || !inRegion(norm(start)) || !inRegion(norm(end))) continue
    virtual.push({a:start,b:end,source:'doorway'})
  }
  virtual.push(...slidingDoorThresholds(edges, input.evidence, doorArcs, context.pathKinds, rasterTolerance))
  virtual.push(...(input.boundaries ?? []).map((e) => ({ ...e, a: feet(e.a), b: feet(e.b), source: e.observationId && e.source === "doorway" ? "doorway" as const : "user" as const })))
  for(const edge of virtual.filter(e=>e.source==='doorway'))(output.openingEvidence??=[]).push({...edge,a:norm(edge.a),b:norm(edge.b)})
  // Wall-face evidence: a nearby parallel face at a plausible physical wall
  // thickness. This is a filter, not proof of architectural meaning.
  const paired = new Set<AreaBoundary>()
  // Frame/hardware micro-segments cannot be wall pairs. Compute their length
  // once, rather than testing them again for every possible long wall face.
  const wallRuns = edges.map(edge => ({ edge, vector: sub(edge.b, edge.a), length: distance(edge.a, edge.b) })).filter(run => run.length >= 2)
  for (let i = 0; i < wallRuns.length; i++) {
    const { edge: a, vector: v, length } = wallRuns[i]
    for (let j = i + 1; j < wallRuns.length; j++) {
      const { edge: b, vector: w, length: otherLength } = wallRuns[j]
      if (Math.abs(cross(v, w)) / (length * otherLength) > 0.015) continue
      const offset = Math.abs(cross(v, sub(b.a, a.a))) / length
      if (offset < 0.25 || offset > 1.5) continue
      const p0 = project(b.a, a.a, a.b).t, p1 = project(b.b, a.a, a.b).t
      const overlap = Math.max(0, Math.min(1, Math.max(p0, p1)) - Math.max(0, Math.min(p0, p1))) * length
      if (overlap >= Math.min(length, otherLength) * 0.6) { paired.add(a); paired.add(b) }
    }
  }
  let unclassified = 0
  const pairedEdges = [...paired]
  const structuralEdges=edges.filter(edge=>{
    const path=edge.pathId===undefined?undefined:sourcePaths.get(edge.pathId)
    return path&&(roleOf(path)==='structure'||inferredStructure.has(path.id)||exteriorFloors.has(path.id)||frameIds.has(path.id))
  })
  // A separate source-assembly graph prevents unclassified shelves/symbols
  // from partitioning a physically supported floor. Keep the full-linework
  // interpretation as an explicit competing hypothesis, never certify omitted
  // interior linework or promote it to furniture solely because it was omitted.
  let oversizedFaces = 0
  const countOversized = () => { oversizedFaces++ }
  const graphs=[{name:'linework',faces:areaFaces([...edges,...virtual],EPS,countOversized)}]
  if(!input.evidence?.raster&&structuralEdges.length>=4&&structuralEdges.length<edges.length)graphs.push({name:'assemblies',faces:areaFaces([...structuralEdges,...virtual],EPS,countOversized)})
  if (oversizedFaces) output.warnings.push(`${oversizedFaces} enclosed boundaries had more than ${MAX_FACE_EDGES} edges and were too complex to trace. Select a smaller region or trace them manually.`)
  const maxAreaSqft = input.maxAreaSqft ?? DEFAULT_MAX_AREA_SQFT
  let oversizedLabelledAreas = 0
  const fixturePathIds = new Set(input.evidence?.paths.filter(p => roleOf(p) === "fixture").map(p => p.id))
  const columnIds = new Set(input.evidence?.paths.filter(p => /(?:^|[-_ ])columns?(?:$|[-_ ])/i.test(p.layer.join(" "))).map(p => p.id))
  const floorExclusions = floorExclusionLabels(input.textRuns)
  const pathsById = new Map(input.evidence?.paths.map(p => [p.id, p]) ?? [])
  const hasStructuralEvidence = inferredStructure.size > 0 || input.evidence?.paths.some(p => roleOf(p) === 'structure')
  let scopeExcluded = 0, unsupportedAreas = 0
  for(const graph of graphs){
  const faces=graph.faces
  for (let index = 0; index < faces.length; index++) {
    const face = faces[index], area = ringArea(face.points)
    if (area < 2) continue
    if (area > maxAreaSqft) {
      // Sheet frames and site outlines are huge unlabeled faces; only a face
      // holding a room label is a floor area someone expects to see.
      if (input.textRuns.some((run) => roomLabelFromText(run.text) && containsPoint(feet([run.x + run.w / 2, run.y + run.h / 2]), face.points))) oversizedLabelledAreas++
      continue
    }
    if (face.points.length > 500) { output.warnings.push("A boundary exceeded 500 vertices and was excluded. Select a simpler region or trace it manually."); continue }
    const children = faces.filter((other) => other !== face && ringArea(other.points) < area && other.points.every((p) => containsPoint(p, face.points)) && !ringsCross(other.points, face.points, true))
      .filter((child, _i, all) => !all.some((other) => other !== child && ringArea(other.points) > ringArea(child.points) && child.points.every(p => containsPoint(p, other.points)) && !ringsCross(child.points, other.points, true)))
    // Small closed hardware/annotation loops are not evidence of floor voids.
    // Retain small explicitly classified columns; other tiny islands require review.
    const deductions = children.filter(child => {
      if (!input.evidence) return ringArea(child.points) >= .25
      // A closed shape is not proof of a floor opening: furniture stays in the
      // floor quantity. Preserve explicitly supported columns and fixture policy.
      return child.boundary.some(edge => edge.pathId !== undefined && (columnIds.has(edge.pathId) ||
        (input.finishPolicy !== 'include-fixtures' && fixturePathIds.has(edge.pathId)) ||
        inferredStructure.has(edge.pathId) || exteriorFloors.has(edge.pathId) ||
        pathsById.get(edge.pathId)?.layer.some(l => /(?:^|[-_ ])walls?(?:$|[-_ ])/i.test(l)))) || floorExclusions.some(r => containsPoint(feet([r.x+r.w/2,r.y+r.h/2]), child.points))
    })
    const deductionUnion = consolidateAreaDeductions(deductions.map((child) => child.points))
    const holes = deductionUnion.rings
    const labels = input.textRuns.filter((run) => roomLabelFromText(run.text) && containsPoint(feet([run.x + run.w / 2, run.y + run.h / 2]), face.points) &&
      !holes.some((hole) => containsPoint(feet([run.x + run.w / 2, run.y + run.h / 2]), hole)))
    // Broad enclosing sheet/building rings and thin wall bands are not rooms.
    const netArea = area - holes.reduce((sum, ring) => sum + ringArea(ring), 0)
    const perimeter = face.boundary.reduce((sum, e) => sum + distance(e.a, e.b), 0)
    if (netArea < 2 || netArea / perimeter < 0.5) continue
    // A closed door symbol is not a floor enclosure, even on a structure
    // layer. Virtual thresholds do not give door-only loops wall evidence.
    const drawn = face.boundary.filter(edge => edge.source === 'drawn')
    if (drawn.length && drawn.every(edge => {
      const path = edge.pathId === undefined ? undefined : pathsById.get(edge.pathId)
      return path && /(?:^|[^a-z])doors?(?:$|[^a-z])/i.test(path.layer.join(' ')) &&
        !/(?:^|[^a-z])walls?(?:$|[^a-z])/i.test(path.layer.join(' '))
    })) { unclassified++; continue }
    if (floorExclusions.some(r => {
      const p = feet([r.x + r.w / 2, r.y + r.h / 2])
      return containsPoint(p, face.points) && !holes.some(h => containsPoint(p, h))
    })) { scopeExcluded++; continue }
    if (!labels.length && children.some((child) => ringArea(child.points) >= 12)) continue
    const supportedLength = face.boundary.reduce((sum, edge) => {
      const middle: AreaPoint = [(edge.a[0] + edge.b[0]) / 2, (edge.a[1] + edge.b[1]) / 2]
      const sourcePath = edge.pathId === undefined ? undefined : pathsById.get(edge.pathId)
      const structural = edge.pathId !== undefined && (inferredStructure.has(edge.pathId) || (sourcePath && roleOf(sourcePath) === 'structure') || exteriorFloors.has(edge.pathId))
      const supported = edge.source !== "drawn" || structural || pairedEdges.some((candidate) => {
        const p = project(middle, candidate.a, candidate.b)
        return p.t >= -1e-6 && p.t <= 1 + 1e-6 && p.distance <= EPS
      })
      return sum + (supported ? distance(edge.a, edge.b) : 0)
    }, 0)
    if (hasStructuralEvidence && supportedLength / perimeter < .65) { unsupportedAreas++; continue }
    if (!labels.length && (netArea < 12 || (paired.size > 0 && supportedLength / perimeter < 0.5))) { unclassified++; continue }
    const warnings = ["Review the drawn boundary and finish-face convention before accepting."]
    if(graph.name==='assemblies')warnings.push('Floor boundary follows corroborated source assemblies. Unclassified interior linework remains unresolved; review partitions, fixtures, columns and voids before accepting.')
    if (!labels.length) warnings.push("No room label found; this may be furniture or another enclosed shape.")
    if (input.visualObservations?.length) warnings.push("Visual source-path interpretation was used. Review boundary classifications; model output is not an accuracy certificate.")
    if (face.boundary.some(e => e.pathId !== undefined && inferredStructure.has(e.pathId))) warnings.push("Wall support inferred from connected solid fills or paired stroke networks without CAD layers. Confirm that these are walls, not furniture or symbols.")
    if (labels.length > 1) warnings.push("Multiple room labels: check for a missing doorway closure or an open-plan finish zone.")
    if (face.boundary.some(e => e.pathId !== undefined && exteriorFloors.has(e.pathId))) warnings.push("Includes an explicit exterior floor outline. Confirm the finish extent, pool/void deductions, and any separate outdoor finish zones.")
    if (deductions.length < children.length) warnings.push("Small interior symbols were not deducted. Review any actual columns or floor voids.")
    if (holes.length) warnings.push("Interior shapes are proposed as deductions. Confirm columns and voids; furniture must not be deducted.")
    if (deductionUnion.consolidatedCells) warnings.push('Adjacent deduction cells share exact source edges and were consolidated without changing their deducted area. Review the original columns and voids; this does not classify their architectural role.')
    if (deductionUnion.unresolved) warnings.push('Some deduction subdivisions could not be consolidated safely. Their original cells remain; review the topology and any enclosed floor islands.')
    if (face.boundary.some((e) => e.pathId !== undefined && fixturePathIds.has(e.pathId))) warnings.push("Includes a fixture boundary. Confirm which fixture footprints should be excluded from this finish area.")
    if (face.boundary.some((e) => e.source === "doorway")) warnings.push("Door geometry supports a virtual threshold; confirm its placement.")
    if (face.boundary.some((e) => e.source === "window")) warnings.push("Window panes and returning wall ends support an inferred floor boundary; confirm the wall below the window and its finish face.")
    if (face.boundary.some((e) => e.source === "user")) warnings.push("Includes a user-defined measurement boundary.")
    const points = face.points.map(norm)
    try { validateAreaGeometry({ points, holes: holes.map(h => h.map(norm)) }) }
    catch {
      output.warnings.push("An enclosure had ambiguous intersecting deductions and was excluded. Review that area manually.")
      continue
    }
    output.proposals.push({ id: graph.name==='linework'?`area-${index}`:`area-assemblies-${index}`, label: labels.map((r) => roomLabelFromText(r.text)).join(" / ") || `Area ${output.proposals.length + 1}`,
      points, originalPoints: points.map((p) => [...p]), holes: holes.map((h) => h.map(norm)),
      boundary: face.boundary.map((e) => ({ ...e, a: norm(e.a), b: norm(e.b) })),
      areaSqft: netArea, warnings, finishPolicy: input.finishPolicy ?? "drawn", source: "vector", edited: face.boundary.some((e) => e.source === "user") })
    if (output.proposals.length === 200) { output.warnings.push("Showing the first 200 areas. Select a smaller region for complete coverage."); break }
  }
  if(output.proposals.length>=200)break
  }
  if(graphs.length>1){
    const resolved=reconcileAreaCandidates(output.proposals.map(area=>{
      let supported=0,total=0
      for(const edge of area.boundary){const length=distance(feet(edge.a),feet(edge.b)),path=edge.pathId===undefined?undefined:sourcePaths.get(edge.pathId);total+=length;if(edge.source!=='drawn'||(path&&(roleOf(path)==='structure'||inferredStructure.has(path.id)||frameIds.has(path.id)||exteriorFloors.has(path.id))))supported+=length}
      return{area,support:total?supported/total:0,interpretation:area.id,primary:!area.id.startsWith('area-assemblies-')}
    }))
    output.proposals=resolved.proposals
    output.alternativeProposals=resolved.alternatives.map(c=>c.area)
    output.boundaryConflicts=resolved.conflicts
    if(resolved.conflicts.length)output.warnings.push('Source-assembly and full-linework floor interpretations disagree. Alternatives remain available and require boundary review.')
  }
  if (oversizedLabelledAreas) output.warnings.push(`${oversizedLabelledAreas} labelled enclosures were larger than ${maxAreaSqft.toLocaleString("en-US")} SF and were excluded. Select their region to review them.`)
  if (unclassified) output.warnings.push(`${unclassified} enclosed shapes lacked enough room evidence and were not proposed. Check for missed closets and finish zones.`)
  if (scopeExcluded) output.warnings.push(`${scopeExcluded} enclosures marked as roof, open below or outside scope were excluded from floor quantities.`)
  if (unsupportedAreas) output.warnings.push(`${unsupportedAreas} enclosures lacked supported architectural boundaries and were excluded; a room label alone does not establish floor extent.`)
  if (!output.proposals.length) output.warnings.push("No closed areas found. Add a doorway boundary, narrow the region, or request an image proposal.")
  return output
}

export function proposalArea(proposal: Pick<AreaProposal, "points" | "holes">, width: number, height: number, scale: number): number {
  return (ringArea(proposal.points) - proposal.holes.reduce((sum, h) => sum + ringArea(h), 0)) * width * height * scale ** 2
}

/** Split a simple ring with a user-defined infinite line; holes require explicit editing. */
export function splitArea(proposal: AreaProposal, a: AreaPoint, b: AreaPoint): AreaProposal[] {
  if (proposal.holes.length) throw new Error("Remove or accept deductions separately before splitting this area.")
  if (distance(a, b) < 1e-6) throw new Error("Choose two different split points.")
  const clip = (sign: number): Ring => {
    const out: Ring = [], direction = sub(b, a)
    for (let i = 0; i < proposal.points.length; i++) {
      const p = proposal.points[i], q = proposal.points[(i + 1) % proposal.points.length]
      const dp = cross(direction, sub(p, a)) * sign, dq = cross(direction, sub(q, a)) * sign
      if (dp >= 0) out.push(p)
      if ((dp > 0 && dq < 0) || (dp < 0 && dq > 0)) {
        const t = dp / (dp - dq); out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])])
      }
    }
    return out.filter((p, i) => distance(p, out[(i + out.length - 1) % out.length]) > 1e-9)
  }
  const rings = [clip(1), clip(-1)]
  if (rings.some((r) => !validRing(r))) throw new Error("That split does not produce two simple areas. Choose another line.")
  return rings.map((points, i) => ({ ...proposal, id: `${proposal.id}-split-${i}`, label: `${proposal.label} ${i + 1}`, points,
    boundary: [], edited: true, source: "user", warnings: ["User-split finish zone; review the new boundary."] }))
}

/** Union only adjacent areas: shared edges disappear, disjoint areas stay separate. */
export function mergeAreas(proposals: AreaProposal[]): AreaProposal {
  if (proposals.length < 2 || proposals.some((p) => p.holes.length)) throw new Error("Select at least two adjacent areas without deductions to merge.")
  const edges = proposals.flatMap((p) => p.points.map((a, i): AreaBoundary => ({ a, b: p.points[(i + 1) % p.points.length], source: "user" })))
  // Subdivide all edges first so partially shared boundaries cancel too.
  const faces = areaFaces(edges, 1e-8)
  const counts = new Map<string, { count: number; edge: AreaBoundary }>()
  const key = (p: AreaPoint) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`
  for (const face of faces) for (const edge of face.boundary) {
    const k = [key(edge.a), key(edge.b)].sort().join("|")
    const value = counts.get(k)
    counts.set(k, { count: (value?.count ?? 0) + 1, edge })
  }
  const union = areaFaces([...counts.values()].filter((v) => v.count === 1).map((v) => v.edge), 1e-8)
  const sum = proposals.reduce((n, p) => n + ringArea(p.points), 0)
  if (union.length !== 1 || Math.abs(ringArea(union[0].points) - sum) > Math.max(1e-10, sum * 0.0001)) throw new Error("Areas must share a boundary and must not overlap.")
  return { ...proposals[0], id: proposals.map((p) => p.id).join("+"), label: proposals.map((p) => p.label).join(" / ").slice(0, 200),
    points: union[0].points, boundary: union[0].boundary, holes: [], edited: true, source: "user", warnings: ["Merged finish zone; review its perimeter."] }
}
