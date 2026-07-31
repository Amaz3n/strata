/**
 * Vector-quality analysis for the Phase-4 takeoff spike.
 *
 * The question this answers: on real customer PDFs, is the vector content good
 * enough to snap and flood-fill against (verdict A), too noisy to trust
 * (verdict B — vision-assisted), or a mix (verdict C)?
 *
 * Everything here is pure aggregation over already-extracted segments; the
 * MuPDF walk that produces them lives in the harness so this stays testable
 * and free of WASM.
 */

export interface Segment {
  x0: number
  y0: number
  x1: number
  y1: number
  /** Stroke width in page units; 0 for filled paths. */
  width: number
  /** True when the segment came from a fill rather than a stroke. */
  filled: boolean
  /** True when short, regularly spaced strokes formed a dash chain. */
  dashed: boolean
}

export interface VectorStats {
  segmentCount: number
  /** Segments within a degree of horizontal or vertical. */
  axisAlignedPct: number
  /** Segments shorter than NOISE_LENGTH — hatching, arrowheads, text outlines. */
  shortSegmentPct: number
  /** Median segment length in page units. */
  medianLength: number
  /**
   * Endpoints shared (within SNAP_TOLERANCE) by two or more segments, as a
   * percentage of all endpoints. High connectivity is what makes room
   * detection by loop-tracing possible.
   */
  connectedEndpointPct: number
  /** Closed loops found by walking the connectivity graph. */
  closedLoopCount: number
  /** Closed loops big enough to plausibly be a room. */
  roomSizedLoopCount: number
  /**
   * Repeated identical sub-paths — doors, windows, fixtures. The signal that
   * count-by-symbol can work geometrically instead of visually.
   */
  repeatedShapeGroups: number
  largestRepeatGroup: number
}

/** Below this (page units, ~1/72") a segment is detail, not structure. */
const NOISE_LENGTH = 3

// ---------------------------------------------------------------------------
// Collinear chain-merging
// ---------------------------------------------------------------------------

/** Endpoints within this (page units) are the same point for chain-merging. */
const CHAIN_ENDPOINT_QUANT = 0.35
/** Continuations within this angle of the chain's base direction extend it. */
const CHAIN_ANGLE_COS = Math.cos((5 * Math.PI) / 180)
/** Max perpendicular drift (page units) of a chain from its base line. */
const CHAIN_MAX_DEVIATION = 0.6
/** Individual strokes this short may be part of a drafted dash pattern. */
const DASH_MAX_SEGMENT_LENGTH = 4
/** Gaps above this are too large to be one dash pattern. */
const DASH_MAX_GAP = 6
/** Three strokes are the minimum evidence of a deliberate dash pattern. */
const DASH_MIN_SEGMENTS = 3
/** Same angular tolerance used by solid collinear-chain merging. */
const DASH_ANGLE_BUCKET_RAD = (5 * Math.PI) / 180

/**
 * Collapse regular short-stroke dash runs into one attributed segment.
 *
 * The collapsed geometry keeps snapping and the full-graph fallback useful,
 * while `dashed` lets the wall graph exclude ceiling outlines, centre lines,
 * and similar non-wall drafting. Grouping is bucketed by angle and line offset
 * so the pass stays near O(n log n) on six-figure CAD exports.
 */
