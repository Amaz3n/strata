"use client"

import { useState } from "react"
import Image from "next/image"
import { formatDistanceToNow, parseISO } from "date-fns"
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
} from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
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
  isImageFile,
  ENTITY_TYPE_LABELS,
} from "./types"

type FileLinkSummaryMap = Record<string, { total: number; types: Record<string, number> }>

interface FileGridProps {
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

export function FileGrid({
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
}: FileGridProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  const toggleSelection = (id: string) => {
    const newSelection = new Set(selectedIds)
    if (newSelection.has(id)) {
      newSelection.delete(id)
    } else {
      newSelection.add(id)
    }
    onSelectionChange(newSelection)
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
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 gap-3">
      {files.map((file) => {
        const isSelected = selectedIds.has(file.id)
        const isHovered = hoveredId === file.id
        const isImage = isImageFile(file.mime_type)
        const category = file.category ? FILE_CATEGORIES[file.category] : null

        return (
          <div
            key={file.id}
            className={cn(
              "group relative rounded-lg border bg-card overflow-hidden transition-all cursor-pointer",
              isSelected
                ? "ring-2 ring-primary border-primary"
                : "hover:border-foreground/20 hover:shadow-md"
            )}
            onMouseEnter={() => setHoveredId(file.id)}
            onMouseLeave={() => setHoveredId(null)}
            onClick={() => onPreview(file)}
          >
            {/* Thumbnail */}
            <div className="relative aspect-[4/3] bg-muted">
              {isImage && file.thumbnail_url ? (
                <Image
                  src={file.thumbnail_url}
                  alt={file.file_name}
                  fill
                  className="object-cover"
                  unoptimized
                />
              ) : (
                <div className="flex items-center justify-center h-full">
                  <span className="text-3xl">{getMimeIcon(file.mime_type)}</span>
                </div>
              )}

              {/* Hover overlay */}
              <div
                className={cn(
                  "absolute inset-0 bg-black/50 transition-opacity flex items-center justify-center gap-1.5",
                  isHovered || isSelected ? "opacity-100" : "opacity-0"
                )}
                onClick={(e) => e.stopPropagation()}
              >
                <Button
                  variant="secondary"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => onPreview(file)}
                >
                  <Eye className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="secondary"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => onDownload(file)}
                >
                  <Download className="h-3.5 w-3.5" />
                </Button>
              </div>

              {/* Checkbox */}
              <div
                className={cn(
                  "absolute top-1.5 left-1.5 transition-opacity",
                  isHovered || isSelected ? "opacity-100" : "opacity-0"
                )}
                onClick={(e) => e.stopPropagation()}
              >
                <Checkbox
                  checked={isSelected}
                  onCheckedChange={() => toggleSelection(file.id)}
                  className="h-4 w-4 bg-white/90 border-white"
                />
              </div>

              {/* Category indicator */}
              {category && (
                <div className="absolute bottom-1.5 left-1.5">
                  <span className="text-sm drop-shadow-md">{category.icon}</span>
                </div>
              )}
            </div>

            {/* File info */}
            <div className="px-2.5 py-2">
              <p className="font-medium text-xs truncate" title={file.file_name}>
                {file.file_name}
              </p>
              <div className="flex items-center justify-between mt-1">
                <span className="text-[11px] text-muted-foreground">
                  {formatFileSize(file.size_bytes)}
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 opacity-0 group-hover:opacity-100"
                    >
                      <MoreHorizontal className="h-3 w-3" />
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
          </div>
        )
      })}
    </div>
  )
}
