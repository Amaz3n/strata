"use client"

import { useRef } from "react"
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
  Shield,
  Download,
  Plus,
  Upload,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
import type { QuickFilter } from "./types"

const CATEGORY_LABELS: Record<Exclude<QuickFilter, "all" | "drawings">, string> = {
  plans: "Plans",
  photos: "Photos",
  contracts: "Contracts",
  permits: "Permits",
  submittals: "Submittals",
  rfis: "RFIs",
  safety: "Safety",
  financials: "Financials",
  other: "Other",
}

interface DocumentsHeaderProps {
  onUploadClick: () => void
  onCreateFolderClick: () => void
  onManageFolderAccessClick: () => void
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

export function DocumentsHeader({
  onUploadClick,
  onCreateFolderClick,
  onManageFolderAccessClick,
  selectedCount,
  onDownloadSelected,
  onMoveSelected,
  onDeleteSelected,
  onClearSelection,
  onDropToFolderPath,
  onDropToRoot,
  isDraggingFiles,
  isDownloadingSelected = false,
}: DocumentsHeaderProps) {
  const {
    currentPath,
    setCurrentPath,
    searchQuery,
    setSearchQuery,
    quickFilter,
    setQuickFilter,
    viewMode,
    setViewMode,
    isUploading,
    counts,
    drawingSets,
  } = useDocuments()

  const searchInputRef = useRef<HTMLInputElement>(null)
  const hasDrawingSets = drawingSets.length > 0

  const pathSegments = currentPath
    ? currentPath.split("/").filter(Boolean)
    : []

  const handleBreadcrumbClick = (index: number) => {
    if (index < 0) {
      setCurrentPath("")
    } else {
      const newPath = "/" + pathSegments.slice(0, index + 1).join("/")
      setCurrentPath(newPath)
    }
  }

  const totalSheets = drawingSets.reduce(
    (acc, set) => acc + (set.sheet_count ?? 0),
    0
  )

  const categoryKeys = Object.keys(CATEGORY_LABELS) as Array<Exclude<QuickFilter, "all" | "drawings">>
  const categoryOptions = categoryKeys.filter((cat) => {
    const count = counts[cat] ?? 0
    return count > 0 || quickFilter === cat
  })

  return (
    <div className="flex flex-col gap-3 pb-3">
      {selectedCount > 0 && (
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
      )}

      {/* Row 1: Category dropdown + Search + View toggle + New dropdown */}
      <div className="flex items-center gap-2">
        {/* Category dropdown */}
        <select
          value={quickFilter === "drawings" && !hasDrawingSets ? "all" : quickFilter}
          onChange={(event) => {
            const nextValue = event.target.value as QuickFilter
            setQuickFilter(nextValue)
            if (nextValue === "drawings") {
              setCurrentPath("")
            }
          }}
          className="h-8 w-[160px] rounded-md border border-input bg-background px-2 text-sm"
          aria-label="Filter documents by category"
        >
          <option value="all">All</option>
          {hasDrawingSets && (
            <option value="drawings">
              Drawings{totalSheets > 0 ? ` (${totalSheets})` : ""}
            </option>
          )}
          {categoryOptions.map((cat) => (
            <option key={cat} value={cat}>
              {CATEGORY_LABELS[cat]} ({counts[cat] ?? 0})
            </option>
          ))}
        </select>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Search */}
        <div className="relative w-48 sm:w-56 lg:w-64">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            ref={searchInputRef}
            placeholder="Search documents..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 h-8 text-sm"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* View toggle */}
        <div className="hidden sm:flex items-center border rounded-md">
          <button
            className={cn(
              "h-8 w-8 flex items-center justify-center transition-colors rounded-l-md",
              viewMode === "list" ? "bg-muted" : "hover:bg-muted/50"
            )}
            onClick={() => setViewMode("list")}
            title="List view"
          >
            <List className="h-4 w-4" />
          </button>
          <button
            className={cn(
              "h-8 w-8 flex items-center justify-center transition-colors rounded-r-md",
              viewMode === "grid" ? "bg-muted" : "hover:bg-muted/50"
            )}
            onClick={() => setViewMode("grid")}
            title="Grid view"
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
        </div>

        {/* New dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" className="h-8 shrink-0">
              <Plus className="h-4 w-4 sm:mr-1.5" />
              <span className="hidden sm:inline">New</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={onUploadClick} disabled={isUploading}>
              <Upload className="h-4 w-4 mr-2" />
              {isUploading ? "Uploading..." : "Upload files"}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={onCreateFolderClick}
              disabled={quickFilter === "drawings"}
            >
              <FolderPlus className="h-4 w-4 mr-2" />
              New folder
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {currentPath && quickFilter !== "drawings" && (
          <Button
            onClick={onManageFolderAccessClick}
            variant="outline"
            size="sm"
            className="h-8 shrink-0"
          >
            <Shield className="h-4 w-4 sm:mr-1.5" />
            <span className="hidden sm:inline">Access</span>
          </Button>
        )}
      </div>

      {/* Row 2: Breadcrumbs (only when inside a folder and not on drawings filter) */}
      {currentPath && quickFilter !== "drawings" && (
        <div className="flex items-center gap-3 min-h-[32px]">
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
                    isDraggingFiles && "hover:bg-muted"
                  )}
                >
                  <FolderClosed className="h-3.5 w-3.5" />
                  All files
                </BreadcrumbLink>
              </BreadcrumbItem>
              {pathSegments.map((segment, index) => (
                <BreadcrumbItem key={segment + index}>
                  <BreadcrumbSeparator>
                    <ChevronRight className="h-3 w-3" />
                  </BreadcrumbSeparator>
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
                        isDraggingFiles && "hover:bg-muted"
                      )}
                    >
                      {segment}
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      )}
    </div>
  )
}
