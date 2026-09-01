"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { thumbHashToDataURL } from "thumbhash"

import { cn } from "@/lib/utils"
import {
  photoSrcSet,
  previewAspectRatio,
  previewUrl,
  type PreviewMetadata,
} from "@/lib/files/photo-src"

interface HashImageProps {
  fileId: string
  alt: string
  preview?: PreviewMetadata | null
  /** `sizes` attribute — how wide this renders, so the browser picks a rung. */
  sizes?: string
  className?: string
  /** Above-the-fold images opt out of lazy loading. */
  priority?: boolean
  /**
   * Fill the space the parent gives it instead of reserving the source's aspect
   * ratio. What a uniform grid wants: square tiles scan far faster than a ragged
   * mix of portrait and landscape.
   */
  fill?: boolean
  /**
   * Where to go when this file has no generated preview — a photo uploaded in
   * the last few minutes, or one whose job failed. Without it the preview route
   * 404s and the tile renders as a broken image.
   */
  fallbackSrc?: string
}

function decodeThumbhash(value?: string | null): string | null {
  if (!value) return null
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return thumbHashToDataURL(bytes)
  } catch {
    // A malformed hash is not worth failing a render over — the image still loads.
    return null
  }
}

/**
 * An image that occupies its final space immediately.
 *
 * The stored thumbhash paints as a blurred backdrop on first frame and the real
 * image fades in over it, while the stored source dimensions reserve the aspect
 * ratio — so a photo grid never reflows as rows load.
 */
export function HashImage({
  fileId,
  alt,
  preview,
  sizes = "(min-width: 1280px) 25vw, (min-width: 640px) 33vw, 50vw",
  className,
  priority = false,
  fill = false,
  fallbackSrc,
}: HashImageProps) {
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const imageRef = useRef<HTMLImageElement>(null)

  const placeholder = useMemo(() => decodeThumbhash(preview?.thumbhash), [preview?.thumbhash])
  const srcSet = useMemo(() => photoSrcSet(fileId, preview), [fileId, preview])
  const aspectRatio = fill ? null : previewAspectRatio(preview)

  // No ladder means no preview to negotiate, so go straight to the fallback
  // rather than requesting a rung that does not exist.
  const src = (failed || !srcSet) && fallbackSrc ? fallbackSrc : previewUrl(fileId, 960)
  const usesLadder = src !== fallbackSrc

  // A cached image can finish decoding before React attaches onLoad, which would
  // otherwise leave it stuck behind the placeholder.
  useEffect(() => {
    if (imageRef.current?.complete) setLoaded(true)
  }, [])

  return (
    <div
      className={cn("relative overflow-hidden bg-muted/40", className)}
      style={aspectRatio ? { aspectRatio } : undefined}
    >
      {placeholder && !loaded && (
        <img
          aria-hidden
          alt=""
          src={placeholder}
          className="absolute inset-0 h-full w-full scale-105 object-cover blur-xl"
        />
      )}
      <img
        ref={imageRef}
        alt={alt}
        src={src}
        srcSet={usesLadder ? srcSet ?? undefined : undefined}
        sizes={usesLadder && srcSet ? sizes : undefined}
        loading={priority ? "eager" : "lazy"}
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        className={cn(
          "relative h-full w-full object-cover transition-opacity duration-150",
          loaded ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  )
}
