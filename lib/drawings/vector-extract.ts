import "server-only"

/**
 * Vector extraction for takeoff snapping.
 *
 * Walks a MuPDF page's display list and records every stroked/filled path as
 * flat segments (curves sampled at 8 chords — takeoff geometry is polygonal,
 * and a flattened curve is what a snap binds to anyway). Segments are noise-
 * filtered and encoded into the `vectors.bin` binary the viewer's snap index
 * consumes, in the SAME normalized image space markup points use (0..1,
 * y-down against the rendered raster).
 *
 * The walk is the production port of scripts/takeoff-vector-spike.mjs; the
 * stats math is shared with it via lib/drawings/vector-analysis.ts.
 *
 * vectors.bin format (little-endian):
 *   "ARCV" (4 bytes) | uint16 version=2 | uint16 reserved | uint32 count
 *   coords: count × (float32 x0, y0, x1, y1), normalized image coordinates
 *   attrs: count × (uint8 flags, uint8 width-in-tenths-of-a-page-unit)
 */

import {
  analyzeSegments,
  collapseDashChains,
  mergeCollinearChains,
  type Segment,
  type VectorStats,
} from "@/lib/drawings/vector-analysis"

/** Below this (page units, ~1/72") a segment is detail, not structure. */
const NOISE_LENGTH_PAGE_UNITS = 3
/** Hard cap on stored segments — malformed PDFs must not produce 100MB blobs. */
const MAX_STORED_SEGMENTS = 200_000
const VECTORS_BIN_VERSION = 2
/**
 * Extraction algorithm revision, persisted in vector_stats. Bump when the
 * extraction pipeline changes in a way that should re-run on existing sheets —
 * the backfill job re-processes any version whose stored algo is older.
 *   1: raw walk + noise filter
 *   2: collinear chain-merge before the noise filter (recovers walls that
 *      exporters shred into sub-point fragments)
 *   3: dash-chain attribution and vectors.bin v2 stroke attributes
 *   4: positioned text runs (text-runs.json) written alongside vectors.bin,
 *      which floorplan interpretation needs to label rooms
 */
export const VECTOR_EXTRACT_ALGO = 4

export interface ExtractedVectors {
  /** Filtered, normalized segments encoded per the vectors.bin contract. */
  bin: Buffer
  storedSegmentCount: number
  /** True when MAX_STORED_SEGMENTS truncated the structural set. */
  truncated: boolean
  /** Stats over the FULL unfiltered set — the routing signal for snap/flood. */
  stats: VectorStats
}

interface PagePoint {
  x: number
  y: number
}

function applyMatrix(ctm: unknown, point: PagePoint): PagePoint {
  const m = Array.isArray(ctm) ? (ctm as number[]) : [1, 0, 0, 1, 0, 0]
  return {
    x: m[0] * point.x + m[2] * point.y + m[4],
    y: m[1] * point.x + m[3] * point.y + m[5],
  }
}

function cubicAt(p0: PagePoint, p1: PagePoint, p2: PagePoint, p3: PagePoint, t: number): PagePoint {
  const u = 1 - t
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  }
}

/** Walk every stroked and filled path on the page into flat page-space segments. */
export function walkPageSegments(mupdf: typeof import("mupdf"), page: unknown): Segment[] {
  const segments: Segment[] = []

  const record = (path: any, ctm: unknown, width: number, filled: boolean) => {
    let cursor: PagePoint | null = null
    let subpathStart: PagePoint | null = null
    const push = (from: PagePoint, to: PagePoint) => {
      const a = applyMatrix(ctm, from)
      const b = applyMatrix(ctm, to)
      if (a.x === b.x && a.y === b.y) return
      segments.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y, width, filled, dashed: false })
    }
    path.walk({
      moveTo(x: number, y: number) {
        cursor = { x, y }
        subpathStart = { x, y }
      },
      lineTo(x: number, y: number) {
        if (cursor) push(cursor, { x, y })
        cursor = { x, y }
      },
      curveTo(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) {
        if (!cursor) {
          cursor = { x: x3, y: y3 }
          return
        }
        const start = cursor
        let prev = cursor
        for (let i = 1; i <= 8; i++) {
          const t = i / 8
          const point = cubicAt(start, { x: x1, y: y1 }, { x: x2, y: y2 }, { x: x3, y: y3 }, t)
          push(prev, point)
          prev = point
        }
        cursor = prev
      },
      closePath() {
        if (cursor && subpathStart) push(cursor, subpathStart)
        cursor = subpathStart
      },
    })
  }

  const device = new (mupdf as any).Device({
    fillPath(path: unknown, _evenOdd: unknown, ctm: unknown) {
      record(path, ctm, 0, true)
    },
    strokePath(path: unknown, stroke: any, ctm: unknown) {
      let width = 1
      try {
        width = stroke.getLineWidth()
      } catch {
        width = 1
      }
      record(path, ctm, width, false)
    },
  })

  ;(page as any).runPageContents(device, (mupdf as any).Matrix.identity)
  device.close?.()

  return segments
}

