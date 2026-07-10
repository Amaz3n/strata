"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import Image from "next/image"
import { cn } from "@/lib/utils"

export type ImageLoadStage = "loading" | "thumbnail" | "medium" | "full"

interface ImageViewerProps {
  thumbnailUrl: string
  mediumUrl: string
  fullUrl: string
  width: number
  height: number
  alt: string
  className?: string
  onLoadStage?: (stage: ImageLoadStage) => void
  onError?: (error: Error) => void
  priority?: boolean
}

/**
 * Progressive image viewer for drawings
 *
 * Loads images in 3 stages for optimal perceived performance:
 * 1. Thumbnail (400px) - Loads first, shows immediately (~30-50KB)
 * 2. Medium (1200px) - Good for mobile/tablet (~150-250KB)
 * 3. Full (2400px) - Final resolution for desktop zoom (~400-600KB)
 *
 * Each stage fades in smoothly when loaded, providing visual feedback
 * while maintaining the best quality available.
 *
 * Target performance:
 * - Thumbnail visible: < 100ms
 * - Medium loaded: < 200ms
 * - Full loaded: < 500ms
 */
export function ImageViewer({
  thumbnailUrl,
  mediumUrl,
  fullUrl,
  width,
  height,
  alt,
  className,
  onLoadStage,
  onError,
  priority = true,
}: ImageViewerProps) {
  const [thumbnailLoaded, setThumbnailLoaded] = useState(false)
  const [mediumLoaded, setMediumLoaded] = useState(false)
  const [fullLoaded, setFullLoaded] = useState(false)
  const [thumbnailError, setThumbnailError] = useState(false)
  const [mediumError, setMediumError] = useState(false)
  const [fullError, setFullError] = useState(false)

  // Derived: the best resolution loaded so far. Never downgrades — a lower-res
  // layer finishing late can't replace a higher one already shown.
  const currentStage: ImageLoadStage = fullLoaded
    ? "full"
    : mediumLoaded
      ? "medium"
      : thumbnailLoaded
        ? "thumbnail"
        : "loading"

  // Keep callbacks out of the load effect's deps so URL changes are the only
  // thing that restarts loading.
  const onLoadStageRef = useRef(onLoadStage)
  useEffect(() => {
    onLoadStageRef.current = onLoadStage
  }, [onLoadStage])

  // Kick off medium and full concurrently with the thumbnail (which loads via
  // the <Image> below). Each layer swaps in as soon as it decodes.
  useEffect(() => {
    setThumbnailLoaded(false)
    setMediumLoaded(false)
    setFullLoaded(false)
    setThumbnailError(false)
    setMediumError(false)
    setFullError(false)

    let cancelled = false

    const mediumImg = new window.Image()
    mediumImg.decoding = "async"
    mediumImg.onload = () => {
      if (cancelled) return
      setMediumLoaded(true)
      onLoadStageRef.current?.("medium")
    }
    mediumImg.onerror = () => {
      if (cancelled) return
      console.warn("[ImageViewer] Failed to load medium resolution image")
      setMediumError(true)
    }
    mediumImg.src = mediumUrl

    const fullImg = new window.Image()
    fullImg.decoding = "async"
    fullImg.onload = () => {
      if (cancelled) return
      setFullLoaded(true)
      onLoadStageRef.current?.("full")
    }
    fullImg.onerror = () => {
      if (cancelled) return
      console.warn("[ImageViewer] Failed to load full resolution image")
      setFullError(true)
    }
    fullImg.src = fullUrl

    return () => {
      cancelled = true
      mediumImg.onload = null
      mediumImg.onerror = null
      fullImg.onload = null
      fullImg.onerror = null
    }
  }, [thumbnailUrl, mediumUrl, fullUrl])

  const handleThumbnailLoad = useCallback(() => {
    setThumbnailLoaded(true)
    onLoadStage?.("thumbnail")
  }, [onLoadStage])

  const handleThumbnailError = useCallback(() => {
    setThumbnailError(true)
    onError?.(new Error("Failed to load thumbnail image"))
  }, [onError])

  // Only a total failure is an error — if any layer made it, keep going.
  const hasError = thumbnailError && mediumError && fullError

  // Calculate aspect ratio for proper sizing
  const aspectRatio = width && height ? width / height : 4 / 3

  // Show error state
  if (hasError) {
    return (
      <div
        className={cn(
          "flex items-center justify-center bg-muted text-muted-foreground",
          className
        )}
        style={{ aspectRatio }}
      >
        <div className="text-center p-4">
          <p className="text-sm">Failed to load image</p>
          <p className="text-xs mt-1">Please try refreshing</p>
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn("relative overflow-hidden bg-muted", className)}
      style={{ aspectRatio }}
    >
      {/* Loading skeleton */}
      {currentStage === "loading" && (
        <div className="absolute inset-0 animate-pulse bg-muted" />
      )}

      {/* Thumbnail layer - loads first, always visible until replaced */}
      <Image
        src={thumbnailUrl}
        alt={alt}
        width={400}
        height={Math.round(400 / aspectRatio)}
        className={cn(
          "absolute inset-0 w-full h-full object-contain transition-opacity duration-200",
          thumbnailLoaded ? "opacity-100" : "opacity-0"
        )}
        priority={priority}
        onLoad={handleThumbnailLoad}
        onError={handleThumbnailError}
        unoptimized // Use original image, no Next.js optimization
      />

      {/* Medium layer - fades in when loaded, replaces thumbnail */}
      {mediumLoaded && (
        <Image
          src={mediumUrl}
          alt={alt}
          width={1200}
          height={Math.round(1200 / aspectRatio)}
          className={cn(
            "absolute inset-0 w-full h-full object-contain transition-opacity duration-200",
            mediumLoaded && !fullLoaded ? "opacity-100" : fullLoaded ? "opacity-0" : "opacity-0"
          )}
          unoptimized
        />
      )}

      {/* Full resolution layer - final layer, fades in when loaded */}
      {fullLoaded && (
        <Image
          src={fullUrl}
          alt={alt}
          width={width || 2400}
          height={height || Math.round(2400 / aspectRatio)}
          className="absolute inset-0 w-full h-full object-contain transition-opacity duration-200 opacity-100"
          unoptimized
        />
      )}

      {/* Loading indicator for progressive stages */}
      {currentStage !== "full" && currentStage !== "loading" && (
        <div className="absolute bottom-2 right-2 px-2 py-1 bg-background/80 backdrop-blur-sm rounded text-xs text-muted-foreground">
          {currentStage === "thumbnail" && "Loading HD..."}
          {currentStage === "medium" && "Loading full resolution..."}
        </div>
      )}
    </div>
  )
}

