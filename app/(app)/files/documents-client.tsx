"use client"

import { useState, useEffect, useCallback, useRef, useMemo } from "react"
import { useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import {
  Upload,
  FileText,
  Search,
  X,
  SlidersHorizontal,
  Grid3X3,
  List,
} from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
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
  getFileAction,
  logFileAccessAction,
  updateFileAction,
  archiveFileAction,
  getFileCountsAction,
  listProjectsForFilterAction,
  listFileVersionsAction,
  uploadFileVersionAction,
  makeVersionCurrentAction,
  updateFileVersionAction,
  deleteFileVersionAction,
  getVersionDownloadUrlAction,
  listFileAccessEventsAction,
  listFileLinkSummaryAction,
} from "./actions"
import type { FileWithUrls, FileUpdate, FileVersion, FileAccessEvent } from "./actions"
import { FileMetadataSheet } from "./file-metadata-sheet"
import type { FileVersionInfo } from "@/components/files/version-history-panel"
import { FileActivitySheet } from "./file-activity-sheet"

function mapVersion(version: FileVersion): FileVersionInfo {
  return {
    id: version.id,
    version_number: version.version_number,
    label: version.label ?? undefined,
    notes: version.notes ?? undefined,
    file_name: version.file_name ?? undefined,
    mime_type: version.mime_type ?? undefined,
    size_bytes: version.size_bytes ?? undefined,
    creator_name: version.creator_name ?? undefined,
    created_at: version.created_at,
    is_current: version.is_current,
  }
}

interface DocumentsCenterClientProps {
  initialFiles: FileWithUrls[]
  initialCounts: Record<string, number>
  initialProjects: Array<{ id: string; name: string }>
  defaultProjectId?: string
  lockProject?: boolean
}

