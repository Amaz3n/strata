"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { buildRenderableTileBaseUrl } from "@/lib/drawings/tile-urls"
import {
  DEFAULT_TILES_COOKIE_ENDPOINT,
  TILES_COOKIE_FRESH_MS,
  TILES_COOKIE_REFRESH_MS,
  ensureTilesCookie,
  getTilesCookieState,
} from "@/lib/drawings/tiles-cookie-client"
import { GpuDrawingViewer, type OverlaySpec } from "@/lib/viewer"
import type {
  CompareMode,
  ImageToScreenMatrix,
  TileManifest,
  ViewerError,
  ViewerMetrics,
} from "@/lib/viewer"

export type { ImageToScreenMatrix, TileManifest }

export interface TiledDrawingViewerProps {
  tileBaseUrl: string
  tileManifest: TileManifest
  className?: string
  /**
   * Fired once per sheet when tiles fail persistently. This component is
   * shared with the token portals, so it deliberately does not know how to
   * repair anything — the authed caller supplies that.
   */
  onTileLoadFailure?: () => void
  /** Real load timings. Emitted at each milestone and on teardown. */
  onMetrics?: (metrics: ViewerMetrics) => void
  onReady?: (viewer: GpuDrawingViewer | null) => void
  onTransformChange?: (args: {
    matrix: ImageToScreenMatrix
    container: { width: number; height: number }
    zoom: number
  }) => void
  thumbnailUrl?: string // Fallback for when tiles don't exist
  /**
   * Optional second tiled image rendered against the base image (used by the
   * drawings comparison view). `overlay` composites it on top at `opacity`
   * (live-updatable without refetching tiles); `difference` runs the GPU
   * ink-diff — unchanged linework gray, removed red, added blue.
   */
  overlaySource?: {
    tileBaseUrl: string
    tileManifest: TileManifest
    opacity: number
    mode?: "overlay" | "difference"
  }
  /**
   * Route that mints the arc_tiles cookie for this viewer's audience.
   * Defaults to the authed app endpoint; portals pass their token-scoped
   * endpoint (/api/portal/drawings/[token]/tiles-cookie).
   */
  tilesCookieEndpoint?: string
}

// ---------------------------------------------------------------------------
// Tiles cookie: POST once per session, shared across every mounted viewer.
// The cookie has a 1h TTL, so mounted viewers also refresh it on an interval
// (see the refresh effect below) and re-POST on suspected auth failures.
// Memoized per endpoint: the authed app and token-authenticated portals mint
// the same cookie from different routes.
// ---------------------------------------------------------------------------

function toCompareMode(mode: "overlay" | "difference" | undefined): CompareMode {
  return mode === "difference" ? "difference" : "composite"
}

