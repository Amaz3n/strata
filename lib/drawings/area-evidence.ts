/** Original PDF path evidence, in normalized rendered-sheet coordinates. */
import type { RasterTextEvidence } from './raster-text'
import type { PdfRasterSampling } from './pdf-raster-sampling'
import type { RasterStraightRunSupport } from './raster-straight-runs'
import type { RasterArcSupport } from './raster-arcs'
import type { RasterPairPaint } from './raster-pair-paint'
export const AREA_EVIDENCE_FILE = "area-evidence.json"
export const AREA_EVIDENCE_VERSION = 1
export const AREA_EXTRACTION_PROFILE = 'floor-area-2'
export type AreaPoint = [number, number]
export type PathCommand = ["M" | "L", number, number] | ["C", number, number, number, number, number, number] | ["Z"]
export interface EvidencePath {
  id: number
  /** Measured raster primitive, not an architectural role or CAD label. */
  rasterFeature?: "paint-boundary" | "linework" | "circular-arc"
  rasterLine?: RasterStraightRunSupport
  rasterWindowIds?: number[]
  rasterArc?: RasterArcSupport
  commands: PathCommand[]
  kind: "stroke" | "fill" | "clip"
  color: number[]
  colorSpace: string
  opacity: number
  width: number
  dashes: number[]
  layer: string[]
  groups: number[]
  clips: number[]
  evenOdd: boolean
}
export interface AreaEvidence {
  version: typeof AREA_EVIDENCE_VERSION
  raster?: { width: number; height: number; feetPerPixel: number; threshold: number; maximumDeviationPixels: number; region: { x0: number; y0: number; x1: number; y1: number }; diagnostics?: {contoursLimited:boolean;straightLimited:boolean;paintLimited:boolean;strokesLimited:boolean;arcsLimited:boolean;combinedPathLimit:boolean}; tiling?: import("./raster-geometry-tiles").RasterGeometryTiling; context?: import("./raster-context").RasterContextEvidence; sourceSampling?: PdfRasterSampling; sourceHash?: string; renderDpi?: number }
  paths: EvidencePath[]
  rasterText?: RasterTextEvidence
  rasterPairPaint?: RasterPairPaint[]
  truncated: boolean
  /** False only when extraction checked for raster/shading/mask paint. Missing
   * on older artifacts means revision equality cannot be established. */
  unrepresentedPaint?: boolean
  extractionProfile?: string
  /** Explicitly classified decoration omitted after its separate budget. The
   * original PDF remains authoritative; this artifact is floor-area evidence. */
  omittedDecorationPaths?: number
}

/** A page frame's bounding box can surround a scanned plan without putting
 * any vector ink inside it. Inspect actual source segments and filled paint,
 * rather than allowing unrelated title blocks to select the vector route. */
export function hasVectorGeometryInRegion(
  evidence: AreaEvidence | null | undefined,
  region = { x0: 0, y0: 0, x1: 1, y1: 1 },
): boolean {
  const segmentIntersects = (a: AreaPoint, b: AreaPoint) => {
    let lo = 0, hi = 1;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    if (Math.hypot(dx, dy) < 1e-10) return false;
    for (const [p, q] of [[-dx, a[0] - region.x0], [dx, region.x1 - a[0]], [-dy, a[1] - region.y0], [dy, region.y1 - a[1]]]) {
      if (Math.abs(p) < 1e-14) { if (q < 0) return false; continue; }
      if (p < 0) lo = Math.max(lo, q / p); else hi = Math.min(hi, q / p);
      if (lo > hi) return false;
    }
    return hi - lo > 1e-10;
  };
  const center: AreaPoint = [(region.x0 + region.x1) / 2, (region.y0 + region.y1) / 2];
  return (evidence?.paths ?? []).some(path => {
    if (path.kind === "clip" || path.opacity < .5) return false;
    // White erase masks/backgrounds contain no recoverable plan linework.
    if (path.kind === "fill" && ((path.colorSpace === "DeviceGray" && path.color[0] >= .98) ||
      (path.colorSpace === "DeviceRGB" && path.color.length === 3 && path.color.every(c => c >= .98)))) return false;
    const bounds = evidencePathBounds(path);
    if (!bounds || bounds.x1 < region.x0 || bounds.x0 > region.x1 || bounds.y1 < region.y0 || bounds.y0 > region.y1) return false;
    const rings = flattenEvidencePath(path);
    if (rings.some(ring => ring.some((p, i) => i > 0 && segmentIntersects(ring[i - 1], p)))) return true;
    if (path.kind !== "fill") return false;
    let winding = 0;
    for (const ring of rings) for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1], b = ring[i];
      const side = (b[0] - a[0]) * (center[1] - a[1]) - (center[0] - a[0]) * (b[1] - a[1]);
      if (a[1] <= center[1] && b[1] > center[1] && side > 0) winding++;
      else if (a[1] > center[1] && b[1] <= center[1] && side < 0) winding--;
    }
    return path.evenOdd ? Math.abs(winding) % 2 === 1 : winding !== 0;
  });
}

/** Conservative bounds include cubic control points, so a curved path crossing
 * a search window is never discarded merely because both ends are outside. */
export function evidencePathBounds(path: EvidencePath): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  const include = (x: number, y: number) => {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y)
  }
  for (const command of path.commands) {
    if (command[0] === 'M' || command[0] === 'L') include(command[1], command[2])
    else if (command[0] === 'C') {
      include(command[1], command[2]); include(command[3], command[4]); include(command[5], command[6])
    }
  }
  return Number.isFinite(x0 + y0 + x1 + y1) ? { x0, y0, x1, y1 } : null
}

export function flattenEvidencePath(path: EvidencePath): AreaPoint[][] {
  const rings: AreaPoint[][] = []
  let current: AreaPoint[] = []
  const finish = () => {
    if (current.length < 2) return
    // PDF fill operations implicitly close each subpath, even without Z.
    if (path.kind === "fill" && current.length > 2) {
      const first = current[0], last = current[current.length - 1]
      if (first[0] !== last[0] || first[1] !== last[1]) current.push([...first])
    }
    rings.push(current)
  }
  for (const command of path.commands) {
    if (command[0] === "M") {
      finish()
      current = [[command[1], command[2]]]
    } else if (command[0] === "L") {
      current.push([command[1], command[2]])
    } else if (command[0] === "C" && current.length) {
      const p = current[current.length - 1]
      for (let i = 1; i <= 32; i++) {
        const t = i / 32, u = 1 - t
        current.push([
          u ** 3 * p[0] + 3 * u * u * t * command[1] + 3 * u * t * t * command[3] + t ** 3 * command[5],
          u ** 3 * p[1] + 3 * u * u * t * command[2] + 3 * u * t * t * command[4] + t ** 3 * command[6],
        ])
      }
    } else if (command[0] === "Z" && current.length) current.push([...current[0]])
  }
  finish()
  return rings
}