export function DocumentsCenterClient({
  initialFiles,
  initialCounts,
  initialProjects,
  defaultProjectId,
  lockProject = false,
}: DocumentsCenterClientProps) {
  const pageSize = 60

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
  const [versionsByFile, setVersionsByFile] = useState<Record<string, FileVersionInfo[]>>({})

  // Delete confirmation
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [fileToDelete, setFileToDelete] = useState<FileWithUrls | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  // Metadata edit
  const [metadataSheetOpen, setMetadataSheetOpen] = useState(false)
  const [fileToEdit, setFileToEdit] = useState<FileWithUrls | null>(null)
  const [activitySheetOpen, setActivitySheetOpen] = useState(false)
  const [fileToReview, setFileToReview] = useState<FileWithUrls | null>(null)
  const [activityEvents, setActivityEvents] = useState<FileAccessEvent[]>([])
  const [activityLoading, setActivityLoading] = useState(false)
  const [attachmentSummary, setAttachmentSummary] = useState<Record<string, { total: number; types: Record<string, number> }>>({})

  // Loading state
  const [isLoading, setIsLoading] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(initialFiles.length >= pageSize)

  // Fetch files when filters change
  const fetchFiles = useCallback(
    async ({ offset = 0, append = false }: { offset?: number; append?: boolean } = {}) => {
      if (append) {
        setIsLoadingMore(true)
      } else {
        setIsLoading(true)
      }
      try {
        const filesData = await listFilesAction({
          project_id: selectedProject,
          category: selectedCategory === "all" ? undefined : selectedCategory,
          search: searchQuery || undefined,
          include_archived: showArchived,
          limit: pageSize,
          offset,
        })

        setFiles((prev) => (append ? [...prev, ...filesData] : filesData))
        setHasMore(filesData.length === pageSize)
      } catch (error) {
        console.error("Failed to fetch files:", error)
        toast.error("Failed to load files")
      } finally {
        setIsLoading(false)
        setIsLoadingMore(false)
      }
    },
    [selectedProject, selectedCategory, searchQuery, showArchived, pageSize]
  )

  const refreshCounts = useCallback(async () => {
    try {
      const countsData = await getFileCountsAction(selectedProject)
      setCounts(countsData)
    } catch (error) {
      console.error("Failed to fetch file counts:", error)
    }
  }, [selectedProject])

  const fetchVersions = useCallback(async (fileId: string) => {
    try {
      const versions = await listFileVersionsAction(fileId)
      setVersionsByFile((prev) => ({ ...prev, [fileId]: versions.map(mapVersion) }))
    } catch (error) {
      console.error("Failed to load versions", error)
      setVersionsByFile((prev) => ({ ...prev, [fileId]: [] }))
    }
  }, [])

  // Debounce search
  const initialFetchRef = useRef(true)
  useEffect(() => {
    if (initialFetchRef.current) {
      initialFetchRef.current = false
      return
    }

    const timeout = setTimeout(() => {
      fetchFiles()
    }, 300)

    return () => clearTimeout(timeout)
  }, [fetchFiles])

  const initialCountsRef = useRef(true)
  useEffect(() => {
    if (initialCountsRef.current) {
      initialCountsRef.current = false
      return
    }

    refreshCounts()
  }, [refreshCounts])

  useEffect(() => {
    if (files.length === 0) {
      setAttachmentSummary({})
      return
    }
    const missingIds = files.map((file) => file.id).filter((id) => !attachmentSummary[id])
    if (missingIds.length === 0) {
      return
    }
    listFileLinkSummaryAction(missingIds)
      .then((rows) => {
        const summary: Record<string, { total: number; types: Record<string, number> }> = {}
        for (const row of rows) {
          if (!summary[row.file_id]) {
            summary[row.file_id] = { total: 0, types: {} }
          }
          summary[row.file_id].total += row.count
          summary[row.file_id].types[row.entity_type] =
            (summary[row.file_id].types[row.entity_type] ?? 0) + row.count
        }
        setAttachmentSummary((prev) => ({ ...prev, ...summary }))
      })
      .catch((error) => {
        console.error("Failed to load file link summary", error)
      })
  }, [files, attachmentSummary])

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

  const searchParams = useSearchParams()
  const requestedFileId = searchParams.get("fileId")

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
        await fetchFiles()
        await refreshCounts()
      } catch (error) {
        console.error("Upload failed:", error)
        toast.error("Failed to upload files")
      } finally {
        setIsUploading(false)
      }
    },
    [selectedProject, selectedCategory, fetchFiles, refreshCounts]
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

  const ensureDownloadUrl = useCallback(async (file: FileWithDetails) => {
    if (file.download_url) return file
    try {
      const url = await getFileDownloadUrlAction(file.id)
      const updated: FileWithDetails = {
        ...file,
        download_url: url,
        thumbnail_url: file.thumbnail_url ?? (isImageFile(file.mime_type) ? url : undefined),
      }
      setViewerFile((prev) => (prev?.id === file.id ? updated : prev))
      setFiles((prev) => prev.map((f) => (f.id === file.id ? { ...f, ...updated } : f)))
      return updated
    } catch (error) {
      console.error("Failed to load preview URL", error)
      return file
    }
  }, [])

  const handlePreview = useCallback(
    (file: FileWithDetails) => {
      setViewerFile(file)
      setViewerOpen(true)
      fetchVersions(file.id)
      void ensureDownloadUrl(file)
    },
    [fetchVersions, ensureDownloadUrl]
  )

  useEffect(() => {
    if (!requestedFileId) return
    const existing = mappedFiles.find((file) => file.id === requestedFileId)
    if (existing) {
      handlePreview(existing)
      return
    }

    getFileAction(requestedFileId)
      .then(async (file) => {
        if (!file) return
        const downloadUrl = await getFileDownloadUrlAction(file.id)
        const fileWithUrls: FileWithDetails = {
          ...file,
          category: file.category as FileCategory | undefined,
          download_url: downloadUrl,
          thumbnail_url: file.mime_type?.startsWith("image/") ? downloadUrl : undefined,
        }
        setViewerFile(fileWithUrls)
        setViewerOpen(true)
        fetchVersions(file.id)
      })
      .catch((error) => console.error("Failed to open file from query", error))
  }, [requestedFileId, mappedFiles, handlePreview, fetchVersions])

  const handleDownload = useCallback(async (file: FileWithDetails) => {
    try {
      const url = await getFileDownloadUrlAction(file.id)
      logFileAccessAction(file.id, "download").catch((error) => {
        console.error("Failed to log download", error)
      })
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
      await fetchFiles()
      await refreshCounts()
    } catch (error) {
      console.error("Delete failed:", error)
      toast.error("Failed to delete file")
    } finally {
      setIsDeleting(false)
    }
  }, [fileToDelete, fetchFiles, refreshCounts])

  const handleViewerFileChange = useCallback(
    (file: FileWithDetails) => {
      setViewerFile(file)
      fetchVersions(file.id)
      void ensureDownloadUrl(file)
      logFileAccessAction(file.id, "view").catch((error) => {
        console.error("Failed to log view", error)
      })
    },
    [fetchVersions, ensureDownloadUrl]
  )

  const handleRefreshVersions = useCallback(async () => {
    if (!viewerFile) return
    await fetchVersions(viewerFile.id)
    await fetchFiles()
  }, [viewerFile, fetchFiles, fetchVersions])

  const handleUploadVersion = useCallback(
    async (file: File, label?: string, notes?: string) => {
      if (!viewerFile) return
      const formData = new FormData()
      formData.append("fileId", viewerFile.id)
      formData.append("file", file)
      if (label) formData.append("label", label)
      if (notes) formData.append("notes", notes)
      await uploadFileVersionAction(formData)
      await fetchVersions(viewerFile.id)
      await fetchFiles()
    },
    [viewerFile, fetchFiles, fetchVersions]
  )

  const handleMakeCurrentVersion = useCallback(
    async (versionId: string) => {
      if (!viewerFile) return
      await makeVersionCurrentAction(viewerFile.id, versionId)
      await fetchVersions(viewerFile.id)
      await fetchFiles()
    },
    [viewerFile, fetchFiles, fetchVersions]
  )

  const handleDownloadVersion = useCallback(async (versionId: string) => {
    const url = await getVersionDownloadUrlAction(versionId)
    const link = document.createElement("a")
    link.href = url
    link.click()
  }, [])

  const handleUpdateVersion = useCallback(
    async (versionId: string, updates: { label?: string; notes?: string }) => {
      await updateFileVersionAction(versionId, updates)
      if (viewerFile) {
        await fetchVersions(viewerFile.id)
      }
    },
    [viewerFile, fetchVersions]
  )

  const handleDeleteVersion = useCallback(
    async (versionId: string) => {
      await deleteFileVersionAction(versionId)
      if (viewerFile) {
        await fetchVersions(viewerFile.id)
        await fetchFiles()
      }
    },
    [viewerFile, fetchFiles, fetchVersions]
  )

  const handleEditMetadata = useCallback((file: FileWithDetails) => {
    setFileToEdit(file as FileWithUrls)
    setMetadataSheetOpen(true)
  }, [])

  const handleViewActivity = useCallback((file: FileWithDetails) => {
    setFileToReview(file as FileWithUrls)
    setActivitySheetOpen(true)
  }, [])

  const handleSaveMetadata = useCallback(
    async (fileId: string, updates: FileUpdate) => {
      try {
        await updateFileAction(fileId, updates)
        toast.success("File updated")
        setMetadataSheetOpen(false)
        setFileToEdit(null)
        await fetchFiles()
        await refreshCounts()
      } catch (error) {
        console.error("Update failed:", error)
        toast.error("Failed to update file")
      }
    },
    [fetchFiles, refreshCounts]
  )

  useEffect(() => {
    if (!activitySheetOpen || !fileToReview) return
    setActivityLoading(true)
    listFileAccessEventsAction(fileToReview.id)
      .then((events) => setActivityEvents(events))
      .catch((error) => {
        console.error("Failed to load file activity", error)
        setActivityEvents([])
      })
      .finally(() => setActivityLoading(false))
  }, [activitySheetOpen, fileToReview])

  const handleArchive = useCallback(
    async (file: FileWithDetails) => {
      try {
        await archiveFileAction(file.id)
        toast.success(`Archived ${file.file_name}`)
        await fetchFiles()
        await refreshCounts()
      } catch (error) {
        console.error("Archive failed:", error)
        toast.error("Failed to archive file")
      }
    },
    [fetchFiles, refreshCounts]
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
          <div className="flex items-center gap-2 flex-1 flex-wrap">
            {!lockProject && (
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
            )}

            <div className="relative flex-1 max-w-md min-w-[220px]">
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

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-9">
                  <SlidersHorizontal className="h-4 w-4 sm:mr-2" />
                  <span className="hidden sm:inline">Filters</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuLabel>Filter by type</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem
                  checked={showImageOnly}
                  onCheckedChange={(checked) => setShowImageOnly(checked === true)}
                >
                  Images only
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem>PDFs only</DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem>Documents only</DropdownMenuCheckboxItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Date range</DropdownMenuLabel>
                <DropdownMenuItem>Last 7 days</DropdownMenuItem>
                <DropdownMenuItem>Last 30 days</DropdownMenuItem>
                <DropdownMenuItem>Last 90 days</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="flex items-center border rounded-md">
              <Button
                variant={viewMode === "grid" ? "secondary" : "ghost"}
                size="sm"
                className="h-9 px-3 rounded-r-none"
                onClick={() => setViewMode("grid")}
              >
                <Grid3X3 className="h-4 w-4" />
              </Button>
              <Button
                variant={viewMode === "list" ? "secondary" : "ghost"}
                size="sm"
                className="h-9 px-3 rounded-l-none"
                onClick={() => setViewMode("list")}
              >
                <List className="h-4 w-4" />
              </Button>
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
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          selectedCount={selectedIds.size}
          onBulkDownload={handleBulkDownload}
          onBulkDelete={handleBulkDelete}
          onClearSelection={handleClearSelection}
          showImageOnly={showImageOnly}
          onShowImageOnlyChange={setShowImageOnly}
          showSearch={false}
          showFilters={false}
          showViewToggle={false}
        />
      </div>

      {/* Main content */}
      <div className="flex-1 min-h-0">
        {isLoading && mappedFiles.length === 0 ? (
          <div className="space-y-4">
            {viewMode === "grid" ? (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {Array.from({ length: 8 }).map((_, index) => (
                  <div key={`file-skeleton-${index}`} className="rounded-lg border p-3 space-y-3">
                    <Skeleton className="h-32 w-full animate-none skeleton-shimmer" />
                    <Skeleton className="h-4 w-3/4 animate-none skeleton-shimmer" />
                    <Skeleton className="h-3 w-1/2 animate-none skeleton-shimmer" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-2">
                {Array.from({ length: 8 }).map((_, index) => (
                  <div
                    key={`file-row-skeleton-${index}`}
                    className="flex items-center gap-3 rounded-lg border p-3"
                  >
                    <Skeleton className="h-10 w-10 rounded-md animate-none skeleton-shimmer" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-4 w-2/3 animate-none skeleton-shimmer" />
                      <Skeleton className="h-3 w-1/3 animate-none skeleton-shimmer" />
                    </div>
                    <Skeleton className="h-8 w-20 animate-none skeleton-shimmer" />
                  </div>
                ))}
              </div>
            )}
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
        ) : (
          <>
            {viewMode === "grid" ? (
              <FileGrid
                files={mappedFiles}
                selectedIds={selectedIds}
                onSelectionChange={setSelectedIds}
                onPreview={handlePreview}
                onDownload={handleDownload}
                onDelete={handleDeleteClick}
                onEdit={handleEditMetadata}
                onViewActivity={handleViewActivity}
                attachmentSummary={attachmentSummary}
              />
            ) : (
              <FileList
                files={mappedFiles}
                selectedIds={selectedIds}
                onSelectionChange={setSelectedIds}
                onPreview={handlePreview}
                onDownload={handleDownload}
                onDelete={handleDeleteClick}
                onEdit={handleEditMetadata}
                onViewActivity={handleViewActivity}
                attachmentSummary={attachmentSummary}
              />
            )}

            {hasMore && (
              <div className="flex justify-center py-6">
                <Button
                  variant="outline"
                  onClick={() => fetchFiles({ offset: files.length, append: true })}
                  disabled={isLoadingMore}
                >
                  {isLoadingMore ? "Loading..." : "Load more"}
                </Button>
              </div>
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
        versions={viewerFile ? versionsByFile[viewerFile.id] ?? [] : []}
        onUploadVersion={handleUploadVersion}
        onMakeCurrentVersion={handleMakeCurrentVersion}
        onDownloadVersion={handleDownloadVersion}
        onUpdateVersion={handleUpdateVersion}
        onDeleteVersion={handleDeleteVersion}
        onRefreshVersions={handleRefreshVersions}
        onFileChange={handleViewerFileChange}
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

      <FileActivitySheet
        file={fileToReview}
        events={activityEvents}
        loading={activityLoading}
        open={activitySheetOpen}
        onOpenChange={(open) => {
          setActivitySheetOpen(open)
          if (!open) {
            setFileToReview(null)
            setActivityEvents([])
          }
        }}
      />
    </div>
  )
}
