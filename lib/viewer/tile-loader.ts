import type { SceneRenderer, TileTexture } from "./types"

/**
 * Fetch → decode → GPU-upload pipeline with an LRU texture cache.
 *
 * `get()` is called from the frame builder for every tile it wants; a miss
 * queues a load and returns null, and `onTileReady` schedules the next frame
 * when the texture lands. Auth failures (cookie-protected tiles expiring
 * mid-session) surface once through `onAuthError`; after the cookie is
 * re-minted, `retryFailed()` clears the failure records so the next frame
 * re-requests them.
 */

export interface TileLoaderOptions {
  credentials: RequestCredentials
  onTileReady: () => void
  onAuthError: () => void
  /** LRU texture cap; ~600 × 512px tiles ≈ a few hundred MB of VRAM, max. */
  maxTiles?: number
  maxConcurrent?: number
}

interface CacheEntry {
  state: "loading" | "ready" | "failed"
  texture: TileTexture | null
}

const DEFAULT_MAX_TILES = 600
const DEFAULT_MAX_CONCURRENT = 12

export class TileLoader {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly queue: string[] = []
  private inFlight = 0
  private renderer: SceneRenderer | null = null
  private destroyed = false
  private authErrorReported = false

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
      return null
    }
    this.entries.set(url, { state: "loading", texture: null })
    this.queue.push(url)
    this.pump()
    return null
  }

  private pump(): void {
    if (!this.renderer || this.destroyed) return
    const maxConcurrent = this.options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT
    while (this.inFlight < maxConcurrent && this.queue.length > 0) {
      const url = this.queue.shift()
      if (!url) break
      const entry = this.entries.get(url)
      if (!entry || entry.state !== "loading") continue
      this.inFlight++
      this.load(url, entry).finally(() => {
        this.inFlight--
        this.pump()
      })
    }
  }

  private async load(url: string, entry: CacheEntry): Promise<void> {
    try {
      const response = await fetch(url, {
        credentials: this.options.credentials,
        mode: "cors",
      })
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          if (!this.authErrorReported) {
            this.authErrorReported = true
            this.options.onAuthError()
          }
        }
        entry.state = "failed"
        return
      }
      const bitmap = await createImageBitmap(await response.blob())
      const renderer = this.renderer
      if (!renderer || this.destroyed || this.entries.get(url) !== entry) {
        bitmap.close()
        return
      }
      entry.texture = renderer.uploadTile(bitmap)
      entry.state = "ready"
      bitmap.close()
      this.evict()
      this.options.onTileReady()
    } catch (error) {
      entry.state = "failed"
      console.warn(`[viewer] Tile load failed: ${url}`, error)
    }
  }

  /** A load that ended in failure — terminal until retryFailed() clears it. */
  isFailed(url: string): boolean {
    return this.entries.get(url)?.state === "failed"
  }

  /** Forget failures (post cookie re-mint) so the next frame refetches. */
  retryFailed(): void {
    this.authErrorReported = false
    for (const [url, entry] of this.entries) {
      if (entry.state === "failed") this.entries.delete(url)
    }
  }

  private evict(): void {
    const maxTiles = this.options.maxTiles ?? DEFAULT_MAX_TILES
    while (this.entries.size > maxTiles) {
      // Map iteration order = insertion order; get() re-inserts on hit, so
      // the first ready entry is the least recently used.
      let evicted = false
      for (const [url, entry] of this.entries) {
        if (entry.state !== "ready") continue
        this.entries.delete(url)
        if (entry.texture) this.renderer?.destroyTile(entry.texture)
        evicted = true
        break
      }
      if (!evicted) return
    }
  }

  destroy(): void {
    this.destroyed = true
    this.queue.length = 0
    for (const entry of this.entries.values()) {
      if (entry.texture) this.renderer?.destroyTile(entry.texture)
    }
    this.entries.clear()
  }
}
