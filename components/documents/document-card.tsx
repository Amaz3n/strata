"use client"

import { cn } from "@/lib/utils"
import {
  FileText,
  Image,
  File,
  FileSpreadsheet,
  Presentation,
  FileCode,
  FolderOpen,
  ChevronRight,
  MoreHorizontal,
  Pencil,
  FolderInput,
  Trash2,
  Activity,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { DocumentItem, ViewMode } from "./types"

interface DocumentCardProps {
  item: DocumentItem
  viewMode: ViewMode
  onClick: () => void
  isSelected?: boolean
  onSelectionChange?: (selected: boolean) => void
  onRenameFile?: (fileId: string) => void
  onMoveFile?: (fileId: string) => void
  onDeleteFile?: (fileId: string) => void
  onViewActivity?: (fileId: string) => void
  onFileDragStart?: (fileId: string, event: React.DragEvent<HTMLDivElement>) => void
  onFileDragEnd?: (fileId: string) => void
  onDropOnFolder?: (path: string) => void
}

const FILE_TYPE_ICONS: Record<string, React.ElementType> = {
  "image/": Image,
  "application/pdf": FileText,
  "application/vnd.openxmlformats-officedocument.spreadsheetml": FileSpreadsheet,
  "application/vnd.openxmlformats-officedocument.presentationml": Presentation,
  "application/vnd.ms-excel": FileSpreadsheet,
  "application/vnd.ms-powerpoint": Presentation,
  "text/": FileCode,
}

function getFileIcon(mimeType?: string): React.ElementType {
  if (!mimeType) return File

  for (const [pattern, Icon] of Object.entries(FILE_TYPE_ICONS)) {
    if (mimeType.startsWith(pattern)) return Icon
  }

  return File
}

function formatFileSize(bytes?: number | null): string {
  if (!bytes) return ""

  const units = ["B", "KB", "MB", "GB"]
  let size = bytes
  let unitIndex = 0

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex++
  }

  return `${size.toFixed(unitIndex > 0 ? 1 : 0)} ${units[unitIndex]}`
}

function formatDate(dateString?: string | null): string {
  if (!dateString) return ""

  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays === 0) return "Today"
  if (diffDays === 1) return "Yesterday"
  if (diffDays < 7) return `${diffDays} days ago`

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  })
}

function formatUploaderName(name?: string | null): string {
  if (!name) return "Unknown"
  return name
}

