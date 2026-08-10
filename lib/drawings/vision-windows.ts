/**
 * Splitting a sheet into windows a vision model can actually read, and putting
 * the answers back together.
 *
 * The problem this exists to solve: the assist path squashed a whole sheet to
 * 2048px on the long edge before showing it to a model. A 36x48" MEP sheet
 * renders around 7200x5400, so a duplex receptacle arrived about six pixels
 * across. No model recovers detail that is not in the image — the ceiling was
 * the picture, not the model.
 *
 * So the sheet is covered by overlapping windows, each rendered near native
 * resolution, and the per-window answers are merged. Overlap is what stops a
 * symbol sitting on a seam from being missed; merging is what stops it being
 * counted twice.
 *
 * Pure geometry — no tiles, no network — so the tricky parts are testable.
 */

/** A window over the sheet, in normalized 0..1 sheet coordinates. */
export interface VisionWindow {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface WindowPlan {
  windows: VisionWindow[]
  /** Windows across and down, for logging and disclosure. */
  cols: number
  rows: number
}

/**
 * Cover a region with overlapping windows.
 *
 * `targetPixels` is how many source pixels each window should span — set from
 * the model's usable image edge, so each window arrives near 1:1 rather than
 * downscaled.
 */
export function planVisionWindows({
  imageWidth,
  imageHeight,
  targetPixels,
  overlap = 0.12,
  maxWindows = 12,
  region,
}: {
  imageWidth: number
  imageHeight: number
  targetPixels: number
  /** Fraction of a window that repeats into its neighbour. */
  overlap?: number
  maxWindows?: number
  region?: VisionWindow
}): WindowPlan {
  const bounds: VisionWindow = region ?? { x0: 0, y0: 0, x1: 1, y1: 1 }
  const spanX = Math.max(0, bounds.x1 - bounds.x0)
  const spanY = Math.max(0, bounds.y1 - bounds.y0)
  if (spanX <= 0 || spanY <= 0) return { windows: [], cols: 0, rows: 0 }

  const regionPixelsX = imageWidth * spanX
  const regionPixelsY = imageHeight * spanY

  // A region already small enough is one window; no point slicing it.
  let cols = Math.max(1, Math.ceil(regionPixelsX / targetPixels))
  let rows = Math.max(1, Math.ceil(regionPixelsY / targetPixels))

  // Respect the ceiling by coarsening — fewer, larger windows beats silently
  // dropping part of the sheet.
  while (cols * rows > maxWindows && (cols > 1 || rows > 1)) {
    if (cols >= rows && cols > 1) cols--
    else if (rows > 1) rows--
    else break
  }

  const stepX = spanX / cols
  const stepY = spanY / rows
  const padX = stepX * overlap
  const padY = stepY * overlap

  const windows: VisionWindow[] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      windows.push({
        x0: Math.max(bounds.x0, bounds.x0 + col * stepX - padX),
        y0: Math.max(bounds.y0, bounds.y0 + row * stepY - padY),
        x1: Math.min(bounds.x1, bounds.x0 + (col + 1) * stepX + padX),
        y1: Math.min(bounds.y1, bounds.y0 + (row + 1) * stepY + padY),
      })
    }
  }

  return { windows, cols, rows }
}

/** Map a point inside a window back to normalized sheet coordinates. */
export function windowPointToSheet(
  window: VisionWindow,
  point: [number, number],
): [number, number] {
  return [
    window.x0 + point[0] * (window.x1 - window.x0),
    window.y0 + point[1] * (window.y1 - window.y0),
  ]
}

/**
 * Merge points found across overlapping windows.
 *
 * Two detections of the same symbol land within a symbol's width of each other,
 * so anything closer than `minSeparation` collapses to the first seen. Without
 * this, every symbol in an overlap band counts twice and the takeoff is wrong
 * in the direction that costs money.
 */
export function mergeWindowPoints(
  points: Array<[number, number]>,
  minSeparation: number,
): Array<[number, number]> {
  const kept: Array<[number, number]> = []
  const threshold = minSeparation * minSeparation

  for (const point of points) {
    let duplicate = false
    for (const existing of kept) {
      const dx = point[0] - existing[0]
      const dy = point[1] - existing[1]
      if (dx * dx + dy * dy < threshold) {
        duplicate = true
        break
      }
    }
    if (!duplicate) kept.push(point)
  }

  return kept
}

/**
 * Separation below which two hits are the same symbol, in normalized units.
 *
 * Derived from the exemplar's own size when the viewer sent one — an estimator
 * clicking a small device symbol and one clicking a large equipment tag should
 * not share a fixed threshold.
 */
export function separationForExemplar({
  searchRadiusPx,
  imageWidth,
  imageHeight,
}: {
  searchRadiusPx?: number | null
  imageWidth: number
  imageHeight: number
}): number {
  const longEdge = Math.max(imageWidth, imageHeight)
  if (!searchRadiusPx || !(longEdge > 0)) return 0.004
  // Two hits within one exemplar width are the same symbol.
  return Math.min(0.05, Math.max(0.002, (searchRadiusPx * 2) / longEdge))
}
