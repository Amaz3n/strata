"use client"

import { useState, useMemo } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ChevronRight, ChevronDown, Pencil, X } from "lucide-react"
import { detectDiscipline, DISCIPLINE_SORT_ORDER } from "@/lib/utils/drawing-utils"
import { DISCIPLINE_LABELS } from "@/lib/validation/drawings"
import type { DrawingDiscipline } from "@/lib/validation/drawings"
import { cn } from "@/lib/utils"

export interface DetectedSheet {
  pageIndex: number
  sheetNumber: string
  sheetTitle: string
  discipline: DrawingDiscipline
  thumbnailUrl?: string
}

interface UploadPreviewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  fileName: string
  processingProgress: number // 0-100
  totalPages: number
  processedPages: number
  detectedSheets: DetectedSheet[]
  onUpdateSheet: (pageIndex: number, updates: Partial<DetectedSheet>) => void
  onAccept: (setTitle: string, revisionLabel: string) => void
  onCancel: () => void
}

export function UploadPreviewDialog({
  open,
  onOpenChange,
  fileName,
  processingProgress,
  totalPages,
  processedPages,
  detectedSheets,
  onUpdateSheet,
  onAccept,
  onCancel,
}: UploadPreviewDialogProps) {
  const [setTitle, setSetTitle] = useState(
    fileName.replace(/\.pdf$/i, "").replace(/[-_]/g, " ")
  )
  const [revisionLabel, setRevisionLabel] = useState("Rev A")
  const [editingSheet, setEditingSheet] = useState<DetectedSheet | null>(null)
  const [expandedDisciplines, setExpandedDisciplines] = useState<Set<string>>(
    new Set(["A", "S", "M", "E", "P"]) // Expand common ones by default
  )

  // Group sheets by discipline
  const sheetsByDiscipline = useMemo(() => {
    const groups: Record<string, DetectedSheet[]> = {}

    for (const sheet of detectedSheets) {
      const disc = sheet.discipline
      if (!groups[disc]) groups[disc] = []
      groups[disc].push(sheet)
    }

    // Sort by sheet number within each group
    for (const sheets of Object.values(groups)) {
      sheets.sort((a, b) => a.sheetNumber.localeCompare(b.sheetNumber))
    }

    // Sort disciplines by standard order
    return Object.entries(groups).sort(
      ([a], [b]) =>
        DISCIPLINE_SORT_ORDER.indexOf(a as DrawingDiscipline) -
        DISCIPLINE_SORT_ORDER.indexOf(b as DrawingDiscipline)
    )
  }, [detectedSheets])

  const toggleDiscipline = (disc: string) => {
    setExpandedDisciplines((prev) => {
      const next = new Set(prev)
      if (next.has(disc)) {
        next.delete(disc)
      } else {
        next.add(disc)
      }
      return next
    })
  }

  const isProcessing = processingProgress < 100

  const handleAccept = () => {
    onAccept(setTitle, revisionLabel)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Upload Plan Set</DialogTitle>
        </DialogHeader>

        {/* Progress Section */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium truncate max-w-[300px]">{fileName}</span>
            <span className="text-muted-foreground">
              {isProcessing
                ? `Processing ${processedPages} of ${totalPages}...`
                : "Complete"}
            </span>
          </div>
          <Progress value={processingProgress} />
        </div>

        {/* Sheets Preview */}
        <div className="flex-1 overflow-y-auto border rounded-lg min-h-[200px]">
          <div className="p-3 border-b bg-muted/50 sticky top-0 z-10">
            <span className="text-sm font-medium">
              Detected {detectedSheets.length} sheets
            </span>
          </div>

          {detectedSheets.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              {isProcessing
                ? "Processing sheets..."
                : "No sheets detected"}
            </div>
          ) : (
            <div className="divide-y">
              {sheetsByDiscipline.map(([discipline, sheets]) => (
                <Collapsible
                  key={discipline}
                  open={expandedDisciplines.has(discipline)}
                  onOpenChange={() => toggleDiscipline(discipline)}
                >
                  <CollapsibleTrigger className="flex items-center gap-2 w-full p-3 hover:bg-muted/50 transition-colors text-left">
                    {expandedDisciplines.has(discipline) ? (
                      <ChevronDown className="h-4 w-4 shrink-0" />
                    ) : (
                      <ChevronRight className="h-4 w-4 shrink-0" />
                    )}
                    <span className="font-medium">
                      {DISCIPLINE_LABELS[discipline as DrawingDiscipline]}
                    </span>
                    <span className="text-muted-foreground">
                      ({sheets.length} {sheets.length === 1 ? "sheet" : "sheets"})
                    </span>
                  </CollapsibleTrigger>

                  <CollapsibleContent>
                    <div className="pl-9 pr-3 pb-2 space-y-1">
                      {sheets.map((sheet) => (
                        <div
                          key={sheet.pageIndex}
                          className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-muted/50 group"
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <span className="font-mono text-sm w-16 shrink-0">
                              {sheet.sheetNumber}
                            </span>
                            <span className="text-sm text-muted-foreground truncate">
                              {sheet.sheetTitle}
                            </span>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                            onClick={() => setEditingSheet(sheet)}
                          >
                            <Pencil className="h-3 w-3" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
          )}
        </div>

        {/* Set Metadata */}
        <div className="grid grid-cols-2 gap-4 pt-2">
          <div className="space-y-2">
            <Label htmlFor="setTitle">Set Title</Label>
            <Input
              id="setTitle"
              value={setTitle}
              onChange={(e) => setSetTitle(e.target.value)}
              placeholder="e.g., December 2024 CD Set"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="revision">Revision</Label>
            <Input
              id="revision"
              value={revisionLabel}
              onChange={(e) => setRevisionLabel(e.target.value)}
              placeholder="e.g., Rev A, For Construction"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={handleAccept} disabled={isProcessing || !setTitle.trim()}>
            {isProcessing ? "Processing..." : "Accept & Finalize"}
          </Button>
        </DialogFooter>

        {/* Edit Sheet Dialog */}
        {editingSheet && (
          <EditSheetDialog
            sheet={editingSheet}
            onSave={(updates) => {
              onUpdateSheet(editingSheet.pageIndex, updates)
              setEditingSheet(null)
            }}
            onCancel={() => setEditingSheet(null)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

interface EditSheetDialogProps {
  sheet: DetectedSheet
  onSave: (updates: Partial<DetectedSheet>) => void
  onCancel: () => void
}

function EditSheetDialog({ sheet, onSave, onCancel }: EditSheetDialogProps) {
  const [sheetNumber, setSheetNumber] = useState(sheet.sheetNumber)
  const [sheetTitle, setSheetTitle] = useState(sheet.sheetTitle)
  const [discipline, setDiscipline] = useState<DrawingDiscipline>(sheet.discipline)

  // Auto-update discipline when sheet number changes
  const handleSheetNumberChange = (value: string) => {
    setSheetNumber(value)
    const detected = detectDiscipline(value)
    if (detected !== "X") {
      setDiscipline(detected)
    }
  }

  const handleSave = () => {
    onSave({ sheetNumber, sheetTitle, discipline })
  }

  return (
    <Dialog open onOpenChange={() => onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Sheet</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="sheetNumber">Sheet Number</Label>
            <Input
              id="sheetNumber"
              value={sheetNumber}
              onChange={(e) => handleSheetNumberChange(e.target.value)}
              placeholder="e.g., A-101"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="sheetTitle">Sheet Title</Label>
            <Input
              id="sheetTitle"
              value={sheetTitle}
              onChange={(e) => setSheetTitle(e.target.value)}
              placeholder="e.g., First Floor Plan"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="discipline">Discipline</Label>
            <Select
              value={discipline}
              onValueChange={(value) => setDiscipline(value as DrawingDiscipline)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select discipline" />
              </SelectTrigger>
              <SelectContent>
                {DISCIPLINE_SORT_ORDER.map((code) => (
                  <SelectItem key={code} value={code}>
                    {DISCIPLINE_LABELS[code]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {sheet.thumbnailUrl && (
            <div className="space-y-2">
              <Label>Preview</Label>
              <div className="border rounded-lg overflow-hidden bg-muted">
                <img
                  src={sheet.thumbnailUrl}
                  alt={`Preview of ${sheetNumber}`}
                  className="w-full h-auto"
                />
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={handleSave}>Save Changes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
