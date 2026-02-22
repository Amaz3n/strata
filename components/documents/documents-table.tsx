"use client"

import { memo } from "react"
import { cn } from "@/lib/utils"
import {
  FileText,
  Image,
  File,
  FileSpreadsheet,
  Presentation,
  FileCode,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  FolderInput,
  Trash2,
  Activity,
  Share2,
  FilePlus2,
  Upload,
  FolderOpenDot,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { FileWithUrls } from "@/app/(app)/files/actions"
import type { DrawingSheet } from "@/app/(app)/drawings/actions"

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

const FILE_TYPE_ICONS: Record<string, React.ElementType> = {
  "image/": Image,
  "application/pdf": FileText,
  "application/vnd.openxmlformats-officedocument.spreadsheetml": FileSpreadsheet,
  "application/vnd.openxmlformats-officedocument.presentationml": Presentation,
  "application/vnd.ms-excel": FileSpreadsheet,
  "application/vnd.ms-powerpoint": Presentation,
  "text/": FileCode,
}

export function getFileIcon(mimeType?: string): React.ElementType {
  if (!mimeType) return File
  for (const [pattern, Icon] of Object.entries(FILE_TYPE_ICONS)) {
    if (mimeType.startsWith(pattern)) return Icon
  }
  return File
}

export function formatFileSize(bytes?: number | null): string {
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

export function formatDate(dateString?: string | null): string {
  if (!dateString) return ""
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays === 0) return "Today"
  if (diffDays === 1) return "Yesterday"
  if (diffDays < 7) return `${diffDays}d ago`

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  })
}

