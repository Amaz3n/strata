"use client"

import { memo } from "react"
import { useRouter } from "next/navigation"
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
  Globe,
  HardHat,
  Lock,
  Users,
  Eye,
  FileSignature,
  Clock,
  CheckCircle2,
  AlertCircle,
  Info,
  ShieldCheck,
  Download,
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
import type { FileWithUrls } from "@/app/(app)/documents/actions"
import type { DrawingSheet } from "@/app/(app)/drawings/actions"
import { QUICK_FILTER_CONFIG, type QuickFilter } from "./types"

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

function getCategoryLabel(category?: string | null): string {
  if (!category) return "-"
  return QUICK_FILTER_CONFIG[category as QuickFilter]?.label ?? category
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
  selectedFolderPaths: Set<string>
  allVisibleSelected: boolean
  visibleFileIds: string[]
  onSelectAllVisibleFiles: (fileIds: string[], selected: boolean) => void
  onFileSelectionChange: (fileId: string, selected: boolean) => void
  onFolderSelectionChange: (path: string, selected: boolean) => void
  onFileClick: (fileId: string) => void
  onDownloadFile: (fileId: string) => void
  onFolderClick: (path: string) => void
  onUploadClick: () => void
  onDropOnFolder: (path: string) => void
  onRenameFile: (fileId: string) => void
  onMoveFile: (fileId: string) => void
  onDeleteFile: (fileId: string) => void
  onViewActivity: (fileId: string) => void
  onShareFile: (fileId: string) => void
  onUploadNewVersion: (fileId: string) => void
  onSendForSignature?: (fileId: string) => void
  onSendForApproval?: (fileId: string) => void
  onOpenProperties: (fileId: string) => void
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
  selectedFolderPaths,
  allVisibleSelected,
  visibleFileIds,
  onSelectAllVisibleFiles,
  onFileSelectionChange,
  onFolderSelectionChange,
  onFileClick,
  onDownloadFile,
  onFolderClick,
  onUploadClick,
  onDropOnFolder,
  onRenameFile,
  onMoveFile,
  onDeleteFile,
  onViewActivity,
  onShareFile,
  onUploadNewVersion,
  onSendForSignature,
  onSendForApproval,
  onOpenProperties,
  onFileDragStart,
  onFileDragEnd,
  hasFilters,
}: DocumentsFileTableProps) {
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
          <TableHead className="w-11 pl-4 pr-2">
            {visibleFileIds.length > 0 && (
              <Checkbox
                checked={allVisibleSelected}
                onCheckedChange={(value) =>
                  onSelectAllVisibleFiles(visibleFileIds, Boolean(value))
                }
                aria-label="Select all visible files"
                className="h-3.5 w-3.5"
              />
            )}
          </TableHead>
          <TableHead className="w-[40%] min-w-[320px]">Name</TableHead>
          <TableHead className="hidden sm:table-cell w-[128px]">Category</TableHead>
          <TableHead className="hidden md:table-cell w-[184px]">Workflow</TableHead>
          <TableHead className="hidden lg:table-cell w-[128px]">Shared</TableHead>
          <TableHead className="hidden md:table-cell w-[112px]">Modified</TableHead>
          <TableHead className="hidden xl:table-cell w-[88px] text-right">Size</TableHead>
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
                onDropOnFolder={onDropOnFolder}
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
              onDownloadFile={onDownloadFile}
              onRenameFile={onRenameFile}
              onMoveFile={onMoveFile}
              onDeleteFile={onDeleteFile}
              onViewActivity={onViewActivity}
              onShareFile={onShareFile}
              onUploadNewVersion={onUploadNewVersion}
              onSendForSignature={onSendForSignature}
              onSendForApproval={onSendForApproval}
              onOpenProperties={onOpenProperties}
              onFileDragStart={onFileDragStart}
              onFileDragEnd={onFileDragEnd}
            />
          )
        })}
      </TableBody>
    </Table>
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
    <Table>
      <TableHeader>
        <TableRow className="bg-muted/40 hover:bg-muted/40">
          <TableHead className="w-[72px] pl-4">Preview</TableHead>
          <TableHead className="min-w-[200px]">Sheet</TableHead>
          <TableHead className="hidden lg:table-cell w-[100px]">Discipline</TableHead>
          <TableHead className="hidden md:table-cell w-[100px]">Modified</TableHead>
          <TableHead className="hidden xl:table-cell w-[140px]">Modified by</TableHead>
          <TableHead className="hidden md:table-cell w-[80px]">Revision</TableHead>
          <TableHead className="w-10 pr-4" />
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
  onDropOnFolder,
}: {
  item: Extract<DocumentTableItem, { type: "folder" }>
  isSelected: boolean
  onSelectionChange: (path: string, selected: boolean) => void
  onFolderClick: (path: string) => void
  onDropOnFolder: (path: string) => void
}) {
  return (
    <TableRow
      className={cn("group cursor-pointer hover:bg-muted/30", isSelected && "bg-primary/5")}
      data-state={isSelected ? "selected" : undefined}
      onClick={() => onFolderClick(item.path)}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onDropOnFolder(item.path)
      }}
    >
      <TableCell className="w-11 pl-4 pr-2">
        <div className="flex h-8 items-center" onClick={(event) => event.stopPropagation()}>
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
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-amber-100/80 dark:bg-amber-950/30">
            <FolderOpen className="h-4 w-4 text-amber-600 dark:text-amber-500" />
          </div>
          <div className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{item.name}</span>
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
        <span className="text-xs text-muted-foreground">-</span>
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
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive focus:text-destructive" disabled>
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
  onSelectionChange,
  onFileClick,
  onDownloadFile,
  onRenameFile,
  onMoveFile,
  onDeleteFile,
  onViewActivity,
  onShareFile,
  onUploadNewVersion,
  onSendForSignature,
  onSendForApproval,
  onOpenProperties,
  onFileDragStart,
  onFileDragEnd,
}: {
  file: FileWithUrls
  isSelected: boolean
  onSelectionChange: (fileId: string, selected: boolean) => void
  onFileClick: (fileId: string) => void
  onDownloadFile: (fileId: string) => void
  onRenameFile: (fileId: string) => void
  onMoveFile: (fileId: string) => void
  onDeleteFile: (fileId: string) => void
  onViewActivity: (fileId: string) => void
  onShareFile: (fileId: string) => void
  onUploadNewVersion: (fileId: string) => void
  onSendForSignature?: (fileId: string) => void
  onSendForApproval?: (fileId: string) => void
  onOpenProperties: (fileId: string) => void
  onFileDragStart: (fileId: string, event: React.DragEvent<HTMLDivElement>) => void
  onFileDragEnd: (fileId: string) => void
}) {
  const router = useRouter()
  const Icon = getFileIcon(file.mime_type ?? undefined)
  const isImage = file.mime_type?.startsWith("image/")
  const thumbnailUrl = file.thumbnail_url ?? (isImage ? file.download_url : undefined)

  const isShared = file.share_with_clients || file.share_with_subs
  
  return (
    <TableRow
      className={cn("group cursor-pointer", isSelected && "bg-primary/5")}
      data-state={isSelected ? "selected" : undefined}
      onClick={() => onFileClick(file.id)}
      draggable
      onDragStart={(event) => onFileDragStart(file.id, event as unknown as React.DragEvent<HTMLDivElement>)}
      onDragEnd={() => onFileDragEnd(file.id)}
    >
      <TableCell className="w-11 pl-4 pr-2" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={isSelected}
          onCheckedChange={(value) => onSelectionChange(file.id, Boolean(value))}
          aria-label={`Select ${file.file_name}`}
          className="h-3.5 w-3.5"
        />
      </TableCell>
      <TableCell className="min-w-0">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
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
          <div className="min-w-0 flex-1">
            <span className="text-sm font-medium truncate block">{file.file_name}</span>
            <div className="flex items-center gap-1.5 sm:hidden mt-0.5">
              {file.category && (
                <span className="text-[11px] text-muted-foreground capitalize">
                  {getCategoryLabel(file.category)}
                </span>
              )}
              <span className="text-[11px] text-muted-foreground">{formatFileSize(file.size_bytes)}</span>
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
        <div className="flex flex-wrap items-center gap-1">
          {file.status && file.status !== "draft" && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge 
                    variant="outline" 
                    className={cn(
                      "text-[10px] px-1 py-0 h-4 font-normal",
                      file.status === "approved" && "text-emerald-600 border-emerald-200 bg-emerald-50 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-900",
                      file.status === "in_review" && "text-blue-600 border-blue-200 bg-blue-50 dark:bg-blue-950/30 dark:text-blue-400 dark:border-blue-900",
                      file.status === "submitted" && "text-amber-600 border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-900",
                      (file.status === "rejected" || file.status === "resubmit_required") && "text-rose-600 border-rose-200 bg-rose-50 dark:bg-rose-950/30 dark:text-rose-400 dark:border-rose-900"
                    )}
                  >
                    {file.status === "approved" && <CheckCircle2 className="h-2.5 w-2.5 mr-1" />}
                    {file.status === "in_review" && <Eye className="h-2.5 w-2.5 mr-1" />}
                    {file.status === "submitted" && <Upload className="h-2.5 w-2.5 mr-1" />}
                    {(file.status === "rejected" || file.status === "resubmit_required") && <AlertCircle className="h-2.5 w-2.5 mr-1" />}
                    <span className="capitalize">{file.status.replace("_", " ")}</span>
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="text-xs">Approval status: {file.status.replace("_", " ")}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {file.signature_status && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge 
                    variant="outline" 
                    className={cn(
                      "text-[10px] px-1 py-0 h-4 font-normal",
                      file.signature_status === "signed" && "text-emerald-600 border-emerald-200 bg-emerald-50 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-900",
                      file.signature_status === "sent" && "text-blue-600 border-blue-200 bg-blue-50 dark:bg-blue-950/30 dark:text-blue-400 dark:border-blue-900",
                      file.signature_status === "draft" && "text-amber-600 border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-900",
                      (file.signature_status === "voided" || file.signature_status === "expired") && "text-muted-foreground border-muted-foreground/30 bg-muted/30"
                    )}
                  >
                    {file.signature_status === "signed" && <CheckCircle2 className="h-2.5 w-2.5 mr-1" />}
                    {file.signature_status === "sent" && <Clock className="h-2.5 w-2.5 mr-1" />}
                    {file.signature_status === "draft" && <Pencil className="h-2.5 w-2.5 mr-1" />}
                    {(file.signature_status === "voided" || file.signature_status === "expired") && <AlertCircle className="h-2.5 w-2.5 mr-1" />}
                    <span className="capitalize">{file.signature_status}</span>
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="text-xs">Signature status: {file.signature_status}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {file.version_number && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge 
                    variant={file.is_current ? "outline" : "secondary"}
                    className={cn(
                      "text-[10px] px-1 py-0 h-4 font-normal",
                      file.is_current ? "text-blue-600 border-blue-200 bg-blue-50 dark:bg-blue-950/30 dark:text-blue-400 dark:border-blue-900" : "text-muted-foreground opacity-70"
                    )}
                  >
                    {!file.is_current && <Clock className="h-2.5 w-2.5 mr-1" />}
                    {file.is_current ? `v${file.version_number}` : "Superseded"}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="text-xs">
                    {file.is_current ? `Latest version (v${file.version_number})` : `Old version (v${file.version_number})`}
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      </TableCell>
      <TableCell className="hidden lg:table-cell w-[128px]">
        <div className="flex min-w-0 items-center gap-1">
          {!isShared ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="secondary" className="bg-muted text-muted-foreground hover:bg-muted text-[10px] px-1 py-0 h-4 font-normal">
                    <Lock className="h-2.5 w-2.5 mr-1" />
                    Private
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="text-xs">Only internal team members can see this</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              {file.share_with_clients && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge variant="outline" className="text-blue-600 border-blue-200 bg-blue-50 dark:bg-blue-950/30 dark:text-blue-400 dark:border-blue-900 text-[10px] px-1 py-0 h-4 font-normal">
                        <Users className="h-2.5 w-2.5 mr-1" />
                        Clients
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p className="text-xs">Visible in Client Portal</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
              {file.share_with_subs && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge variant="outline" className="text-indigo-600 border-indigo-200 bg-indigo-50 dark:bg-indigo-950/30 dark:text-indigo-400 dark:border-indigo-900 text-[10px] px-1 py-0 h-4 font-normal">
                        <HardHat className="h-2.5 w-2.5 mr-1" />
                        Subs
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p className="text-xs">Visible in Subcontractor Portal</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>
          )}
        </div>
      </TableCell>
      <TableCell className="hidden md:table-cell w-[112px] text-xs text-muted-foreground">
        {formatDate(file.updated_at ?? file.created_at)}
      </TableCell>
      <TableCell className="hidden xl:table-cell w-[88px] text-right text-xs text-muted-foreground tabular-nums">
        {formatFileSize(file.size_bytes)}
      </TableCell>
      <TableCell className="w-[92px] pr-4" onClick={(e) => e.stopPropagation()}>
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
              <DropdownMenuItem onClick={() => onUploadNewVersion(file.id)}>
                <FilePlus2 className="h-4 w-4 mr-2" />
                Upload new version...
              </DropdownMenuItem>
              {file.mime_type === "application/pdf" && (
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
              <DropdownMenuItem onClick={() => onSendForApproval?.(file.id)}>
                <CheckCircle2 className="h-4 w-4 mr-2" />
                Submit for approval...
              </DropdownMenuItem>
              {file.status && file.status !== "draft" && (
                <DropdownMenuItem onClick={() => {/* Stage 9 logic */}}>
                  <ShieldCheck className="h-4 w-4 mr-2" />
                  Approval workflow...
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
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
        </div>
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
      className={cn("group", onOpen && "cursor-pointer")}
      onClick={() => onOpen?.(sheet)}
    >
      <TableCell className="pl-4">
        <div className="h-9 w-14 overflow-hidden rounded border bg-muted/40">
          {thumbnail ? (
            <img
              src={thumbnail}
              alt={sheet.sheet_number}
              className="h-full w-full object-cover"
              loading="lazy"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-[9px] text-muted-foreground">
              -
            </div>
          )}
        </div>
      </TableCell>
      <TableCell>
        <span className="text-sm font-semibold block">{sheetNumber}</span>
        <span className="text-xs text-muted-foreground truncate block max-w-[280px] mt-0.5">
          {sheet.sheet_title || "Untitled sheet"}
        </span>
      </TableCell>
      <TableCell className="hidden lg:table-cell">
        {sheet.discipline ? (
          <span className="text-xs text-muted-foreground">{sheet.discipline}</span>
        ) : (
          <span className="text-xs text-muted-foreground">-</span>
        )}
      </TableCell>
      <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
        {formatDate(sheet.updated_at)}
      </TableCell>
      <TableCell className="hidden xl:table-cell">
        <span className="text-xs text-muted-foreground truncate block max-w-[130px]">{lastModifiedBy}</span>
      </TableCell>
      <TableCell className="hidden md:table-cell">
        {sheet.current_revision_label ? (
          <Badge variant="outline" className="text-[11px] px-1.5 py-0">
            {sheet.current_revision_label}
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground">-</span>
        )}
      </TableCell>
      <TableCell className="pr-4" onClick={(e) => e.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity">
              <MoreHorizontal className="h-3.5 w-3.5" />
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
            <TableCell className="pl-4 pr-2">
              <Skeleton className="h-3.5 w-3.5 rounded" />
            </TableCell>
            <TableCell>
              <div className="flex items-center gap-3">
                <Skeleton className="h-8 w-8 rounded shrink-0" />
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
          <Button variant="outline" size="sm" onClick={() => {/* potentially clear filters */}}>
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
