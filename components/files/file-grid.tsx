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
  CheckCircle,
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
} from "./types"

interface FileGridProps {
  files: FileWithDetails[]
  selectedIds: Set<string>
  onSelectionChange: (ids: Set<string>) => void
  onPreview: (file: FileWithDetails) => void
  onDownload: (file: FileWithDetails) => void
  onDelete: (file: FileWithDetails) => void
  onVersionHistory?: (file: FileWithDetails) => void
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

  const toggleAll = () => {
    if (selectedIds.size === files.length) {
      onSelectionChange(new Set())
    } else {
      onSelectionChange(new Set(files.map((f) => f.id)))
    }
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
    <div className="space-y-4">
      {/* Selection toolbar */}
      {files.length > 0 && (
        <div className="flex items-center gap-4 text-sm">
          <div className="flex items-center gap-2">
            <Checkbox
              checked={selectedIds.size === files.length && files.length > 0}
              onCheckedChange={toggleAll}
              className="h-4 w-4"
            />
            <span className="text-muted-foreground">
              {selectedIds.size > 0
                ? `${selectedIds.size} selected`
                : `${files.length} files`}
            </span>
          </div>
        </div>
      )}

      {/* Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
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
                  : "hover:border-primary/50 hover:shadow-lg"
              )}
              onMouseEnter={() => setHoveredId(file.id)}
              onMouseLeave={() => setHoveredId(null)}
              onClick={() => onPreview(file)}
            >
              {/* Thumbnail / Preview */}
              <div className="relative aspect-square bg-muted">
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
                    <span className="text-4xl">{getMimeIcon(file.mime_type)}</span>
                  </div>
                )}

                {/* Overlay on hover/select */}
                <div
                  className={cn(
                    "absolute inset-0 bg-black/60 transition-opacity flex items-center justify-center gap-2",
                    isHovered || isSelected ? "opacity-100" : "opacity-0"
                  )}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Button
                    variant="secondary"
                    size="icon"
                    className="h-9 w-9"
                    onClick={() => onPreview(file)}
                  >
                    <Eye className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="secondary"
                    size="icon"
                    className="h-9 w-9"
                    onClick={() => onDownload(file)}
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                </div>

                {/* Selection checkbox */}
                <div
                  className={cn(
                    "absolute top-2 left-2 transition-opacity",
                    isHovered || isSelected ? "opacity-100" : "opacity-0"
                  )}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={() => toggleSelection(file.id)}
                    className="h-5 w-5 bg-white/90 border-white"
                  />
                </div>

                {/* Version badge */}
                {file.has_versions && (
                  <div className="absolute top-2 right-2">
                    <Badge
                      variant="secondary"
                      className="text-xs bg-black/60 text-white border-0"
                    >
                      <History className="h-3 w-3 mr-1" />v{file.version_number ?? 1}
                    </Badge>
                  </div>
                )}

                {/* Category badge */}
                {category && (
                  <div className="absolute bottom-2 left-2">
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-xs border-0",
                        category.color
                      )}
                    >
                      {category.icon}
                    </Badge>
                  </div>
                )}
              </div>

              {/* File info */}
              <div className="p-3">
                <p className="font-medium text-sm truncate" title={file.file_name}>
                  {file.file_name}
                </p>
                <div className="flex items-center justify-between mt-1">
                  <span className="text-xs text-muted-foreground">
                    {formatFileSize(file.size_bytes)}
                  </span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 opacity-0 group-hover:opacity-100"
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
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
                      <DropdownMenuSeparator />
                      <DropdownMenuItem>
                        <Tag className="mr-2 h-4 w-4" />
                        Edit tags
                      </DropdownMenuItem>
                      <DropdownMenuItem>
                        <Folder className="mr-2 h-4 w-4" />
                        Move to folder
                      </DropdownMenuItem>
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
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {formatDistanceToNow(parseISO(file.created_at), { addSuffix: true })}
                </p>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}






