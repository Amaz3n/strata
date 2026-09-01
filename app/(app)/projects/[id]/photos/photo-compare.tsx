"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { format, parseISO } from "date-fns"
import { Columns2, GitCompareArrows, Images } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { previewUrl } from "@/lib/files/photo-src"
import { cn } from "@/lib/utils"
import type { ProjectPhoto } from "@/lib/services/photos"

type CompareMode = "split" | "overlay"

function photoLabel(photo: ProjectPhoto) {
  const when = format(parseISO(photo.taken_at), "MMM d, yyyy · h:mm a")
  const where = photo.locations[0]
  return where ? `${when} — ${where}` : when
}

/**
 * The largest rung when there is a ladder, and otherwise whatever the service
 * decided this photo displays from — never the original, which for a HEIC is a
 * file no browser can decode.
 */
function comparableSrc(photo: ProjectPhoto) {
  return photo.preview.sizes?.length ? previewUrl(photo.id, 2048) : photo.thumbnail_url
}

function PhotoPane({ photo, className }: { photo: ProjectPhoto; className?: string }) {
  return (
    // Streamed through the authenticated org-scoped file route, so the Next
    // image pipeline has nothing to add — images are unoptimized app-wide.
    <img
      src={comparableSrc(photo)}
      alt={photo.file_name}
      className={cn("h-full w-full object-contain", className)}
      draggable={false}
    />
  )
}

interface PhotoCompareProps {
  photos: ProjectPhoto[]
}

/**
 * Two photos of the same place, weeks apart.
 *
 * The pair defaults to the oldest and newest of whatever is loaded, so filtering
 * the timeline to one area and switching here is the whole workflow — that
 * filter is what makes the comparison mean something, and it already exists.
 *
 * Videos are excluded: there is no still to compare.
 */
export function PhotoCompare({ photos }: PhotoCompareProps) {
  const comparable = useMemo(() => photos.filter((photo) => photo.media_kind === "image"), [photos])

  const [mode, setMode] = useState<CompareMode>("split")
  const [leftId, setLeftId] = useState<string | null>(null)
  const [rightId, setRightId] = useState<string | null>(null)
  const [position, setPosition] = useState(50)
  const overlayRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  // Photos arrive newest first, so the last one is the earliest: "before" on the
  // left, "after" on the right, which is the order people read them in.
  useEffect(() => {
    if (comparable.length === 0) return
    setLeftId((current) => (current && comparable.some((p) => p.id === current) ? current : comparable[comparable.length - 1].id))
    setRightId((current) => (current && comparable.some((p) => p.id === current) ? current : comparable[0].id))
  }, [comparable])

  const left = comparable.find((photo) => photo.id === leftId) ?? null
  const right = comparable.find((photo) => photo.id === rightId) ?? null

  const moveDivider = useCallback((clientX: number) => {
    const bounds = overlayRef.current?.getBoundingClientRect()
    if (!bounds || bounds.width === 0) return
    const next = ((clientX - bounds.left) / bounds.width) * 100
    setPosition(Math.min(100, Math.max(0, next)))
  }, [])

  useEffect(() => {
    if (mode !== "overlay") return
    const onMove = (event: PointerEvent) => {
      if (!dragging.current) return
      event.preventDefault()
      moveDivider(event.clientX)
    }
    const onUp = () => {
      dragging.current = false
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    return () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
    }
  }, [mode, moveDivider])

  if (comparable.length < 2) {
    return (
      <div className="flex flex-col items-center px-6 py-24 text-center">
        <Images className="size-6 text-muted-foreground" />
        <p className="mt-4 text-sm font-medium">Not enough photos to compare</p>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          Comparison needs two photos. Clear a filter, or scroll the timeline to load more.
        </p>
      </div>
    )
  }

  return (
    <div className="px-4 py-4 sm:px-6">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={leftId ?? undefined} onValueChange={setLeftId}>
          <SelectTrigger size="sm" className="w-full min-w-0 sm:w-72">
            <SelectValue placeholder="Before" />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {comparable.map((photo) => (
              <SelectItem key={photo.id} value={photo.id}>{photoLabel(photo)}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={rightId ?? undefined} onValueChange={setRightId}>
          <SelectTrigger size="sm" className="w-full min-w-0 sm:w-72">
            <SelectValue placeholder="After" />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {comparable.map((photo) => (
              <SelectItem key={photo.id} value={photo.id}>{photoLabel(photo)}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant={mode === "split" ? "secondary" : "ghost"}
            className="h-8"
            onClick={() => setMode("split")}
          >
            <Columns2 className="size-3.5" />
            Side by side
          </Button>
          <Button
            size="sm"
            variant={mode === "overlay" ? "secondary" : "ghost"}
            className="h-8"
            onClick={() => setMode("overlay")}
          >
            <GitCompareArrows className="size-3.5" />
            Overlay
          </Button>
        </div>
      </div>

      {left && right && (
        <div className="mt-4">
          {mode === "split" ? (
            <div className="grid gap-px bg-border sm:grid-cols-2">
              {[left, right].map((photo, index) => (
                <figure key={`${photo.id}-${index}`} className="bg-background">
                  <div className="h-[45vh] min-h-[260px] bg-muted/40">
                    <PhotoPane photo={photo} />
                  </div>
                  <figcaption className="flex items-baseline justify-between gap-2 px-2 py-2 text-xs">
                    <span className="truncate font-medium">{index === 0 ? "Before" : "After"}</span>
                    <span className="truncate tabular-nums text-muted-foreground">{photoLabel(photo)}</span>
                  </figcaption>
                </figure>
              ))}
            </div>
          ) : (
            <div>
              <div
                ref={overlayRef}
                className="relative h-[60vh] min-h-[320px] touch-none select-none overflow-hidden bg-muted/40"
                onPointerDown={(event) => {
                  dragging.current = true
                  moveDivider(event.clientX)
                }}
              >
                <PhotoPane photo={left} className="absolute inset-0" />
                <div
                  className="absolute inset-0"
                  style={{ clipPath: `inset(0 0 0 ${position}%)` }}
                >
                  <PhotoPane photo={right} className="absolute inset-0" />
                </div>

                <div
                  className="absolute inset-y-0 w-px bg-background"
                  style={{ left: `${position}%` }}
                  aria-hidden
                />
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(position)}
                  onChange={(event) => setPosition(Number(event.target.value))}
                  aria-label="Comparison position"
                  className="absolute inset-x-0 bottom-3 mx-auto w-2/3 cursor-ew-resize"
                />
              </div>
              <div className="flex items-baseline justify-between gap-4 px-1 py-2 text-xs">
                <span className="truncate text-muted-foreground">Before · {photoLabel(left)}</span>
                <span className="truncate text-muted-foreground">After · {photoLabel(right)}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
