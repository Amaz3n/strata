/**
 * Pure math for revision change detection: DZI level geometry plus the
 * pixel-diff that turns two same-size grayscale rasters into a changed-pixel
 * ratio and a set of changed-region bounding boxes.
 *
 * No I/O and no sharp in here — the pipeline downloads/assembles the rasters
 * and calls in with raw buffers, the same split condition-rollup uses so the
 * part that decides "what changed" stays unit-testable.
 */

/** Bump when the diff math changes so stored results can be told apart. */
export const CHANGE_DETECTION_ALGO = "tile-diff-v1"

/** Gray-value delta (0..255) below which a pixel counts as unchanged. */
const DIFF_THRESHOLD = 32
/** Region grid cell edge in raster px. */
const CELL_SIZE = 16
/** Changed pixels a cell needs before it participates in a region. */
const CELL_CHANGED_MIN = 6
/** Regions kept per sheet (largest first); the true count is reported. */
const MAX_REGIONS = 24

export interface Size {
  width: number
  height: number
}

/** Changed-region bounding box, normalized 0..1 against the sheet raster. */
export interface ChangeRegion {
  x: number
  y: number
  w: number
  h: number
}

export interface RasterDiffResult {
  /** Changed pixels / total pixels, 0..1. */
  changedRatio: number
  /** Largest regions first, capped at MAX_REGIONS. */
  regions: ChangeRegion[]
  /** True region count before the cap. */
  regionCount: number
}

/**
 * Pixel dimensions of one DZI level. Level `levelCount - 1` is full
 * resolution; each level down ceil-halves both axes, and successive
 * ceil-halving composes exactly (`ceil(ceil(n/2)/2) === ceil(n/4)`), so this
 * matches libvips dzsave output bit-for-bit.
 */
export function dziLevelSize(
  imageWidth: number,
  imageHeight: number,
  levelCount: number,
  level: number,
): Size {
  const shift = Math.max(0, levelCount - 1 - level)
  const divisor = 2 ** shift
  return {
    width: Math.max(1, Math.ceil(imageWidth / divisor)),
    height: Math.max(1, Math.ceil(imageHeight / divisor)),
  }
}

/**
 * Smallest count of pyramid levels (from the coarse end) whose top level's
 * long edge reaches `minLongEdge` — i.e. how much of the pyramid must exist
 * before a fit-to-screen view renders sharp. Returns the full count when the
 * image itself is smaller than the target.
 */
export function readyLevelCountForLongEdge(
  imageWidth: number,
  imageHeight: number,
  levelCount: number,
  minLongEdge: number,
): number {
  for (let level = 0; level < levelCount; level++) {
    const size = dziLevelSize(imageWidth, imageHeight, levelCount, level)
    if (Math.max(size.width, size.height) >= minLongEdge) {
      return level + 1
    }
  }
  return levelCount
}

/**
 * The cheapest level whose long edge is at least `targetLongEdge` — the
 * resolution region detection runs at. Falls back to the top level when the
 * whole image is smaller than the target.
 */
export function pickDiffLevel(
  imageWidth: number,
  imageHeight: number,
  levelCount: number,
  targetLongEdge: number,
): number {
  return readyLevelCountForLongEdge(imageWidth, imageHeight, levelCount, targetLongEdge) - 1
}

/**
 * Compare two single-channel rasters of identical dimensions.
 *
 * Changed pixels are grouped by a coarse cell grid and connected cells merge
 * (4-neighbor flood) into normalized bounding boxes, so one moved wall reads
 * as one region instead of a thousand pixels.
 */
export function diffGrayRasters(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  height: number,
): RasterDiffResult {
  if (a.length < width * height || b.length < width * height) {
    throw new Error("Raster buffers smaller than declared dimensions")
  }

  const cellCols = Math.ceil(width / CELL_SIZE)
  const cellRows = Math.ceil(height / CELL_SIZE)
  const cellCounts = new Uint32Array(cellCols * cellRows)
  let changedPixels = 0

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width
    const cellRow = Math.floor(y / CELL_SIZE) * cellCols
    for (let x = 0; x < width; x++) {
      const idx = rowOffset + x
      const delta = a[idx] - b[idx]
      if (delta > DIFF_THRESHOLD || delta < -DIFF_THRESHOLD) {
        changedPixels++
        cellCounts[cellRow + Math.floor(x / CELL_SIZE)]++
      }
    }
  }

  // Flood-fill flagged cells into regions.
  const flagged = new Uint8Array(cellCols * cellRows)
  for (let i = 0; i < cellCounts.length; i++) {
    if (cellCounts[i] >= CELL_CHANGED_MIN) flagged[i] = 1
  }

  interface CellRegion {
    minX: number
    minY: number
    maxX: number
    maxY: number
    cells: number
  }
  const regions: CellRegion[] = []
  const stack: number[] = []

  for (let start = 0; start < flagged.length; start++) {
    if (!flagged[start]) continue
    flagged[start] = 0
    stack.length = 0
    stack.push(start)
    const region: CellRegion = {
      minX: start % cellCols,
      minY: Math.floor(start / cellCols),
      maxX: start % cellCols,
      maxY: Math.floor(start / cellCols),
      cells: 0,
    }
    while (stack.length > 0) {
      const cell = stack.pop() as number
      const cx = cell % cellCols
      const cy = Math.floor(cell / cellCols)
      region.cells++
      if (cx < region.minX) region.minX = cx
      if (cx > region.maxX) region.maxX = cx
      if (cy < region.minY) region.minY = cy
      if (cy > region.maxY) region.maxY = cy
      if (cx > 0 && flagged[cell - 1]) { flagged[cell - 1] = 0; stack.push(cell - 1) }
      if (cx < cellCols - 1 && flagged[cell + 1]) { flagged[cell + 1] = 0; stack.push(cell + 1) }
      if (cy > 0 && flagged[cell - cellCols]) { flagged[cell - cellCols] = 0; stack.push(cell - cellCols) }
      if (cy < cellRows - 1 && flagged[cell + cellCols]) { flagged[cell + cellCols] = 0; stack.push(cell + cellCols) }
    }
    regions.push(region)
  }

  regions.sort(
    (r1, r2) =>
      (r2.maxX - r2.minX + 1) * (r2.maxY - r2.minY + 1) -
      (r1.maxX - r1.minX + 1) * (r1.maxY - r1.minY + 1),
  )

  const normalized: ChangeRegion[] = regions.slice(0, MAX_REGIONS).map((r) => ({
    x: round4((r.minX * CELL_SIZE) / width),
    y: round4((r.minY * CELL_SIZE) / height),
    w: round4((Math.min((r.maxX + 1) * CELL_SIZE, width) - r.minX * CELL_SIZE) / width),
    h: round4((Math.min((r.maxY + 1) * CELL_SIZE, height) - r.minY * CELL_SIZE) / height),
  }))

  return {
    changedRatio: round4(changedPixels / (width * height)),
    regions: normalized,
    regionCount: regions.length,
  }
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}
