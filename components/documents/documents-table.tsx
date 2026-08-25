"use client"

import { memo, useMemo } from "react"
import { useRouter } from "next/navigation"
import { useDraggable } from "@dnd-kit/core"
import { cn } from "@/lib/utils"
import {
  FileText,
  FolderOpen,
  GripVertical,
  MoreHorizontal,
  Pencil,
  FolderInput,
  Trash2,
  Activity,
  Share2,
  FilePlus2,
  Upload,
  FolderOpenDot,
  Eye,
  FileSignature,
  Clock,
  AlertCircle,
  Info,
  Download,
  Link2,
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  Undo2,
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { FileWithUrls } from "@/app/(app)/documents/types"
import { useDocuments } from "./documents-context"
import {
  FileSharingBadges,
  FileSignatureBadge,
  FileStatusBadge,
  FileVersionBadge,
  getFolderSharingState,
  getPrimarySourceContext,
} from "./file-badges"
import { FileThumbnail } from "./file-type-icon"
import { useDocumentsDrag, useFolderDropTarget } from "./documents-dnd"
import { formatFileSize, formatRelativeDate, formatShortDate } from "./format"
import { QUICK_FILTER_CONFIG, type QuickFilter } from "./types"
import { useProductTerminology } from "@/components/layout/use-product-terminology"

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------


function getCategoryLabel(category?: string | null): string {
  if (!category) return "-"
  return QUICK_FILTER_CONFIG[category as QuickFilter]?.label ?? category
}

function getDueBadge(file: FileWithUrls) {
  if (!file.due_at) return null

  const dueDate = new Date(file.due_at)
  if (Number.isNaN(dueDate.getTime())) return null

  const diffDays = Math.ceil((dueDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
  const detail = `Due ${formatShortDate(file.due_at)}`

  if (diffDays < 0) {
    return {
      label: "Overdue",
      detail,
      variantClass: "border-destructive/30 bg-destructive/10 text-destructive",
      Icon: AlertCircle,
    }
  }

  if (diffDays === 0) {
    return {
      label: "Due today",
      detail,
      variantClass: "border-warning/30 bg-warning/10 text-warning",
      Icon: Clock,
    }
  }

  if (diffDays <= 30) {
    return {
      label: `${diffDays}d`,
      detail,
      variantClass: "border-warning/30 bg-warning/10 text-warning",
      Icon: Clock,
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The lead column carries the drag handle and the checkbox, plus a transparent
 * left rule that a drop target colours in. Header, folder rows and file rows all
 * use it so the checkboxes stay on one axis and nothing shifts on hover.
 */
const LEAD_CELL_CLASS = "w-[52px] border-l-2 border-l-transparent pl-2.5 pr-1"

export type DocumentTableItem =
  | { type: "file"; data: FileWithUrls }
  | { type: "folder"; path: string; name: string; itemCount: number }

export interface DocumentsFileTableProps {
  items: DocumentTableItem[]
  isLoading?: boolean
  selectedFileIds: Set<string>
  selectedFolderPaths: Set<string>
  allVisibleSelected: boolean
  visibleFileIds: string[]
  onSelectAllVisibleFiles: (fileIds: string[], selected: boolean) => void
  onFileSelectionChange: (fileId: string, selected: boolean) => void
  onFolderSelectionChange: (path: string, selected: boolean) => void
  onFileClick: (fileId: string) => void
  onDownloadFile: (fileId: string) => void
  onFolderClick: (path: string) => void
  onRenameFolder?: (path: string) => void
  onShareFolder?: (path: string) => void
  onDeleteFolder?: (path: string) => void
  onUploadClick: () => void
  /** External OS files dropped onto a folder row. Internal moves go through dnd-kit. */
  onUploadToFolder: (path: string, files: File[]) => void
  onRenameFile: (fileId: string) => void
  onMoveFile: (fileId: string) => void
  onDeleteFile: (fileId: string) => void
  onRestoreFile?: (fileId: string) => void
  onViewActivity: (fileId: string) => void
  onShareFile: (fileId: string) => void
  onUploadNewVersion: (fileId: string) => void
  onSendForSignature?: (fileId: string) => void
  onOpenProperties: (fileId: string) => void
  hasFilters?: boolean
}

type SortableFileColumn = "name" | "workflow" | "updated_at" | "size"

function SortableTableHead({
  label,
  sortKey,
  currentSort,
  direction,
  onSort,
  className,
  align = "left",
}: {
  label: string
  sortKey: SortableFileColumn
  currentSort: "name" | "workflow" | "updated_at" | "created_at" | "size"
  direction: "asc" | "desc"
  onSort: (sortKey: SortableFileColumn) => void
  className?: string
  align?: "left" | "right"
}) {
  const isActive = currentSort === sortKey
  const Icon = !isActive ? ArrowUpDown : direction === "asc" ? ChevronUp : ChevronDown

  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "flex w-full items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
          align === "right" ? "justify-end text-right" : "justify-start text-left",
        )}
        aria-label={`Sort by ${label}`}
      >
        <span>{label}</span>
        <Icon className={cn("h-3.5 w-3.5 shrink-0", !isActive && "opacity-50")} />
      </button>
    </TableHead>
  )
}

// ---------------------------------------------------------------------------
// Files Table
// ---------------------------------------------------------------------------

export function DocumentsFileTable({
  items,
  isLoading,
  selectedFileIds,
  selectedFolderPaths,
  allVisibleSelected,
  visibleFileIds,
  onSelectAllVisibleFiles,
  onFileSelectionChange,
  onFolderSelectionChange,
  onFileClick,
  onDownloadFile,
  onFolderClick,
  onRenameFolder,
  onShareFolder,
  onDeleteFolder,
  onUploadClick,
  onUploadToFolder,
  onRenameFile,
  onMoveFile,
  onDeleteFile,
  onRestoreFile,
  onViewActivity,
  onShareFile,
  onUploadNewVersion,
  onSendForSignature,
  onOpenProperties,
  hasFilters,
}: DocumentsFileTableProps) {
  const { sort, direction, toggleSort } = useDocuments()
  const { draggedFileIds } = useDocumentsDrag()

  // A row that is part of the current selection drags the whole selection, so
  // the payload it hands dnd-kit has to be the resolved list, not its own id.
  const selectedFileIdList = useMemo(() => Array.from(selectedFileIds), [selectedFileIds])
  const dragSourceIds = useMemo(() => new Set(draggedFileIds), [draggedFileIds])

  if (isLoading && items.length === 0) {
    return <TableSkeleton rows={10} cols={8} />
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
    <Table className="table-fixed min-w-[960px]">
      <TableHeader>
        <TableRow className="bg-muted/40 hover:bg-muted/40">
          <TableHead className={LEAD_CELL_CLASS}>
            {visibleFileIds.length > 0 && (
              <div className="flex items-center gap-1">
                <span className="w-4 shrink-0" aria-hidden />
                <Checkbox
                  checked={allVisibleSelected}
                  onCheckedChange={(value) =>
                    onSelectAllVisibleFiles(visibleFileIds, Boolean(value))
                  }
                  aria-label="Select all visible files"
                  className="h-3.5 w-3.5"
                />
              </div>
            )}
          </TableHead>
          <SortableTableHead
            label="Name"
            sortKey="name"
            currentSort={sort}
            direction={direction}
            onSort={toggleSort}
            className="w-[40%] min-w-[320px]"
          />
          <TableHead className="hidden sm:table-cell w-[128px]">Category</TableHead>
          <SortableTableHead
            label="Workflow"
            sortKey="workflow"
            currentSort={sort}
            direction={direction}
            onSort={toggleSort}
            className="hidden md:table-cell w-[184px]"
          />
          <TableHead className="hidden lg:table-cell w-[128px]">Shared</TableHead>
          <SortableTableHead
            label="Modified"
            sortKey="updated_at"
            currentSort={sort}
            direction={direction}
            onSort={toggleSort}
            className="hidden md:table-cell w-[112px]"
          />
          <SortableTableHead
            label="Size"
            sortKey="size"
            currentSort={sort}
            direction={direction}
            onSort={toggleSort}
            className="hidden xl:table-cell w-[88px] text-right"
            align="right"
          />
          <TableHead className="w-[92px] pr-4" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => {
          if (item.type === "folder") {
            return (
              <FolderRow
                key={item.path}
                item={item}
                isSelected={selectedFolderPaths.has(item.path)}
                onSelectionChange={onFolderSelectionChange}
                onFolderClick={onFolderClick}
                onUploadToFolder={onUploadToFolder}
                onRenameFolder={onRenameFolder}
                onShareFolder={onShareFolder}
                onDeleteFolder={onDeleteFolder}
              />
            )
          }
          return (
            <FileRow
              key={item.data.id}
              file={item.data}
              isSelected={selectedFileIds.has(item.data.id)}
              isDragSource={dragSourceIds.has(item.data.id)}
              dragFileIds={
                selectedFileIds.has(item.data.id) && selectedFileIdList.length > 1
                  ? selectedFileIdList
                  : undefined
              }
              onSelectionChange={onFileSelectionChange}
              onFileClick={onFileClick}
              onDownloadFile={onDownloadFile}
              onRenameFile={onRenameFile}
              onMoveFile={onMoveFile}
              onDeleteFile={onDeleteFile}
              onRestoreFile={onRestoreFile}
              onViewActivity={onViewActivity}
              onShareFile={onShareFile}
              onUploadNewVersion={onUploadNewVersion}
              onSendForSignature={onSendForSignature}
              onOpenProperties={onOpenProperties}
            />
          )
        })}
      </TableBody>
    </Table>
  )
}

// ---------------------------------------------------------------------------
// Row Components
// ---------------------------------------------------------------------------

const FolderRow = memo(function FolderRow({
  item,
  isSelected,
  onSelectionChange,
  onFolderClick,
  onUploadToFolder,
  onRenameFolder,
  onShareFolder,
  onDeleteFolder,
}: {
  item: Extract<DocumentTableItem, { type: "folder" }>
  isSelected: boolean
  onSelectionChange: (path: string, selected: boolean) => void
  onFolderClick: (path: string) => void
  onUploadToFolder: (path: string, files: File[]) => void
  onRenameFolder?: (path: string) => void
  onShareFolder?: (path: string) => void
  onDeleteFolder?: (path: string) => void
}) {
  const { folderPermissions } = useDocuments()
  const terms = useProductTerminology()
  const folderSharing = getFolderSharingState(folderPermissions, item.path)
  const { setNodeRef, isOver, isBlocked } = useFolderDropTarget("table", item.path)

  return (
    <TableRow
      ref={setNodeRef}
      className={cn(
        "group cursor-pointer hover:bg-muted/30",
        isSelected && "bg-primary/5",
        isBlocked && "opacity-40",
        isOver && "bg-primary/15 hover:bg-primary/15",
      )}
      data-state={isSelected ? "selected" : undefined}
      onClick={() => onFolderClick(item.path)}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        // Only OS files reach this path — internal moves never touch the
        // native drag API, so there is nothing here to disambiguate.
        const droppedFiles = Array.from(event.dataTransfer.files)
        if (droppedFiles.length === 0) return
        event.preventDefault()
        event.stopPropagation()
        onUploadToFolder(item.path, droppedFiles)
      }}
    >
      <TableCell className={cn(LEAD_CELL_CLASS, isOver && "border-l-primary")}>
        <div
          className="flex h-8 items-center gap-1"
          onClick={(event) => event.stopPropagation()}
        >
          <span className="w-4 shrink-0" aria-hidden />
          <Checkbox
            checked={isSelected}
            onCheckedChange={(value) => onSelectionChange(item.path, Boolean(value))}
            aria-label={`Select folder ${item.name}`}
            className="h-3.5 w-3.5"
          />
        </div>
      </TableCell>
      <TableCell className="min-w-0">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center bg-muted transition-colors duration-150",
              isOver && "bg-primary/20",
            )}
          >
            <FolderOpen
              className={cn("h-4 w-4", isOver ? "text-primary" : "text-muted-foreground")}
            />
          </div>
          <div className="min-w-0 flex-1">
            <span className={cn("block truncate text-sm font-medium", isOver && "text-primary")}>
              {item.name}
            </span>
            <span className="block text-xs text-muted-foreground sm:hidden">
              {item.itemCount} {item.itemCount === 1 ? "item" : "items"}
            </span>
          </div>
        </div>
      </TableCell>
      <TableCell className="hidden sm:table-cell w-[128px]">
        <span className="text-xs text-muted-foreground">Folder</span>
      </TableCell>
      <TableCell className="hidden md:table-cell w-[184px]">
        <span className="text-xs text-muted-foreground">
          {item.itemCount} {item.itemCount === 1 ? "item" : "items"}
        </span>
      </TableCell>
      <TableCell className="hidden lg:table-cell w-[128px]">
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <FileSharingBadges
            clients={folderSharing.share_with_clients}
            subs={folderSharing.share_with_subs}
            clientsLabel={terms.owners}
            tooltips={{
              private: "New files in this folder default to internal visibility",
              clients: folderSharing.inherited
                ? `Inherited ${terms.owner.toLowerCase()} sharing default`
                : `New files default to ${terms.ownerPortal} visibility`,
              subs: folderSharing.inherited
                ? "Inherited subcontractor sharing default"
                : "New files default to Subcontractor Portal visibility",
            }}
          />
        </div>
      </TableCell>
      <TableCell className="hidden md:table-cell w-[112px]">
        <span className="text-xs text-muted-foreground">-</span>
      </TableCell>
      <TableCell className="hidden xl:table-cell w-[88px] text-right">
        <span className="text-xs text-muted-foreground">-</span>
      </TableCell>
      <TableCell className="w-[92px] pr-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
            onClick={() => onFolderClick(item.path)}
          >
            Open
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity">
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => onFolderClick(item.path)}>
                <FolderOpenDot className="h-4 w-4 mr-2" />
                Open
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onRenameFolder?.(item.path)}>
                <Pencil className="h-4 w-4 mr-2" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onShareFolder?.(item.path)}>
                <Share2 className="h-4 w-4 mr-2" />
                Sharing defaults
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => onDeleteFolder?.(item.path)}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete folder
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </TableCell>
    </TableRow>
  )
})

