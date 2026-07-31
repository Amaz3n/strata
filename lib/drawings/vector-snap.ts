/**
 * Geometric snapping over extracted PDF vectors.
 *
 * The drawings pipeline extracts a sheet version's PDF line segments at ingest
 * and stores them as `vectors.bin` next to the tiles (see the format contract
 * in `parseVectorsBin`). This module turns that flat segment list into a
 * spatial index the takeoff tools query per click:
 *
 *   - `snapPoint` — pull a clicked point onto real linework
 *
 * Coordinate contract: segments arrive NORMALIZED 0..1 (the same space
 * `drawing_markups.data.points` uses — see lib/drawings/measure.ts), y-down.
 * The index converts to rendered-image pixels once at build; every query and
 * every result is in image pixels. Call sites own the norm↔px conversion.
 *
 * Everything returns null on bad or insufficient data — null always means
 * "fall back to today's behavior" (raw clicks, or the vision-assist path).
 *
 * Client-safe and pure: no imports, no DOM, unit-tested in
 * tests/takeoff-snap.test.js.
 */

export interface ImageSize {
  width: number
  height: number
}

export interface PxPoint {
  x: number
  y: number
}

// ---------------------------------------------------------------------------
// vectors.bin parsing
// ---------------------------------------------------------------------------

const MAGIC = [0x41, 0x52, 0x43, 0x56] // "ARCV"
const HEADER_BYTES = 12
const BYTES_PER_SEGMENT = 16 // 4 × float32
const ATTR_BYTES_PER_SEGMENT = 2
const FLAG_DASHED = 1

export interface ParsedVectors {
  segments: Float32Array
  /** v1 has no attributes; v2 exposes one flag byte per segment. */
  flags: Uint8Array | null
  /** v1 has no attributes; v2 exposes width in tenths of a page unit. */
  widths: Uint8Array | null
}

/**
 * Parse a `vectors.bin` payload.
 *
 * Little-endian. Both versions begin with 4 bytes ASCII "ARCV", uint16
 * version, uint16 reserved, uint32 segmentCount. v1 then stores only the
 * coordinate block. v2 appends an attribute block of `(flags, width)` bytes.
 *
 * Returns the flat `[x0, y0, x1, y1, ...]` array, or null when the magic,
 * version, or byte length disagree — a truncated download must never produce
 * a half-parsed index.
 */
export function parseVectorsBin(buffer: ArrayBuffer): ParsedVectors | null {
  if (buffer.byteLength < HEADER_BYTES) return null
  const view = new DataView(buffer)
  for (let i = 0; i < MAGIC.length; i++) {
    if (view.getUint8(i) !== MAGIC[i]) return null
  }
  const version = view.getUint16(4, true)
  if (version !== 1 && version !== 2) return null
  const segmentCount = view.getUint32(8, true)
  const coordinateBytes = segmentCount * BYTES_PER_SEGMENT
  const expectedBytes =
    HEADER_BYTES + coordinateBytes + (version === 2 ? segmentCount * ATTR_BYTES_PER_SEGMENT : 0)
  if (buffer.byteLength !== expectedBytes) return null
  if (segmentCount === 0) {
    return {
      segments: new Float32Array(0),
      flags: version === 2 ? new Uint8Array(0) : null,
      widths: version === 2 ? new Uint8Array(0) : null,
    }
  }
  // HEADER_BYTES is 4-byte aligned, so a view straight over the body is safe.
  const segments = new Float32Array(buffer, HEADER_BYTES, segmentCount * 4)
  if (version === 1) return { segments, flags: null, widths: null }

  const attrs = new Uint8Array(buffer, HEADER_BYTES + coordinateBytes, segmentCount * 2)
  const flags = new Uint8Array(segmentCount)
  const widths = new Uint8Array(segmentCount)
  for (let i = 0; i < segmentCount; i++) {
    flags[i] = attrs[i * 2]
    widths[i] = attrs[i * 2 + 1]
  }
  return { segments, flags, widths }
}

// ---------------------------------------------------------------------------
// Spatial index
// ---------------------------------------------------------------------------

/** Grid cell edge in image pixels. Sized so a wall spans a handful of cells. */
const CELL_SIZE = 64

/**
 * Endpoints this close (image px) are the same vertex. The extraction renders
 * at ~150 DPI, so this is the 0.75pt tolerance the vector spike validated,
 * scaled to image pixels (0.75/72 × 150 ≈ 1.5).
 */
const MERGE_TOLERANCE_PX = 1.5

/**
 * A closed loop below this area (image px²) is a symbol, not a room. Mirrors
 * ROOM_MIN_AREA=400 page-units² in lib/drawings/vector-analysis.ts at 150 DPI
 * (400 × (150/72)² ≈ 1736).
 */
