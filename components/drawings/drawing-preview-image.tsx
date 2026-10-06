"use client"

import { useEffect, useState } from "react"
import { FileImage, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { toRenderableDrawingsUrl } from "@/lib/drawings/tile-urls"
import {
  DEFAULT_TILES_COOKIE_ENDPOINT,
  ensureTilesCookie
} from "@/lib/drawings/tiles-cookie-client"

/** Review images need the same authenticated access as the drawing viewer. */
export function DrawingPreviewImage({
  url,
  alt,
  className
}: {
  url?: string | null
  alt: string
  className?: string
}) {
  // A new asset (early thumbnail -> final thumbnail) gets a fresh load state.
  return (
    <PreviewImage
      key={url ?? "pending"}
      url={url}
      alt={alt}
      className={className}
    />
  )
}

function PreviewImage({
  url,
  alt,
  className
}: {
  url?: string | null
  alt: string
  className?: string
}) {
  const [src, setSrc] = useState<string>()
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!url) return
    let active = true
    setFailed(false)
    setLoaded(false)
    const prepare = async () => {
      if (url.includes("/drawings-tiles/")) {
        // Shared promise: a grid of images only mints one access cookie.
        await ensureTilesCookie(DEFAULT_TILES_COOKIE_ENDPOINT).catch(() => {})
      }
      if (active) setSrc(toRenderableDrawingsUrl(url))
    }
    void prepare()
    return () => {
      active = false
    }
  }, [url, attempt])

  const recover = () => {
    // Also handles rejected cross-domain cookies and CDN auth failures. The
    // same-origin route independently checks membership; access stays private.
    const marker = "/drawings-tiles/"
    const index = url?.indexOf(marker) ?? -1
    const proxy =
      index >= 0
        ? `/api/drawings/tiles/${url!.slice(index + marker.length)}`
        : undefined
    if (proxy && src !== proxy) {
      setSrc(proxy)
    } else {
      setFailed(true)
    }
  }

  return (
    <div
      className={cn(
        "relative flex items-center justify-center overflow-hidden bg-muted/30",
        className
      )}
    >
      {src && !failed && (
        <img
          key={`${src}:${attempt}`}
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={recover}
          className={cn(
            "absolute inset-0 h-full w-full object-contain transition-opacity",
            loaded ? "opacity-100" : "opacity-0"
          )}
        />
      )}
      {!loaded || failed ? (
        <div className="flex flex-col items-center gap-2 p-2 text-center text-muted-foreground">
          <FileImage className="h-5 w-5" aria-hidden="true" />
          {failed ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-auto gap-1 px-1 py-0.5 text-xs"
              onClick={() => {
                setSrc(undefined)
                setAttempt((n) => n + 1)
              }}
            >
              <RotateCcw className="h-3 w-3" /> Retry preview
            </Button>
          ) : (
            <span className="text-[11px]">
              {url ? "Loading preview" : "Preparing preview"}
            </span>
          )}
        </div>
      ) : null}
    </div>
  )
}
