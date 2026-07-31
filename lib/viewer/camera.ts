import type { ImageToScreenMatrix, Size } from "./types"

/**
 * 2D pan/zoom camera over a raster image, shared by every GPU viewer.
 *
 * State is (center, scale): the image point under the viewport center and
 * screen px per image px. No rotation — the emitted matrix keeps the full
 * affine shape only for API compatibility with overlay consumers.
 *
 * Pure and DOM-free (unit-tested in tests/drawing-viewer-scene.test.js);
 * gesture wiring lives in gestures.ts, constraints are applied here.
 */

export interface CameraPoint {
  x: number
  y: number
}

/** Allow zooming slightly out past fit, matching the old viewer's feel. */
const MIN_SCALE_FIT_RATIO = 0.5
/** Absolute ceiling: 2 screen px per image px (past 1:1, retina headroom). */
const MAX_SCALE = 2

export class Camera2D {
  private imageWidth = 1
  private imageHeight = 1
  private viewportWidth = 1
  private viewportHeight = 1
  /** Image px under the viewport center. */
  private centerX = 0.5
  private centerY = 0.5
  /** Screen px per image px. */
  private scale = 1

  get imageSize(): Size {
    return { width: this.imageWidth, height: this.imageHeight }
  }

  get viewportSize(): Size {
    return { width: this.viewportWidth, height: this.viewportHeight }
  }

  get currentScale(): number {
    return this.scale
  }

  /**
   * OpenSeadragon-compatible zoom figure: 1 means the image width exactly
   * fills the viewport width. The viewer chrome displays `zoom * 100`%.
   */
  get zoom(): number {
    return (this.scale * this.imageWidth) / Math.max(1, this.viewportWidth)
  }

  fitScale(): number {
    return Math.min(
      this.viewportWidth / this.imageWidth,
      this.viewportHeight / this.imageHeight,
    )
  }

  private minScale(): number {
    return this.fitScale() * MIN_SCALE_FIT_RATIO
  }

  private maxScale(): number {
    return Math.max(MAX_SCALE, this.fitScale() * 2)
  }

  /** Swap the image (sheet navigation). The view resets to fit. */
  setImageSize(size: Size): void {
    this.imageWidth = Math.max(1, size.width)
    this.imageHeight = Math.max(1, size.height)
    this.goHome()
  }

  /** Container resized. Keeps the current view, re-clamped. */
  setViewportSize(size: Size): void {
    const fitBefore = this.fitScale()
    const wasHome = Math.abs(this.scale - fitBefore) < 1e-9
    this.viewportWidth = Math.max(1, size.width)
    this.viewportHeight = Math.max(1, size.height)
    if (wasHome) this.goHome()
    else this.applyConstraints()
  }

  goHome(): void {
    this.scale = this.fitScale()
    this.centerX = this.imageWidth / 2
    this.centerY = this.imageHeight / 2
  }

  /** 1 image px = 1 screen px, keeping the viewport center fixed. */
  zoomToActualSize(): void {
    this.zoomToScale(1)
  }

  zoomToScale(scale: number, focal?: CameraPoint): void {
    const clamped = Math.min(this.maxScale(), Math.max(this.minScale(), scale))
    const pivot = focal ?? {
      x: this.viewportWidth / 2,
      y: this.viewportHeight / 2,
    }
    // Keep the image point under the pivot fixed on screen.
    const image = this.screenToImage(pivot)
    this.scale = clamped
    this.centerX = image.x + (this.viewportWidth / 2 - pivot.x) / this.scale
    this.centerY = image.y + (this.viewportHeight / 2 - pivot.y) / this.scale
    this.applyConstraints()
  }

  zoomBy(factor: number, focal?: CameraPoint): void {
    this.zoomToScale(this.scale * factor, focal)
  }

  panByScreen(dx: number, dy: number): void {
    this.centerX -= dx / this.scale
    this.centerY -= dy / this.scale
    this.applyConstraints()
  }

  /**
   * Edge clamp: when the image overflows the viewport on an axis you can pan
   * to either edge but not past it; when it fits, it stays centered.
   */
  applyConstraints(): void {
    this.scale = Math.min(this.maxScale(), Math.max(this.minScale(), this.scale))
    this.centerX = clampCenter(this.centerX, this.imageWidth, this.viewportWidth, this.scale)
    this.centerY = clampCenter(this.centerY, this.imageHeight, this.viewportHeight, this.scale)
  }

  matrix(): ImageToScreenMatrix {
    return {
      a: this.scale,
      b: 0,
      c: 0,
      d: this.scale,
      e: this.viewportWidth / 2 - this.centerX * this.scale,
      f: this.viewportHeight / 2 - this.centerY * this.scale,
    }
  }

  screenToImage(p: CameraPoint): CameraPoint {
    return {
      x: this.centerX + (p.x - this.viewportWidth / 2) / this.scale,
      y: this.centerY + (p.y - this.viewportHeight / 2) / this.scale,
    }
  }

  imageToScreen(p: CameraPoint): CameraPoint {
    return {
      x: (p.x - this.centerX) * this.scale + this.viewportWidth / 2,
      y: (p.y - this.centerY) * this.scale + this.viewportHeight / 2,
    }
  }

  /** Snapshot for view animation; restore with setView (re-clamped). */
  getView(): { scale: number; centerX: number; centerY: number } {
    return { scale: this.scale, centerX: this.centerX, centerY: this.centerY }
  }

  setView(view: { scale: number; centerX: number; centerY: number }): void {
    this.scale = view.scale
    this.centerX = view.centerX
    this.centerY = view.centerY
    this.applyConstraints()
  }

  /** Image-space rect currently visible (may extend past the image bounds). */
  visibleImageRect(): { x: number; y: number; width: number; height: number } {
    const topLeft = this.screenToImage({ x: 0, y: 0 })
    return {
      x: topLeft.x,
      y: topLeft.y,
      width: this.viewportWidth / this.scale,
      height: this.viewportHeight / this.scale,
    }
  }
}

function clampCenter(
  center: number,
  imageExtent: number,
  viewportExtent: number,
  scale: number,
): number {
  const halfView = viewportExtent / (2 * scale)
  if (imageExtent * scale <= viewportExtent) return imageExtent / 2
  return Math.min(imageExtent - halfView, Math.max(halfView, center))
}
