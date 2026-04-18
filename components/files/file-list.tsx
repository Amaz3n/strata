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
      return <ArrowUpDown className="ml-1 h-3 w-3 opacity-40" />
    }
    return sortOrder === "asc" ? (
      <ArrowUp className="ml-1 h-3 w-3" />
    ) : (
      <ArrowDown className="ml-1 h-3 w-3" />
    )
  }

  if (files.length === 0 && !isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted mb-3">
          <FileText className="h-7 w-7 text-muted-foreground" />
        </div>
        <h3 className="font-semibold">No files yet</h3>
        <p className="text-sm text-muted-foreground mt-1 max-w-sm">
          Upload plans, contracts, photos, and documents to keep your project organized.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-lg border overflow-hidden">
      {/* Header */}
      <div className="grid grid-cols-[40px_1fr_100px_80px_120px_40px] items-center gap-2 px-3 py-2 bg-muted/50 border-b text-xs font-medium text-muted-foreground">
        <div>
          <Checkbox
            checked={selectedIds.size === files.length && files.length > 0}
            onCheckedChange={toggleAll}
            className="h-3.5 w-3.5"
          />
        </div>
        <button className="flex items-center hover:text-foreground transition-colors text-left" onClick={() => handleSort("name")}>
          Name <SortIcon field="name" />
        </button>
        <button className="hidden md:flex items-center hover:text-foreground transition-colors" onClick={() => handleSort("category")}>
          Category <SortIcon field="category" />
        </button>
        <button className="hidden sm:flex items-center hover:text-foreground transition-colors" onClick={() => handleSort("size")}>
          Size <SortIcon field="size" />
        </button>
        <button className="flex items-center hover:text-foreground transition-colors" onClick={() => handleSort("date")}>
          Date <SortIcon field="date" />
        </button>
        <div />
      </div>

      {/* Rows */}
      <div>
        {sortedFiles.map((file) => {
          const isSelected = selectedIds.has(file.id)
          const category = file.category ? FILE_CATEGORIES[file.category] : null

          return (
            <div
              key={file.id}
              className={cn(
                "grid grid-cols-[40px_1fr_100px_80px_120px_40px] items-center gap-2 px-3 py-2.5 border-b last:border-b-0 cursor-pointer transition-colors",
                isSelected ? "bg-primary/5" : "hover:bg-muted/30"
              )}
              onClick={() => onPreview(file)}
            >
              <div onClick={(e) => e.stopPropagation()}>
                <Checkbox
                  checked={isSelected}
                  onCheckedChange={() => toggleSelection(file.id)}
                  className="h-3.5 w-3.5"
                />
              </div>

              <div className="flex items-center gap-2.5 min-w-0">
                <span className="text-lg shrink-0">{getMimeIcon(file.mime_type)}</span>
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{file.file_name}</p>
                  {file.folder_path && (
                    <p className="text-[11px] text-muted-foreground truncate">{file.folder_path}</p>
                  )}
                </div>
              </div>

              <div className="hidden md:block">
                {category ? (
                  <span className="text-xs text-muted-foreground">
                    {category.icon} {category.label.split(" ")[0]}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">-</span>
                )}
              </div>

              <div className="hidden sm:block text-xs text-muted-foreground tabular-nums">
                {formatFileSize(file.size_bytes)}
              </div>

              <div className="text-xs text-muted-foreground">
                <span title={format(parseISO(file.created_at), "PPpp")}>
                  {formatDistanceToNow(parseISO(file.created_at), { addSuffix: true })}
                </span>
              </div>

              <div onClick={(e) => e.stopPropagation()}>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-7 w-7">
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuItem onClick={() => onPreview(file)}>
                      <Eye className="mr-2 h-3.5 w-3.5" />
                      Preview
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onDownload(file)}>
                      <Download className="mr-2 h-3.5 w-3.5" />
                      Download
                    </DropdownMenuItem>
                    {onViewActivity && (
                      <DropdownMenuItem onClick={() => onViewActivity(file)}>
                        <History className="mr-2 h-3.5 w-3.5" />
                        Activity
                      </DropdownMenuItem>
                    )}
                    {onEdit && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => onEdit(file)}>
                          <Tag className="mr-2 h-3.5 w-3.5" />
                          Edit details
                        </DropdownMenuItem>
                      </>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => onDelete(file)}
                    >
                      <Trash2 className="mr-2 h-3.5 w-3.5" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
