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
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { uploadFileAction } from "@/app/(app)/files/actions"
import type { FileCategory } from "@/components/files/types"

interface UploadQueueItem {
  id: string
  file: File
  status: "queued" | "uploading" | "success" | "error"
  error?: string
}

interface UploadDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialFiles?: File[]
  projectId: string
  folderPath?: string
  folderOptions?: string[]
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

const ROOT_FOLDER_VALUE = "__docs-root__"

function normalizeFolderPath(value?: string | null): string {
  if (!value) return ""
  const trimmed = value.trim()
  if (!trimmed) return ""
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`
  const normalized = withLeadingSlash.replace(/\/+/g, "/").replace(/\/$/, "")
  return normalized === "/" ? "" : normalized
}

export function UploadDialog({
  open,
  onOpenChange,
  initialFiles = [],
  projectId,
  folderPath,
  folderOptions = [],
  onUploadComplete,
}: UploadDialogProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const seededInitialFilesRef = useRef("")
  const [queue, setQueue] = useState<UploadQueueItem[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const [category, setCategory] = useState<FileCategory | "auto">("auto")
  const [targetFolder, setTargetFolder] = useState(normalizeFolderPath(folderPath))

  const currentFolder = useMemo(() => normalizeFolderPath(folderPath), [folderPath])
  const selectableFolders = useMemo(() => {
    const paths = new Set<string>()
    for (const path of folderOptions) {
      const normalized = normalizeFolderPath(path)
      if (normalized) paths.add(normalized)
    }
    if (currentFolder) paths.add(currentFolder)
    const normalizedTarget = normalizeFolderPath(targetFolder)
    if (normalizedTarget) paths.add(normalizedTarget)
    return Array.from(paths).sort((a, b) => a.localeCompare(b))
  }, [folderOptions, currentFolder, targetFolder])

  // Populate queue with initial files
  const addFiles = useCallback((files: File[]) => {
    const newItems: UploadQueueItem[] = files.map((file) => ({
      id: `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      status: "queued",
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
    setTargetFolder(normalizeFolderPath(folderPath))
    addFiles(initialFiles)
  }, [open, initialFiles, folderPath, addFiles])

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        setTargetFolder(normalizeFolderPath(folderPath))
      }
      if (!nextOpen) {
        setQueue([])
        setCategory("auto")
        setTargetFolder("")
        seededInitialFilesRef.current = ""
      }
      onOpenChange(nextOpen)
    },
    [folderPath, onOpenChange]
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

    for (const item of pendingItems) {
      setQueue((prev) =>
        prev.map((q) =>
          q.id === item.id ? { ...q, status: "uploading" } : q
        )
      )

      try {
        const formData = new FormData()
        formData.append("file", item.file)
        formData.append("projectId", projectId)
        if (category !== "auto") {
          formData.append("category", category)
        }
        if (targetFolder) {
          formData.append("folderPath", targetFolder)
        }

        await uploadFileAction(formData)

        setQueue((prev) =>
          prev.map((q) =>
            q.id === item.id ? { ...q, status: "success" } : q
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
  }, [queue, projectId, category, targetFolder, onUploadComplete, handleOpenChange])

  const hasQueuedFiles = queue.some((item) => item.status === "queued")
  const allComplete = queue.length > 0 && queue.every((item) => item.status !== "queued" && item.status !== "uploading")

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload Files</DialogTitle>
          <DialogDescription>
            Add files to your project. Drag and drop or click to browse.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Drop zone / Add files button */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileInputChange}
            accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.gif,.webp,.dwg,.dxf,.txt,.csv,.zip"
          />

          {queue.length === 0 ? (
            <button
              onClick={() => fileInputRef.current?.click()}
              className={cn(
                "flex flex-col items-center justify-center w-full h-40 border-2 border-dashed rounded-lg transition-colors",
                "border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/50"
              )}
            >
              <Upload className="h-8 w-8 text-muted-foreground mb-2" />
              <p className="text-sm font-medium">Drop files here</p>
              <p className="text-xs text-muted-foreground mt-1">
                or click to browse
              </p>
            </button>
          ) : (
            <div className="space-y-3">
              {/* File list */}
              <div className="max-h-48 overflow-y-auto space-y-2">
                {queue.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center gap-3 p-2 rounded-lg border bg-muted/30"
                  >
                    {/* Status icon */}
                    <div className="shrink-0">
                      {item.status === "uploading" && (
                        <Loader2 className="h-4 w-4 animate-spin text-primary" />
                      )}
                      {item.status === "success" && (
                        <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                      )}
                      {item.status === "error" && (
                        <AlertTriangle className="h-4 w-4 text-destructive" />
                      )}
                      {item.status === "queued" && (
                        <FileText className="h-4 w-4 text-muted-foreground" />
                      )}
                    </div>

                    {/* File info */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {item.file.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {(item.file.size / 1024 / 1024).toFixed(2)} MB
                        {item.error && (
                          <span className="text-destructive ml-2">
                            {item.error}
                          </span>
                        )}
                      </p>
                    </div>

                    {/* Remove button */}
                    {item.status === "queued" && !isUploading && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 shrink-0"
                        onClick={() => removeFile(item.id)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>

              {/* Add more files button */}
              {!isUploading && !allComplete && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Add more files
                </Button>
              )}
            </div>
          )}

          {/* Options */}
          {queue.length > 0 && !allComplete && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="category">Category</Label>
                <Select
                  value={category}
                  onValueChange={(v) => setCategory(v as FileCategory | "auto")}
                  disabled={isUploading}
                >
                  <SelectTrigger id="category">
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
                <Label htmlFor="folder">Folder</Label>
                <Select
                  value={targetFolder || ROOT_FOLDER_VALUE}
                  onValueChange={(value) =>
                    setTargetFolder(value === ROOT_FOLDER_VALUE ? "" : value)
                  }
                  disabled={isUploading}
                >
                  <SelectTrigger id="folder">
                    <SelectValue placeholder="Choose folder" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ROOT_FOLDER_VALUE}>Project root</SelectItem>
                    {selectableFolders.map((path) => (
                      <SelectItem key={path} value={path}>
                        {path}
                        {path === currentFolder ? " (Current)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
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
                  Upload {queue.filter((q) => q.status === "queued").length} file
                  {queue.filter((q) => q.status === "queued").length !== 1
                    ? "s"
                    : ""}
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
