"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import {
  Upload,
  FileText,
  X,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Plus,
  Image as ImageIcon,
  FileArchive,
  FileSpreadsheet,
  HardDriveUpload,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { uploadDocumentFileDirect } from "@/lib/services/files-client"
import type { FileCategory } from "@/components/files/types"

interface UploadQueueItem {
  id: string
  file: File
  status: "queued" | "uploading" | "success" | "error"
  progress: number
  loaded: number
  startedAt?: number
  stage?: "preparing" | "uploading" | "finalizing"
  error?: string
}

interface UploadDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialFiles?: File[]
  projectId: string
  folderPath?: string
  onUploadComplete?: () => void
}

const CATEGORY_OPTIONS: { value: FileCategory | "auto"; label: string }[] = [
  { value: "auto", label: "Auto-detect" },
  { value: "plans", label: "Plans" },
  { value: "photos", label: "Photos" },
  { value: "contracts", label: "Contracts" },
  { value: "permits", label: "Permits" },
  { value: "submittals", label: "Submittals" },
  { value: "rfis", label: "RFIs" },
  { value: "safety", label: "Safety" },
  { value: "financials", label: "Financials" },
  { value: "other", label: "Other" },
]

const UPLOAD_CONCURRENCY = 3

function normalizeFolderPath(value?: string | null): string {
  if (!value) return ""
  const trimmed = value.trim()
  if (!trimmed) return ""
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`
  const normalized = withLeadingSlash.replace(/\/+/g, "/").replace(/\/$/, "")
  return normalized === "/" ? "" : normalized
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function FileTypeIcon({ file }: { file: File }) {
  const extension = file.name.toLowerCase().split(".").pop()
  const className = "h-4 w-4"

  if (file.type.startsWith("image/")) return <ImageIcon className={className} />
  if (extension === "zip") return <FileArchive className={className} />
  if (["csv", "xls", "xlsx"].includes(extension ?? "")) return <FileSpreadsheet className={className} />
  return <FileText className={className} />
}

export function UploadDialog({
  open,
  onOpenChange,
  initialFiles = [],
  projectId,
  folderPath,
  onUploadComplete,
}: UploadDialogProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const seededInitialFilesRef = useRef("")
  const [queue, setQueue] = useState<UploadQueueItem[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const [category, setCategory] = useState<FileCategory | "auto">("auto")
  const [visibility, setVisibility] = useState<"public" | "private">("public")
  const [isDraggingOver, setIsDraggingOver] = useState(false)

  const currentFolder = useMemo(() => normalizeFolderPath(folderPath), [folderPath])
  const destinationLabel = currentFolder || "Project root"

  // Populate queue with initial files
  const addFiles = useCallback((files: File[]) => {
    const newItems: UploadQueueItem[] = files.map((file) => ({
      id: `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      status: "queued",
      progress: 0,
      loaded: 0,
    }))
    setQueue((prev) => [...prev, ...newItems])
  }, [])

  useEffect(() => {
    if (!open || initialFiles.length === 0) return
    const signature = initialFiles
      .map((file) => `${file.name}:${file.size}:${file.lastModified}`)
      .join("|")
    if (!signature || seededInitialFilesRef.current === signature) return
    seededInitialFilesRef.current = signature
    setQueue([])
    addFiles(initialFiles)
  }, [open, initialFiles, addFiles])

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        setQueue([])
        setCategory("auto")
        setVisibility("public")
        setIsDraggingOver(false)
        seededInitialFilesRef.current = ""
      }
      onOpenChange(nextOpen)
    },
    [onOpenChange]
  )

  // Handle file input change
  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? [])
      if (files.length > 0) {
        addFiles(files)
      }
      if (fileInputRef.current) {
        fileInputRef.current.value = ""
      }
    },
    [addFiles]
  )

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLButtonElement>) => {
      event.preventDefault()
      setIsDraggingOver(false)
      const files = Array.from(event.dataTransfer.files ?? [])
      if (files.length > 0) addFiles(files)
    },
    [addFiles]
  )

  // Remove file from queue
  const removeFile = useCallback((id: string) => {
    setQueue((prev) => prev.filter((item) => item.id !== id))
  }, [])

  // Upload all files
  const handleUpload = useCallback(async () => {
    const pendingItems = queue.filter((item) => item.status === "queued")
    if (pendingItems.length === 0) return

    setIsUploading(true)
    let successCount = 0
    let failCount = 0

    const uploadOne = async (item: UploadQueueItem) => {
      setQueue((prev) =>
        prev.map((q) =>
          q.id === item.id ? { ...q, status: "uploading" } : q
        )
      )

      try {
        await uploadDocumentFileDirect(item.file, {
          projectId,
          category: category === "auto" ? undefined : category,
          visibility,
          folderPath: currentFolder,
          onStage: (stage) => {
            setQueue((prev) =>
              prev.map((q) =>
                q.id === item.id ? { ...q, stage, startedAt: q.startedAt ?? performance.now() } : q
              )
            )
          },
          onProgress: ({ percent, loaded }) => {
            setQueue((prev) =>
              prev.map((q) =>
                q.id === item.id ? { ...q, progress: percent, loaded } : q
              )
            )
          },
        })

        setQueue((prev) =>
          prev.map((q) =>
            q.id === item.id ? { ...q, status: "success", progress: 100, loaded: item.file.size } : q
          )
        )
        successCount++
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Upload failed"
        setQueue((prev) =>
          prev.map((q) =>
            q.id === item.id ? { ...q, status: "error", error: message } : q
          )
        )
        failCount++
      }
    }

    const workers = Array.from(
      { length: Math.min(UPLOAD_CONCURRENCY, pendingItems.length) },
      async (_, workerIndex) => {
        for (let index = workerIndex; index < pendingItems.length; index += UPLOAD_CONCURRENCY) {
          await uploadOne(pendingItems[index])
        }
      }
    )
    await Promise.all(workers)

    setIsUploading(false)

    if (successCount > 0) {
      toast.success(
        `${successCount} file${successCount > 1 ? "s" : ""} uploaded`
      )
      onUploadComplete?.()
    }
    if (failCount > 0) {
      toast.error(
        `${failCount} file${failCount > 1 ? "s" : ""} failed to upload`
      )
    }

    // Close dialog if all succeeded
    if (failCount === 0) {
      handleOpenChange(false)
    }
  }, [
    queue,
    projectId,
    category,
    visibility,
    currentFolder,
    onUploadComplete,
    handleOpenChange,
  ])

  const hasQueuedFiles = queue.some((item) => item.status === "queued")
  const allComplete = queue.length > 0 && queue.every((item) => item.status !== "queued" && item.status !== "uploading")
  const queuedCount = queue.filter((item) => item.status === "queued").length
  const successCount = queue.filter((item) => item.status === "success").length
  const errorCount = queue.filter((item) => item.status === "error").length
  const totalSize = queue.reduce((sum, item) => sum + item.file.size, 0)
  const overallProgress = queue.length > 0
    ? Math.round(queue.reduce((sum, item) => sum + (item.status === "success" ? 100 : item.progress), 0) / queue.length)
    : 0

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent className="w-full gap-0 overflow-hidden p-0 sm:max-w-2xl" mobileFullscreen>
        <SheetHeader className="border-b px-6 py-5">
          <div className="flex items-start gap-3 pr-8">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <HardDriveUpload className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <SheetTitle className="text-lg">Upload files</SheetTitle>
              <SheetDescription>
                Add files to {destinationLabel}.
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileInputChange}
            accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.gif,.webp,.dwg,.dxf,.txt,.csv,.zip"
          />

          <div className="grid gap-5">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              onDragEnter={(event) => {
                event.preventDefault()
                setIsDraggingOver(true)
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setIsDraggingOver(false)}
              onDrop={handleDrop}
              disabled={isUploading}
              className={cn(
                "group flex min-h-48 w-full flex-col items-center justify-center rounded-lg border border-dashed bg-muted/20 px-6 py-8 text-center transition",
                "hover:border-primary/60 hover:bg-primary/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isDraggingOver && "border-primary bg-primary/[0.06]",
                isUploading && "cursor-not-allowed opacity-70"
              )}
            >
              <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-lg border bg-background shadow-sm transition group-hover:scale-105">
                <Upload className="h-6 w-6 text-primary" />
              </div>
              <div className="text-sm font-semibold">
                Drop files here or browse from your computer
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{destinationLabel}</div>
            </button>

            {queue.length > 0 && (
              <div className="rounded-lg border bg-background">
                <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
                  <div>
                    <div className="text-sm font-semibold">
                      {queue.length} file{queue.length === 1 ? "" : "s"} selected
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {formatFileSize(totalSize)}
                      {successCount > 0 ? ` · ${successCount} uploaded` : ""}
                      {errorCount > 0 ? ` · ${errorCount} failed` : ""}
                    </div>
                  </div>
                  {!isUploading && !allComplete && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Add files
                    </Button>
                  )}
                </div>

                {isUploading && (
                  <div className="border-b px-4 py-3">
                    <div className="mb-2 flex items-center justify-between text-xs">
                      <span className="font-medium">Uploading</span>
                      <span className="text-muted-foreground">{overallProgress}%</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary transition-[width]"
                        style={{ width: `${Math.max(3, overallProgress)}%` }}
                      />
                    </div>
                  </div>
                )}

                <div className="max-h-72 overflow-y-auto p-2">
                  {queue.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center gap-3 rounded-md px-2 py-2.5 transition hover:bg-muted/50"
                    >
                      <div
                        className={cn(
                          "flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground",
                          item.status === "success" && "border-emerald-200 bg-emerald-50 text-emerald-600",
                          item.status === "error" && "border-destructive/20 bg-destructive/10 text-destructive",
                          item.status === "uploading" && "border-primary/30 bg-primary/10 text-primary"
                        )}
                      >
                        {item.status === "uploading" ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : item.status === "success" ? (
                          <CheckCircle2 className="h-4 w-4" />
                        ) : item.status === "error" ? (
                          <AlertTriangle className="h-4 w-4" />
                        ) : (
                          <FileTypeIcon file={item.file} />
                        )}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{item.file.name}</div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                          <span>{formatFileSize(item.file.size)}</span>
                          {item.status === "uploading" && (
                            <span className="capitalize">
                              {item.stage ?? "uploading"} {item.progress}%
                              {item.loaded > 0 && item.startedAt
                                ? ` · ${(item.loaded / 1024 / 1024 / Math.max((performance.now() - item.startedAt) / 1000, 0.5)).toFixed(1)} MB/s`
                                : ""}
                            </span>
                          )}
                          {item.error && <span className="text-destructive">{item.error}</span>}
                        </div>
                        {item.status === "uploading" && (
                          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full bg-primary transition-[width]"
                              style={{ width: `${Math.max(2, item.progress)}%` }}
                            />
                          </div>
                        )}
                      </div>

                      {item.status === "queued" && !isUploading && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          onClick={() => removeFile(item.id)}
                          aria-label={`Remove ${item.file.name}`}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {queue.length > 0 && !allComplete && (
              <div className="grid gap-3 rounded-lg border bg-muted/20 p-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="category">Category</Label>
                    <Select
                      value={category}
                      onValueChange={(v) => setCategory(v as FileCategory | "auto")}
                      disabled={isUploading}
                    >
                      <SelectTrigger id="category" className="bg-background">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CATEGORY_OPTIONS.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="visibility">Visibility</Label>
                    <Select
                      value={visibility}
                      onValueChange={(value) => setVisibility(value as "public" | "private")}
                      disabled={isUploading}
                    >
                      <SelectTrigger id="visibility" className="bg-background">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="public">Project visible</SelectItem>
                        <SelectItem value="private">Private</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
              </div>
            )}
          </div>
        </div>

        <SheetFooter className="border-t bg-background px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-xs text-muted-foreground">
            {queue.length > 0
              ? `${queuedCount} queued · ${formatFileSize(totalSize)} total`
              : `Destination: ${destinationLabel}`}
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={isUploading}
          >
            {allComplete ? "Close" : "Cancel"}
          </Button>
          {!allComplete && (
            <Button
              onClick={handleUpload}
              disabled={!hasQueuedFiles || isUploading}
            >
              {isUploading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Uploading...
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4 mr-2" />
                  Upload {queuedCount} file{queuedCount !== 1 ? "s" : ""}
                </>
              )}
            </Button>
          )}
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
