"use client"

import { useState, useMemo, useCallback, useRef } from "react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Upload, FileText } from "@/components/icons"
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
import { FileDropOverlay } from "./file-drop-overlay"
import { FileViewer } from "./file-viewer"
import { FileGrid } from "./file-grid"
import { FileList } from "./file-list"
import { FileToolbar, type ViewMode } from "./file-toolbar"
import {
  type FileWithDetails,
  type FileCategory,
  isImageFile,
  isPreviewable,
  FILE_CATEGORIES,
} from "./types"

interface FilesManagerProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  files: any[]
  projectId: string
  onUpload: (files: File[], category?: FileCategory) => Promise<void>
  onDelete: (fileId: string) => Promise<void>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onDownload: (file: any) => void
  className?: string
}

export function FilesManager({
  files: rawFiles,
  projectId,
  onUpload,
  onDelete,
  onDownload,
  className,
}: FilesManagerProps) {
  // Cast files to the expected type
  const files = rawFiles as FileWithDetails[]

  // View state
  const [viewMode, setViewMode] = useState<ViewMode>("grid")
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedCategory, setSelectedCategory] = useState<FileCategory | "all">("all")
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showImageOnly, setShowImageOnly] = useState(false)

  // Drag and drop state
  const [isDraggingOver, setIsDraggingOver] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const dragCounterRef = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Viewer state
  const [viewerOpen, setViewerOpen] = useState(false)
  const [viewerFile, setViewerFile] = useState<FileWithDetails | null>(null)

  // Delete confirmation
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [fileToDelete, setFileToDelete] = useState<FileWithDetails | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  // Filter files
  const filteredFiles = useMemo(() => {
    let result = files

    // Category filter
    if (selectedCategory !== "all") {
      result = result.filter((f) => f.category === selectedCategory)
    }

    // Image only filter
    if (showImageOnly) {
      result = result.filter((f) => isImageFile(f.mime_type))
    }

    // Search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase()
      result = result.filter(
        (f) =>
          f.file_name.toLowerCase().includes(query) ||
          f.tags?.some((t) => t.toLowerCase().includes(query)) ||
          f.description?.toLowerCase().includes(query)
      )
    }

    return result
  }, [files, selectedCategory, showImageOnly, searchQuery])

  // Get previewable files for gallery navigation
  const previewableFiles = useMemo(
    () => filteredFiles.filter((f) => isPreviewable(f.mime_type)),
    [filteredFiles]
  )

  // Drag and drop handlers
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current += 1
    if (e.dataTransfer.items?.length) {
      setIsDraggingOver(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current -= 1
    if (dragCounterRef.current === 0) {
      setIsDraggingOver(false)
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
      setIsDraggingOver(false)
      dragCounterRef.current = 0

      const droppedFiles = Array.from(e.dataTransfer.files)
      if (droppedFiles.length === 0) return

      setIsUploading(true)
      try {
        await onUpload(droppedFiles)
        toast.success(
          `${droppedFiles.length} file${droppedFiles.length > 1 ? "s" : ""} uploaded`
        )
      } catch (error) {
        console.error("Upload failed:", error)
        toast.error("Failed to upload files")
      } finally {
        setIsUploading(false)
      }
    },
    [onUpload]
  )

  // File input handler (for button click)
  const handleFileInputChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const selectedFiles = Array.from(e.target.files ?? [])
      if (selectedFiles.length === 0) return

      // Reset input so same file can be selected again
      if (fileInputRef.current) {
        fileInputRef.current.value = ""
      }

      setIsUploading(true)
      try {
        await onUpload(selectedFiles)
        toast.success(
          `${selectedFiles.length} file${selectedFiles.length > 1 ? "s" : ""} uploaded`
        )
      } catch (error) {
        console.error("Upload failed:", error)
        toast.error("Failed to upload files")
      } finally {
        setIsUploading(false)
      }
    },
    [onUpload]
  )

  const handlePreview = useCallback((file: FileWithDetails) => {
    setViewerFile(file)
    setViewerOpen(true)
  }, [])

  const handleDownload = useCallback(
    (file: FileWithDetails) => {
      onDownload(file)
      toast.success(`Downloading ${file.file_name}`)
    },
    [onDownload]
  )

  const handleDeleteClick = useCallback((file: FileWithDetails) => {
    setFileToDelete(file)
    setDeleteDialogOpen(true)
  }, [])

  const handleDeleteConfirm = useCallback(async () => {
    if (!fileToDelete) return

    setIsDeleting(true)
    try {
      await onDelete(fileToDelete.id)
      toast.success(`Deleted ${fileToDelete.file_name}`)
      setDeleteDialogOpen(false)
      setFileToDelete(null)
    } catch (error) {
      console.error("Delete failed:", error)
      toast.error("Failed to delete file")
    } finally {
      setIsDeleting(false)
    }
  }, [fileToDelete, onDelete])

  const handleBulkDownload = useCallback(() => {
    const selectedFiles = files.filter((f) => selectedIds.has(f.id))
    selectedFiles.forEach((f) => onDownload(f))
    toast.success(`Downloading ${selectedFiles.length} files`)
  }, [files, selectedIds, onDownload])

  const handleBulkDelete = useCallback(async () => {
    const selectedFiles = files.filter((f) => selectedIds.has(f.id))
    // For now, just show a toast - in production you'd want a confirmation dialog
    toast.info(`Bulk delete ${selectedFiles.length} files (not implemented)`)
  }, [files, selectedIds])

  const handleClearSelection = useCallback(() => {
    setSelectedIds(new Set())
  }, [])

  return (
    <div
      className={cn("flex flex-col h-full relative rounded-xl border bg-card p-4", className)}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Hidden file input for button upload */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileInputChange}
        accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.gif,.webp,.dwg,.dxf,.txt,.csv,.zip"
      />

      {/* Drop overlay */}
      <FileDropOverlay isVisible={isDraggingOver} />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:gap-4 mb-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 overflow-x-auto pb-1">
            <Button
              variant={selectedCategory === "all" ? "secondary" : "ghost"}
              size="sm"
              className="h-9 shrink-0"
              onClick={() => setSelectedCategory("all")}
            >
              All Files
              <span className="ml-2 text-xs text-muted-foreground">{files.length}</span>
            </Button>
            {(Object.keys(FILE_CATEGORIES) as FileCategory[]).map((cat) => {
              const { label, icon } = FILE_CATEGORIES[cat]
              const count = files.filter((f) => (f.category ?? "other") === cat).length
              const isSelected = selectedCategory === cat
              return (
                <Button
                  key={cat}
                  variant={isSelected ? "secondary" : "ghost"}
                  size="sm"
                  className="h-9 shrink-0"
                  onClick={() => setSelectedCategory(cat)}
                >
                  <span className="mr-2 text-base">{icon}</span>
                  {label}
                  {count > 0 && (
                    <span className="ml-2 text-xs text-muted-foreground">{count}</span>
                  )}
                </Button>
              )
            })}
          </div>
        </div>

        <div className="flex-1 w-full">
          <FileToolbar
            className="w-full"
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            selectedCount={selectedIds.size}
            onBulkDownload={handleBulkDownload}
            onBulkDelete={handleBulkDelete}
            onClearSelection={handleClearSelection}
            showImageOnly={showImageOnly}
            onShowImageOnlyChange={setShowImageOnly}
          />
        </div>

        <div className="flex justify-end">
          <Button
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
          >
            <Upload className="mr-2 h-4 w-4" />
            {isUploading ? "Uploading..." : "Upload Files"}
          </Button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 min-h-0">
        {/* Show empty state with drop zone when no files */}
        {files.length === 0 ? (
          <div
            className={cn(
              "flex flex-col items-center justify-center py-16 px-8 border-2 border-dashed rounded-lg transition-colors cursor-pointer",
              isDraggingOver
                ? "border-primary bg-primary/5"
                : "border-muted-foreground/25 hover:border-primary/50"
            )}
            onClick={() => fileInputRef.current?.click()}
          >
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted mb-4">
              <FileText className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="font-semibold text-lg">No files yet</h3>
            <p className="text-sm text-muted-foreground mt-1 text-center max-w-sm">
              Drag and drop files here, or click to browse. Upload plans, contracts, photos, and documents.
            </p>
            <Button className="mt-4" variant="outline">
              <Upload className="mr-2 h-4 w-4" />
              Choose Files
            </Button>
          </div>
        ) : (
          <>
            {/* Files grid/list */}
            {viewMode === "grid" ? (
              <FileGrid
                files={filteredFiles}
                selectedIds={selectedIds}
                onSelectionChange={setSelectedIds}
                onPreview={handlePreview}
                onDownload={handleDownload}
                onDelete={handleDeleteClick}
              />
            ) : (
              <FileList
                files={filteredFiles}
                selectedIds={selectedIds}
                onSelectionChange={setSelectedIds}
                onPreview={handlePreview}
                onDownload={handleDownload}
                onDelete={handleDeleteClick}
              />
            )}
          </>
        )}
      </div>

      {/* File Viewer */}
      <FileViewer
        file={viewerFile}
        files={previewableFiles}
        open={viewerOpen}
        onOpenChange={setViewerOpen}
        onDownload={handleDownload}
      />

      {/* Delete confirmation dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete file?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{fileToDelete?.file_name}"? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
