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
}: HashImageProps) {
  const [loaded, setLoaded] = useState(false)
  const imageRef = useRef<HTMLImageElement>(null)

  const placeholder = useMemo(() => decodeThumbhash(preview?.thumbhash), [preview?.thumbhash])
  const srcSet = useMemo(() => photoSrcSet(fileId, preview), [fileId, preview])
  const aspectRatio = previewAspectRatio(preview)

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
      {/* eslint-disable-next-line @next/next/no-img-element -- streamed through the authenticated org-scoped file route */}
      <img
        ref={imageRef}
        alt={alt}
        src={previewUrl(fileId, 960)}
        srcSet={srcSet ?? undefined}
        sizes={srcSet ? sizes : undefined}
        loading={priority ? "eager" : "lazy"}
        decoding="async"
        onLoad={() => setLoaded(true)}
        className={cn(
          "relative h-full w-full object-cover transition-opacity duration-150",
          loaded ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  )
}
