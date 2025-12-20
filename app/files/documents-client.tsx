"use client"

import { useState, useEffect, useCallback, useRef, useMemo } from "react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Upload, FileText, Search, Filter, FolderOpen, X, MoreHorizontal } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
import { Badge } from "@/components/ui/badge"
import { FileDropOverlay } from "@/components/files/file-drop-overlay"
import { FileViewer } from "@/components/files/file-viewer"
import { FileGrid } from "@/components/files/file-grid"
import { FileList } from "@/components/files/file-list"
import { FileToolbar, type ViewMode } from "@/components/files/file-toolbar"
import {
  type FileWithDetails,
  type FileCategory,
  isImageFile,
  isPreviewable,
  FILE_CATEGORIES,
} from "@/components/files/types"
import {
  listFilesAction,
  uploadFileAction,
  deleteFileAction,
  getFileDownloadUrlAction,
  updateFileAction,
  archiveFileAction,
  getFileCountsAction,
  listProjectsForFilterAction,
} from "./actions"
import type { FileWithUrls, FileUpdate } from "./actions"
import { FileMetadataSheet } from "./file-metadata-sheet"

interface DocumentsCenterClientProps {
  initialFiles: FileWithUrls[]
  initialCounts: Record<string, number>
  initialProjects: Array<{ id: string; name: string }>
  defaultProjectId?: string
}

