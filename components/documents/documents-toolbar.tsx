"use client"

import Link from "next/link"

import {
  Search,
  X,
  FolderClosed,
  FolderPlus,
  FolderInput,
  Trash2,
  Download,
  CheckSquare,
  Plus,
  Share2,
  Upload,
  Undo2,
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
import { useDocuments, useDocumentsSearchInput } from "./documents-context"
import { QUICK_FILTER_CONFIG, type QuickFilter } from "./types"
import { cn } from "@/lib/utils"

interface DocumentsToolbarProps {
  plansHref?: string
  preconstruction?: boolean
  onUploadClick: () => void
  onCreateFolderClick: () => void
  selectedCount: number
  selectedFolderCount?: number
  onDownloadSelected: () => void
  onMoveSelected: () => void
  onDeleteSelected: () => void
  onRestoreSelected?: () => void
  onClearSelection: () => void
  onOpenSelectedFolder?: () => void
  onRenameSelectedFolder?: () => void
  onShareSelectedFolder?: () => void
  onDeleteSelectedFolder?: () => void
  isDownloadingSelected?: boolean
  explorerOpen?: boolean
  onToggleExplorer?: () => void
}

export function DocumentsToolbar({
  preconstruction = false,
  plansHref,
  onUploadClick,
  onCreateFolderClick,
  selectedCount,
  selectedFolderCount = 0,
  onDownloadSelected,
  onMoveSelected,
  onDeleteSelected,
  onRestoreSelected,
  onClearSelection,
  onOpenSelectedFolder,
  onRenameSelectedFolder,
  onShareSelectedFolder,
  onDeleteSelectedFolder,
  isDownloadingSelected = false,
  explorerOpen = false,
  onToggleExplorer,
}: DocumentsToolbarProps) {
  const { quickFilter, setQuickFilter } = useDocuments()
  const [searchInput, setSearchInput] = useDocumentsSearchInput()

  const hasFolderSelection = selectedFolderCount > 0
  const isTrashView = quickFilter === "trash"

  return (
    <div className={cn("flex flex-col gap-2", preconstruction && "gap-3 [&>div:first-child]:rounded-none")}>
      {hasFolderSelection ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-none border border-primary/20 bg-primary/5 px-3 py-2 shadow-sm">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-none bg-primary text-primary-foreground">
              <CheckSquare className="h-4 w-4" />
            </span>
            <Badge variant="secondary" className="h-7 px-2.5 text-xs font-semibold">
              {selectedFolderCount} folder{selectedFolderCount === 1 ? "" : "s"}
            </Badge>
            <span className="text-sm font-medium text-foreground">selected</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {selectedFolderCount === 1 && (
              <>
                <Button variant="secondary" size="sm" className="h-8" onClick={onOpenSelectedFolder}>
                  <FolderClosed className="h-4 w-4 mr-2" />
                  Open
                </Button>
                <Button variant="secondary" size="sm" className="h-8" onClick={onRenameSelectedFolder}>
                  <FolderInput className="h-4 w-4 mr-2" />
                  Rename
                </Button>
                <Button variant="secondary" size="sm" className="h-8" onClick={onShareSelectedFolder}>
                  <Share2 className="h-4 w-4 mr-2" />
                  Share
                </Button>
              </>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-destructive hover:text-destructive"
              onClick={onDeleteSelectedFolder}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClearSelection} aria-label="Clear selection">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : selectedCount > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-none border border-primary/20 bg-primary/5 px-3 py-2 shadow-sm">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-none bg-primary text-primary-foreground">
              <CheckSquare className="h-4 w-4" />
            </span>
            <Badge variant="secondary" className="h-7 px-2.5 text-xs font-semibold">
              {selectedCount} file{selectedCount === 1 ? "" : "s"}
            </Badge>
            <span className="text-sm font-medium text-foreground">selected</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button variant="secondary" size="sm" className="h-8" onClick={onDownloadSelected} disabled={isDownloadingSelected}>
              <Download className="h-4 w-4 mr-2" />
              {isDownloadingSelected ? "Downloading..." : "Download"}
            </Button>
            {isTrashView ? (
              <Button variant="secondary" size="sm" className="h-8" onClick={onRestoreSelected ?? onDeleteSelected}>
                <Undo2 className="h-4 w-4 mr-2" />
                Restore
              </Button>
            ) : (
              <>
                <Button variant="secondary" size="sm" className="h-8" onClick={onMoveSelected}>
                  <FolderInput className="h-4 w-4 mr-2" />
                  Move
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-destructive hover:text-destructive"
                  onClick={onDeleteSelected}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </Button>
              </>
            )}
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClearSelection} aria-label="Clear selection">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : null}

      {/* Main toolbar row */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className={cn("h-8 w-8 shrink-0", preconstruction && "hidden h-10 w-10 rounded-none border-border/60 shadow-none lg:inline-flex")}
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
          <div className={cn("relative w-full max-w-[300px]", preconstruction && "max-w-sm")}>
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search documents..."
              aria-label="Search documents"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className={cn("h-8 pl-8 text-sm", preconstruction && "h-10 rounded-none border-border/60 bg-muted/30 pr-8 shadow-none")}
            />
            {searchInput && (
              <button
                type="button"
                aria-label="Clear document search"
                onClick={() => setSearchInput("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          {/* Category Filter */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className={cn("h-8 gap-1.5 hidden md:flex", preconstruction && "h-10 rounded-none border-border/60 px-3 shadow-none")}>
                <ListFilter className="h-3.5 w-3.5" />
                <span className="text-xs">Filter</span>
                {quickFilter !== "all" && (
                  <Badge variant="secondary" className="ml-1 px-1 py-0 h-4 text-[10px] min-w-[1.25rem] justify-center">
                    {QUICK_FILTER_CONFIG[quickFilter].label}
                  </Badge>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Filter documents</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {(Object.entries(QUICK_FILTER_CONFIG) as [QuickFilter, { label: string; icon: string }][])
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

        {preconstruction && (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {plansHref && (
              <Button asChild variant="outline" className="h-10 rounded-none shadow-none">
                <Link href={plansHref}>Plans &amp; quantities</Link>
              </Button>
            )}
            <Button variant="outline" className="h-10 rounded-none shadow-none" onClick={onCreateFolderClick}>
              <FolderPlus className="size-4" />
              New folder
            </Button>
            <Button className="h-10 rounded-none px-4" onClick={onUploadClick}>
              <Upload className="size-4" />
              Upload files
            </Button>
          </div>
        )}

        {/* Right side: New dropdown */}
        {!preconstruction && <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" className="h-8 shrink-0 ml-auto">
              <Plus className="h-3.5 w-3.5 sm:mr-1.5" />
              <span className="hidden sm:inline">New</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={onUploadClick}>
              <Upload className="h-4 w-4 mr-2" />
              Upload files
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onCreateFolderClick}>
              <FolderPlus className="h-4 w-4 mr-2" />
              New folder
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>}
      </div>

    </div>
  )
}
