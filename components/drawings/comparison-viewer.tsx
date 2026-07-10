'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ArrowUpDown, X } from 'lucide-react'
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

// Use optimized image URLs when available, fall back to PDF URLs
function getVersionImageUrl(version: DrawingSheetVersion | undefined) {
  if (!version) return undefined
  return (
    version.image_full_url ||
    version.image_medium_url ||
    version.image_thumbnail_url ||
    version.file_url
  )
}

type CompareMode = 'side-by-side' | 'overlay'

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
  const [mode, setMode] = useState<CompareMode>('side-by-side')
  const [overlayOpacity, setOverlayOpacity] = useState(50)
  const [swapped, setSwapped] = useState(false)

  const leftVersion = versions.find(v => v.id === leftVersionId)
  const rightVersion = versions.find(v => v.id === rightVersionId)

  const versionLabel = (v: DrawingSheetVersion | undefined, idx: number) => {
    const n = versions.length - versions.findIndex(x => x.id === v?.id)
    return Number.isFinite(n) && n > 0 ? `v${n}` : `v${idx + 1}`
  }
  const fullLabel = (v: DrawingSheetVersion | undefined, idx: number) =>
    `${versionLabel(v, idx)}${v?.revision_label ? ` · ${v.revision_label}` : ''}`

  const leftImageUrl = getVersionImageUrl(leftVersion)
  const rightImageUrl = getVersionImageUrl(rightVersion)

  // Overlay stacking: older version underneath, newer on top (versions are
  // ordered newest-first, so a higher index = older). Swap flips the stack.
  const leftIdx = versions.findIndex(v => v.id === leftVersionId)
  const rightIdx = versions.findIndex(v => v.id === rightVersionId)
  const olderFirst: [DrawingSheetVersion | undefined, DrawingSheetVersion | undefined] =
    leftIdx >= rightIdx ? [leftVersion, rightVersion] : [rightVersion, leftVersion]
  const baseVersion = swapped ? olderFirst[1] : olderFirst[0]
  const topVersion = swapped ? olderFirst[0] : olderFirst[1]

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
          {/* Mode toggle */}
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={mode}
            onValueChange={v => {
              if (v === 'side-by-side' || v === 'overlay') setMode(v)
            }}
          >
            <ToggleGroupItem value="side-by-side">Side by side</ToggleGroupItem>
            <ToggleGroupItem value="overlay">Overlay</ToggleGroupItem>
          </ToggleGroup>

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
                    {fullLabel(v, idx)}
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
                    {fullLabel(v, idx)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

        </div>
      </div>

      {/* Main Content. Pan/zoom via trackpad/scroll gestures (the tiled viewer
          owns navigation) — per pane in side-by-side, shared in overlay. */}
      <div className="flex-1 overflow-hidden relative flex flex-col">
        {mode === 'side-by-side' ? (
          <SideBySideView
            leftUrl={leftImageUrl}
            rightUrl={rightImageUrl}
            leftVersion={leftVersion}
            rightVersion={rightVersion}
            leftLabel={fullLabel(leftVersion, 0)}
            rightLabel={fullLabel(rightVersion, 1)}
          />
        ) : (
          <OverlayView
            baseVersion={baseVersion}
            topVersion={topVersion}
            baseLabel={fullLabel(baseVersion, 0)}
            topLabel={fullLabel(topVersion, 1)}
            opacity={overlayOpacity}
            onOpacityChange={setOverlayOpacity}
            onSwap={() => setSwapped(s => !s)}
          />
        )}
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

function OverlayView({
  baseVersion,
  topVersion,
  baseLabel,
  topLabel,
  opacity,
  onOpacityChange,
  onSwap,
}: {
  baseVersion?: DrawingSheetVersion
  topVersion?: DrawingSheetVersion
  baseLabel: string
  topLabel: string
  opacity: number
  onOpacityChange: (value: number) => void
  onSwap: () => void
}) {
  const baseTiles = getTileSource(baseVersion)
  const topTiles = getTileSource(topVersion)
  const baseSrc = toRenderableDrawingsUrl(getVersionImageUrl(baseVersion))
  const topSrc = toRenderableDrawingsUrl(getVersionImageUrl(topVersion))

  return (
    <div className="flex h-full flex-col">
      {/* Control bar — mirrors the side-by-side label bars */}
      <div className="flex items-center justify-center gap-3 border-b bg-muted/50 px-4 py-2 text-sm">
        <span className="font-medium">{baseLabel}</span>
        <span className="text-muted-foreground">base</span>
        <div className="flex items-center gap-2">
          <Slider
            className="w-48"
            min={0}
            max={100}
            step={1}
            value={[opacity]}
            onValueChange={([v]) => onOpacityChange(v)}
            aria-label={`Opacity of ${topLabel}`}
          />
          <span className="w-9 text-right tabular-nums text-muted-foreground">
            {opacity}%
          </span>
        </div>
        <span className="font-medium">{topLabel}</span>
        <span className="text-muted-foreground">on top</span>
        <Button variant="ghost" size="sm" onClick={onSwap}>
          <ArrowUpDown className="h-4 w-4" />
          Swap
        </Button>
      </div>

      <div className="flex-1 overflow-hidden">
        {baseTiles && topTiles ? (
          // Both versions have tiles: one OSD viewer, newer composited over
          // older in a single shared viewport.
          <TiledDrawingViewer
            tileBaseUrl={baseTiles.tileBaseUrl}
            tileManifest={baseTiles.tileManifest}
            thumbnailUrl={toRenderableDrawingsUrl(getVersionImageUrl(baseVersion))}
            overlaySource={{
              tileBaseUrl: topTiles.tileBaseUrl,
              tileManifest: topTiles.tileManifest,
              opacity: opacity / 100,
            }}
            className="h-full w-full"
          />
        ) : baseSrc || topSrc ? (
          // At least one version is still processing (no tiles yet): stack the
          // same static previews the side-by-side falls back to.
          <div className="relative h-full w-full bg-muted/20">
            {baseSrc ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={baseSrc}
                alt={baseLabel}
                loading="eager"
                className="absolute inset-0 h-full w-full object-contain"
              />
            ) : null}
            {topSrc ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={topSrc}
                alt={topLabel}
                loading="eager"
                className="absolute inset-0 h-full w-full object-contain"
                style={{ opacity: opacity / 100 }}
              />
            ) : null}
          </div>
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            No preview available
          </div>
        )}
      </div>
    </div>
  )
}
