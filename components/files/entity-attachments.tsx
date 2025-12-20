"use client"

import { useState, useCallback, useRef } from "react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Upload, Paperclip, Trash2, Download, Eye, X, FileText } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { FileViewer } from "./file-viewer"
import { formatFileSize, isPreviewable, getMimeIcon, type FileWithDetails } from "./types"

export interface AttachedFile {
  id: string
  linkId: string
  file_name: string
  mime_type?: string
  size_bytes?: number
  download_url?: string
  thumbnail_url?: string
  created_at: string
  link_role?: string
}

interface EntityAttachmentsProps {
  entityType: string
  entityId: string
  projectId?: string
  attachments: AttachedFile[]
  onAttach: (files: File[], linkRole?: string) => Promise<void>
  onDetach: (linkId: string) => Promise<void>
  onDownload?: (attachment: AttachedFile) => void
  linkRole?: string
  className?: string
  title?: string
  description?: string
  maxFiles?: number
  acceptedTypes?: string
  readOnly?: boolean
  compact?: boolean
}

export function EntityAttachments({
  entityType,
  entityId,
  projectId,
  attachments,
  onAttach,
  onDetach,
  onDownload,
  linkRole,
  className,
  title = "Attachments",
  description,
  maxFiles,
  acceptedTypes = ".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.gif,.webp,.dwg,.dxf,.txt,.csv,.zip",
  readOnly = false,
  compact = false,
}: EntityAttachmentsProps) {
  const [isUploading, setIsUploading] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [detachDialogOpen, setDetachDialogOpen] = useState(false)
  const [attachmentToDetach, setAttachmentToDetach] = useState<AttachedFile | null>(null)
  const [isDetaching, setIsDetaching] = useState(false)
  const [viewerOpen, setViewerOpen] = useState(false)
  const [viewerFile, setViewerFile] = useState<FileWithDetails | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragCounterRef = useRef(0)

  const canAddMore = !maxFiles || attachments.length < maxFiles

  const handleFiles = useCallback(
    async (files: File[]) => {
      if (!canAddMore) {
        toast.error(`Maximum ${maxFiles} attachments allowed`)
        return
      }

      const filesToUpload = maxFiles
        ? files.slice(0, maxFiles - attachments.length)
        : files

      if (filesToUpload.length === 0) return

      setIsUploading(true)
      try {
        await onAttach(filesToUpload, linkRole)
        toast.success(
          `${filesToUpload.length} file${filesToUpload.length > 1 ? "s" : ""} attached`
        )
      } catch (error) {
        console.error("Attach failed:", error)
        toast.error("Failed to attach files")
      } finally {
        setIsUploading(false)
      }
    },
    [onAttach, linkRole, canAddMore, maxFiles, attachments.length]
  )

  const handleInputChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? [])
      if (fileInputRef.current) {
        fileInputRef.current.value = ""
      }
      if (files.length > 0) {
        await handleFiles(files)
      }
    },
    [handleFiles]
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
    async (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragging(false)
      dragCounterRef.current = 0

      if (readOnly) return

      const files = Array.from(e.dataTransfer.files)
      if (files.length > 0) {
        await handleFiles(files)
      }
    },
    [handleFiles, readOnly]
  )

  const handleDetachClick = useCallback((attachment: AttachedFile) => {
    setAttachmentToDetach(attachment)
    setDetachDialogOpen(true)
  }, [])

  const handleDetachConfirm = useCallback(async () => {
    if (!attachmentToDetach) return

    setIsDetaching(true)
    try {
      await onDetach(attachmentToDetach.linkId)
      toast.success(`Removed ${attachmentToDetach.file_name}`)
      setDetachDialogOpen(false)
      setAttachmentToDetach(null)
    } catch (error) {
      console.error("Detach failed:", error)
      toast.error("Failed to remove attachment")
    } finally {
      setIsDetaching(false)
    }
  }, [attachmentToDetach, onDetach])

  const handlePreview = useCallback((attachment: AttachedFile) => {
    setViewerFile({
      id: attachment.id,
      org_id: "",
      file_name: attachment.file_name,
      storage_path: "",
      visibility: "private",
      created_at: attachment.created_at,
      mime_type: attachment.mime_type,
      size_bytes: attachment.size_bytes,
      download_url: attachment.download_url,
      thumbnail_url: attachment.thumbnail_url,
    })
    setViewerOpen(true)
  }, [])

  const handleDownload = useCallback(
    (attachment: AttachedFile) => {
      if (onDownload) {
        onDownload(attachment)
      } else if (attachment.download_url) {
        const link = document.createElement("a")
        link.href = attachment.download_url
        link.download = attachment.file_name
        link.click()
        toast.success(`Downloading ${attachment.file_name}`)
      }
    },
    [onDownload]
  )

  const previewableFiles = attachments
    .filter((a) => isPreviewable(a.mime_type))
    .map((a) => ({
      id: a.id,
      org_id: "",
      file_name: a.file_name,
      storage_path: "",
      visibility: "private",
      created_at: a.created_at,
      mime_type: a.mime_type,
      size_bytes: a.size_bytes,
      download_url: a.download_url,
      thumbnail_url: a.thumbnail_url,
    }))

  if (compact) {
    return (
      <div className={cn("space-y-2", className)}>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleInputChange}
          accept={acceptedTypes}
        />

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Paperclip className="h-4 w-4" />
            <span>
              {attachments.length} attachment{attachments.length !== 1 ? "s" : ""}
            </span>
          </div>
          {!readOnly && canAddMore && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
            >
              <Upload className="h-4 w-4 mr-1" />
              {isUploading ? "Uploading..." : "Add"}
            </Button>
          )}
        </div>

        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {attachments.map((attachment) => (
              <div
                key={attachment.linkId}
                className="flex items-center gap-2 px-2 py-1 rounded-md bg-muted text-sm"
              >
                <span className="text-base">{getMimeIcon(attachment.mime_type)}</span>
                <span className="truncate max-w-[150px]">{attachment.file_name}</span>
                <div className="flex items-center gap-1">
                  {isPreviewable(attachment.mime_type) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      onClick={() => handlePreview(attachment)}
                    >
                      <Eye className="h-3 w-3" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0"
                    onClick={() => handleDownload(attachment)}
                  >
                    <Download className="h-3 w-3" />
                  </Button>
                  {!readOnly && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                      onClick={() => handleDetachClick(attachment)}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <FileViewer
          file={viewerFile}
          files={previewableFiles}
          open={viewerOpen}
          onOpenChange={setViewerOpen}
          onDownload={(f) => {
            const attachment = attachments.find((a) => a.id === f.id)
            if (attachment) handleDownload(attachment)
          }}
        />

        <AlertDialog open={detachDialogOpen} onOpenChange={setDetachDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove attachment?</AlertDialogTitle>
              <AlertDialogDescription>
                This will remove "{attachmentToDetach?.file_name}" from this{" "}
                {entityType.toLowerCase()}. The file will not be deleted.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isDetaching}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDetachConfirm}
                disabled={isDetaching}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {isDetaching ? "Removing..." : "Remove"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    )
  }

  return (
    <div
      className={cn("space-y-4", className)}
      onDragEnter={!readOnly ? handleDragEnter : undefined}
      onDragLeave={!readOnly ? handleDragLeave : undefined}
      onDragOver={!readOnly ? handleDragOver : undefined}
      onDrop={!readOnly ? handleDrop : undefined}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleInputChange}
        accept={acceptedTypes}
      />

      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">{title}</h3>
          {description && (
            <p className="text-xs text-muted-foreground mt-1">{description}</p>
          )}
        </div>
        {!readOnly && canAddMore && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
          >
            <Upload className="h-4 w-4 mr-2" />
            {isUploading ? "Uploading..." : "Add Files"}
          </Button>
        )}
      </div>

      {attachments.length === 0 ? (
        <div
          className={cn(
            "flex flex-col items-center justify-center py-8 px-4 border-2 border-dashed rounded-lg transition-colors",
            !readOnly && "cursor-pointer hover:border-primary/50",
            isDragging && "border-primary bg-primary/5"
          )}
          onClick={!readOnly ? () => fileInputRef.current?.click() : undefined}
        >
          <FileText className="h-8 w-8 text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground text-center">
            {readOnly
              ? "No attachments"
              : "Drag and drop files here, or click to browse"}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {attachments.map((attachment) => (
            <div
              key={attachment.linkId}
              className="flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
            >
              <div className="text-2xl shrink-0">{getMimeIcon(attachment.mime_type)}</div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{attachment.file_name}</p>
                <p className="text-xs text-muted-foreground">
                  {formatFileSize(attachment.size_bytes)}
                  {attachment.link_role && (
                    <span className="ml-2 text-primary">• {attachment.link_role}</span>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {isPreviewable(attachment.mime_type) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handlePreview(attachment)}
                  >
                    <Eye className="h-4 w-4" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDownload(attachment)}
                >
                  <Download className="h-4 w-4" />
                </Button>
                {!readOnly && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={() => handleDetachClick(attachment)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {maxFiles && (
        <p className="text-xs text-muted-foreground">
          {attachments.length} of {maxFiles} attachments
        </p>
      )}

      <FileViewer
        file={viewerFile}
        files={previewableFiles}
        open={viewerOpen}
        onOpenChange={setViewerOpen}
        onDownload={(f) => {
          const attachment = attachments.find((a) => a.id === f.id)
          if (attachment) handleDownload(attachment)
        }}
      />

      <AlertDialog open={detachDialogOpen} onOpenChange={setDetachDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove attachment?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove "{attachmentToDetach?.file_name}" from this{" "}
              {entityType.toLowerCase()}. The file will not be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDetaching}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDetachConfirm}
              disabled={isDetaching}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDetaching ? "Removing..." : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
