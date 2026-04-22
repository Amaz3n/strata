"use client"

import { useRef } from "react"
import {
  Search,
  X,
  FolderClosed,
  FolderPlus,
  FolderInput,
  Trash2,
  Download,
  Plus,
  Upload,
  ListFilter,
  PanelLeft,
  PanelLeftClose,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useDocuments } from "./documents-context"
import { QUICK_FILTER_CONFIG } from "./types"

interface DocumentsToolbarProps {
  onUploadClick: () => void
  onCreateFolderClick: () => void
  selectedCount: number
  selectedFolderCount?: number
  onDownloadSelected: () => void
  onMoveSelected: () => void
  onDeleteSelected: () => void
  onClearSelection: () => void
  onOpenSelectedFolder?: () => void
  onRenameSelectedFolder?: () => void
  onShareSelectedFolder?: () => void
  onDeleteSelectedFolder?: () => void
  onDropToFolderPath: (path: string) => void
  onDropToRoot: () => void
  isDraggingFiles: boolean
  isDownloadingSelected?: boolean
  explorerOpen?: boolean
  onToggleExplorer?: () => void
}

export function DocumentsToolbar({
  onUploadClick,
  onCreateFolderClick,
  selectedCount,
  selectedFolderCount = 0,
  onDownloadSelected,
  onMoveSelected,
  onDeleteSelected,
  onClearSelection,
  onOpenSelectedFolder,
  onRenameSelectedFolder,
  onShareSelectedFolder,
  onDeleteSelectedFolder,
  onDropToFolderPath,
  onDropToRoot,
  isDraggingFiles,
  isDownloadingSelected = false,
  explorerOpen = false,
  onToggleExplorer,
}: DocumentsToolbarProps) {
  const {
    searchQuery,
    setSearchQuery,
    isUploading,
    quickFilter,
    setQuickFilter,
  } = useDocuments()

  const searchInputRef = useRef<HTMLInputElement>(null)
  const hasFolderSelection = selectedFolderCount > 0

  return (
    <div className="flex flex-col gap-2">
      {hasFolderSelection ? (
        <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
          <span className="text-sm font-medium">
            {selectedFolderCount} folder{selectedFolderCount === 1 ? "" : "s"} selected
          </span>
          {selectedFolderCount === 1 && (
            <>
              <Button variant="outline" size="sm" onClick={onOpenSelectedFolder}>
                <FolderClosed className="h-4 w-4 mr-2" />
                Open
              </Button>
              <Button variant="outline" size="sm" onClick={onRenameSelectedFolder}>
                <FolderInput className="h-4 w-4 mr-2" />
                Rename
              </Button>
              <Button variant="outline" size="sm" onClick={onShareSelectedFolder}>
                <Plus className="h-4 w-4 mr-2" />
                Share
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={onDeleteSelectedFolder}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete
              </Button>
            </>
          )}
          <Button variant="ghost" size="sm" onClick={onClearSelection}>
            Clear
          </Button>
        </div>
      ) : selectedCount > 0 ? (
        <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
          <span className="text-sm font-medium">{selectedCount} selected</span>
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
      ) : null}

      {/* Main toolbar row */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-1">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={onToggleExplorer}
            aria-label={explorerOpen ? "Hide explorer" : "Show explorer"}
            title={explorerOpen ? "Hide explorer" : "Show explorer"}
          >
            {explorerOpen ? (
              <PanelLeftClose className="h-3.5 w-3.5" />
            ) : (
              <PanelLeft className="h-3.5 w-3.5" />
            )}
          </Button>

          {/* Search */}
          <div className="relative w-full max-w-[300px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              placeholder="Search documents..."
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
              {(Object.entries(QUICK_FILTER_CONFIG) as [any, any][])
                .filter(([key]) => key !== "drawings")
                .map(([key, config]) => (
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

          <div className="flex-1" />
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
            <DropdownMenuItem onClick={onCreateFolderClick}>
              <FolderPlus className="h-4 w-4 mr-2" />
              New folder
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

    </div>
  )
}
