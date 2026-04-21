"use client"

import { useState, useCallback, useEffect, useRef } from "react"
import Image from "next/image"
import { cn } from "@/lib/utils"
import {
  X,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  RotateCw,
  Download,
  Maximize2,
  Minimize2,
  FileText,
  Loader2,
  History,
  MoreHorizontal,
} from "@/components/icons"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { type FileWithDetails, isImageFile, isPdfFile, formatFileSize } from "./types"
import { VersionHistoryPanel, type FileVersionInfo } from "./version-history-panel"

interface FileViewerProps {
  file: FileWithDetails | null
  files?: FileWithDetails[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onDownload?: (file: FileWithDetails) => void
  versions?: FileVersionInfo[]
  onUploadVersion?: (file: File, label?: string, notes?: string) => Promise<void>
  onMakeCurrentVersion?: (versionId: string) => Promise<void>
  onDownloadVersion?: (versionId: string) => Promise<void>
  onUpdateVersion?: (versionId: string, updates: { label?: string; notes?: string }) => Promise<void>
  onDeleteVersion?: (versionId: string) => Promise<void>
  onRefreshVersions?: () => Promise<void>
  onFileChange?: (file: FileWithDetails) => void
}

export function FileViewer({
  file,
  files = [],
  open,
  onOpenChange,
  onDownload,
  versions,
  onUploadVersion,
  onMakeCurrentVersion,
  onDownloadVersion,
  onUpdateVersion,
  onDeleteVersion,
  onRefreshVersions,
  onFileChange,
}: FileViewerProps) {
  const [zoom, setZoom] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [swipeX, setSwipeX] = useState(0)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null)
  const [pdfPageCount, setPdfPageCount] = useState(0)
  const [activePdfPage, setActivePdfPage] = useState(1)
  const [pdfLoadFailed, setPdfLoadFailed] = useState(false)
  const [pdfViewportWidth, setPdfViewportWidth] = useState(0)
  const [pdfComponents, setPdfComponents] = useState<{
    Document: any
    Page: any
    pdfjs: any
  } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const pdfViewportRef = useRef<HTMLDivElement>(null)
  const gestureRef = useRef({
    startTouches: [] as Array<{ x: number; y: number }>,
    startZoom: 1,
    startPan: { x: 0, y: 0 },
    startDistance: 0,
    lastTapTime: 0,
    lastTapX: 0,
    lastTapY: 0,
  })

  const hasFileList = files.length > 0
  const derivedIndexFromFile =
    hasFileList && file ? files.findIndex((f) => f.id === file.id) : -1
  const parentControlsSelection = hasFileList && Boolean(file) && Boolean(onFileChange)
  const activeIndex = parentControlsSelection
    ? (derivedIndexFromFile >= 0 ? derivedIndexFromFile : 0)
    : currentIndex
  const clampedIndex = hasFileList
    ? Math.min(Math.max(activeIndex, 0), files.length - 1)
    : 0
  const currentFile = hasFileList ? files[clampedIndex] : file
  const currentFileIsPdf = currentFile ? isPdfFile(currentFile.mime_type) : false
  const currentPdfUrl = currentFile ? `/api/files/${currentFile.id}/raw` : null

