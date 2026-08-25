"use client"

import { useState, useCallback, useEffect, useRef, type ReactNode } from "react"
import { createPortal } from "react-dom"
import dynamic from "next/dynamic"
import Image from "next/image"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { useHydrated } from "@/hooks/use-hydrated"
import { useIsMobile } from "@/hooks/use-mobile"
import { PDF_WORKER_SRC } from "@/lib/pdf/worker-src"
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
  History,
  MoreHorizontal,
  Printer,
} from "@/components/icons"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import {
  INITIAL_PDF_STATUS,
  PdfSkeleton,
  clampPdfScale,
  type PdfViewerStatus,
  type PdfZoom,
} from "./pdf-chrome"
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

/**
 * react-pdf and pdf.js are ~1MB of the client bundle plus two stylesheets. They
 * load only once a PDF is actually on screen — this component is mounted by
 * every attachment list in the app.
 *
 * The `import()` has to stay written out inline here. `ssr: false` is applied by
 * a compile-time transform that only recognises a literal dynamic import, so
 * hoisting the import into a helper silently loses the exclusion — pdf.js then
 * runs during server rendering and dies on `DOMMatrix is not defined`, which
 * surfaces much later as a worker that was never configured.
 */
const PdfViewer = dynamic(() => import("./pdf-viewer").then((mod) => mod.PdfViewer), {
  ssr: false,
  loading: () => <PdfSkeleton />,
})

/**
 * Pull the PDF stack into cache before anyone asks for it.
 *
 * Left alone, the first PDF a user opens pays for ~1MB of viewer chunk plus the
 * worker before a single page can render, so it feels markedly slower than
 * every PDF opened after it. A surface that expects PDFs — the documents page —
 * calls this while the browser is idle, which makes the first open cost the
 * same as the rest.
 *
 * Safe to call repeatedly: the module import is memoized by the bundler, and
 * the worker request is answered from the HTTP cache.
 */
export function preloadPdfViewer(): void {
  // Spelled out again rather than shared with the `dynamic()` call above: both
  // resolve to the same chunk, so this warms exactly what opening a PDF needs,
  // and neither one stops being a literal import the compiler can see.
  void import("./pdf-viewer").catch(() => {
    // A failed prefetch is not a failure: opening a PDF retries the import and
    // surfaces the error there, where there is somewhere to show it.
  })
  void fetch(PDF_WORKER_SRC, { credentials: "same-origin" }).catch(() => {})
}

const FIT_WIDTH: PdfZoom = { kind: "fit-width" }
const FIT_PAGE: PdfZoom = { kind: "fit-page" }
const ZOOM_PRESETS = [0.5, 0.75, 1, 1.5, 2, 4]

const FOCUSABLE_SELECTOR =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),video[controls],audio[controls],[tabindex]:not([tabindex="-1"])'

/**
 * Print without a round trip through the Downloads folder. The file is fetched
 * to a blob and handed to a hidden same-origin iframe: pointing an iframe at
 * the file route directly cannot work, because the app sends
 * `X-Frame-Options: DENY` on every response.
 */
