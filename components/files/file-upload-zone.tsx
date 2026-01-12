"use client"

import { useCallback, useState, useRef } from "react"
import { cn } from "@/lib/utils"
import { Upload, X, FileText, CheckCircle, AlertCircle, Loader2 } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { formatFileSize, getMimeIcon, type FileCategory } from "./types"

interface FileUploadZoneProps {
  onUpload: (files: File[], category?: FileCategory) => Promise<void>
  category?: FileCategory
  maxFiles?: number
  maxSizeBytes?: number
  accept?: string
  disabled?: boolean
  className?: string
}

interface UploadingFile {
  id: string
  file: File
  progress: number
  status: "pending" | "uploading" | "complete" | "error"
  error?: string
}

export function FileUploadZone({
  onUpload,
  category,
  maxFiles = 20,
  maxSizeBytes = 100 * 1024 * 1024, // 100MB
  accept = ".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.gif,.webp,.dwg,.dxf,.txt,.csv,.zip",
  disabled = false,
  className,
}: FileUploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [uploadingFiles, setUploadingFiles] = useState<UploadingFile[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragCounterRef = useRef(0)

  const processFiles = useCallback(
    async (files: FileList | File[]) => {
      const fileArray = Array.from(files)

      // Validate files
      const validFiles: File[] = []
      const errors: string[] = []

      for (const file of fileArray) {
        if (file.size > maxSizeBytes) {
          errors.push(`${file.name} exceeds ${formatFileSize(maxSizeBytes)} limit`)
          continue
        }
        validFiles.push(file)
      }

      if (validFiles.length > maxFiles) {
        errors.push(`Maximum ${maxFiles} files allowed`)
        validFiles.splice(maxFiles)
      }

      if (validFiles.length === 0 && errors.length > 0) {
        // Show error toast
        return
      }

      // Add files to queue
      const queuedFiles: UploadingFile[] = validFiles.map((file) => ({
        id: `${file.name}-${Date.now()}-${Math.random()}`,
        file,
        progress: 0,
        status: "pending",
      }))

      setUploadingFiles((prev) => [...prev, ...queuedFiles])

      // Start upload
      for (const uploadFile of queuedFiles) {
        setUploadingFiles((prev) =>
          prev.map((f) =>
            f.id === uploadFile.id ? { ...f, status: "uploading", progress: 10 } : f
          )
        )

        try {
          // Simulate progress
          const progressInterval = setInterval(() => {
            setUploadingFiles((prev) =>
              prev.map((f) =>
                f.id === uploadFile.id && f.progress < 90
                  ? { ...f, progress: f.progress + 10 }
                  : f
              )
            )
          }, 200)

          await onUpload([uploadFile.file], category)

          clearInterval(progressInterval)

          setUploadingFiles((prev) =>
            prev.map((f) =>
              f.id === uploadFile.id ? { ...f, status: "complete", progress: 100 } : f
            )
          )

          // Remove completed after delay
          setTimeout(() => {
            setUploadingFiles((prev) => prev.filter((f) => f.id !== uploadFile.id))
          }, 2000)
        } catch (error) {
          setUploadingFiles((prev) =>
            prev.map((f) =>
              f.id === uploadFile.id
                ? { ...f, status: "error", error: "Upload failed" }
                : f
            )
          )
        }
      }
    },
    [onUpload, category, maxFiles, maxSizeBytes]
  )

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current += 1
    if (e.dataTransfer.items?.length) {
      setIsDragging(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current -= 1
    if (dragCounterRef.current === 0) {
      setIsDragging(false)
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragging(false)
      dragCounterRef.current = 0

      if (disabled) return

      const { files } = e.dataTransfer
      if (files?.length) {
        processFiles(files)
      }
    },
    [disabled, processFiles]
  )

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const { files } = e.target
      if (files?.length) {
        processFiles(files)
      }
      // Reset input
      if (fileInputRef.current) {
        fileInputRef.current.value = ""
      }
    },
    [processFiles]
  )

  const removeFromQueue = useCallback((id: string) => {
    setUploadingFiles((prev) => prev.filter((f) => f.id !== id))
  }, [])

  return (
    <div className={cn("space-y-4", className)}>
      {/* Drop Zone */}
      <div
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onClick={() => !disabled && fileInputRef.current?.click()}
        className={cn(
          "relative flex flex-col items-center justify-center gap-4 rounded-lg border-2 border-dashed p-8 transition-all cursor-pointer",
          isDragging
            ? "border-primary bg-primary/5 scale-[1.02]"
            : "border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/50",
          disabled && "opacity-50 cursor-not-allowed"
        )}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={accept}
          onChange={handleFileSelect}
          disabled={disabled}
          className="hidden"
        />

        <div
          className={cn(
            "flex h-14 w-14 items-center justify-center rounded-full transition-colors",
            isDragging ? "bg-primary/20" : "bg-muted"
          )}
        >
          <Upload
            className={cn(
              "h-7 w-7 transition-colors",
              isDragging ? "text-primary" : "text-muted-foreground"
            )}
          />
        </div>

        <div className="text-center">
          <p className="font-medium">
            {isDragging ? "Drop files here" : "Drag & drop files here"}
          </p>
          <p className="text-sm text-muted-foreground mt-1">
            or click to browse • Max {formatFileSize(maxSizeBytes)} per file
          </p>
        </div>

        <div className="flex flex-wrap justify-center gap-2 text-xs text-muted-foreground">
          <span className="px-2 py-1 rounded bg-muted">PDF</span>
          <span className="px-2 py-1 rounded bg-muted">Images</span>
          <span className="px-2 py-1 rounded bg-muted">Documents</span>
          <span className="px-2 py-1 rounded bg-muted">Spreadsheets</span>
          <span className="px-2 py-1 rounded bg-muted">CAD Files</span>
        </div>
      </div>

      {/* Upload Queue */}
      {uploadingFiles.length > 0 && (
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-medium">
              Uploading {uploadingFiles.filter((f) => f.status === "uploading").length} of{" "}
              {uploadingFiles.length} files
            </h4>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setUploadingFiles([])}
              className="text-xs"
            >
              Clear all
            </Button>
          </div>

          <ScrollArea className="max-h-[200px]">
            <div className="space-y-2">
              {uploadingFiles.map((uploadFile) => (
                <div
                  key={uploadFile.id}
                  className="flex items-center gap-3 rounded-lg bg-muted/50 p-3"
                >
                  <span className="text-lg shrink-0">
                    {getMimeIcon(uploadFile.file.type)}
                  </span>

                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {uploadFile.file.name}
                    </p>
                    <div className="flex items-center gap-2 mt-1">
                      <Progress value={uploadFile.progress} className="h-1.5 flex-1" />
                      <span className="text-xs text-muted-foreground shrink-0">
                        {uploadFile.progress}%
                      </span>
                    </div>
                  </div>

                  <div className="shrink-0">
                    {uploadFile.status === "uploading" && (
                      <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    )}
                    {uploadFile.status === "complete" && (
                      <CheckCircle className="h-4 w-4 text-success" />
                    )}
                    {uploadFile.status === "error" && (
                      <AlertCircle className="h-4 w-4 text-destructive" />
                    )}
                    {uploadFile.status === "pending" && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => removeFromQueue(uploadFile.id)}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  )
}












