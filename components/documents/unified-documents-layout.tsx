"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { FileDropOverlay } from "@/components/files/file-drop-overlay"
import { FileViewer } from "@/components/files/file-viewer"
import { DrawingViewer } from "@/components/drawings/drawing-viewer"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
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
import { DocumentsProvider, useDocuments } from "./documents-context"
import { DocumentsHeader } from "./documents-header"
import { DocumentsContent } from "./documents-content"
import { DrawingSetsContent, DrawingSetsSection } from "./drawing-sets-content"
import { FileTimelineSheet } from "./file-timeline-sheet"
import { UploadDialog } from "./upload-dialog"
import type { UnifiedDocumentsLayoutProps } from "./types"
import type { FileWithDetails } from "@/components/files/types"
import {
  getFileDownloadUrlAction,
  listFileVersionsAction,
  uploadFileVersionAction,
  makeVersionCurrentAction,
  updateFileVersionAction,
  deleteFileVersionAction,
  getVersionDownloadUrlAction,
  updateFileAction,
  createFolderAction,
  bulkMoveFilesAction,
  bulkDeleteFilesAction,
  getFolderPermissionsAction,
  updateFolderPermissionsAction,
  listFileTimelineAction,
} from "@/app/(app)/files/actions"
import type { FileVersion, FileWithUrls, FileTimelineEvent } from "@/app/(app)/files/actions"
import { getSheetDownloadUrlAction } from "@/app/(app)/drawings/actions"
import type { DrawingSheet } from "@/app/(app)/drawings/actions"

