import { Camera2D } from "./camera"
import { attachGestures, type GestureController, type GestureOptions } from "./gestures"
import { TileLoader } from "./tile-loader"
import { TilePyramid } from "./tile-pyramid"
import { createSceneRenderer } from "./webgpu-renderer"
import type {
  CompareMode,
  DrawQuad,
  ImageToScreenMatrix,
  SceneRenderer,
  Size,
  TileManifest,
} from "./types"

/**
 * The GPU drawing viewer: camera + gestures + tile streaming + renderer,
 * assembled behind the small imperative API the viewer chrome talks to.
 * Framework-agnostic — the React wrapper is
 * components/drawings/viewer/tiled-drawing-viewer.tsx.
 *
 * Rendering is on-demand: anything that changes the frame sets a dirty flag
 * and schedules one rAF. A frame draws coarse-to-fine — every cached level at
 * or below the target level that intersects the viewport — so navigation
 * shows a sharpening sheet instead of blank tiles.
 */

export interface TileSourceSpec {
  baseUrl: string
  manifest: TileManifest
}

export interface OverlaySpec {
  source: TileSourceSpec
  opacity: number
  mode: CompareMode
}

export interface ViewerTransform {
  matrix: ImageToScreenMatrix
  container: Size
  zoom: number
}

export interface GpuViewerOptions {
  container: HTMLElement
  source: TileSourceSpec
  overlay?: OverlaySpec | null
  credentials?: RequestCredentials
  gestures?: Partial<GestureOptions>
  onTransformChange?: (transform: ViewerTransform) => void
  /** First frame where every target-level tile in view has drawn. Per source. */
  onFirstFullFrame?: () => void
  /**
   * First pan/zoom by the user (or viewer chrome) after a source loads. The
   * thumbnail-first backdrop is only aligned with the home view — the wrapper
   * uses this to drop it the moment the camera moves.
   */
  onViewInteraction?: () => void
  onTileAuthError?: () => void
}

/** Retina sharpness is worth fetching one level deeper, but cap the cost. */
const MAX_DPR_FOR_LEVEL = 2

/** Discrete zoom glide (buttons, double-click, home). */
const VIEW_ANIMATION_MS = 200

export class GpuDrawingViewer {
  private readonly container: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly camera = new Camera2D()
  private readonly loader: TileLoader
  private readonly gestures: GestureController
  private readonly resizeObserver: ResizeObserver
  private readonly options: GpuViewerOptions

  private renderer: SceneRenderer | null = null
  private basePyramid: TilePyramid
  private overlayPyramid: TilePyramid | null = null
  private overlayOpacity = 1
  private compareMode: CompareMode = "composite"
  private dirty = false
  private frameHandle = 0
  private animationHandle = 0
  private destroyed = false
  private firstFullFrameFired = false
  private viewInteractionFired = false
  /** Tiles whose bitmap contradicts the manifest geometry — never drawn. */
  private readonly mismatchedTiles = new Set<string>()

  constructor(options: GpuViewerOptions) {
    this.options = options
    this.container = options.container
    this.canvas = document.createElement("canvas")
    this.canvas.style.position = "absolute"
    this.canvas.style.inset = "0"
    this.canvas.style.width = "100%"
    this.canvas.style.height = "100%"
    this.canvas.style.touchAction = "none"
    this.container.appendChild(this.canvas)

    this.basePyramid = new TilePyramid(options.source.baseUrl, options.source.manifest)
    this.applyOverlaySpec(options.overlay ?? null)

    this.loader = new TileLoader({
      credentials: options.credentials ?? "omit",
      onTileReady: () => this.invalidate(),
      onAuthError: () => this.options.onTileAuthError?.(),
    })

    this.camera.setImageSize(this.basePyramid.imageSize)
    this.syncViewportSize()

    this.gestures = attachGestures(
      this.canvas,
      {
        panByScreen: (dx, dy) => {
          this.cancelViewAnimation()
          this.camera.panByScreen(dx, dy)
          this.userViewChanged()
        },
        zoomBy: (factor, focal, animate) => {
          this.cancelViewAnimation()
          if (animate) {
            this.animateView((camera) => camera.zoomBy(factor, focal))
          } else {
            this.camera.zoomBy(factor, focal)
            this.userViewChanged()
          }
        },
      },
      options.gestures,
    )

    this.resizeObserver = new ResizeObserver(() => {
      this.syncViewportSize()
      this.viewChanged()
    })
    this.resizeObserver.observe(this.container)

    void this.boot()
    this.emitTransform()
  }

