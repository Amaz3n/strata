"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Eye,
  FileText,
  Loader2,
  MoreHorizontal,
  RotateCw,
  Trash2,
  Upload,
  ZoomIn,
  ZoomOut,
} from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { AttachedFile } from "@/components/files"
import { isImageFile, isPdfFile, formatFileSize } from "@/components/files/types"

interface PayableDocumentPaneProps {
  attachments: AttachedFile[]
  loading?: boolean
  onAttach?: (files: File[], linkRole?: string) => Promise<void>
  onDetach?: (linkId: string) => Promise<void>
  projectId?: string
  className?: string
}

/**
 * Embeddable (non-modal) document viewer for the payables workspace right pane.
 * Renders PDFs via react-pdf and images inline, with a tab strip when a bill has
 * more than one attachment. Mirrors the loader pattern in components/files/file-viewer.tsx.
 */
export function PayableDocumentPane({
  attachments,
  loading = false,
  onAttach,
  onDetach,
  projectId,
  className,
}: PayableDocumentPaneProps) {
  const [activeTab, setActiveTab] = useState<"receipt" | "docs">("receipt")
  const [activeId, setActiveId] = useState<string | null>(attachments[0]?.id ?? null)
  const [zoom, setZoom] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [pageCount, setPageCount] = useState(0)
  const [activePage, setActivePage] = useState(1)
  const [isRendering, setIsRendering] = useState(true)
  const [pdfLoadFailed, setPdfLoadFailed] = useState(false)
  const [viewportWidth, setViewportWidth] = useState(0)
  const [pdfComponents, setPdfComponents] = useState<{ Document: any; Page: any } | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [isReplacing, setIsReplacing] = useState(false)

  const viewportRef = useRef<HTMLDivElement>(null)
  const replaceInputRef = useRef<HTMLInputElement>(null)
  const docsInputRef = useRef<HTMLInputElement>(null)

  const active = useMemo(
    () => attachments.find((file) => file.id === activeId) ?? attachments[0] ?? null,
    [attachments, activeId],
  )

  const otherAttachments = useMemo(() => {
    if (!active) return attachments
    return attachments.filter((file) => file.id !== active.id)
  }, [attachments, active])

  // Keep a valid selection as the attachment list changes (bill switches).
  useEffect(() => {
    if (attachments.length === 0) {
      setActiveId(null)
    } else if (!attachments.some((file) => file.id === activeId)) {
      setActiveId(attachments[0].id)
    }
  }, [attachments, activeId])

  const isPdf = active ? isPdfFile(active.mime_type) : false
  const isImage = active ? isImageFile(active.mime_type) : false
  const pdfUrl = active ? (active.download_url ?? `/api/files/${active.id}/raw`) : null

  // Reset view state when the active document changes.
  useEffect(() => {
    setZoom(1)
    setRotation(0)
    setPageCount(0)
    setActivePage(1)
    setPdfLoadFailed(false)
    setIsRendering(true)
  }, [active?.id])

  // Lazy-load react-pdf only when a PDF is shown.
  useEffect(() => {
    if (!isPdf) return
    let cancelled = false
    void (async () => {
      try {
        const { Document, Page, pdfjs } = await import("react-pdf")
        if (cancelled) return
        pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`
        setPdfComponents({ Document, Page })
      } catch (error) {
        console.error("Failed to load PDF components", error)
        if (!cancelled) {
          setPdfLoadFailed(true)
          setIsRendering(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isPdf])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const update = () => setViewportWidth(viewport.clientWidth)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [active?.id])

  const PdfDocument = pdfComponents?.Document
  const PdfPage = pdfComponents?.Page
  const activePageClamped = Math.min(Math.max(activePage, 1), Math.max(pageCount, 1))
  const basePageWidth = viewportWidth > 0 ? Math.max(280, Math.min(1100, viewportWidth - 48)) : 760
  const pageWidth = basePageWidth * zoom

  // Replace invoice handler
  const handleReplaceClick = () => {
    replaceInputRef.current?.click()
  }

  const handleReplaceFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    if (files.length > 0 && active && onAttach && onDetach) {
      setIsReplacing(true)
      try {
        await onAttach(files)
        await onDetach(active.linkId)
        toast.success("Invoice replaced successfully")
      } catch (err) {
        console.error("Replace failed:", err)
        toast.error("Failed to replace invoice")
      } finally {
        setIsReplacing(false)
        if (replaceInputRef.current) replaceInputRef.current.value = ""
      }
    }
  }

  // Upload handlers for Docs tab
  const handleDocsUploadZoneClick = () => {
    docsInputRef.current?.click()
  }

  const handleDocsFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    if (files.length > 0 && onAttach) {
      await onAttach(files)
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0 && onAttach) {
      await onAttach(files)
    }
  }

  return (
    <div className={cn("flex h-full flex-col bg-muted/20 relative", className)}>
      {/* Header with two tabs */}
      <div className="flex h-16 shrink-0 items-center justify-between border-b bg-background px-4">
        <div className="flex gap-6 h-full items-center">
          <button
            type="button"
            onClick={() => setActiveTab("receipt")}
            className={cn(
              "relative flex h-full items-center text-sm font-semibold transition-colors focus:outline-none",
              activeTab === "receipt" ? "text-primary" : "text-muted-foreground hover:text-foreground"
            )}
          >
            Receipt
            {activeTab === "receipt" && (
              <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-primary" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("docs")}
            className={cn(
              "relative flex h-full items-center text-sm font-semibold transition-colors focus:outline-none",
              activeTab === "docs" ? "text-primary" : "text-muted-foreground hover:text-foreground"
            )}
          >
            Documents
            {otherAttachments.length > 0 && (
              <span className="ml-1.5 rounded-full bg-muted/80 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                {otherAttachments.length}
              </span>
            )}
            {activeTab === "docs" && (
              <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-primary" />
            )}
          </button>
        </div>
        {loading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
      </div>

      <input
        ref={replaceInputRef}
        type="file"
        accept=".pdf,.png,.jpg,.jpeg,.gif,.webp"
        onChange={handleReplaceFile}
        className="hidden"
      />

      {isReplacing && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="flex flex-col items-center gap-2">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
            <p className="text-xs font-semibold text-muted-foreground">Replacing invoice...</p>
          </div>
        </div>
      )}

      {/* Main Body */}
      <div className="flex-1 min-h-0 flex flex-col relative bg-muted/5">
        {loading ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : activeTab === "receipt" ? (
          // Receipt View
          !active ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center p-6 bg-background/30">
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                <FileText className="h-7 w-7" />
              </span>
              <div>
                <p className="text-sm font-semibold">No receipt attached</p>
                <p className="text-xs text-muted-foreground mt-1 max-w-[280px]">
                  Go to the Documents tab or click below to upload a receipt/invoice.
                </p>
                <Button onClick={handleReplaceClick} className="mt-4" size="sm">
                  <Upload className="mr-2 h-4 w-4" />
                  Upload receipt
                </Button>
              </div>
            </div>
          ) : (
            <>
              {/* Viewer body */}
              <div ref={viewportRef} className="relative min-h-0 flex-1 overflow-auto">
                {isRendering && (isPdf || isImage) ? (
                  <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-background/10">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                ) : null}

                {isPdf && pdfUrl && !pdfLoadFailed && PdfDocument && PdfPage ? (
                  <div className="flex min-h-full items-start justify-center p-4">
                    <PdfDocument
                      key={active.id}
                      file={pdfUrl}
                      loading={null}
                      onLoadSuccess={(info: { numPages: number }) => {
                        setPageCount(info.numPages)
                        setActivePage((prev) => Math.min(Math.max(prev, 1), Math.max(info.numPages, 1)))
                        setPdfLoadFailed(false)
                      }}
                      onLoadError={(error: unknown) => {
                        console.error("Failed to load PDF", error)
                        setPdfLoadFailed(true)
                        setIsRendering(false)
                      }}
                    >
                      <PdfPage
                        pageNumber={activePageClamped}
                        width={pageWidth}
                        rotate={rotation}
                        renderTextLayer={false}
                        renderAnnotationLayer={false}
                        onRenderSuccess={() => setIsRendering(false)}
                        className={cn("rounded-md shadow-lg", isRendering && "opacity-0")}
                      />
                    </PdfDocument>
                  </div>
                ) : isPdf && pdfUrl && pdfLoadFailed ? (
                  <iframe src={`${pdfUrl}#toolbar=0&navpanes=0`} className="h-full w-full bg-white" title={active.file_name} onLoad={() => setIsRendering(false)} />
                ) : isImage && active.download_url ? (
                  <div className="flex min-h-full items-center justify-center p-4">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={active.download_url}
                      alt={active.file_name}
                      className={cn("max-w-full object-contain transition-transform", isRendering && "opacity-0")}
                      style={{ transform: `scale(${zoom}) rotate(${rotation}deg)` }}
                      onLoad={() => setIsRendering(false)}
                      onError={() => setIsRendering(false)}
                    />
                  </div>
                ) : !isPdf && !isImage ? (
                  <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
                    <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                      <FileText className="h-7 w-7" />
                    </span>
                    <div>
                      <p className="text-sm font-semibold">{active.file_name}</p>
                      <p className="mt-1 text-xs text-muted-foreground">Preview not available for this file type.</p>
                      {active.download_url ? (
                        <Button asChild className="mt-4" size="sm">
                          <a href={active.download_url} download>
                            <Download className="mr-2 h-4 w-4" />
                            Download
                          </a>
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>

              {/* Floating Controls */}
              <div className="absolute bottom-6 left-6 right-6 z-20 flex justify-between items-center pointer-events-none">
                {/* Bottom Left controls: Zoom & Rotate */}
                {(isPdf || isImage) && (
                  <div className="flex items-center gap-1 pointer-events-auto bg-background/85 backdrop-blur-sm border shadow-lg rounded-full p-1.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 rounded-full hover:bg-muted"
                      onClick={() => setZoom((z) => Math.max(z - 0.2, 0.5))}
                      title="Zoom out"
                    >
                      <ZoomOut className="h-4 w-4 text-foreground" />
                    </Button>
                    <button
                      onClick={() => setZoom(1)}
                      className="px-1 text-center font-mono text-[11px] tabular-nums text-muted-foreground hover:text-foreground hover:font-semibold text-xs"
                      title="Reset zoom"
                    >
                      {Math.round(zoom * 100)}%
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 rounded-full hover:bg-muted"
                      onClick={() => setZoom((z) => Math.min(z + 0.2, 4))}
                      title="Zoom in"
                    >
                      <ZoomIn className="h-4 w-4 text-foreground" />
                    </Button>
                    <div className="h-4 w-px bg-border my-auto mx-1" />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 rounded-full hover:bg-muted"
                      onClick={() => setRotation((r) => (r + 90) % 360)}
                      title="Rotate"
                    >
                      <RotateCw className="h-4 w-4 text-foreground" />
                    </Button>
                  </div>
                )}

                {/* Bottom Center paging */}
                {isPdf && pageCount > 1 && (
                  <div className="flex items-center gap-1 pointer-events-auto bg-background/85 backdrop-blur-sm border shadow-lg rounded-full p-1.5 mx-auto">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 rounded-full hover:bg-muted"
                      disabled={activePageClamped <= 1}
                      onClick={() => setActivePage((p) => Math.max(p - 1, 1))}
                      title="Previous page"
                    >
                      <ChevronLeft className="h-4 w-4 text-foreground" />
                    </Button>
                    <span className="px-2 font-mono text-[11px] tabular-nums text-muted-foreground text-xs">
                      {activePageClamped}/{pageCount}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 rounded-full hover:bg-muted"
                      disabled={activePageClamped >= pageCount}
                      onClick={() => setActivePage((p) => Math.min(p + 1, pageCount))}
                      title="Next page"
                    >
                      <ChevronRight className="h-4 w-4 text-foreground" />
                    </Button>
                  </div>
                )}

                {/* Bottom Right controls: Hamburger Menu */}
                <div className="pointer-events-auto ml-auto">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-11 w-11 rounded-full bg-background/85 backdrop-blur-sm border shadow-lg hover:bg-background/95 hover:scale-[1.02] transition-transform flex items-center justify-center"
                        title="Document actions"
                      >
                        <MoreHorizontal className="h-5 w-5 text-foreground" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      <DropdownMenuItem onClick={handleReplaceClick}>
                        <Upload className="mr-2 h-4 w-4" />
                        Replace invoice
                      </DropdownMenuItem>
                      {active.download_url && (
                        <DropdownMenuItem asChild>
                          <a href={active.download_url} download>
                            <Download className="mr-2 h-4 w-4" />
                            Download
                          </a>
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => onDetach && onDetach(active.linkId)}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete invoice
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </>
          )
        ) : (
          // Docs Tab
          <div className="flex-1 overflow-y-auto p-6 bg-background/30">
            {otherAttachments.length === 0 ? (
              <div
                onDragOver={handleDragOver}
                onDragEnter={handleDragEnter}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={handleDocsUploadZoneClick}
                className={cn(
                  "flex flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed p-12 transition-all cursor-pointer h-[320px] bg-background",
                  isDragging
                    ? "border-primary bg-primary/5 scale-[1.01]"
                    : "border-muted-foreground/20 hover:border-primary/40 hover:bg-muted/30"
                )}
              >
                <input
                  ref={docsInputRef}
                  type="file"
                  multiple
                  onChange={handleDocsFileSelect}
                  className="hidden"
                />
                <div className={cn(
                  "flex h-12 w-12 items-center justify-center rounded-full transition-colors bg-muted text-muted-foreground",
                  isDragging && "bg-primary/10 text-primary"
                )}>
                  <Upload className="h-6 w-6" />
                </div>
                <div className="text-center">
                  <p className="font-semibold text-sm">Drag & drop files here</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    or click to browse from your device
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Attached files ({otherAttachments.length})
                  </span>
                  <Button variant="outline" size="sm" onClick={handleDocsUploadZoneClick} className="h-8 text-xs">
                    <Upload className="mr-1.5 h-3.5 w-3.5" />
                    Upload
                  </Button>
                  <input
                    ref={docsInputRef}
                    type="file"
                    multiple
                    onChange={handleDocsFileSelect}
                    className="hidden"
                  />
                </div>

                <div className="divide-y rounded-xl border bg-background overflow-hidden">
                  {otherAttachments.map((file) => (
                    <div key={file.id} className="flex items-center justify-between p-3.5 hover:bg-muted/30 transition-colors">
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                          <FileText className="h-5 w-5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold truncate" title={file.file_name}>
                            {file.file_name}
                          </p>
                          <p className="text-[11px] text-muted-foreground mt-0.5">
                            {file.size_bytes ? formatFileSize(file.size_bytes) : "Unknown size"}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 ml-4">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 hover:bg-muted"
                          onClick={() => {
                            setActiveId(file.id)
                            setActiveTab("receipt")
                          }}
                          title="View file"
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        {file.download_url && (
                          <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-muted" asChild title="Download">
                            <a href={file.download_url} download>
                              <Download className="h-4 w-4" />
                            </a>
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-muted"
                          onClick={() => {
                            if (onDetach) onDetach(file.linkId)
                          }}
                          title="Delete attachment"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
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
