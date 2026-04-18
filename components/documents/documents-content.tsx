"use client"

import { useMemo } from "react"
import { Layers } from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { useDocuments, buildFolderTree } from "./documents-context"
import { DocumentsFileTable } from "./documents-table"
import type { DocumentTableItem } from "./documents-table"

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
  onSendForSignature?: (fileId: string) => void
  onSendForApproval?: (fileId: string) => void
  onOpenProperties: (fileId: string) => void
  onFileDragStart: (fileId: string, event: React.DragEvent<HTMLDivElement>) => void
  onFileDragEnd: (fileId: string) => void
  onDrawingSetClick?: (setId: string, title: string) => void
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
  onSendForSignature,
  onSendForApproval,
  onOpenProperties,
  onFileDragStart,
  onFileDragEnd,
  onDrawingSetClick,
}: DocumentsContentProps) {
  const {
    files,
    folders,
    drawingSets,
    currentPath,
    quickFilter,
    searchQuery,
    isLoading,
    isLoadingMore,
    hasMore,
    loadMore,
  } = useDocuments()

  const folderTree = useMemo(() => buildFolderTree(folders, files), [folders, files])

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

  // Show drawing sets at root level
  const showDrawingSets = !currentPath && drawingSets.length > 0 && onDrawingSetClick

  return (
    <div className="flex flex-col min-h-full">
      {showDrawingSets && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2 px-4 py-3 border-b shrink-0">
          {drawingSets.map((set) => (
            <button
              key={set.id}
              type="button"
              onClick={() => onDrawingSetClick(set.id, set.title)}
              className={cn(
                "flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
                "hover:bg-muted/50 hover:border-foreground/20",
              )}
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-blue-50 dark:bg-blue-950/30">
                <Layers className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{set.title}</p>
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-muted-foreground">
                    {set.sheet_count ?? 0} sheets
                  </span>
                  {set.status === "processing" && (
                    <Badge variant="secondary" className="text-[9px] px-1 py-0 h-3.5">Processing</Badge>
                  )}
                  {set.status === "failed" && (
                    <Badge variant="destructive" className="text-[9px] px-1 py-0 h-3.5">Failed</Badge>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 min-h-0">
        <DocumentsFileTable
          items={documentItems}
          isLoading={isLoading}
          selectedFileIds={selectedFileIds}
          allVisibleSelected={allVisibleSelected}
          visibleFileIds={visibleFileIds}
          onSelectAllVisibleFiles={onSelectAllVisibleFiles}
          onFileSelectionChange={onFileSelectionChange}
          onFileClick={onFileClick}
          onFolderClick={onFolderClick}
          onUploadClick={onUploadClick}
          onDropOnFolder={onDropOnFolder}
          onRenameFile={onRenameFile}
          onMoveFile={onMoveFile}
          onDeleteFile={onDeleteFile}
          onViewActivity={onViewActivity}
          onShareFile={onShareFile}
          onSendForSignature={onSendForSignature}
          onSendForApproval={onSendForApproval}
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