  useEffect(() => {
    if (!open || !currentFileIsPdf) return
    let cancelled = false

    const loadPdfComponents = async () => {
      try {
        const { Document, Page, pdfjs } = await import("react-pdf")
        if (cancelled) return
        pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`
        setPdfComponents({ Document, Page, pdfjs })
      } catch (error) {
        console.error("Failed to load PDF components", error)
        if (!cancelled) {
          setPdfLoadFailed(true)
          setIsLoading(false)
        }
      }
    }

    void loadPdfComponents()
    return () => {
      cancelled = true
    }
  }, [open, currentFileIsPdf])

  // Reset state when file changes
  useEffect(() => {
    setZoom(1)
    setRotation(0)
    setPan({ x: 0, y: 0 })
    setSwipeX(0)
    setIsLoading(true)
    setImageDimensions(null)
    setPdfPageCount(0)
    setActivePdfPage(1)
    setPdfLoadFailed(false)
  }, [file?.id])

  useEffect(() => {
    if (!open || !currentFileIsPdf) return
    const viewport = pdfViewportRef.current
    if (!viewport) return

    const updateWidth = () => {
      setPdfViewportWidth(viewport.clientWidth)
    }
    updateWidth()

    const observer = new ResizeObserver(() => updateWidth())
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [open, currentFileIsPdf, showVersions])

  useEffect(() => {
    if (!currentFileIsPdf || pdfPageCount <= 0) return
    setIsLoading(true)
  }, [activePdfPage, currentFileIsPdf, pdfPageCount])

  const hasMultiple = files.length > 1
  const canPrev = hasMultiple && clampedIndex > 0
  const canNext = hasMultiple && clampedIndex < files.length - 1
  const hasVersionsPanel =
    Boolean(versions) &&
    Boolean(
      onUploadVersion &&
      onMakeCurrentVersion &&
      onDownloadVersion &&
      onUpdateVersion &&
      onDeleteVersion &&
      onRefreshVersions
    )

  const handlePrev = useCallback(() => {
    if (canPrev) {
      if (parentControlsSelection && onFileChange) {
        const prevFile = files[clampedIndex - 1]
        if (prevFile) {
          onFileChange(prevFile)
        }
      } else {
        setCurrentIndex((i) => Math.max(i - 1, 0))
      }
      setIsLoading(true)
      setZoom(1)
      setRotation(0)
      setPan({ x: 0, y: 0 })
      setSwipeX(0)
      setImageDimensions(null)
    }
  }, [canPrev, parentControlsSelection, onFileChange, files, clampedIndex])

  const handleNext = useCallback(() => {
    if (canNext) {
      if (parentControlsSelection && onFileChange) {
        const nextFile = files[clampedIndex + 1]
        if (nextFile) {
          onFileChange(nextFile)
        }
      } else {
        setCurrentIndex((i) => i + 1)
      }
      setIsLoading(true)
      setZoom(1)
      setRotation(0)
      setPan({ x: 0, y: 0 })
      setSwipeX(0)
      setImageDimensions(null)
    }
  }, [canNext, parentControlsSelection, onFileChange, files, clampedIndex])

  const handleSelectFile = useCallback((index: number) => {
    const selectedFile = files[index]
    if (!selectedFile) return

    if (parentControlsSelection && onFileChange) {
      onFileChange(selectedFile)
    } else {
      setCurrentIndex(index)
    }

    setIsLoading(true)
    setZoom(1)
    setRotation(0)
    setPan({ x: 0, y: 0 })
    setSwipeX(0)
    setImageDimensions(null)
  }, [files, parentControlsSelection, onFileChange])

  // Handle image load to get dimensions
  const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget
    setImageDimensions({ width: img.naturalWidth, height: img.naturalHeight })
    setIsLoading(false)
  }, [])

  // Keyboard navigation
  useEffect(() => {
    if (!open) return

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowLeft":
          handlePrev()
          break
        case "ArrowRight":
          handleNext()
          break
        case "Escape":
          onOpenChange(false)
          break
        case "+":
        case "=":
          setZoom((z) => Math.min(z + 0.25, 5))
          break
        case "-":
          setZoom((z) => Math.max(z - 0.25, 0.25))
          break
        case "r":
          setRotation((r) => (r + 90) % 360)
          break
        case "0":
          setZoom(1)
          setRotation(0)
          setPan({ x: 0, y: 0 })
          break
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [open, handlePrev, handleNext, onOpenChange])

  // Touch gesture handlers (pinch zoom, pan, swipe between files, double-tap)
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const g = gestureRef.current
    const touches = Array.from(e.touches).map(t => ({ x: t.clientX, y: t.clientY }))
    g.startTouches = touches
    g.startZoom = zoom
    g.startPan = pan

    if (touches.length === 2) {
      g.startDistance = Math.hypot(
        touches[0].x - touches[1].x,
        touches[0].y - touches[1].y,
      )
    } else if (touches.length === 1) {
      const now = Date.now()
      const { x, y } = touches[0]
      const dt = now - g.lastTapTime
      const dist = Math.hypot(x - g.lastTapX, y - g.lastTapY)
      if (dt < 300 && dist < 30) {
        // Double tap — toggle zoom
        if (zoom > 1.1) {
          setZoom(1)
          setPan({ x: 0, y: 0 })
        } else {
          setZoom(2.5)
        }
        g.lastTapTime = 0
      } else {
        g.lastTapTime = now
        g.lastTapX = x
        g.lastTapY = y
      }
    }
  }, [zoom, pan])

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const g = gestureRef.current
    const touches = Array.from(e.touches).map(t => ({ x: t.clientX, y: t.clientY }))

    if (touches.length === 2 && g.startTouches.length === 2 && g.startDistance > 0) {
      const dist = Math.hypot(
        touches[0].x - touches[1].x,
        touches[0].y - touches[1].y,
      )
      const scale = dist / g.startDistance
      const nextZoom = Math.max(0.5, Math.min(5, g.startZoom * scale))
      setZoom(nextZoom)
      if (nextZoom <= 1.05) setPan({ x: 0, y: 0 })
    } else if (touches.length === 1 && g.startTouches.length === 1) {
      const dx = touches[0].x - g.startTouches[0].x
      const dy = touches[0].y - g.startTouches[0].y
      if (zoom > 1.05) {
        setPan({ x: g.startPan.x + dx, y: g.startPan.y + dy })
      } else if (Math.abs(dx) > Math.abs(dy)) {
        setSwipeX(dx)
      }
    }
  }, [zoom])

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    const g = gestureRef.current
    const remaining = e.touches.length
    if (g.startTouches.length === 1 && remaining === 0 && zoom <= 1.05) {
      const threshold = 70
      if (swipeX > threshold && canPrev) {
        handlePrev()
      } else if (swipeX < -threshold && canNext) {
        handleNext()
      }
      setSwipeX(0)
    }
    if (remaining === 0) {
      g.startTouches = []
      g.startDistance = 0
    } else {
      // Reset gesture baseline with remaining touches (e.g., releasing 2nd finger)
      g.startTouches = Array.from(e.touches).map(t => ({ x: t.clientX, y: t.clientY }))
      g.startZoom = zoom
      g.startPan = pan
      g.startDistance = 0
    }
  }, [zoom, pan, swipeX, canPrev, canNext, handlePrev, handleNext])

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen()
      setIsFullscreen(true)
    } else {
      document.exitFullscreen()
      setIsFullscreen(false)
    }
  }, [])

  // Close on backdrop click
  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onOpenChange(false)
    }
  }, [onOpenChange])

  if (!open || !currentFile) return null

  const isImage = isImageFile(currentFile.mime_type)
  const isPdf = isPdfFile(currentFile.mime_type)
  const activePdfPageClamped = Math.min(Math.max(activePdfPage, 1), Math.max(pdfPageCount, 1))
  const pdfPageWidth = pdfViewportWidth > 0
    ? Math.max(280, Math.min(1200, pdfViewportWidth - 48))
    : 900
  const PdfDocument = pdfComponents?.Document
  const PdfPage = pdfComponents?.Page
  const showPdfThumbnails =
    isPdf && !pdfLoadFailed && Boolean(currentPdfUrl) && Boolean(PdfDocument && PdfPage) && pdfPageCount > 1
  const pdfThumbnailWidth = 88

  const hasBottomStrip = showPdfThumbnails || hasMultiple

  return (
    <div
      className="fixed inset-0 z-50 flex bg-black/95"
      onClick={handleBackdropClick}
    >
      {/* Main viewer column */}
      <div
        ref={containerRef}
        className="relative flex-1 flex flex-col min-w-0"
        onClick={(e) => e.stopPropagation()}
      >
        {/* TOP BAR */}
        <div className="absolute top-0 inset-x-0 z-30 flex items-center gap-1 px-2 sm:px-3 py-2 sm:py-3 bg-gradient-to-b from-black/90 via-black/60 to-transparent pointer-events-none">
          <Button
            variant="ghost"
            size="icon"
            className="pointer-events-auto h-10 w-10 rounded-full text-white/90 hover:text-white hover:bg-white/10 flex-shrink-0"
            onClick={() => onOpenChange(false)}
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </Button>

          <div className="pointer-events-auto flex-1 min-w-0 text-white px-1 sm:px-2">
            <p className="text-sm font-medium truncate">{currentFile.file_name}</p>
            <p className="text-[11px] text-white/60 truncate">
              {formatFileSize(currentFile.size_bytes)}
              {imageDimensions && (
                <span> · {imageDimensions.width} × {imageDimensions.height}</span>
              )}
              {hasMultiple && (
                <span> · {clampedIndex + 1} of {files.length}</span>
              )}
              {isPdf && pdfPageCount > 0 && (
                <span> · Page {activePdfPageClamped} of {pdfPageCount}</span>
              )}
            </p>
          </div>

          {/* Desktop inline zoom controls */}
          {isImage && (
            <div className="pointer-events-auto hidden md:flex items-center gap-0.5 mr-1 bg-white/5 rounded-full px-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-full text-white/90 hover:text-white hover:bg-white/10"
                onClick={() => setZoom((z) => Math.max(z - 0.25, 0.25))}
                aria-label="Zoom out"
              >
                <ZoomOut className="h-4 w-4" />
              </Button>
              <button
                onClick={() => { setZoom(1); setRotation(0) }}
                className="text-xs text-white/70 hover:text-white tabular-nums w-12 text-center"
                aria-label="Reset zoom"
              >
                {Math.round(zoom * 100)}%
              </button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-full text-white/90 hover:text-white hover:bg-white/10"
                onClick={() => setZoom((z) => Math.min(z + 0.25, 5))}
                aria-label="Zoom in"
              >
                <ZoomIn className="h-4 w-4" />
              </Button>
            </div>
          )}

          {/* Primary action — download */}
          {onDownload && (
            <Button
              variant="ghost"
              size="icon"
              className="pointer-events-auto h-10 w-10 rounded-full text-white/90 hover:text-white hover:bg-white/10 flex-shrink-0"
              onClick={() => onDownload(currentFile)}
              aria-label="Download"
            >
              <Download className="h-4 w-4" />
            </Button>
          )}

          {/* Versions quick toggle (desktop) */}
          {hasVersionsPanel && (
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "pointer-events-auto hidden md:inline-flex h-10 w-10 rounded-full text-white/90 hover:text-white hover:bg-white/10 flex-shrink-0",
                showVersions && "bg-white/15 text-white"
              )}
              onClick={() => setShowVersions((prev) => !prev)}
              aria-label="Version history"
            >
              <History className="h-4 w-4" />
            </Button>
          )}

          {/* Overflow menu — mobile zoom/rotate, fullscreen, versions */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="pointer-events-auto h-10 w-10 rounded-full text-white/90 hover:text-white hover:bg-white/10 flex-shrink-0"
                aria-label="More options"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {isImage && (
                <div className="md:hidden">
                  <DropdownMenuItem onClick={() => setZoom((z) => Math.min(z + 0.25, 5))}>
                    <ZoomIn className="mr-2 h-4 w-4" />
                    Zoom in
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setZoom((z) => Math.max(z - 0.25, 0.25))}>
                    <ZoomOut className="mr-2 h-4 w-4" />
                    Zoom out
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => { setZoom(1); setRotation(0) }}>
                    Reset ({Math.round(zoom * 100)}%)
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </div>
              )}
              {isImage && (
                <DropdownMenuItem onClick={() => setRotation((r) => (r + 90) % 360)}>
                  <RotateCw className="mr-2 h-4 w-4" />
                  Rotate
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={toggleFullscreen}>
                {isFullscreen ? (
                  <><Minimize2 className="mr-2 h-4 w-4" /> Exit fullscreen</>
                ) : (
                  <><Maximize2 className="mr-2 h-4 w-4" /> Fullscreen</>
                )}
              </DropdownMenuItem>
              {hasVersionsPanel && (
                <DropdownMenuItem
                  className="md:hidden"
                  onClick={() => setShowVersions((prev) => !prev)}
                >
                  <History className="mr-2 h-4 w-4" />
                  {showVersions ? "Hide versions" : "Version history"}
                </DropdownMenuItem>
              )}
              {onDownload && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => onDownload(currentFile)}>
                    <Download className="mr-2 h-4 w-4" />
                    Download
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* NAV ARROWS */}
        {hasMultiple && (
          <>
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "absolute left-2 sm:left-4 top-1/2 -translate-y-1/2 z-20 h-10 w-10 sm:h-12 sm:w-12 rounded-full bg-black/40 backdrop-blur-sm text-white/90 hover:text-white hover:bg-black/60 transition-opacity",
                !canPrev && "opacity-0 pointer-events-none"
              )}
              onClick={handlePrev}
              disabled={!canPrev}
              aria-label="Previous"
            >
              <ChevronLeft className="h-5 w-5 sm:h-6 sm:w-6" />
            </Button>

            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "absolute right-2 sm:right-4 top-1/2 -translate-y-1/2 z-20 h-10 w-10 sm:h-12 sm:w-12 rounded-full bg-black/40 backdrop-blur-sm text-white/90 hover:text-white hover:bg-black/60 transition-opacity",
                !canNext && "opacity-0 pointer-events-none"
              )}
              onClick={handleNext}
              disabled={!canNext}
              aria-label="Next"
            >
              <ChevronRight className="h-5 w-5 sm:h-6 sm:w-6" />
            </Button>
          </>
        )}

        {/* CONTENT */}
        <div
          className={cn(
            "flex-1 flex items-center justify-center overflow-hidden relative",
            "pt-14 sm:pt-16",
            hasBottomStrip ? "pb-28 sm:pb-32" : "pb-4"
          )}
        >
          {isLoading && (
            <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
              <Loader2 className="h-8 w-8 animate-spin text-white/60" />
            </div>
          )}

          {isImage && currentFile.download_url && (
            <div
              className="absolute inset-0 flex items-center justify-center touch-none select-none"
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
              onTouchCancel={handleTouchEnd}
            >
              <div
                className={cn(
                  "flex items-center justify-center w-full h-full",
                  // Only animate when not actively gesturing (zoom=1, pan=0, swipeX=0 → reset states transition)
                  swipeX === 0 && "transition-transform duration-200 ease-out"
                )}
                style={{
                  transform: `translate3d(${swipeX + pan.x}px, ${pan.y}px, 0) scale(${zoom}) rotate(${rotation}deg)`,
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={currentFile.download_url}
                  alt={currentFile.file_name}
                  className={cn(
                    "max-w-full max-h-full w-auto h-auto object-contain pointer-events-none",
                    isLoading && "opacity-0"
                  )}
                  onLoad={handleImageLoad}
                  draggable={false}
                />
              </div>
            </div>
          )}

          {isPdf && currentFile.download_url && (
            <div ref={pdfViewportRef} className="h-full w-full overflow-auto bg-zinc-950/40">
              {!pdfLoadFailed && currentPdfUrl && PdfDocument && PdfPage ? (
                <PdfDocument
                  key={currentFile.id}
                  file={currentPdfUrl}
                  onLoadSuccess={(info: { numPages: number }) => {
                    setPdfPageCount(info.numPages)
                    setActivePdfPage((prev) => Math.min(Math.max(prev, 1), Math.max(info.numPages, 1)))
                    setPdfLoadFailed(false)
                  }}
                  onLoadError={(error: unknown) => {
                    console.error("Failed to load PDF", error)
                    setPdfLoadFailed(true)
                    setIsLoading(false)
                  }}
                >
                  <div className="flex min-h-full items-start justify-center p-4">
                    <PdfPage
                      pageNumber={activePdfPageClamped}
                      width={pdfPageWidth}
                      renderTextLayer={false}
                      renderAnnotationLayer={false}
                      onRenderSuccess={() => setIsLoading(false)}
                      className={cn("rounded-md shadow-2xl", isLoading && "opacity-0")}
                    />
                  </div>
                </PdfDocument>
              ) : !pdfLoadFailed && currentPdfUrl ? (
                <div className="h-full w-full" />
              ) : (
                <iframe
                  src={`${currentFile.download_url}#toolbar=0&navpanes=0`}
                  className={cn("w-full h-full bg-white", isLoading && "opacity-0")}
                  onLoad={() => setIsLoading(false)}
                  title={currentFile.file_name}
                />
              )}
            </div>
          )}

