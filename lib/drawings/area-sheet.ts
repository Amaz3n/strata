import { AREA_ENGINE_VERSION, areasOverlap, containsPoint, detectAreas, prepareAreaInterpretation, type AreaDetection, type AreaInput, type AreaProposal, type AreaRegion } from './area-takeoff'
import { areaRoomLabel, areaTextRuns } from './area-labels'
import { detectLocalScaleDisagreement, extractDimensionTokens } from './scale'
import { evidencePathBounds, type AreaPoint } from './area-evidence'
import { areaPathRole } from './area-paths'
import { assessAreaCoverage } from './area-coverage'
import { areaViewExclusions, textOutsideAreaExclusions } from './area-context'
import { reconcileAreaCandidates, type AreaCandidate } from './area-candidates'
import { assessAreaBoundary, attachAreaArchitecture } from './area-architecture'
import { interpretArchitecturalElements } from './area-semantics'
import { authoritativeDimensionText } from './raster-text'

/** Prefer a CAD wall envelope, then overlapping physical-size windows around
 * room labels. Search boundaries never become walls. Only complete faces are
 * returned and globally deduplicated; missing coverage is explicitly reported. */
export function detectSheetAreas(input: Omit<AreaInput, 'region'>): AreaDetection {
  const exclusions = areaViewExclusions(input.evidence, input.textRuns)
  input = { ...input, textRuns: areaTextRuns(textOutsideAreaExclusions(input.textRuns, exclusions)) }
  // Classify once per sheet; preserve all clips needed by retained paths.
  // The stored original evidence is never changed by this working selection.
  const interpretation = prepareAreaInterpretation(input)
  const exteriorFloors = interpretation.exteriorFloors!
  const elements = interpretArchitecturalElements(input.evidence, input.visualObservations, {sx:input.imageWidth*input.feetPerImagePx,sy:input.imageHeight*input.feetPerImagePx})
  const candidates: AreaCandidate[] = []
  const primaryPreview: AreaProposal[] = []
  const evidence = input.evidence ? { ...input.evidence, paths: input.evidence.paths.filter(p => p.kind === 'clip' || areaPathRole(p) !== 'decoration' || interpretation.wallMaterials?.has(p.id) || exteriorFloors.has(p.id)) } : input.evidence
  input = { ...input, evidence, textRuns: areaTextRuns(input.textRuns) }
  const sx = input.imageWidth * input.feetPerImagePx, sy = input.imageHeight * input.feetPerImagePx
  if (!(sx > 0 && sy > 0 && Number.isFinite(sx + sy))) throw new Error('Calibrate the drawing before detecting areas.')
  const inferredStructure = interpretation.inferredStructure!
  const boundarySupport=new Set([...inferredStructure,...(interpretation.leafDoors?.doors.flatMap(d=>d.framePathIds)??[])])
  const structural: AreaPoint[] = []
  const interpretedStructure = new Set(elements.filter(e => ["wall", "window", "column"].includes(e.kind) && !e.conflict).map(e => e.pathId))
  const interpretedWalls = new Set(elements.filter(e => e.kind === "wall" && !e.conflict).map(e => e.pathId))
  for (const path of input.evidence?.paths ?? []) {
    if (!(path.kind !== 'clip' && path.layer.some(l => /(?:^|[-_ ])wall(?:$|[-_ ])/i.test(l))) && !inferredStructure.has(path.id) && !interpretedWalls.has(path.id)) continue
    let previous: AreaPoint | null = null
    for (const c of path.commands) {
      if (c[0] === 'L' || c[0] === 'M') {
        const point: AreaPoint = [c[1], c[2]]
        if (c[0] === 'L' && previous && Math.hypot((point[0] - previous[0]) * sx, (point[1] - previous[1]) * sy) >= 1) structural.push(previous, point)
        previous = point
      } else previous = null
    }
  }
  const bounds = (structural.length > 20 || inferredStructure.size >= 3 || (structural.length >= 6 && interpretedWalls.size >= 2)) ? structural.reduce((b, p) => ({ x0: Math.min(b.x0, p[0]), y0: Math.min(b.y0, p[1]), x1: Math.max(b.x1, p[0]), y1: Math.max(b.y1, p[1]) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }) : null
  // A partial CAD envelope is not evidence that a room outside it is absent.
  const eligibleText = input.textRuns
  const seeds = eligibleText.filter(t => areaRoomLabel(t.text)).map(t => ({ x: t.x + t.w / 2, y: t.y + t.h / 2, label: areaRoomLabel(t.text)! }))
  const output: AreaDetection = { engine: AREA_ENGINE_VERSION, proposals: [], warnings: [], segmentCount: 0 }
  if (exclusions.length) output.warnings.push(`Excluded ${exclusions.length} source-framed annotation or unscaled view regions. Check that all intended plan views remain included.`)
  output.coverage = assessAreaCoverage(eligibleText, [])
  if (!seeds.length && !bounds) {
    output.warnings.push('No positioned room labels found. Choose a plan region for vector detection, or an image proposal for a scan.')
    return attachAreaArchitecture(output, input,[],undefined,interpretation)
  }
  const tokens = input.textRuns.filter(t => authoritativeDimensionText(t) && !/[a-z]/i.test(t.text)).flatMap(t => extractDimensionTokens(t.text, { x0: t.x * input.imageWidth, y0: t.y * input.imageHeight, x1: (t.x + t.w) * input.imageWidth, y1: (t.y + t.h) * input.imageHeight }))
  const seen = new Set<string>(), failures = new Set<string>()
  const pathsById = new Map(input.evidence?.paths.map(path => [path.id, path]) ?? [])
  const indexedPaths = input.evidence?.paths.map(path => ({ path, bounds: evidencePathBounds(path) }))
  let attempts = 0, completedScans = 0
  const covers = (p: AreaProposal, x: number, y: number) => containsPoint([x, y], p.points) && !p.holes.some(h => containsPoint([x, y], h))
  const scan = (region: AreaRegion) => {
    const key = JSON.stringify(region)
    if (seen.has(key)) return
    if (attempts >= 60) { failures.add('Whole-sheet search reached its processing limit. Choose a region around any missed rooms.'); return }
    seen.add(key); attempts++
    if (detectLocalScaleDisagreement({ tokens, sheetFeetPerUnit: input.feetPerImagePx, region: { x0: region.x0 * input.imageWidth, y0: region.y0 * input.imageHeight, x1: region.x1 * input.imageWidth, y1: region.y1 * input.imageHeight } })) {
      failures.add('Some plan regions disagree with the calibrated scale and were excluded. Calibrate and detect those regions separately.')
      return
    }
    try {
      // Reuse source bounds across overlapping windows. Keep complete paths
      // (not clipped replacements) and every clip record; topology, fill rules,
      // and curve fitting remain the detector's responsibility.
      const localEvidence = input.evidence && indexedPaths ? { ...input.evidence, paths: indexedPaths.filter(({ path, bounds: b }) =>
        path.kind === 'clip' || !b || (b.x1 >= region.x0 && b.x0 <= region.x1 && b.y1 >= region.y0 && b.y0 <= region.y1)).map(({ path }) => path) } : input.evidence
      const result = detectAreas({ ...input, evidence: localEvidence, region }, {
        ...interpretation,
        // Global geometric inference is not yet qualified across mixed drawing
        // conventions. Retain local inference: passing the global candidate set
        // reduced measured corpus coverage. CAD roles/leaders remain shared.
        inferredStructure: undefined,
      })
      completedScans++
      const openingKeys=new Set((output.openingEvidence??[]).map(e=>[e.a,e.b].map(p=>p.map(v=>v.toFixed(7)).join(",")).sort().join("|")))
      for(const edge of result.openingEvidence??[]){const key=[edge.a,edge.b].map(p=>p.map(v=>v.toFixed(7)).join(",")).sort().join("|");if(!openingKeys.has(key)){(output.openingEvidence??=[]).push(edge);openingKeys.add(key)}}
      output.segmentCount = Math.max(output.segmentCount, result.segmentCount)
      for (const area of [...result.proposals,...(result.alternativeProposals??[])]) {
        if (exclusions.some(({bounds:b}) => area.points.every(p=>p[0]>=b.x0-1e-6&&p[0]<=b.x1+1e-6&&p[1]>=b.y0-1e-6&&p[1]<=b.y1+1e-6))) continue
        // Region mode offers unlabelled enclosures. Whole-sheet mode must not
        // offer title blocks, furniture or schedules simply because they close.
        if (!seeds.some(s => covers(area, s.x, s.y))) {
          // With explicit CAD structure, a missing tag must not hide a room.
          // Require a substantial enclosure predominantly bounded by structure.
          let structuralLength = 0, perimeter = 0
          for (const edge of area.boundary) {
            const length = Math.hypot((edge.b[0] - edge.a[0]) * sx, (edge.b[1] - edge.a[1]) * sy)
            perimeter += length
            const path = edge.pathId === undefined ? undefined : pathsById.get(edge.pathId)
            if (edge.source !== 'drawn' || (path && (areaPathRole(path) === 'structure' || inferredStructure.has(path.id) || interpretedStructure.has(path.id)))) structuralLength += length
          }
          if (!bounds || area.areaSqft < 12 || !perimeter || structuralLength / perimeter < .8) continue
        }
        const assessment = assessAreaBoundary(area, input, elements,boundarySupport)
        // Retain all distinct interpretations until the sheet search completes.
        // Unknown support remains reviewable, never promoted by room labels.
        // The existing nonoverlapping preview is a fallback. A new counter-scan
        // may replace it with stronger evidence, not merely a larger/smaller
        // polygon or crop. Keep tied alternatives as explicit conflicts.
        const primary = !primaryPreview.some(existing => areasOverlap(existing, area))
        if (primary) primaryPreview.push(area)
        candidates.push({ area, support: Math.max(.1, assessment.supportedFraction+(assessment.inferredFraction??0)), interpretation: key, primary })

      }
      for (const warning of result.warnings) if (/truncat|clip|masking|fixture footprints|intersecting deductions|first 200|500 vertices|too complex to trace|larger than [0-9,]+ SF|excluded from floor quantities|lacked supported architectural boundaries|annotation leaders/i.test(warning)) failures.add(warning.replace(/^\d+ enclosures lacked supported architectural boundaries and were excluded/, "Enclosures without supported architectural boundaries were excluded"))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Detection failed'
      // Dense windows are expected during a whole-sheet search; report them
      // once rather than per window, but never drop them without a trace.
      failures.add(/24,000|Too much linework/.test(message) ? 'Some search windows had too much linework to trace, so rooms there may be missing. Select a smaller region around them.' : message)
    }
  }
  if (bounds) scan({ x0: Math.max(0, bounds.x0 - 1 / sx), y0: Math.max(0, bounds.y0 - 1 / sy), x1: Math.min(1, bounds.x1 + 1 / sx), y1: Math.min(1, bounds.y1 + 1 / sy) })
  const fullEnvelopeCompleted = completedScans > 0 && candidates.length > 0
  const reconsidered = new Set<number>()
  for (const radius of [16, 26, 42]) {
    for (const [seedIndex, seed] of seeds.entries()) {
      const covering = candidates.filter(c => covers(c.area, seed.x, seed.y))
      if (covering.some(c => c.support >= .98 && seeds.filter(s => covers(c.area, s.x, s.y)).length === 1)) continue
      // Shared/uncertain enclosures get a local counter-interpretation. Repeating
      // larger windows over the same covered label is not independent evidence.
      // Uncovered labels still receive all three search scales.
      if (covering.length && reconsidered.has(seedIndex)) continue
      if (covering.length) reconsidered.add(seedIndex)
      scan({ x0: Math.max(0, seed.x - radius / sx), y0: Math.max(0, seed.y - radius / sy), x1: Math.min(1, seed.x + radius / sx), y1: Math.min(1, seed.y + radius / sy) })
      if (attempts >= 60) break
    }
  }
  if (!fullEnvelopeCompleted && bounds) {
    // Dense dimensioned plans may omit tags entirely. Overlapping structural
    // windows retain the same complete-face requirement as label searches.
    for (let x = bounds.x0; x < bounds.x1 && attempts < 60; x += 26 / sx) {
      for (let y = bounds.y0; y < bounds.y1 && attempts < 60; y += 26 / sy) {
        const cx = Math.min(x + 13 / sx, bounds.x1), cy = Math.min(y + 13 / sy, bounds.y1)
        for (const radius of [26, 42]) scan({ x0: Math.max(0, cx - radius / sx), y0: Math.max(0, cy - radius / sy), x1: Math.min(1, cx + radius / sx), y1: Math.min(1, cy + radius / sy) })
      }
    }
  }
  if (attempts >= 60) failures.add('Whole-sheet search reached its processing limit. Choose a region around any missed rooms.')
  const reconciled = reconcileAreaCandidates(candidates)
  output.proposals = reconciled.proposals
  output.alternativeProposals=reconciled.alternatives.map(c=>c.area)
  output.boundaryConflicts=reconciled.conflicts
  if (reconciled.conflicts.length) failures.add('Competing boundary interpretations remain. Inspect highlighted areas before accepting quantities.')
  const missed = seeds.filter(s => !output.proposals.some(p => covers(p, s.x, s.y)))
  if (missed.length) output.warnings.push(`No complete area found for ${missed.length} room labels: ${[...new Set(missed.map(s => s.label))].slice(0, 12).join(', ')}. Review these locations or choose a smaller region.`)
  if (output.proposals.some(p => p.warnings.some(w => w.startsWith('No room label')))) output.warnings.push('Unlabeled enclosures supported by CAD structure are included. Confirm these are floor areas; room-label coverage cannot check them.')
  output.coverage = assessAreaCoverage(eligibleText, output.proposals)
  output.warnings.push(...failures)
  if (!output.proposals.length) output.warnings.push('No complete rooms detected. Select a plan region or use an image proposal; no quantities were created.')
  return attachAreaArchitecture(output, input, reconciled.conflicts,undefined,interpretation)
}