const ROOM_MIN_AREA_PX = 1736

/**
 * Connectivity summary computed once at index build, mirroring the ingest-time
 * `vector_stats` fields the routing boundary in docs/takeoff-vector-spike.md §5
 * is written against. Computed here from the (already noise-filtered) segments
 * so routing works even before the client has a path to the stored stats.
 */
export interface VectorIndexStats {
  /** Endpoints shared by 2+ segments, as a percentage of all endpoints. */
  connectedEndpointPct: number
  /** Closed loops big enough to plausibly be a room. */
  roomSizedLoopCount: number
}

export interface VectorIndex {
  imageSize: ImageSize
  /** Flat [x0, y0, x1, y1, ...] in image pixels. */
  segments: Float32Array
  flags: Uint8Array | null
  widths: Uint8Array | null
  segmentCount: number
  cols: number
  rows: number
  cellSize: number
  /** CSR layout: segment ids for cell c are cellItems[cellOffsets[c]..cellOffsets[c+1]). */
  cellOffsets: Int32Array
  cellItems: Int32Array
  stats: VectorIndexStats
  /** Query-scoped dedup stamps (a segment can sit in many cells). Internal. */
  stamps: Int32Array
  stampId: number
}

/**
 * Build a uniform spatial grid over image-pixel space from normalized
 * segments. One conversion pass, two counting passes into typed arrays — no
 * per-segment object allocation, so 50k+ segments index without jank.
 */
export function buildVectorIndex(parsed: ParsedVectors, imageSize: ImageSize): VectorIndex | null {
  const { segments, flags, widths } = parsed
  if (imageSize.width <= 0 || imageSize.height <= 0) return null
  if (segments.length % 4 !== 0) return null
  const segmentCount = segments.length / 4
  if (flags && flags.length !== segmentCount) return null
  if (widths && widths.length !== segmentCount) return null

  const px = new Float32Array(segments.length)
  for (let i = 0; i < segmentCount; i++) {
    px[i * 4] = segments[i * 4] * imageSize.width
    px[i * 4 + 1] = segments[i * 4 + 1] * imageSize.height
    px[i * 4 + 2] = segments[i * 4 + 2] * imageSize.width
    px[i * 4 + 3] = segments[i * 4 + 3] * imageSize.height
  }

  const cols = Math.max(1, Math.ceil(imageSize.width / CELL_SIZE))
  const rows = Math.max(1, Math.ceil(imageSize.height / CELL_SIZE))
  const cellCount = cols * rows

  const clampCol = (x: number) => Math.min(cols - 1, Math.max(0, Math.floor(x / CELL_SIZE)))
  const clampRow = (y: number) => Math.min(rows - 1, Math.max(0, Math.floor(y / CELL_SIZE)))

  // Pass 1: how many (segment, cell) pairs land in each cell.
  const counts = new Int32Array(cellCount)
  for (let i = 0; i < segmentCount; i++) {
    const c0 = clampCol(Math.min(px[i * 4], px[i * 4 + 2]))
    const c1 = clampCol(Math.max(px[i * 4], px[i * 4 + 2]))
    const r0 = clampRow(Math.min(px[i * 4 + 1], px[i * 4 + 3]))
    const r1 = clampRow(Math.max(px[i * 4 + 1], px[i * 4 + 3]))
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) counts[r * cols + c]++
    }
  }

  const cellOffsets = new Int32Array(cellCount + 1)
  for (let c = 0; c < cellCount; c++) cellOffsets[c + 1] = cellOffsets[c] + counts[c]

  // Pass 2: fill, reusing counts as per-cell write cursors.
  const cellItems = new Int32Array(cellOffsets[cellCount])
  counts.fill(0)
  for (let i = 0; i < segmentCount; i++) {
    const c0 = clampCol(Math.min(px[i * 4], px[i * 4 + 2]))
    const c1 = clampCol(Math.max(px[i * 4], px[i * 4 + 2]))
    const r0 = clampRow(Math.min(px[i * 4 + 1], px[i * 4 + 3]))
    const r1 = clampRow(Math.max(px[i * 4 + 1], px[i * 4 + 3]))
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = r * cols + c
        cellItems[cellOffsets[cell] + counts[cell]] = i
        counts[cell]++
      }
    }
  }

  return {
    imageSize,
    segments: px,
    flags,
    widths,
    segmentCount,
    cols,
    rows,
    cellSize: CELL_SIZE,
    cellOffsets,
    cellItems,
    stats: computeStats(px, segmentCount),
    stamps: new Int32Array(segmentCount),
    stampId: 0,
  }
}

