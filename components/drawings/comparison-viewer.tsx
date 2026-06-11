'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { X } from 'lucide-react'
import type { DrawingSheet, DrawingSheetVersion } from '@/lib/services/drawings'
import {
  TiledDrawingViewer,
  toRenderableDrawingsUrl,
  type TileManifest,
} from './viewer/tiled-drawing-viewer'

function getTileSource(version: DrawingSheetVersion | undefined): {
  tileBaseUrl: string
  tileManifest: TileManifest
} | null {
  if (!version?.tile_base_url || !version?.tile_manifest) return null
  const manifest = version.tile_manifest as TileManifest
  if (!manifest?.Image?.Size?.Width || !manifest?.Image?.Size?.Height) return null
  return { tileBaseUrl: version.tile_base_url, tileManifest: manifest }
}

interface ComparisonViewerProps {
  sheet: DrawingSheet
  versions: DrawingSheetVersion[]
  leftVersionId: string
  rightVersionId: string
  onClose: () => void
  onChangeVersions: (leftId: string, rightId: string) => void
}

export function ComparisonViewer({
  sheet,
  versions,
  leftVersionId,
  rightVersionId,
  onClose,
  onChangeVersions,
}: ComparisonViewerProps) {
  const leftVersion = versions.find(v => v.id === leftVersionId)
  const rightVersion = versions.find(v => v.id === rightVersionId)

  const versionLabel = (v: DrawingSheetVersion | undefined, idx: number) => {
    const n = versions.length - versions.findIndex(x => x.id === v?.id)
    return Number.isFinite(n) && n > 0 ? `v${n}` : `v${idx + 1}`
  }

  // Use optimized image URLs when available, fall back to PDF URLs
  const getVersionImageUrl = (version: DrawingSheetVersion | undefined) => {
    if (!version) return undefined
    return (
      version.image_full_url ||
      version.image_medium_url ||
      version.image_thumbnail_url ||
      version.file_url
    )
  }

  const leftImageUrl = getVersionImageUrl(leftVersion)
  const rightImageUrl = getVersionImageUrl(rightVersion)

  // Escape closes the comparison view. Zoom/pan is handled by the tiled viewer.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 bg-background flex flex-col">
      {/* Header */}
      <div className="border-b px-4 py-2 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
          <div>
            <h2 className="font-semibold">
              {sheet.sheet_number} {sheet.sheet_title}
            </h2>
            <p className="text-sm text-muted-foreground">Comparison Mode</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {/* Version Selectors */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Comparing:</span>
            <Select
              value={leftVersionId}
              onValueChange={v => onChangeVersions(v, rightVersionId)}
            >
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {versions.map((v, idx) => (
                  <SelectItem key={v.id} value={v.id} disabled={v.id === rightVersionId}>
                    {versionLabel(v, idx)}{v.revision_label ? ` · ${v.revision_label}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-sm text-muted-foreground">vs</span>
            <Select
              value={rightVersionId}
              onValueChange={v => onChangeVersions(leftVersionId, v)}
            >
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {versions.map((v, idx) => (
                  <SelectItem key={v.id} value={v.id} disabled={v.id === leftVersionId}>
                    {versionLabel(v, idx)}{v.revision_label ? ` · ${v.revision_label}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

        </div>
      </div>

      {/* Main Content — side-by-side tiled comparison. Pan/zoom per pane via
          trackpad/scroll gestures (the tiled viewer owns navigation). */}
      <div className="flex-1 overflow-hidden relative">
        <SideBySideView
          leftUrl={leftImageUrl}
          rightUrl={rightImageUrl}
          leftVersion={leftVersion}
          rightVersion={rightVersion}
          leftLabel={versionLabel(leftVersion, 0)}
          rightLabel={versionLabel(rightVersion, 1)}
        />
      </div>
    </div>
  )
}

// Sub-components

function ComparePane({
  version,
  url,
  label,
}: {
  version?: DrawingSheetVersion
  url?: string
  label: string
}) {
  const tiles = getTileSource(version)
  if (tiles) {
    // Full-resolution tiled rendering with its own pan/zoom (OpenSeadragon).
    return (
      <TiledDrawingViewer
        tileBaseUrl={tiles.tileBaseUrl}
        tileManifest={tiles.tileManifest}
        thumbnailUrl={toRenderableDrawingsUrl(url)}
        className="h-full w-full"
      />
    )
  }
  const src = toRenderableDrawingsUrl(url)
  if (src) {
    return (
      <div className="flex h-full w-full items-center justify-center overflow-auto bg-muted/20 p-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={label} className="max-w-none" loading="eager" />
      </div>
    )
  }
  return (
    <div className="flex h-full w-full items-center justify-center text-muted-foreground">
      No preview available
    </div>
  )
}

function SideBySideView({
  leftUrl,
  rightUrl,
  leftVersion,
  rightVersion,
  leftLabel,
  rightLabel,
}: {
  leftUrl?: string
  rightUrl?: string
  leftVersion?: DrawingSheetVersion
  rightVersion?: DrawingSheetVersion
  leftLabel: string
  rightLabel: string
}) {
  return (
    <div className="flex h-full divide-x">
      <div className="flex-1 flex flex-col min-w-0">
        <div className="px-4 py-2 bg-muted/50 text-sm font-medium text-center border-b">
          {leftLabel}
        </div>
        <div className="flex-1 overflow-hidden">
          <ComparePane version={leftVersion} url={leftUrl} label={leftLabel} />
        </div>
      </div>

      <div className="flex-1 flex flex-col min-w-0">
        <div className="px-4 py-2 bg-muted/50 text-sm font-medium text-center border-b">
          {rightLabel}
        </div>
        <div className="flex-1 overflow-hidden">
          <ComparePane version={rightVersion} url={rightUrl} label={rightLabel} />
        </div>
      </div>
    </div>
  )
}