  private async boot(): Promise<void> {
    try {
      const renderer = await createSceneRenderer(this.canvas)
      if (this.destroyed) {
        renderer.destroy()
        return
      }
      this.renderer = renderer
      this.loader.setRenderer(renderer)
      renderer.resize(this.camera.viewportSize, this.dpr())
      this.invalidate()
    } catch (error) {
      console.error("[GpuDrawingViewer] Renderer init failed:", error)
    }
  }

  get backend(): "webgpu" | "webgl2" | null {
    return this.renderer?.backend ?? null
  }

  private dpr(): number {
    return typeof window === "undefined" ? 1 : window.devicePixelRatio || 1
  }

  private syncViewportSize(): void {
    const rect = this.container.getBoundingClientRect()
    const size = { width: Math.max(1, rect.width), height: Math.max(1, rect.height) }
    this.camera.setViewportSize(size)
    this.renderer?.resize(size, this.dpr())
  }

  private viewChanged(): void {
    this.emitTransform()
    this.invalidate()
  }

  /** A view change the user (or viewer chrome) caused — not resize/setSource. */
  private userViewChanged(): void {
    if (!this.viewInteractionFired) {
      this.viewInteractionFired = true
      this.options.onViewInteraction?.()
    }
    this.viewChanged()
  }

  private cancelViewAnimation(): void {
    if (this.animationHandle) cancelAnimationFrame(this.animationHandle)
    this.animationHandle = 0
  }

