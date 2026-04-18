"use client"

import { Fragment, useRef } from "react"
import {
  Search,
  X,
  FolderClosed,
  ChevronRight,
  FolderPlus,
  FolderInput,
  Trash2,
  Download,
  Plus,
  Upload,
  Layers,
  ListFilter,
  ArrowUpDown,
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
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { useDocuments } from "./documents-context"
import { QUICK_FILTER_CONFIG } from "./types"

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
    isUploading,
    selectedDrawingSetId,
    selectedDrawingSetTitle,
    navigateToRoot,
    navigateToFolder,
    quickFilter,
    setQuickFilter,
    sort,
    setSort,
    direction,
    setDirection,
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

  const sortOptions = [
    { label: "Date created", value: "created_at" },
    { label: "Date modified", value: "updated_at" },
    { label: "Name", value: "name" },
    { label: "File size", value: "size" },
  ] as const

  return (
    <div className="flex flex-col gap-2">
      {/* Main toolbar row */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-1">
          {/* Search */}
          <div className="relative w-full max-w-[300px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              placeholder={isViewingDrawingSet ? "Search sheets..." : "Search documents..."}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 pl-8 text-sm"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          {/* Category Filter */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 gap-1.5 hidden md:flex">
                <ListFilter className="h-3.5 w-3.5" />
                <span className="text-xs">Category</span>
                {quickFilter !== "all" && (
                  <Badge variant="secondary" className="ml-1 px-1 py-0 h-4 text-[10px] min-w-[1.25rem] justify-center">
                    {QUICK_FILTER_CONFIG[quickFilter].label}
                  </Badge>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Filter by category</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {(Object.entries(QUICK_FILTER_CONFIG) as [any, any][]).map(([key, config]) => (
                <DropdownMenuCheckboxItem
                  key={key}
                  checked={quickFilter === key}
                  onCheckedChange={() => setQuickFilter(key)}
                  className="text-xs"
                >
                  {config.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Sort */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 gap-1.5 hidden md:flex">
                <ArrowUpDown className="h-3.5 w-3.5" />
                <span className="text-xs">Sort</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Sort by</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {sortOptions.map((option) => (
                <DropdownMenuCheckboxItem
                  key={option.value}
                  checked={sort === option.value}
                  onCheckedChange={() => setSort(option.value as any)}
                  className="text-xs"
                >
                  {option.label}
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={direction === "asc"}
                onCheckedChange={() => setDirection("asc")}
                className="text-xs"
              >
                Ascending
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={direction === "desc"}
                onCheckedChange={() => setDirection("desc")}
                className="text-xs"
              >
                Descending
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="flex-1" />

          {/* Drawing set breadcrumb */}
          {isViewingDrawingSet && (
            <Breadcrumb className="shrink-0 hidden lg:block">
              <BreadcrumbList className="flex-nowrap gap-1">
                <BreadcrumbItem>
                  <BreadcrumbLink
                    href="#"
                    onClick={(e) => {
                      e.preventDefault()
                      navigateToRoot()
                    }}
                    className="flex items-center gap-1 text-xs rounded px-1 py-0.5"
                  >
                    <FolderClosed className="h-3.5 w-3.5" />
                    All files
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator>
                  <ChevronRight className="h-3 w-3" />
                </BreadcrumbSeparator>
                <BreadcrumbItem>
                  <BreadcrumbPage className="text-xs truncate max-w-[200px]">
                    {selectedDrawingSetTitle || "Drawing Set"}
                  </BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          )}

          {/* Folder breadcrumbs */}
          {currentPath && !isViewingDrawingSet && (
            <Breadcrumb className="shrink-0 hidden lg:block">
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
          )}
        </div>

        {/* Right side: New dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" className="h-8 shrink-0 ml-auto">
              <Plus className="h-3.5 w-3.5 sm:mr-1.5" />
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
            <DropdownMenuItem onClick={onCreateFolderClick} disabled={isViewingDrawingSet}>
              <FolderPlus className="h-4 w-4 mr-2" />
              New folder
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Breadcrumbs for smaller screens */}
      {(currentPath || isViewingDrawingSet) && (
        <div className="lg:hidden px-1">
          {/* Duplicate of breadcrumb logic but visible only on small screens */}
          {isViewingDrawingSet ? (
            <Breadcrumb>
              <BreadcrumbList className="flex-nowrap gap-1">
                <BreadcrumbItem>
                  <BreadcrumbLink
                    href="#"
                    onClick={(e) => {
                      e.preventDefault()
                      navigateToRoot()
                    }}
                    className="flex items-center gap-1 text-[10px] rounded px-1 py-0.5"
                  >
                    <FolderClosed className="h-3 w-3" />
                    All files
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator>
                  <ChevronRight className="h-2.5 w-2.5" />
                </BreadcrumbSeparator>
                <BreadcrumbItem>
                  <BreadcrumbPage className="text-[10px] truncate max-w-[150px]">
                    {selectedDrawingSetTitle || "Drawing Set"}
                  </BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          ) : (
            <Breadcrumb>
              <BreadcrumbList className="flex-nowrap gap-1">
                <BreadcrumbItem>
                  <BreadcrumbLink
                    href="#"
                    onClick={(e) => {
                      e.preventDefault()
                      handleBreadcrumbClick(-1)
                    }}
                    className="flex items-center gap-1 text-[10px] rounded px-1 py-0.5"
                  >
                    <FolderClosed className="h-3 w-3" />
                    All files
                  </BreadcrumbLink>
                </BreadcrumbItem>
                {pathSegments.map((segment, index) => (
                  <Fragment key={segment + index}>
                    <BreadcrumbSeparator>
                      <ChevronRight className="h-2.5 w-2.5" />
                    </BreadcrumbSeparator>
                    <BreadcrumbItem>
                      {index === pathSegments.length - 1 ? (
                        <BreadcrumbPage className="text-[10px] truncate max-w-[120px]">
                          {segment}
                        </BreadcrumbPage>
                      ) : (
                        <BreadcrumbLink
                          href="#"
                          onClick={(e) => {
                            e.preventDefault()
                            handleBreadcrumbClick(index)
                          }}
                          className="text-[10px] truncate max-w-[120px] rounded px-1 py-0.5"
                        >
                          {segment}
                        </BreadcrumbLink>
                      )}
                    </BreadcrumbItem>
                  </Fragment>
                ))}
              </BreadcrumbList>
            </Breadcrumb>
          )}
        </div>
      )}

      {/* Bulk actions bar */}
      {selectedCount > 0 && (
        <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2">
          <span className="text-sm font-medium">{selectedCount} selected</span>
          <div className="flex items-center gap-1 ml-2">
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onDownloadSelected} disabled={isDownloadingSelected}>
              <Download className="h-3.5 w-3.5 mr-1" />
              {isDownloadingSelected ? "..." : "Download"}
            </Button>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onMoveSelected}>
              <FolderInput className="h-3.5 w-3.5 mr-1" />
              Move
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs text-destructive hover:text-destructive"
              onClick={onDeleteSelected}
            >
              <Trash2 className="h-3.5 w-3.5 mr-1" />
              Delete
            </Button>
          </div>
          <Button variant="ghost" size="sm" className="h-7 text-xs ml-auto" onClick={onClearSelection}>
            Clear
          </Button>
        </div>
      )}
    </div>
  )
}