          {!isImage && !isPdf && (
            <div className="flex flex-col items-center justify-center gap-4 text-white/80 px-6 text-center">
              <FileText className="h-16 w-16" />
              <div>
                <p className="font-medium">{currentFile.file_name}</p>
                <p className="text-sm opacity-60 mt-1">
                  Preview not available for this file type
                </p>
                {onDownload && (
                  <Button
                    variant="secondary"
                    className="mt-4"
                    onClick={() => onDownload(currentFile)}
                  >
                    <Download className="mr-2 h-4 w-4" />
                    Download to view
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* BOTTOM STRIP */}
        {hasBottomStrip && (
          <div className="absolute bottom-0 inset-x-0 z-20 bg-gradient-to-t from-black/90 via-black/70 to-transparent pt-6 pb-3 px-3">
            {showPdfThumbnails && currentPdfUrl && PdfDocument && PdfPage ? (
              <PdfDocument
                key={`${currentFile.id}-thumbs`}
                file={currentPdfUrl}
                loading={null}
                noData={null}
                error={null}
              >
                <div className="flex items-center gap-2 overflow-x-auto pb-1 px-1">
                  {Array.from({ length: pdfPageCount }).map((_, pageIndex) => {
                    const pageNumber = pageIndex + 1
                    const active = pageNumber === activePdfPageClamped
                    return (
                      <button
                        key={`pdf-page-${pageNumber}`}
                        onClick={() => setActivePdfPage(pageNumber)}
                        aria-label={`Go to page ${pageNumber}`}
                        className={cn(
                          "group relative shrink-0 rounded-md overflow-hidden transition-all",
                          active
                            ? "ring-2 ring-primary shadow-lg"
                            : "opacity-60 hover:opacity-100 ring-1 ring-white/10"
                        )}
                      >
                        <div className="bg-white">
                          <PdfPage
                            pageNumber={pageNumber}
                            width={pdfThumbnailWidth}
                            renderTextLayer={false}
                            renderAnnotationLayer={false}
                            loading={
                              <div className="h-[114px] w-[88px] animate-pulse bg-zinc-200" />
                            }
                            error={
                              <div className="flex h-[114px] w-[88px] items-center justify-center bg-zinc-200 text-[10px] font-medium text-zinc-600">
                                {pageNumber}
                              </div>
                            }
                          />
                        </div>
                        <span
                          className={cn(
                            "absolute bottom-1 right-1 text-[10px] font-medium px-1.5 py-0.5 rounded tabular-nums",
                            active
                              ? "bg-primary text-primary-foreground"
                              : "bg-black/70 text-white/90"
                          )}
                        >
                          {pageNumber}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </PdfDocument>
            ) : hasMultiple ? (
              <div className="flex items-center justify-center gap-1.5 overflow-x-auto px-1">
                {files.map((f, index) => {
                  const active = index === clampedIndex
                  return (
                    <button
                      key={f.id}
                      onClick={() => handleSelectFile(index)}
                      className={cn(
                        "relative h-14 w-14 shrink-0 rounded-md overflow-hidden transition-all",
                        active
                          ? "ring-2 ring-primary shadow-lg scale-105"
                          : "opacity-60 hover:opacity-100 ring-1 ring-white/10"
                      )}
                      aria-label={f.file_name}
                    >
                      {isImageFile(f.mime_type) && f.thumbnail_url ? (
                        <Image
                          src={f.thumbnail_url}
                          alt={f.file_name}
                          fill
                          className="object-cover"
                          unoptimized
                        />
                      ) : (
                        <div className="flex items-center justify-center h-full w-full bg-zinc-800">
                          <FileText className="h-5 w-5 text-white/60" />
                        </div>
                      )}
                    </button>
                  )
                })}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* Versions side panel */}
      {hasVersionsPanel && showVersions && (
        <aside
          className="w-full sm:w-[360px] sm:max-w-[40vw] bg-background text-foreground border-l border-border overflow-y-auto flex-shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="p-4">
            <VersionHistoryPanel
              fileId={currentFile.id}
              fileName={currentFile.file_name}
              versions={versions ?? []}
              onUploadVersion={onUploadVersion!}
              onMakeCurrent={onMakeCurrentVersion!}
              onDownloadVersion={onDownloadVersion!}
              onUpdateVersion={onUpdateVersion!}
              onDeleteVersion={onDeleteVersion!}
              onRefresh={onRefreshVersions!}
            />
          </div>
        </aside>
      )}
    </div>
  )
}
