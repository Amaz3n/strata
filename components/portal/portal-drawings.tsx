"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ChevronLeft, ChevronRight, Download, ExternalLink, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  TiledDrawingViewer,
  toRenderableDrawingsUrl,
  type ImageToScreenMatrix,
  type TileManifest,
} from "@/components/drawings/viewer/tiled-drawing-viewer"
import { SVGOverlay, type SVGOverlayHandle } from "@/components/drawings/viewer/svg-overlay"
import { DISCIPLINE_LABELS, type DrawingDiscipline } from "@/lib/validation/drawings"
import type { DrawingMarkup, DrawingPin } from "@/app/(app)/drawings/types"

export interface PortalDrawingSheet {
  id: string
  sheet_number: string
  sheet_title: string | null
  discipline: string | null
  revision_label: string | null
  tile_base_url: string | null
  tile_manifest: TileManifest | null
  thumbnail_url: string | null
  image_full_url: string | null
  image_width: number | null
  image_height: number | null
  pdf_url: string
  markups: DrawingMarkup[]
  pins: DrawingPin[]
}

interface PortalDrawingsSectionProps {
  token: string
  canDownload?: boolean
}

function disciplineLabel(code: string | null): string {
  if (!code) return "Uncategorized"
  return DISCIPLINE_LABELS[code as DrawingDiscipline] ?? code
}

function resolveTileSource(
  sheet: PortalDrawingSheet,
): { baseUrl: string; manifest: TileManifest } | null {
  if (!sheet.tile_base_url || !sheet.tile_manifest) return null
  const width = sheet.tile_manifest.Image?.Size?.Width ?? sheet.image_width
  const height = sheet.tile_manifest.Image?.Size?.Height ?? sheet.image_height
  if (!width || !height) return null
  return { baseUrl: sheet.tile_base_url, manifest: sheet.tile_manifest }
}

/**
 * Shared drawing sheets for a portal: discipline-grouped register that opens a
 * full-screen tiled viewer with the markups/pins shared to this audience.
 * Renders nothing when the project has no shared sheets.
 */
