"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import {
  AlertCircle,
  FilePlus2,
  Layers,
  Loader2,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SheetsTable } from "./documents-table"
import {
  createDrawingRevisionAction,
  createDrawingSetFromUpload,
  createSheetVersionAction,
  deleteDrawingSetAction,
  deleteDrawingSheetAction,
  listDrawingRevisionsAction,
  listDrawingSheetsWithUrlsAction,
  listSheetVersionsAction,
  retryProcessingAction,
  updateDrawingSetAction,
  updateDrawingSheetAction,
} from "@/app/(app)/drawings/actions"
import { uploadFileAction } from "@/app/(app)/files/actions"
import { uploadDrawingFileToStorage } from "@/lib/services/drawings-client"
import type {
  DrawingRevision,
  DrawingSet,
  DrawingSheet,
} from "@/app/(app)/drawings/actions"
import {
  DISCIPLINE_LABELS,
  DRAWING_SET_TYPE_LABELS,
  type DrawingDiscipline,
  type DrawingSetType,
} from "@/lib/validation/drawings"
import { useDocuments } from "./documents-context"

const DRAWING_SET_TYPES = Object.entries(DRAWING_SET_TYPE_LABELS)
const DISCIPLINE_OPTIONS = Object.entries(DISCIPLINE_LABELS) as Array<[DrawingDiscipline, string]>
const SHEETS_PAGE_SIZE = 30

function coerceSetType(value?: string | null): DrawingSetType {
  if (value && value in DRAWING_SET_TYPE_LABELS) return value as DrawingSetType
  return "general"
}

function matchesSheetQuery(sheet: DrawingSheet, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return (
    sheet.sheet_number.toLowerCase().includes(q) ||
    (sheet.sheet_title ?? "").toLowerCase().includes(q) ||
    (sheet.discipline ?? "").toLowerCase().includes(q) ||
    (sheet.current_revision_label ?? "").toLowerCase().includes(q)
  )
}

function formatCompactDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Unknown"
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
  })
}

function dispatchNavRefresh() {
  window.dispatchEvent(new CustomEvent("docs-nav-refresh"))
}