export function collapseDashChains(segments: Segment[]): Segment[] {
  if (segments.length === 0) return []

  type Candidate = {
    index: number
    ux: number
    uy: number
    start: number
    end: number
    x0: number
    y0: number
    x1: number
    y1: number
  }

  const groups = new Map<string, Candidate[]>()
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]
    const dx = segment.x1 - segment.x0
    const dy = segment.y1 - segment.y0
    const length = Math.hypot(dx, dy)
    if (!(length > 0) || length > DASH_MAX_SEGMENT_LENGTH) continue

    let ux = dx / length
    let uy = dy / length
    // Direction-agnostic: normalize every line to the same half-plane.
    if (ux < 0 || (Math.abs(ux) < 1e-9 && uy < 0)) {
      ux = -ux
      uy = -uy
    }
    const nx = -uy
    const ny = ux
    const angle = Math.atan2(uy, ux)
    const angleBucket = Math.round(angle / DASH_ANGLE_BUCKET_RAD)
    const offset = ((segment.x0 + segment.x1) / 2) * nx + ((segment.y0 + segment.y1) / 2) * ny
    const offsetBucket = Math.round(offset / CHAIN_MAX_DEVIATION)
    const startProjection = Math.min(
      segment.x0 * ux + segment.y0 * uy,
      segment.x1 * ux + segment.y1 * uy,
    )
    const endProjection = Math.max(
      segment.x0 * ux + segment.y0 * uy,
      segment.x1 * ux + segment.y1 * uy,
    )
    const key = `${angleBucket}:${offsetBucket}`
    const candidate = {
      index,
      ux,
      uy,
      start: startProjection,
      end: endProjection,
      x0: segment.x0,
      y0: segment.y0,
      x1: segment.x1,
      y1: segment.y1,
    }
    const group = groups.get(key)
    if (group) group.push(candidate)
    else groups.set(key, [candidate])
  }

  const replacement = new Map<number, Segment>()
  const consumed = new Uint8Array(segments.length)

  for (const group of groups.values()) {
    if (group.length < DASH_MIN_SEGMENTS) continue
    group.sort((a, b) => a.start - b.start)

    let cursor = 0
    while (cursor <= group.length - DASH_MIN_SEGMENTS) {
      let end = cursor + 1
      const gaps: number[] = []
      while (end < group.length) {
        const previous = group[end - 1]
        const current = group[end]
        const gap = current.start - previous.end
        if (gap <= 0 || gap > DASH_MAX_GAP) break
        gaps.push(gap)
        end++
      }

      const run = group.slice(cursor, end)
      const minGap = gaps.length > 0 ? Math.min(...gaps) : Infinity
      const maxGap = gaps.length > 0 ? Math.max(...gaps) : Infinity
      const regular =
        run.length >= DASH_MIN_SEGMENTS &&
        Number.isFinite(minGap) &&
        minGap > 0 &&
        maxGap <= minGap * 2

      if (!regular) {
        cursor++
        continue
      }

      const base = run[0]
      const baseSegment = segments[base.index]
      const start = run.reduce((best, item) => (item.start < best.start ? item : best), run[0])
      const finish = run.reduce((best, item) => (item.end > best.end ? item : best), run[0])
      const pointAtProjection = (candidate: Candidate, projection: number) => {
        const aProjection = candidate.x0 * base.ux + candidate.y0 * base.uy
        const bProjection = candidate.x1 * base.ux + candidate.y1 * base.uy
        return Math.abs(aProjection - projection) <= Math.abs(bProjection - projection)
          ? { x: candidate.x0, y: candidate.y0 }
          : { x: candidate.x1, y: candidate.y1 }
      }
      const firstPoint = pointAtProjection(start, start.start)
      const lastPoint = pointAtProjection(finish, finish.end)

      replacement.set(base.index, {
        x0: firstPoint.x,
        y0: firstPoint.y,
        x1: lastPoint.x,
        y1: lastPoint.y,
        width: baseSegment.width,
        filled: baseSegment.filled,
        dashed: true,
      })
      for (const item of run) consumed[item.index] = 1
      cursor = end
    }
  }

  const collapsed: Segment[] = []
  for (let index = 0; index < segments.length; index++) {
    const dash = replacement.get(index)
    if (dash) {
      collapsed.push(dash)
      continue
    }
    if (consumed[index]) continue
    collapsed.push({ ...segments[index], dashed: segments[index].dashed ?? false })
  }
  return collapsed
}

