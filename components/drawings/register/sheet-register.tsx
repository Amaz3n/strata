"use client"

import { Fragment, useCallback, useMemo, useRef, useState } from "react"
import {
  ChevronRight,
  Download,
  Eye,
  FileWarning,
  History,
  LayoutGrid,
  MoreHorizontal,
  Pencil,
  Rows3,
  Send,
  Trash2,
  Upload,
} from "lucide-react"

import type { DrawingSheet } from "@/lib/services/drawings"
import type { DrawingDiscipline } from "@/lib/validation/drawings"
import { DISCIPLINE_LABELS } from "@/lib/validation/drawings"
import {
  DISCIPLINE_SORT_ORDER,
  disciplineGradientClass,
  disciplineIcon,
  sortSheetNumbers,
} from "@/lib/utils/drawing-utils"
import { prefetchTilesCookie } from "@/lib/drawings/tiles-cookie-client"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

export type RegisterSortKey = "number" | "updated"
export type RegisterViewMode = "list" | "grid"

export interface DisciplineGroup {
  code: string
  label: string
  sheets: DrawingSheet[]
}

interface SheetRegisterProps {
  /** Sheets after the caller's name filter has been applied. */
  sheets: DrawingSheet[]
  /** How many sheets exist in total for this project, ignoring the render cap. */
  totalSheetCount?: number
  /** How many sheets were loaded before filtering — the cap applies to this. */
  loadedSheetCount: number
  search: string
  expandedDisciplines: Set<string>
  onToggleDiscipline: (code: string) => void
  onViewSheet: (sheet: DrawingSheet, versionId?: string | null, openVersions?: boolean) => void
  onRenameSheet: (sheet: DrawingSheet) => void
  onDeleteSheet: (sheet: DrawingSheet) => void
  onUploadRevisionSheet: (sheet: DrawingSheet) => void
  onDisciplineChange: (sheetId: string, discipline: DrawingDiscipline) => void
  onEditGroup: (group: DisciplineGroup) => void
  onDeleteGroup: (group: DisciplineGroup) => void
  onBulkSharingChange: (
    sheetIds: string[],
    sharing: { share_with_clients?: boolean; share_with_subs?: boolean }
  ) => Promise<void> | void
  onBulkDisciplineChange: (sheetIds: string[], discipline: DrawingDiscipline) => Promise<void> | void
}

function formatDate(value?: string | null) {
  if (!value) return "—"
  const date = new Date(value)
  const now = new Date()
  const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24))
  if (diffDays === 0) return "Today"
  if (diffDays === 1) return "Yesterday"
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  })
}

function sheetVersionLabel(sheet: DrawingSheet) {
  // Label by the sheet's own published version count: uploaded once -> v1,
  // revised once -> v2, etc. Immune to project-wide revision numbering.
  const count = sheet.version_count ?? 0
  return `v${count > 0 ? count : 1}`
}

function disciplineLabel(code?: DrawingDiscipline | string | null) {
  if (!code) return "Other"
  return DISCIPLINE_LABELS[code as DrawingDiscipline] ?? String(code)
}

function Highlighted({ text, highlight }: { text: string; highlight: string }) {
  const needle = highlight.trim().toLowerCase()
  if (!needle) return <>{text}</>
  const index = text.toLowerCase().indexOf(needle)
  if (index === -1) return <>{text}</>
  return (
    <>
      {text.slice(0, index)}
      <mark className="bg-primary/20 text-foreground">
        {text.slice(index, index + needle.length)}
      </mark>
      {text.slice(index + needle.length)}
    </>
  )
}

/**
 * Open work anchored to this sheet. Populated by the denormalized register view;
 * undefined when that view is unavailable, in which case we render nothing
 * rather than an untrue zero.
 */
