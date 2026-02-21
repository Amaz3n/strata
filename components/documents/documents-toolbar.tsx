"use client"

import { Fragment, useRef } from "react"
import { cn } from "@/lib/utils"
import {
  Search,
  X,
  LayoutGrid,
  List,
  FolderClosed,
  ChevronRight,
  FolderPlus,
  FolderInput,
  Trash2,
  Download,
  Plus,
  Upload,
  Layers,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useDocuments } from "./documents-context"

interface DocumentsToolbarProps {
  onUploadClick: () => void
  onUploadDrawingSetClick: () => void
  onCreateFolderClick: () => void
  selectedCount: number
  onDownloadSelected: () => void
  onMoveSelected: () => void
  onDeleteSelected: () => void
  onClearSelection: () => void
  onDropToFolderPath: (path: string) => void
  onDropToRoot: () => void
  isDraggingFiles: boolean
  isDownloadingSelected?: boolean
}

export function DocumentsToolbar({
  onUploadClick,
  onUploadDrawingSetClick,
  onCreateFolderClick,
  selectedCount,
  onDownloadSelected,
  onMoveSelected,
  onDeleteSelected,
  onClearSelection,
  onDropToFolderPath,
  onDropToRoot,
  isDraggingFiles,
  isDownloadingSelected = false,
}: DocumentsToolbarProps) {
  const {
    currentPath,
    searchQuery,
    setSearchQuery,
    viewMode,
    setViewMode,
    isUploading,
    selectedDrawingSetId,
    navigateToRoot,
    navigateToFolder,
  } = useDocuments()

  const searchInputRef = useRef<HTMLInputElement>(null)
  const isViewingDrawingSet = Boolean(selectedDrawingSetId)

  const pathSegments = currentPath
    ? currentPath.split("/").filter(Boolean)
    : []

  const handleBreadcrumbClick = (index: number) => {
    if (index < 0) {
      navigateToRoot()
    } else {
      const newPath = "/" + pathSegments.slice(0, index + 1).join("/")
      navigateToFolder(newPath)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Bulk actions bar */}
      {selectedCount > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-muted/50 px-3 py-2.5">
          <Badge variant="secondary" className="rounded-md">
            {selectedCount} selected
          </Badge>
          <Button variant="outline" size="sm" onClick={onDownloadSelected} disabled={isDownloadingSelected}>
            <Download className="h-4 w-4 mr-2" />
            {isDownloadingSelected ? "Downloading..." : "Download"}
          </Button>
          <Button variant="outline" size="sm" onClick={onMoveSelected}>
            <FolderInput className="h-4 w-4 mr-2" />
            Move
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={onDeleteSelected}
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Delete
          </Button>
          <Button variant="ghost" size="sm" onClick={onClearSelection}>
            Clear
          </Button>
        </div>
      )}

      {/* Toolbar row: Search + View toggle + New dropdown */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            ref={searchInputRef}
            placeholder={isViewingDrawingSet ? "Search sheets..." : "Search documents..."}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-9 rounded-lg border-border/70 bg-background/80 pl-9 text-sm"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* View toggle — hidden when viewing drawing sets */}
        {!isViewingDrawingSet && (
          <div className="hidden sm:flex items-center rounded-lg border border-border/70 bg-background/80 p-0.5">
            <button
              type="button"
              className={cn(
                "h-8 w-8 flex items-center justify-center rounded-md transition-colors",
                viewMode === "list" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
              onClick={() => setViewMode("list")}
              title="List view"
            >
              <List className="h-4 w-4" />
            </button>
            <button
              type="button"
              className={cn(
                "h-8 w-8 flex items-center justify-center rounded-md transition-colors",
                viewMode === "grid" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
              onClick={() => setViewMode("grid")}
              title="Grid view"
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* New dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" className="h-9 shrink-0">
              <Plus className="h-4 w-4 sm:mr-1.5" />
              <span className="hidden sm:inline">New</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={onUploadClick} disabled={isUploading}>
              <Upload className="h-4 w-4 mr-2" />
              {isUploading ? "Uploading..." : "Upload files"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onUploadDrawingSetClick} disabled={isUploading}>
              <Layers className="h-4 w-4 mr-2" />
              Upload drawing set
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onCreateFolderClick}>
              <FolderPlus className="h-4 w-4 mr-2" />
              New folder
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

      </div>

      {/* Breadcrumbs — only when in a subfolder (not for drawing sets, since sidebar shows that) */}
      {currentPath && !isViewingDrawingSet && (
        <div className="flex min-h-[32px] items-center gap-3 rounded-lg border border-border/60 bg-muted/30 px-2 py-1.5">
          <Breadcrumb className="shrink-0">
            <BreadcrumbList className="flex-nowrap gap-1">
              <BreadcrumbItem>
                <BreadcrumbLink
                  href="#"
                  onClick={(e) => {
                    e.preventDefault()
                    handleBreadcrumbClick(-1)
                  }}
                  onDragOver={(event) => {
                    if (!isDraggingFiles) return
                    event.preventDefault()
                  }}
                  onDrop={(event) => {
                    if (!isDraggingFiles) return
                    event.preventDefault()
                    onDropToRoot()
                  }}
                  className={cn(
                    "flex items-center gap-1 text-xs rounded px-1 py-0.5 transition-colors",
                    isDraggingFiles && "hover:bg-muted",
                  )}
                >
                  <FolderClosed className="h-3.5 w-3.5" />
                  All files
                </BreadcrumbLink>
              </BreadcrumbItem>
              {pathSegments.map((segment, index) => (
                <Fragment key={segment + index}>
                  <BreadcrumbSeparator>
                    <ChevronRight className="h-3 w-3" />
                  </BreadcrumbSeparator>
                  <BreadcrumbItem>
                    {index === pathSegments.length - 1 ? (
                      <BreadcrumbPage className="text-xs truncate max-w-[160px]">
                        {segment}
                      </BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink
                        href="#"
                        onClick={(e) => {
                          e.preventDefault()
                          handleBreadcrumbClick(index)
                        }}
                        onDragOver={(event) => {
                          if (!isDraggingFiles) return
                          event.preventDefault()
                        }}
                        onDrop={(event) => {
                          if (!isDraggingFiles) return
                          event.preventDefault()
                          const targetPath = "/" + pathSegments.slice(0, index + 1).join("/")
                          onDropToFolderPath(targetPath)
                        }}
                        className={cn(
                          "text-xs truncate max-w-[160px] rounded px-1 py-0.5 transition-colors",
                          isDraggingFiles && "hover:bg-muted",
                        )}
                      >
                        {segment}
                      </BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                </Fragment>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      )}
    </div>
  )
}