/** Quantized vertex key for endpoint merging. */
function vertexKey(x: number, y: number): number {
  // Sheets are a few tens of thousands of px at most; 1<<20 rows out-range them.
  return Math.round(x / MERGE_TOLERANCE_PX) * (1 << 20) + Math.round(y / MERGE_TOLERANCE_PX)
}

/**
 * Endpoint connectivity plus a conservative room-sized-loop count, matching
 * the spike harness: walk unambiguous degree-2 chains only, never guess a
 * branch at a junction.
 */
function computeStats(px: Float32Array, segmentCount: number): VectorIndexStats {
  if (segmentCount === 0) return { connectedEndpointPct: 0, roomSizedLoopCount: 0 }

  const vertexIds = new Map<number, number>()
  const vertexX: number[] = []
  const vertexY: number[] = []
  const vertexEdges: number[][] = []

  const touch = (x: number, y: number, edge: number): number => {
    const key = vertexKey(x, y)
    let id = vertexIds.get(key)
    if (id === undefined) {
      id = vertexX.length
      vertexIds.set(key, id)
      vertexX.push(x)
      vertexY.push(y)
      vertexEdges.push([])
    }
    vertexEdges[id].push(edge)
    return id
  }

  const edgeA = new Int32Array(segmentCount)
  const edgeB = new Int32Array(segmentCount)
  for (let i = 0; i < segmentCount; i++) {
    edgeA[i] = touch(px[i * 4], px[i * 4 + 1], i)
    edgeB[i] = touch(px[i * 4 + 2], px[i * 4 + 3], i)
  }

  let connected = 0
  for (const edges of vertexEdges) {
    if (edges.length >= 2) connected += edges.length
  }

  const visited = new Uint8Array(segmentCount)
  let roomSizedLoops = 0
  for (let start = 0; start < segmentCount; start++) {
    if (visited[start]) continue
    let edge = start
    let vertex = edgeA[start]
    const startVertex = vertex
    let twiceArea = 0
    let prevX = vertexX[vertex]
    let prevY = vertexY[vertex]
    let guard = 0
    while (guard++ < 512) {
      visited[edge] = 1
      const next = edgeA[edge] === vertex ? edgeB[edge] : edgeA[edge]
      const nx = vertexX[next]
      const ny = vertexY[next]
      twiceArea += prevX * ny - nx * prevY
      prevX = nx
      prevY = ny
      if (next === startVertex && guard >= 3) {
        if (Math.abs(twiceArea) / 2 >= ROOM_MIN_AREA_PX) roomSizedLoops++
        break
      }
      const candidates = vertexEdges[next].filter((e) => !visited[e])
      if (candidates.length !== 1) break
      edge = candidates[0]
      vertex = next
    }
  }

  return {
    connectedEndpointPct: Math.round(((connected / (segmentCount * 2)) * 100) * 10) / 10,
    roomSizedLoopCount: roomSizedLoops,
  }
}

/**
 * Collect the distinct segment ids whose grid cells intersect the rectangle.
 * Uses the index's stamp array for dedup so a hot query loop allocates only
 * the result list.
 */
function collectSegmentsInRect(
  index: VectorIndex,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): number[] {
  index.stampId++
  const stamp = index.stampId
  const c0 = Math.min(index.cols - 1, Math.max(0, Math.floor(minX / index.cellSize)))
  const c1 = Math.min(index.cols - 1, Math.max(0, Math.floor(maxX / index.cellSize)))
  const r0 = Math.min(index.rows - 1, Math.max(0, Math.floor(minY / index.cellSize)))
  const r1 = Math.min(index.rows - 1, Math.max(0, Math.floor(maxY / index.cellSize)))
  const out: number[] = []
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const cell = r * index.cols + c
      const end = index.cellOffsets[cell + 1]
      for (let k = index.cellOffsets[cell]; k < end; k++) {
        const seg = index.cellItems[k]
        if (index.stamps[seg] === stamp) continue
        index.stamps[seg] = stamp
        out.push(seg)
      }
    }
  }
  return out
}

/** Squared distance from a point to a segment, plus the projection parameter. */
function projectOntoSegment(
  pxq: number,
  pyq: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): { t: number; x: number; y: number; distSq: number } {
  const dx = x1 - x0
  const dy = y1 - y0
  const lenSq = dx * dx + dy * dy
  const t = lenSq === 0 ? 0 : Math.min(1, Math.max(0, ((pxq - x0) * dx + (pyq - y0) * dy) / lenSq))
  const x = x0 + t * dx
  const y = y0 + t * dy
  const ddx = pxq - x
  const ddy = pyq - y
  return { t, x, y, distSq: ddx * ddx + ddy * ddy }
}