/**
 * Merge runs of end-to-end collinear segments into single long segments.
 *
 * Some CAD exporters shred every wall line into sub-point fragments (observed
 * in the field: a partition wall emitted as tens of thousands of <1pt pieces,
 * which the noise filter then deleted — so manual takeoff snapping missed
 * straight through a wall the raster plainly showed). Merging BEFORE the noise
 * filter recovers that structure, while true hatching stays filterable: hatch
 * strokes are short parallel lines that do not connect end-to-end, so they
 * never chain.
 *
 * Greedy and deliberately strict: a chain only extends through continuations
 * within ~5° of the chain's base direction that keep every endpoint within
 * CHAIN_MAX_DEVIATION of the base line — corners, arcs, and T-junctions
 * terminate a chain rather than bend it.
 */
export function mergeCollinearChains(segments: Segment[]): Segment[] {
  if (segments.length === 0) return []

  const quantKey = (x: number, y: number) =>
    `${Math.round(x / CHAIN_ENDPOINT_QUANT)},${Math.round(y / CHAIN_ENDPOINT_QUANT)}`

  const byEndpoint = new Map<string, number[]>()
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    for (const key of [quantKey(segment.x0, segment.y0), quantKey(segment.x1, segment.y1)]) {
      let list = byEndpoint.get(key)
      if (!list) byEndpoint.set(key, (list = []))
      list.push(i)
    }
  }

  const direction = (segment: Segment): [number, number] => {
    const dx = segment.x1 - segment.x0
    const dy = segment.y1 - segment.y0
    const length = Math.hypot(dx, dy) || 1
    return [dx / length, dy / length]
  }

  const used = new Uint8Array(segments.length)
  const merged: Segment[] = []

  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue
    used[i] = 1
    const base = segments[i]
    const [ux, uy] = direction(base)

    let head = { x: base.x1, y: base.y1 }
    let tail = { x: base.x0, y: base.y0 }

    const extend = (start: { x: number; y: number }, forward: boolean) => {
      let point = start
      for (;;) {
        const candidates = byEndpoint.get(quantKey(point.x, point.y)) ?? []
        let nextIndex = -1
        let nextFar: { x: number; y: number } | null = null
        for (const j of candidates) {
          if (used[j]) continue
          const candidate = segments[j]
          if (
            (candidate.dashed ?? false) !== (base.dashed ?? false) ||
            candidate.filled !== base.filled ||
            Math.abs(candidate.width - base.width) > 0.1
          ) {
            continue
          }
          const [vx, vy] = direction(candidate)
          if (Math.abs(vx * ux + vy * uy) < CHAIN_ANGLE_COS) continue

          const touchesStart =
            Math.abs(candidate.x0 - point.x) <= CHAIN_ENDPOINT_QUANT &&
            Math.abs(candidate.y0 - point.y) <= CHAIN_ENDPOINT_QUANT
          const touchesEnd =
            Math.abs(candidate.x1 - point.x) <= CHAIN_ENDPOINT_QUANT &&
            Math.abs(candidate.y1 - point.y) <= CHAIN_ENDPOINT_QUANT
          if (!touchesStart && !touchesEnd) continue

          const far = touchesStart
            ? { x: candidate.x1, y: candidate.y1 }
            : { x: candidate.x0, y: candidate.y0 }
          const dx = far.x - tail.x
          const dy = far.y - tail.y
          const perpendicular = Math.abs(dx * -uy + dy * ux)
          if (perpendicular > CHAIN_MAX_DEVIATION) continue

          const along = dx * ux + dy * uy
          const headAlong = (head.x - tail.x) * ux + (head.y - tail.y) * uy
          if (forward && along <= headAlong) continue
          if (!forward && along >= 0) continue

          nextIndex = j
          nextFar = far
          break
        }
        if (nextIndex === -1 || !nextFar) break
        used[nextIndex] = 1
        point = nextFar
        if (forward) head = nextFar
        else tail = nextFar
      }
    }

    extend(head, true)
    extend(tail, false)
    merged.push({
      x0: tail.x,
      y0: tail.y,
      x1: head.x,
      y1: head.y,
      width: base.width,
      filled: base.filled,
      dashed: base.dashed ?? false,
    })
  }

  return merged
}
/** Endpoints this close are treated as the same vertex. */
const SNAP_TOLERANCE = 0.75
/** A loop smaller than this is a symbol, not a room (page units squared). */
const ROOM_MIN_AREA = 400