function getDisplaySheetNumber(sheet: DrawingSheet): string {
  const rawNumber = (sheet.sheet_number ?? "").trim()
  if (rawNumber && !/^sheet\s*\d+$/i.test(rawNumber)) {
    return rawNumber.toUpperCase()
  }
  const title = sheet.sheet_title ?? ""
  const extractedFromTitle = title.match(/\b([A-Z]{1,3}\s*[-.]?\s*\d{1,4}[A-Z]?)\b/i)
  if (extractedFromTitle?.[1]) {
    return extractedFromTitle[1].replace(/\s+/g, "").toUpperCase()
  }
  return rawNumber || "UNNAMED"
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DocumentTableItem =
  | { type: "file"; data: FileWithUrls }
  | { type: "folder"; path: string; name: string; itemCount: number }

export interface DocumentsFileTableProps {
  items: DocumentTableItem[]
  isLoading?: boolean
  selectedFileIds: Set<string>
  allVisibleSelected: boolean
  visibleFileIds: string[]
  onSelectAllVisibleFiles: (fileIds: string[], selected: boolean) => void
  onFileSelectionChange: (fileId: string, selected: boolean) => void
  onFileClick: (fileId: string) => void
  onFolderClick: (path: string) => void
  onUploadClick: () => void
  onDropOnFolder: (path: string) => void
  onRenameFile: (fileId: string) => void
  onMoveFile: (fileId: string) => void
  onDeleteFile: (fileId: string) => void
  onViewActivity: (fileId: string) => void
  onShareFile: (fileId: string) => void
  onFileDragStart: (fileId: string, event: React.DragEvent<HTMLDivElement>) => void
  onFileDragEnd: (fileId: string) => void
  hasFilters?: boolean
}

export interface SheetsTableProps {
  sheets: DrawingSheet[]
  isLoading?: boolean
  onSheetClick?: (sheet: DrawingSheet) => void
  onEditSheet: (sheet: DrawingSheet) => void
  onDeleteSheet: (sheet: DrawingSheet) => void
  onAddVersion: (sheet: DrawingSheet) => void
}

// ---------------------------------------------------------------------------
// Files Table
// ---------------------------------------------------------------------------

export function DocumentsFileTable({
  items,
  isLoading,
  selectedFileIds,
  allVisibleSelected,
  visibleFileIds,
  onSelectAllVisibleFiles,
  onFileSelectionChange,
  onFileClick,
  onFolderClick,
  onUploadClick,
  onDropOnFolder,
  onRenameFile,
  onMoveFile,
  onDeleteFile,
  onViewActivity,
  onShareFile,
  onFileDragStart,
  onFileDragEnd,
  hasFilters,
}: DocumentsFileTableProps) {
  if (isLoading && items.length === 0) {
    return <TableSkeleton rows={8} cols={7} />
  }

  if (items.length === 0) {
    return (
      <EmptyState
        hasFilters={hasFilters}
        onUploadClick={onUploadClick}
      />
    )
  }

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="divide-x">
              <TableHead className="w-10 px-3 py-3">
                {visibleFileIds.length > 0 && (
                  <Checkbox
                    checked={allVisibleSelected}
                    onCheckedChange={(value) =>
                      onSelectAllVisibleFiles(visibleFileIds, Boolean(value))
                    }
                    aria-label="Select all visible files"
                  />
                )}
              </TableHead>
              <TableHead className="min-w-[240px] px-4 py-3">Name</TableHead>
              <TableHead className="hidden sm:table-cell px-4 py-3">Category</TableHead>
              <TableHead className="hidden md:table-cell px-4 py-3">Modified</TableHead>
              <TableHead className="hidden lg:table-cell px-4 py-3">Uploaded by</TableHead>
              <TableHead className="hidden lg:table-cell px-4 py-3 text-right">Size</TableHead>
              <TableHead className="w-12 px-3 py-3" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => {
              if (item.type === "folder") {
                return (
                  <FolderRow
                    key={item.path}
                    item={item}
                    onFolderClick={onFolderClick}
                    onDropOnFolder={onDropOnFolder}
                    onMoveFile={onMoveFile}
                    onDeleteFile={onDeleteFile}
                  />
                )
              }
              return (
                <FileRow
                  key={item.data.id}
                  file={item.data}
                  isSelected={selectedFileIds.has(item.data.id)}
                  onSelectionChange={onFileSelectionChange}
                  onFileClick={onFileClick}
                  onRenameFile={onRenameFile}
                  onMoveFile={onMoveFile}
                  onDeleteFile={onDeleteFile}
                  onViewActivity={onViewActivity}
                  onShareFile={onShareFile}
                  onFileDragStart={onFileDragStart}
                  onFileDragEnd={onFileDragEnd}
                />
              )
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sheets Table
// ---------------------------------------------------------------------------

export function SheetsTable({
  sheets,
  isLoading,
  onSheetClick,
  onEditSheet,
  onDeleteSheet,
  onAddVersion,
}: SheetsTableProps) {
  if (isLoading) {
    return <TableSkeleton rows={6} cols={7} />
  }

  if (sheets.length === 0) {
    return null
  }

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="divide-x">
              <TableHead className="w-16 px-4 py-3">Preview</TableHead>
              <TableHead className="min-w-[200px] px-4 py-3">Sheet</TableHead>
              <TableHead className="hidden lg:table-cell px-4 py-3">Discipline</TableHead>
              <TableHead className="hidden md:table-cell px-4 py-3">Modified</TableHead>
              <TableHead className="hidden xl:table-cell px-4 py-3">Modified by</TableHead>
              <TableHead className="hidden md:table-cell px-4 py-3">Revision</TableHead>
              <TableHead className="w-12 px-3 py-3" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sheets.map((sheet) => (
              <SheetRow
                key={sheet.id}
                sheet={sheet}
                onOpen={onSheetClick}
                onEdit={onEditSheet}
                onDelete={onDeleteSheet}
                onAddVersion={onAddVersion}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Row Components
// ---------------------------------------------------------------------------

const FolderRow = memo(function FolderRow({
  item,
  onFolderClick,
  onDropOnFolder,
  onMoveFile: _onMoveFile,
  onDeleteFile: _onDeleteFile,
}: {
  item: Extract<DocumentTableItem, { type: "folder" }>
  onFolderClick: (path: string) => void
  onDropOnFolder: (path: string) => void
  onMoveFile: (fileId: string) => void
  onDeleteFile: (fileId: string) => void
}) {
  return (
    <TableRow
      className="divide-x cursor-pointer hover:bg-muted/50 transition-colors"
      onClick={() => onFolderClick(item.path)}
      onDragOver={(event) => {
        event.preventDefault()
      }}
      onDrop={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onDropOnFolder(item.path)
      }}
    >
      <TableCell className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          aria-label={`Select folder ${item.name}`}
          disabled
        />
      </TableCell>
      <TableCell className="px-4 py-3" colSpan={5}>
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-amber-50 dark:bg-amber-950/30">
            <FolderOpen className="h-4.5 w-4.5 text-amber-600 dark:text-amber-500" />
          </div>
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-medium">{item.name}</span>
            <span className="text-sm text-muted-foreground">
              {item.itemCount} {item.itemCount === 1 ? "item" : "items"}
            </span>
          </div>
        </div>
      </TableCell>
      <TableCell className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={() => onFolderClick(item.path)}>
              <FolderOpenDot className="h-4 w-4 mr-2" />
              Open
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onDropOnFolder(item.path)}>
              <FolderInput className="h-4 w-4 mr-2" />
              Move files here
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              disabled
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete folder
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  )
})

const FileRow = memo(function FileRow({
  file,
  isSelected,
  onSelectionChange,
  onFileClick,
  onRenameFile,
  onMoveFile,
  onDeleteFile,
  onViewActivity,
  onShareFile,
  onFileDragStart,
  onFileDragEnd,
}: {
  file: FileWithUrls
  isSelected: boolean
  onSelectionChange: (fileId: string, selected: boolean) => void
  onFileClick: (fileId: string) => void
  onRenameFile: (fileId: string) => void
  onMoveFile: (fileId: string) => void
  onDeleteFile: (fileId: string) => void
  onViewActivity: (fileId: string) => void
  onShareFile: (fileId: string) => void
  onFileDragStart: (fileId: string, event: React.DragEvent<HTMLDivElement>) => void
  onFileDragEnd: (fileId: string) => void
}) {
  const Icon = getFileIcon(file.mime_type ?? undefined)
  const isImage = file.mime_type?.startsWith("image/")
  const thumbnailUrl = file.thumbnail_url ?? (isImage ? file.download_url : undefined)

  return (
    <TableRow
      className={cn(
        "divide-x cursor-pointer hover:bg-muted/50 transition-colors",
        isSelected && "bg-primary/5",
      )}
      data-state={isSelected ? "selected" : undefined}
      onClick={() => onFileClick(file.id)}
      draggable
      onDragStart={(event) => onFileDragStart(file.id, event as unknown as React.DragEvent<HTMLDivElement>)}
      onDragEnd={() => onFileDragEnd(file.id)}
    >
      <TableCell className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={isSelected}
          onCheckedChange={(value) => onSelectionChange(file.id, Boolean(value))}
          aria-label={`Select ${file.file_name}`}
        />
      </TableCell>
      <TableCell className="px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
            {isImage && thumbnailUrl ? (
              <img
                src={thumbnailUrl}
                alt={file.file_name}
                className="h-full w-full object-cover"
                loading="lazy"
              />
            ) : (
              <Icon className="h-4 w-4 text-muted-foreground" />
            )}
          </div>
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="font-medium truncate">{file.file_name}</span>
            <div className="flex items-center gap-1.5 sm:hidden">
              {file.category && (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-[18px]">
                  {file.category}
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">{formatFileSize(file.size_bytes)}</span>
            </div>
          </div>
        </div>
      </TableCell>
      <TableCell className="hidden sm:table-cell px-4 py-3">
        {file.category ? (
          <Badge variant="secondary" className="text-xs px-2 py-0.5 capitalize">
            {file.category}
          </Badge>
        ) : (
          <span className="text-sm text-muted-foreground">-</span>
        )}
      </TableCell>
      <TableCell className="hidden md:table-cell px-4 py-3 text-sm text-muted-foreground">
        {formatDate(file.updated_at ?? file.created_at)}
      </TableCell>
      <TableCell className="hidden lg:table-cell px-4 py-3 text-sm text-muted-foreground">
        <span className="truncate block max-w-[140px]">
          {file.uploader_name ?? "Unknown"}
        </span>
      </TableCell>
      <TableCell className="hidden lg:table-cell px-4 py-3 text-right text-sm text-muted-foreground tabular-nums">
        {formatFileSize(file.size_bytes)}
      </TableCell>
      <TableCell className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={() => onViewActivity(file.id)}>
              <Activity className="h-4 w-4 mr-2" />
              Timeline
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onRenameFile(file.id)}>
              <Pencil className="h-4 w-4 mr-2" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onMoveFile(file.id)}>
              <FolderInput className="h-4 w-4 mr-2" />
              Move
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onShareFile(file.id)}>
              <Share2 className="h-4 w-4 mr-2" />
              Share
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => onDeleteFile(file.id)}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  )
})

const SheetRow = memo(function SheetRow({
  sheet,
  onOpen,
  onEdit,
  onDelete,
  onAddVersion,
}: {
  sheet: DrawingSheet
  onOpen?: (sheet: DrawingSheet) => void
  onEdit: (sheet: DrawingSheet) => void
  onDelete: (sheet: DrawingSheet) => void
  onAddVersion: (sheet: DrawingSheet) => void
}) {
  const thumbnail = sheet.image_thumbnail_url ?? null
  const sheetNumber = getDisplaySheetNumber(sheet)
  const lastModifiedBy =
    sheet.last_modified_by_name ??
    sheet.current_revision_creator_name ??
    "System"

  return (
    <TableRow
      className={cn("divide-x hover:bg-muted/50 transition-colors", onOpen && "cursor-pointer")}
      onClick={() => onOpen?.(sheet)}
    >
      <TableCell className="px-4 py-3">
        <div className="h-10 w-14 overflow-hidden rounded border bg-muted/40">
          {thumbnail ? (
            <img
              src={thumbnail}
              alt={sheet.sheet_number}
              className="h-full w-full object-cover"
              loading="lazy"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-[9px] text-muted-foreground">
              No thumb
            </div>
          )}
        </div>
      </TableCell>
      <TableCell className="px-4 py-3">
        <div className="flex flex-col gap-0.5">
          <span className="font-semibold">{sheetNumber}</span>
          <span className="text-sm text-muted-foreground truncate max-w-[280px]">
            {sheet.sheet_title || "Untitled sheet"}
          </span>
        </div>
      </TableCell>
      <TableCell className="hidden lg:table-cell px-4 py-3">
        {sheet.discipline ? (
          <Badge variant="secondary" className="text-xs px-2 py-0.5">
            {sheet.discipline}
          </Badge>
        ) : (
          <span className="text-sm text-muted-foreground">-</span>
        )}
      </TableCell>
      <TableCell className="hidden md:table-cell px-4 py-3 text-sm text-muted-foreground">
        {formatDate(sheet.updated_at)}
      </TableCell>
      <TableCell className="hidden xl:table-cell px-4 py-3 text-sm text-muted-foreground">
        <span className="truncate block max-w-[140px]">{lastModifiedBy}</span>
      </TableCell>
      <TableCell className="hidden md:table-cell px-4 py-3">
        {sheet.current_revision_label ? (
          <Badge variant="outline" className="text-xs px-2 py-0.5">
            {sheet.current_revision_label}
          </Badge>
        ) : (
          <span className="text-sm text-muted-foreground">-</span>
        )}
      </TableCell>
      <TableCell className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={() => onEdit(sheet)}>
              <Pencil className="mr-2 h-4 w-4" />
              Edit sheet
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onAddVersion(sheet)}>
              <FilePlus2 className="mr-2 h-4 w-4" />
              Add version
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => onDelete(sheet)}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete sheet
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  )
})

