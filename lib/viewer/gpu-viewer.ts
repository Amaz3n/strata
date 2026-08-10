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
 * components/drawings/viewer/tiled-drawing-viewer.tsx. Failures and telemetry
 * surface only through the `onError` / `onMetrics` callbacks; this module
 * never owns UI or transport.
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

/**
 * Structured failure channel for the React layer.
 *  - `renderer-unavailable`: no GPU backend could be created — terminal.
 *  - `device-lost`: the GPU device/context died. `recovering: true` means an
 *    automatic rebuild is in flight; `false` means retries are exhausted and
 *    the viewer is terminally blank.
 *  - `tiles-unauthorized`: tile fetches hit 401/403 (expired cookie). Fired
 *    alongside `onTileAuthError`, which remains the re-mint hook.
 *  - `tiles-failed`: sustained tile failure — `failedCount` distinct tiles of
 *    the current source have failed for non-auth reasons.
 */
export type ViewerError =
  | { type: "renderer-unavailable"; message: string }
  | {
      type: "device-lost"
      backend: "webgpu" | "webgl2"
      reason: string
      recovering: boolean
    }
  | { type: "tiles-unauthorized" }
  | { type: "tiles-failed"; failedCount: number }

/**
 * Telemetry snapshot, emitted through `onMetrics` at load milestones (first
 * tile, first full frame), on source switch, and on destroy. Emit-only — the
 * consumer owns aggregation and transport.
 */
export interface ViewerMetrics {
  /** ms from source load start to the first tile texture landing. */
  timeToFirstTileMs: number | null
  /** ms from source load start to the first frame with every target tile. */
  timeToFirstFullFrameMs: number | null
  /** Rolling fetch → decode → upload latency samples (ms), oldest first. */
  tileLoadLatencyMs: readonly number[]
  /** Failed tile loads over the viewer's lifetime. */
  tileFailureCount: number
  /** High-water mark of decoded tile bytes resident on the GPU. */
  peakCacheBytes: number
}

export interface GpuViewerOptions {
  container: HTMLElement
  source: TileSourceSpec
  overlay?: OverlaySpec | null
  credentials?: RequestCredentials
  gestures?: Partial<GestureOptions>
  /** GPU tile-cache budget in decoded RGBA bytes. Default 256 MiB. */
  maxCacheBytes?: number
  onTransformChange?: (transform: ViewerTransform) => void
  /** First frame where every target-level tile in view has drawn. Per source. */
  onFirstFullFrame?: () => void
  /**
   * First pan/zoom by the user (or viewer chrome) after a source loads. The
   * thumbnail-first backdrop is only aligned with the home view — the wrapper
   * uses this to drop it the moment the camera moves.
   */
  onViewInteraction?: () => void
  /** Cookie re-mint hook; `onError` also reports `tiles-unauthorized`. */
  onTileAuthError?: () => void
  /** Structured failures. Without it they fall back to console.error. */
  onError?: (error: ViewerError) => void
  onMetrics?: (metrics: ViewerMetrics) => void
}

/**
 * Cap devicePixelRatio for level selection AND the drawing buffer: retina
 * sharpness is worth fetching one level deeper, but a DPR-3 phone must not
 * pay for a 3× framebuffer. One choke point — renderers size themselves from
 * whatever dpr the viewer hands them.
 */
const MAX_RENDER_DPR = 2

/** Discrete zoom glide (buttons, double-click, home). */
const VIEW_ANIMATION_MS = 200

/**
 * Device-loss recovery attempts for the viewer's lifetime — a flapping GPU
 * (TDR loop) must not spin re-negotiation forever. Deliberately not reset on
 * success.
 */
const MAX_DEVICE_RECOVERY_ATTEMPTS = 2

/** Give a crashed GPU process a beat to come back before renegotiating. */
const DEVICE_RECOVERY_DELAY_MS = 250

/** Minimum screen-space pan speed (CSS px/ms) before prefetching ahead. */
const PREFETCH_MIN_SPEED_PX_MS = 0.1

/** Pan samples older than this say nothing about current travel. */
const PREFETCH_MAX_SAMPLE_AGE_MS = 300

export class GpuDrawingViewer {
  private readonly container: HTMLElement
  private readonly camera = new Camera2D()
  private readonly loader: TileLoader
  private readonly resizeObserver: ResizeObserver
  private readonly options: GpuViewerOptions

  private canvas: HTMLCanvasElement
  private gestures: GestureController
  private readonly gestureOptions: Partial<GestureOptions>
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
  private recovering = false
  private recoveryAttempts = 0
  private sourceStartTime = performance.now()
  private firstTileTime: number | null = null
  private firstFullFrameTime: number | null = null
  private lastPanSample: { x: number; y: number; time: number } | null = null
  /** Tiles whose bitmap contradicts the manifest geometry — never drawn. */
  private readonly mismatchedTiles = new Set<string>()

