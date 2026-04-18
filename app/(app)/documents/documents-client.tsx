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
  FolderInput,
  Plus,
  Loader2,
  CheckCircle2,
  AlertTriangle,
} from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Progress } from "@/components/ui/progress"
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { FileDropOverlay } from "@/components/files/file-drop-overlay"
import { FileViewer } from "@/components/files/file-viewer"
import { FileGrid } from "@/components/files/file-grid"
import { FileList } from "@/components/files/file-list"
import type { ViewMode } from "@/components/files/file-toolbar"
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
  getFileCountsAction,
  listFoldersAction,
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

interface UploadQueueItem {
  id: string
  fileName: string
  status: "queued" | "uploading" | "success" | "error"
  attempts: number
  error?: string
}

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

function normalizeFolderPath(value?: string | null): string {
  if (!value) return ""
  const trimmed = value.trim()
  if (!trimmed) return ""
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`
  return withLeadingSlash.replace(/\/+/g, "/").replace(/\/$/, "")
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
  const [selectedFolder, setSelectedFolder] = useState<string>("all")
  const [showArchived, setShowArchived] = useState(false)

  // View state
  const [viewMode, setViewMode] = useState<ViewMode>("grid")
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showImageOnly, setShowImageOnly] = useState(false)

  // Drag and drop state
  const [isDraggingOver, setIsDraggingOver] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [uploadFolderPath, setUploadFolderPath] = useState("")
  const [newFolderDialogOpen, setNewFolderDialogOpen] = useState(false)
  const [newFolderPath, setNewFolderPath] = useState("")
  const [uploadQueue, setUploadQueue] = useState<UploadQueueItem[]>([])
  const dragCounterRef = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Viewer state
  const [viewerOpen, setViewerOpen] = useState(false)
  const [viewerFile, setViewerFile] = useState<FileWithDetails | null>(null)
  const [versionsByFile, setVersionsByFile] = useState<Record<string, FileVersionInfo[]>>({})
  const lastViewerFileIdRef = useRef<string | null>(null)

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
  const [folders, setFolders] = useState<string[]>([])
  const [bulkMoveDialogOpen, setBulkMoveDialogOpen] = useState(false)
  const [bulkMoveTargetFolder, setBulkMoveTargetFolder] = useState("")
  const [isMovingFiles, setIsMovingFiles] = useState(false)

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

        setFiles((prev) => (append ? [...prev, ...filesData.data] : filesData.data))
        setHasMore(filesData.hasMore)
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

  const refreshFolders = useCallback(async () => {
    try {
      const folderList = await listFoldersAction(selectedProject)
      const normalized = folderList
        .map((folder) => normalizeFolderPath(folder))
        .filter(Boolean)
      setFolders(Array.from(new Set(normalized)).sort((a, b) => a.localeCompare(b)))
    } catch (error) {
      console.error("Failed to fetch folders:", error)
      setFolders([])
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

  const initialFoldersRef = useRef(true)
  useEffect(() => {
    if (initialFoldersRef.current) {
      initialFoldersRef.current = false
      void refreshFolders()
      return
    }

    void refreshFolders()
  }, [refreshFolders])

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

  useEffect(() => {
    setSelectedFolder("all")
    setSelectedIds(new Set())
  }, [selectedProject])

  // Map files to the UI component's expected format
  const mappedFiles = useMemo<FileWithDetails[]>(() => {
    let result = files.map((f) => ({
      ...f,
      category: f.category as FileCategory | undefined,
    }))

    if (selectedFolder === "unsorted") {
      result = result.filter((f) => !normalizeFolderPath(f.folder_path))
    } else if (selectedFolder !== "all") {
      result = result.filter((f) => {
        const folder = normalizeFolderPath(f.folder_path)
        if (!folder) return false
        return folder === selectedFolder || folder.startsWith(`${selectedFolder}/`)
      })
    }

    // Apply image-only filter locally
    if (showImageOnly) {
      result = result.filter((f) => isImageFile(f.mime_type))
    }

    return result
  }, [files, showImageOnly, selectedFolder])

  // Get previewable files for gallery navigation
  const previewableFiles = useMemo(
    () => mappedFiles.filter((f) => isPreviewable(f.mime_type)),
    [mappedFiles]
  )

  const folderOptions = useMemo(() => {
    const fromFiles = files
      .map((file) => normalizeFolderPath(file.folder_path))
      .filter(Boolean)
    return Array.from(new Set([...folders, ...fromFiles])).sort((a, b) => a.localeCompare(b))
  }, [files, folders])

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
      if (filesToUpload.length === 0) return
      setIsUploading(true)
      const created = filesToUpload.map((file) => ({
        id: `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        fileName: file.name,
        status: "queued" as const,
        attempts: 0,
      }))
      setUploadQueue((prev) => [...created, ...prev].slice(0, 30))

      let successCount = 0
      const failures: string[] = []

      try {
        for (const [index, file] of filesToUpload.entries()) {
          const queueId = created[index].id
          let uploaded = false
          let attempt = 0
          let lastError: unknown = null

          while (!uploaded && attempt < 3) {
            attempt += 1
            setUploadQueue((prev) =>
              prev.map((item) =>
                item.id === queueId
                  ? { ...item, status: "uploading", attempts: attempt, error: undefined }
                  : item
              )
            )

            try {
              const formData = new FormData()
              formData.append("file", file)
              if (selectedProject) {
                formData.append("projectId", selectedProject)
              }
              if (selectedCategory !== "all") {
                formData.append("category", selectedCategory)
              }
              if (uploadFolderPath) {
                formData.append("folderPath", uploadFolderPath)
              }

              await uploadFileAction(formData)
              uploaded = true
              successCount += 1
              setUploadQueue((prev) =>
                prev.map((item) =>
                  item.id === queueId ? { ...item, status: "success", attempts: attempt } : item
                )
              )
            } catch (error) {
              lastError = error
              if (attempt < 3) {
                await new Promise((resolve) => setTimeout(resolve, 300 * attempt))
              }
            }
          }

          if (!uploaded) {
            const message =
              lastError instanceof Error
                ? lastError.message
                : "Upload failed after retries"
            failures.push(file.name)
            setUploadQueue((prev) =>
              prev.map((item) =>
                item.id === queueId ? { ...item, status: "error", attempts: 3, error: message } : item
              )
            )
            console.error(`Upload failed for ${file.name}:`, lastError)
          }
        }

        if (successCount > 0) {
          toast.success(
            `${successCount} file${successCount > 1 ? "s" : ""} uploaded`
          )
        }
        if (failures.length > 0) {
          toast.error(
            `Failed to upload ${failures.length} file${failures.length > 1 ? "s" : ""}`
          )
        }
        await fetchFiles()
        await refreshCounts()
        await refreshFolders()
      } catch (error) {
        console.error("Upload failed:", error)
        toast.error("Failed to upload files")
      } finally {
        setIsUploading(false)
      }
    },
    [selectedProject, selectedCategory, uploadFolderPath, fetchFiles, refreshCounts, refreshFolders]
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

  const handleCreateFolder = useCallback(() => {
    const normalized = normalizeFolderPath(newFolderPath)
    if (!normalized) {
      toast.error("Enter a folder path")
      return
    }
    setFolders((prev) => Array.from(new Set([...prev, normalized])).sort((a, b) => a.localeCompare(b)))
    setUploadFolderPath(normalized)
    setSelectedFolder(normalized)
    setNewFolderPath("")
    setNewFolderDialogOpen(false)
    toast.success(`Created folder ${normalized}`)
  }, [newFolderPath])

  const handleBulkMove = useCallback(async () => {
    if (selectedIds.size === 0) return

    const target =
      bulkMoveTargetFolder.trim() === "" || bulkMoveTargetFolder === "unsorted"
        ? null
        : normalizeFolderPath(bulkMoveTargetFolder)

    setIsMovingFiles(true)
    try {
      await Promise.all(
        Array.from(selectedIds).map((fileId) =>
          updateFileAction(fileId, { folder_path: target })
        )
      )
      toast.success(`Moved ${selectedIds.size} file${selectedIds.size > 1 ? "s" : ""}`)
      setSelectedIds(new Set())
      setBulkMoveDialogOpen(false)
      setBulkMoveTargetFolder("")
      await fetchFiles()
      await refreshFolders()
    } catch (error) {
      console.error("Bulk move failed:", error)
      toast.error("Failed to move selected files")
    } finally {
      setIsMovingFiles(false)
    }
  }, [bulkMoveTargetFolder, selectedIds, fetchFiles, refreshFolders])

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

  useEffect(() => {
    if (!viewerOpen) {
      lastViewerFileIdRef.current = null
    }
  }, [viewerOpen])

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
      await refreshFolders()
    } catch (error) {
      console.error("Delete failed:", error)
      toast.error("Failed to delete file")
    } finally {
      setIsDeleting(false)
    }
  }, [fileToDelete, fetchFiles, refreshCounts, refreshFolders])

  const handleViewerFileChange = useCallback(
    (file: FileWithDetails) => {
      if (lastViewerFileIdRef.current === file.id) {
        return
      }
      lastViewerFileIdRef.current = file.id
      setViewerFile((prev) => (prev?.id === file.id ? prev : file))
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
        await refreshFolders()
      } catch (error) {
        console.error("Update failed:", error)
        toast.error("Failed to update file")
      }
    },
    [fetchFiles, refreshCounts, refreshFolders]
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

  const handleBulkDownload = useCallback(() => {
    const selectedFiles = mappedFiles.filter((f) => selectedIds.has(f.id))
    selectedFiles.forEach((f) => handleDownload(f))
  }, [mappedFiles, selectedIds, handleDownload])

  const handleBulkDelete = useCallback(async () => {
    toast.info(`Bulk delete ${selectedIds.size} files (not implemented)`)
  }, [selectedIds])

  const handleOpenBulkMove = useCallback(() => {
    if (selectedIds.size === 0) return
    setBulkMoveDialogOpen(true)
  }, [selectedIds])

  const handleClearSelection = useCallback(() => {
    setSelectedIds(new Set())
  }, [])

  const activeFilterCount =
    (selectedCategory !== "all" ? 1 : 0) +
    (selectedFolder !== "all" ? 1 : 0) +
    (showImageOnly ? 1 : 0) +
    (showArchived ? 1 : 0)

  return (
    <div
      className="flex flex-col h-full relative bg-background"
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

      {/* Top bar */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b bg-background/95 backdrop-blur-sm sticky top-0 z-10">
        <div className="flex items-center gap-2">
          {/* Search */}
          <div className="relative w-64">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search files..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-8 h-8 text-sm"
            />
            {searchQuery && (
              <Button
                variant="ghost"
                size="sm"
                className="absolute right-0.5 top-1/2 -translate-y-1/2 h-6 w-6 p-0"
                onClick={() => setSearchQuery("")}
              >
                <X className="h-3 w-3" />
              </Button>
            )}
          </div>

          {/* Project filter */}
          {!lockProject && (
            <Select
              value={selectedProject ?? "all"}
              onValueChange={(value) =>
                setSelectedProject(value === "all" ? undefined : value)
              }
            >
              <SelectTrigger className="w-[160px] h-8 text-sm">
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

          {/* Filters dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 text-sm">
                <SlidersHorizontal className="h-3.5 w-3.5 mr-1.5" />
                Filters
                {activeFilterCount > 0 && (
                  <Badge variant="secondary" className="ml-1.5 h-4 px-1 text-[10px] rounded-full">
                    {activeFilterCount}
                  </Badge>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuLabel>Category</DropdownMenuLabel>
              <DropdownMenuCheckboxItem
                checked={selectedCategory === "all"}
                onCheckedChange={() => setSelectedCategory("all")}
              >
                All categories
              </DropdownMenuCheckboxItem>
              {(Object.keys(FILE_CATEGORIES) as FileCategory[]).map((cat) => {
                const { label, icon } = FILE_CATEGORIES[cat]
                return (
                  <DropdownMenuCheckboxItem
                    key={cat}
                    checked={selectedCategory === cat}
                    onCheckedChange={() => setSelectedCategory(cat)}
                  >
                    <span className="mr-1.5">{icon}</span>
                    {label}
                    {(counts[cat] ?? 0) > 0 && (
                      <span className="ml-auto text-xs text-muted-foreground">{counts[cat]}</span>
                    )}
                  </DropdownMenuCheckboxItem>
                )
              })}
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Folder</DropdownMenuLabel>
              <DropdownMenuCheckboxItem
                checked={selectedFolder === "all"}
                onCheckedChange={() => setSelectedFolder("all")}
              >
                All folders
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={selectedFolder === "unsorted"}
                onCheckedChange={() => setSelectedFolder("unsorted")}
              >
                Unsorted
              </DropdownMenuCheckboxItem>
              {folderOptions.map((folder) => (
                <DropdownMenuCheckboxItem
                  key={folder}
                  checked={selectedFolder === folder}
                  onCheckedChange={() => setSelectedFolder(folder)}
                >
                  {folder}
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Options</DropdownMenuLabel>
              <DropdownMenuCheckboxItem
                checked={showImageOnly}
                onCheckedChange={(checked) => setShowImageOnly(checked === true)}
              >
                Images only
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={showArchived}
                onCheckedChange={(checked) => setShowArchived(checked === true)}
              >
                Show archived
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* View toggle */}
          <div className="flex items-center border rounded-md h-8">
            <Button
              variant={viewMode === "grid" ? "secondary" : "ghost"}
              size="sm"
              className="h-full px-2 rounded-r-none border-0"
              onClick={() => setViewMode("grid")}
            >
              <Grid3X3 className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant={viewMode === "list" ? "secondary" : "ghost"}
              size="sm"
              className="h-full px-2 rounded-l-none border-0"
              onClick={() => setViewMode("list")}
            >
              <List className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {/* Right side: file count + upload */}
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground tabular-nums">
            {mappedFiles.length} file{mappedFiles.length !== 1 ? "s" : ""}
          </span>
          <Button size="sm" className="h-8" onClick={() => fileInputRef.current?.click()} disabled={isUploading}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {isUploading ? "Uploading..." : "Upload"}
          </Button>
        </div>
      </div>

      {/* Bulk actions bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-2 px-4 py-2 border-b bg-muted/50">
          <span className="text-sm font-medium">{selectedIds.size} selected</span>
          <div className="flex items-center gap-1 ml-2">
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleBulkDownload}>
              Download
            </Button>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleOpenBulkMove}>
              Move
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs text-destructive hover:text-destructive"
              onClick={handleBulkDelete}
            >
              Delete
            </Button>
          </div>
          <Button variant="ghost" size="sm" className="h-7 text-xs ml-auto" onClick={handleClearSelection}>
            Clear
          </Button>
        </div>
      )}

      {/* Upload queue */}
      {uploadQueue.length > 0 && (
        <div className="border-b bg-muted/30 px-4 py-2">
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-xs font-medium">Uploading</p>
            <Button variant="ghost" size="sm" className="h-5 text-[10px] px-1.5" onClick={() => setUploadQueue([])}>
              Clear
            </Button>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {uploadQueue.slice(0, 10).map((item) => {
              const icon =
                item.status === "uploading" || item.status === "queued"
                  ? <Loader2 className="h-3 w-3 animate-spin text-muted-foreground shrink-0" />
                  : item.status === "success"
                    ? <CheckCircle2 className="h-3 w-3 text-emerald-600 shrink-0" />
                    : <AlertTriangle className="h-3 w-3 text-destructive shrink-0" />
              return (
                <div key={item.id} className="flex items-center gap-1.5 rounded bg-background px-2 py-1 border min-w-0">
                  {icon}
                  <span className="truncate text-[11px] max-w-[120px]">{item.fileName}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 min-h-0 overflow-auto">
        {isLoading && mappedFiles.length === 0 ? (
          <div className="p-4">
            {viewMode === "grid" ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 gap-3">
                {Array.from({ length: 12 }).map((_, index) => (
                  <div key={`file-skeleton-${index}`} className="rounded-lg border overflow-hidden">
                    <Skeleton className="aspect-square w-full animate-none skeleton-shimmer" />
                    <div className="p-2.5 space-y-1.5">
                      <Skeleton className="h-3.5 w-3/4 animate-none skeleton-shimmer" />
                      <Skeleton className="h-3 w-1/2 animate-none skeleton-shimmer" />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-0">
                {Array.from({ length: 8 }).map((_, index) => (
                  <div
                    key={`file-row-skeleton-${index}`}
                    className="flex items-center gap-3 px-4 py-3 border-b"
                  >
                    <Skeleton className="h-8 w-8 rounded animate-none skeleton-shimmer" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-3.5 w-2/5 animate-none skeleton-shimmer" />
                      <Skeleton className="h-3 w-1/4 animate-none skeleton-shimmer" />
                    </div>
                    <Skeleton className="h-6 w-16 animate-none skeleton-shimmer" />
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : mappedFiles.length === 0 ? (
          <div
            className={cn(
              "flex flex-col items-center justify-center h-full min-h-[400px] transition-colors cursor-pointer",
              isDraggingOver ? "bg-primary/5" : ""
            )}
            onClick={() => fileInputRef.current?.click()}
          >
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted mb-3">
              <FileText className="h-7 w-7 text-muted-foreground" />
            </div>
            <h3 className="font-semibold text-base">No files yet</h3>
            <p className="text-sm text-muted-foreground mt-1 text-center max-w-sm">
              {searchQuery || selectedCategory !== "all" || selectedFolder !== "all" || showImageOnly
                ? "No files match your filters. Try adjusting your search or filters."
                : "Drag and drop files here, or click to upload."}
            </p>
            {!searchQuery && selectedCategory === "all" && selectedFolder === "all" && (
              <Button className="mt-3" variant="outline" size="sm">
                <Upload className="mr-1.5 h-3.5 w-3.5" />
                Choose Files
              </Button>
            )}
          </div>
        ) : (
          <div className="p-4">
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
                  size="sm"
                  onClick={() => fetchFiles({ offset: files.length, append: true })}
                  disabled={isLoadingMore}
                >
                  {isLoadingMore ? "Loading..." : "Load more"}
                </Button>
              </div>
            )}
          </div>
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
              Are you sure you want to delete &ldquo;{fileToDelete?.file_name}&rdquo;? This action cannot
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

      <Dialog open={newFolderDialogOpen} onOpenChange={setNewFolderDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create folder path</DialogTitle>
            <DialogDescription>
              Folder paths are virtual and can include nested segments like <code>/drawings/addenda</code>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Input
              placeholder="/drawings/addenda"
              value={newFolderPath}
              onChange={(event) => setNewFolderPath(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewFolderDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateFolder}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkMoveDialogOpen} onOpenChange={setBulkMoveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move selected files</DialogTitle>
            <DialogDescription>
              Move {selectedIds.size} selected file{selectedIds.size === 1 ? "" : "s"} to a folder.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Select value={bulkMoveTargetFolder || "unsorted"} onValueChange={setBulkMoveTargetFolder}>
              <SelectTrigger>
                <SelectValue placeholder="Choose folder" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="unsorted">Unsorted (no folder)</SelectItem>
                {folderOptions.map((folder) => (
                  <SelectItem key={`move-${folder}`} value={folder}>
                    {folder}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              placeholder="or type new folder path"
              value={bulkMoveTargetFolder === "unsorted" ? "" : bulkMoveTargetFolder}
              onChange={(event) => setBulkMoveTargetFolder(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkMoveDialogOpen(false)} disabled={isMovingFiles}>
              Cancel
            </Button>
            <Button onClick={handleBulkMove} disabled={isMovingFiles}>
              {isMovingFiles ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Moving...
                </>
              ) : (
                <>
                  <FolderInput className="mr-2 h-4 w-4" />
                  Move files
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