export function analyzeSegments(segments: Segment[]): VectorStats {
  if (segments.length === 0) {
    return {
      segmentCount: 0,
      axisAlignedPct: 0,
      shortSegmentPct: 0,
      medianLength: 0,
      connectedEndpointPct: 0,
      closedLoopCount: 0,
      roomSizedLoopCount: 0,
      repeatedShapeGroups: 0,
      largestRepeatGroup: 0,
    }
  }

  const lengths = segments.map((s) => Math.hypot(s.x1 - s.x0, s.y1 - s.y0))
  const sortedLengths = [...lengths].sort((a, b) => a - b)

  let axisAligned = 0
  let short = 0
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    const dx = Math.abs(segment.x1 - segment.x0)
    const dy = Math.abs(segment.y1 - segment.y0)
    // ~1 degree off either axis.
    if (dx < 0.018 * dy || dy < 0.018 * dx) axisAligned += 1
    if (lengths[i] < NOISE_LENGTH) short += 1
  }

  const structural = segments.filter((_, i) => lengths[i] >= NOISE_LENGTH)
  const connectivity = buildConnectivity(structural)

  const repeats = findRepeatedShapes(segments)

  return {
    segmentCount: segments.length,
    axisAlignedPct: round1((axisAligned / segments.length) * 100),
    shortSegmentPct: round1((short / segments.length) * 100),
    medianLength: round1(sortedLengths[Math.floor(sortedLengths.length / 2)]),
    connectedEndpointPct: connectivity.connectedPct,
    closedLoopCount: connectivity.loops.length,
    roomSizedLoopCount: connectivity.loops.filter((loop) => loop.area >= ROOM_MIN_AREA).length,
    repeatedShapeGroups: repeats.groups,
    largestRepeatGroup: repeats.largest,
  }
}

interface Connectivity {
  connectedPct: number
  loops: Array<{ area: number; vertexCount: number }>
}

/**
 * Build a vertex graph from segment endpoints and look for closed loops.
 *
 * The loop finder is deliberately cheap: it walks each unvisited degree-2
 * chain to its end and reports a loop when it returns to its start. Rooms in
 * an architectural plan are exactly that shape. Anything requiring real
 * planar-graph face extraction is beyond a spike.
 */
function buildConnectivity(segments: Segment[]): Connectivity {
  if (segments.length === 0) return { connectedPct: 0, loops: [] }

  const key = (x: number, y: number) =>
    `${Math.round(x / SNAP_TOLERANCE)}:${Math.round(y / SNAP_TOLERANCE)}`

  const vertices = new Map<string, { x: number; y: number; edges: number[] }>()
  const touch = (x: number, y: number, edgeIndex: number) => {
    const id = key(x, y)
    const existing = vertices.get(id)
    if (existing) existing.edges.push(edgeIndex)
    else vertices.set(id, { x, y, edges: [edgeIndex] })
    return id
  }

  const edges = segments.map((segment, index) => ({
    a: touch(segment.x0, segment.y0, index),
    b: touch(segment.x1, segment.y1, index),
  }))

  let connectedEndpoints = 0
  for (const vertex of vertices.values()) {
    if (vertex.edges.length >= 2) connectedEndpoints += vertex.edges.length
  }
  const totalEndpoints = segments.length * 2

  const visitedEdges = new Set<number>()
  const loops: Array<{ area: number; vertexCount: number }> = []

  for (let start = 0; start < edges.length; start++) {
    if (visitedEdges.has(start)) continue

    const path: Array<{ x: number; y: number }> = []
    let currentEdge = start
    let currentVertexId = edges[start].a
    const startVertexId = currentVertexId
    let guard = 0

    while (guard++ < 512) {
      visitedEdges.add(currentEdge)
      const edge = edges[currentEdge]
      const nextVertexId = edge.a === currentVertexId ? edge.b : edge.a
      const nextVertex = vertices.get(nextVertexId)
      if (!nextVertex) break
      path.push({ x: nextVertex.x, y: nextVertex.y })

      if (nextVertexId === startVertexId && path.length >= 3) {
        loops.push({ area: shoelace(path), vertexCount: path.length })
        break
      }

      // Only follow unambiguous continuations: a junction means this is a wall
      // network, not a traceable ring, and guessing a branch invents rooms.
      const candidates = nextVertex.edges.filter((index) => !visitedEdges.has(index))
      if (candidates.length !== 1) break

      currentEdge = candidates[0]
      currentVertexId = nextVertexId
    }
  }

  return {
    connectedPct: totalEndpoints === 0 ? 0 : round1((connectedEndpoints / totalEndpoints) * 100),
    loops,
  }
}