  constructor(options: GpuViewerOptions) {
    this.options = options
    this.container = options.container
    this.gestureOptions = { ...options.gestures }
    this.canvas = this.createCanvas()
    this.container.appendChild(this.canvas)

    this.basePyramid = new TilePyramid(options.source.baseUrl, options.source.manifest)
    this.applyOverlaySpec(options.overlay ?? null)

    this.loader = new TileLoader({
      credentials: options.credentials ?? "omit",
      onTileReady: () => {
        if (this.firstTileTime === null) {
          this.firstTileTime = performance.now() - this.sourceStartTime
          this.emitMetrics()
        }
        this.invalidate()
      },
      onAuthError: () => {
        this.reportError({ type: "tiles-unauthorized" })
        this.options.onTileAuthError?.()
      },
      onSustainedFailure: (failedCount) =>
        this.reportError({ type: "tiles-failed", failedCount }),
      maxCacheBytes: options.maxCacheBytes,
    })

    this.camera.setImageSize(this.basePyramid.imageSize)
    this.syncViewportSize()

    this.gestures = this.attachGestureHost()

    this.resizeObserver = new ResizeObserver(() => {
      this.syncViewportSize()
      this.viewChanged()
    })
    this.resizeObserver.observe(this.container)

    void this.boot()
    this.emitTransform()
  }

  private createCanvas(): HTMLCanvasElement {
    const canvas = document.createElement("canvas")
    canvas.style.position = "absolute"
    canvas.style.inset = "0"
    canvas.style.width = "100%"
    canvas.style.height = "100%"
    canvas.style.touchAction = "none"
    return canvas
  }

  private attachGestureHost(): GestureController {
    return attachGestures(
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
      this.gestureOptions,
    )
  }

