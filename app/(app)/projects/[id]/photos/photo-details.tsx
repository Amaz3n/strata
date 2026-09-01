"use client"

import Link from "next/link"
import { format, parseISO } from "date-fns"
import { ExternalLink, Loader2, Sparkles } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { formatFileSize } from "@/components/files/types"
import type { PhotoAlbum, ProjectPhoto } from "@/lib/services/photos"

/** Radix Select cannot hold an empty value, so "unassigned" needs a name. */
const NONE = "__none__"

export interface PhotoPatch {
  album_id?: string | null
  location_id?: string | null
  trade_company_id?: string | null
  visibility?: "internal" | "client"
}

interface PhotoDetailsProps {
  photo: ProjectPhoto
  albums: PhotoAlbum[]
  locations: Array<{ id: string; full_path: string }>
  trades: Array<{ id: string; name: string }>
  canEdit: boolean
  pending: boolean
  onPatch: (patch: PhotoPatch) => void
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[72px_1fr] gap-3 py-2.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

export function PhotoDetails({ photo, albums, locations, trades, canEdit, pending, onPatch }: PhotoDetailsProps) {
  const takenAt = parseISO(photo.taken_at)
  const uploadedAt = parseISO(photo.created_at)
  // Only worth showing twice when they are different days — otherwise it is the
  // same fact printed twice.
  const uploadDiffers = photo.taken_at.slice(0, 10) !== photo.created_at.slice(0, 10)
  const published = photo.curated_visibility === "client"

  return (
    <div className="p-4">
      <p className="truncate text-sm font-medium">{photo.file_name}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {format(takenAt, "EEE, MMM d, yyyy 'at' h:mm a")}
      </p>

      {photo.ai_caption && (
        <div className="mt-4 border-l-2 border-l-chart-1 bg-muted/40 px-3 py-2">
          <p className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            <Sparkles className="size-3" />
            Caption
          </p>
          <p className="mt-1 text-xs leading-relaxed">{photo.ai_caption}</p>
          {photo.ai_tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {photo.ai_tags.slice(0, 12).map((tag) => (
                <Badge key={tag} variant="secondary" className="rounded-none px-1.5 py-0 text-[10px] font-normal">
                  {tag}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}

      <dl className="mt-5 divide-y border-y text-xs">
        <Row label="Uploader">
          <span className="block truncate">{photo.uploader_name ?? "Unknown"}</span>
        </Row>
        {uploadDiffers && (
          <Row label="Uploaded">
            <span className="tabular-nums">{format(uploadedAt, "MMM d, yyyy")}</span>
          </Row>
        )}
        <Row label="Size">
          <span className="truncate tabular-nums">
            {formatFileSize(photo.size_bytes ?? undefined)}
            {photo.preview.width && photo.preview.height ? (
              <span className="text-muted-foreground"> · {photo.preview.width} × {photo.preview.height}</span>
            ) : null}
          </span>
        </Row>
        {photo.latitude !== null && photo.longitude !== null && (
          <Row label="Location">
            <a
              className="inline-flex items-center gap-1 tabular-nums underline underline-offset-2 hover:text-foreground"
              href={`https://maps.google.com/?q=${photo.latitude},${photo.longitude}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {photo.latitude.toFixed(5)}, {photo.longitude.toFixed(5)}
              <ExternalLink className="size-3" />
            </a>
          </Row>
        )}
      </dl>

      {canEdit ? (
        <div className="mt-5 space-y-3">
          <div className="space-y-1.5">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Area</p>
            <Select
              value={photo.location_id ?? NONE}
              onValueChange={(value) => onPatch({ location_id: value === NONE ? null : value })}
              disabled={pending || locations.length === 0}
            >
              <SelectTrigger size="sm" className="w-full">
                <SelectValue placeholder={locations.length === 0 ? "No areas defined" : "Unassigned"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Unassigned</SelectItem>
                {locations.map((location) => (
                  <SelectItem key={location.id} value={location.id}>{location.full_path}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Trade</p>
            <Select
              value={photo.trade_company_id ?? NONE}
              onValueChange={(value) => onPatch({ trade_company_id: value === NONE ? null : value })}
              disabled={pending || trades.length === 0}
            >
              <SelectTrigger size="sm" className="w-full">
                <SelectValue placeholder={trades.length === 0 ? "No companies on this job" : "Unassigned"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Unassigned</SelectItem>
                {trades.map((trade) => (
                  <SelectItem key={trade.id} value={trade.id}>{trade.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Album</p>
            <Select
              value={photo.album_id ?? NONE}
              onValueChange={(value) => onPatch({ album_id: value === NONE ? null : value })}
              disabled={pending || albums.length === 0}
            >
              <SelectTrigger size="sm" className="w-full">
                <SelectValue placeholder={albums.length === 0 ? "No albums yet" : "Unassigned"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Unassigned</SelectItem>
                {albums.map((album) => (
                  <SelectItem key={album.id} value={album.id}>{album.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Button
            className="w-full"
            size="sm"
            variant={published ? "secondary" : "outline"}
            disabled={pending}
            onClick={() => onPatch({ visibility: published ? "internal" : "client" })}
          >
            {pending && <Loader2 className="size-3.5 animate-spin" />}
            {published ? "Remove from client feed" : "Publish to client feed"}
          </Button>
        </div>
      ) : (
        <dl className="mt-5 divide-y border-y text-xs">
          <Row label="Area">
            <span className="block truncate">
              {locations.find((location) => location.id === photo.location_id)?.full_path ?? "Unassigned"}
            </span>
          </Row>
          <Row label="Album">
            <span className="block truncate">
              {albums.find((album) => album.id === photo.album_id)?.name ?? "Unassigned"}
            </span>
          </Row>
        </dl>
      )}

      <p className="mt-5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Filed under</p>
      <div className="mt-1 -mx-2">
        {photo.sources.map((source) => (
          <Link
            key={`${source.type}:${source.entity_id}`}
            href={source.href}
            className="flex items-start justify-between gap-2 px-2 py-2 text-xs transition-colors hover:bg-accent/50"
          >
            <span className="min-w-0">
              <span className="block truncate font-medium">{source.label}</span>
              {source.location ? (
                <span className="mt-0.5 block truncate text-muted-foreground">{source.location}</span>
              ) : null}
            </span>
            <ExternalLink className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          </Link>
        ))}
      </div>
    </div>
  )
}
