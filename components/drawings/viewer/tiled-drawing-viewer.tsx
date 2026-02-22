"use client"

import { useCallback, useEffect, useMemo, useRef } from "react"
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

export function TiledDrawingViewer({
  tileBaseUrl,
  tileManifest,
  className,
  onReady,
  onTransformChange,
  thumbnailUrl,
}: TiledDrawingViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<any | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const imageSizeRef = useRef<{ width: number; height: number } | null>(null)
  const onReadyRef = useRef<TiledDrawingViewerProps["onReady"]>(onReady)
  const onTransformChangeRef = useRef<TiledDrawingViewerProps["onTransformChange"]>(onTransformChange)

  const imageSize = useMemo(() => {
    const w = tileManifest?.Image?.Size?.Width ?? 1
    const h = tileManifest?.Image?.Size?.Height ?? 1
    return { width: w, height: h }
  }, [tileManifest])

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
      const tileSize = Math.max(1, manifest?.Image?.TileSize ?? 256)
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

  useEffect(() => {
    if (!containerRef.current || viewerRef.current) return

    let disposed = false
    let viewer: any | null = null

    const boot = async () => {
      // Avoid importing openseadragon during SSR/module evaluation:
      // it touches `document` at import-time.
      const mod = (await import("openseadragon")) as any
      const OSD: OpenSeadragonNS = mod?.default ?? mod
      if (disposed || !containerRef.current) return

      viewer = OSD({
        element: containerRef.current,
        tileSources: [buildTileSource(tileBaseUrl, tileManifest)],
        crossOriginPolicy: "Anonymous",
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
        imageLoaderLimit: 4,
        maxImageCacheCount: 200,
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

      viewer.addHandler("open", emitTransform)
      viewer.addHandler("viewport-change", emitTransform)

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
  }, [buildTileSource, tileBaseUrl, tileManifest])

  useEffect(() => {
    if (!viewerRef.current) return
    try {
      viewerRef.current.open(buildTileSource(tileBaseUrl, tileManifest))
    } catch (e) {
      console.error('[TiledViewer] Failed to update tile source:', e)
    }
  }, [buildTileSource, tileBaseUrl, tileManifest])

  return <div ref={containerRef} className={cn("h-full w-full", className)} />
}