export function SheetsContent({
  onSheetClick,
  onUploadDrawingSetClick: _onUploadDrawingSetClick,
}: {
  onSheetClick?: (sheet: DrawingSheet) => void
  onUploadDrawingSetClick?: () => void
}) {
  const {
    drawingSets,
    searchQuery,
    projectId,
    selectedDrawingSetId,
    setSelectedDrawingSet,
    refreshDrawingSets,
    refreshFiles,
  } = useDocuments()

  const selectedSet = useMemo(
    () => drawingSets.find((s) => s.id === selectedDrawingSetId) ?? null,
    [drawingSets, selectedDrawingSetId],
  )

  const [sheetPage, setSheetPage] = useState(1)
  const [sheets, setSheets] = useState<DrawingSheet[]>([])
  const [loadingSheets, setLoadingSheets] = useState(false)

  const [editingSet, setEditingSet] = useState<DrawingSet | null>(null)
  const [setTitle, setSetTitle] = useState("")
  const [setDescription, setSetDescription] = useState("")
  const [setType, setSetType] = useState<DrawingSetType>("general")
  const [savingSet, setSavingSet] = useState(false)

  const [deletingSet, setDeletingSet] = useState<DrawingSet | null>(null)
  const [deletingSetPending, setDeletingSetPending] = useState(false)
  const [retryingSetId, setRetryingSetId] = useState<string | null>(null)

  const [setRevisionTarget, setSetRevisionTarget] = useState<DrawingSet | null>(null)
  const [setRevisionLabelValue, setSetRevisionLabel] = useState("")
  const [setRevisionNotesValue, setSetRevisionNotes] = useState("")
  const [setRevisionFile, setSetRevisionFile] = useState<File | null>(null)
  const [uploadingSetRevision, setUploadingSetRevision] = useState(false)

  const [editingSheet, setEditingSheet] = useState<{ sheet: DrawingSheet } | null>(null)
  const [sheetNumber, setSheetNumber] = useState("")
  const [sheetTitle, setSheetTitle] = useState("")
  const [sheetDiscipline, setSheetDiscipline] = useState("")
  const [savingSheet, setSavingSheet] = useState(false)

  const [deletingSheet, setDeletingSheet] = useState<{ sheet: DrawingSheet } | null>(null)
  const [deletingSheetPending, setDeletingSheetPending] = useState(false)

  const [versionTarget, setVersionTarget] = useState<{ sheet: DrawingSheet } | null>(null)
  const [versionFile, setVersionFile] = useState<File | null>(null)
  const [revisionLabel, setRevisionLabel] = useState("")
  const [revisionNotes, setRevisionNotes] = useState("")
  const [knownRevisions, setKnownRevisions] = useState<DrawingRevision[]>([])
  const [knownVersionCount, setKnownVersionCount] = useState<number>(0)
  const [loadingVersionMeta, setLoadingVersionMeta] = useState(false)
  const [savingVersion, setSavingVersion] = useState(false)

  const loadSheets = useCallback(
    async (setId: string, force = false) => {
      if (!force && sheets.length > 0 && selectedDrawingSetId === setId) return
      setLoadingSheets(true)
      try {
        const data = await listDrawingSheetsWithUrlsAction({
          project_id: projectId,
          drawing_set_id: setId,
          limit: 500,
        })
        setSheets(data)
        setSheetPage(1)
      } catch (error) {
        console.error("Failed to load sheets:", error)
        toast.error("Failed to load sheets")
      } finally {
        setLoadingSheets(false)
      }
    },
    [projectId, sheets.length, selectedDrawingSetId],
  )

  useEffect(() => {
    if (!selectedSet) {
      setSheets([])
      return
    }
    void loadSheets(selectedSet.id)
  }, [selectedSet?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const filteredSheets = useMemo(
    () => sheets.filter((sheet) => matchesSheetQuery(sheet, searchQuery.trim())),
    [sheets, searchQuery],
  )

  const totalPages = Math.max(1, Math.ceil(filteredSheets.length / SHEETS_PAGE_SIZE))
  const clampedPage = Math.min(sheetPage, totalPages)
  const paginatedSheets = useMemo(() => {
    const start = (clampedPage - 1) * SHEETS_PAGE_SIZE
    return filteredSheets.slice(start, start + SHEETS_PAGE_SIZE)
  }, [clampedPage, filteredSheets])

  useEffect(() => {
    if (sheetPage > totalPages) setSheetPage(totalPages)
  }, [sheetPage, totalPages])

  useEffect(() => {
    setSheetPage(1)
  }, [searchQuery])

  const openSetEdit = useCallback((set: DrawingSet) => {
    setEditingSet(set)
    setSetTitle(set.title)
    setSetDescription(set.description ?? "")
    setSetType(coerceSetType(set.set_type))
  }, [])

  const saveSetEdit = useCallback(async () => {
    if (!editingSet) return
    const title = setTitle.trim()
    if (!title) {
      toast.error("Set title is required")
      return
    }
    setSavingSet(true)
    try {
      await updateDrawingSetAction(editingSet.id, {
        title,
        description: setDescription.trim() || null,
        set_type: setType,
      })
      await refreshDrawingSets()
      dispatchNavRefresh()
      toast.success("Drawing set updated")
      setEditingSet(null)
    } catch (error) {
      console.error("Failed to update drawing set:", error)
      toast.error("Failed to update drawing set")
    } finally {
      setSavingSet(false)
    }
  }, [editingSet, refreshDrawingSets, setDescription, setTitle, setType])

  const retrySet = useCallback(
    async (setId: string) => {
      setRetryingSetId(setId)
      try {
        await retryProcessingAction(setId)
        await refreshDrawingSets()
        dispatchNavRefresh()
        toast.success("Set processing retried")
      } catch (error) {
        console.error("Failed to retry processing:", error)
        toast.error("Failed to retry processing")
      } finally {
        setRetryingSetId(null)
      }
    },
    [refreshDrawingSets],
  )

  const confirmDeleteSet = useCallback(async () => {
    if (!deletingSet) return
    setDeletingSetPending(true)
    try {
      await deleteDrawingSetAction(deletingSet.id)
      await Promise.all([refreshDrawingSets(), refreshFiles()])
      dispatchNavRefresh()
      toast.success("Drawing set deleted")
      setDeletingSet(null)
      setSelectedDrawingSet(null, null)
    } catch (error) {
      console.error("Failed to delete drawing set:", error)
      toast.error("Failed to delete drawing set")
    } finally {
      setDeletingSetPending(false)
    }
  }, [deletingSet, refreshDrawingSets, refreshFiles, setSelectedDrawingSet])

  const openSetRevisionDialog = useCallback((set: DrawingSet) => {
    setSetRevisionTarget(set)
    setSetRevisionFile(null)
    setSetRevisionNotes("")
    setSetRevisionLabel(`Rev ${new Date().toISOString().slice(0, 10)}`)
  }, [])

  const uploadSetRevision = useCallback(async () => {
    if (!setRevisionTarget) return
    if (!setRevisionFile) {
      toast.error("Select a PDF file")
      return
    }
    if (setRevisionFile.type && setRevisionFile.type !== "application/pdf") {
      toast.error("Only PDF files are supported for set revisions")
      return
    }
    const label = setRevisionLabelValue.trim()
    if (!label) {
      toast.error("Revision label is required")
      return
    }
    setUploadingSetRevision(true)
    try {
      const { storagePath } = await uploadDrawingFileToStorage(setRevisionFile, projectId)
      const nextTitle = `${setRevisionTarget.title} (${label})`
      const newSet = await createDrawingSetFromUpload({
        projectId,
        title: nextTitle,
        setType: setRevisionTarget.set_type ?? "general",
        fileName: setRevisionFile.name,
        storagePath,
        fileSize: setRevisionFile.size,
        mimeType: setRevisionFile.type || "application/pdf",
      })
      const revisionNote = setRevisionNotesValue.trim()
      await updateDrawingSetAction(newSet.id, {
        description: revisionNote
          ? `Revision of ${setRevisionTarget.title}: ${revisionNote}`
          : `Revision of ${setRevisionTarget.title}`,
      })
      await Promise.all([refreshDrawingSets(), refreshFiles()])
      dispatchNavRefresh()
      setSelectedDrawingSet(newSet.id, newSet.title)
      toast.success("Set revision uploaded and queued for processing")
      setSetRevisionTarget(null)
      setSetRevisionFile(null)
    } catch (error) {
      console.error("Failed to upload set revision:", error)
      toast.error("Failed to upload set revision")
    } finally {
      setUploadingSetRevision(false)
    }
  }, [
    projectId,
    refreshDrawingSets,
    refreshFiles,
    setSelectedDrawingSet,
    setRevisionFile,
    setRevisionLabelValue,
    setRevisionNotesValue,
    setRevisionTarget,
  ])

  const openSheetEdit = useCallback((sheet: DrawingSheet) => {
    setEditingSheet({ sheet })
    setSheetNumber(sheet.sheet_number)
    setSheetTitle(sheet.sheet_title ?? "")
    setSheetDiscipline(sheet.discipline ?? "")
  }, [])

  const saveSheetEdit = useCallback(async () => {
    if (!editingSheet || !selectedSet) return
    const nextSheetNumber = sheetNumber.trim()
    if (!nextSheetNumber) {
      toast.error("Sheet number is required")
      return
    }
    setSavingSheet(true)
    try {
      await updateDrawingSheetAction(editingSheet.sheet.id, {
        sheet_number: nextSheetNumber,
        sheet_title: sheetTitle.trim() || null,
        discipline: (sheetDiscipline.trim() || null) as DrawingDiscipline | null,
      })
      await Promise.all([loadSheets(selectedSet.id, true), refreshDrawingSets()])
      toast.success("Sheet updated")
      setEditingSheet(null)
    } catch (error) {
      console.error("Failed to update sheet:", error)
      toast.error("Failed to update sheet")
    } finally {
      setSavingSheet(false)
    }
  }, [editingSheet, selectedSet, loadSheets, refreshDrawingSets, sheetDiscipline, sheetNumber, sheetTitle])

  const confirmDeleteSheet = useCallback(async () => {
    if (!deletingSheet || !selectedSet) return
    setDeletingSheetPending(true)
    try {
      await deleteDrawingSheetAction(deletingSheet.sheet.id)
      await Promise.all([loadSheets(selectedSet.id, true), refreshDrawingSets()])
      dispatchNavRefresh()
      toast.success("Sheet deleted")
      setDeletingSheet(null)
    } catch (error) {
      console.error("Failed to delete sheet:", error)
      toast.error("Failed to delete sheet")
    } finally {
      setDeletingSheetPending(false)
    }
  }, [deletingSheet, selectedSet, loadSheets, refreshDrawingSets])

  const openVersionDialog = useCallback(
    async (sheet: DrawingSheet) => {
      if (!selectedSet) return
      setVersionTarget({ sheet })
      setVersionFile(null)
      setRevisionNotes("")
      setRevisionLabel("")
      setKnownRevisions([])
      setKnownVersionCount(0)
      setLoadingVersionMeta(true)
      try {
        const [revisions, versions] = await Promise.all([
          listDrawingRevisionsAction({
            project_id: projectId,
            drawing_set_id: selectedSet.id,
            limit: 100,
          }),
          listSheetVersionsAction(sheet.id),
        ])
        setKnownRevisions(revisions)
        setKnownVersionCount(versions.length)
        setRevisionLabel(`Rev ${revisions.length + 1}`)
      } catch (error) {
        console.error("Failed to load version metadata:", error)
        setRevisionLabel("Rev 1")
      } finally {
        setLoadingVersionMeta(false)
      }
    },
    [projectId, selectedSet],
  )

  const submitSheetVersion = useCallback(async () => {
    if (!versionTarget || !selectedSet) return
    if (!versionFile) {
      toast.error("Choose a version file")
      return
    }
    const cleanRevisionLabel = revisionLabel.trim()
    if (!cleanRevisionLabel) {
      toast.error("Revision label is required")
      return
    }
    setSavingVersion(true)
    try {
      const formData = new FormData()
      formData.append("file", versionFile)
      formData.append("projectId", projectId)
      formData.append("category", "plans")
      formData.append("folderPath", `/drawings/versions/${selectedSet.id}`)
      formData.append("description", `Drawing version for ${versionTarget.sheet.sheet_number}`)

      const uploaded = await uploadFileAction(formData)
      const revision = await createDrawingRevisionAction({
        project_id: projectId,
        drawing_set_id: selectedSet.id,
        revision_label: cleanRevisionLabel,
        issued_date: new Date().toISOString().slice(0, 10),
        notes: revisionNotes.trim() || undefined,
      })
      await createSheetVersionAction({
        drawing_sheet_id: versionTarget.sheet.id,
        drawing_revision_id: revision.id,
        file_id: uploaded.id,
        extracted_metadata: {
          source: "documents-sheet-version",
          original_file_name: versionFile.name,
        },
      })
      await updateDrawingSheetAction(versionTarget.sheet.id, {
        current_revision_id: revision.id,
      })
      await Promise.all([
        loadSheets(selectedSet.id, true),
        refreshDrawingSets(),
        refreshFiles(),
      ])
      toast.success("New sheet version added")
      setVersionTarget(null)
      setVersionFile(null)
    } catch (error) {
      console.error("Failed to add sheet version:", error)
      toast.error("Failed to add sheet version")
    } finally {
      setSavingVersion(false)
    }
  }, [
    loadSheets,
    projectId,
    refreshDrawingSets,
    refreshFiles,
    revisionLabel,
    revisionNotes,
    selectedSet,
    versionFile,
    versionTarget,
  ])

  if (!selectedSet) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-8">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted mb-4">
          <Layers className="h-8 w-8 text-muted-foreground" />
        </div>
        <h3 className="font-semibold text-lg">Drawing set not found</h3>
        <p className="text-sm text-muted-foreground mt-1 text-center max-w-sm">
          Select a drawing set from the sidebar to view its sheets.
        </p>
      </div>
    )
  }

  return (
    <>
      <div className="space-y-3 py-3">
        <div className="border bg-card">
          <div className="px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="truncate text-base font-semibold">{selectedSet.title}</h3>
                {selectedSet.description && (
                  <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                    {selectedSet.description}
                  </p>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>{selectedSet.sheet_count ?? 0} sheets</span>
                  <span aria-hidden>•</span>
                  <span>{DRAWING_SET_TYPE_LABELS[coerceSetType(selectedSet.set_type)]}</span>
                  <span aria-hidden>•</span>
                  <span>Uploaded {formatCompactDate(selectedSet.created_at)}</span>
                  <span aria-hidden>•</span>
                  <span>Updated {formatCompactDate(selectedSet.updated_at)}</span>
                </div>
              </div>

              <div className="flex items-center gap-1">
                {selectedSet.status === "failed" && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8"
                    onClick={() => retrySet(selectedSet.id)}
                    disabled={retryingSetId === selectedSet.id}
                  >
                    {retryingSetId === selectedSet.id ? (
                      <>
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        Retrying
                      </>
                    ) : (
                      "Retry processing"
                    )}
                  </Button>
                )}

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    <DropdownMenuItem onClick={() => openSetEdit(selectedSet)}>
                      <Pencil className="mr-2 h-4 w-4" />
                      Edit set metadata
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => openSetRevisionDialog(selectedSet)}>
                      <FilePlus2 className="mr-2 h-4 w-4" />
                      Upload set revision
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive"
                      onClick={() => setDeletingSet(selectedSet)}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Delete set
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            {selectedSet.status === "processing" && (
              <div className="mt-3 max-w-md">
                <div className="mb-1 text-[11px] text-muted-foreground">
                  Processing {selectedSet.processed_pages}/{selectedSet.total_pages ?? "?"} pages
                </div>
                <Progress
                  value={
                    selectedSet.total_pages
                      ? (selectedSet.processed_pages / selectedSet.total_pages) * 100
                      : 0
                  }
                  className="h-1.5"
                />
              </div>
            )}

            {selectedSet.status === "failed" && selectedSet.error_message && (
              <div className="mt-2 flex items-center gap-1.5 text-xs text-destructive">
                <AlertCircle className="h-3.5 w-3.5" />
                <span>{selectedSet.error_message}</span>
              </div>
            )}
          </div>
        </div>

        {selectedSet.status !== "ready" && (
          <div className="flex items-center justify-center border bg-card px-6 py-16 text-sm text-muted-foreground">
            Sheets will appear when processing is complete.
          </div>
        )}

        {selectedSet.status === "ready" && (
          <>
            {searchQuery && (
              <p className="text-xs text-muted-foreground">
                Filtering sheets by: <span className="font-medium text-foreground">{searchQuery}</span>
              </p>
            )}

            {loadingSheets && (
              <div className="space-y-2">
                {Array.from({ length: 6 }).map((_, idx) => (
                  <div
                    key={`sheet-loading-${idx}`}
                    className="h-[60px] border bg-muted/20 animate-pulse"
                  />
                ))}
              </div>
            )}

            {!loadingSheets && filteredSheets.length === 0 && (
              <div className="flex items-center justify-center border bg-card px-6 py-16 text-sm text-muted-foreground">
                {searchQuery ? "No sheets match the current search." : "No sheets in this drawing set yet."}
              </div>
            )}

            {!loadingSheets && filteredSheets.length > 0 && (
              <>
                <SheetsTable
                  sheets={paginatedSheets}
                  onSheetClick={onSheetClick}
                  onEditSheet={openSheetEdit}
                  onDeleteSheet={(sheet) => setDeletingSheet({ sheet })}
                  onAddVersion={(sheet) => {
                    void openVersionDialog(sheet)
                  }}
                />

                <div className="flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">
                    Showing {(clampedPage - 1) * SHEETS_PAGE_SIZE + 1}
                    -
                    {Math.min(clampedPage * SHEETS_PAGE_SIZE, filteredSheets.length)}{" "}
                    of {filteredSheets.length}
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7"
                      disabled={clampedPage <= 1}
                      onClick={() => setSheetPage(Math.max(1, clampedPage - 1))}
                    >
                      Prev
                    </Button>
                    <span className="tabular-nums text-xs text-muted-foreground">
                      {clampedPage}/{totalPages}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7"
                      disabled={clampedPage >= totalPages}
                      onClick={() => setSheetPage(Math.min(totalPages, clampedPage + 1))}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </div>

      {/* Edit set dialog */}
      <Dialog open={Boolean(editingSet)} onOpenChange={(open) => !open && setEditingSet(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit drawing set</DialogTitle>
            <DialogDescription>Update metadata for this set.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="sheets-set-title">Title</Label>
              <Input
                id="sheets-set-title"
                value={setTitle}
                onChange={(event) => setSetTitle(event.target.value)}
                disabled={savingSet}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sheets-set-description">Description</Label>
              <Input
                id="sheets-set-description"
                value={setDescription}
                onChange={(event) => setSetDescription(event.target.value)}
                placeholder="Optional"
                disabled={savingSet}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sheets-set-type">Type</Label>
              <select
                id="sheets-set-type"
                value={setType}
                onChange={(event) => setSetType(coerceSetType(event.target.value))}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                disabled={savingSet}
              >
                {DRAWING_SET_TYPES.map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingSet(null)} disabled={savingSet}>Cancel</Button>
            <Button onClick={saveSetEdit} disabled={savingSet}>
              {savingSet ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Saving...</> : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Set revision dialog */}
      <Dialog open={Boolean(setRevisionTarget)} onOpenChange={(open) => !open && setSetRevisionTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Upload set revision</DialogTitle>
            <DialogDescription>Upload a new PDF for this set revision.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <p className="font-medium">{setRevisionTarget?.title}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sheets-rev-label">Revision label</Label>
              <Input
                id="sheets-rev-label"
                value={setRevisionLabelValue}
                onChange={(event) => setSetRevisionLabel(event.target.value)}
                placeholder="Rev 2026-02-20"
                disabled={uploadingSetRevision}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sheets-rev-notes">Notes</Label>
              <Input
                id="sheets-rev-notes"
                value={setRevisionNotesValue}
                onChange={(event) => setSetRevisionNotes(event.target.value)}
                placeholder="Optional"
                disabled={uploadingSetRevision}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sheets-rev-file">PDF file</Label>
              <Input
                id="sheets-rev-file"
                type="file"
                accept=".pdf,application/pdf"
                disabled={uploadingSetRevision}
                onChange={(event) => setSetRevisionFile(event.target.files?.[0] ?? null)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSetRevisionTarget(null)} disabled={uploadingSetRevision}>Cancel</Button>
            <Button onClick={uploadSetRevision} disabled={uploadingSetRevision || !setRevisionFile}>
              {uploadingSetRevision ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Uploading...</> : "Upload revision"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit sheet dialog */}
      <Dialog open={Boolean(editingSheet)} onOpenChange={(open) => !open && setEditingSheet(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit sheet</DialogTitle>
            <DialogDescription>Update sheet metadata and discipline.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="sheets-sheet-number">Sheet number</Label>
              <Input id="sheets-sheet-number" value={sheetNumber} onChange={(e) => setSheetNumber(e.target.value)} disabled={savingSheet} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sheets-sheet-title">Sheet title</Label>
              <Input id="sheets-sheet-title" value={sheetTitle} onChange={(e) => setSheetTitle(e.target.value)} placeholder="Optional" disabled={savingSheet} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sheets-sheet-discipline">Discipline</Label>
              <select
                id="sheets-sheet-discipline"
                value={sheetDiscipline}
                onChange={(e) => setSheetDiscipline(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                disabled={savingSheet}
              >
                <option value="">None</option>
                {DISCIPLINE_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>{value} - {label}</option>
                ))}
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingSheet(null)} disabled={savingSheet}>Cancel</Button>
            <Button onClick={saveSheetEdit} disabled={savingSheet}>
              {savingSheet ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Saving...</> : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add sheet version dialog */}
      <Dialog open={Boolean(versionTarget)} onOpenChange={(open) => !open && setVersionTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add sheet version</DialogTitle>
            <DialogDescription>Upload a replacement file and create a new revision.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <p className="font-medium">{versionTarget?.sheet.sheet_number} {versionTarget?.sheet.sheet_title ?? ""}</p>
              <p className="text-xs text-muted-foreground">Current versions: {knownVersionCount}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sheets-ver-label">Revision label</Label>
              <Input id="sheets-ver-label" value={revisionLabel} onChange={(e) => setRevisionLabel(e.target.value)} disabled={savingVersion || loadingVersionMeta} placeholder="Rev 3" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sheets-ver-notes">Notes</Label>
              <Input id="sheets-ver-notes" value={revisionNotes} onChange={(e) => setRevisionNotes(e.target.value)} disabled={savingVersion || loadingVersionMeta} placeholder="Optional" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sheets-ver-file">Version file</Label>
              <Input id="sheets-ver-file" type="file" accept=".pdf,image/*" disabled={savingVersion || loadingVersionMeta} onChange={(e) => setVersionFile(e.target.files?.[0] ?? null)} />
            </div>
            {loadingVersionMeta && (
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading revision details...
              </div>
            )}
            {knownRevisions.length > 0 && (
              <p className="text-[11px] text-muted-foreground">
                Existing revisions: {knownRevisions.map((rev) => rev.revision_label).join(", ")}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVersionTarget(null)} disabled={savingVersion}>Cancel</Button>
            <Button onClick={submitSheetVersion} disabled={savingVersion || loadingVersionMeta || !versionFile}>
              {savingVersion ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Saving...</> : "Upload version"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete set confirmation */}
      <AlertDialog open={Boolean(deletingSet)} onOpenChange={(open) => !open && setDeletingSet(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete drawing set?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes &ldquo;{deletingSet?.title}&rdquo; and all linked sheets and versions.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingSetPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deletingSetPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={confirmDeleteSet}
            >
              {deletingSetPending ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Deleting...</> : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete sheet confirmation */}
      <AlertDialog open={Boolean(deletingSheet)} onOpenChange={(open) => !open && setDeletingSheet(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete sheet?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes sheet {deletingSheet?.sheet.sheet_number}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingSheetPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deletingSheetPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={confirmDeleteSheet}
            >
              {deletingSheetPending ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Deleting...</> : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