/**
 * Simpler single-image viewer for cases where we only have one resolution
 * (e.g., legacy sheets or fallback mode)
 */
interface SimpleImageViewerProps {
  src: string
  width?: number
  height?: number
  alt: string
  className?: string
  onLoad?: () => void
  onError?: (error: Error) => void
}

export function SimpleImageViewer({
  src,
  width = 2400,
  height,
  alt,
  className,
  onLoad,
  onError,
}: SimpleImageViewerProps) {
  const [loaded, setLoaded] = useState(false)
  const [hasError, setHasError] = useState(false)

  const aspectRatio = width && height ? width / height : 4 / 3

  if (hasError) {
    return (
      <div
        className={cn(
          "flex items-center justify-center bg-muted text-muted-foreground",
          className
        )}
        style={{ aspectRatio }}
      >
        <p className="text-sm">Failed to load image</p>
      </div>
    )
  }

  return (
    <div
      className={cn("relative overflow-hidden bg-muted", className)}
      style={{ aspectRatio }}
    >
      {!loaded && <div className="absolute inset-0 animate-pulse bg-muted" />}

      <Image
        src={src}
        alt={alt}
        width={width}
        height={height || Math.round(width / aspectRatio)}
        className={cn(
          "w-full h-full object-contain transition-opacity duration-200",
          loaded ? "opacity-100" : "opacity-0"
        )}
        priority
        onLoad={() => {
          setLoaded(true)
          onLoad?.()
        }}
        onError={() => {
          setHasError(true)
          onError?.(new Error("Failed to load image"))
        }}
        unoptimized
      />
    </div>
  )
}