  /**
   * Glide the camera to wherever `mutate` lands it: scale interpolates
   * geometrically, center linearly, ease-out cubic over a fixed duration.
   * Any direct gesture cancels mid-flight.
   */
  private animateView(mutate: (camera: Camera2D) => void): void {
    this.cancelViewAnimation()
    const from = this.camera.getView()
    mutate(this.camera)
    const to = this.camera.getView()
    this.camera.setView(from)
    const start = performance.now()
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / VIEW_ANIMATION_MS)
      const ease = 1 - Math.pow(1 - t, 3)
      this.camera.setView({
        scale: from.scale * Math.pow(to.scale / from.scale, ease),
        centerX: from.centerX + (to.centerX - from.centerX) * ease,
        centerY: from.centerY + (to.centerY - from.centerY) * ease,
      })
      this.viewChanged()
      this.animationHandle = t < 1 ? requestAnimationFrame(step) : 0
    }
    this.userViewChanged()
    this.animationHandle = requestAnimationFrame(step)
  }

  private emitTransform(): void {
    this.options.onTransformChange?.({
      matrix: this.camera.matrix(),
      container: this.camera.viewportSize,
      zoom: this.camera.zoom,
    })
  }

  private invalidate(): void {
    if (this.dirty || this.destroyed) return
    this.dirty = true
    this.frameHandle = requestAnimationFrame(() => {
      this.dirty = false
      this.renderFrame()
    })
  }

  /**
   * Coarse-to-fine quads for one pyramid, mapped into base-image space.
   * Coarser levels cost at most a handful of tiles each, stay warm in the
   * LRU, and cover the viewport while the target level streams in.
   */
  private collectQuads(
    pyramid: TilePyramid,
    targetLevel: number,
  ): { quads: DrawQuad[]; targetComplete: boolean } {
    const baseSize = this.basePyramid.imageSize
    const scaleX = pyramid.imageSize.width / baseSize.width
    const scaleY = pyramid.imageSize.height / baseSize.height
    const visibleBase = this.camera.visibleImageRect()
    // Base-image space → this pyramid's image space.
    const visible = {
      x: visibleBase.x * scaleX,
      y: visibleBase.y * scaleY,
      width: visibleBase.width * scaleX,
      height: visibleBase.height * scaleY,
    }
    const quads: DrawQuad[] = []
    let targetComplete = true
    for (let level = 0; level <= targetLevel; level++) {
      for (const placement of pyramid.tilesInRect(level, visible)) {
        const texture = this.loader.get(placement.url)
        if (!texture) {
          // A permanently-failed tile is terminal — it must not pin the
          // "first full frame" signal (and the thumbnail behind it) forever.
          if (
            level === targetLevel &&
            !this.loader.isFailed(placement.url) &&
            !this.mismatchedTiles.has(placement.url)
          ) {
            targetComplete = false
          }
          continue
        }
        // Integrity guard: a bitmap that contradicts the manifest's tile
        // geometry means the pyramid on disk (or in a CDN cache) is from a
        // different render generation. Compositing it would paint the sheet
        // at the wrong scale — skip it and say so. Legacy single-image
        // pyramids are exempt (their manifest dims are only nominal).
        if (pyramid.levelCount > 1) {
          const levelScale = pyramid.levelScale(placement.level)
          const expectedW = placement.rect.width * levelScale
          const expectedH = placement.rect.height * levelScale
          if (
            Math.abs(texture.width - expectedW) > 1.5 ||
            Math.abs(texture.height - expectedH) > 1.5
          ) {
            if (!this.mismatchedTiles.has(placement.url)) {
              this.mismatchedTiles.add(placement.url)
              console.warn(
                `[viewer] Tile geometry mismatch (stale pyramid generation?): ${placement.url} is ${texture.width}×${texture.height}, expected ${Math.round(expectedW)}×${Math.round(expectedH)}`,
              )
            }
            continue
          }
        }
        quads.push({
          texture,
          rect: {
            x: placement.rect.x / scaleX,
            y: placement.rect.y / scaleY,
            width: placement.rect.width / scaleX,
            height: placement.rect.height / scaleY,
          },
        })
      }
    }
    return { quads, targetComplete }
  }

  private renderFrame(): void {
    const renderer = this.renderer
    if (!renderer || this.destroyed) return

    const dpr = this.dpr()
    const levelScale = this.camera.currentScale * Math.min(dpr, MAX_DPR_FOR_LEVEL)
    const baseLevel = this.basePyramid.levelForScale(levelScale)
    const base = this.collectQuads(this.basePyramid, baseLevel)

    let overlayQuads: DrawQuad[] = []
    let overlayComplete = true
    if (this.overlayPyramid) {
      const overlayLevel = this.overlayPyramid.levelForScale(levelScale)
      const overlay = this.collectQuads(this.overlayPyramid, overlayLevel)
      overlayQuads = overlay.quads
      overlayComplete = overlay.targetComplete
    }

    const { width, height } = this.basePyramid.imageSize
    renderer.render({
      matrix: this.camera.matrix(),
      viewport: this.camera.viewportSize,
      dpr,
      base: base.quads,
      overlay: overlayQuads,
      overlayOpacity: this.overlayOpacity,
      mode: this.compareMode,
      imageRect: { x: 0, y: 0, width, height },
    })

    if (!this.firstFullFrameFired && base.targetComplete && overlayComplete) {
      this.firstFullFrameFired = true
      this.options.onFirstFullFrame?.()
    }
  }

  // ---- Imperative API (the viewer chrome's handle) ------------------------

  setSource(source: TileSourceSpec, overlay?: OverlaySpec | null): void {
    this.cancelViewAnimation()
    this.basePyramid = new TilePyramid(source.baseUrl, source.manifest)
    this.applyOverlaySpec(overlay ?? null)
    this.firstFullFrameFired = false
    this.viewInteractionFired = false
    this.mismatchedTiles.clear()
    this.camera.setImageSize(this.basePyramid.imageSize)
    this.viewChanged()
  }

  private applyOverlaySpec(overlay: OverlaySpec | null): void {
    this.overlayPyramid = overlay
      ? new TilePyramid(overlay.source.baseUrl, overlay.source.manifest)
      : null
    this.overlayOpacity = overlay?.opacity ?? 1
    this.compareMode = overlay?.mode ?? "composite"
  }

  setOverlayOpacity(opacity: number): void {
    this.overlayOpacity = opacity
    this.invalidate()
  }

  setCompareMode(mode: CompareMode): void {
    this.compareMode = mode
    this.invalidate()
  }

  setGestureOptions(options: Partial<GestureOptions>): void {
    this.gestures.setOptions(options)
  }

  zoomBy(factor: number): void {
    this.animateView((camera) => camera.zoomBy(factor))
  }

  goHome(): void {
    this.animateView((camera) => camera.goHome())
  }

  zoomToActualSize(): void {
    this.animateView((camera) => camera.zoomToActualSize())
  }

  /** Post cookie re-mint: refetch failed tiles. */
  refreshTiles(): void {
    this.loader.retryFailed()
    this.invalidate()
  }

  destroy(): void {
    this.destroyed = true
    this.cancelViewAnimation()
    if (this.frameHandle) cancelAnimationFrame(this.frameHandle)
    this.resizeObserver.disconnect()
    this.gestures.destroy()
    this.loader.destroy()
    this.renderer?.destroy()
    this.renderer = null
    this.canvas.remove()
  }
}
