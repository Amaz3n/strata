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
  const containerRef = useRef<HTMLDivElement>(null)

  // Find current index when file changes
  useEffect(() => {
    if (file && files.length > 0) {
      const index = files.findIndex((f) => f.id === file.id)
      if (index >= 0) {
        setCurrentIndex(index)
      }
    }
  }, [file, files])

  const currentFile = files.length > 0 ? files[currentIndex] : file

  // Reset state when file changes
  useEffect(() => {
    setZoom(1)
    setRotation(0)
    setIsLoading(true)
    setImageDimensions(null)
  }, [file?.id])

  useEffect(() => {
    if (currentFile) {
      onFileChange?.(currentFile)
    }
  }, [currentFile?.id, onFileChange])
  const hasMultiple = files.length > 1
  const canPrev = hasMultiple && currentIndex > 0
  const canNext = hasMultiple && currentIndex < files.length - 1
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
      setCurrentIndex((i) => i - 1)
      setIsLoading(true)
      setZoom(1)
      setRotation(0)
      setImageDimensions(null)
    }
  }, [canPrev])

  const handleNext = useCallback(() => {
    if (canNext) {
      setCurrentIndex((i) => i + 1)
      setIsLoading(true)
      setZoom(1)
      setRotation(0)
      setImageDimensions(null)
    }
  }, [canNext])

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
                    • {currentIndex + 1} of {files.length}
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

        {/* Thumbnail strip for multiple files */}
        {hasMultiple && (
          <div className="bg-black/80 border-t border-white/10 p-3 shrink-0">
            <div className="flex items-center justify-center gap-2 overflow-x-auto">
              {files.map((f, index) => (
                <button
                  key={f.id}
                  onClick={() => {
                    setCurrentIndex(index)
                    setIsLoading(true)
                    setZoom(1)
                    setRotation(0)
                    setImageDimensions(null)
                  }}
                  className={cn(
                    "relative h-12 w-12 shrink-0 rounded overflow-hidden border-2 transition-all",
                    index === currentIndex
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
    </div>
  )
}
