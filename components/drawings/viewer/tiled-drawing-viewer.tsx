"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { cn } from "@/lib/utils"

type OpenSeadragonNS = any

export type TileManifest = {
  Image: {
    xmlns?: string
    Format: string
    Overlap: number
    TileSize: number
    Size: { Width: number; Height: number }
  }
  // Non-standard helper written by our worker for reliable level detection.
  Levels?: number
}

export interface FallbackImageViewerProps {
  imageUrl: string
  className?: string
  onReady?: () => void
}

export type ImageToScreenMatrix = {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

export interface TiledDrawingViewerProps {
  tileBaseUrl: string
  tileManifest: TileManifest
  className?: string
  onReady?: (viewer: any | null) => void
  onTransformChange?: (args: {
    matrix: ImageToScreenMatrix
    container: { width: number; height: number }
    zoom: number
  }) => void
  thumbnailUrl?: string // Fallback for when tiles don't exist
  /**
   * Optional second tiled image composited over the base image (used by the
   * drawings comparison overlay). Opacity is 0..1 and updates live via
   * setOpacity() without rebuilding the viewer or re-opening tile sources.
   */
  overlaySource?: {
    tileBaseUrl: string
    tileManifest: TileManifest
    opacity: number
  }
  /**
   * Route that mints the arc_tiles cookie for this viewer's audience.
   * Defaults to the authed app endpoint; portals pass their token-scoped
   * endpoint (/api/portal/drawings/[token]/tiles-cookie).
   */
  tilesCookieEndpoint?: string
}

function buildMatrix(args: {
  p00: { x: number; y: number }
  p10: { x: number; y: number }
  p01: { x: number; y: number }
  imageWidth: number
  imageHeight: number
}): ImageToScreenMatrix {
  const { p00, p10, p01, imageWidth, imageHeight } = args

  const a = (p10.x - p00.x) / imageWidth
  const b = (p10.y - p00.y) / imageWidth
  const c = (p01.x - p00.x) / imageHeight
  const d = (p01.y - p00.y) / imageHeight
  const e = p00.x
  const f = p00.y

  return { a, b, c, d, e, f }
}

function normalizeFormat(value?: string) {
  const normalized = (value ?? "png").trim().toLowerCase()
  return normalized || "png"
}

function buildRenderableTileBaseUrl(baseUrl: string, secureTilesEnabled: boolean) {
  if (typeof window === "undefined") return baseUrl
  if (!secureTilesEnabled) return baseUrl

  const host = window.location.hostname.toLowerCase()
  const isProductionAppHost =
    host === "app.arcnaples.com" || host.endsWith(".arcnaples.com")

  if (isProductionAppHost) return baseUrl

  try {
    const parsed = new URL(baseUrl)
    const marker = "/drawings-tiles/"
    const index = parsed.pathname.indexOf(marker)
    if (index === -1) return baseUrl
    const path = parsed.pathname.slice(index + marker.length)
    return `/api/drawings/tiles/${path}`
  } catch {
    return baseUrl
  }
}

/**
 * Convert a raw drawings CDN url (tile base, thumbnail.png, etc.) into a URL the
 * browser can actually load. Raw cdn.arcnaples.com urls are auth-protected and
 * 401 off the production host (e.g. on localhost), so we route them through the
 * authenticated /api/drawings/tiles proxy. Mirrors the viewer's tile handling.
 */
export function toRenderableDrawingsUrl(
  url?: string | null,
): string | undefined {
  if (!url) return undefined
  const secure = process.env.NEXT_PUBLIC_DRAWINGS_TILES_SECURE === "true"
  return buildRenderableTileBaseUrl(url, secure)
}

// ---------------------------------------------------------------------------
// Tiles cookie: POST once per session, shared across every mounted viewer.
// The cookie has a 1h TTL, so mounted viewers also refresh it on an interval
// (see the refresh effect below) and re-POST on suspected auth failures.
// Memoized per endpoint: the authed app and token-authenticated portals mint
// the same cookie from different routes.
// ---------------------------------------------------------------------------

const DEFAULT_TILES_COOKIE_ENDPOINT = "/api/drawings/tiles-cookie"

const TILES_COOKIE_REFRESH_MS = 45 * 60 * 1000
// If tile loads fail while the cookie is younger than this, the failure is
// almost certainly not auth expiry — skip the recovery round trip.
const TILES_COOKIE_FRESH_MS = 60 * 1000

type TilesCookieState = { promise: Promise<void> | null; setAt: number }
const tilesCookieStates = new Map<string, TilesCookieState>()

function getTilesCookieState(endpoint: string): TilesCookieState {
  let state = tilesCookieStates.get(endpoint)
  if (!state) {
    state = { promise: null, setAt: 0 }
    tilesCookieStates.set(endpoint, state)
  }
  return state
}

function ensureTilesCookie(endpoint: string, options?: { force?: boolean }): Promise<void> {
  const state = getTilesCookieState(endpoint)
  if (!options?.force && state.promise) return state.promise

  const promise = fetch(endpoint, {
    method: "POST",
    credentials: "include",
  })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Failed to set tiles cookie: HTTP ${response.status}`)
      }
      state.setAt = Date.now()
    })
    .catch((error) => {
      // Allow the next caller to retry instead of caching the failure forever.
      if (state.promise === promise) state.promise = null
      throw error
    })

  state.promise = promise
  return promise
}

export function TiledDrawingViewer({
  tileBaseUrl,
  tileManifest,
  className,
  onReady,
  onTransformChange,
  thumbnailUrl,
  overlaySource,
  tilesCookieEndpoint = DEFAULT_TILES_COOKIE_ENDPOINT,
}: TiledDrawingViewerProps) {
  const secureTilesEnabled = process.env.NEXT_PUBLIC_DRAWINGS_TILES_SECURE === "true"
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<any | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const imageSizeRef = useRef<{ width: number; height: number } | null>(null)
  const onReadyRef = useRef<TiledDrawingViewerProps["onReady"]>(onReady)
  const onTransformChangeRef = useRef<TiledDrawingViewerProps["onTransformChange"]>(onTransformChange)
  const lastAuthRecoveryAtRef = useRef(0)

  // Thumbnail-first render: show the sheet thumbnail behind the OSD canvas so
  // the user never stares at a blank surface while tiles stream in.
  const [thumbnailHidden, setThumbnailHidden] = useState(false)
  const renderableThumbnailUrl = useMemo(
    () => (thumbnailUrl ? buildRenderableTileBaseUrl(thumbnailUrl, secureTilesEnabled) : undefined),
    [secureTilesEnabled, thumbnailUrl]
  )

  const imageSize = useMemo(() => {
    const w = tileManifest?.Image?.Size?.Width ?? 1
    const h = tileManifest?.Image?.Size?.Height ?? 1
    return { width: w, height: h }
  }, [tileManifest])
  const renderableTileBaseUrl = useMemo(
    () => buildRenderableTileBaseUrl(tileBaseUrl, secureTilesEnabled),
    [secureTilesEnabled, tileBaseUrl]
  )
  const overlayTileBaseUrl = overlaySource?.tileBaseUrl
  const overlayManifest = overlaySource?.tileManifest
  const overlayOpacity = overlaySource?.opacity
  const renderableOverlayBaseUrl = useMemo(
    () =>
      overlayTileBaseUrl
        ? buildRenderableTileBaseUrl(overlayTileBaseUrl, secureTilesEnabled)
        : undefined,
    [secureTilesEnabled, overlayTileBaseUrl]
  )

  useEffect(() => {
    imageSizeRef.current = imageSize
  }, [imageSize])

  useEffect(() => {
    onReadyRef.current = onReady
  }, [onReady])

  useEffect(() => {
    onTransformChangeRef.current = onTransformChange
  }, [onTransformChange])

  const buildTileSource = useCallback(
    (baseUrl: string, manifest: TileManifest) => {
      const width = manifest?.Image?.Size?.Width ?? 1
      const height = manifest?.Image?.Size?.Height ?? 1
      const format = normalizeFormat(manifest?.Image?.Format)
      const explicitLevels =
        typeof manifest?.Levels === "number" && Number.isFinite(manifest.Levels)
          ? Math.max(1, Math.floor(manifest.Levels))
          : null

      // Backward compatibility:
      // Legacy manifests had no level metadata and only one file at /tiles/0/0_0.png.
      if (!explicitLevels || explicitLevels <= 1) {
        return {
          type: "image",
          url: `${baseUrl}/tiles/0/0_0.${format}`,
          buildPyramid: false,
        }
      }

      const maxLevel = explicitLevels - 1
      const tileSize = Math.max(1, manifest?.Image?.TileSize ?? 512)
      const overlap = Math.max(0, manifest?.Image?.Overlap ?? 0)

      return {
        width,
        height,
        minLevel: 0,
        maxLevel,
        tileSize,
        tileOverlap: overlap,
        getTileUrl: (level: number, x: number, y: number) =>
          `${baseUrl}/tiles/${level}/${x}_${y}.${format}`,
      }
    },
    []
  )

  // Latest tile source inputs, readable from the mount-once boot effect.
  const tileSourceRef = useRef<{ baseUrl: string; manifest: TileManifest }>({
    baseUrl: renderableTileBaseUrl,
    manifest: tileManifest,
  })
  useEffect(() => {
    tileSourceRef.current = { baseUrl: renderableTileBaseUrl, manifest: tileManifest }
  }, [renderableTileBaseUrl, tileManifest])

  const overlaySourceRef = useRef<{ baseUrl: string; manifest: TileManifest } | null>(null)
  const overlayOpacityRef = useRef(overlayOpacity ?? 1)
  useEffect(() => {
    overlaySourceRef.current =
      renderableOverlayBaseUrl && overlayManifest
        ? { baseUrl: renderableOverlayBaseUrl, manifest: overlayManifest }
        : null
  }, [renderableOverlayBaseUrl, overlayManifest])

  // Compose the open() payload: base image plus (optionally) the overlay image.
  const composeTileSources = useCallback(() => {
    const { baseUrl, manifest } = tileSourceRef.current
    const overlay = overlaySourceRef.current
    const sources: any[] = [buildTileSource(baseUrl, manifest)]
    if (overlay) {
      sources.push({
        tileSource: buildTileSource(overlay.baseUrl, overlay.manifest),
        opacity: overlayOpacityRef.current,
      })
    }
    return sources
  }, [buildTileSource])

  // Create the OSD viewer ONCE per component mount. Sheet changes reuse the
  // instance via viewer.open() (see the effect below) instead of destroy/recreate.
  useEffect(() => {
    if (!containerRef.current || viewerRef.current) return

    let disposed = false
    let viewer: any | null = null

    const boot = async () => {
      // Avoid importing openseadragon during SSR/module evaluation:
      // it touches `document` at import-time.
      // Start the cookie POST and the module import concurrently.
      const [mod] = await Promise.all([
        import("openseadragon") as Promise<any>,
        secureTilesEnabled ? ensureTilesCookie(tilesCookieEndpoint) : Promise.resolve(),
      ])
      const OSD: OpenSeadragonNS = mod?.default ?? mod
      if (disposed || !containerRef.current) return

      viewer = OSD({
        element: containerRef.current,
        tileSources: composeTileSources(),
        // Secure tiles are cookie-protected on a sibling subdomain.
        // Avoid `anonymous` here because it strips credentials from image requests.
        crossOriginPolicy: secureTilesEnabled ? false : "Anonymous",
        // Interaction
        gestureSettingsMouse: {
          clickToZoom: false,
          dblClickToZoom: true,
          scrollToZoom: true,
        },
        gestureSettingsTouch: {
          pinchToZoom: true,
          flickEnabled: true,
        },
        // Performance
        immediateRender: true,
        imageLoaderLimit: 18,
        maxImageCacheCount: 600,
        blendTime: 0.05,
        alwaysBlend: false,
        // UI (we provide our own controls)
        showNavigationControl: false,
        showNavigator: false,
        constrainDuringPan: true,
        visibilityRatio: 0.5,
      })

      viewerRef.current = viewer
      onReadyRef.current?.(viewer)

      const emitTransform = () => {
        const el = containerRef.current
        if (!el || !viewer) return

        const rect = el.getBoundingClientRect()
        const container = { width: rect.width, height: rect.height }

        // Derive affine matrix image(px) -> screen(px) from 3 points.
        const p00 = viewer.viewport.imageToViewerElementCoordinates(new OSD.Point(0, 0))
        const currentSize = imageSizeRef.current ?? { width: 1, height: 1 }
        const p10 = viewer.viewport.imageToViewerElementCoordinates(
          new OSD.Point(currentSize.width, 0)
        )
        const p01 = viewer.viewport.imageToViewerElementCoordinates(
          new OSD.Point(0, currentSize.height)
        )

        const matrix = buildMatrix({
          p00,
          p10,
          p01,
          imageWidth: currentSize.width,
          imageHeight: currentSize.height,
        })

        const zoom = viewer.viewport.getZoom(true)
        onTransformChangeRef.current?.({ matrix, container, zoom })
      }

      viewer.addHandler("open", () => {
        emitTransform()

        // The overlay opacity may have changed while open() was in flight.
        viewer?.world?.getItemAt?.(1)?.setOpacity?.(overlayOpacityRef.current)

        // Fade the static thumbnail out once OSD has a fully-loaded frame.
        const item = viewer?.world?.getItemAt?.(0)
        if (!item) return
        if (item.getFullyLoaded?.()) {
          setThumbnailHidden(true)
          return
        }
        item.addHandler?.("fully-loaded-change", (event: any) => {
          if (event?.fullyLoaded) setThumbnailHidden(true)
        })
      })
      viewer.addHandler("viewport-change", emitTransform)

      // Tile failures that look like cookie expiry (e.g. after the machine
      // slept past the TTL): re-POST the cookie once, then re-request tiles.
      viewer.addHandler("tile-load-failed", () => {
        if (!secureTilesEnabled) return
        const now = Date.now()
        if (now - getTilesCookieState(tilesCookieEndpoint).setAt < TILES_COOKIE_FRESH_MS) return
        if (now - lastAuthRecoveryAtRef.current < TILES_COOKIE_FRESH_MS) return
        lastAuthRecoveryAtRef.current = now

        ensureTilesCookie(tilesCookieEndpoint, { force: true })
          .then(() => {
            const current = viewerRef.current
            if (!current) return
            const count = current.world?.getItemCount?.() ?? 0
            for (let i = 0; i < count; i++) {
              current.world.getItemAt(i)?.reset?.()
            }
            current.forceRedraw?.()
          })
          .catch((error) => {
            console.error("[TiledDrawingViewer] Tiles cookie recovery failed:", error)
          })
      })

      resizeObserverRef.current = new ResizeObserver(() => {
        emitTransform()
      })
      resizeObserverRef.current.observe(containerRef.current)
    }

    boot().catch((e) => console.error("[TiledDrawingViewer] Failed to init OpenSeadragon:", e))

    return () => {
      disposed = true
      resizeObserverRef.current?.disconnect()
      resizeObserverRef.current = null
      viewer?.destroy?.()
      viewerRef.current = null
      onReadyRef.current?.(null)
    }
  }, [composeTileSources, secureTilesEnabled, tilesCookieEndpoint])

  // Sheet/manifest/overlay-source changes: reuse the existing viewer via open()
  // instead of a destroy/recreate cycle. (No-op on mount — the viewer doesn't
  // exist yet and boot() constructs it with the latest sources from the refs.)
  useEffect(() => {
    if (!viewerRef.current) return
    try {
      viewerRef.current.open(composeTileSources())
    } catch (e) {
      console.error('[TiledViewer] Failed to update tile source:', e)
    }
  }, [composeTileSources, renderableTileBaseUrl, tileManifest, renderableOverlayBaseUrl, overlayManifest])

  // Overlay opacity changes: update the composited image in place — no
  // re-open, no tile refetch.
  useEffect(() => {
    if (typeof overlayOpacity !== 'number') return
    overlayOpacityRef.current = overlayOpacity
    viewerRef.current?.world?.getItemAt?.(1)?.setOpacity?.(overlayOpacity)
  }, [overlayOpacity])

  // Re-show the thumbnail whenever the sheet (tile source) changes.
  useEffect(() => {
    setThumbnailHidden(false)
  }, [renderableTileBaseUrl])

  // The cookie TTL is 1h. Refresh it while any tiled viewer is mounted so new
  // tile fetches never 401 mid-session.
  useEffect(() => {
    if (!secureTilesEnabled) return
    const id = window.setInterval(() => {
      ensureTilesCookie(tilesCookieEndpoint, { force: true }).catch((error) => {
        console.error("[TiledDrawingViewer] Tiles cookie refresh failed:", error)
      })
    }, TILES_COOKIE_REFRESH_MS)
    return () => window.clearInterval(id)
  }, [secureTilesEnabled, tilesCookieEndpoint])

  return (
    <div className={cn("relative h-full w-full", className)}>
      {renderableThumbnailUrl ? (
        <img
          src={renderableThumbnailUrl}
          alt=""
          aria-hidden
          draggable={false}
          className={cn(
            "pointer-events-none absolute inset-0 h-full w-full select-none object-contain transition-opacity duration-300",
            thumbnailHidden ? "opacity-0" : "opacity-100"
          )}
        />
      ) : null}
      <div ref={containerRef} className="absolute inset-0" />
    </div>
  )
}