function FileActions({
  fileId,
  onRenameFile,
  onMoveFile,
  onDeleteFile,
  onViewActivity,
}: {
  fileId: string
  onRenameFile?: (fileId: string) => void
  onMoveFile?: (fileId: string) => void
  onDeleteFile?: (fileId: string) => void
  onViewActivity?: (fileId: string) => void
}) {
  if (!onRenameFile && !onMoveFile && !onDeleteFile && !onViewActivity) {
    return null
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        {onViewActivity && (
          <DropdownMenuItem onClick={() => onViewActivity(fileId)}>
            <Activity className="h-4 w-4 mr-2" />
            Timeline
          </DropdownMenuItem>
        )}
        {onRenameFile && (
          <DropdownMenuItem onClick={() => onRenameFile(fileId)}>
            <Pencil className="h-4 w-4 mr-2" />
            Rename
          </DropdownMenuItem>
        )}
        {onMoveFile && (
          <DropdownMenuItem onClick={() => onMoveFile(fileId)}>
            <FolderInput className="h-4 w-4 mr-2" />
            Move
          </DropdownMenuItem>
        )}
        {onDeleteFile && (
          <DropdownMenuItem
            onClick={() => onDeleteFile(fileId)}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Delete
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function DocumentCard({
  item,
  viewMode,
  onClick,
  isSelected = false,
  onSelectionChange,
  onRenameFile,
  onMoveFile,
  onDeleteFile,
  onViewActivity,
  onFileDragStart,
  onFileDragEnd,
  onDropOnFolder,
}: DocumentCardProps) {
  if (item.type === "folder") {
    return viewMode === "grid" ? (
      <FolderCardGrid item={item} onClick={onClick} onDropOnFolder={onDropOnFolder} />
    ) : (
      <FolderCardList item={item} onClick={onClick} onDropOnFolder={onDropOnFolder} />
    )
  }

  if (item.type === "file") {
    return viewMode === "grid" ? (
      <FileCardGrid
        item={item}
        onClick={onClick}
        isSelected={isSelected}
        onSelectionChange={onSelectionChange}
        onRenameFile={onRenameFile}
        onMoveFile={onMoveFile}
        onDeleteFile={onDeleteFile}
        onViewActivity={onViewActivity}
        onFileDragStart={onFileDragStart}
        onFileDragEnd={onFileDragEnd}
      />
    ) : (
      <FileCardList
        item={item}
        onClick={onClick}
        isSelected={isSelected}
        onSelectionChange={onSelectionChange}
        onRenameFile={onRenameFile}
        onMoveFile={onMoveFile}
        onDeleteFile={onDeleteFile}
        onViewActivity={onViewActivity}
        onFileDragStart={onFileDragStart}
        onFileDragEnd={onFileDragEnd}
      />
    )
  }

  return null
}

interface FolderCardProps {
  item: Extract<DocumentItem, { type: "folder" }>
  onClick: () => void
  onDropOnFolder?: (path: string) => void
}

function FolderCardGrid({ item, onClick, onDropOnFolder }: FolderCardProps) {
  return (
    <button
      onClick={onClick}
      onDragOver={(event) => {
        if (!onDropOnFolder) return
        event.preventDefault()
      }}
      onDrop={(event) => {
        if (!onDropOnFolder) return
        event.preventDefault()
        event.stopPropagation()
        onDropOnFolder(item.path)
      }}
      className="group flex flex-col items-center gap-2 p-4 rounded-lg border bg-card hover:bg-accent hover:border-accent transition-colors text-left"
    >
      <div className="w-12 h-12 flex items-center justify-center rounded-lg bg-muted group-hover:bg-background transition-colors">
        <FolderOpen className="h-6 w-6 text-muted-foreground" />
      </div>
      <div className="text-center w-full">
        <p className="font-medium text-sm truncate">{item.name}</p>
        <p className="text-xs text-muted-foreground">
          {item.itemCount} {item.itemCount === 1 ? "item" : "items"}
        </p>
      </div>
    </button>
  )
}

function FolderCardList({ item, onClick, onDropOnFolder }: FolderCardProps) {
  return (
    <button
      onClick={onClick}
      onDragOver={(event) => {
        if (!onDropOnFolder) return
        event.preventDefault()
      }}
      onDrop={(event) => {
        if (!onDropOnFolder) return
        event.preventDefault()
        event.stopPropagation()
        onDropOnFolder(item.path)
      }}
      className="flex w-full items-center gap-3 px-3 py-2.5 hover:bg-muted/50 transition-colors text-left"
    >
      <div className="w-5 shrink-0" />
      <div className="w-9 h-9 flex items-center justify-center rounded-lg bg-muted shrink-0">
        <FolderOpen className="h-5 w-5 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm truncate">{item.name}</p>
        <p className="text-xs text-muted-foreground">
          {item.itemCount} {item.itemCount === 1 ? "item" : "items"}
        </p>
      </div>
      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
    </button>
  )
}

interface FileCardProps {
  item: Extract<DocumentItem, { type: "file" }>
  onClick: () => void
  isSelected: boolean
  onSelectionChange?: (selected: boolean) => void
  onRenameFile?: (fileId: string) => void
  onMoveFile?: (fileId: string) => void
  onDeleteFile?: (fileId: string) => void
  onViewActivity?: (fileId: string) => void
  onFileDragStart?: (fileId: string, event: React.DragEvent<HTMLDivElement>) => void
  onFileDragEnd?: (fileId: string) => void
}

function handleRowKeyDown(
  event: React.KeyboardEvent<HTMLDivElement>,
  onActivate: () => void
) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault()
    onActivate()
  }
}

function FileCardGrid({
  item,
  onClick,
  isSelected,
  onSelectionChange,
  onRenameFile,
  onMoveFile,
  onDeleteFile,
  onViewActivity,
  onFileDragStart,
  onFileDragEnd,
}: FileCardProps) {
  const { data: file } = item
  const Icon = getFileIcon(file.mime_type ?? undefined)
  const isImage = file.mime_type?.startsWith("image/")
  const thumbnailUrl = file.thumbnail_url ?? file.download_url

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => handleRowKeyDown(event, onClick)}
      draggable={Boolean(onFileDragStart)}
      onDragStart={(event) => onFileDragStart?.(file.id, event)}
      onDragEnd={() => onFileDragEnd?.(file.id)}
      className={cn(
        "group flex flex-col rounded-lg border bg-card hover:border-primary/50 transition-colors text-left overflow-hidden relative",
        isSelected && "ring-2 ring-primary/40 border-primary/50"
      )}
    >
      {onSelectionChange && (
        <div
          className="absolute left-2 top-2 z-10"
          onClick={(event) => event.stopPropagation()}
        >
          <Checkbox
            checked={isSelected}
            onCheckedChange={(value) => onSelectionChange(Boolean(value))}
            className="h-4 w-4 bg-background/90"
          />
        </div>
      )}

      <div className="aspect-[4/3] bg-muted flex items-center justify-center overflow-hidden">
        {isImage && thumbnailUrl ? (
          <img
            src={thumbnailUrl}
            alt={file.file_name}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
            loading="lazy"
          />
        ) : (
          <Icon className="h-10 w-10 text-muted-foreground" />
        )}
      </div>

      <div className="p-2.5 space-y-1">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="font-medium text-sm truncate">{file.file_name}</p>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {file.category && (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
                  {file.category}
                </Badge>
              )}
              <span>{formatFileSize(file.size_bytes)}</span>
            </div>
          </div>
          <FileActions
            fileId={file.id}
            onRenameFile={onRenameFile}
            onMoveFile={onMoveFile}
            onDeleteFile={onDeleteFile}
            onViewActivity={onViewActivity}
          />
        </div>
      </div>
    </div>
  )
}