// ---------------------------------------------------------------------------
// Shared components
// ---------------------------------------------------------------------------

function TableSkeleton({ rows, cols }: { rows: number; cols: number }) {
  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="divide-x">
              {Array.from({ length: cols }).map((_, i) => (
                <TableHead key={i} className="px-4 py-3">
                  <Skeleton className="h-3 w-16" />
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: rows }).map((_, i) => (
              <TableRow key={i} className="divide-x">
                <TableCell className="px-3 py-3">
                  <Skeleton className="h-4 w-4 rounded" />
                </TableCell>
                <TableCell className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Skeleton className="h-9 w-9 rounded-md shrink-0" />
                    <Skeleton className="h-4 w-40" />
                  </div>
                </TableCell>
                {Array.from({ length: cols - 2 }).map((_, j) => (
                  <TableCell key={j} className="px-4 py-3 hidden md:table-cell">
                    <Skeleton className="h-3 w-16" />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function EmptyState({
  hasFilters,
  onUploadClick,
}: {
  hasFilters?: boolean
  onUploadClick: () => void
}) {
  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <Table>
        <TableBody>
          <TableRow>
            <TableCell colSpan={7} className="py-16">
              <div
                className="flex cursor-pointer flex-col items-center gap-4"
                onClick={onUploadClick}
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                  {hasFilters ? (
                    <FileText className="h-6 w-6 text-muted-foreground" />
                  ) : (
                    <Upload className="h-6 w-6 text-muted-foreground" />
                  )}
                </div>
                <div className="text-center">
                  <p className="font-medium">
                    {hasFilters ? "No files found" : "No documents yet"}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {hasFilters
                      ? "Try adjusting your filters or search query."
                      : "Drag and drop files here, or click to upload."}
                  </p>
                </div>
                {!hasFilters && (
                  <Button variant="outline">
                    <Upload className="mr-2 h-4 w-4" />
                    Upload Files
                  </Button>
                )}
              </div>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  )
}
