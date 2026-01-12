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
  const [currentStage, setCurrentStage] = useState<ImageLoadStage>("loading")
  const [thumbnailLoaded, setThumbnailLoaded] = useState(false)
  const [mediumLoaded, setMediumLoaded] = useState(false)
  const [fullLoaded, setFullLoaded] = useState(false)
  const [hasError, setHasError] = useState(false)

  // Track if component is mounted to avoid state updates after unmount
  const isMountedRef = useRef(true)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  // Reset state when URLs change (e.g., navigating to different sheet)
  useEffect(() => {
    setCurrentStage("loading")
    setThumbnailLoaded(false)
    setMediumLoaded(false)
    setFullLoaded(false)
    setHasError(false)
  }, [thumbnailUrl, mediumUrl, fullUrl])

  // Preload medium and full resolution images after thumbnail loads
  useEffect(() => {
    if (!thumbnailLoaded || !isMountedRef.current) return

    // Start loading medium resolution
    const mediumImg = new window.Image()
    mediumImg.onload = () => {
      if (!isMountedRef.current) return
      setMediumLoaded(true)
      setCurrentStage("medium")
      onLoadStage?.("medium")

      // Then load full resolution
      const fullImg = new window.Image()
      fullImg.onload = () => {
        if (!isMountedRef.current) return
        setFullLoaded(true)
        setCurrentStage("full")
        onLoadStage?.("full")
      }
      fullImg.onerror = () => {
        console.warn("[ImageViewer] Failed to load full resolution image")
        // Keep using medium as fallback
      }
      fullImg.src = fullUrl
    }
    mediumImg.onerror = () => {
      console.warn("[ImageViewer] Failed to load medium resolution image")
      // Keep using thumbnail and try full directly
      const fullImg = new window.Image()
      fullImg.onload = () => {
        if (!isMountedRef.current) return
        setFullLoaded(true)
        setCurrentStage("full")
        onLoadStage?.("full")
      }
      fullImg.src = fullUrl
    }
    mediumImg.src = mediumUrl
  }, [thumbnailLoaded, mediumUrl, fullUrl, onLoadStage])

  const handleThumbnailLoad = useCallback(() => {
    if (!isMountedRef.current) return
    setThumbnailLoaded(true)
    setCurrentStage("thumbnail")
    onLoadStage?.("thumbnail")
  }, [onLoadStage])

  const handleThumbnailError = useCallback(() => {
    if (!isMountedRef.current) return
    setHasError(true)
    onError?.(new Error("Failed to load thumbnail image"))
  }, [onError])

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