export function PortalDrawingsSection({ token, canDownload = true }: PortalDrawingsSectionProps) {
  const [sheets, setSheets] = useState<PortalDrawingSheet[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    setError(null)
    fetch(`/api/portal/drawings/${token}`, { credentials: "include" })
      .then(async (response) => {
        // No document access on this link: hide the section, don't error.
        if (response.status === 401) return { sheets: [] }
        if (!response.ok) {
          const body = await response.json().catch(() => null)
          throw new Error(body?.error ?? `Failed to load drawings (HTTP ${response.status})`)
        }
        return response.json()
      })
      .then((body: { sheets: PortalDrawingSheet[] }) => {
        if (!cancelled) setSheets(body.sheets ?? [])
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load drawings")
      })
    return () => {
      cancelled = true
    }
  }, [token, reloadKey])

  const groups = useMemo(() => {
    if (!sheets) return []
    const byDiscipline = new Map<string, { indexes: number[] }>()
    sheets.forEach((sheet, index) => {
      const key = disciplineLabel(sheet.discipline)
      const group = byDiscipline.get(key) ?? { indexes: [] }
      group.indexes.push(index)
      byDiscipline.set(key, group)
    })
    return Array.from(byDiscipline.entries())
  }, [sheets])

  if (error) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Drawings</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button size="sm" variant="outline" onClick={() => setReloadKey((k) => k + 1)}>
              Retry
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (!sheets) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Drawings</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-1.5">
                <Skeleton className="aspect-[4/3] w-full" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    )
  }

  if (sheets.length === 0) return null

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Drawings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {groups.map(([label, group]) => (
            <div key={label}>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {label}
                <span className="ml-1.5 tabular-nums">({group.indexes.length})</span>
              </p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                {group.indexes.map((index) => {
                  const sheet = sheets[index]
                  const thumbnail = toRenderableDrawingsUrl(sheet.thumbnail_url)
                  return (
                    <button
                      key={sheet.id}
                      type="button"
                      onClick={() => setOpenIndex(index)}
                      className="group border bg-card text-left transition-colors hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      <div className="flex aspect-[4/3] items-center justify-center overflow-hidden border-b bg-muted">
                        {thumbnail ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={thumbnail}
                            alt={`${sheet.sheet_number} thumbnail`}
                            loading="lazy"
                            draggable={false}
                            className="h-full w-full object-contain"
                          />
                        ) : (
                          <span className="text-xs text-muted-foreground">{sheet.sheet_number}</span>
                        )}
                      </div>
                      <div className="px-2 py-1.5">
                        <p className="truncate text-xs font-medium">
                          {sheet.sheet_number}
                          {sheet.revision_label ? (
                            <span className="ml-1 font-normal text-muted-foreground">
                              {sheet.revision_label}
                            </span>
                          ) : null}
                        </p>
                        {sheet.sheet_title ? (
                          <p className="truncate text-[11px] text-muted-foreground">{sheet.sheet_title}</p>
                        ) : null}
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {openIndex !== null && sheets[openIndex] ? (
        <PortalSheetViewer
          sheets={sheets}
          index={openIndex}
          token={token}
          canDownload={canDownload}
          onIndexChange={setOpenIndex}
          onClose={() => setOpenIndex(null)}
        />
      ) : null}
    </>
  )
}

interface PortalSheetViewerProps {
  sheets: PortalDrawingSheet[]
  index: number
  token: string
  canDownload: boolean
  onIndexChange: (index: number) => void
  onClose: () => void
}

/**
 * Full-screen read-only sheet viewer: tiled deep-zoom when tiles exist, image
 * fallback otherwise, PDF link as the last resort. No markup tools — shared
 * markups/pins render on a non-interactive overlay.
 */
function PortalSheetViewer({
  sheets,
  index,
  token,
  canDownload,
  onIndexChange,
  onClose,
}: PortalSheetViewerProps) {
  const sheet = sheets[index]
  const tileSource = resolveTileSource(sheet)
  const hasPrev = index > 0
  const hasNext = index < sheets.length - 1

  const [osdContainer, setOsdContainer] = useState<{ width: number; height: number } | null>(null)
  const overlayHandleRef = useRef<SVGOverlayHandle | null>(null)
  const matrixRef = useRef<ImageToScreenMatrix | null>(null)

  const setOverlayHandle = useCallback((handle: SVGOverlayHandle | null) => {
    overlayHandleRef.current = handle
    handle?.setTransform(matrixRef.current)
  }, [])

  const handleTransformChange = useCallback(
    ({ matrix, container }: { matrix: ImageToScreenMatrix; container: { width: number; height: number } }) => {
      matrixRef.current = matrix
      overlayHandleRef.current?.setTransform(matrix)
      setOsdContainer((prev) =>
        prev && prev.width === container.width && prev.height === container.height ? prev : container,
      )
    },
    [],
  )

  const goPrev = useCallback(() => {
    if (index > 0) onIndexChange(index - 1)
  }, [index, onIndexChange])
  const goNext = useCallback(() => {
    if (index < sheets.length - 1) onIndexChange(index + 1)
  }, [index, sheets.length, onIndexChange])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
      if (event.key === "ArrowLeft") goPrev()
      if (event.key === "ArrowRight") goNext()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose, goPrev, goNext])

  // Lock body scroll while the full-screen viewer is open.
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = previous
    }
  }, [])

  const imageSize = useMemo(
    () => ({
      width: sheet.tile_manifest?.Image?.Size?.Width ?? sheet.image_width ?? 1,
      height: sheet.tile_manifest?.Image?.Size?.Height ?? sheet.image_height ?? 1,
    }),
    [sheet],
  )

  const fallbackImageUrl = toRenderableDrawingsUrl(sheet.image_full_url)
  const downloadName = `${sheet.sheet_number || "sheet"}.pdf`.replace(/[^\w.-]+/g, "-")

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-neutral-900">
      {/* Toolbar: close / sheet identity / prev-next / download */}
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-white/10 px-2 text-white">
        <Button
          size="icon"
          variant="ghost"
          onClick={onClose}
          aria-label="Close viewer"
          className="text-white hover:bg-white/10 hover:text-white"
        >
          <X className="h-4 w-4" />
        </Button>
        <div className="min-w-0 flex-1 px-1">
          <p className="truncate text-sm font-medium leading-tight">
            {sheet.sheet_number}
            {sheet.revision_label ? (
              <span className="ml-1.5 text-xs font-normal text-white/60">{sheet.revision_label}</span>
            ) : null}
          </p>
          {sheet.sheet_title ? (
            <p className="truncate text-[11px] leading-tight text-white/60">{sheet.sheet_title}</p>
          ) : null}
        </div>
        <span className="px-1 text-xs tabular-nums text-white/60">
          {index + 1}/{sheets.length}
        </span>
        <Button
          size="icon"
          variant="ghost"
          onClick={goPrev}
          disabled={!hasPrev}
          aria-label="Previous sheet"
          className="text-white hover:bg-white/10 hover:text-white disabled:text-white/30"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          onClick={goNext}
          disabled={!hasNext}
          aria-label="Next sheet"
          className="text-white hover:bg-white/10 hover:text-white disabled:text-white/30"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        {canDownload ? (
          <Button
            size="icon"
            variant="ghost"
            asChild
            className="text-white hover:bg-white/10 hover:text-white"
          >
            <a href={sheet.pdf_url} download={downloadName} aria-label={`Download ${sheet.sheet_number} PDF`}>
              <Download className="h-4 w-4" />
            </a>
          </Button>
        ) : null}
      </div>

      {/* Drawing surface */}
      <div className="relative min-h-0 flex-1">
        {tileSource ? (
          <div className="absolute inset-0">
            <TiledDrawingViewer
              tileBaseUrl={tileSource.baseUrl}
              tileManifest={tileSource.manifest}
              thumbnailUrl={sheet.thumbnail_url ?? undefined}
              tilesCookieEndpoint={`/api/portal/drawings/${token}/tiles-cookie`}
              className="absolute inset-0"
              onTransformChange={handleTransformChange}
            />
            <SVGOverlay
              ref={setOverlayHandle}
              container={osdContainer}
              imageSize={imageSize}
              markups={sheet.markups}
              pins={sheet.pins}
              showMarkups
              showPins
              interactive={false}
            />
          </div>
        ) : fallbackImageUrl ? (
          <div className="absolute inset-0 overflow-auto">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={fallbackImageUrl}
              alt={`${sheet.sheet_number}${sheet.sheet_title ? ` — ${sheet.sheet_title}` : ""}`}
              className="h-full w-full object-contain"
              draggable={false}
            />
          </div>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="text-sm text-white/70">
              This sheet is still being processed for fast viewing.
            </p>
            <Button asChild variant="outline" size="sm" className="gap-1.5">
              <a href={sheet.pdf_url} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-3.5 w-3.5" />
                Open PDF
              </a>
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