async function printFromUrl(url: string, fileName: string): Promise<void> {
  try {
    const response = await fetch(url, { credentials: "same-origin" })
    if (!response.ok) throw new Error(`Print request failed (${response.status})`)
    const blobUrl = URL.createObjectURL(await response.blob())

    const frame = document.createElement("iframe")
    frame.title = fileName
    frame.setAttribute("aria-hidden", "true")
    frame.style.cssText =
      "position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0;border:0;"

    const cleanup = () => {
      URL.revokeObjectURL(blobUrl)
      frame.remove()
    }

    frame.onload = () => {
      const frameWindow = frame.contentWindow
      if (!frameWindow) {
        cleanup()
        toast.error("Could not open the print dialog")
        return
      }
      frameWindow.focus()
      frameWindow.print()
      // The print dialog is modal but asynchronous; the frame has to outlive it.
      window.setTimeout(cleanup, 60_000)
    }
    frame.onerror = cleanup

    frame.src = blobUrl
    document.body.appendChild(frame)
  } catch (error) {
    console.error("Failed to print file", error)
    // Last resort: hand it to the browser's own viewer, which can print it.
    if (!window.open(url, "_blank", "noopener,noreferrer")) {
      toast.error("Could not open this file for printing")
    }
  }
}

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
  const [imageLoadFailed, setImageLoadFailed] = useState(false)
  const [wordLoadFailed, setWordLoadFailed] = useState(false)
  const [wordHtml, setWordHtml] = useState<string | null>(null)
  const [pdfZoom, setPdfZoom] = useState<PdfZoom>(FIT_WIDTH)
  const [pdfRotation, setPdfRotation] = useState(0)
  const [pdfStatus, setPdfStatus] = useState<PdfViewerStatus>(INITIAL_PDF_STATUS)
  const dialogRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
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
    setImageLoadFailed(false)
    setWordLoadFailed(false)
    setWordHtml(null)
    setPdfZoom(FIT_WIDTH)
    setPdfRotation(0)
    setPdfStatus(INITIAL_PDF_STATUS)

    if (hasFileList && derivedIndexFromFile >= 0) {
      setCurrentIndex(derivedIndexFromFile)
    }
  }, [currentFileId, derivedIndexFromFile, hasFileList])

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

  /**
   * PDFs and images answer the same four verbs, but a PDF's "zoom" is a page
   * width the viewer derives from its own viewport, so it reports back the
   * scale it actually landed on and the chrome drives it from there.
   */
  const handlePdfStatus = useCallback((next: PdfViewerStatus) => {
    setPdfStatus((prev) =>
      prev.state === next.state &&
      prev.pageCount === next.pageCount &&
      prev.activePage === next.activePage &&
      prev.effectiveScale === next.effectiveScale
        ? prev
        : next
    )
  }, [])

  const handleZoomIn = useCallback(() => {
    if (currentFileIsPdf) {
      setPdfZoom({ kind: "scale", value: clampPdfScale(pdfStatus.effectiveScale * 1.25) })
    } else {
      setZoom((z) => Math.min(z + 0.25, 5))
    }
  }, [currentFileIsPdf, pdfStatus.effectiveScale])

  const handleZoomOut = useCallback(() => {
    if (currentFileIsPdf) {
      setPdfZoom({ kind: "scale", value: clampPdfScale(pdfStatus.effectiveScale / 1.25) })
    } else {
      setZoom((z) => Math.max(z - 0.25, 0.25))
    }
  }, [currentFileIsPdf, pdfStatus.effectiveScale])

  const handleZoomReset = useCallback(() => {
    if (currentFileIsPdf) {
      setPdfZoom(FIT_WIDTH)
      setPdfRotation(0)
    } else {
      setZoom(1)
      setRotation(0)
      setPan({ x: 0, y: 0 })
    }
  }, [currentFileIsPdf])

  const handleRotate = useCallback(() => {
    if (currentFileIsPdf) {
      setPdfRotation((r) => (r + 90) % 360)
    } else {
      setRotation((r) => (r + 90) % 360)
    }
  }, [currentFileIsPdf])

  const handleDownloadCurrent = useCallback(() => {
    if (currentFile && onDownload) onDownload(currentFile)
  }, [currentFile, onDownload])

  // Print what is on screen, not what is in storage: a HEIC previews through a
  // generated JPEG, and the browser cannot render the original at all.
  const printableUrl = currentFileIsPdf
    ? currentFile?.download_url ?? null
    : currentFileIsImage
      ? currentImageSrc ?? null
      : null

  const handlePrint = useCallback(() => {
    if (!printableUrl || !currentFile) return
    void printFromUrl(printableUrl, currentFile.file_name)
  }, [printableUrl, currentFile])

  // Keyboard: navigation, view controls, and the modal's focus loop.
  useEffect(() => {
    if (!open) return

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      const inEditableField =
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT")

      if (event.key === "Escape") {
        onOpenChange(false)
        return
      }
      if (inEditableField) return

      const root = dialogRef.current
      if (event.key === "Tab" && root) {
        const active = document.activeElement
        // A menu or dialog portalled outside the viewer manages its own focus.
        if (!(active instanceof HTMLElement) || !root.contains(active)) return
        const focusable = Array.from(
          root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
        ).filter((el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === active)
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (event.shiftKey && (active === first || active === root)) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && active === last) {
          event.preventDefault()
          first.focus()
        }
        return
      }

      // Leave browser and OS chords alone — Ctrl/Cmd+F must reach the text layer.
      if (event.metaKey || event.ctrlKey || event.altKey) return

      switch (event.key) {
        case "ArrowLeft":
          handlePrev()
          break
        case "ArrowRight":
          handleNext()
          break
        case "+":
        case "=":
          event.preventDefault()
          handleZoomIn()
          break
        case "-":
          event.preventDefault()
          handleZoomOut()
          break
        case "r":
        case "R":
          handleRotate()
          break
        case "0":
          handleZoomReset()
          break
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [
    open,
    handlePrev,
    handleNext,
    handleZoomIn,
    handleZoomOut,
    handleRotate,
    handleZoomReset,
    onOpenChange,
  ])

  // Focus moves into the viewer on open and back where it came from on close.
  useEffect(() => {
    if (!open) return
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialogRef.current?.focus()
    return () => {
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus()
      }
    }
  }, [open])

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
  const isPdf = currentFileIsPdf
  const isVideo = isVideoFile(currentFile.mime_type)
  const isAudio = isAudioFile(currentFile.mime_type)
  const isWord = currentFileIsWord

  // One URL, one gate. `download_url` is optional on the shape callers hand us
  // (attachment lists and portal galleries build it themselves), so a missing
  // one is a real state — and it lands in the unavailable card below rather
  // than rendering an empty frame.
  const previewUrl = currentFile.download_url ?? null
  const canZoom = isImage || isPdf
  const zoomPercent = isPdf
    ? Math.round(pdfStatus.effectiveScale * 100)
    : Math.round(zoom * 100)

  const showPdfRail = isPdf && pdfStatus.state === "ready" && pdfStatus.pageCount > 1
  const showFileStrip = hasMultiple && !showPdfRail

  const showUnavailable =
    (isImage && (imageLoadFailed || !currentImageSrc)) ||
    (isWord && wordLoadFailed) ||
    (isPdf && !previewUrl) ||
    ((isVideo || isAudio) && !previewUrl) ||
    (!isImage && !isPdf && !isVideo && !isAudio && !isWord)

  // Portalled to the body so the viewer escapes whatever opened it: rendered
  // inline it sat earlier in the DOM than a drawer's portal (and inside vaul's
  // transformed panel), so it opened *behind* the drawer. Overlays here all share
  // z-50 and stack by mount order — last opened wins — which keeps the version
  // AlertDialog below on top of the viewer. A modal drawer also sets
  // `pointer-events: none` on the body, hence pointer-events-auto.
  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={currentFile.file_name}
      tabIndex={-1}
      className="pointer-events-auto fixed inset-0 z-50 flex bg-sidebar outline-none"
      onClick={handleBackdropClick}
    >
      {/* Main viewer column */}
      <div
        className="relative flex-1 flex flex-col min-w-0"
        onClick={(e) => e.stopPropagation()}
      >
        {/* TOP-LEFT: identity + navigation */}
        <div className="absolute left-3 sm:left-4 top-[calc(0.75rem+env(safe-area-inset-top))] z-30 flex max-w-[calc(100%-9.5rem)] items-center gap-1 border bg-background/95 p-1 shadow-lg backdrop-blur-md sm:max-w-[460px]">
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
            <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden bg-muted text-muted-foreground">
              {isImage && currentFile.thumbnail_url ? (
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
                {isPdf && pdfStatus.pageCount > 0 && (
                  <span> · Page {pdfStatus.activePage} of {pdfStatus.pageCount}</span>
                )}
              </p>
            </div>
          </div>
        </div>

        {/* TOP-RIGHT: view + actions */}
        <div className="absolute right-3 sm:right-4 top-[calc(0.75rem+env(safe-area-inset-top))] z-30 flex items-center gap-2">
          {/* Mobile: compact pill */}
          <div className="flex items-center gap-0.5 border bg-background/95 p-1 shadow-lg backdrop-blur-md md:hidden">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-9 w-9" aria-label="More options">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                {canZoom && (
                  <>
                    <DropdownMenuItem onClick={handleZoomIn}>
                      <ZoomIn className="mr-2 h-4 w-4" />
                      Zoom in
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={handleZoomOut}>
                      <ZoomOut className="mr-2 h-4 w-4" />
                      Zoom out
                    </DropdownMenuItem>
                    {isPdf ? (
                      <>
                        <DropdownMenuItem onClick={() => setPdfZoom(FIT_WIDTH)}>
                          Fit width ({zoomPercent}%)
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setPdfZoom(FIT_PAGE)}>
                          Fit page
                        </DropdownMenuItem>
                      </>
                    ) : (
                      <DropdownMenuItem onClick={handleZoomReset}>
                        Reset ({zoomPercent}%)
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onClick={handleRotate}>
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
                {(printableUrl || onDownload) && <DropdownMenuSeparator />}
                {printableUrl && (
                  <DropdownMenuItem onClick={handlePrint}>
                    <Printer className="mr-2 h-4 w-4" />
                    Print
                  </DropdownMenuItem>
                )}
                {onDownload && (
                  <DropdownMenuItem onClick={handleDownloadCurrent}>
                    <Download className="mr-2 h-4 w-4" />
                    Download
                  </DropdownMenuItem>
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

          {/* Desktop: zoom pill */}
          {canZoom && (
            <div className="hidden items-center gap-0.5 border bg-background/95 p-1 shadow-lg backdrop-blur-md md:flex">
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9"
                onClick={handleZoomOut}
                title="Zoom out (−)"
                aria-label="Zoom out"
              >
                <ZoomOut className="h-4 w-4" />
              </Button>
              {isPdf ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      className="w-14 text-center font-mono text-xs tabular-nums text-muted-foreground transition-colors hover:text-foreground"
                      title="Zoom level"
                      aria-label={`Zoom level, ${zoomPercent} percent`}
                    >
                      {zoomPercent}%
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuItem onClick={() => setPdfZoom(FIT_WIDTH)}>
                      Fit width
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setPdfZoom(FIT_PAGE)}>
                      Fit page
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    {ZOOM_PRESETS.map((preset) => (
                      <DropdownMenuItem
                        key={preset}
                        onClick={() => setPdfZoom({ kind: "scale", value: preset })}
                      >
                        <span className="tabular-nums">{Math.round(preset * 100)}%</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <button
                  onClick={handleZoomReset}
                  className="w-14 text-center font-mono text-xs tabular-nums text-muted-foreground transition-colors hover:text-foreground"
                  title="Reset zoom (0)"
                  aria-label={`Reset zoom, currently ${zoomPercent} percent`}
                >
                  {zoomPercent}%
                </button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9"
                onClick={handleZoomIn}
                title="Zoom in (+)"
                aria-label="Zoom in"
              >
                <ZoomIn className="h-4 w-4" />
              </Button>
            </div>
          )}

          {/* Desktop: actions pill */}
          <div className="hidden items-center gap-0.5 border bg-background/95 p-1 shadow-lg backdrop-blur-md md:flex">
            {canZoom && (
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9"
                onClick={handleRotate}
                title="Rotate (R)"
                aria-label="Rotate"
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
                aria-label="Details"
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
                aria-label="Version history"
              >
                <History className="h-4 w-4" />
              </Button>
            )}
            {printableUrl && (
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9"
                onClick={handlePrint}
                title="Print"
                aria-label="Print"
              >
                <Printer className="h-4 w-4" />
              </Button>
            )}
            {onDownload && (
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9"
                onClick={handleDownloadCurrent}
                title="Download"
                aria-label="Download"
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
              aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
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
              aria-label="Close"
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
            showFileStrip ? "pb-28 sm:pb-32" : "pb-[max(env(safe-area-inset-bottom),1rem)]"
          )}
        >
          {isImage && currentImageSrc && !imageLoadFailed && (
            <div
              className="absolute inset-0 flex items-center justify-center touch-none select-none"
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
              onTouchCancel={handleTouchEnd}
            >
              {isLoading && (
                <div className="absolute inset-0 flex items-center justify-center p-8">
                  <Skeleton className="h-full w-full max-w-3xl" />
                </div>
              )}
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

          {isPdf && previewUrl && (
            <div className="relative h-full w-full bg-sidebar">
              <PdfViewer
                key={currentFile.id}
                url={previewUrl}
                fileId={currentFile.id}
                fileName={currentFile.file_name}
                zoom={pdfZoom}
                rotation={pdfRotation}
                onStatusChange={handlePdfStatus}
                onDownload={onDownload ? handleDownloadCurrent : undefined}
              />
            </div>
          )}

          {isVideo && previewUrl && (
            <div className="absolute inset-0 flex items-center justify-center px-3 sm:px-6">
              {isLoading && (
                <div className="absolute inset-0 flex items-center justify-center p-8">
                  <Skeleton className="h-full w-full max-w-3xl" />
                </div>
              )}
              <video
                key={currentFile.id}
                src={previewUrl}
                controls
                playsInline
                preload="metadata"
                className={cn("max-h-full max-w-full shadow-2xl", isLoading && "opacity-0")}
                onLoadedMetadata={() => setIsLoading(false)}
                onCanPlay={() => setIsLoading(false)}
                onError={() => setIsLoading(false)}
              />
            </div>
          )}

          {isAudio && previewUrl && (
            <div className="absolute inset-0 flex items-center justify-center px-4">
              <div className="w-full max-w-xl border bg-background/95 p-6 shadow-2xl backdrop-blur-md">
                <div className="mb-4 flex items-center gap-3">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center bg-muted text-muted-foreground">
                    <FileText className="h-5 w-5" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{currentFile.file_name}</p>
                    <p className="text-xs text-muted-foreground">{formatFileSize(currentFile.size_bytes)}</p>
                  </div>
                </div>
                <audio
                  key={currentFile.id}
                  src={previewUrl}
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

          {isWord && !wordLoadFailed && (
            <div className="h-full w-full overflow-hidden bg-sidebar">
              {wordHtml ? (
                <iframe
                  key={currentFile.id}
                  srcDoc={wordHtml}
                  sandbox=""
                  referrerPolicy="no-referrer"
                  className="h-full w-full border-0 bg-muted"
                  onLoad={() => setIsLoading(false)}
                  title={currentFile.file_name}
                />
              ) : (
                <div className="flex h-full w-full items-start justify-center p-6">
                  <Skeleton className="h-full w-full max-w-[820px]" />
                </div>
              )}
            </div>
          )}

          {showUnavailable && (
            <div className="mx-4 flex max-w-sm flex-col items-center justify-center gap-4 border bg-background/95 px-8 py-10 text-center shadow-xl backdrop-blur-md">
              <span className="flex h-16 w-16 items-center justify-center bg-muted text-muted-foreground">
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
                    : !previewUrl && (isPdf || isImage || isVideo || isAudio)
                    ? "This file has no preview link. Open it from Documents, or download the original."
                    : "Preview not available for this file type"}
                </p>
                {onDownload && (
                  <Button
                    className="mt-4"
                    onClick={handleDownloadCurrent}
                  >
                    <Download className="mr-2 h-4 w-4" />
                    Download to view
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* BOTTOM STRIP — sibling files. A multi-page PDF renders its own page
            rail inside the viewer, where it can share the one pdf.js document. */}
        {showFileStrip && (
          <div className="absolute inset-x-0 bottom-[max(env(safe-area-inset-bottom),0.75rem)] z-20 flex justify-center px-3">
            <div className="max-w-full overflow-hidden border bg-background/95 p-1.5 shadow-lg backdrop-blur-md">
              <div className="flex items-center gap-1.5 overflow-x-auto p-1">
                {files.map((f, index) => {
                  const active = index === clampedIndex
                  return (
                    <button
                      key={f.id}
                      onClick={() => handleSelectFile(index)}
                      className={cn(
                        "relative h-14 w-14 shrink-0 overflow-hidden transition-all",
                        active
                          ? "ring-2 ring-primary shadow-md"
                          : "opacity-70 hover:opacity-100 ring-1 ring-border"
                      )}
                      aria-label={f.file_name}
                      aria-current={active ? "true" : undefined}
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
