"use client"

import { useState } from "react"
import { formatDistanceToNow, parseISO, format } from "date-fns"
import { cn } from "@/lib/utils"
import {
  MoreHorizontal,
  Download,
  Eye,
  Trash2,
  Copy,
  History,
  Tag,
  Folder,
  FileText,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
} from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
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
  type FileWithDetails,
  FILE_CATEGORIES,
  getMimeIcon,
  formatFileSize,
  ENTITY_TYPE_LABELS,
} from "./types"

type FileLinkSummaryMap = Record<string, { total: number; types: Record<string, number> }>

type SortField = "name" | "size" | "date" | "category"
type SortOrder = "asc" | "desc"

interface FileListProps {
  files: FileWithDetails[]
  selectedIds: Set<string>
  onSelectionChange: (ids: Set<string>) => void
  onPreview: (file: FileWithDetails) => void
  onDownload: (file: FileWithDetails) => void
  onDelete: (file: FileWithDetails) => void
  onVersionHistory?: (file: FileWithDetails) => void
  onEdit?: (file: FileWithDetails) => void
  onViewActivity?: (file: FileWithDetails) => void
  attachmentSummary?: FileLinkSummaryMap
  isLoading?: boolean
}

export function FileList({
  files,
  selectedIds,
  onSelectionChange,
  onPreview,
  onDownload,
  onDelete,
  onVersionHistory,
  onEdit,
  onViewActivity,
  attachmentSummary,
  isLoading,
}: FileListProps) {
  const [sortField, setSortField] = useState<SortField>("date")
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc")

  const toggleSelection = (id: string) => {
    const newSelection = new Set(selectedIds)
    if (newSelection.has(id)) {
      newSelection.delete(id)
    } else {
      newSelection.add(id)
    }
    onSelectionChange(newSelection)
  }

  const toggleAll = () => {
    if (selectedIds.size === files.length) {
      onSelectionChange(new Set())
    } else {
      onSelectionChange(new Set(files.map((f) => f.id)))
    }
  }

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc")
    } else {
      setSortField(field)
      setSortOrder("asc")
    }
  }

  const sortedFiles = [...files].sort((a, b) => {
    const multiplier = sortOrder === "asc" ? 1 : -1

    switch (sortField) {
      case "name":
        return multiplier * a.file_name.localeCompare(b.file_name)
      case "size":
        return multiplier * ((a.size_bytes ?? 0) - (b.size_bytes ?? 0))
      case "date":
        return multiplier * (new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      case "category":
        return multiplier * ((a.category ?? "other").localeCompare(b.category ?? "other"))
      default:
        return 0
    }
  })

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) {
      return <ArrowUpDown className="ml-1 h-3.5 w-3.5 opacity-50" />
    }
    return sortOrder === "asc" ? (
      <ArrowUp className="ml-1 h-3.5 w-3.5" />
    ) : (
      <ArrowDown className="ml-1 h-3.5 w-3.5" />
    )
  }

  if (files.length === 0 && !isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted mb-4">
          <FileText className="h-8 w-8 text-muted-foreground" />
        </div>
        <h3 className="font-semibold text-lg">No files yet</h3>
        <p className="text-sm text-muted-foreground mt-1 max-w-sm">
          Upload plans, contracts, photos, and documents to keep your project organized.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-[40px]">
              <Checkbox
                checked={selectedIds.size === files.length && files.length > 0}
                onCheckedChange={toggleAll}
                className="h-4 w-4"
              />
            </TableHead>
            <TableHead>
              <Button
                variant="ghost"
                size="sm"
                className="-ml-3 h-8"
                onClick={() => handleSort("name")}
              >
                Name
                <SortIcon field="name" />
              </Button>
            </TableHead>
            <TableHead className="hidden md:table-cell">
              <Button
                variant="ghost"
                size="sm"
                className="-ml-3 h-8"
                onClick={() => handleSort("category")}
              >
                Category
                <SortIcon field="category" />
              </Button>
            </TableHead>
            <TableHead className="hidden sm:table-cell">
              <Button
                variant="ghost"
                size="sm"
                className="-ml-3 h-8"
                onClick={() => handleSort("size")}
              >
                Size
                <SortIcon field="size" />
              </Button>
            </TableHead>
            <TableHead className="hidden lg:table-cell">Uploaded by</TableHead>
            <TableHead>
              <Button
                variant="ghost"
                size="sm"
                className="-ml-3 h-8"
                onClick={() => handleSort("date")}
              >
                Date
                <SortIcon field="date" />
              </Button>
            </TableHead>
            <TableHead className="w-[50px]"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedFiles.map((file) => {
            const isSelected = selectedIds.has(file.id)
            const category = file.category ? FILE_CATEGORIES[file.category] : null
            const summary = attachmentSummary?.[file.id]
            const attachmentText = summary
              ? Object.entries(summary.types)
                  .map(([type, count]) => `${ENTITY_TYPE_LABELS[type] ?? type} (${count})`)
                  .join(", ")
              : ""

            return (
              <TableRow
                key={file.id}
                className={cn(
                  "cursor-pointer",
                  isSelected && "bg-primary/5"
                )}
                onClick={() => onPreview(file)}
              >
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={() => toggleSelection(file.id)}
                    className="h-4 w-4"
                  />
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <span className="text-xl shrink-0">{getMimeIcon(file.mime_type)}</span>
                    <div className="min-w-0">
                      <p className="font-medium truncate max-w-[200px] lg:max-w-[300px]">
                        {file.file_name}
                      </p>
                      {file.has_versions && (
                        <Badge variant="outline" className="text-xs mt-0.5">
                          <History className="h-3 w-3 mr-1" />
                          v{file.version_number ?? 1}
                        </Badge>
                      )}
                      <div className="flex flex-wrap items-center gap-1 mt-1">
                        {file.share_with_clients && (
                          <Badge variant="secondary" className="text-[11px]">
                            Clients
                          </Badge>
                        )}
                        {file.share_with_subs && (
                          <Badge variant="secondary" className="text-[11px]">
                            Subs
                          </Badge>
                        )}
                        {!file.share_with_clients && !file.share_with_subs && (
                          <span className="text-xs text-muted-foreground">Private</span>
                        )}
                      </div>
                      {(file.folder_path || (file.tags && file.tags.length > 0)) && (
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          {file.folder_path && <span>{file.folder_path}</span>}
                          {file.tags && file.tags.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1">
                              {file.tags.slice(0, 3).map((tag) => (
                                <Badge key={tag} variant="outline" className="text-[10px]">
                                  {tag}
                                </Badge>
                              ))}
                              {file.tags.length > 3 && (
                                <span className="text-[10px] text-muted-foreground">
                                  +{file.tags.length - 3}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                      {summary && attachmentText && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Attached to: {attachmentText}
                        </p>
                      )}
                    </div>
                  </div>
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  {category ? (
                    <Badge variant="secondary" className={cn("text-xs", category.color)}>
                      {category.icon} {category.label}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground text-sm">—</span>
                  )}
                </TableCell>
                <TableCell className="hidden sm:table-cell text-muted-foreground">
                  {formatFileSize(file.size_bytes)}
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  {file.uploader_name ? (
                    <div className="flex items-center gap-2">
                      <Avatar className="h-6 w-6">
                        <AvatarImage src={file.uploader_avatar} />
                        <AvatarFallback className="text-xs">
                          {file.uploader_name
                            .split(" ")
                            .map((n) => n[0])
                            .join("")
                            .slice(0, 2)}
                        </AvatarFallback>
                      </Avatar>
                      <span className="text-sm">{file.uploader_name}</span>
                    </div>
                  ) : (
                    <span className="text-muted-foreground text-sm">—</span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  <span title={format(parseISO(file.created_at), "PPpp")}>
                    {formatDistanceToNow(parseISO(file.created_at), { addSuffix: true })}
                  </span>
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      <DropdownMenuItem onClick={() => onPreview(file)}>
                        <Eye className="mr-2 h-4 w-4" />
                        Preview
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onDownload(file)}>
                        <Download className="mr-2 h-4 w-4" />
                        Download
                      </DropdownMenuItem>
                      {onViewActivity && (
                        <DropdownMenuItem onClick={() => onViewActivity(file)}>
                          <History className="mr-2 h-4 w-4" />
                          View activity
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem>
                        <Copy className="mr-2 h-4 w-4" />
                        Copy link
                      </DropdownMenuItem>
                      {onVersionHistory && (
                        <DropdownMenuItem onClick={() => onVersionHistory(file)}>
                          <History className="mr-2 h-4 w-4" />
                          Version history
                        </DropdownMenuItem>
                      )}
                      {onEdit && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => onEdit(file)}>
                            <Tag className="mr-2 h-4 w-4" />
                            Edit details
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => onEdit(file)}>
                            <Folder className="mr-2 h-4 w-4" />
                            Sharing & folders
                          </DropdownMenuItem>
                        </>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => onDelete(file)}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}




