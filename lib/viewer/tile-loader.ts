import type { SceneRenderer, TileTexture } from "./types"

/**
 * Fetch → decode → GPU-upload pipeline with a byte-budgeted LRU texture cache.
 *
 * `get()` is called from the frame builder for every tile it wants; a miss
 * queues a load and returns null, and `onTileReady` schedules the next frame
 * when the texture lands. `prefetch()` queues speculative loads that only run
 * once the visible queue is drained, so prefetching can never delay a visible
 * tile. Auth failures (cookie-protected tiles expiring mid-session) surface
 * once through `onAuthError`; after the cookie is re-minted, `retryFailed()`
 * clears the failure records so the next frame re-requests them. Other
 * failures surface through `onSustainedFailure` once enough distinct tiles
 * have failed for the current source.
 *
 * The budget counts decoded RGBA bytes (width × height × 4) of uploaded
 * textures — the actual VRAM footprint — not tile counts. Loading and failed
 * entries carry no bytes and cannot push past it. Nothing is retained across
 * `release()` (sheet switches refetch through the HTTP cache).
 */

export interface TileLoaderOptions {
  credentials: RequestCredentials
  onTileReady: () => void
  onAuthError: () => void
  /**
   * Fired once per source epoch (reset by release()/retryFailed()) when
   * distinct non-auth tile failures reach the sustained-failure threshold.
   */
  onSustainedFailure?: (failedCount: number) => void
  /** GPU texture budget in decoded RGBA bytes. Default 256 MiB. */
  maxCacheBytes?: number
  maxConcurrent?: number
}

export interface TileLoaderStats {
  /** Rolling fetch → decode → upload latency samples in ms, oldest first. */
  latencySamplesMs: readonly number[]
  /** Failed tile loads over the loader's lifetime. */
  failureCount: number
  currentBytes: number
  peakBytes: number
}

interface CacheEntry {
  state: "loading" | "ready" | "failed"
  texture: TileTexture | null
  /** Decoded RGBA footprint once uploaded (width × height × 4), else 0. */
  bytes: number
  priority: "visible" | "prefetch"
  inFlight: boolean
}

const DEFAULT_MAX_CACHE_BYTES = 256 * 1024 * 1024
const DEFAULT_MAX_CONCURRENT = 12
/** Distinct failed tiles (per source epoch) that count as sustained failure. */
const SUSTAINED_FAILURE_THRESHOLD = 3
/** Failed entries are terminal markers; beyond this the oldest are dropped. */
const MAX_FAILED_ENTRIES = 300
const MAX_LATENCY_SAMPLES = 120

export class TileLoader {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly visibleQueue: string[] = []
  private readonly prefetchQueue: string[] = []
  private inFlight = 0
  private renderer: SceneRenderer | null = null
  private destroyed = false
  private authErrorReported = false
  private currentBytes = 0
  private peakBytes = 0
  private failureCount = 0
  /** Distinct non-auth failures this source epoch (sustained-failure gate). */
  private epochFailures = 0
  private readonly latencySamples: number[] = []

  constructor(private readonly options: TileLoaderOptions) {}

  /** The renderer arrives async (backend negotiation); loads wait for it. */
  setRenderer(renderer: SceneRenderer | null): void {
    this.renderer = renderer
    if (renderer) this.pump()
  }

  /** Texture for a tile URL, or null (queueing the load on first miss). */
  get(url: string): TileTexture | null {
    const entry = this.entries.get(url)
    if (entry) {
      if (entry.state === "ready" && entry.texture) {
        // LRU bump.
        this.entries.delete(url)
        this.entries.set(url, entry)
        return entry.texture
      }
      if (entry.state === "loading" && entry.priority === "prefetch") {
        // A prefetched tile became visible — promote it past the low queue.
        entry.priority = "visible"
        if (!entry.inFlight) this.visibleQueue.push(url)
      }
      return null
    }
    this.entries.set(url, {
      state: "loading",
      texture: null,
      bytes: 0,
      priority: "visible",
      inFlight: false,
    })
    this.visibleQueue.push(url)
    this.pump()
    return null
  }

  /** Speculative load; runs only when no visible tile is waiting. */
  prefetch(url: string): void {
    if (this.destroyed || this.entries.has(url)) return
    this.entries.set(url, {
      state: "loading",
      texture: null,
      bytes: 0,
      priority: "prefetch",
      inFlight: false,
    })
    this.prefetchQueue.push(url)
    this.pump()
  }

  private dequeue(): { url: string; entry: CacheEntry } | null {
    while (this.visibleQueue.length > 0) {
      const url = this.visibleQueue.shift()
      if (!url) continue
      const entry = this.entries.get(url)
      if (entry && entry.state === "loading" && !entry.inFlight) return { url, entry }
    }
    while (this.prefetchQueue.length > 0) {
      const url = this.prefetchQueue.shift()
      if (!url) continue
      const entry = this.entries.get(url)
      // A promoted entry's stale low-queue copy is skipped here (priority
      // check) and served from the visible queue instead.
      if (
        entry &&
        entry.state === "loading" &&
        !entry.inFlight &&
        entry.priority === "prefetch"
      ) {
        return { url, entry }
      }
    }
    return null
  }

