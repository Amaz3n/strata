"use client"

import { useMemo, useState } from "react"

import { FileViewer } from "@/components/files/file-viewer"
import type { FileWithDetails } from "@/components/files/types"

export type GalleryPhoto = { id: string; url: string; caption: string | null }

interface Props {
  photos: GalleryPhoto[]
  /** Accent used for the active-thumbnail ring. */
  accentColor?: string | null
}

/**
 * Interactive estimate photo gallery for the client portal: a thumbnail grid that
 * opens the same {@link FileViewer} used in the documents workspace (zoom, pan,
 * rotate, swipe, keyboard nav) so the preview experience is identical app-wide.
 *
 * Portal photos are signed R2 URLs rather than file records, so we adapt each one
 * into the minimal {@link FileWithDetails} shape FileViewer needs to render an image.
 */
export function EstimatePhotoGallery({ photos, accentColor }: Props) {
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  const accent = accentColor || undefined

  const viewerFiles = useMemo<FileWithDetails[]>(
    () =>
      photos.map((photo, idx) => ({
        id: photo.id || `photo-${idx}`,
        org_id: "",
        file_name: photo.caption?.trim() || `Photo ${idx + 1}`,
        storage_path: "",
        mime_type: "image/jpeg",
        visibility: "private",
        created_at: new Date().toISOString(),
        download_url: photo.url,
        thumbnail_url: photo.url,
      })),
    [photos],
  )

  if (!photos || photos.length === 0) return null

  const activeFile = openIndex !== null ? viewerFiles[openIndex] ?? null : null

  return (
    <div className="space-y-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        Photos ({photos.length})
      </p>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {photos.map((photo, idx) => (
          <button
            key={photo.id || idx}
            type="button"
            onClick={() => setOpenIndex(idx)}
            className="group relative aspect-square overflow-hidden rounded-md border bg-muted transition-shadow hover:shadow-md focus:outline-none focus-visible:ring-2"
            style={{ ["--tw-ring-color" as any]: accent }}
            aria-label={photo.caption || `Open photo ${idx + 1}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={photo.url} alt={photo.caption || `Photo ${idx + 1}`} className="h-full w-full object-cover transition-transform group-hover:scale-105" />
          </button>
        ))}
      </div>

      <FileViewer
        file={activeFile}
        files={viewerFiles}
        open={openIndex !== null}
        onOpenChange={(open) => {
          if (!open) setOpenIndex(null)
        }}
        onFileChange={(next) => {
          const idx = viewerFiles.findIndex((f) => f.id === next.id)
          if (idx >= 0) setOpenIndex(idx)
        }}
        onDownload={(f) => {
          if (f.download_url) window.open(f.download_url, "_blank", "noopener,noreferrer")
        }}
      />
    </div>
  )
}