export function TiledDrawingViewer({
  tileBaseUrl,
  tileManifest,
  className,
  onTileLoadFailure,
  onMetrics,
  onReady,
  onTransformChange,
  thumbnailUrl,
  overlaySource,
  tilesCookieEndpoint = DEFAULT_TILES_COOKIE_ENDPOINT,
}: TiledDrawingViewerProps) {
  const secureTilesEnabled = process.env.NEXT_PUBLIC_DRAWINGS_TILES_SECURE === "true"
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<GpuDrawingViewer | null>(null)
  const onReadyRef = useRef<TiledDrawingViewerProps["onReady"]>(onReady)
  const onTransformChangeRef = useRef<TiledDrawingViewerProps["onTransformChange"]>(onTransformChange)
  const onMetricsRef = useRef<TiledDrawingViewerProps["onMetrics"]>(onMetrics)
  const onTileLoadFailureRef =
    useRef<TiledDrawingViewerProps["onTileLoadFailure"]>(onTileLoadFailure)
  const lastAuthRecoveryAtRef = useRef(0)
  /** Bumped to force a full viewer rebuild after a terminal failure. */
  const [retryNonce, setRetryNonce] = useState(0)
  const [viewerError, setViewerError] = useState<ViewerError | null>(null)
  const failureReportedRef = useRef(false)

  // Thumbnail-first render: show the sheet thumbnail behind the GPU canvas so
  // the user never stares at a blank surface while tiles stream in.
  const [thumbnailHidden, setThumbnailHidden] = useState(false)
  const renderableThumbnailUrl = useMemo(
    () => (thumbnailUrl ? buildRenderableTileBaseUrl(thumbnailUrl, secureTilesEnabled) : undefined),
    [secureTilesEnabled, thumbnailUrl]
  )

  const renderableTileBaseUrl = useMemo(
    () => buildRenderableTileBaseUrl(tileBaseUrl, secureTilesEnabled),
    [secureTilesEnabled, tileBaseUrl]
  )
  const overlayTileBaseUrl = overlaySource?.tileBaseUrl
  const overlayManifest = overlaySource?.tileManifest
  const overlayOpacity = overlaySource?.opacity
  const overlayMode = overlaySource?.mode
  const renderableOverlayBaseUrl = useMemo(
    () =>
      overlayTileBaseUrl
        ? buildRenderableTileBaseUrl(overlayTileBaseUrl, secureTilesEnabled)
        : undefined,
    [secureTilesEnabled, overlayTileBaseUrl]
  )

  useEffect(() => {
    onReadyRef.current = onReady
  }, [onReady])

  useEffect(() => {
    onTransformChangeRef.current = onTransformChange
  }, [onTransformChange])

  useEffect(() => {
    onMetricsRef.current = onMetrics
  }, [onMetrics])

  useEffect(() => {
    onTileLoadFailureRef.current = onTileLoadFailure
  }, [onTileLoadFailure])

  const sources = useMemo(
    () => ({
      base: { baseUrl: renderableTileBaseUrl, manifest: tileManifest },
      overlay:
        renderableOverlayBaseUrl && overlayManifest
          ? ({
              source: { baseUrl: renderableOverlayBaseUrl, manifest: overlayManifest },
              opacity: overlayOpacity ?? 1,
              mode: toCompareMode(overlayMode),
            } satisfies OverlaySpec)
          : null,
    }),
    // Opacity and mode update in place via their own effects below; changing
    // them must not re-open the tile sources.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [renderableTileBaseUrl, tileManifest, renderableOverlayBaseUrl, overlayManifest]
  )
  const sourcesRef = useRef(sources)
  sourcesRef.current = sources
  /** What the mounted viewer is showing, to skip the mount-echo setSource. */
  const appliedSourcesRef = useRef<typeof sources | null>(null)

  // Create the GPU viewer ONCE per component mount. Sheet changes reuse the
  // instance via setSource() (see the effect below) instead of destroy/recreate.
  useEffect(() => {
    const container = containerRef.current
    if (!container || viewerRef.current) return

    if (secureTilesEnabled) {
      // Start the cookie POST before the first tile request goes out.
      ensureTilesCookie(tilesCookieEndpoint).catch((error) => {
        console.error("[TiledDrawingViewer] Tiles cookie mint failed:", error)
      })
    }

    const initialSources = sourcesRef.current
    appliedSourcesRef.current = initialSources
    const viewer = new GpuDrawingViewer({
      container,
      source: initialSources.base,
      overlay: initialSources.overlay,
      credentials: secureTilesEnabled ? "include" : "omit",
      onTransformChange: (transform) => onTransformChangeRef.current?.(transform),
      onFirstFullFrame: () => setThumbnailHidden(true),
      // The thumbnail backdrop is only aligned with the home view; the first
      // pan/zoom drops it even if tiles are still streaming.
      onViewInteraction: () => setThumbnailHidden(true),
      // Tile failures that look like cookie expiry (e.g. after the machine
      // slept past the TTL): re-POST the cookie once, then re-request tiles.
      onTileAuthError: () => {
        if (!secureTilesEnabled) return
        const now = Date.now()
        if (now - getTilesCookieState(tilesCookieEndpoint).setAt < TILES_COOKIE_FRESH_MS) return
        if (now - lastAuthRecoveryAtRef.current < TILES_COOKIE_FRESH_MS) return
        lastAuthRecoveryAtRef.current = now

        ensureTilesCookie(tilesCookieEndpoint, { force: true })
          .then(() => viewerRef.current?.refreshTiles())
          .catch((error) => {
            console.error("[TiledDrawingViewer] Tiles cookie recovery failed:", error)
          })
      },
      onMetrics: (metrics) => onMetricsRef.current?.(metrics),
      // Only surface states the user can do something about. A device loss
      // that is still recovering resolves itself; showing it would flash an
      // error over a viewer that is about to come back.
      onError: (error) => {
        if (error.type === "tiles-unauthorized") return
        if (error.type === "device-lost" && error.recovering) return
        setViewerError(error)

        // Tiles that will not load are a server-side problem. Report it once
        // per sheet and let the caller decide what repair means.
        if (error.type === "tiles-failed" && !failureReportedRef.current) {
          failureReportedRef.current = true
          onTileLoadFailureRef.current?.()
        }
      },
    })
    viewerRef.current = viewer
    onReadyRef.current?.(viewer)

    return () => {
      viewer.destroy()
      viewerRef.current = null
      onReadyRef.current?.(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secureTilesEnabled, tilesCookieEndpoint, retryNonce])

  // Sheet/manifest/overlay-source changes: reuse the existing viewer via
  // setSource() instead of a destroy/recreate cycle.
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || appliedSourcesRef.current === sources) return
    appliedSourcesRef.current = sources
    viewer.setSource(sources.base, sources.overlay)
  }, [sources])

  // Overlay opacity / compare-mode changes: update in place — no refetch.
  useEffect(() => {
    if (typeof overlayOpacity === "number") viewerRef.current?.setOverlayOpacity(overlayOpacity)
  }, [overlayOpacity])
  useEffect(() => {
    if (overlayMode) viewerRef.current?.setCompareMode(toCompareMode(overlayMode))
  }, [overlayMode])

  // Re-show the thumbnail whenever the sheet (tile source) changes, and clear
  // any failure the previous sheet was carrying.
  useEffect(() => {
    setThumbnailHidden(false)
    setViewerError(null)
    failureReportedRef.current = false
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
      {viewerError && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background/90 p-6 text-center">
          <p className="text-sm font-medium">{viewerErrorTitle(viewerError)}</p>
          <p className="max-w-sm text-xs text-muted-foreground">
            {viewerErrorDetail(viewerError)}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setViewerError(null)
              setRetryNonce((nonce) => nonce + 1)
            }}
          >
            Try again
          </Button>
        </div>
      )}
    </div>
  )
}

function viewerErrorTitle(error: ViewerError): string {
  switch (error.type) {
    case "renderer-unavailable":
      return "This browser can't display drawings"
    case "device-lost":
      return "The drawing view lost its graphics device"
    case "tiles-failed":
      return "This sheet's image failed to load"
    case "tiles-unauthorized":
      return "Access to this sheet expired"
  }
}

function viewerErrorDetail(error: ViewerError): string {
  switch (error.type) {
    case "renderer-unavailable":
      return "Drawings need WebGPU or WebGL2. Try a different browser, or enable hardware acceleration."
    case "device-lost":
      return "This usually happens after the device sleeps or another app takes the GPU."
    case "tiles-failed":
      return `${error.failedCount} tiles could not be loaded. We've asked the server to rebuild this sheet — retrying in a moment often fixes it.`
    case "tiles-unauthorized":
      return "Your access to these drawing tiles timed out."
  }
}