  private pump(): void {
    if (!this.renderer || this.destroyed) return
    const maxConcurrent = this.options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT
    while (this.inFlight < maxConcurrent) {
      const next = this.dequeue()
      if (!next) return
      next.entry.inFlight = true
      this.inFlight++
      this.load(next.url, next.entry).finally(() => {
        this.inFlight--
        this.pump()
      })
    }
  }

  private async load(url: string, entry: CacheEntry): Promise<void> {
    const startedAt = performance.now()
    try {
      const response = await fetch(url, {
        credentials: this.options.credentials,
        mode: "cors",
      })
      if (!response.ok) {
        const isAuth = response.status === 401 || response.status === 403
        if (isAuth && !this.authErrorReported) {
          this.authErrorReported = true
          this.options.onAuthError()
        }
        this.recordFailure(url, entry, isAuth)
        return
      }
      const bitmap = await createImageBitmap(await response.blob())
      const renderer = this.renderer
      if (!renderer || this.destroyed || this.entries.get(url) !== entry) {
        bitmap.close()
        return
      }
      const texture = renderer.uploadTile(bitmap)
      bitmap.close()
      entry.texture = texture
      entry.state = "ready"
      entry.bytes = texture.width * texture.height * 4
      this.currentBytes += entry.bytes
      if (this.currentBytes > this.peakBytes) this.peakBytes = this.currentBytes
      this.recordLatency(performance.now() - startedAt)
      this.evict()
      this.options.onTileReady()
    } catch {
      this.recordFailure(url, entry, false)
    }
  }

  private recordFailure(url: string, entry: CacheEntry, isAuth: boolean): void {
    // A load that lost its entry (release() mid-flight) is not a failure of
    // the current source — don't let it trip the sustained-failure gate.
    if (this.destroyed || this.entries.get(url) !== entry) return
    entry.state = "failed"
    this.failureCount++
    if (isAuth) return
    this.epochFailures++
    if (this.epochFailures === SUSTAINED_FAILURE_THRESHOLD) {
      this.options.onSustainedFailure?.(this.epochFailures)
    }
  }

  private recordLatency(latencyMs: number): void {
    this.latencySamples.push(latencyMs)
    if (this.latencySamples.length > MAX_LATENCY_SAMPLES) this.latencySamples.shift()
  }

  /** A load that ended in failure — terminal until retryFailed() clears it. */
  isFailed(url: string): boolean {
    return this.entries.get(url)?.state === "failed"
  }

  /** Forget failures (post cookie re-mint) so the next frame refetches. */
  retryFailed(): void {
    this.authErrorReported = false
    this.epochFailures = 0
    for (const [url, entry] of this.entries) {
      if (entry.state === "failed") this.entries.delete(url)
    }
  }

  stats(): TileLoaderStats {
    return {
      latencySamplesMs: [...this.latencySamples],
      failureCount: this.failureCount,
      currentBytes: this.currentBytes,
      peakBytes: this.peakBytes,
    }
  }

  private evict(): void {
    // Failed entries are kept as terminal markers for the current source but
    // must not accumulate without bound — drop the oldest past the cap.
    let failedCount = 0
    for (const entry of this.entries.values()) {
      if (entry.state === "failed") failedCount++
    }
    if (failedCount > MAX_FAILED_ENTRIES) {
      for (const [url, entry] of this.entries) {
        if (entry.state !== "failed") continue
        this.entries.delete(url)
        failedCount--
        if (failedCount <= MAX_FAILED_ENTRIES) break
      }
    }
    const budget = this.options.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES
    while (this.currentBytes > budget) {
      // Map iteration order = insertion order; get() re-inserts on hit, so
      // the first ready entry is the least recently used.
      let evicted = false
      for (const [url, entry] of this.entries) {
        if (entry.state !== "ready" || !entry.texture) continue
        this.entries.delete(url)
        this.currentBytes -= entry.bytes
        this.renderer?.destroyTile(entry.texture)
        evicted = true
        break
      }
      if (!evicted) return
    }
  }

  /**
   * Free every texture and queued load — sheet switch or device loss. Peak
   * bytes, latency samples, and the lifetime failure count survive (they are
   * telemetry, not cache state); the sustained-failure epoch resets.
   */
  release(): void {
    this.visibleQueue.length = 0
    this.prefetchQueue.length = 0
    for (const entry of this.entries.values()) {
      if (entry.texture) this.renderer?.destroyTile(entry.texture)
    }
    this.entries.clear()
    this.currentBytes = 0
    this.epochFailures = 0
    this.authErrorReported = false
  }

  destroy(): void {
    this.destroyed = true
    this.release()
  }
}