function SheetActivity({ sheet }: { sheet: DrawingSheet }) {
  const openPins = sheet.open_pins_count
  const markups = sheet.markups_count

  if (openPins == null && markups == null) return null

  return (
    <span className="inline-flex items-center gap-2 tabular-nums">
      {openPins != null && openPins > 0 && (
        <span
          className="inline-flex items-center gap-1 text-warning"
          title={`${openPins} open ${openPins === 1 ? "item" : "items"} on this sheet`}
        >
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
          {openPins}
        </span>
      )}
      {markups != null && markups > 0 && (
        <span className="text-muted-foreground" title={`${markups} markups`}>
          {markups} mk
        </span>
      )}
    </span>
  )
}

function SheetThumbnail({ sheet, className }: { sheet: DrawingSheet; className?: string }) {
  const url = sheet.image_thumbnail_url
  if (!url) {
    return (
      <div
        className={cn(
          "flex items-center justify-center border bg-muted text-muted-foreground",
          className
        )}
      >
        <FileWarning className="h-3 w-3" />
      </div>
    )
  }
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      className={cn("border bg-background object-cover object-top", className)}
    />
  )
}

function SheetRowMenu({
  sheet,
  onOpen,
  onRename,
  onViewVersions,
  onUploadRevision,
  onDelete,
  onDisciplineChange,
}: {
  sheet: DrawingSheet
  onOpen: () => void
  onRename: () => void
  onViewVersions: () => void
  onUploadRevision: () => void
  onDelete: () => void
  onDisciplineChange: (discipline: DrawingDiscipline) => void
}) {
  const currentDiscipline = (sheet.discipline as DrawingDiscipline) ?? "X"
  const sheetLabel = sheet.sheet_title || sheet.sheet_number

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 transition-opacity md:opacity-0 md:group-hover:opacity-100 data-[state=open]:opacity-100"
          aria-label={`Actions for ${sheet.sheet_number}`}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onClick={onOpen}>
          <Eye className="mr-2 h-4 w-4" />
          Open
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onRename}>
          <Pencil className="mr-2 h-4 w-4" />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onViewVersions}>
          <History className="mr-2 h-4 w-4" />
          Version history
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onUploadRevision}>
          <Upload className="mr-2 h-4 w-4" />
          Submit sheet issuance
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a
            href={`/projects/${sheet.project_id}/transmittals?drawingSheet=${sheet.id}&description=${encodeURIComponent(sheetLabel)}`}
          >
            <Send className="mr-2 h-4 w-4" />
            Send as transmittal
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => window.open(`/api/drawings/export?sheetId=${sheet.id}`, "_blank")}
        >
          <Download className="mr-2 h-4 w-4" />
          Download with markups
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <span className="mr-2 inline-flex h-4 w-6 items-center justify-center border font-mono text-[10px]">
              {currentDiscipline}
            </span>
            Discipline
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52">
            {DISCIPLINE_SORT_ORDER.map((code) => (
              <DropdownMenuItem
                key={code}
                onClick={() => {
                  if (code !== currentDiscipline) onDisciplineChange(code)
                }}
                className={cn("gap-2", code === currentDiscipline && "bg-muted font-medium")}
              >
                <span
                  className={cn(
                    "inline-flex h-5 w-8 items-center justify-center border font-mono text-[11px]",
                    disciplineGradientClass(code)
                  )}
                >
                  {code}
                </span>
                <span>{disciplineLabel(code)}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="mr-2 h-4 w-4" />
          Delete sheet
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function SheetRow({
  sheet,
  search,
  selected,
  onSelectedChange,
  onOpen,
  onRename,
  onViewVersions,
  onUploadRevision,
  onDelete,
  onDisciplineChange,
  indented,
}: {
  sheet: DrawingSheet
  search: string
  selected: boolean
  onSelectedChange: (next: boolean) => void
  onOpen: () => void
  onRename: () => void
  onViewVersions: () => void
  onUploadRevision: () => void
  onDelete: () => void
  onDisciplineChange: (discipline: DrawingDiscipline) => void
  indented: boolean
}) {
  return (
    <TableRow
      className="group cursor-pointer border-t border-border/40 hover:bg-muted/20"
      onClick={onOpen}
      data-state={selected ? "selected" : undefined}
    >
      <TableCell className="w-10 pl-4" onClick={(event) => event.stopPropagation()}>
        <Checkbox
          checked={selected}
          onCheckedChange={(value) => onSelectedChange(value === true)}
          aria-label={`Select ${sheet.sheet_number}`}
        />
      </TableCell>
      <TableCell className={cn("w-[120px]", indented && "pl-6")}>
        <div className="flex items-center gap-2">
          <SheetThumbnail sheet={sheet} className="h-8 w-6 shrink-0" />
          <span className="truncate font-mono text-xs font-medium tabular-nums">
            <Highlighted text={sheet.sheet_number || "—"} highlight={search} />
          </span>
        </div>
      </TableCell>
      <TableCell className="min-w-0">
        <div className="truncate text-sm">
          <Highlighted text={sheet.sheet_title || "Untitled sheet"} highlight={search} />
        </div>
      </TableCell>
      <TableCell className="hidden w-[120px] text-xs sm:table-cell">
        <SheetActivity sheet={sheet} />
      </TableCell>
      <TableCell className="hidden w-[100px] text-center text-xs text-muted-foreground tabular-nums md:table-cell">
        {sheetVersionLabel(sheet)}
      </TableCell>
      <TableCell className="hidden w-[150px] truncate text-center text-xs text-muted-foreground md:table-cell">
        {sheet.last_modified_by_name ?? sheet.current_revision_creator_name ?? "—"}
      </TableCell>
      <TableCell className="hidden w-[120px] text-center text-xs text-muted-foreground tabular-nums lg:table-cell">
        {formatDate(sheet.updated_at)}
      </TableCell>
      <TableCell className="w-[60px] pr-4" onClick={(event) => event.stopPropagation()}>
        <div className="flex justify-end">
          <SheetRowMenu
            sheet={sheet}
            onOpen={onOpen}
            onRename={onRename}
            onViewVersions={onViewVersions}
            onUploadRevision={onUploadRevision}
            onDelete={onDelete}
            onDisciplineChange={onDisciplineChange}
          />
        </div>
      </TableCell>
    </TableRow>
  )
}

function SheetCard({
  sheet,
  search,
  selected,
  onSelectedChange,
  onOpen,
}: {
  sheet: DrawingSheet
  search: string
  selected: boolean
  onSelectedChange: (next: boolean) => void
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group relative flex flex-col border text-left transition-colors hover:bg-muted/30",
        selected && "ring-1 ring-primary"
      )}
    >
      <span
        className="absolute left-2 top-2 z-10"
        onClick={(event) => {
          event.stopPropagation()
        }}
      >
        <Checkbox
          checked={selected}
          onCheckedChange={(value) => onSelectedChange(value === true)}
          aria-label={`Select ${sheet.sheet_number}`}
        />
      </span>
      <SheetThumbnail sheet={sheet} className="h-40 w-full border-0 border-b" />
      <span className="flex min-w-0 flex-col gap-0.5 p-2">
        <span className="truncate font-mono text-xs font-medium tabular-nums">
          <Highlighted text={sheet.sheet_number || "—"} highlight={search} />
        </span>
        <span className="truncate text-xs text-muted-foreground">
          <Highlighted text={sheet.sheet_title || "Untitled sheet"} highlight={search} />
        </span>
        <span className="flex items-center justify-between pt-1 text-[11px] text-muted-foreground">
          <span className="tabular-nums">{sheetVersionLabel(sheet)}</span>
          <SheetActivity sheet={sheet} />
        </span>
      </span>
    </button>
  )
}

export function SheetRegister({
  sheets,
  totalSheetCount,
  loadedSheetCount,
  search,
  expandedDisciplines,
  onToggleDiscipline,
  onViewSheet,
  onRenameSheet,
  onDeleteSheet,
  onUploadRevisionSheet,
  onDisciplineChange,
  onEditGroup,
  onDeleteGroup,
  onBulkSharingChange,
  onBulkDisciplineChange,
}: SheetRegisterProps) {
  const [sortKey, setSortKey] = useState<RegisterSortKey>("number")
  const [viewMode, setViewMode] = useState<RegisterViewMode>("list")
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const warmedTilesAccess = useRef(false)

  // Opening a sheet costs a cookie mint plus a TLS handshake before the first
  // tile moves. Hovering or focusing a row is intent enough to pay both early.
  const warmTilesAccess = useCallback(() => {
    if (warmedTilesAccess.current) return
    warmedTilesAccess.current = true
    prefetchTilesCookie()
  }, [])

  const tilesOrigin = useMemo(() => {
    const base = sheets.find((sheet) => sheet.tile_base_url)?.tile_base_url
    if (!base) return null
    try {
      return new URL(base).origin
    } catch {
      return null
    }
  }, [sheets])

  const truncatedBy =
    totalSheetCount != null && totalSheetCount > loadedSheetCount
      ? totalSheetCount - loadedSheetCount
      : 0

  // Sorting by recent activity flattens the discipline grouping: the question
  // "what changed lately" is cross-discipline by nature.
  const groups = useMemo<DisciplineGroup[]>(() => {
    if (sortKey !== "number") return []
    const map = new Map<string, DrawingSheet[]>()
    for (const sheet of sheets) {
      const key = sheet.discipline ?? "X"
      const existing = map.get(key)
      if (existing) existing.push(sheet)
      else map.set(key, [sheet])
    }
    return Array.from(map.entries())
      .map(([code, list]) => ({
        code,
        label: disciplineLabel(code),
        sheets: [...list].sort((a, b) => sortSheetNumbers(a.sheet_number, b.sheet_number)),
      }))
      .sort((a, b) => {
        const ai = DISCIPLINE_SORT_ORDER.indexOf(a.code as DrawingDiscipline)
        const bi = DISCIPLINE_SORT_ORDER.indexOf(b.code as DrawingDiscipline)
        if (ai === -1 && bi === -1) return a.code.localeCompare(b.code)
        if (ai === -1) return 1
        if (bi === -1) return -1
        return ai - bi
      })
  }, [sheets, sortKey])

  const flatSheets = useMemo(() => {
    if (sortKey === "number") return []
    return [...sheets].sort(
      (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    )
  }, [sheets, sortKey])

  // While searching, every matching group is open regardless of manual state.
  const isExpanded = useCallback(
    (code: string) => (search.trim() ? true : expandedDisciplines.has(code)),
    [search, expandedDisciplines]
  )

  const visibleSheetIds = useMemo(() => {
    if (sortKey !== "number") return flatSheets.map((sheet) => sheet.id)
    return groups.flatMap((group) =>
      isExpanded(group.code) ? group.sheets.map((sheet) => sheet.id) : []
    )
  }, [sortKey, flatSheets, groups, isExpanded])

  const allVisibleSelected =
    visibleSheetIds.length > 0 && visibleSheetIds.every((id) => selectedIds.has(id))

  const toggleSelected = useCallback((sheetId: string, next: boolean) => {
    setSelectedIds((prev) => {
      const updated = new Set(prev)
      if (next) updated.add(sheetId)
      else updated.delete(sheetId)
      return updated
    })
  }, [])

  const toggleAllVisible = useCallback(
    (next: boolean) => {
      setSelectedIds((prev) => {
        const updated = new Set(prev)
        for (const id of visibleSheetIds) {
          if (next) updated.add(id)
          else updated.delete(id)
        }
        return updated
      })
    },
    [visibleSheetIds]
  )

  const clearSelection = useCallback(() => setSelectedIds(new Set()), [])

  const selectedList = useMemo(() => Array.from(selectedIds), [selectedIds])

  const runBulkSharing = useCallback(
    async (sharing: { share_with_clients?: boolean; share_with_subs?: boolean }) => {
      await onBulkSharingChange(selectedList, sharing)
      clearSelection()
    },
    [onBulkSharingChange, selectedList, clearSelection]
  )

  const runBulkDiscipline = useCallback(
    async (discipline: DrawingDiscipline) => {
      await onBulkDisciplineChange(selectedList, discipline)
      clearSelection()
    },
    [onBulkDisciplineChange, selectedList, clearSelection]
  )

  const renderSheetRow = (sheet: DrawingSheet, indented: boolean) => (
    <SheetRow
      key={sheet.id}
      sheet={sheet}
      search={search}
      indented={indented}
      selected={selectedIds.has(sheet.id)}
      onSelectedChange={(next) => toggleSelected(sheet.id, next)}
      onOpen={() => onViewSheet(sheet)}
      onRename={() => onRenameSheet(sheet)}
      onViewVersions={() => onViewSheet(sheet, null, true)}
      onUploadRevision={() => onUploadRevisionSheet(sheet)}
      onDelete={() => onDeleteSheet(sheet)}
      onDisciplineChange={(discipline) => onDisciplineChange(sheet.id, discipline)}
    />
  )

  return (
    <div
      className="flex min-h-0 flex-col"
      onPointerEnter={warmTilesAccess}
      onFocusCapture={warmTilesAccess}
    >
      {tilesOrigin && <link rel="preconnect" href={tilesOrigin} crossOrigin="use-credentials" />}
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        {selectedList.length > 0 ? (
          <>
            <span className="text-xs font-medium tabular-nums">
              {selectedList.length} selected
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-8">
                  Bulk actions
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
                  Sharing
                </DropdownMenuLabel>
                <DropdownMenuItem
                  onClick={() => void runBulkSharing({ share_with_clients: true })}
                >
                  Share with clients
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => void runBulkSharing({ share_with_clients: false })}
                >
                  Unshare from clients
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => void runBulkSharing({ share_with_subs: true })}>
                  Share with subs
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => void runBulkSharing({ share_with_subs: false })}>
                  Unshare from subs
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>Change discipline</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-52">
                    {DISCIPLINE_SORT_ORDER.map((code) => (
                      <DropdownMenuItem
                        key={code}
                        className="gap-2"
                        onClick={() => void runBulkDiscipline(code)}
                      >
                        <span
                          className={cn(
                            "inline-flex h-5 w-8 items-center justify-center border font-mono text-[11px]",
                            disciplineGradientClass(code)
                          )}
                        >
                          {code}
                        </span>
                        <span>{disciplineLabel(code)}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="ghost" size="sm" className="h-8" onClick={clearSelection}>
              Clear
            </Button>
          </>
        ) : (
          <>
            <span className="text-xs text-muted-foreground">Sort</span>
            <Select
              value={sortKey}
              onValueChange={(value) => setSortKey(value as RegisterSortKey)}
            >
              <SelectTrigger className="h-8 w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="number">Sheet number</SelectItem>
                <SelectItem value="updated">Recently updated</SelectItem>
              </SelectContent>
            </Select>
          </>
        )}

        <div className="ml-auto flex items-center gap-2">
          {truncatedBy > 0 && (
            <span className="text-xs text-warning tabular-nums">
              Showing {loadedSheetCount} of {totalSheetCount} sheets
            </span>
          )}
          <ToggleGroup
            type="single"
            value={viewMode}
            onValueChange={(value) => {
              if (value) setViewMode(value as RegisterViewMode)
            }}
            variant="outline"
            size="sm"
          >
            <ToggleGroupItem value="list" aria-label="List view">
              <Rows3 className="h-4 w-4" />
            </ToggleGroupItem>
            <ToggleGroupItem value="grid" aria-label="Grid view">
              <LayoutGrid className="h-4 w-4" />
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>

      {sheets.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-muted-foreground">
          No sheets match this filter.
        </div>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {(sortKey === "number" ? groups.flatMap((group) => group.sheets) : flatSheets).map(
            (sheet) => (
              <SheetCard
                key={sheet.id}
                sheet={sheet}
                search={search}
                selected={selectedIds.has(sheet.id)}
                onSelectedChange={(next) => toggleSelected(sheet.id, next)}
                onOpen={() => onViewSheet(sheet)}
              />
            )
          )}
        </div>
      ) : (
        <Table className="table-fixed sm:min-w-[980px]">
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead className="w-10 pl-4">
                <Checkbox
                  checked={allVisibleSelected}
                  onCheckedChange={(value) => toggleAllVisible(value === true)}
                  aria-label="Select all visible sheets"
                />
              </TableHead>
              <TableHead className="w-[120px] text-xs font-medium text-muted-foreground">
                Sheet
              </TableHead>
              <TableHead className="text-xs font-medium text-muted-foreground">Title</TableHead>
              <TableHead className="hidden w-[120px] text-xs font-medium text-muted-foreground sm:table-cell">
                Activity
              </TableHead>
              <TableHead className="hidden w-[100px] text-center text-xs font-medium text-muted-foreground md:table-cell">
                Version
              </TableHead>
              <TableHead className="hidden w-[150px] text-center text-xs font-medium text-muted-foreground md:table-cell">
                Modified by
              </TableHead>
              <TableHead className="hidden w-[120px] text-center text-xs font-medium text-muted-foreground lg:table-cell">
                Updated
              </TableHead>
              <TableHead className="w-[60px] pr-4" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortKey === "number"
              ? groups.map((group) => {
                  const Icon = disciplineIcon(group.code)
                  const expanded = isExpanded(group.code)
                  return (
                    <Fragment key={group.code}>
                      <TableRow
                        className={cn(
                          "group cursor-pointer border-t bg-background hover:bg-muted/30",
                          expanded && "bg-muted/20"
                        )}
                        onClick={() => onToggleDiscipline(group.code)}
                      >
                        <TableCell className="w-10 pl-4">
                          <ChevronRight
                            className={cn(
                              "h-4 w-4 text-muted-foreground transition-transform",
                              expanded && "rotate-90"
                            )}
                          />
                        </TableCell>
                        <TableCell colSpan={2}>
                          <div className="flex min-w-0 items-center gap-3">
                            <span
                              className={cn(
                                "inline-flex h-8 w-8 shrink-0 items-center justify-center border",
                                disciplineGradientClass(group.code)
                              )}
                            >
                              <Icon className="h-4 w-4" />
                            </span>
                            <span className="truncate text-sm font-semibold">{group.label}</span>
                            <span className="text-xs text-muted-foreground tabular-nums">
                              {group.sheets.length}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell" />
                        <TableCell className="hidden md:table-cell" />
                        <TableCell className="hidden md:table-cell" />
                        <TableCell className="hidden lg:table-cell" />
                        <TableCell
                          className="pr-4"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <div className="flex justify-end">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 transition-opacity md:opacity-0 md:group-hover:opacity-100 data-[state=open]:opacity-100"
                                  aria-label={`Actions for ${group.label}`}
                                >
                                  <MoreHorizontal className="h-3.5 w-3.5" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-56">
                                <DropdownMenuItem onClick={() => onEditGroup(group)}>
                                  <Pencil className="mr-2 h-4 w-4" />
                                  Change discipline
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  className="text-destructive focus:text-destructive"
                                  onClick={() => onDeleteGroup(group)}
                                >
                                  <Trash2 className="mr-2 h-4 w-4" />
                                  Delete all {group.sheets.length} sheets
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </TableCell>
                      </TableRow>
                      {expanded && group.sheets.map((sheet) => renderSheetRow(sheet, true))}
                    </Fragment>
                  )
                })
              : flatSheets.map((sheet) => renderSheetRow(sheet, false))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
