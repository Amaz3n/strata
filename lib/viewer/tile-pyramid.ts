import type { Rect, Size, TileManifest } from "./types"

/**
 * DZI pyramid math for the drawings tile layout: `${base}/tiles/{level}/{x}_{y}.{fmt}`.
 *
 * Level `levelCount - 1` is full resolution; each level down halves both
 * dimensions (ceil). Tiles carry `Overlap` extra pixels on interior edges so
 * adjacent tiles can be drawn without seams. Legacy manifests (no `Levels`
 * or `Levels <= 1`) are a single full-size image at `tiles/0/0_0`.
 *
 * Pure and DOM-free; unit-tested in tests/drawing-viewer-scene.test.js.
 */

export interface TilePlacement {
  level: number
  x: number
  y: number
  url: string
  /** Where this tile's bitmap lands, in image px (overlap included). */
  rect: Rect
  /** The tile bitmap's own pixel dimensions at its own level. */
  size: Size
}

function normalizeFormat(value?: string): string {
  const normalized = (value ?? "png").trim().toLowerCase()
  return normalized || "png"
}

export class TilePyramid {
  readonly imageSize: Size
  readonly levelCount: number
  readonly tileSize: number
  readonly overlap: number
  private readonly baseUrl: string
  private readonly format: string

  constructor(baseUrl: string, manifest: TileManifest) {
    this.baseUrl = baseUrl
    this.imageSize = {
      width: Math.max(1, manifest.Image?.Size?.Width ?? 1),
      height: Math.max(1, manifest.Image?.Size?.Height ?? 1),
    }
    this.format = normalizeFormat(manifest.Image?.Format)
    const explicitLevels =
      typeof manifest.Levels === "number" && Number.isFinite(manifest.Levels)
        ? Math.max(1, Math.floor(manifest.Levels))
        : 1
    this.levelCount = explicitLevels
    this.tileSize =
      explicitLevels <= 1
        ? Math.max(this.imageSize.width, this.imageSize.height)
        : Math.max(1, manifest.Image?.TileSize ?? 512)
    this.overlap = explicitLevels <= 1 ? 0 : Math.max(0, manifest.Image?.Overlap ?? 0)
  }

  /** Image px per level px: 2^(level - max); the top level is 1. */
  private levelScale(level: number): number {
    return 2 ** (level - (this.levelCount - 1))
  }

  /**
   * Level px → image px, per axis. NOT `1 / levelScale(level)`: level sizes
   * are ceil-rounded, so a coarse level's pixel grid covers slightly *more*
   * than a clean power-of-two shrink (level 0 of a 3456×2304 sheet is a single
   * pixel standing in for the whole image, not for 4096×4096 of it). Scaling
   * by the power of two pushes the last row and column past the image edge,
   * and since coarse levels are drawn underneath the target level, that
   * overhang paints a blank band down the right and bottom of the sheet.
   */
  private levelToImage(level: number): { x: number; y: number } {
    const size = this.levelSize(level)
    return {
      x: this.imageSize.width / size.width,
      y: this.imageSize.height / size.height,
    }
  }

  levelSize(level: number): Size {
    const scale = this.levelScale(level)
    return {
      width: Math.max(1, Math.ceil(this.imageSize.width * scale)),
      height: Math.max(1, Math.ceil(this.imageSize.height * scale)),
    }
  }

  columns(level: number): number {
    return Math.ceil(this.levelSize(level).width / this.tileSize)
  }

  rows(level: number): number {
    return Math.ceil(this.levelSize(level).height / this.tileSize)
  }

  tileUrl(level: number, x: number, y: number): string {
    return `${this.baseUrl}/tiles/${level}/${x}_${y}.${this.format}`
  }

  /**
   * Sharpest level worth fetching for a camera scale (screen px per image px),
   * already multiplied by the capped devicePixelRatio by the caller. A level
   * is sufficient once its resolution meets the on-screen resolution.
   */
  levelForScale(scale: number): number {
    if (scale >= 1) return this.levelCount - 1
    const level = Math.ceil(this.levelCount - 1 + Math.log2(scale) - 1e-6)
    return Math.min(this.levelCount - 1, Math.max(0, level))
  }

  placement(level: number, x: number, y: number): TilePlacement {
    const { width: levelW, height: levelH } = this.levelSize(level)
    const cols = this.columns(level)
    const rows = this.rows(level)
    const sx = x * this.tileSize - (x > 0 ? this.overlap : 0)
    const sy = y * this.tileSize - (y > 0 ? this.overlap : 0)
    const sw = Math.min(
      levelW - sx,
      this.tileSize + (x > 0 ? this.overlap : 0) + (x < cols - 1 ? this.overlap : 0),
    )
    const sh = Math.min(
      levelH - sy,
      this.tileSize + (y > 0 ? this.overlap : 0) + (y < rows - 1 ? this.overlap : 0),
    )
    const toImage = this.levelToImage(level)
    return {
      level,
      x,
      y,
      url: this.tileUrl(level, x, y),
      rect: {
        x: sx * toImage.x,
        y: sy * toImage.y,
        width: sw * toImage.x,
        height: sh * toImage.y,
      },
      size: { width: sw, height: sh },
    }
  }

  /** Tiles of a level intersecting an image-space rect, row-major. */
  tilesInRect(level: number, rect: Rect): TilePlacement[] {
    const toImage = this.levelToImage(level)
    const scaleX = 1 / toImage.x
    const scaleY = 1 / toImage.y
    const cols = this.columns(level)
    const rows = this.rows(level)
    const x0 = Math.max(0, Math.floor((rect.x * scaleX) / this.tileSize))
    const y0 = Math.max(0, Math.floor((rect.y * scaleY) / this.tileSize))
    const x1 = Math.min(
      cols - 1,
      Math.floor(((rect.x + rect.width) * scaleX) / this.tileSize),
    )
    const y1 = Math.min(
      rows - 1,
      Math.floor(((rect.y + rect.height) * scaleY) / this.tileSize),
    )
    const placements: TilePlacement[] = []
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        placements.push(this.placement(level, x, y))
      }
    }
    return placements
  }
}
