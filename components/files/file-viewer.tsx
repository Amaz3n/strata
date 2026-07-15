"use client"

import { useState, useCallback, useEffect, useRef, type ReactNode } from "react"
import { createPortal } from "react-dom"
import Image from "next/image"
import { cn } from "@/lib/utils"
import { useHydrated } from "@/hooks/use-hydrated"
import { useIsMobile } from "@/hooks/use-mobile"
import {
  X,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  RotateCw,
  Download,
  Info,
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
import {
  type FileWithDetails,
  isBrowserRenderableImage,
  isAudioFile,
  isHeicFile,
  isImageFile,
  isPdfFile,
  isVideoFile,
  isWordPreviewable,
  formatFileSize,
} from "./types"
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
  /**
   * Optional side panel describing the file on screen. Opens by default on desktop.
   * Track the visible file with `onFileChange` to keep this in sync while navigating.
   */
  details?: ReactNode
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
  details,
}: FileViewerProps) {
  const isMobile = useIsMobile()
  const hydrated = useHydrated()
  const [zoom, setZoom] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [swipeX, setSwipeX] = useState(0)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null)
  const [pdfPageCount, setPdfPageCount] = useState(0)
  const [activePdfPage, setActivePdfPage] = useState(1)
  const [pdfLoadFailed, setPdfLoadFailed] = useState(false)
  const [imageLoadFailed, setImageLoadFailed] = useState(false)
  const [wordLoadFailed, setWordLoadFailed] = useState(false)
  const [wordHtml, setWordHtml] = useState<string | null>(null)
  const [pdfViewportWidth, setPdfViewportWidth] = useState(0)
  const [pdfComponents, setPdfComponents] = useState<{
    Document: any
    Page: any
    pdfjs: any
  } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
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
  const currentFileId = currentFile?.id
  const currentFileIsPdf = currentFile ? isPdfFile(currentFile.mime_type) : false
  const currentFileIsWord = currentFile ? isWordPreviewable(currentFile.mime_type, currentFile.file_name) : false
  const currentPdfUrl = currentFile ? (currentFile.download_url ?? `/api/files/${currentFile.id}/raw`) : null
  const currentFileHasGeneratedImagePreview =
    Boolean(currentFile?.thumbnail_url) &&
    currentFile?.thumbnail_url !== currentFile?.download_url
  const currentFileIsHeic = currentFile ? isHeicFile(currentFile.mime_type, currentFile.file_name) : false
  const currentFileIsImage = currentFile
    ? isBrowserRenderableImage(
        currentFile.mime_type,
        currentFile.file_name,
        currentFileHasGeneratedImagePreview
      )
    : false
  const currentImageSrc =
    currentFile && currentFileIsImage
      ? currentFileIsHeic && currentFile.thumbnail_url
        ? currentFile.thumbnail_url
        : currentFile.download_url
      : undefined

  useEffect(() => {
    if (!open || !currentFileIsPdf) return
    let cancelled = false

    const loadPdfComponents = async () => {
      try {
        const { Document, Page, pdfjs } = await import("react-pdf")
        if (cancelled) return
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs"
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

  // Fetch the Word preview HTML and render it via srcDoc. Fetching (rather than
  // pointing an iframe at the route URL) sidesteps the global X-Frame-Options: DENY
  // header, while the sandboxed srcDoc keeps the document fully isolated.
  useEffect(() => {
    if (!open || !currentFileIsWord || !currentFileId) return
    let cancelled = false

    setWordHtml(null)
    setWordLoadFailed(false)
    setIsLoading(true)

    fetch(`/api/files/${currentFileId}/word-preview`, { credentials: "same-origin" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Preview request failed (${res.status})`)
        return res.text()
      })
      .then((html) => {
        if (cancelled) return
        setWordHtml(html)
        setIsLoading(false)
      })
      .catch((error) => {
        if (cancelled) return
        console.error("Failed to load Word preview", error)
        setWordLoadFailed(true)
        setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, currentFileIsWord, currentFileId])

  // Hide the mobile bottom nav (and any other immersive-aware chrome) while open
  useEffect(() => {
    if (typeof window === "undefined" || !open) return
    window.dispatchEvent(
      new CustomEvent("arc-immersive-view", { detail: { active: true } }),
    )
    return () => {
      window.dispatchEvent(
        new CustomEvent("arc-immersive-view", { detail: { active: false } }),
      )
    }
  }, [open])

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
    setImageLoadFailed(false)
    setWordLoadFailed(false)
    setWordHtml(null)

    if (hasFileList && derivedIndexFromFile >= 0) {
      setCurrentIndex(derivedIndexFromFile)
    }
  }, [currentFileId, derivedIndexFromFile, hasFileList])

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
  const hasDetailsPanel = Boolean(details)

  // Details lead on desktop, where they sit beside the file rather than on top of it.
  useEffect(() => {
    if (!open) return
    setShowDetails(hasDetailsPanel && !isMobile)
  }, [open, hasDetailsPanel, isMobile])

  const toggleDetails = useCallback(() => {
    setShowDetails((prev) => {
      if (!prev) setShowVersions(false)
      return !prev
    })
  }, [])

  const toggleVersions = useCallback(() => {
    setShowVersions((prev) => {
      if (!prev) setShowDetails(false)
      return !prev
    })
  }, [])

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
      setImageLoadFailed(false)
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
      setImageLoadFailed(false)
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
    setImageLoadFailed(false)
  }, [files, parentControlsSelection, onFileChange])

  // Handle image load to get dimensions
  const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget
    setImageDimensions({ width: img.naturalWidth, height: img.naturalHeight })
    setImageLoadFailed(false)
    setIsLoading(false)
  }, [])

  const handleImageError = useCallback(() => {
    setImageLoadFailed(true)
    setIsLoading(false)
  }, [])

  useEffect(() => {
    if (!open || !currentImageSrc) return

    const img = imageRef.current
    const resolvedImageSrc = new URL(currentImageSrc, window.location.href).href
    if (!img || img.src !== resolvedImageSrc || !img.complete) return

    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      setImageDimensions({ width: img.naturalWidth, height: img.naturalHeight })
      setImageLoadFailed(false)
      setIsLoading(false)
    } else {
      setImageLoadFailed(true)
      setIsLoading(false)
    }
  }, [open, currentImageSrc])

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

  if (!open || !currentFile || !hydrated) return null

  const isImage = currentFileIsImage
  const isHeic = currentFileIsHeic
  const isPdf = isPdfFile(currentFile.mime_type)
  const isVideo = isVideoFile(currentFile.mime_type)
  const isAudio = isAudioFile(currentFile.mime_type)
  const isWord = isWordPreviewable(currentFile.mime_type, currentFile.file_name)
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

  // Portalled to the body so the viewer escapes whatever opened it: rendered
  // inline it sat earlier in the DOM than a drawer's portal (and inside vaul's
  // transformed panel), so it opened *behind* the drawer. Overlays here all share
  // z-50 and stack by mount order — last opened wins — which keeps the version
  // AlertDialog below on top of the viewer. A modal drawer also sets
  // `pointer-events: none` on the body, hence pointer-events-auto.
  return createPortal(
    <div
      className="pointer-events-auto fixed inset-0 z-50 flex bg-neutral-900"
      onClick={handleBackdropClick}
    >
      {/* Main viewer column */}
      <div
        ref={containerRef}
        className="relative flex-1 flex flex-col min-w-0"
        onClick={(e) => e.stopPropagation()}
      >
        {/* TOP-LEFT: identity + navigation */}
        <div className="absolute left-3 sm:left-4 top-[calc(0.75rem+env(safe-area-inset-top))] z-30 flex max-w-[calc(100%-9.5rem)] items-center gap-1 rounded-xl border bg-background/95 p-1 shadow-lg backdrop-blur-md sm:max-w-[460px]">
          {hasMultiple && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="hidden h-9 w-9 sm:inline-flex"
                onClick={handlePrev}
                disabled={!canPrev}
                aria-label="Previous"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="hidden w-10 text-center font-mono text-xs tabular-nums text-muted-foreground sm:inline">
                {clampedIndex + 1}/{files.length}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="hidden h-9 w-9 sm:inline-flex"
                onClick={handleNext}
                disabled={!canNext}
                aria-label="Next"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
              <div className="mx-1 hidden h-6 w-px bg-border sm:block" />
            </>
          )}
          <div className="flex h-9 min-w-0 items-center gap-2 px-1">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground">
              {isImage && currentFile.thumbnail_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={currentFile.thumbnail_url} alt="" className="h-full w-full object-cover" />
              ) : (
                <FileText className="h-3.5 w-3.5" />
              )}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold leading-tight">{currentFile.file_name}</p>
              <p className="truncate text-[11px] leading-tight text-muted-foreground">
                {formatFileSize(currentFile.size_bytes)}
                {imageDimensions && (
                  <span> · {imageDimensions.width} × {imageDimensions.height}</span>
                )}
                {hasMultiple && <span> · {clampedIndex + 1} of {files.length}</span>}
                {isPdf && pdfPageCount > 0 && (
                  <span> · Page {activePdfPageClamped} of {pdfPageCount}</span>
                )}
              </p>
            </div>
          </div>
        </div>

        {/* TOP-RIGHT: view + actions */}
        <div className="absolute right-3 sm:right-4 top-[calc(0.75rem+env(safe-area-inset-top))] z-30 flex items-center gap-2">
          {/* Mobile: compact pill */}
          <div className="flex items-center gap-0.5 rounded-xl border bg-background/95 p-1 shadow-lg backdrop-blur-md md:hidden">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-9 w-9" aria-label="More options">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                {isImage && (
                  <>
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
                    <DropdownMenuItem onClick={() => setRotation((r) => (r + 90) % 360)}>
                      <RotateCw className="mr-2 h-4 w-4" />
                      Rotate
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem onClick={toggleFullscreen}>
                  {isFullscreen ? (
                    <><Minimize2 className="mr-2 h-4 w-4" /> Exit fullscreen</>
                  ) : (
                    <><Maximize2 className="mr-2 h-4 w-4" /> Fullscreen</>
                  )}
                </DropdownMenuItem>
                {hasDetailsPanel && (
                  <DropdownMenuItem onClick={toggleDetails}>
                    <Info className="mr-2 h-4 w-4" />
                    {showDetails ? "Hide details" : "Details"}
                  </DropdownMenuItem>
                )}
                {hasVersionsPanel && (
                  <DropdownMenuItem onClick={toggleVersions}>
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
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              onClick={() => onOpenChange(false)}
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* Desktop: zoom pill (images) */}
          {isImage && (
            <div className="hidden items-center gap-0.5 rounded-xl border bg-background/95 p-1 shadow-lg backdrop-blur-md md:flex">
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9"
                onClick={() => setZoom((z) => Math.max(z - 0.25, 0.25))}
                title="Zoom out"
              >
                <ZoomOut className="h-4 w-4" />
              </Button>
              <button
                onClick={() => { setZoom(1); setRotation(0) }}
                className="w-11 text-center font-mono text-xs tabular-nums text-muted-foreground transition-colors hover:text-foreground"
                title="Reset zoom"
              >
                {Math.round(zoom * 100)}%
              </button>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9"
                onClick={() => setZoom((z) => Math.min(z + 0.25, 5))}
                title="Zoom in"
              >
                <ZoomIn className="h-4 w-4" />
              </Button>
            </div>
          )}

          {/* Desktop: actions pill */}
          <div className="hidden items-center gap-0.5 rounded-xl border bg-background/95 p-1 shadow-lg backdrop-blur-md md:flex">
            {isImage && (
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9"
                onClick={() => setRotation((r) => (r + 90) % 360)}
                title="Rotate"
              >
                <RotateCw className="h-4 w-4" />
              </Button>
            )}
            {hasDetailsPanel && (
              <Button
                variant={showDetails ? "secondary" : "ghost"}
                size="icon"
                className="h-9 w-9"
                onClick={toggleDetails}
                title="Details"
              >
                <Info className="h-4 w-4" />
              </Button>
            )}
            {hasVersionsPanel && (
              <Button
                variant={showVersions ? "secondary" : "ghost"}
                size="icon"
                className="h-9 w-9"
                onClick={toggleVersions}
                title="Version history"
              >
                <History className="h-4 w-4" />
              </Button>
            )}
            {onDownload && (
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9"
                onClick={() => onDownload(currentFile)}
                title="Download"
              >
                <Download className="h-4 w-4" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              onClick={toggleFullscreen}
              title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            >
              {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </Button>
            <div className="mx-1 h-6 w-px bg-border" />
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              onClick={() => onOpenChange(false)}
              title="Close (Esc)"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* CONTENT */}
        <div
          className={cn(
            "flex-1 flex items-center justify-center overflow-hidden relative",
            "pt-[calc(4.5rem+env(safe-area-inset-top))]",
            hasBottomStrip ? "pb-28 sm:pb-32" : "pb-[max(env(safe-area-inset-bottom),1rem)]"
          )}
        >
          {isLoading && (
            <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
              <Loader2 className="h-8 w-8 animate-spin text-white/60" />
            </div>
          )}

          {isImage && currentImageSrc && !imageLoadFailed && (
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
                  ref={imageRef}
                  src={currentImageSrc}
                  alt={currentFile.file_name}
                  className={cn(
                    "max-w-full max-h-full w-auto h-auto object-contain pointer-events-none",
                    isLoading && "opacity-0"
                  )}
                  onLoad={handleImageLoad}
                  onError={handleImageError}
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

          {isVideo && currentFile.download_url && (
            <div className="absolute inset-0 flex items-center justify-center px-3 sm:px-6">
              <video
                key={currentFile.id}
                src={currentFile.download_url}
                controls
                playsInline
                preload="metadata"
                className={cn("max-h-full max-w-full rounded-md shadow-2xl", isLoading && "opacity-0")}
                onLoadedMetadata={() => setIsLoading(false)}
                onCanPlay={() => setIsLoading(false)}
                onError={() => setIsLoading(false)}
              />
            </div>
          )}

          {isAudio && currentFile.download_url && (
            <div className="absolute inset-0 flex items-center justify-center px-4">
              <div className="w-full max-w-xl rounded-2xl border bg-background/95 p-6 shadow-2xl backdrop-blur-md">
                <div className="mb-4 flex items-center gap-3">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                    <FileText className="h-5 w-5" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{currentFile.file_name}</p>
                    <p className="text-xs text-muted-foreground">{formatFileSize(currentFile.size_bytes)}</p>
                  </div>
                </div>
                <audio
                  key={currentFile.id}
                  src={currentFile.download_url}
                  controls
                  preload="metadata"
                  className="w-full"
                  onLoadedMetadata={() => setIsLoading(false)}
                  onCanPlay={() => setIsLoading(false)}
                  onError={() => setIsLoading(false)}
                />
              </div>
            </div>
          )}

          {isWord && !wordLoadFailed && wordHtml && (
            <div className="h-full w-full overflow-hidden bg-zinc-950/40">
              <iframe
                key={currentFile.id}
                srcDoc={wordHtml}
                sandbox=""
                referrerPolicy="no-referrer"
                className="h-full w-full border-0 bg-[#f1f5f9]"
                onLoad={() => setIsLoading(false)}
                title={currentFile.file_name}
              />
            </div>
          )}

          {((isImage && imageLoadFailed) ||
            (isWord && wordLoadFailed) ||
            (!isImage && !isPdf && !isVideo && !isAudio && !isWord)) && (
            <div className="mx-4 flex max-w-sm flex-col items-center justify-center gap-4 rounded-2xl border bg-background/95 px-8 py-10 text-center shadow-xl backdrop-blur-md">
              <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                <FileText className="h-8 w-8" />
              </span>
              <div>
                <p className="font-semibold">{currentFile.file_name}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {isHeic
                    ? imageLoadFailed
                      ? "HEIC preview is not available yet. The original file is still downloadable."
                      : currentFile.preview_status === "failed"
                      ? "HEIC preview generation failed. The original file is still downloadable."
                      : "HEIC preview is still processing. The original file is downloadable now."
                    : isWord
                    ? "We couldn't render a preview for this document. The original file is still downloadable."
                    : "Preview not available for this file type"}
                </p>
                {onDownload && (
                  <Button
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
          <div className="absolute inset-x-0 bottom-[max(env(safe-area-inset-bottom),0.75rem)] z-20 flex justify-center px-3">
            <div className="max-w-full overflow-hidden rounded-xl border bg-background/95 p-1.5 shadow-lg backdrop-blur-md">
            {showPdfThumbnails && currentPdfUrl && PdfDocument && PdfPage ? (
              <PdfDocument
                key={`${currentFile.id}-thumbs`}
                file={currentPdfUrl}
                loading={null}
                noData={null}
                error={null}
              >
                <div className="flex items-center gap-2 overflow-x-auto p-1">
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
                            ? "ring-2 ring-primary shadow-md"
                            : "opacity-70 hover:opacity-100 ring-1 ring-border"
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
              <div className="flex items-center gap-1.5 overflow-x-auto p-1">
                {files.map((f, index) => {
                  const active = index === clampedIndex
                  return (
                    <button
                      key={f.id}
                      onClick={() => handleSelectFile(index)}
                      className={cn(
                        "relative h-14 w-14 shrink-0 rounded-md overflow-hidden transition-all",
                        active
                          ? "ring-2 ring-primary shadow-md"
                          : "opacity-70 hover:opacity-100 ring-1 ring-border"
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
                        <div className="flex items-center justify-center h-full w-full bg-muted">
                          <FileText className="h-5 w-5 text-muted-foreground" />
                        </div>
                      )}
                    </button>
                  )
                })}
              </div>
            ) : null}
            </div>
          </div>
        )}
      </div>

      {/* Details side panel */}
      {hasDetailsPanel && showDetails && (
        <aside
          className="w-full sm:w-[320px] sm:max-w-[40vw] bg-background text-foreground border-l border-border overflow-y-auto flex-shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          {details}
        </aside>
      )}

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
    </div>,
    document.body,
  )
}