  private async boot(): Promise<void> {
    try {
      const renderer = await createSceneRenderer(this.canvas)
      if (this.destroyed) {
        renderer.destroy()
        return
      }
      renderer.onDeviceLost = (reason) => this.handleDeviceLoss(renderer.backend, reason)
      this.renderer = renderer
      this.loader.setRenderer(renderer)
      renderer.resize(this.camera.viewportSize, this.dpr())
      this.invalidate()
    } catch (error) {
      this.reportError({
        type: "renderer-unavailable",
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * A lost device takes every uploaded texture with it. Tear the dead backend
   * down, re-negotiate on a fresh canvas, and let the frame path re-request
   * visible tiles (refetches ride the HTTP cache). Each loss consumes one
   * capped recovery attempt; a re-negotiation that itself fails is terminal —
   * createSceneRenderer already exhausted every backend.
   */
  private handleDeviceLoss(backend: "webgpu" | "webgl2", reason: string): void {
    if (this.destroyed || this.recovering) return
    // Release before detaching the renderer so destroyTile still runs (a
    // no-op on the dead device, but it keeps the accounting uniform).
    this.loader.release()
    this.loader.setRenderer(null)
    if (this.renderer) {
      this.renderer.onDeviceLost = null
      this.renderer.destroy()
      this.renderer = null
    }
    if (this.recoveryAttempts >= MAX_DEVICE_RECOVERY_ATTEMPTS) {
      this.reportError({ type: "device-lost", backend, reason, recovering: false })
      return
    }
    this.recoveryAttempts++
    this.recovering = true
    this.reportError({ type: "device-lost", backend, reason, recovering: true })
    void this.recoverRenderer()
  }

  private async recoverRenderer(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, DEVICE_RECOVERY_DELAY_MS))
    if (this.destroyed) {
      this.recovering = false
      return
    }
    // A context-claimed canvas cannot renegotiate backends — start clean.
    this.replaceCanvas()
    await this.boot()
    this.recovering = false
  }

  private replaceCanvas(): void {
    this.gestures.destroy()
    this.canvas.remove()
    this.canvas = this.createCanvas()
    this.container.appendChild(this.canvas)
    this.gestures = this.attachGestureHost()
  }

  get backend(): "webgpu" | "webgl2" | null {
    return this.renderer?.backend ?? null
  }

  private dpr(): number {
    if (typeof window === "undefined") return 1
    return Math.min(window.devicePixelRatio || 1, MAX_RENDER_DPR)
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

  private reportError(error: ViewerError): void {
    if (this.options.onError) {
      this.options.onError(error)
    } else {
      console.error("[GpuDrawingViewer]", error)
    }
  }

  private emitMetrics(): void {
    if (!this.options.onMetrics) return
    const stats = this.loader.stats()
    this.options.onMetrics({
      timeToFirstTileMs: this.firstTileTime,
      timeToFirstFullFrameMs: this.firstFullFrameTime,
      tileLoadLatencyMs: stats.latencySamplesMs,
      tileFailureCount: stats.failureCount,
      peakCacheBytes: stats.peakBytes,
    })
  }

  private invalidate(): void {
    if (this.dirty || this.destroyed) return
    this.dirty = true
    this.frameHandle = requestAnimationFrame(() => {
      this.dirty = false
      this.frameHandle = 0
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
          if (
            Math.abs(texture.width - placement.size.width) > 1 ||
            Math.abs(texture.height - placement.size.height) > 1
          ) {
            if (!this.mismatchedTiles.has(placement.url)) {
              this.mismatchedTiles.add(placement.url)
              console.warn(
                `[viewer] Tile geometry mismatch (stale pyramid generation?): ${placement.url} is ${texture.width}×${texture.height}, expected ${placement.size.width}×${placement.size.height}`,
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

  /**
   * Directional prefetch: when the camera is traveling, queue the ring of
   * target-level tiles one tile-span ahead in the direction of travel. These
   * ride the loader's low-priority queue, so they can never delay a visible
   * tile; already-cached and already-queued tiles are no-ops.
   */
  private prefetchAhead(targetLevel: number): void {
    const visible = this.camera.visibleImageRect()
    const now = performance.now()
    const previous = this.lastPanSample
    this.lastPanSample = { x: visible.x, y: visible.y, time: now }
    if (!previous) return
    const dt = now - previous.time
    if (dt <= 0 || dt > PREFETCH_MAX_SAMPLE_AGE_MS) return
    const scale = this.camera.currentScale
    const vx = ((visible.x - previous.x) * scale) / dt
    const vy = ((visible.y - previous.y) * scale) / dt
    if (Math.hypot(vx, vy) < PREFETCH_MIN_SPEED_PX_MS) return
    const levelSize = this.basePyramid.levelSize(targetLevel)
    const spanX =
      (this.basePyramid.tileSize * this.basePyramid.imageSize.width) / levelSize.width
    const spanY =
      (this.basePyramid.tileSize * this.basePyramid.imageSize.height) / levelSize.height
    const ahead = {
      x: visible.x + Math.sign(vx) * spanX,
      y: visible.y + Math.sign(vy) * spanY,
      width: visible.width,
      height: visible.height,
    }
    for (const placement of this.basePyramid.tilesInRect(targetLevel, ahead)) {
      this.loader.prefetch(placement.url)
    }
  }

  private renderFrame(): void {
    const renderer = this.renderer
    if (!renderer || this.destroyed) return

    const dpr = this.dpr()
    const levelScale = this.camera.currentScale * dpr
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

    this.prefetchAhead(baseLevel)

    if (!this.firstFullFrameFired && base.targetComplete && overlayComplete) {
      this.firstFullFrameFired = true
      this.firstFullFrameTime = performance.now() - this.sourceStartTime
      this.emitMetrics()
      this.options.onFirstFullFrame?.()
    }
  }

  // ---- Imperative API (the viewer chrome's handle) ------------------------

  setSource(source: TileSourceSpec, overlay?: OverlaySpec | null): void {
    this.cancelViewAnimation()
    // Final snapshot for the outgoing source, then free its GPU memory.
    this.emitMetrics()
    this.loader.release()
    this.basePyramid = new TilePyramid(source.baseUrl, source.manifest)
    this.applyOverlaySpec(overlay ?? null)
    this.firstFullFrameFired = false
    this.viewInteractionFired = false
    this.mismatchedTiles.clear()
    this.sourceStartTime = performance.now()
    this.firstTileTime = null
    this.firstFullFrameTime = null
    this.lastPanSample = null
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
    Object.assign(this.gestureOptions, options)
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

  /**
   * Bring a region of the sheet into view, centered.
   *
   * Used to walk in-sheet search hits. It only ever zooms IN toward
   * `minScale`: a user hunting for a schedule mark has already chosen a
   * reading zoom, and yanking them back out to fit the match would lose the
   * context they came in with.
   */
  revealImageRect(
    rect: { x: number; y: number; width: number; height: number },
    options?: { minScale?: number },
  ): void {
    if (rect.width <= 0 || rect.height <= 0) return
    const centerX = rect.x + rect.width / 2
    const centerY = rect.y + rect.height / 2
    const minScale = options?.minScale
    this.animateView((camera) => {
      const view = camera.getView()
      const scale = minScale && view.scale < minScale ? minScale : view.scale
      camera.setView({ scale, centerX, centerY })
    })
  }

  /** Post cookie re-mint: refetch failed tiles. */
  refreshTiles(): void {
    this.loader.retryFailed()
    this.invalidate()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.emitMetrics()
    this.cancelViewAnimation()
    if (this.frameHandle) cancelAnimationFrame(this.frameHandle)
    this.frameHandle = 0
    this.resizeObserver.disconnect()
    this.gestures.destroy()
    this.loader.destroy()
    if (this.renderer) {
      this.renderer.onDeviceLost = null
      this.renderer.destroy()
      this.renderer = null
    }
    this.canvas.remove()
  }
}
