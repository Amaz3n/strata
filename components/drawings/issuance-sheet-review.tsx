"use client"

import { useMemo, useState } from "react"
import dynamic from "next/dynamic"
import { Check, ChevronLeft, ChevronRight, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { DrawingPreviewImage } from "@/components/drawings/drawing-preview-image"
import { cn } from "@/lib/utils"
import {
  DISCIPLINE_LABELS,
  type DrawingDiscipline
} from "@/lib/validation/drawings"
import { DISCIPLINE_SORT_ORDER } from "@/lib/utils/drawing-utils"
import type {
  RevisionDiffSheet,
  RevisionVersionPreview
} from "@/lib/services/drawings"
import type { TileManifest } from "@/lib/viewer"

const TiledDrawingViewer = dynamic(
  () =>
    import("@/components/drawings/viewer/tiled-drawing-viewer").then(
      (module) => module.TiledDrawingViewer
    ),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Opening drawing…
      </div>
    )
  }
)
export type IssuanceSheetEdit = {
  sheet_number?: string
  sheet_title?: string
  discipline?: DrawingDiscipline
}
const PAGE_SIZE = 30

export function IssuanceSheetReview({
  sheets,
  edits,
  decisions,
  deletedSheetNumbers,
  onEdit,
  onAccept,
  disabled
}: {
  sheets: RevisionDiffSheet[]
  edits: Record<string, IssuanceSheetEdit>
  decisions: Record<string, boolean>
  deletedSheetNumbers: Set<string>
  onEdit: (id: string, patch: IssuanceSheetEdit) => void
  onAccept: (id: string, accepted: boolean) => void
  disabled: boolean
}) {
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState("all")
  const [selectedId, setSelectedId] = useState<string>()
  const [listPage, setListPage] = useState(0)
  const [version, setVersion] = useState<"draft" | "current">("draft")
  const filtered = useMemo(
    () =>
      sheets.filter((sheet) => {
        const edit = edits[sheet.sheet_id]
        const text =
          `${edit?.sheet_number ?? sheet.sheet_number} ${edit?.sheet_title ?? sheet.sheet_title ?? ""}`.toLowerCase()
        return (
          text.includes(query.toLowerCase()) &&
          (filter === "all" || sheet.change === filter || (filter === "review" && sheet.needs_number_review && !edit?.sheet_number?.trim()))
        )
      }),
    [sheets, edits, query, filter]
  )
  const index = Math.max(
    0,
    filtered.findIndex((sheet) => sheet.sheet_id === selectedId)
  )
  const selected = filtered[index]
  const page = Math.min(
    listPage,
    Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1)
  )
  const select = (sheet: RevisionDiffSheet) => {
    setSelectedId(sheet.sheet_id)
    setVersion("draft")
  }
  const move = (next: number) => {
    select(filtered[next])
    setListPage(Math.floor(next / PAGE_SIZE))
  }
  const edit = selected ? edits[selected.sheet_id] : undefined
  const preview = selected
    ? version === "current" && selected.current
      ? selected.current
      : selected.draft
    : null

  return (
    <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[240px_minmax(0,1fr)] md:grid-rows-1">
      <aside
        className="flex min-h-0 flex-col border-b bg-muted/15 md:border-b-0 md:border-r"
        aria-label="Sheets in this issuance"
      >
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 p-3 md:block md:space-y-3 md:p-4">
          <div className="relative">
            <Search
              className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              aria-label="Search issuance sheets"
              placeholder="Find a sheet"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setListPage(0)
              }}
              className="h-9 pl-8"
            />
          </div>
          <Select
            value={filter}
            onValueChange={(value) => {
              setFilter(value)
              setListPage(0)
            }}
          >
            <SelectTrigger
              aria-label="Filter sheets"
              className="h-8 border-0 bg-transparent px-1 text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sheets · {sheets.length}</SelectItem>
              <SelectItem value="review">Needs review</SelectItem>
              <SelectItem value="updated">Updated sheets</SelectItem>
              <SelectItem value="added">New sheets</SelectItem>
            </SelectContent>
          </Select>
          <div className="col-span-2 md:hidden">
            <Select
              value={selected?.sheet_id ?? ""}
              onValueChange={(id) => {
                const sheet = filtered.find((s) => s.sheet_id === id)
                if (sheet) select(sheet)
              }}
            >
              <SelectTrigger aria-label="Choose sheet" className="w-full">
                <SelectValue placeholder="No matching sheets" />
              </SelectTrigger>
              <SelectContent>
                {filtered.map((sheet) => (
                  <SelectItem key={sheet.sheet_id} value={sheet.sheet_id}>
                    {edits[sheet.sheet_id]?.sheet_number ?? sheet.sheet_number}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="hidden min-h-0 flex-1 overflow-y-auto px-2 pb-2 md:block">
          {filtered
            .slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
            .map((sheet) => (
              <button
                key={sheet.sheet_id}
                type="button"
                onClick={() => select(sheet)}
                aria-pressed={selected?.sheet_id === sheet.sheet_id}
                className={cn(
                  "mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected?.sheet_id === sheet.sheet_id && "bg-muted"
                )}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {edits[sheet.sheet_id]?.sheet_number ?? sheet.sheet_number}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {edits[sheet.sheet_id]?.sheet_title ??
                      sheet.sheet_title ??
                      "Untitled sheet"}
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {sheet.change === "added" ? "New sheet" : "Updated"}
                    {decisions[sheet.sheet_id] === false ? " · Excluded" : ""}
                  </p>
                </div>
                {decisions[sheet.sheet_id] !== false && (
                  <Check
                    className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    aria-label="Included"
                  />
                )}
              </button>
            ))}
        </div>
        {filtered.length > PAGE_SIZE && (
          <div className="hidden items-center justify-between border-t p-3 text-xs text-muted-foreground md:flex">
            <Button
              size="icon"
              variant="ghost"
              aria-label="Previous list page"
              disabled={page === 0}
              onClick={() => setListPage(page - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            {page + 1} / {Math.ceil(filtered.length / PAGE_SIZE)}
            <Button
              size="icon"
              variant="ghost"
              aria-label="Next list page"
              disabled={(page + 1) * PAGE_SIZE >= filtered.length}
              onClick={() => setListPage(page + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </aside>
      {selected ? (
        <div className="flex min-h-0 min-w-0 flex-col overflow-y-auto xl:overflow-hidden">
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
            <div
              className="flex items-center gap-1 rounded-lg bg-muted/60 p-1"
              aria-label="Drawing version"
            >
              <Button
                size="sm"
                variant={version === "draft" ? "secondary" : "ghost"}
                aria-pressed={version === "draft"}
                onClick={() => setVersion("draft")}
              >
                Uploaded
              </Button>
              <Button
                size="sm"
                variant={version === "current" ? "secondary" : "ghost"}
                aria-pressed={version === "current"}
                disabled={!selected.current}
                onClick={() => setVersion("current")}
              >
                Current
              </Button>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Button
                size="icon"
                variant="ghost"
                aria-label="Previous sheet"
                disabled={index === 0}
                onClick={() => move(index - 1)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="tabular-nums">
                {index + 1} of {filtered.length}
              </span>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Next sheet"
                disabled={index === filtered.length - 1}
                onClick={() => move(index + 1)}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="grid min-h-0 flex-1 xl:grid-cols-[minmax(0,1fr)_260px]">
            <div
              className="relative min-h-[280px] bg-muted/35 xl:min-h-0"
              aria-label={`${version === "current" ? "Current" : "Uploaded"} drawing preview`}
            >
              <SheetPreview
                key={preview?.version_id}
                preview={preview}
                label={edit?.sheet_number ?? selected.sheet_number}
              />
            </div>
            <fieldset
              disabled={disabled}
              className="min-w-0 space-y-5 border-t p-5 xl:overflow-y-auto xl:border-l xl:border-t-0"
            >
              <div>
                <p className="text-xs font-medium text-muted-foreground">
                  SHEET DETAILS
                </p>
                <h3 className="mt-2 text-lg font-semibold">
                  {edit?.sheet_number ?? selected.sheet_number}
                </h3>
              </div>
              <label className="flex cursor-pointer items-center gap-3 text-sm">
                <Checkbox
                  checked={decisions[selected.sheet_id] !== false}
                  disabled={disabled}
                  onCheckedChange={(value) =>
                    onAccept(selected.sheet_id, value === true)
                  }
                />
                Include in issuance
              </label>
              {selected.needs_number_review && !edit?.sheet_number?.trim() && (
                <div role="alert" className="space-y-2 rounded-lg border p-3 text-sm">
                  <p className="font-medium">Needs review</p>
                  <p className="text-muted-foreground">We could not verify this number. Read the title block and correct it below, or confirm the displayed number.</p>
                  <Button type="button" variant="outline" size="sm"
                    onClick={() => onEdit(selected.sheet_id, { sheet_number: selected.sheet_number })}>
                    Confirm number
                  </Button>
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="review-sheet-number">Sheet number</Label>
                <Input
                  id="review-sheet-number"
                  value={edit?.sheet_number ?? selected.sheet_number}
                  onChange={(event) =>
                    onEdit(selected.sheet_id, {
                      sheet_number: event.target.value
                    })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="review-sheet-title">Title</Label>
                <Input
                  id="review-sheet-title"
                  value={edit?.sheet_title ?? selected.sheet_title ?? ""}
                  onChange={(event) =>
                    onEdit(selected.sheet_id, {
                      sheet_title: event.target.value
                    })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="review-sheet-trade">Trade</Label>
                <Select
                  disabled={disabled}
                  value={edit?.discipline ?? selected.discipline ?? "X"}
                  onValueChange={(value) =>
                    onEdit(selected.sheet_id, {
                      discipline: value as DrawingDiscipline
                    })
                  }
                >
                  <SelectTrigger id="review-sheet-trade" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DISCIPLINE_SORT_ORDER.map((code) => (
                      <SelectItem key={code} value={code}>
                        {DISCIPLINE_LABELS[code as DrawingDiscipline]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {selected.change === "added"
                  ? "Adds a new sheet to the register when published."
                  : "Replaces the current version when published. Earlier versions remain in history."}
              </p>
              {deletedSheetNumbers.has(selected.sheet_number) &&
                selected.change === "added" && (
                  <p className="text-xs text-muted-foreground">
                    Previously deleted. This sheet will return as new.
                  </p>
                )}
            </fieldset>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-center p-10 text-sm text-muted-foreground">
          No sheets match your search.
        </div>
      )}
    </div>
  )
}

function SheetPreview({
  preview,
  label
}: {
  preview?: RevisionVersionPreview | null
  label: string
}) {
  if (preview?.tile_base_url && preview.tile_manifest) {
    return (
      <TiledDrawingViewer
        tileBaseUrl={preview.tile_base_url}
        tileManifest={preview.tile_manifest as TileManifest}
        thumbnailUrl={preview.thumbnail_url ?? undefined}
        className="absolute inset-0 h-full w-full"
      />
    )
  }
  return (
    <DrawingPreviewImage
      url={preview?.thumbnail_url}
      alt={label}
      className="absolute inset-0 h-full w-full"
    />
  )
}