const FileRow = memo(function FileRow({
  file,
  isSelected,
  isDragSource,
  dragFileIds,
  onSelectionChange,
  onFileClick,
  onDownloadFile,
  onRenameFile,
  onMoveFile,
  onDeleteFile,
  onRestoreFile,
  onViewActivity,
  onShareFile,
  onUploadNewVersion,
  onSendForSignature,
  onOpenProperties,
}: {
  file: FileWithUrls
  isSelected: boolean
  /** This row is one of the files currently in hand, so it reads as lifted. */
  isDragSource: boolean
  /** Set when the row belongs to a multi-file selection that drags as one. */
  dragFileIds?: string[]
  onSelectionChange: (fileId: string, selected: boolean) => void
  onFileClick: (fileId: string) => void
  onDownloadFile: (fileId: string) => void
  onRenameFile: (fileId: string) => void
  onMoveFile: (fileId: string) => void
  onDeleteFile: (fileId: string) => void
  onRestoreFile?: (fileId: string) => void
  onViewActivity: (fileId: string) => void
  onShareFile: (fileId: string) => void
  onUploadNewVersion: (fileId: string) => void
  onSendForSignature?: (fileId: string) => void
  onOpenProperties: (fileId: string) => void
}) {
  const terms = useProductTerminology()
  const router = useRouter()
  const primarySource = getPrimarySourceContext(file)
  const hasSourceHref = Boolean(primarySource?.href)
  const isArchived = Boolean(file.archived_at)
  const dueBadge = getDueBadge(file)
  const DueIcon = dueBadge?.Icon
  const hasWorkflowState = Boolean(
    (file.status && file.status !== "draft") ||
      file.signature_status ||
      file.version_number ||
      dueBadge,
  )

  // Trashed files have no Move action either — there is nowhere to put them
  // until they are restored.
  const { attributes, listeners, setNodeRef, setActivatorNodeRef } = useDraggable({
    id: file.id,
    disabled: isArchived,
    data: { fileIds: dragFileIds ?? [file.id], primaryFileName: file.file_name },
    attributes: { roleDescription: "draggable file" },
  })

  return (
    <TableRow
      ref={setNodeRef}
      className={cn(
        "group cursor-pointer",
        isSelected && "bg-primary/5",
        isDragSource && "opacity-40",
      )}
      data-state={isSelected ? "selected" : undefined}
      onClick={() => onFileClick(file.id)}
      // The pointer sensor only arms here; it needs 4px of travel before it
      // takes over, so a plain click still opens the file and dnd-kit swallows
      // the trailing click once a drag has actually started.
      {...listeners}
    >
      <TableCell className={LEAD_CELL_CLASS}>
        <div className="flex items-center gap-1">
          {isArchived ? (
            <span className="w-4 shrink-0" aria-hidden />
          ) : (
            <button
              type="button"
              ref={setActivatorNodeRef}
              {...attributes}
              aria-label={`Move ${file.file_name} to another folder`}
              onClick={(event) => event.stopPropagation()}
              className="inline-flex w-4 shrink-0 cursor-grab items-center justify-center text-muted-foreground opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover:opacity-100"
            >
              <GripVertical className="h-3.5 w-3.5" />
            </button>
          )}
          <span
            className="inline-flex"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Checkbox
              checked={isSelected}
              onCheckedChange={(value) => onSelectionChange(file.id, Boolean(value))}
              aria-label={`Select ${file.file_name}`}
              className="h-3.5 w-3.5"
            />
          </span>
        </div>
      </TableCell>
      <TableCell className="min-w-0">
        <div className="flex items-center gap-3">
          <FileThumbnail
            fileName={file.file_name}
            mimeType={file.mime_type}
            thumbnailUrl={file.thumbnail_url}
            className="h-8 w-8"
          />
          <div className="min-w-0 flex-1">
            <span className="text-sm font-medium truncate block">{file.file_name}</span>
            <div className="flex items-center gap-1.5 sm:hidden mt-0.5">
              {file.category && (
                <span className="text-[11px] text-muted-foreground capitalize">
                  {getCategoryLabel(file.category)}
                </span>
              )}
              <span className="text-[11px] tabular-nums text-muted-foreground">{formatFileSize(file.size_bytes)}</span>
            </div>
          </div>
        </div>
      </TableCell>
      <TableCell className="hidden sm:table-cell w-[128px]">
        {file.category ? (
          <div className="truncate text-xs text-muted-foreground">
            {getCategoryLabel(file.category)}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">-</span>
        )}
      </TableCell>
      <TableCell className="hidden md:table-cell w-[184px]">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-1">
          <FileStatusBadge status={file.status} />
          <FileSignatureBadge status={file.signature_status} />
          {file.version_number ? (
            <FileVersionBadge
              versionNumber={file.version_number}
              isCurrent={Boolean(file.is_current)}
            />
          ) : null}
          {dueBadge && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="outline"
                    className={cn("text-[10px] px-1 py-0 h-4 font-normal", dueBadge.variantClass)}
                  >
                    {DueIcon && <DueIcon className="h-2.5 w-2.5 mr-1" />}
                    {dueBadge.label}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="text-xs">{dueBadge.detail}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {!hasWorkflowState && <span className="text-xs text-muted-foreground">-</span>}
          </div>
        </div>
      </TableCell>
      <TableCell className="hidden lg:table-cell w-[128px]">
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <FileSharingBadges
            clients={file.share_with_clients}
            subs={file.share_with_subs}
            clientsLabel={terms.owners}
            tooltips={{
              private: "Only internal team members can see this",
              clients: `Visible in ${terms.ownerPortal}`,
              subs: "Visible in Subcontractor Portal",
            }}
          />
        </div>
      </TableCell>
      <TableCell className="hidden md:table-cell w-[112px] text-xs text-muted-foreground">
        {formatRelativeDate(file.updated_at ?? file.created_at)}
      </TableCell>
      <TableCell className="hidden xl:table-cell w-[88px] text-right text-xs text-muted-foreground tabular-nums">
        {formatFileSize(file.size_bytes)}
      </TableCell>
      <TableCell
        className="w-[92px] pr-4"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 sm:opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={() => onOpenProperties(file.id)}
            title="Open properties"
          >
            <Info className="h-3.5 w-3.5" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity">
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => onOpenProperties(file.id)}>
                <Info className="h-4 w-4 mr-2" />
                Properties
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onFileClick(file.id)}>
                <Eye className="h-4 w-4 mr-2" />
                Preview
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onDownloadFile(file.id)}>
                <Download className="h-4 w-4 mr-2" />
                Download
              </DropdownMenuItem>
              {!isArchived && (
                <DropdownMenuItem onClick={() => onUploadNewVersion(file.id)}>
                  <FilePlus2 className="h-4 w-4 mr-2" />
                  Upload new version...
                </DropdownMenuItem>
              )}
              {!isArchived && file.mime_type === "application/pdf" && (
                <DropdownMenuItem onClick={() => onSendForSignature?.(file.id)}>
                  <FileSignature className="h-4 w-4 mr-2" />
                  Sign...
                </DropdownMenuItem>
              )}
              {file.signature_status && (
                <DropdownMenuItem onClick={() => router.push(`/projects/${file.project_id}/signatures?search=${file.id}`)}>
                  <FileSignature className="h-4 w-4 mr-2" />
                  View signature...
                </DropdownMenuItem>
              )}
              {hasSourceHref && (
                <DropdownMenuItem onClick={() => primarySource?.href && router.push(primarySource.href)}>
                  <Link2 className="h-4 w-4 mr-2" />
                  {primarySource?.primary_action_label ?? "Open source"}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onViewActivity(file.id)}>
                <Activity className="h-4 w-4 mr-2" />
                Timeline
              </DropdownMenuItem>
              {isArchived ? (
                <DropdownMenuItem onClick={() => onRestoreFile?.(file.id)}>
                  <Undo2 className="h-4 w-4 mr-2" />
                  Restore
                </DropdownMenuItem>
              ) : (
                <>
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
                </>
              )}
              {!isArchived && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => onDeleteFile(file.id)}
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Move to trash
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </TableCell>
    </TableRow>
  )
})

