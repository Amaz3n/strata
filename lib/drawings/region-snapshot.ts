/**
 * Pure math for drawing viewport snapshots: clamp a normalized sheet region,
 * pick the cheapest DZI pyramid level that covers it at output resolution,
 * and turn the region into level-pixel geometry (crop rect, tile range,
 * capped output size).
 *
 * No I/O and no sharp in here — `lib/services/drawing-snapshots.ts` downloads
 * and composites the tiles. Same split as change detection, whose
 * `dziLevelSize` is reused rather than re-derived so both features agree on
 * level geometry bit-for-bit.
 */

import { dziLevelSize, type Size } from "@/lib/drawings/change-detection"

/**
 * Target long edge (px) of a snapshot. The picked level's region long edge is
 * at most 2× this, so a full-sheet grab can never assemble a gigantic image.
 */
export const SNAPSHOT_LONG_EDGE = 1600

/** Regions thinner than this (normalized) after clamping count as empty. */
const MIN_REGION_EDGE = 0.001

/** Normalized 0..1 region of the sheet image, y down. */
export interface NormalizedRegion {
  x: number
  y: number
  w: number
  h: number
}

/** Integer pixel rect at a specific pyramid level. */
export interface PixelRect {
  x: number
  y: number
  w: number
  h: number
}

/** Inclusive tile-index range at a level. */
export interface TileRange {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Where one tile's bitmap lands in level-pixel space (overlap included). */
export interface TileLevelPlacement {
  left: number
  top: number
  width: number
  height: number
}

export interface RegionSnapshotPlan {
  level: number
  levelSize: Size
  /** Crop rect in level px. */
  rect: PixelRect
  /** Tiles that must be downloaded to cover `rect`. */
  tiles: TileRange
  /** Final encoded dimensions (rect proportionally capped, never upscaled). */
  output: Size
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/**
 * Clamp a normalized region to the unit square. Returns null when the region
 * is non-finite, inverted, or has (near-)zero area after clamping.
 */
export function clampRegion(region: NormalizedRegion): NormalizedRegion | null {
  if (
    !Number.isFinite(region.x) ||
    !Number.isFinite(region.y) ||
    !Number.isFinite(region.w) ||
    !Number.isFinite(region.h)
  ) {
    return null
  }
  const x = clamp01(region.x)
  const y = clamp01(region.y)
  const w = clamp01(region.x + region.w) - x
  const h = clamp01(region.y + region.h) - y
  if (w < MIN_REGION_EDGE || h < MIN_REGION_EDGE) return null
  return { x, y, w, h }
}

/**
 * Cheapest pyramid level whose slice of the region reaches `targetLongEdge`
 * — the level a snapshot is assembled from. Falls back to the sharpest level
 * when even full resolution is smaller than the target (tiny region), in
 * which case the output simply stays at native size.
 */
export function pickSnapshotLevel(
  imageWidth: number,
  imageHeight: number,
  levelCount: number,
  region: NormalizedRegion,
  targetLongEdge: number,
): number {
  for (let level = 0; level < levelCount; level++) {
    const size = dziLevelSize(imageWidth, imageHeight, levelCount, level)
    const longEdge = Math.max(region.w * size.width, region.h * size.height)
    if (longEdge >= targetLongEdge) return level
  }
  return levelCount - 1
}

/**
 * The region as an integer pixel rect at a level: floor/ceil so the crop
 * fully covers the requested region, clamped to the level, never empty.
 */
export function regionRectAtLevel(region: NormalizedRegion, levelSize: Size): PixelRect {
  const left = Math.min(levelSize.width - 1, Math.max(0, Math.floor(region.x * levelSize.width)))
  const top = Math.min(levelSize.height - 1, Math.max(0, Math.floor(region.y * levelSize.height)))
  const right = Math.min(
    levelSize.width,
    Math.max(left + 1, Math.ceil((region.x + region.w) * levelSize.width)),
  )
  const bottom = Math.min(
    levelSize.height,
    Math.max(top + 1, Math.ceil((region.y + region.h) * levelSize.height)),
  )
  return { x: left, y: top, w: right - left, h: bottom - top }
}

/** Proportionally shrink to fit the long edge; identity when already smaller. */
export function snapshotOutputSize(rect: PixelRect, maxLongEdge: number): Size {
  const longEdge = Math.max(rect.w, rect.h)
  if (longEdge <= maxLongEdge) return { width: rect.w, height: rect.h }
  const scale = maxLongEdge / longEdge
  return {
    width: Math.max(1, Math.round(rect.w * scale)),
    height: Math.max(1, Math.round(rect.h * scale)),
  }
}

/**
 * Inclusive tile indices covering a level-pixel rect. Uses the rect's last
 * pixel (not its exclusive right edge) so a rect ending exactly on a tile
 * boundary doesn't pull in an extra column/row.
 */
export function tileRangeForRect(rect: PixelRect, tileSize: number, levelSize: Size): TileRange {
  const cols = Math.ceil(levelSize.width / tileSize)
  const rows = Math.ceil(levelSize.height / tileSize)
  const x0 = Math.min(cols - 1, Math.max(0, Math.floor(rect.x / tileSize)))
  const y0 = Math.min(rows - 1, Math.max(0, Math.floor(rect.y / tileSize)))
  const x1 = Math.min(cols - 1, Math.max(x0, Math.floor((rect.x + rect.w - 1) / tileSize)))
  const y1 = Math.min(rows - 1, Math.max(y0, Math.floor((rect.y + rect.h - 1) / tileSize)))
  return { x0, y0, x1, y1 }
}

/**
 * Where tile (x, y) lands in level-pixel space, DZI overlap included on
 * interior edges — mirrors `TilePyramid.placement` (lib/viewer/tile-pyramid.ts)
 * so server assembly matches what the viewer draws.
 */
export function tileLevelPlacement(
  x: number,
  y: number,
  tileSize: number,
  overlap: number,
  levelSize: Size,
): TileLevelPlacement {
  const cols = Math.ceil(levelSize.width / tileSize)
  const rows = Math.ceil(levelSize.height / tileSize)
  const left = x * tileSize - (x > 0 ? overlap : 0)
  const top = y * tileSize - (y > 0 ? overlap : 0)
  const width = Math.min(
    levelSize.width - left,
    tileSize + (x > 0 ? overlap : 0) + (x < cols - 1 ? overlap : 0),
  )
  const height = Math.min(
    levelSize.height - top,
    tileSize + (y > 0 ? overlap : 0) + (y < rows - 1 ? overlap : 0),
  )
  return { left, top, width, height }
}

/**
 * Full geometry for one snapshot: level, crop rect, tile range, output size.
 * `region` must already be clamped (see `clampRegion`).
 */
export function planRegionSnapshot(params: {
  imageWidth: number
  imageHeight: number
  levelCount: number
  tileSize: number
  region: NormalizedRegion
  targetLongEdge?: number
}): RegionSnapshotPlan {
  const targetLongEdge = params.targetLongEdge ?? SNAPSHOT_LONG_EDGE
  const level = pickSnapshotLevel(
    params.imageWidth,
    params.imageHeight,
    params.levelCount,
    params.region,
    targetLongEdge,
  )
  const levelSize = dziLevelSize(params.imageWidth, params.imageHeight, params.levelCount, level)
  const rect = regionRectAtLevel(params.region, levelSize)
  const tiles = tileRangeForRect(rect, params.tileSize, levelSize)
  const output = snapshotOutputSize(rect, targetLongEdge)
  return { level, levelSize, rect, tiles, output }
}
