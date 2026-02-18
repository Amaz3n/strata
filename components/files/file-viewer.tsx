"use client"

import { useState, useCallback, useEffect, useRef } from "react"
import Image from "next/image"
import { Document as PdfDocument, Page as PdfPage, pdfjs } from "react-pdf"
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
} from "@/components/icons"
import { Button } from "@/components/ui/button"
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
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null)
  const [pdfPageCount, setPdfPageCount] = useState(0)
  const [activePdfPage, setActivePdfPage] = useState(1)
  const [pdfLoadFailed, setPdfLoadFailed] = useState(false)
  const [pdfViewportWidth, setPdfViewportWidth] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const pdfViewportRef = useRef<HTMLDivElement>(null)

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
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url
    ).toString()
  }, [open, currentFileIsPdf])

  // Reset state when file changes
  useEffect(() => {
    setZoom(1)
    setRotation(0)
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
          break
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [open, handlePrev, handleNext, onOpenChange])

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
  const showPdfThumbnails = isPdf && !pdfLoadFailed && Boolean(currentPdfUrl) && pdfPageCount > 1

  // Calculate optimal dialog size based on image aspect ratio
  const getDialogStyle = () => {
    if (!isImage || !imageDimensions) {
      // Default size for PDFs and non-images
      return { width: "90vw", height: "90vh" }
    }

    const { width: imgW, height: imgH } = imageDimensions
    const aspectRatio = imgW / imgH
    const viewportW = window.innerWidth * 0.92
    const viewportH = window.innerHeight * 0.92

    let dialogW: number
    let dialogH: number

    if (aspectRatio > 1) {
      // Landscape - prioritize width
      dialogW = Math.min(imgW, viewportW)
      dialogH = dialogW / aspectRatio
      if (dialogH > viewportH) {
        dialogH = viewportH
        dialogW = dialogH * aspectRatio
      }
    } else {
      // Portrait - prioritize height
      dialogH = Math.min(imgH, viewportH)
      dialogW = dialogH * aspectRatio
      if (dialogW > viewportW) {
        dialogW = viewportW
        dialogH = dialogW / aspectRatio
      }
    }

    // Add some padding for UI elements
    const uiPadding = 120 // For header and thumbnail strip
    dialogH = Math.min(dialogH + uiPadding, viewportH)

    return {
      width: `${Math.max(dialogW, 400)}px`,
      height: `${Math.max(dialogH, 300)}px`,
      maxWidth: "95vw",
      maxHeight: "95vh",
    }
  }

  const dialogStyle = getDialogStyle()

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      <div
        ref={containerRef}
        className="relative flex flex-col bg-black/95 rounded-lg overflow-hidden shadow-2xl"
        style={dialogStyle}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 bg-black/80 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-3 text-white min-w-0">
            <FileText className="h-5 w-5 shrink-0 opacity-70" />
            <div className="min-w-0">
              <p className="font-medium truncate">{currentFile.file_name}</p>
              <p className="text-xs opacity-60">
                {formatFileSize(currentFile.size_bytes)}
                {imageDimensions && (
                  <span className="ml-2">
                    {imageDimensions.width} × {imageDimensions.height}
                  </span>
                )}
                {hasMultiple && (
                  <span className="ml-2">
                    • {clampedIndex + 1} of {files.length}
                  </span>
                )}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1">
            {isImage && (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-white/80 hover:text-white hover:bg-white/10"
                  onClick={() => setZoom((z) => Math.max(z - 0.25, 0.25))}
                >
                  <ZoomOut className="h-4 w-4" />
                </Button>
                <span className="text-sm text-white/60 w-12 text-center">
                  {Math.round(zoom * 100)}%
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-white/80 hover:text-white hover:bg-white/10"
                  onClick={() => setZoom((z) => Math.min(z + 0.25, 5))}
                >
                  <ZoomIn className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-white/80 hover:text-white hover:bg-white/10"
                  onClick={() => setRotation((r) => (r + 90) % 360)}
                >
                  <RotateCw className="h-4 w-4" />
                </Button>
              </>
            )}

            {onDownload && (
              <Button
                variant="ghost"
                size="icon"
                className="text-white/80 hover:text-white hover:bg-white/10"
                onClick={() => onDownload(currentFile)}
              >
                <Download className="h-4 w-4" />
              </Button>
            )}

            {hasVersionsPanel && (
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  "text-white/80 hover:text-white hover:bg-white/10",
                  showVersions && "bg-white/10 text-white"
                )}
                onClick={() => setShowVersions((prev) => !prev)}
              >
                <History className="h-4 w-4" />
              </Button>
            )}

            <Button
              variant="ghost"
              size="icon"
              className="text-white/80 hover:text-white hover:bg-white/10"
              onClick={toggleFullscreen}
            >
              {isFullscreen ? (
                <Minimize2 className="h-4 w-4" />
              ) : (
                <Maximize2 className="h-4 w-4" />
              )}
            </Button>

            <Button
              variant="ghost"
              size="icon"
              className="text-white/80 hover:text-white hover:bg-white/10"
              onClick={() => onOpenChange(false)}
            >
              <X className="h-5 w-5" />
            </Button>
          </div>
        </div>

        {/* Navigation Arrows */}
        {hasMultiple && (
          <>
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "absolute left-4 top-1/2 -translate-y-1/2 z-50 h-12 w-12 rounded-full bg-black/50 text-white/80 hover:text-white hover:bg-black/70",
                !canPrev && "opacity-30 cursor-not-allowed"
              )}
              onClick={handlePrev}
              disabled={!canPrev}
            >
              <ChevronLeft className="h-6 w-6" />
            </Button>

            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "absolute right-4 top-1/2 -translate-y-1/2 z-50 h-12 w-12 rounded-full bg-black/50 text-white/80 hover:text-white hover:bg-black/70",
                !canNext && "opacity-30 cursor-not-allowed"
              )}
              onClick={handleNext}
              disabled={!canNext}
            >
              <ChevronRight className="h-6 w-6" />
            </Button>
          </>
        )}

        {/* Content */}
        <div className="flex-1 flex overflow-hidden relative">
          <div className="flex-1 flex items-center justify-center overflow-hidden relative">
            {isLoading && (
              <div className="absolute inset-0 flex items-center justify-center z-10">
                <Loader2 className="h-8 w-8 animate-spin text-white/60" />
              </div>
            )}

            {isImage && currentFile.download_url && (
              <div
                className="relative transition-transform duration-200 ease-out flex items-center justify-center"
                style={{
                  transform: `scale(${zoom}) rotate(${rotation}deg)`,
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={currentFile.download_url}
                  alt={currentFile.file_name}
                  className={cn(
                    "max-w-full max-h-full w-auto h-auto object-contain",
                    isLoading && "opacity-0"
                  )}
                  onLoad={handleImageLoad}
                  style={{
                    maxHeight: hasMultiple ? "calc(100% - 80px)" : "100%",
                  }}
                />
              </div>
            )}

            {isPdf && currentFile.download_url && (
              <div ref={pdfViewportRef} className="h-full w-full overflow-auto bg-zinc-950/40">
                {!pdfLoadFailed && currentPdfUrl ? (
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
                ) : (
                  <iframe
                    src={`${currentFile.download_url}#toolbar=0&navpanes=0`}
                    className={cn(
                      "w-full h-full bg-white",
                      isLoading && "opacity-0"
                    )}
                    onLoad={() => setIsLoading(false)}
                    title={currentFile.file_name}
                  />
                )}
              </div>
            )}

            {!isImage && !isPdf && (
              <div className="flex flex-col items-center justify-center gap-4 text-white/80">
                <FileText className="h-16 w-16" />
                <div className="text-center">
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

          {hasVersionsPanel && showVersions && (
            <div className="w-[360px] bg-background text-foreground border-l border-border overflow-y-auto">
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
            </div>
          )}
        </div>

        {(showPdfThumbnails || hasMultiple) && (
          <div className="bg-black/80 border-t border-white/10 p-3 shrink-0 space-y-3">
            {showPdfThumbnails && (
              <div className="space-y-1.5">
                <p className="text-[11px] uppercase tracking-wide text-white/50">Pages</p>
                {currentPdfUrl ? (
                  <PdfDocument
                    key={`${currentFile.id}-thumbs`}
                    file={currentPdfUrl}
                    loading={null}
                    noData={null}
                    error={null}
                  >
                    <div className="flex items-start gap-2 overflow-x-auto pb-1">
                      {Array.from({ length: pdfPageCount }).map((_, pageIndex) => {
                        const pageNumber = pageIndex + 1
                        return (
                          <button
                            key={`pdf-page-${pageNumber}`}
                            onClick={() => setActivePdfPage(pageNumber)}
                            className={cn(
                              "group shrink-0 rounded-md border border-white/15 bg-black/40 p-1 transition-all",
                              pageNumber === activePdfPageClamped
                                ? "border-primary ring-2 ring-primary/50"
                                : "hover:border-white/30"
                            )}
                          >
                            <div className="overflow-hidden rounded bg-white shadow-sm">
                              <PdfPage
                                pageNumber={pageNumber}
                                width={68}
                                renderTextLayer={false}
                                renderAnnotationLayer={false}
                              />
                            </div>
                            <p
                              className={cn(
                                "mt-1 text-center text-[10px] font-medium",
                                pageNumber === activePdfPageClamped ? "text-white" : "text-white/60 group-hover:text-white/90"
                              )}
                            >
                              {pageNumber}
                            </p>
                          </button>
                        )
                      })}
                    </div>
                  </PdfDocument>
                ) : null}
              </div>
            )}

            {hasMultiple && (
              <div className="space-y-1.5">
                <p className="text-[11px] uppercase tracking-wide text-white/50">Files</p>
                <div className="flex items-center justify-center gap-2 overflow-x-auto">
                  {files.map((f, index) => (
                    <button
                      key={f.id}
                      onClick={() => handleSelectFile(index)}
                      className={cn(
                        "relative h-12 w-12 shrink-0 rounded overflow-hidden border-2 transition-all",
                        index === clampedIndex
                          ? "border-primary ring-2 ring-primary/50"
                          : "border-transparent opacity-60 hover:opacity-100"
                      )}
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
                        <div className="flex items-center justify-center h-full bg-muted text-lg">
                          <FileText className="h-5 w-5 text-muted-foreground" />
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