// ---------------------------------------------------------------------------
// Shared components
// ---------------------------------------------------------------------------

function TableSkeleton({ rows, cols }: { rows: number; cols: number }) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="bg-muted/40 hover:bg-muted/40">
          {Array.from({ length: cols }).map((_, i) => (
            <TableHead key={i}>
              <Skeleton className="h-3 w-14" />
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {Array.from({ length: rows }).map((_, i) => (
          <TableRow key={i}>
            <TableCell className={LEAD_CELL_CLASS}>
              <div className="flex items-center gap-1">
                <span className="w-4 shrink-0" aria-hidden />
                <Skeleton className="h-3.5 w-3.5" />
              </div>
            </TableCell>
            <TableCell>
              <div className="flex items-center gap-3">
                <Skeleton className="h-8 w-8 shrink-0" />
                <Skeleton className="h-3.5 w-36" />
              </div>
            </TableCell>
            {Array.from({ length: cols - 2 }).map((_, j) => (
              <TableCell key={j} className="hidden md:table-cell">
                <Skeleton className="h-3 w-14" />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function EmptyState({
  hasFilters,
  onUploadClick,
}: {
  hasFilters?: boolean
  onUploadClick: () => void
}) {
  const { currentPath, setQuickFilter, setSearchQuery, navigateToRoot } = useDocuments()

  // `hasFilters` counts the open folder as a filter, so clearing has to leave it too.
  const clearFilters = () => {
    setSearchQuery("")
    if (currentPath) {
      navigateToRoot()
      return
    }
    setQuickFilter("all")
  }

  return (
    <div
      className="flex flex-col items-center justify-center gap-3 py-24 px-4"
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        {hasFilters ? (
          <FileText className="h-6 w-6 text-muted-foreground" />
        ) : (
          <Upload className="h-6 w-6 text-muted-foreground" />
        )}
      </div>
      <div className="text-center max-w-[400px]">
        <p className="font-medium">
          {hasFilters ? "No files found" : "No documents yet"}
        </p>
        <p className="text-sm text-muted-foreground mt-0.5">
          {hasFilters
            ? "Try adjusting your filters or search query."
            : "Upload drawings, contracts, photos, permits, and closeout files for this project."}
        </p>
      </div>
      <div className="mt-2">
        {hasFilters ? (
          <Button variant="outline" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        ) : (
          <Button variant="default" size="sm" onClick={onUploadClick}>
            <Upload className="mr-2 h-4 w-4" />
            Upload documents
          </Button>
        )}
      </div>
    </div>
  )
}
