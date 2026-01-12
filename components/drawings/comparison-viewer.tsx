'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  ToggleGroup,
  ToggleGroupItem,
} from '@/components/ui/toggle-group'
import {
  X,
  ZoomIn,
  ZoomOut,
  Maximize,
  Download,
  Columns,
  Layers,
  SplitSquareHorizontal,
  Link2,
  Link2Off,
} from 'lucide-react'
import type { DrawingSheet, DrawingSheetVersion } from '@/lib/services/drawings'

type CompareMode = 'side-by-side' | 'overlay' | 'slider'

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
  const [zoom, setZoom] = useState(0.75)
  const [syncZoom, setSyncZoom] = useState(true)
  const [syncPan, setSyncPan] = useState(true)
  const [overlayOpacity, setOverlayOpacity] = useState(50)
  const [sliderPosition, setSliderPosition] = useState(50)

  const leftVersion = versions.find(v => v.id === leftVersionId)
  const rightVersion = versions.find(v => v.id === rightVersionId)

  // Use optimized image URLs when available, fall back to PDF URLs
  const getVersionImageUrl = (version: DrawingSheetVersion | undefined) => {
    if (!version) return undefined
    // Prefer optimized full resolution image, fall back to medium, then file_url (PDF)
    return version.image_full_url || version.image_medium_url || version.file_url
  }

  const leftImageUrl = getVersionImageUrl(leftVersion)
  const rightImageUrl = getVersionImageUrl(rightVersion)

  const handleZoomIn = () => setZoom(z => Math.min(z + 0.25, 3))
  const handleZoomOut = () => setZoom(z => Math.max(z - 0.25, 0.25))
  const handleFit = () => setZoom(0.75)

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      } else if (e.key === '=' || e.key === '+') {
        handleZoomIn()
      } else if (e.key === '-') {
        handleZoomOut()
      } else if (e.key === '0' && e.ctrlKey) {
        e.preventDefault()
        handleFit()
      }
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
                {versions.map(v => (
                  <SelectItem key={v.id} value={v.id} disabled={v.id === rightVersionId}>
                    {v.revision_label || 'Unknown'}
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
                {versions.map(v => (
                  <SelectItem key={v.id} value={v.id} disabled={v.id === leftVersionId}>
                    {v.revision_label || 'Unknown'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Mode Toggle */}
          <ToggleGroup type="single" value={mode} onValueChange={v => v && setMode(v as CompareMode)}>
            <ToggleGroupItem value="side-by-side" aria-label="Side by side">
              <Columns className="h-4 w-4" />
            </ToggleGroupItem>
            <ToggleGroupItem value="overlay" aria-label="Overlay">
              <Layers className="h-4 w-4" />
            </ToggleGroupItem>
            <ToggleGroupItem value="slider" aria-label="Slider">
              <SplitSquareHorizontal className="h-4 w-4" />
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-hidden relative">
        {mode === 'side-by-side' && (
          <SideBySideView
            leftUrl={leftImageUrl}
            rightUrl={rightImageUrl}
            leftLabel={leftVersion?.revision_label || 'Unknown'}
            rightLabel={rightVersion?.revision_label || 'Unknown'}
            zoom={zoom}
            syncZoom={syncZoom}
            syncPan={syncPan}
          />
        )}

        {mode === 'overlay' && (
          <OverlayView
            leftUrl={leftImageUrl}
            rightUrl={rightImageUrl}
            opacity={overlayOpacity}
            zoom={zoom}
          />
        )}

        {mode === 'slider' && (
          <SliderView
            leftUrl={leftImageUrl}
            rightUrl={rightImageUrl}
            position={sliderPosition}
            zoom={zoom}
          />
        )}
      </div>

      {/* Footer Controls */}
      <div className="border-t px-4 py-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={handleZoomOut}>
            <ZoomOut className="h-4 w-4" />
          </Button>
          <span className="text-sm w-16 text-center">{Math.round(zoom * 100)}%</span>
          <Button variant="outline" size="icon" onClick={handleZoomIn}>
            <ZoomIn className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="icon" onClick={handleFit}>
            <Maximize className="h-4 w-4" />
          </Button>
        </div>

        {/* Mode-specific controls */}
        {mode === 'side-by-side' && (
          <div className="flex items-center gap-4">
            <Button
              variant={syncZoom ? 'secondary' : 'outline'}
              size="sm"
              onClick={() => setSyncZoom(!syncZoom)}
            >
              {syncZoom ? <Link2 className="h-4 w-4 mr-1" /> : <Link2Off className="h-4 w-4 mr-1" />}
              Sync Zoom
            </Button>
            <Button
              variant={syncPan ? 'secondary' : 'outline'}
              size="sm"
              onClick={() => setSyncPan(!syncPan)}
            >
              {syncPan ? <Link2 className="h-4 w-4 mr-1" /> : <Link2Off className="h-4 w-4 mr-1" />}
              Sync Pan
            </Button>
          </div>
        )}

        {mode === 'overlay' && (
          <div className="flex items-center gap-4 flex-1 max-w-md mx-4">
            <span className="text-sm text-muted-foreground whitespace-nowrap">
              {leftVersion?.revision_label || 'Left'}
            </span>
            <Slider
              value={[overlayOpacity]}
              onValueChange={([v]) => setOverlayOpacity(v)}
              min={0}
              max={100}
              step={1}
              className="flex-1"
            />
            <span className="text-sm text-muted-foreground whitespace-nowrap">
              {rightVersion?.revision_label || 'Right'}
            </span>
          </div>
        )}

        {mode === 'slider' && (
          <div className="flex items-center gap-4 flex-1 max-w-md mx-4">
            <Slider
              value={[sliderPosition]}
              onValueChange={([v]) => setSliderPosition(v)}
              min={0}
              max={100}
              step={1}
              className="flex-1"
            />
            <span className="text-sm text-muted-foreground w-12 text-right">
              {sliderPosition}%
            </span>
          </div>
        )}

        <Button variant="outline" size="sm">
          <Download className="h-4 w-4 mr-1" />
          Download Both
        </Button>
      </div>
    </div>
  )
}

// Sub-components for each view mode

interface ViewProps {
  leftUrl?: string
  rightUrl?: string
  zoom: number
}

function SideBySideView({
  leftUrl,
  rightUrl,
  leftLabel,
  rightLabel,
  zoom,
  syncZoom,
  syncPan,
}: ViewProps & {
  leftLabel: string
  rightLabel: string
  syncZoom: boolean
  syncPan: boolean
}) {
  const leftRef = useRef<HTMLDivElement>(null)
  const rightRef = useRef<HTMLDivElement>(null)

  // Sync scroll positions when syncPan is enabled
  useEffect(() => {
    if (!syncPan) return

    const left = leftRef.current
    const right = rightRef.current
    if (!left || !right) return

    let syncing = false

    const syncScroll = (source: HTMLDivElement, target: HTMLDivElement) => {
      if (syncing) return
      syncing = true

      target.scrollLeft = source.scrollLeft
      target.scrollTop = source.scrollTop

      requestAnimationFrame(() => {
        syncing = false
      })
    }

    const handleLeftScroll = () => syncScroll(left, right)
    const handleRightScroll = () => syncScroll(right, left)

    left.addEventListener('scroll', handleLeftScroll)
    right.addEventListener('scroll', handleRightScroll)

    return () => {
      left.removeEventListener('scroll', handleLeftScroll)
      right.removeEventListener('scroll', handleRightScroll)
    }
  }, [syncPan])

  return (
    <div className="flex h-full divide-x">
      <div className="flex-1 flex flex-col">
        <div className="px-4 py-2 bg-muted/50 text-sm font-medium text-center border-b">
          {leftLabel}
        </div>
        <div ref={leftRef} className="flex-1 overflow-auto p-4 flex items-center justify-center bg-muted/20">
          {leftUrl ? (
            <img
              src={leftUrl}
              alt={leftLabel}
              style={{ transform: `scale(${zoom})`, transformOrigin: 'center' }}
              className="max-w-none transition-transform"
              loading="eager"
            />
          ) : (
            <div className="text-muted-foreground">No file available</div>
          )}
        </div>
      </div>

      <div className="flex-1 flex flex-col">
        <div className="px-4 py-2 bg-muted/50 text-sm font-medium text-center border-b">
          {rightLabel}
        </div>
        <div ref={rightRef} className="flex-1 overflow-auto p-4 flex items-center justify-center bg-muted/20">
          {rightUrl ? (
            <img
              src={rightUrl}
              alt={rightLabel}
              style={{ transform: `scale(${zoom})`, transformOrigin: 'center' }}
              className="max-w-none transition-transform"
              loading="eager"
            />
          ) : (
            <div className="text-muted-foreground">No file available</div>
          )}
        </div>
      </div>
    </div>
  )
}

function OverlayView({ leftUrl, rightUrl, opacity, zoom }: ViewProps & { opacity: number }) {
  return (
    <div className="h-full overflow-auto p-4 flex items-center justify-center bg-muted/20">
      <div className="relative">
        {/* Bottom layer (left/old) */}
        {leftUrl && (
          <img
            src={leftUrl}
            alt="Left version"
            style={{
              transform: `scale(${zoom})`,
              transformOrigin: 'center',
              filter: 'sepia(1) saturate(3) hue-rotate(-50deg) brightness(0.9)',
            }}
            className="max-w-none"
          />
        )}

        {/* Top layer (right/new) with opacity */}
        {rightUrl && (
          <img
            src={rightUrl}
            alt="Right version"
            style={{
              transform: `scale(${zoom})`,
              transformOrigin: 'center',
              opacity: opacity / 100,
              filter: 'sepia(1) saturate(3) hue-rotate(180deg) brightness(0.9)',
            }}
            className="absolute inset-0 max-w-none"
          />
        )}
      </div>
    </div>
  )
}

function SliderView({ leftUrl, rightUrl, position, zoom }: ViewProps & { position: number }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [localPosition, setLocalPosition] = useState(position)

  // Sync with prop
  useEffect(() => {
    if (!isDragging) {
      setLocalPosition(position)
    }
  }, [position, isDragging])

  const handleMouseDown = () => setIsDragging(true)
  const handleMouseUp = () => setIsDragging(false)

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging || !containerRef.current) return

    const rect = containerRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const percentage = Math.max(0, Math.min(100, (x / rect.width) * 100))
    setLocalPosition(percentage)
  }, [isDragging])

  useEffect(() => {
    if (isDragging) {
      const handleGlobalMouseUp = () => setIsDragging(false)
      window.addEventListener('mouseup', handleGlobalMouseUp)
      return () => window.removeEventListener('mouseup', handleGlobalMouseUp)
    }
  }, [isDragging])

  return (
    <div
      ref={containerRef}
      className="h-full overflow-auto p-4 flex items-center justify-center bg-muted/20 cursor-ew-resize"
      onMouseMove={handleMouseMove}
    >
      <div className="relative">
        {/* Full right image (underneath) */}
        {rightUrl && (
          <img
            src={rightUrl}
            alt="Right version"
            style={{ transform: `scale(${zoom})`, transformOrigin: 'center' }}
            className="max-w-none"
          />
        )}

        {/* Clipped left image (on top) */}
        {leftUrl && (
          <div
            className="absolute inset-0 overflow-hidden"
            style={{ width: `${localPosition}%` }}
          >
            <img
              src={leftUrl}
              alt="Left version"
              style={{ transform: `scale(${zoom})`, transformOrigin: 'center' }}
              className="max-w-none"
            />
          </div>
        )}

        {/* Slider handle */}
        <div
          className="absolute top-0 bottom-0 w-1 bg-primary cursor-ew-resize"
          style={{ left: `${localPosition}%`, transform: 'translateX(-50%)' }}
          onMouseDown={handleMouseDown}
        >
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 bg-primary rounded-full flex items-center justify-center shadow-lg">
            <SplitSquareHorizontal className="h-4 w-4 text-primary-foreground" />
          </div>
        </div>
      </div>
    </div>
  )
}
