"use client"

import { useMemo } from "react"
import { format, parseISO } from "date-fns"
import { Check, MapPin, Video } from "lucide-react"

import { HashImage } from "@/components/files/hash-image"
import { cn } from "@/lib/utils"
import type { ProjectPhoto } from "@/lib/services/photos"

const TILE_SIZES = "(max-width: 640px) 33vw, (max-width: 1024px) 20vw, 13vw"

function sourceLabel(type: string, labels: Record<string, string>) {
  return labels[type] ?? type.replaceAll("_", " ")
}

interface PhotoGridProps {
  photos: ProjectPhoto[]
  sourceLabels: Record<string, string>
  selection: Set<string>
  selecting: boolean
  onToggle: (photo: ProjectPhoto, index: number, extend: boolean) => void
  onOpen: (photo: ProjectPhoto) => void
}

/**
 * The timeline. One row per day of capture, dates on a rail down the left, square
 * tiles so the eye can scan a hundred of them without the grid going ragged.
 *
 * Days come from `taken_at`, not upload time — a super emptying Friday's camera
 * roll on Monday morning gets three days of work filed on the three days it
 * happened.
 */
export function PhotoGrid({ photos, sourceLabels, selection, selecting, onToggle, onOpen }: PhotoGridProps) {
  const currentYear = new Date().getFullYear()

  const groups = useMemo(() => {
    const byDay = new Map<string, Array<{ photo: ProjectPhoto; index: number }>>()
    photos.forEach((photo, index) => {
      const key = photo.taken_at.slice(0, 10)
      byDay.set(key, [...(byDay.get(key) ?? []), { photo, index }])
    })
    return Array.from(byDay.entries())
  }, [photos])

  return (
    <ol className="px-4 sm:px-6">
      {groups.map(([date, entries]) => {
        const day = parseISO(date)
        return (
          <li key={date} className="flex">
            <div className="w-20 shrink-0 pr-3 text-right sm:w-28 sm:pr-4">
              {/* Clears the h-12 toolbar stuck above it. */}
              <div className="sticky top-14 py-5">
                <p className="text-xs font-medium tabular-nums">
                  {format(day, day.getFullYear() === currentYear ? "MMM d" : "MMM d, yyyy")}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">{format(day, "EEE")}</p>
                <p className="mt-2 hidden text-[11px] tabular-nums text-muted-foreground sm:block">
                  {entries.length} photo{entries.length === 1 ? "" : "s"}
                </p>
              </div>
            </div>

            <div className="relative min-w-0 flex-1 border-l py-5 pl-3 sm:pl-4">
              <span aria-hidden className="absolute -left-[3px] top-[26px] size-[5px] bg-foreground" />
              <div className="grid grid-cols-3 gap-px sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 2xl:grid-cols-8">
                {entries.map(({ photo, index }) => {
                  const selected = selection.has(photo.id)
                  return (
                    <div key={photo.id} className="group relative aspect-square bg-muted">
                      <button
                        type="button"
                        className={cn(
                          "absolute inset-0 overflow-hidden text-left focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          selected && "ring-2 ring-inset ring-primary",
                        )}
                        onClick={(event) => {
                          if (selecting || event.shiftKey || event.metaKey || event.ctrlKey) {
                            onToggle(photo, index, event.shiftKey)
                            return
                          }
                          onOpen(photo)
                        }}
                        aria-label={photo.file_name}
                        aria-pressed={selecting ? selected : undefined}
                      >
                        {photo.media_kind === "video" ? (
                          <video
                            src={photo.download_url}
                            preload="metadata"
                            muted
                            playsInline
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <HashImage
                            fileId={photo.id}
                            alt=""
                            preview={photo.preview}
                            sizes={TILE_SIZES}
                            fill
                            // Not the original: a HEIC cannot be rendered by any
                            // browser, and `thumbnail_url` is the service's one
                            // decision about what a photo displays from.
                            fallbackSrc={photo.thumbnail_url}
                            className="h-full w-full"
                          />
                        )}

                        <span
                          className={cn(
                            "absolute inset-x-0 bottom-0 flex items-center gap-1 truncate bg-background px-1.5 py-1 text-[10px] font-medium transition-transform duration-150",
                            "translate-y-full group-hover:translate-y-0 group-focus-within:translate-y-0",
                          )}
                        >
                          <span className="truncate">{sourceLabel(photo.primary_source.type, sourceLabels)}</span>
                          {photo.latitude !== null && (
                            <MapPin className="ml-auto size-3 shrink-0 text-muted-foreground" aria-label="Has location" />
                          )}
                        </span>
                      </button>

                      {photo.media_kind === "video" && (
                        <span
                          aria-hidden
                          className="pointer-events-none absolute left-1.5 top-1.5 flex size-5 items-center justify-center bg-background/85 text-foreground"
                        >
                          <Video className="size-3" />
                        </span>
                      )}

                      {photo.curated_visibility === "client" && (
                        <span
                          className="pointer-events-none absolute right-1.5 top-1.5 bg-success px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-success-foreground"
                          title="Published to the client feed"
                        >
                          Client
                        </span>
                      )}

                      {/* The checkbox is the affordance that says a grid is
                          selectable at all, so it shows on hover rather than
                          only once a selection mode has been entered. */}
                      <button
                        type="button"
                        onClick={(event) => onToggle(photo, index, event.shiftKey)}
                        aria-label={selected ? `Deselect ${photo.file_name}` : `Select ${photo.file_name}`}
                        aria-pressed={selected}
                        className={cn(
                          "absolute left-1.5 top-1.5 flex size-5 items-center justify-center border transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          photo.media_kind === "video" && "left-8",
                          selected
                            ? "border-primary bg-primary text-primary-foreground opacity-100"
                            : "border-border bg-background/85 opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                          selecting && "opacity-100",
                        )}
                      >
                        {selected && <Check className="size-3.5" />}
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
