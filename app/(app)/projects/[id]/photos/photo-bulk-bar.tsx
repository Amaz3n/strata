"use client"

import { ChevronDown, Download, Loader2, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { PhotoAlbum } from "@/lib/services/photos"
import type { PhotoPatch } from "./photo-details"

/** Matches MAX_ZIP_FILES in app/api/documents/download-zip. */
const ZIP_LIMIT = 100

interface PhotoBulkBarProps {
  count: number
  albums: PhotoAlbum[]
  locations: Array<{ id: string; full_path: string }>
  canEdit: boolean
  pending: boolean
  downloading: boolean
  onPatch: (patch: PhotoPatch) => void
  onDownload: () => void
  onClear: () => void
}

/**
 * What you can do to a selection, in one place.
 *
 * Every one of these was reachable before only by opening a photo, changing one
 * field, closing it, and opening the next — which is why nobody curated anything.
 * The bar reports the count it is acting on, so "publish" is never ambiguous
 * about how many photos are about to reach a client.
 *
 * These are menus of actions rather than value pickers: a selection of eighty
 * photos has no single current album to show as the selected option.
 */
export function PhotoBulkBar({
  count,
  albums,
  locations,
  canEdit,
  pending,
  downloading,
  onPatch,
  onDownload,
  onClear,
}: PhotoBulkBarProps) {
  const overZipLimit = count > ZIP_LIMIT

  return (
    <div className="pointer-events-none sticky bottom-0 z-30 flex justify-center px-4 pb-4">
      <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-1.5 border bg-background p-2 shadow-lg">
        <span className="px-1.5 text-xs font-medium tabular-nums">{count} selected</span>
        <div className="h-5 w-px bg-border" />

        {canEdit && (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" className="h-8" disabled={pending}>
                  Album
                  <ChevronDown className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="center" className="max-h-72 w-56 overflow-y-auto">
                <DropdownMenuLabel className="text-xs">Add {count} to</DropdownMenuLabel>
                {albums.length === 0 ? (
                  <DropdownMenuItem disabled>No albums yet</DropdownMenuItem>
                ) : (
                  albums.map((album) => (
                    <DropdownMenuItem key={album.id} onSelect={() => onPatch({ album_id: album.id })}>
                      <span className="truncate">{album.name}</span>
                      <span className="ml-auto text-xs tabular-nums text-muted-foreground">{album.photo_count}</span>
                    </DropdownMenuItem>
                  ))
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => onPatch({ album_id: null })}>Remove from album</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" className="h-8" disabled={pending || locations.length === 0}>
                  Area
                  <ChevronDown className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="center" className="max-h-72 w-56 overflow-y-auto">
                <DropdownMenuLabel className="text-xs">Set area for {count}</DropdownMenuLabel>
                {locations.map((location) => (
                  <DropdownMenuItem key={location.id} onSelect={() => onPatch({ location_id: location.id })}>
                    <span className="truncate">{location.full_path}</span>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => onPatch({ location_id: null })}>Clear area</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Button size="sm" variant="outline" className="h-8" disabled={pending} onClick={() => onPatch({ visibility: "client" })}>
              {pending && <Loader2 className="size-3.5 animate-spin" />}
              Publish
            </Button>
            <Button size="sm" variant="ghost" className="h-8" disabled={pending} onClick={() => onPatch({ visibility: "internal" })}>
              Unpublish
            </Button>
            <div className="h-5 w-px bg-border" />
          </>
        )}

        <Button
          size="sm"
          variant="ghost"
          className="h-8"
          onClick={onDownload}
          disabled={downloading || overZipLimit}
          title={overZipLimit ? `ZIP downloads are limited to ${ZIP_LIMIT} photos` : undefined}
        >
          {downloading ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
          Download
        </Button>

        <Button size="sm" variant="ghost" className="h-8" onClick={onClear} aria-label="Clear selection">
          <X className="size-3.5" />
        </Button>

        {overZipLimit && (
          <p className="w-full px-1 text-center text-[11px] text-muted-foreground">
            Select {ZIP_LIMIT} or fewer to download as a ZIP.
          </p>
        )}
      </div>
    </div>
  )
}