/**
 * Filter, normalize, and encode a page's segments.
 *
 * `pageToImageScale` converts page units to rendered-image pixels (the render
 * DPI / 72, using the SAME transform the raster came from), and the image
 * dimensions normalize to 0..1. Sub-noise segments are dropped BEFORE the cap
 * so truncation only ever sacrifices detail, never structure.
 */
export function encodeVectors(
  segments: Segment[],
  args: {
    pageToImageScale: number
    imageWidth: number
    imageHeight: number
    /** Page-space origin of the rendered raster (page bounds x0/y0). */
    pageOriginX?: number
    pageOriginY?: number
  },
): ExtractedVectors {
  const { pageToImageScale, imageWidth, imageHeight } = args
  const originX = args.pageOriginX ?? 0
  const originY = args.pageOriginY ?? 0

  // Merge shredded collinear runs BEFORE filtering, so a wall emitted as ten
  // thousand sub-point fragments survives as one long segment. Stats are
  // computed on the merged set — that is the graph snapping actually sees.
  const mergedSegments = mergeCollinearChains(collapseDashChains(segments))
  const stats = analyzeSegments(mergedSegments)

  const structural = mergedSegments.filter((segment) => {
    const length = Math.hypot(segment.x1 - segment.x0, segment.y1 - segment.y0)
    return length >= NOISE_LENGTH_PAGE_UNITS
  })

  const truncated = structural.length > MAX_STORED_SEGMENTS
  const kept = truncated ? structural.slice(0, MAX_STORED_SEGMENTS) : structural

  const header = Buffer.alloc(12)
  header.write("ARCV", 0, "ascii")
  header.writeUInt16LE(VECTORS_BIN_VERSION, 4)
  header.writeUInt16LE(0, 6)
  header.writeUInt32LE(kept.length, 8)

  const coords = Buffer.alloc(kept.length * 16)
  const attrs = Buffer.alloc(kept.length * 2)
  for (let i = 0; i < kept.length; i++) {
    const segment = kept[i]
    const offset = i * 16
    coords.writeFloatLE(((segment.x0 - originX) * pageToImageScale) / imageWidth, offset)
    coords.writeFloatLE(((segment.y0 - originY) * pageToImageScale) / imageHeight, offset + 4)
    coords.writeFloatLE(((segment.x1 - originX) * pageToImageScale) / imageWidth, offset + 8)
    coords.writeFloatLE(((segment.y1 - originY) * pageToImageScale) / imageHeight, offset + 12)
    attrs.writeUInt8((segment.dashed ? 1 : 0) | (segment.filled ? 2 : 0), i * 2)
    attrs.writeUInt8(Math.min(255, Math.max(0, Math.round(segment.width * 10))), i * 2 + 1)
  }

  return {
    bin: Buffer.concat([header, coords, attrs]),
    storedSegmentCount: kept.length,
    truncated,
    stats,
  }
}

/** The stats payload persisted at extracted_metadata.vector_stats. */
export function vectorStatsMetadata(extracted: ExtractedVectors): Record<string, unknown> {
  return {
    algo: VECTOR_EXTRACT_ALGO,
    segment_count: extracted.stats.segmentCount,
    stored_segment_count: extracted.storedSegmentCount,
    truncated: extracted.truncated,
    connected_endpoint_pct: extracted.stats.connectedEndpointPct,
    room_sized_loop_count: extracted.stats.roomSizedLoopCount,
    short_segment_pct: extracted.stats.shortSegmentPct,
    extracted_at: new Date().toISOString(),
  }
}