function shoelace(points: Array<{ x: number; y: number }>): number {
  let twice = 0
  for (let i = 0; i < points.length; i++) {
    const current = points[i]
    const next = points[(i + 1) % points.length]
    twice += current.x * next.y - next.x * current.y
  }
  return Math.abs(twice) / 2
}

/**
 * Count repeated geometry by shape signature (translation-invariant). A door
 * block placed forty times produces forty identical signatures, which is what
 * makes "find every one of these" a geometric operation rather than a visual
 * one.
 */
function findRepeatedShapes(segments: Segment[]): { groups: number; largest: number } {
  const signatures = new Map<string, number>()

  for (const segment of segments) {
    const dx = round1(segment.x1 - segment.x0)
    const dy = round1(segment.y1 - segment.y0)
    // Direction-agnostic so a symbol drawn either way round still matches.
    const signature = `${Math.abs(dx)}:${Math.abs(dy)}:${round1(segment.width)}`
    signatures.set(signature, (signatures.get(signature) ?? 0) + 1)
  }

  let groups = 0
  let largest = 0
  for (const count of signatures.values()) {
    // Three or more identical segments is a pattern, not a coincidence.
    if (count >= 3) {
      groups += 1
      if (count > largest) largest = count
    }
  }
  return { groups, largest }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * Turn the numbers into the A/B/C recommendation the gameplan asks for. The
 * human signs off on the verdict; this only says what the evidence supports.
 */
export function recommendVerdict(stats: VectorStats): {
  verdict: "A" | "B" | "C"
  reason: string
} {
  if (stats.segmentCount < 200) {
    return {
      verdict: "B",
      reason:
        "Almost no vector content — this reads as a scanned or rasterized sheet, so geometry is not available to snap to.",
    }
  }

  const cleanEnough = stats.shortSegmentPct < 55 && stats.connectedEndpointPct >= 55
  const roomsTraceable = stats.roomSizedLoopCount >= 3

  if (cleanEnough && roomsTraceable) {
    return {
      verdict: "A",
      reason: `Linework is connected (${stats.connectedEndpointPct}% of endpoints shared) and ${stats.roomSizedLoopCount} room-sized closed loops trace cleanly — geometric snapping and flood-fill are viable.`,
    }
  }

  if (!cleanEnough && !roomsTraceable) {
    return {
      verdict: "B",
      reason: `Linework is fragmented (${stats.shortSegmentPct}% of segments are sub-noise, ${stats.connectedEndpointPct}% endpoint connectivity) and no room-sized loops close — geometry cannot carry the tracing on its own.`,
    }
  }

  return {
    verdict: "C",
    reason: `Mixed: ${stats.connectedEndpointPct}% endpoint connectivity and ${stats.roomSizedLoopCount} traceable loops, but ${stats.shortSegmentPct}% noise. Snap to geometry where it closes, fall back to the vision path where it does not.`,
  }
}
