"use client"

import { cn } from "@/lib/utils"
import {
  Search,
  Grid3X3,
  List,
  SlidersHorizontal,
  Download,
  Trash2,
  FolderInput,
  X,
} from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu"

export type ViewMode = "grid" | "list"

interface FileToolbarProps {
  viewMode: ViewMode
  onViewModeChange: (mode: ViewMode) => void
  searchQuery: string
  onSearchChange: (query: string) => void
  selectedCount: number
  onBulkDownload?: () => void
  onBulkDelete?: () => void
  onBulkMove?: () => void
  onClearSelection?: () => void
  showImageOnly?: boolean
  onShowImageOnlyChange?: (value: boolean) => void
  className?: string
}

export function FileToolbar({
  viewMode,
  onViewModeChange,
  searchQuery,
  onSearchChange,
  selectedCount,
  onBulkDownload,
  onBulkDelete,
  onBulkMove,
  onClearSelection,
  showImageOnly,
  onShowImageOnlyChange,
  className,
}: FileToolbarProps) {
  const hasSelection = selectedCount > 0

  return (
    <div
      className={cn(
        "flex flex-col sm:flex-row items-start sm:items-center gap-3",
        className
      )}
    >
      {/* Search */}
      <div className="relative flex-1 w-full sm:max-w-xs">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search files..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-9 h-9"
        />
        {searchQuery && (
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
            onClick={() => onSearchChange("")}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <div className="flex items-center gap-2 w-full sm:w-auto">
        {/* Bulk actions */}
        {hasSelection ? (
          <div className="flex items-center gap-2 flex-1 sm:flex-initial">
            <span className="text-sm text-muted-foreground">
              {selectedCount} selected
            </span>
            {onBulkDownload && (
              <Button variant="outline" size="sm" onClick={onBulkDownload}>
                <Download className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">Download</span>
              </Button>
            )}
            {onBulkMove && (
              <Button variant="outline" size="sm" onClick={onBulkMove}>
                <FolderInput className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">Move</span>
              </Button>
            )}
            {onBulkDelete && (
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={onBulkDelete}
              >
                <Trash2 className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">Delete</span>
              </Button>
            )}
            {onClearSelection && (
              <Button variant="ghost" size="sm" onClick={onClearSelection}>
                <X className="h-4 w-4 mr-1" />
                Clear
              </Button>
            )}
          </div>
        ) : (
          <>
            {/* Filters */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-9">
                  <SlidersHorizontal className="h-4 w-4 sm:mr-2" />
                  <span className="hidden sm:inline">Filters</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuLabel>Filter by type</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem
                  checked={showImageOnly}
                  onCheckedChange={onShowImageOnlyChange}
                >
                  Images only
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem>PDFs only</DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem>Documents only</DropdownMenuCheckboxItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Date range</DropdownMenuLabel>
                <DropdownMenuItem>Last 7 days</DropdownMenuItem>
                <DropdownMenuItem>Last 30 days</DropdownMenuItem>
                <DropdownMenuItem>Last 90 days</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}

        {/* View mode toggle */}
        <div className="flex items-center border rounded-md ml-auto sm:ml-0">
          <Button
            variant={viewMode === "grid" ? "secondary" : "ghost"}
            size="sm"
            className="h-9 px-3 rounded-r-none"
            onClick={() => onViewModeChange("grid")}
          >
            <Grid3X3 className="h-4 w-4" />
          </Button>
          <Button
            variant={viewMode === "list" ? "secondary" : "ghost"}
            size="sm"
            className="h-9 px-3 rounded-l-none"
            onClick={() => onViewModeChange("list")}
          >
            <List className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}






