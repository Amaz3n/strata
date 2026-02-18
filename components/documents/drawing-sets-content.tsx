"use client"

import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import {
  Layers,
  Loader2,
  AlertCircle,
  Upload,
  ChevronRight,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { useDocuments } from "./documents-context"
import type { DrawingSet, DrawingSheet } from "@/app/(app)/drawings/actions"

export function DrawingSetsContent({
  onSheetClick,
  onUploadDrawingSetClick,
}: {
  onSheetClick?: (sheet: DrawingSheet) => void
  onUploadDrawingSetClick?: () => void
}) {
  const { drawingSets, searchQuery } = useDocuments()

  const filteredSets = searchQuery
    ? drawingSets.filter((set) =>
        set.title.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : drawingSets

  if (filteredSets.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-8">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted mb-4">
          <Layers className="h-8 w-8 text-muted-foreground" />
        </div>
        <h3 className="font-semibold text-lg">
          {searchQuery ? "No drawing sets found" : "No drawing sets yet"}
        </h3>
        <p className="text-sm text-muted-foreground mt-1 text-center max-w-sm">
          {searchQuery
            ? "Try adjusting your search query."
            : "Upload drawing set PDFs to automatically split them into individual sheets."}
        </p>
        {!searchQuery && onUploadDrawingSetClick && (
          <Button onClick={onUploadDrawingSetClick} className="mt-4" size="sm">
            <Upload className="h-4 w-4 mr-2" />
            Upload drawing set
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="py-3">
      <div className="rounded-lg border divide-y">
        {filteredSets.map((set) => (
          <DrawingSetRow key={set.id} set={set} onSheetClick={onSheetClick} />
        ))}
      </div>
    </div>
  )
}

export function DrawingSetsSection({
  onSheetClick,
}: {
  onSheetClick?: (sheet: DrawingSheet) => void
}) {
  const { drawingSets, searchQuery } = useDocuments()
  const [sectionOpen, setSectionOpen] = useState(true)

  const filteredSets = searchQuery
    ? drawingSets.filter((set) =>
        set.title.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : drawingSets

  if (filteredSets.length === 0) return null

  return (
    <div>
      <Collapsible open={sectionOpen} onOpenChange={setSectionOpen}>
        <CollapsibleTrigger asChild>
          <button className="flex w-full items-center gap-2 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
            <ChevronRight
              className={cn(
                "h-4 w-4 shrink-0 transition-transform duration-200",
                sectionOpen && "rotate-90"
              )}
            />
            <Layers className="h-4 w-4 shrink-0" />
            Drawing Sets
            <span className="tabular-nums text-xs opacity-70">
              ({filteredSets.length})
            </span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="rounded-lg border divide-y mb-4">
            {filteredSets.map((set) => (
              <DrawingSetRow key={set.id} set={set} onSheetClick={onSheetClick} />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

function DrawingSetRow({
  set,
  onSheetClick,
}: {
  set: DrawingSet
  onSheetClick?: (sheet: DrawingSheet) => void
}) {
  const {
    expandedDrawingSets,
    toggleDrawingSetExpanded,
    sheetsBySetId,
    loadSheetsForSet,
  } = useDocuments()

  const isExpanded = expandedDrawingSets.has(set.id)
  const sheets = sheetsBySetId[set.id]
  const isProcessing = set.status === "processing"
  const isFailed = set.status === "failed"
  const isReady = set.status === "ready"

  useEffect(() => {
    if (isExpanded && !sheets && isReady) {
      loadSheetsForSet(set.id)
    }
  }, [isExpanded, sheets, isReady, set.id, loadSheetsForSet])

  const progress = set.total_pages
    ? (set.processed_pages / set.total_pages) * 100
    : 0

  return (
    <Collapsible
      open={isExpanded}
      onOpenChange={(open) => {
        if (open !== isExpanded) {
          toggleDrawingSetExpanded(set.id)
        }
      }}
    >
      <CollapsibleTrigger asChild>
        <button className="flex w-full items-center gap-3 p-3 hover:bg-muted/50 transition-colors text-left">
          <div
            className={cn(
              "w-10 h-10 rounded-lg flex items-center justify-center shrink-0",
              isProcessing && "bg-blue-500/10",
              isFailed && "bg-destructive/10",
              isReady && "bg-muted"
            )}
          >
            {isProcessing ? (
              <Loader2 className="h-5 w-5 animate-spin text-blue-500" />
            ) : isFailed ? (
              <AlertCircle className="h-5 w-5 text-destructive" />
            ) : (
              <Layers className="h-5 w-5 text-muted-foreground" />
            )}
          </div>

          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm truncate">{set.title}</p>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {isProcessing && (
                <span className="text-blue-500">
                  Processing {set.processed_pages}/{set.total_pages ?? "?"}{" "}
                  pages
                </span>
              )}
              {isFailed && (
                <span className="text-destructive">
                  {set.error_message || "Processing failed"}
                </span>
              )}
              {isReady && (
                <span>
                  {set.sheet_count ?? 0}{" "}
                  {(set.sheet_count ?? 0) === 1 ? "sheet" : "sheets"}
                </span>
              )}
            </div>
            {isProcessing && <Progress value={progress} className="h-1 mt-1.5" />}
          </div>

          <ChevronRight
            className={cn(
              "h-4 w-4 text-muted-foreground shrink-0 transition-transform duration-200",
              isExpanded && "rotate-90"
            )}
          />
        </button>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="border-t bg-muted/20">
          {!sheets && isReady && (
            <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading sheets...
            </div>
          )}
          {sheets?.length === 0 && (
            <div className="px-4 py-3 text-sm text-muted-foreground">
              No sheets in this set
            </div>
          )}
          {sheets && sheets.length > 0 && (
            <div className="divide-y">
              {/* Sheet list header */}
              <div className="grid grid-cols-[auto_1fr_auto_auto] gap-3 px-4 py-2 text-xs font-medium text-muted-foreground">
                <span className="w-16">Sheet #</span>
                <span>Title</span>
                <span className="w-20 text-center">Discipline</span>
                <span className="w-16 text-right">Size</span>
              </div>
              {sheets.map((sheet) => (
                <SheetRow key={sheet.id} sheet={sheet} onClick={onSheetClick} />
              ))}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function SheetRow({
  sheet,
  onClick,
}: {
  sheet: DrawingSheet
  onClick?: (sheet: DrawingSheet) => void
}) {
  return (
    <button
      className="grid grid-cols-[auto_1fr_auto_auto] gap-3 w-full items-center px-4 py-2.5 hover:bg-muted/50 transition-colors text-left text-sm"
      onClick={() => onClick?.(sheet)}
      disabled={!onClick}
    >
      <span className="w-16 font-medium text-xs">{sheet.sheet_number}</span>
      <span className="truncate text-sm">{sheet.sheet_title || "Untitled"}</span>
      <span className="w-20 text-center">
        {sheet.discipline && (
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
            {sheet.discipline}
          </Badge>
        )}
      </span>
      <span className="w-16 text-right text-xs text-muted-foreground">
        {sheet.image_width && sheet.image_height
          ? `${Math.round(sheet.image_width)}×${Math.round(sheet.image_height)}`
          : ""}
      </span>
    </button>
  )
}
