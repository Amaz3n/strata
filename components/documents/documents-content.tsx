"use client"

import { useMemo } from "react"
import { AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useDocuments } from "./documents-context"
import { useVisibleDocuments } from "./use-visible-documents"
import { DocumentsFileTable } from "./documents-table"
import type { DocumentTableItem } from "./documents-table"

interface DocumentsContentProps {
  onFileClick: (fileId: string) => void
  onDownloadFile: (fileId: string) => void
  onFolderClick: (path: string) => void
  onRenameFolder?: (path: string) => void
  onShareFolder?: (path: string) => void
  onDeleteFolder?: (path: string) => void
  onUploadClick: () => void
  /** External OS files dropped onto a folder row. Internal moves go through dnd-kit. */
  onUploadToFolder: (path: string, files: File[]) => void
  selectedFileIds: Set<string>
  selectedFolderPaths: Set<string>
  onFileSelectionChange: (fileId: string, selected: boolean) => void
  onFolderSelectionChange: (path: string, selected: boolean) => void
  onSelectAllVisibleFiles: (fileIds: string[], selected: boolean) => void
  onRenameFile: (fileId: string) => void
  onMoveFile: (fileId: string) => void
  onDeleteFile: (fileId: string) => void
  onRestoreFile?: (fileId: string) => void
  onViewActivity: (fileId: string) => void
  onShareFile: (fileId: string) => void
  onUploadNewVersion: (fileId: string) => void
  onSendForSignature?: (fileId: string) => void
  onOpenProperties: (fileId: string) => void
}

export function DocumentsContent({
  onFileClick,
  onDownloadFile,
  onFolderClick,
  onRenameFolder,
  onShareFolder,
  onDeleteFolder,
  onUploadClick,
  onUploadToFolder,
  selectedFileIds,
  selectedFolderPaths,
  onFileSelectionChange,
  onFolderSelectionChange,
  onSelectAllVisibleFiles,
  onRenameFile,
  onMoveFile,
  onDeleteFile,
  onRestoreFile,
  onViewActivity,
  onShareFile,
  onUploadNewVersion,
  onSendForSignature,
  onOpenProperties,
}: DocumentsContentProps) {
  const {
    isLoading,
    isLoadingMore,
    hasMore,
    loadMore,
    totalCount,
    error,
    refreshFiles,
  } = useDocuments()

  const { currentFolders, filteredFiles, showFolders, hasFilters } = useVisibleDocuments()

  const documentItems: DocumentTableItem[] = useMemo(() => {
    const items: DocumentTableItem[] = []

    if (showFolders) {
      items.push(...currentFolders)
    }

    items.push(
      ...filteredFiles.map((file) => ({
        type: "file" as const,
        data: file,
      }))
    )

    return items
  }, [currentFolders, filteredFiles, showFolders])

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

  if (error && filteredFiles.length === 0) {
    return (
      <div className="flex min-h-[320px] flex-col items-center justify-center gap-3 p-8 text-center">
        <AlertTriangle className="h-8 w-8 text-destructive" />
        <div className="space-y-1">
          <p className="text-sm font-medium">Could not load documents</p>
          <p className="max-w-sm text-sm text-muted-foreground">{error}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refreshFiles()}>
          Try again
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col min-h-full">
      {error ? (
        <div className="flex items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/5 px-4 py-2">
          <p className="text-sm text-destructive">
            {error} — showing the last loaded results.
          </p>
          <Button variant="outline" size="sm" onClick={() => refreshFiles()}>
            Retry
          </Button>
        </div>
      ) : null}
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
          onRenameFolder={onRenameFolder}
          onShareFolder={onShareFolder}
          onDeleteFolder={onDeleteFolder}
          onUploadClick={onUploadClick}
          onUploadToFolder={onUploadToFolder}
          onRenameFile={onRenameFile}
          onMoveFile={onMoveFile}
          onDeleteFile={onDeleteFile}
          onRestoreFile={onRestoreFile}
          onViewActivity={onViewActivity}
          onShareFile={onShareFile}
          onUploadNewVersion={onUploadNewVersion}
          onSendForSignature={onSendForSignature}
          onOpenProperties={onOpenProperties}
          hasFilters={hasFilters}
        />
        
        {hasMore && (
          <div className="flex items-center justify-center gap-3 border-t p-4">
            <span className="text-xs text-muted-foreground tabular-nums">
              Showing {filteredFiles.length} of {totalCount}
            </span>
            <Button variant="outline" size="sm" onClick={loadMore} disabled={isLoadingMore}>
              {isLoadingMore ? "Loading more..." : "Load more"}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