function FileCardList({
  item,
  onClick,
  isSelected,
  onSelectionChange,
  onRenameFile,
  onMoveFile,
  onDeleteFile,
  onViewActivity,
  onFileDragStart,
  onFileDragEnd,
}: FileCardProps) {
  const { data: file } = item
  const Icon = getFileIcon(file.mime_type ?? undefined)
  const isImage = file.mime_type?.startsWith("image/")
  const thumbnailUrl = file.thumbnail_url ?? file.download_url

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => handleRowKeyDown(event, onClick)}
      draggable={Boolean(onFileDragStart)}
      onDragStart={(event) => onFileDragStart?.(file.id, event)}
      onDragEnd={() => onFileDragEnd?.(file.id)}
      className={cn(
        "flex w-full items-center gap-3 px-3 py-2.5 hover:bg-muted/50 transition-colors text-left",
        isSelected && "bg-primary/5"
      )}
    >
      <div
        className="w-5 shrink-0"
        onClick={(event) => event.stopPropagation()}
      >
        {onSelectionChange && (
          <Checkbox
            checked={isSelected}
            onCheckedChange={(value) => onSelectionChange(Boolean(value))}
            className="h-4 w-4"
          />
        )}
      </div>

      <div className="w-9 h-9 rounded bg-muted flex items-center justify-center overflow-hidden shrink-0">
        {isImage && thumbnailUrl ? (
          <img
            src={thumbnailUrl}
            alt={file.file_name}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <Icon className="h-4.5 w-4.5 text-muted-foreground" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm truncate">{file.file_name}</p>
      </div>

      <div className="hidden sm:block w-24 shrink-0">
        {file.category && (
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
            {file.category}
          </Badge>
        )}
      </div>

      <div className="hidden lg:block w-28 text-xs text-muted-foreground shrink-0 truncate">
        {formatUploaderName(file.uploader_name)}
      </div>

      <div className="hidden md:block w-16 text-xs text-muted-foreground shrink-0 text-right">
        {formatFileSize(file.size_bytes)}
      </div>

      <div className="hidden md:block w-20 text-xs text-muted-foreground shrink-0 text-right">
        {formatDate(file.created_at)}
      </div>

      <div className="w-20 text-xs text-muted-foreground shrink-0 text-right">
        {formatDate(file.updated_at ?? file.created_at)}
      </div>

      <div
        className="w-8 shrink-0 flex justify-end"
        onClick={(event) => event.stopPropagation()}
      >
        <FileActions
          fileId={file.id}
          onRenameFile={onRenameFile}
          onMoveFile={onMoveFile}
          onDeleteFile={onDeleteFile}
          onViewActivity={onViewActivity}
        />
      </div>
    </div>
  )
}
