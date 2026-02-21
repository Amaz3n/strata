"use client"

import { useMemo } from "react"
import { cn } from "@/lib/utils"
import { FileText, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Checkbox } from "@/components/ui/checkbox"
import { useDocuments, buildFolderTree } from "./documents-context"
import { DocumentCard } from "./document-card"
import type { DocumentItem } from "./types"

interface DocumentsContentProps {
  onFileClick: (fileId: string) => void
  onFolderClick: (path: string) => void
  onUploadClick: () => void
  onDropOnFolder: (path: string) => void
  selectedFileIds: Set<string>
  onFileSelectionChange: (fileId: string, selected: boolean) => void
  onSelectAllVisibleFiles: (fileIds: string[], selected: boolean) => void
  onRenameFile: (fileId: string) => void
  onMoveFile: (fileId: string) => void
  onDeleteFile: (fileId: string) => void
  onViewActivity: (fileId: string) => void
  onShareFile: (fileId: string) => void
  onFileDragStart: (fileId: string, event: React.DragEvent<HTMLDivElement>) => void
  onFileDragEnd: (fileId: string) => void
}

export function DocumentsContent({
  onFileClick,
  onFolderClick,
  onUploadClick,
  onDropOnFolder,
  selectedFileIds,
  onFileSelectionChange,
  onSelectAllVisibleFiles,
  onRenameFile,
  onMoveFile,
  onDeleteFile,
  onViewActivity,
  onShareFile,
  onFileDragStart,
  onFileDragEnd,
}: DocumentsContentProps) {
  const {
    files,
    folders,
    currentPath,
    quickFilter,
    searchQuery,
    viewMode,
    isLoading,
  } = useDocuments()

  // Build folder tree to get direct children of current path
  const folderTree = useMemo(() => buildFolderTree(folders, files), [folders, files])

  // Get folders at current level
  const currentFolders = useMemo(() => {
    if (!currentPath) {
      // At root, show top-level folders
      return folderTree.map((node) => ({
        type: "folder" as const,
        path: node.path,
        name: node.name,
        itemCount: node.itemCount,
      }))
    }

    // Find the current folder node
    const findNode = (
      nodes: typeof folderTree,
      targetPath: string
    ): (typeof folderTree)[0] | null => {
      for (const node of nodes) {
        if (node.path === targetPath) return node
        const found = findNode(node.children, targetPath)
        if (found) return found
      }
      return null
    }

    const currentNode = findNode(folderTree, currentPath)
    if (!currentNode) return []

    return currentNode.children.map((node) => ({
      type: "folder" as const,
      path: node.path,
      name: node.name,
      itemCount: node.itemCount,
    }))
  }, [folderTree, currentPath])

  // Filter files by current path and category
  const filteredFiles = useMemo(() => {
    let result = files

    // Filter by folder path
    if (currentPath) {
      const normalizedPath = currentPath.replace(/\/+/g, "/")
      result = result.filter((file) => {
        const filePath = file.folder_path
          ? file.folder_path.startsWith("/")
            ? file.folder_path
            : `/${file.folder_path}`
          : ""
        // Only show files directly in this folder (not nested)
        return filePath === normalizedPath
      })
    } else {
      // At root, show files without folder_path (unsorted files)
      result = result.filter((file) => !file.folder_path || file.folder_path === "/")
    }

    // Filter by category if not "all"
    if (quickFilter !== "all") {
      result = result.filter((file) => file.category === quickFilter)
    }

    // Filter by search query
    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      result = result.filter(
        (file) =>
          file.file_name.toLowerCase().includes(query) ||
          file.description?.toLowerCase().includes(query) ||
          file.tags?.some((tag) => tag.toLowerCase().includes(query))
      )
    }

    return result
  }, [files, currentPath, quickFilter, searchQuery])

  // Combine folders and files into document items
  const documentItems: DocumentItem[] = useMemo(() => {
    const items: DocumentItem[] = []

    // Add folders first (when not searching and at root or in a folder)
    if (!searchQuery || currentPath) {
      items.push(
        ...currentFolders.map((folder) => ({
          type: "folder" as const,
          path: folder.path,
          name: folder.name,
          itemCount: folder.itemCount,
        }))
      )
    }

    // Add files
    items.push(
      ...filteredFiles.map((file) => ({
        type: "file" as const,
        data: file,
      }))
    )

    return items
  }, [currentFolders, filteredFiles, searchQuery, currentPath])

  const visibleFileIds = useMemo(
    () => filteredFiles.map((file) => file.id),
    [filteredFiles]
  )

  const selectedVisibleCount = useMemo(
    () => visibleFileIds.filter((id) => selectedFileIds.has(id)).length,
    [visibleFileIds, selectedFileIds]
  )

  const allVisibleSelected =
    visibleFileIds.length > 0 && selectedVisibleCount === visibleFileIds.length

  // Loading state
  if (isLoading && documentItems.length === 0) {
    return (
      <div className="py-3">
        {viewMode === "grid" ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="aspect-[4/3] rounded-lg" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 p-3 rounded-lg border">
                <Skeleton className="h-10 w-10 rounded" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="h-3 w-1/4" />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  // Empty state
  if (documentItems.length === 0) {
    const hasFilters = quickFilter !== "all" || searchQuery || currentPath

    return (
      <div
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-8 py-16 transition-colors",
          "border-muted-foreground/25 bg-background/70 hover:border-primary/50"
        )}
        onClick={onUploadClick}
      >
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          {hasFilters ? (
            <FileText className="h-8 w-8 text-muted-foreground" />
          ) : (
            <Upload className="h-8 w-8 text-muted-foreground" />
          )}
        </div>
        <h3 className="text-lg font-semibold">
          {hasFilters ? "No files found" : "No documents yet"}
        </h3>
        <p className="mt-1 max-w-sm text-center text-sm text-muted-foreground">
          {hasFilters
            ? "Try adjusting your filters or search query."
            : "Drag and drop files here, or click to upload documents, plans, and photos."}
        </p>
        {!hasFilters && (
          <Button className="mt-4" variant="outline">
            <Upload className="mr-2 h-4 w-4" />
            Upload Files
          </Button>
        )}
      </div>
    )
  }

  // Grid view
  if (viewMode === "grid") {
    return (
      <div className="py-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
          {documentItems.map((item) => (
            <DocumentCard
              key={
                item.type === "file"
                  ? item.data.id
                  : item.type === "folder"
                    ? item.path
                    : item.data.id
              }
              item={item}
              viewMode={viewMode}
              isSelected={item.type === "file" ? selectedFileIds.has(item.data.id) : false}
              onSelectionChange={
                item.type === "file"
                  ? (selected) => onFileSelectionChange(item.data.id, selected)
                  : undefined
              }
              onRenameFile={onRenameFile}
              onMoveFile={onMoveFile}
              onDeleteFile={onDeleteFile}
              onViewActivity={onViewActivity}
              onShareFile={onShareFile}
              onDropOnFolder={onDropOnFolder}
              onFileDragStart={onFileDragStart}
              onFileDragEnd={onFileDragEnd}
              onClick={() => {
                if (item.type === "folder") {
                  onFolderClick(item.path)
                } else if (item.type === "file") {
                  onFileClick(item.data.id)
                }
              }}
            />
          ))}
        </div>
      </div>
    )
  }

  // List view
  return (
    <div className="py-3">
      <div className="divide-y rounded-xl border border-border/60 bg-background/80">
        {/* Column headers */}
        <div className="flex items-center gap-3 px-3 py-2 text-xs font-medium text-muted-foreground">
          <div className="w-5 shrink-0">
            {visibleFileIds.length > 0 && (
              <Checkbox
                checked={allVisibleSelected}
                onCheckedChange={(value) =>
                  onSelectAllVisibleFiles(visibleFileIds, Boolean(value))
                }
                aria-label="Select all visible files"
              />
            )}
          </div>
          <div className="w-9 shrink-0" />
          <div className="flex-1 min-w-0">Name</div>
          <div className="hidden sm:block w-24 shrink-0">Category</div>
          <div className="hidden lg:block w-28 shrink-0">Uploaded by</div>
          <div className="hidden md:block w-16 shrink-0 text-right">Size</div>
          <div className="hidden md:block w-20 shrink-0 text-right">Uploaded</div>
          <div className="w-20 shrink-0 text-right">Updated</div>
          <div className="w-8 shrink-0" />
        </div>
        {documentItems.map((item) => (
          <DocumentCard
            key={
              item.type === "file"
                ? item.data.id
                : item.type === "folder"
                  ? item.path
                  : item.data.id
            }
            item={item}
            viewMode={viewMode}
            isSelected={item.type === "file" ? selectedFileIds.has(item.data.id) : false}
            onSelectionChange={
              item.type === "file"
                ? (selected) => onFileSelectionChange(item.data.id, selected)
                : undefined
            }
            onRenameFile={onRenameFile}
            onMoveFile={onMoveFile}
            onDeleteFile={onDeleteFile}
            onViewActivity={onViewActivity}
            onShareFile={onShareFile}
            onDropOnFolder={onDropOnFolder}
            onFileDragStart={onFileDragStart}
            onFileDragEnd={onFileDragEnd}
            onClick={() => {
              if (item.type === "folder") {
                onFolderClick(item.path)
              } else if (item.type === "file") {
                onFileClick(item.data.id)
              }
            }}
          />
        ))}
      </div>
    </div>
  )
}
