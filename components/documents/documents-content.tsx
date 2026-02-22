"use client"

import { useMemo } from "react"
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
    isLoading,
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
    let result = files

    if (currentPath) {
      const normalizedPath = currentPath.replace(/\/+/g, "/")
      result = result.filter((file) => {
        const filePath = file.folder_path
          ? file.folder_path.startsWith("/")
            ? file.folder_path
            : `/${file.folder_path}`
          : ""
        return filePath === normalizedPath
      })
    } else {
      result = result.filter((file) => !file.folder_path || file.folder_path === "/")
    }

    if (quickFilter !== "all") {
      result = result.filter((file) => file.category === quickFilter)
    }

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
    <div className="py-3">
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
        onFileDragStart={onFileDragStart}
        onFileDragEnd={onFileDragEnd}
        hasFilters={hasFilters}
      />
    </div>
  )
}
