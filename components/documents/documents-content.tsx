"use client"

import { useMemo } from "react"
import { cn } from "@/lib/utils"
import { useDocuments, buildFolderTree } from "./documents-context"
import { DocumentsFileTable } from "./documents-table"
import type { DocumentTableItem } from "./documents-table"

interface DocumentsContentProps {
  onFileClick: (fileId: string) => void
  onDownloadFile: (fileId: string) => void
  onFolderClick: (path: string) => void
  onUploadClick: () => void
  onDropOnFolder: (path: string, files?: File[]) => void
  selectedFileIds: Set<string>
  selectedFolderPaths: Set<string>
  onFileSelectionChange: (fileId: string, selected: boolean) => void
  onFolderSelectionChange: (path: string, selected: boolean) => void
  onSelectAllVisibleFiles: (fileIds: string[], selected: boolean) => void
  onRenameFile: (fileId: string) => void
  onMoveFile: (fileId: string) => void
  onDeleteFile: (fileId: string) => void
  onViewActivity: (fileId: string) => void
  onShareFile: (fileId: string) => void
  onUploadNewVersion: (fileId: string) => void
  onSendForSignature?: (fileId: string) => void
  onOpenProperties: (fileId: string) => void
  onFileDragStart: (fileId: string, event: React.DragEvent<HTMLDivElement>) => void
  onFileDragEnd: (fileId: string) => void
}

export function DocumentsContent({
  onFileClick,
  onDownloadFile,
  onFolderClick,
  onUploadClick,
  onDropOnFolder,
  selectedFileIds,
  selectedFolderPaths,
  onFileSelectionChange,
  onFolderSelectionChange,
  onSelectAllVisibleFiles,
  onRenameFile,
  onMoveFile,
  onDeleteFile,
  onViewActivity,
  onShareFile,
  onUploadNewVersion,
  onSendForSignature,
  onOpenProperties,
  onFileDragStart,
  onFileDragEnd,
}: DocumentsContentProps) {
  const {
    files,
    folders,
    folderItemCounts,
    currentPath,
    quickFilter,
    searchQuery,
    isLoading,
    isLoadingMore,
    hasMore,
    loadMore,
  } = useDocuments()

  const folderTree = useMemo(
    () => buildFolderTree(folders, files, folderItemCounts),
    [folders, files, folderItemCounts]
  )

  const currentFolders = useMemo(() => {
    if (!currentPath) {
      return folderTree.map((node) => ({
        type: "folder" as const,
        path: node.path,
        name: node.name,
        itemCount: node.itemCount,
      }))
    }

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

  const filteredFiles = useMemo(() => {
    // Files are now server-filtered by quickFilter and searchQuery
    // We only need to filter by currentPath if we are not in a search/global view
    let result = files

    if (currentPath && !searchQuery) {
      const normalizedPath = currentPath.replace(/\/+/g, "/")
      result = result.filter((file) => {
        const filePath = file.folder_path
          ? file.folder_path.startsWith("/")
            ? file.folder_path
            : `/${file.folder_path}`
          : ""
        return filePath === normalizedPath
      })
    } else if (!currentPath && !searchQuery && quickFilter === "all") {
      result = result.filter((file) => !file.folder_path || file.folder_path === "/")
    }

    return result
  }, [files, currentPath, searchQuery, quickFilter])

  const documentItems: DocumentTableItem[] = useMemo(() => {
    const items: DocumentTableItem[] = []

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

  const hasFilters = quickFilter !== "all" || Boolean(searchQuery) || Boolean(currentPath)

  return (
    <div className="flex flex-col min-h-full">
      <div className="flex-1 min-h-0">
        <DocumentsFileTable
          items={documentItems}
          isLoading={isLoading}
          selectedFileIds={selectedFileIds}
          selectedFolderPaths={selectedFolderPaths}
          allVisibleSelected={allVisibleSelected}
          visibleFileIds={visibleFileIds}
          onSelectAllVisibleFiles={onSelectAllVisibleFiles}
          onFileSelectionChange={onFileSelectionChange}
          onFolderSelectionChange={onFolderSelectionChange}
          onFileClick={onFileClick}
          onDownloadFile={onDownloadFile}
          onFolderClick={onFolderClick}
          onUploadClick={onUploadClick}
          onDropOnFolder={onDropOnFolder}
          onRenameFile={onRenameFile}
          onMoveFile={onMoveFile}
          onDeleteFile={onDeleteFile}
          onViewActivity={onViewActivity}
          onShareFile={onShareFile}
          onUploadNewVersion={onUploadNewVersion}
          onSendForSignature={onSendForSignature}
          onOpenProperties={onOpenProperties}
          onFileDragStart={onFileDragStart}
          onFileDragEnd={onFileDragEnd}
          hasFilters={hasFilters}
        />
        
        {hasMore && (
          <div className="flex justify-center p-4 border-t">
            <button
              type="button"
              onClick={loadMore}
              disabled={isLoadingMore}
              className={cn(
                "px-4 py-2 text-sm font-medium rounded-md border",
                "hover:bg-muted transition-colors disabled:opacity-50",
              )}
            >
              {isLoadingMore ? "Loading more..." : "Load more"}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