export function DocumentsCenterClient({
  initialFiles,
  initialCounts,
  initialProjects,
  defaultProjectId,
}: DocumentsCenterClientProps) {
  // Data state
  const [files, setFiles] = useState<FileWithUrls[]>(initialFiles)
  const [counts, setCounts] = useState(initialCounts)
  const [projects] = useState(initialProjects)

  // Filter state
  const [selectedProject, setSelectedProject] = useState<string | undefined>(defaultProjectId)
  const [selectedCategory, setSelectedCategory] = useState<FileCategory | "all">("all")
  const [searchQuery, setSearchQuery] = useState("")
  const [showArchived, setShowArchived] = useState(false)

  // View state
  const [viewMode, setViewMode] = useState<ViewMode>("grid")
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
  const [fileToDelete, setFileToDelete] = useState<FileWithUrls | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  // Metadata edit
  const [metadataSheetOpen, setMetadataSheetOpen] = useState(false)
  const [fileToEdit, setFileToEdit] = useState<FileWithUrls | null>(null)

  // Loading state
  const [isLoading, setIsLoading] = useState(false)

  // Fetch files when filters change
  const fetchFiles = useCallback(async () => {
    setIsLoading(true)
    try {
      const [filesData, countsData] = await Promise.all([
        listFilesAction({
          project_id: selectedProject,
          category: selectedCategory === "all" ? undefined : selectedCategory,
          search: searchQuery || undefined,
          include_archived: showArchived,
        }),
        getFileCountsAction(selectedProject),
      ])

      setFiles(filesData)
      setCounts(countsData)
    } catch (error) {
      console.error("Failed to fetch files:", error)
      toast.error("Failed to load files")
    } finally {
      setIsLoading(false)
    }
  }, [selectedProject, selectedCategory, searchQuery, showArchived])

  // Debounce search
  useEffect(() => {
    const timeout = setTimeout(() => {
      fetchFiles()
    }, 300)

    return () => clearTimeout(timeout)
  }, [fetchFiles])

  // Map files to the UI component's expected format
  const mappedFiles = useMemo<FileWithDetails[]>(() => {
    let result = files.map((f) => ({
      ...f,
      category: f.category as FileCategory | undefined,
    }))

    // Apply image-only filter locally
    if (showImageOnly) {
      result = result.filter((f) => isImageFile(f.mime_type))
    }

    return result
  }, [files, showImageOnly])

  // Get previewable files for gallery navigation
  const previewableFiles = useMemo(
    () => mappedFiles.filter((f) => isPreviewable(f.mime_type)),
    [mappedFiles]
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

  const handleUpload = useCallback(
    async (filesToUpload: File[]) => {
      setIsUploading(true)
      try {
        for (const file of filesToUpload) {
          const formData = new FormData()
          formData.append("file", file)
          if (selectedProject) {
            formData.append("projectId", selectedProject)
          }
          if (selectedCategory !== "all") {
            formData.append("category", selectedCategory)
          }

          await uploadFileAction(formData)
        }

        toast.success(
          `${filesToUpload.length} file${filesToUpload.length > 1 ? "s" : ""} uploaded`
        )
        fetchFiles()
      } catch (error) {
        console.error("Upload failed:", error)
        toast.error("Failed to upload files")
      } finally {
        setIsUploading(false)
      }
    },
    [selectedProject, selectedCategory, fetchFiles]
  )

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDraggingOver(false)
      dragCounterRef.current = 0

      const droppedFiles = Array.from(e.dataTransfer.files)
      if (droppedFiles.length === 0) return

      await handleUpload(droppedFiles)
    },
    [handleUpload]
  )

  const handleFileInputChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const selectedFiles = Array.from(e.target.files ?? [])
      if (selectedFiles.length === 0) return

      if (fileInputRef.current) {
        fileInputRef.current.value = ""
      }

      await handleUpload(selectedFiles)
    },
    [handleUpload]
  )

  const handlePreview = useCallback((file: FileWithDetails) => {
    setViewerFile(file)
    setViewerOpen(true)
  }, [])

  const handleDownload = useCallback(async (file: FileWithDetails) => {
    try {
      const url = await getFileDownloadUrlAction(file.id)
      const link = document.createElement("a")
      link.href = url
      link.download = file.file_name
      link.click()
      toast.success(`Downloading ${file.file_name}`)
    } catch (error) {
      console.error("Download failed:", error)
      toast.error("Failed to download file")
    }
  }, [])

  const handleDeleteClick = useCallback((file: FileWithDetails) => {
    setFileToDelete(file as FileWithUrls)
    setDeleteDialogOpen(true)
  }, [])

  const handleDeleteConfirm = useCallback(async () => {
    if (!fileToDelete) return

    setIsDeleting(true)
    try {
      await deleteFileAction(fileToDelete.id)
      toast.success(`Deleted ${fileToDelete.file_name}`)
      setDeleteDialogOpen(false)
      setFileToDelete(null)
      fetchFiles()
    } catch (error) {
      console.error("Delete failed:", error)
      toast.error("Failed to delete file")
    } finally {
      setIsDeleting(false)
    }
  }, [fileToDelete, fetchFiles])

  const handleEditMetadata = useCallback((file: FileWithDetails) => {
    setFileToEdit(file as FileWithUrls)
    setMetadataSheetOpen(true)
  }, [])

  const handleSaveMetadata = useCallback(
    async (fileId: string, updates: FileUpdate) => {
      try {
        await updateFileAction(fileId, updates)
        toast.success("File updated")
        setMetadataSheetOpen(false)
        setFileToEdit(null)
        fetchFiles()
      } catch (error) {
        console.error("Update failed:", error)
        toast.error("Failed to update file")
      }
    },
    [fetchFiles]
  )

  const handleArchive = useCallback(
    async (file: FileWithDetails) => {
      try {
        await archiveFileAction(file.id)
        toast.success(`Archived ${file.file_name}`)
        fetchFiles()
      } catch (error) {
        console.error("Archive failed:", error)
        toast.error("Failed to archive file")
      }
    },
    [fetchFiles]
  )

  const handleBulkDownload = useCallback(() => {
    const selectedFiles = mappedFiles.filter((f) => selectedIds.has(f.id))
    selectedFiles.forEach((f) => handleDownload(f))
  }, [mappedFiles, selectedIds, handleDownload])

  const handleBulkDelete = useCallback(async () => {
    toast.info(`Bulk delete ${selectedIds.size} files (not implemented)`)
  }, [selectedIds])

  const handleClearSelection = useCallback(() => {
    setSelectedIds(new Set())
  }, [])

  return (
    <div
      className="flex flex-col h-full relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Hidden file input */}
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

      {/* Header with filters */}
      <div className="flex flex-col gap-4 mb-6">
        {/* Top row: Project filter, Search, Upload */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex items-center gap-2 flex-1">
            <Select
              value={selectedProject ?? "all"}
              onValueChange={(value) =>
                setSelectedProject(value === "all" ? undefined : value)
              }
            >
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="All Projects" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Projects</SelectItem>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search files..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
              {searchQuery && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6 p-0"
                  onClick={() => setSearchQuery("")}
                >
                  <X className="h-3 w-3" />
                </Button>
              )}
            </div>
          </div>

          <Button onClick={() => fileInputRef.current?.click()} disabled={isUploading}>
            <Upload className="mr-2 h-4 w-4" />
            {isUploading ? "Uploading..." : "Upload"}
          </Button>
        </div>

        {/* Category tabs */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          <Button
            variant={selectedCategory === "all" ? "secondary" : "ghost"}
            size="sm"
            className="h-9 shrink-0"
            onClick={() => setSelectedCategory("all")}
          >
            All Files
            <span className="ml-2 text-xs text-muted-foreground">{counts.all ?? 0}</span>
          </Button>
          {(Object.keys(FILE_CATEGORIES) as FileCategory[]).map((cat) => {
            const { label, icon } = FILE_CATEGORIES[cat]
            const count = counts[cat] ?? 0
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

        {/* Toolbar */}
        <FileToolbar
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          searchQuery=""
          onSearchChange={() => {}}
          selectedCount={selectedIds.size}
          onBulkDownload={handleBulkDownload}
          onBulkDelete={handleBulkDelete}
          onClearSelection={handleClearSelection}
          showImageOnly={showImageOnly}
          onShowImageOnlyChange={setShowImageOnly}
        />
      </div>

      {/* Main content */}
      <div className="flex-1 min-h-0">
        {isLoading ? (
          <div className="flex items-center justify-center h-64">
            <div className="text-muted-foreground">Loading files...</div>
          </div>
        ) : mappedFiles.length === 0 ? (
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
              {searchQuery || selectedCategory !== "all"
                ? "No files match your filters. Try adjusting your search or category."
                : "Drag and drop files here, or click to browse. Upload plans, contracts, photos, and documents."}
            </p>
            {!searchQuery && selectedCategory === "all" && (
              <Button className="mt-4" variant="outline">
                <Upload className="mr-2 h-4 w-4" />
                Choose Files
              </Button>
            )}
          </div>
        ) : viewMode === "grid" ? (
          <FileGrid
            files={mappedFiles}
            selectedIds={selectedIds}
            onSelectionChange={setSelectedIds}
            onPreview={handlePreview}
            onDownload={handleDownload}
            onDelete={handleDeleteClick}
          />
        ) : (
          <FileList
            files={mappedFiles}
            selectedIds={selectedIds}
            onSelectionChange={setSelectedIds}
            onPreview={handlePreview}
            onDownload={handleDownload}
            onDelete={handleDeleteClick}
          />
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
              Are you sure you want to delete "{fileToDelete?.file_name}"? This action cannot
              be undone.
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

      {/* Metadata edit sheet */}
      <FileMetadataSheet
        file={fileToEdit}
        open={metadataSheetOpen}
        onOpenChange={setMetadataSheetOpen}
        onSave={handleSaveMetadata}
      />
    </div>
  )
}