/** Proper (interior×interior) intersection of two segments, or null. */
function segmentIntersection(
  ax0: number, ay0: number, ax1: number, ay1: number,
  bx0: number, by0: number, bx1: number, by1: number,
): { x: number; y: number; t: number; u: number } | null {
  const rx = ax1 - ax0
  const ry = ay1 - ay0
  const sx = bx1 - bx0
  const sy = by1 - by0
  const denom = rx * sy - ry * sx
  if (Math.abs(denom) < 1e-9) return null
  const qpx = bx0 - ax0
  const qpy = by0 - ay0
  const t = (qpx * sy - qpy * sx) / denom
  const u = (qpx * ry - qpy * rx) / denom
  const eps = 1e-6
  if (t < eps || t > 1 - eps || u < eps || u > 1 - eps) return null
  return { x: ax0 + t * rx, y: ay0 + t * ry, t, u }
}

// ---------------------------------------------------------------------------
// snapPoint
// ---------------------------------------------------------------------------

export type SnapKind = "endpoint" | "intersection" | "segment"

export interface SnapResult {
  /** Image pixels — the same space the query point is in. */
  point: PxPoint
  kind: SnapKind
}

/** Pairwise intersection checks are O(n²); bound the candidate set. */
const MAX_SNAP_INTERSECTION_CANDIDATES = 48

/**
 * Snap a point (image px) onto nearby linework within `tolerancePx`.
 *
 * Preference order: endpoint (including near-coincident endpoint clusters —
 * wall corners), then crossing intersections, then the nearest mid-segment
 * projection. Endpoints win even when a projection is closer, because the
 * corner is almost always what the estimator meant.
 */
export function snapPoint(index: VectorIndex, point: PxPoint, tolerancePx: number): SnapResult | null {
  if (!(tolerancePx > 0)) return null
  const candidates = collectSegmentsInRect(
    index,
    point.x - tolerancePx,
    point.y - tolerancePx,
    point.x + tolerancePx,
    point.y + tolerancePx,
  )
  if (candidates.length === 0) return null

  const tolSq = tolerancePx * tolerancePx
  const seg = index.segments

  let bestEndpointDistSq = Infinity
  let bestEndpointX = 0
  let bestEndpointY = 0
  for (const i of candidates) {
    for (let e = 0; e < 2; e++) {
      const ex = seg[i * 4 + e * 2]
      const ey = seg[i * 4 + e * 2 + 1]
      const dx = point.x - ex
      const dy = point.y - ey
      const distSq = dx * dx + dy * dy
      if (distSq <= tolSq && distSq < bestEndpointDistSq) {
        bestEndpointDistSq = distSq
        bestEndpointX = ex
        bestEndpointY = ey
      }
    }
  }
  if (bestEndpointDistSq < Infinity) {
    return { point: { x: bestEndpointX, y: bestEndpointY }, kind: "endpoint" }
  }

  // Crossing intersections among the nearest few candidates.
  const nearby = candidates
    .map((i) => ({
      i,
      distSq: projectOntoSegment(point.x, point.y, seg[i * 4], seg[i * 4 + 1], seg[i * 4 + 2], seg[i * 4 + 3]).distSq,
    }))
    .filter((c) => c.distSq <= tolSq)
    .sort((a, b) => a.distSq - b.distSq)
    .slice(0, MAX_SNAP_INTERSECTION_CANDIDATES)

  let bestCrossDistSq = Infinity
  let bestCrossX = 0
  let bestCrossY = 0
  for (let a = 0; a < nearby.length; a++) {
    for (let b = a + 1; b < nearby.length; b++) {
      const i = nearby[a].i
      const j = nearby[b].i
      const hit = segmentIntersection(
        seg[i * 4], seg[i * 4 + 1], seg[i * 4 + 2], seg[i * 4 + 3],
        seg[j * 4], seg[j * 4 + 1], seg[j * 4 + 2], seg[j * 4 + 3],
      )
      if (!hit) continue
      const dx = point.x - hit.x
      const dy = point.y - hit.y
      const distSq = dx * dx + dy * dy
      if (distSq <= tolSq && distSq < bestCrossDistSq) {
        bestCrossDistSq = distSq
        bestCrossX = hit.x
        bestCrossY = hit.y
      }
    }
  }
  if (bestCrossDistSq < Infinity) {
    return { point: { x: bestCrossX, y: bestCrossY }, kind: "intersection" }
  }

  if (nearby.length > 0) {
    const i = nearby[0].i
    const projected = projectOntoSegment(
      point.x, point.y,
      seg[i * 4], seg[i * 4 + 1], seg[i * 4 + 2], seg[i * 4 + 3],
    )
    return { point: { x: projected.x, y: projected.y }, kind: "segment" }
  }
  return null
}

// ---------------------------------------------------------------------------