interface FileVersionInfo {
  id: string
  version_number: number
  label?: string
  notes?: string
  file_name?: string
  mime_type?: string
  size_bytes?: number
  creator_name?: string
  created_at: string
  is_current: boolean
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

function normalizeFolderPath(path: string): string | null {
  const trimmed = path.trim()
  if (!trimmed) return null
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`
  const normalized = withLeadingSlash.replace(/\/+/g, "/")
  if (normalized === "/") return null
  return normalized.replace(/\/$/, "")
}

export function UnifiedDocumentsLayout(props: UnifiedDocumentsLayoutProps) {
  return (
    <DocumentsProvider {...props}>
      <UnifiedDocumentsLayoutInner />
    </DocumentsProvider>
  )
}

function UnifiedDocumentsLayoutInner() {
  const {
    projectId,
    files,
    folders,
    quickFilter,
    currentPath,
    setCurrentPath,
    refreshFiles,
  } = useDocuments()

  const [isDraggingOver, setIsDraggingOver] = useState(false)
  const dragCounterRef = useRef(0)

  const [uploadDialogOpen, setUploadDialogOpen] = useState(false)
  const [uploadFiles, setUploadFiles] = useState<File[]>([])

  const [viewerOpen, setViewerOpen] = useState(false)
  const [viewerFile, setViewerFile] = useState<FileWithDetails | null>(null)
  const [versionsByFile, setVersionsByFile] = useState<Record<string, FileVersionInfo[]>>({})
  const lastNotifiedViewerFileIdRef = useRef<string | null>(null)

  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set())
  const [isDownloadingSelected, setIsDownloadingSelected] = useState(false)
  const [draggedFileId, setDraggedFileId] = useState<string | null>(null)
  const [isDraggingDocumentFile, setIsDraggingDocumentFile] = useState(false)

  const [createFolderDialogOpen, setCreateFolderDialogOpen] = useState(false)
  const [newFolderPath, setNewFolderPath] = useState("")
  const [isCreatingFolder, setIsCreatingFolder] = useState(false)

  const [folderAccessDialogOpen, setFolderAccessDialogOpen] = useState(false)
  const [folderShareWithClients, setFolderShareWithClients] = useState(false)
  const [folderShareWithSubs, setFolderShareWithSubs] = useState(false)
  const [applyFolderAccessToExisting, setApplyFolderAccessToExisting] = useState(false)
  const [isSavingFolderAccess, setIsSavingFolderAccess] = useState(false)

  const [renameDialogOpen, setRenameDialogOpen] = useState(false)
  const [renameFile, setRenameFile] = useState<FileWithUrls | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [isRenaming, setIsRenaming] = useState(false)

  const [moveDialogOpen, setMoveDialogOpen] = useState(false)
  const [moveTargetFolder, setMoveTargetFolder] = useState("")
  const [moveFileIds, setMoveFileIds] = useState<string[]>([])
  const [isMoving, setIsMoving] = useState(false)

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deleteFileIds, setDeleteFileIds] = useState<string[]>([])
  const [isDeleting, setIsDeleting] = useState(false)

  const [timelineOpen, setTimelineOpen] = useState(false)
  const [timelineFile, setTimelineFile] = useState<FileWithUrls | null>(null)
  const [timelineEvents, setTimelineEvents] = useState<FileTimelineEvent[]>([])
  const [timelineLoading, setTimelineLoading] = useState(false)

  const [drawingViewerOpen, setDrawingViewerOpen] = useState(false)
  const [drawingViewerSheet, setDrawingViewerSheet] = useState<DrawingSheet | null>(null)
  const [drawingViewerUrl, setDrawingViewerUrl] = useState<string | null>(null)
  const drawingViewerRequestIdRef = useRef(0)

  useEffect(() => {
    setSelectedFileIds(new Set())
  }, [quickFilter, currentPath])

  useEffect(() => {
    if (!viewerOpen) {
      lastNotifiedViewerFileIdRef.current = null
    }
  }, [viewerOpen])

  const folderOptions = useMemo(() => {
    const allFolderPaths = new Set<string>(folders)
    for (const file of files) {
      if (file.folder_path) {
        const normalized = normalizeFolderPath(file.folder_path)
        if (normalized) {
          allFolderPaths.add(normalized)
        }
      }
    }
    return Array.from(allFolderPaths).sort((a, b) => a.localeCompare(b))
  }, [files, folders])

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current += 1
    const hasInternalFileDrag = e.dataTransfer.types.includes("application/x-arc-file-id")
    if (!hasInternalFileDrag && e.dataTransfer.items?.length) {
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

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDraggingOver(false)
    dragCounterRef.current = 0

    const droppedFiles = Array.from(e.dataTransfer.files)
    if (droppedFiles.length > 0) {
      setUploadFiles(droppedFiles)
      setUploadDialogOpen(true)
    }
  }, [])

  const handleFileClick = useCallback(
    async (fileId: string) => {
      const file = files.find((f) => f.id === fileId)
      if (!file) return

      const initialDownloadUrl = file.download_url ?? undefined
      const initialFile: FileWithDetails = {
        ...file,
        category: file.category as any,
        download_url: initialDownloadUrl,
        thumbnail_url:
          file.thumbnail_url ??
          (file.mime_type?.startsWith("image/") ? initialDownloadUrl : undefined),
      }

      setViewerFile(initialFile)
      setViewerOpen(true)

      try {
        if (!initialDownloadUrl) {
          const downloadUrl = await getFileDownloadUrlAction(fileId)
          setViewerFile((prev) => {
            if (!prev || prev.id !== fileId) return prev
            return {
              ...prev,
              download_url: downloadUrl,
              thumbnail_url:
                prev.thumbnail_url ??
                (prev.mime_type?.startsWith("image/") ? downloadUrl : undefined),
            }
          })
        }

        const versions = await listFileVersionsAction(fileId)
        setVersionsByFile((prev) => ({
          ...prev,
          [fileId]: versions.map(mapVersion),
        }))
      } catch (error) {
        console.error("Failed to open file:", error)
        toast.error("Failed to open file")
      }
    },
    [files]
  )

  const handleFolderClick = useCallback(
    (path: string) => {
      setCurrentPath(path)
    },
    [setCurrentPath]
  )

  const handleUploadClick = useCallback(() => {
    setUploadFiles([])
    setUploadDialogOpen(true)
  }, [])

  const handleFileSelectionChange = useCallback((fileId: string, selected: boolean) => {
    setSelectedFileIds((prev) => {
      const next = new Set(prev)
      if (selected) {
        next.add(fileId)
      } else {
        next.delete(fileId)
      }
      return next
    })
  }, [])

  const handleSelectAllVisibleFiles = useCallback((fileIds: string[], selected: boolean) => {
    setSelectedFileIds((prev) => {
      const next = new Set(prev)
      for (const id of fileIds) {
        if (selected) {
          next.add(id)
        } else {
          next.delete(id)
        }
      }
      return next
    })
  }, [])

  const openRenameDialog = useCallback(
    (fileId: string) => {
      const file = files.find((item) => item.id === fileId)
      if (!file) return
      setRenameFile(file)
      setRenameValue(file.file_name)
      setRenameDialogOpen(true)
    },
    [files]
  )

  const openMoveDialog = useCallback(
    (fileId?: string) => {
      if (fileId) {
        setMoveFileIds([fileId])
      } else {
        setMoveFileIds(Array.from(selectedFileIds))
      }
      setMoveTargetFolder(currentPath || "")
      setMoveDialogOpen(true)
    },
    [selectedFileIds, currentPath]
  )

  const openDeleteDialog = useCallback(
    (fileId?: string) => {
      if (fileId) {
        setDeleteFileIds([fileId])
      } else {
        setDeleteFileIds(Array.from(selectedFileIds))
      }
      setDeleteDialogOpen(true)
    },
    [selectedFileIds]
  )

  const resolveDraggedFileIds = useCallback(
    (primaryFileId?: string): string[] => {
      const fileId = primaryFileId ?? draggedFileId
      if (!fileId) return []
      if (selectedFileIds.has(fileId)) {
        return Array.from(selectedFileIds)
      }
      return [fileId]
    },
    [draggedFileId, selectedFileIds]
  )

  const handleFileDragStart = useCallback(
    (fileId: string, event: React.DragEvent<HTMLDivElement>) => {
      setDraggedFileId(fileId)
      setIsDraggingDocumentFile(true)
      event.dataTransfer.effectAllowed = "move"
      event.dataTransfer.setData("application/x-arc-file-id", fileId)
    },
    []
  )

  const handleFileDragEnd = useCallback(() => {
    setIsDraggingDocumentFile(false)
    setDraggedFileId(null)
  }, [])

  const moveFilesToFolder = useCallback(
    async (fileIds: string[], targetPath: string | null, sourceLabel: string) => {
      if (fileIds.length === 0) return
      const normalizedTarget = targetPath ? normalizeFolderPath(targetPath) : null

      setIsMoving(true)
      try {
        if (normalizedTarget) {
          await createFolderAction(projectId, normalizedTarget)
        }
        await bulkMoveFilesAction(fileIds, normalizedTarget, true)
        toast.success(
          `Moved ${fileIds.length} file${fileIds.length === 1 ? "" : "s"} to ${sourceLabel}`
        )
        setSelectedFileIds(new Set())
        await refreshFiles()
      } catch (error) {
        console.error("Failed to move files:", error)
        toast.error("Failed to move files")
      } finally {
        setIsMoving(false)
      }
    },
    [projectId, refreshFiles]
  )

  const handleDropOnFolder = useCallback(
    async (targetPath: string) => {
      const fileIds = resolveDraggedFileIds()
      await moveFilesToFolder(fileIds, targetPath, targetPath)
      setIsDraggingDocumentFile(false)
      setDraggedFileId(null)
    },
    [resolveDraggedFileIds, moveFilesToFolder]
  )

  const handleDropToRoot = useCallback(async () => {
    const fileIds = resolveDraggedFileIds()
    await moveFilesToFolder(fileIds, null, "Root")
    setIsDraggingDocumentFile(false)
    setDraggedFileId(null)
  }, [resolveDraggedFileIds, moveFilesToFolder])

  const openTimeline = useCallback(
    async (fileId: string) => {
      const file = files.find((item) => item.id === fileId)
      if (!file) return
      setTimelineFile(file)
      setTimelineOpen(true)
      setTimelineLoading(true)
      try {
        const events = await listFileTimelineAction(fileId)
        setTimelineEvents(events)
      } catch (error) {
        console.error("Failed to load timeline:", error)
        toast.error("Failed to load timeline")
        setTimelineEvents([])
      } finally {
        setTimelineLoading(false)
      }
    },
    [files]
  )

  const handleSheetClick = useCallback(async (sheet: DrawingSheet) => {
    const requestId = drawingViewerRequestIdRef.current + 1
    drawingViewerRequestIdRef.current = requestId
    setDrawingViewerSheet(sheet)
    setDrawingViewerUrl(null)
    setDrawingViewerOpen(true)

    const hasTiles = Boolean((sheet as any).tile_base_url && (sheet as any).tile_manifest)
    const hasOptimizedImages = Boolean(
      sheet.image_thumbnail_url && sheet.image_medium_url && sheet.image_full_url
    )
    if (hasTiles || hasOptimizedImages) {
      return
    }

    try {
      const url = await getSheetDownloadUrlAction(sheet.id)
      if (drawingViewerRequestIdRef.current !== requestId) return
      if (!url) {
        toast.error("Sheet file not available")
        return
      }
      setDrawingViewerUrl(url)
    } catch (error) {
      console.error("Failed to open sheet:", error)
      toast.error("Failed to open sheet")
    }
  }, [])

  const handleCreateFolder = useCallback(async () => {
    const normalized = normalizeFolderPath(newFolderPath)
    if (!normalized) {
      toast.error("Enter a folder path like /contracts")
      return
    }

    setIsCreatingFolder(true)
    try {
      await createFolderAction(projectId, normalized)
      toast.success(`Created folder ${normalized}`)
      setCreateFolderDialogOpen(false)
      setNewFolderPath("")
      await refreshFiles()
    } catch (error) {
      console.error("Failed to create folder:", error)
      toast.error(error instanceof Error ? error.message : "Failed to create folder")
    } finally {
      setIsCreatingFolder(false)
    }
  }, [newFolderPath, projectId, refreshFiles])

  const openFolderAccessDialog = useCallback(async () => {
    if (!currentPath) return
    setFolderAccessDialogOpen(true)
    try {
      const permissions = await getFolderPermissionsAction(projectId, currentPath)
      setFolderShareWithClients(permissions.share_with_clients)
      setFolderShareWithSubs(permissions.share_with_subs)
      setApplyFolderAccessToExisting(false)
    } catch (error) {
      console.error("Failed to load folder permissions:", error)
      toast.error("Failed to load folder access settings")
    }
  }, [projectId, currentPath])

  const saveFolderAccess = useCallback(async () => {
    if (!currentPath) return
    setIsSavingFolderAccess(true)
    try {
      const result = await updateFolderPermissionsAction(
        projectId,
        currentPath,
        {
          share_with_clients: folderShareWithClients,
          share_with_subs: folderShareWithSubs,
        },
        applyFolderAccessToExisting
      )
      const suffix =
        applyFolderAccessToExisting && result.affectedFiles > 0
          ? ` (${result.affectedFiles} files updated)`
          : ""
      toast.success(`Folder access saved${suffix}`)
      setFolderAccessDialogOpen(false)
      await refreshFiles()
    } catch (error) {
      console.error("Failed to save folder access:", error)
      toast.error(error instanceof Error ? error.message : "Failed to save folder access")
    } finally {
      setIsSavingFolderAccess(false)
    }
  }, [
    projectId,
    currentPath,
    folderShareWithClients,
    folderShareWithSubs,
    applyFolderAccessToExisting,
    refreshFiles,
  ])

  const handleRenameConfirm = useCallback(async () => {
    if (!renameFile) return
    const nextName = renameValue.trim()
    if (!nextName) {
      toast.error("File name is required")
      return
    }

    setIsRenaming(true)
    try {
      await updateFileAction(renameFile.id, { file_name: nextName })
      toast.success("File renamed")
      setRenameDialogOpen(false)
      setRenameFile(null)
      await refreshFiles()
    } catch (error) {
      console.error("Failed to rename file:", error)
      toast.error("Failed to rename file")
    } finally {
      setIsRenaming(false)
    }
  }, [renameFile, renameValue, refreshFiles])

  const handleMoveConfirm = useCallback(async () => {
    if (moveFileIds.length === 0) return

    const normalizedTarget = normalizeFolderPath(moveTargetFolder)
    await moveFilesToFolder(
      moveFileIds,
      normalizedTarget,
      normalizedTarget ?? "Root"
    )
    setMoveDialogOpen(false)
    setMoveFileIds([])
    setMoveTargetFolder("")
  }, [moveFileIds, moveTargetFolder, moveFilesToFolder])

  const handleDeleteConfirm = useCallback(async () => {
    if (deleteFileIds.length === 0) return

    setIsDeleting(true)
    try {
      await bulkDeleteFilesAction(deleteFileIds)
      toast.success(`Deleted ${deleteFileIds.length} file${deleteFileIds.length === 1 ? "" : "s"}`)
      setDeleteDialogOpen(false)
      setDeleteFileIds([])
      setSelectedFileIds(new Set())
      await refreshFiles()
    } catch (error) {
      console.error("Failed to delete files:", error)
      toast.error("Failed to delete files")
    } finally {
      setIsDeleting(false)
    }
  }, [deleteFileIds, refreshFiles])

  const handleDownloadSelected = useCallback(async () => {
    const ids = Array.from(selectedFileIds)
    if (ids.length === 0) return

    const selectedFiles = files.filter((file) => selectedFileIds.has(file.id))
    if (selectedFiles.length === 0) {
      toast.error("No selected files available for download")
      return
    }

    setIsDownloadingSelected(true)
    try {
      const downloads = await Promise.all(
        selectedFiles.map(async (file) => {
          try {
            const url = await getFileDownloadUrlAction(file.id)
            return { fileName: file.file_name, url }
          } catch {
            return null
          }
        })
      )

      let successCount = 0
      for (const download of downloads) {
        if (!download) continue
        const link = document.createElement("a")
        link.href = download.url
        link.download = download.fileName
        link.rel = "noopener"
        document.body.appendChild(link)
        link.click()
        link.remove()
        successCount += 1
      }

      if (successCount === 0) {
        toast.error("Failed to download selected files")
        return
      }

      if (successCount < ids.length) {
        toast.success(`Downloaded ${successCount} of ${ids.length} selected files`)
      } else {
        toast.success(`Downloading ${successCount} selected file${successCount === 1 ? "" : "s"}`)
      }
    } catch (error) {
      console.error("Failed to download selected files:", error)
      toast.error("Failed to download selected files")
    } finally {
      setIsDownloadingSelected(false)
    }
  }, [files, selectedFileIds])

  const handleUploadVersion = useCallback(
    async (file: File, label?: string, notes?: string) => {
      if (!viewerFile) return
      const formData = new FormData()
      formData.append("fileId", viewerFile.id)
      formData.append("file", file)
      if (label) formData.append("label", label)
      if (notes) formData.append("notes", notes)
      await uploadFileVersionAction(formData)
      const versions = await listFileVersionsAction(viewerFile.id)
      setVersionsByFile((prev) => ({
        ...prev,
        [viewerFile.id]: versions.map(mapVersion),
      }))
      await refreshFiles()
    },
    [viewerFile, refreshFiles]
  )

  const handleMakeCurrentVersion = useCallback(
    async (versionId: string) => {
      if (!viewerFile) return
      await makeVersionCurrentAction(viewerFile.id, versionId)
      const versions = await listFileVersionsAction(viewerFile.id)
      setVersionsByFile((prev) => ({
        ...prev,
        [viewerFile.id]: versions.map(mapVersion),
      }))
      await refreshFiles()
    },
    [viewerFile, refreshFiles]
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
        const versions = await listFileVersionsAction(viewerFile.id)
        setVersionsByFile((prev) => ({
          ...prev,
          [viewerFile.id]: versions.map(mapVersion),
        }))
      }
    },
    [viewerFile]
  )

  const handleDeleteVersion = useCallback(
    async (versionId: string) => {
      await deleteFileVersionAction(versionId)
      if (viewerFile) {
        const versions = await listFileVersionsAction(viewerFile.id)
        setVersionsByFile((prev) => ({
          ...prev,
          [viewerFile.id]: versions.map(mapVersion),
        }))
        await refreshFiles()
      }
    },
    [viewerFile, refreshFiles]
  )

  const handleViewerFileChange = useCallback((file: FileWithDetails) => {
    setViewerFile((prev) => (prev?.id === file.id ? prev : file))
    if (lastNotifiedViewerFileIdRef.current === file.id) {
      return
    }
    lastNotifiedViewerFileIdRef.current = file.id
    listFileVersionsAction(file.id).then((versions) => {
      setVersionsByFile((prev) => ({
        ...prev,
        [file.id]: versions.map(mapVersion),
      }))
    })
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

  const previewableFiles = useMemo(() => {
    return files
      .filter((f) => {
        const mime = f.mime_type ?? ""
        return (
          mime.startsWith("image/") ||
          mime === "application/pdf" ||
          mime.startsWith("video/") ||
          mime.startsWith("audio/")
        )
      })
      .map((f) => {
        const selectedViewer = viewerFile?.id === f.id ? viewerFile : null
        return {
          ...f,
          ...(selectedViewer
            ? {
                download_url: selectedViewer.download_url,
                thumbnail_url: selectedViewer.thumbnail_url,
              }
            : {}),
          category: f.category as any,
        }
      })
  }, [files, viewerFile])

  const renderContent = () => {
    if (quickFilter === "drawings") {
      return <DrawingSetsContent onSheetClick={handleSheetClick} />
    }

    if (quickFilter === "all" && !currentPath) {
      return (
        <>
          <DrawingSetsSection onSheetClick={handleSheetClick} />
          <DocumentsContent
            onFileClick={handleFileClick}
            onFolderClick={handleFolderClick}
            onUploadClick={handleUploadClick}
            onDropOnFolder={handleDropOnFolder}
            selectedFileIds={selectedFileIds}
            onFileSelectionChange={handleFileSelectionChange}
            onSelectAllVisibleFiles={handleSelectAllVisibleFiles}
            onRenameFile={openRenameDialog}
            onMoveFile={(fileId) => openMoveDialog(fileId)}
            onDeleteFile={(fileId) => openDeleteDialog(fileId)}
            onViewActivity={openTimeline}
            onFileDragStart={handleFileDragStart}
            onFileDragEnd={handleFileDragEnd}
          />
        </>
      )
    }

    return (
      <DocumentsContent
        onFileClick={handleFileClick}
        onFolderClick={handleFolderClick}
        onUploadClick={handleUploadClick}
        onDropOnFolder={handleDropOnFolder}
        selectedFileIds={selectedFileIds}
        onFileSelectionChange={handleFileSelectionChange}
        onSelectAllVisibleFiles={handleSelectAllVisibleFiles}
        onRenameFile={openRenameDialog}
        onMoveFile={(fileId) => openMoveDialog(fileId)}
        onDeleteFile={(fileId) => openDeleteDialog(fileId)}
        onViewActivity={openTimeline}
        onFileDragStart={handleFileDragStart}
        onFileDragEnd={handleFileDragEnd}
      />
    )
  }

  return (
    <div
      className="h-full flex flex-col relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <FileDropOverlay isVisible={isDraggingOver} />

      <div className="shrink-0">
        <DocumentsHeader
          onUploadClick={handleUploadClick}
          onCreateFolderClick={() => {
            setNewFolderPath(currentPath || "")
            setCreateFolderDialogOpen(true)
          }}
          onManageFolderAccessClick={openFolderAccessDialog}
          selectedCount={selectedFileIds.size}
          onDownloadSelected={handleDownloadSelected}
          onMoveSelected={() => openMoveDialog()}
          onDeleteSelected={() => openDeleteDialog()}
          onClearSelection={() => setSelectedFileIds(new Set())}
          onDropToFolderPath={handleDropOnFolder}
          onDropToRoot={handleDropToRoot}
          isDraggingFiles={isDraggingDocumentFile}
          isDownloadingSelected={isDownloadingSelected}
        />
      </div>

      <ScrollArea className="flex-1">
        {renderContent()}
      </ScrollArea>

      <UploadDialog
        open={uploadDialogOpen}
        onOpenChange={setUploadDialogOpen}
        initialFiles={uploadFiles}
        projectId={projectId}
        folderPath={currentPath}
        onUploadComplete={refreshFiles}
      />

      <FileViewer
        file={viewerFile}
        files={previewableFiles}
        open={viewerOpen}
        onOpenChange={(open) => {
          setViewerOpen(open)
          if (!open) {
            setViewerFile(null)
          }
        }}
        onDownload={handleDownload}
        versions={viewerFile ? versionsByFile[viewerFile.id] ?? [] : []}
        onUploadVersion={handleUploadVersion}
        onMakeCurrentVersion={handleMakeCurrentVersion}
        onDownloadVersion={handleDownloadVersion}
        onUpdateVersion={handleUpdateVersion}
        onDeleteVersion={handleDeleteVersion}
        onRefreshVersions={async () => {
          if (viewerFile) {
            const versions = await listFileVersionsAction(viewerFile.id)
            setVersionsByFile((prev) => ({
              ...prev,
              [viewerFile.id]: versions.map(mapVersion),
            }))
          }
        }}
        onFileChange={viewerOpen ? handleViewerFileChange : undefined}
      />

      {drawingViewerOpen && drawingViewerSheet && (
        <DrawingViewer
          sheet={drawingViewerSheet}
          fileUrl={drawingViewerUrl ?? undefined}
          markups={[]}
          pins={[]}
          readOnly
          onClose={() => {
            setDrawingViewerOpen(false)
            setDrawingViewerSheet(null)
            setDrawingViewerUrl(null)
          }}
          imageThumbnailUrl={drawingViewerSheet.image_thumbnail_url ?? null}
          imageMediumUrl={drawingViewerSheet.image_medium_url ?? null}
          imageFullUrl={drawingViewerSheet.image_full_url ?? null}
          imageWidth={drawingViewerSheet.image_width ?? null}
          imageHeight={drawingViewerSheet.image_height ?? null}
        />
      )}

      <FileTimelineSheet
        file={timelineFile}
        events={timelineEvents}
        loading={timelineLoading}
        open={timelineOpen}
        onOpenChange={(open) => {
          setTimelineOpen(open)
          if (!open) {
            setTimelineFile(null)
            setTimelineEvents([])
          }
        }}
      />

      <Dialog open={createFolderDialogOpen} onOpenChange={setCreateFolderDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create folder</DialogTitle>
            <DialogDescription>
              Folders are virtual and support nested paths like <code>/contracts/subcontracts</code>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Input
              placeholder="/contracts"
              value={newFolderPath}
              onChange={(event) => setNewFolderPath(event.target.value)}
              disabled={isCreatingFolder}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateFolderDialogOpen(false)}
              disabled={isCreatingFolder}
            >
              Cancel
            </Button>
            <Button onClick={handleCreateFolder} disabled={isCreatingFolder}>
              {isCreatingFolder ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={folderAccessDialogOpen} onOpenChange={setFolderAccessDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Folder Access Defaults</DialogTitle>
            <DialogDescription>
              Default visibility for new files in <code>{currentPath || "/"}</code>.
              Internal team roles (PM/Super/Admin) always keep full access.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">Client Portal</p>
                <p className="text-xs text-muted-foreground">Expose new files in this folder to clients.</p>
              </div>
              <Checkbox
                checked={folderShareWithClients}
                onCheckedChange={(value) => setFolderShareWithClients(Boolean(value))}
                disabled={isSavingFolderAccess}
              />
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">Subcontractor Portal</p>
                <p className="text-xs text-muted-foreground">Expose new files in this folder to subs.</p>
              </div>
              <Checkbox
                checked={folderShareWithSubs}
                onCheckedChange={(value) => setFolderShareWithSubs(Boolean(value))}
                disabled={isSavingFolderAccess}
              />
            </div>
            <div className="flex items-center gap-2 rounded-md border p-3">
              <Checkbox
                id="apply-folder-access"
                checked={applyFolderAccessToExisting}
                onCheckedChange={(value) => setApplyFolderAccessToExisting(Boolean(value))}
                disabled={isSavingFolderAccess}
              />
              <Label htmlFor="apply-folder-access" className="text-sm">
                Also apply to existing files in this folder and subfolders
              </Label>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setFolderAccessDialogOpen(false)}
              disabled={isSavingFolderAccess}
            >
              Cancel
            </Button>
            <Button onClick={saveFolderAccess} disabled={isSavingFolderAccess}>
              {isSavingFolderAccess ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save Access"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename file</DialogTitle>
            <DialogDescription>
              Update the file name shown in Documents.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Input
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              disabled={isRenaming}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameDialogOpen(false)} disabled={isRenaming}>
              Cancel
            </Button>
            <Button onClick={handleRenameConfirm} disabled={isRenaming}>
              {isRenaming ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={moveDialogOpen} onOpenChange={setMoveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move files</DialogTitle>
            <DialogDescription>
              Move {moveFileIds.length} file{moveFileIds.length === 1 ? "" : "s"} to a folder. Leave empty to move to root.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Input
              list="folder-options"
              placeholder="/contracts"
              value={moveTargetFolder}
              onChange={(event) => setMoveTargetFolder(event.target.value)}
              disabled={isMoving}
            />
            <datalist id="folder-options">
              {folderOptions.map((folder) => (
                <option key={folder} value={folder} />
              ))}
            </datalist>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMoveDialogOpen(false)} disabled={isMoving}>
              Cancel
            </Button>
            <Button onClick={handleMoveConfirm} disabled={isMoving || moveFileIds.length === 0}>
              {isMoving ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Moving...
                </>
              ) : (
                "Move"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete files?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete {deleteFileIds.length} file{deleteFileIds.length === 1 ? "" : "s"}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                "Delete"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
