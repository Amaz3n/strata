"use client"

import { memo, useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import {
  AlertCircle,
  Eye,
  FilePlus2,
  Layers,
  Loader2,
  MoreHorizontal,
  Pencil,
  RefreshCcw,
  Trash2,
  Upload,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
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
const COMPACT_SET_LIMIT = 6

function coerceSetType(value?: string | null): DrawingSetType {
  if (value && value in DRAWING_SET_TYPE_LABELS) return value as DrawingSetType
  return "general"
}

function statusBadgeVariant(set: DrawingSet): "destructive" | "secondary" | "outline" {
  if (set.status === "failed") return "destructive"
  if (set.status === "ready") return "secondary"
  return "outline"
}

function matchesSetQuery(set: DrawingSet, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return (
    set.title.toLowerCase().includes(q) ||
    (set.description ?? "").toLowerCase().includes(q) ||
    (set.set_type ?? "").toLowerCase().includes(q)
  )
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

export function DrawingSetsContent({
  onSheetClick,
  onUploadDrawingSetClick,
}: {
  onSheetClick?: (sheet: DrawingSheet) => void
  onUploadDrawingSetClick?: () => void
}) {
  return (
    <DrawingSetsWorkspace
      onSheetClick={onSheetClick}
      onUploadDrawingSetClick={onUploadDrawingSetClick}
    />
  )
}

export function DrawingSetsSection({
  onSheetClick,
}: {
  onSheetClick?: (sheet: DrawingSheet) => void
}) {
  const { drawingSets, searchQuery } = useDocuments()
  const filteredSets = useMemo(
    () => drawingSets.filter((set) => matchesSetQuery(set, searchQuery.trim())),
    [drawingSets, searchQuery]
  )

  if (filteredSets.length === 0) return null

  return (
    <div>
      <div className="flex items-center gap-2 py-2 text-sm font-medium text-muted-foreground">
        <Layers className="h-4 w-4 shrink-0" />
        Drawing Sets
        <span className="tabular-nums text-xs opacity-70">
          ({filteredSets.length})
        </span>
      </div>
      <DrawingSetsWorkspace onSheetClick={onSheetClick} compact />
    </div>
  )
}

function DrawingSetsWorkspace({
  onSheetClick,
  onUploadDrawingSetClick,
  compact = false,
}: {
  onSheetClick?: (sheet: DrawingSheet) => void
  onUploadDrawingSetClick?: () => void
  compact?: boolean
}) {
  const {
    drawingSets,
    searchQuery,
    projectId,
    setQuickFilter,
    selectedDrawingSetId,
    setSelectedDrawingSet,
    refreshDrawingSets,
    refreshFiles,
  } = useDocuments()

  const [sheetSearch, setSheetSearch] = useState("")
  const [sheetPageBySetId, setSheetPageBySetId] = useState<Record<string, number>>({})

  const [loadingSetIds, setLoadingSetIds] = useState<Set<string>>(new Set())
  const [sheetsBySetId, setSheetsBySetId] = useState<Record<string, DrawingSheet[]>>({})

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

  const [editingSheet, setEditingSheet] = useState<{ setId: string; sheet: DrawingSheet } | null>(null)
  const [sheetNumber, setSheetNumber] = useState("")
  const [sheetTitle, setSheetTitle] = useState("")
  const [sheetDiscipline, setSheetDiscipline] = useState("")
  const [savingSheet, setSavingSheet] = useState(false)

  const [deletingSheet, setDeletingSheet] = useState<{ setId: string; sheet: DrawingSheet } | null>(null)
  const [deletingSheetPending, setDeletingSheetPending] = useState(false)

  const [versionTarget, setVersionTarget] = useState<{ setId: string; sheet: DrawingSheet } | null>(null)
  const [versionFile, setVersionFile] = useState<File | null>(null)
  const [revisionLabel, setRevisionLabel] = useState("")
  const [revisionNotes, setRevisionNotes] = useState("")
  const [knownRevisions, setKnownRevisions] = useState<DrawingRevision[]>([])
  const [knownVersionCount, setKnownVersionCount] = useState<number>(0)
  const [loadingVersionMeta, setLoadingVersionMeta] = useState(false)
  const [savingVersion, setSavingVersion] = useState(false)

  const filteredSets = useMemo(
    () => drawingSets.filter((set) => matchesSetQuery(set, searchQuery.trim())),
    [drawingSets, searchQuery]
  )
  const selectedSet = useMemo(
    () => filteredSets.find((set) => set.id === selectedDrawingSetId) ?? filteredSets[0] ?? null,
    [filteredSets, selectedDrawingSetId]
  )

  useEffect(() => {
    if (filteredSets.length === 0) {
      setSelectedDrawingSet(null, null)
      return
    }
    if (!selectedDrawingSetId || !filteredSets.some((set) => set.id === selectedDrawingSetId)) {
      const firstSet = filteredSets[0]
      setSelectedDrawingSet(firstSet.id, firstSet.title)
    }
  }, [filteredSets, selectedDrawingSetId, setSelectedDrawingSet])

  useEffect(() => {
    if (!selectedSet) return
    setSelectedDrawingSet(selectedSet.id, selectedSet.title)
  }, [selectedSet, setSelectedDrawingSet])

  const loadSheetsForSet = useCallback(
    async (setId: string, force: boolean = false) => {
      if (!force && sheetsBySetId[setId]) return
      setLoadingSetIds((prev) => {
        if (prev.has(setId)) return prev
        const next = new Set(prev)
        next.add(setId)
        return next
      })

      try {
        const sheets = await listDrawingSheetsWithUrlsAction({
          project_id: projectId,
          drawing_set_id: setId,
          limit: 500,
        })
        setSheetsBySetId((prev) => ({ ...prev, [setId]: sheets }))
        setSheetPageBySetId((prev) => (prev[setId] ? prev : { ...prev, [setId]: 1 }))
      } catch (error) {
        console.error("Failed to load sheets:", error)
        toast.error("Failed to load sheets")
      } finally {
        setLoadingSetIds((prev) => {
          if (!prev.has(setId)) return prev
          const next = new Set(prev)
          next.delete(setId)
          return next
        })
      }
    },
    [projectId, sheetsBySetId]
  )

  useEffect(() => {
    if (!selectedSet) return
    void loadSheetsForSet(selectedSet.id)
  }, [selectedSet, loadSheetsForSet])

  const selectedSetSheets = useMemo(() => {
    if (!selectedSet) return []
    return sheetsBySetId[selectedSet.id] ?? []
  }, [selectedSet, sheetsBySetId])
  const filteredSelectedSheets = useMemo(
    () => selectedSetSheets.filter((sheet) => matchesSheetQuery(sheet, sheetSearch.trim())),
    [selectedSetSheets, sheetSearch]
  )

  const currentSheetPage = selectedSet ? sheetPageBySetId[selectedSet.id] ?? 1 : 1
  const totalSheetPages = Math.max(
    1,
    Math.ceil(filteredSelectedSheets.length / SHEETS_PAGE_SIZE)
  )
  const clampedCurrentPage = Math.min(currentSheetPage, totalSheetPages)
  const paginatedSheets = useMemo(() => {
    const start = (clampedCurrentPage - 1) * SHEETS_PAGE_SIZE
    return filteredSelectedSheets.slice(start, start + SHEETS_PAGE_SIZE)
  }, [clampedCurrentPage, filteredSelectedSheets])

  useEffect(() => {
    if (!selectedSet) return
    if (currentSheetPage <= totalSheetPages) return
    setSheetPageBySetId((prev) => ({ ...prev, [selectedSet.id]: totalSheetPages }))
  }, [currentSheetPage, selectedSet, totalSheetPages])

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
        toast.success("Set processing retried")
      } catch (error) {
        console.error("Failed to retry processing:", error)
        toast.error("Failed to retry processing")
      } finally {
        setRetryingSetId(null)
      }
    },
    [refreshDrawingSets]
  )

  const confirmDeleteSet = useCallback(async () => {
    if (!deletingSet) return

    setDeletingSetPending(true)
    try {
      await deleteDrawingSetAction(deletingSet.id)
      setSheetsBySetId((prev) => {
        const next = { ...prev }
        delete next[deletingSet.id]
        return next
      })
      setSheetPageBySetId((prev) => {
        const next = { ...prev }
        delete next[deletingSet.id]
        return next
      })
      await Promise.all([refreshDrawingSets(), refreshFiles()])
      toast.success("Drawing set deleted")
      setDeletingSet(null)
    } catch (error) {
      console.error("Failed to delete drawing set:", error)
      toast.error("Failed to delete drawing set")
    } finally {
      setDeletingSetPending(false)
    }
  }, [deletingSet, refreshDrawingSets, refreshFiles])

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
      if (revisionNote) {
        await updateDrawingSetAction(newSet.id, {
          description: `Revision of ${setRevisionTarget.title}: ${revisionNote}`,
        })
      } else {
        await updateDrawingSetAction(newSet.id, {
          description: `Revision of ${setRevisionTarget.title}`,
        })
      }

      await Promise.all([refreshDrawingSets(), refreshFiles()])
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

  const openSheetEdit = useCallback((setId: string, sheet: DrawingSheet) => {
    setEditingSheet({ setId, sheet })
    setSheetNumber(sheet.sheet_number)
    setSheetTitle(sheet.sheet_title ?? "")
    setSheetDiscipline(sheet.discipline ?? "")
  }, [])

  const saveSheetEdit = useCallback(async () => {
    if (!editingSheet) return
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
      await Promise.all([
        loadSheetsForSet(editingSheet.setId, true),
        refreshDrawingSets(),
      ])
      toast.success("Sheet updated")
      setEditingSheet(null)
    } catch (error) {
      console.error("Failed to update sheet:", error)
      toast.error("Failed to update sheet")
    } finally {
      setSavingSheet(false)
    }
  }, [
    editingSheet,
    loadSheetsForSet,
    refreshDrawingSets,
    sheetDiscipline,
    sheetNumber,
    sheetTitle,
  ])

  const confirmDeleteSheet = useCallback(async () => {
    if (!deletingSheet) return
    setDeletingSheetPending(true)
    try {
      await deleteDrawingSheetAction(deletingSheet.sheet.id)
      await Promise.all([
        loadSheetsForSet(deletingSheet.setId, true),
        refreshDrawingSets(),
      ])
      toast.success("Sheet deleted")
      setDeletingSheet(null)
    } catch (error) {
      console.error("Failed to delete sheet:", error)
      toast.error("Failed to delete sheet")
    } finally {
      setDeletingSheetPending(false)
    }
  }, [deletingSheet, loadSheetsForSet, refreshDrawingSets])

  const openVersionDialog = useCallback(
    async (setId: string, sheet: DrawingSheet) => {
      setVersionTarget({ setId, sheet })
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
            drawing_set_id: setId,
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
    [projectId, setRevisionLabel, setRevisionNotes]
  )

  const submitSheetVersion = useCallback(async () => {
    if (!versionTarget) return
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
      formData.append("folderPath", `/drawings/versions/${versionTarget.setId}`)
      formData.append("description", `Drawing version for ${versionTarget.sheet.sheet_number}`)

      const uploaded = await uploadFileAction(formData)
      const revision = await createDrawingRevisionAction({
        project_id: projectId,
        drawing_set_id: versionTarget.setId,
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
        loadSheetsForSet(versionTarget.setId, true),
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
    loadSheetsForSet,
    projectId,
    refreshDrawingSets,
    refreshFiles,
    revisionLabel,
    revisionNotes,
    versionFile,
    versionTarget,
  ])

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
            : "Upload drawing set PDFs to split sheets and manage versions."}
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

  if (compact) {
    const compactSets = filteredSets.slice(0, COMPACT_SET_LIMIT)
    const hasMore = filteredSets.length > compactSets.length

    return (
      <div className="mb-4 rounded-lg border bg-card p-3 space-y-2">
        {compactSets.map((set) => (
          <button
            key={set.id}
            className="w-full rounded-md border bg-background px-3 py-2 text-left hover:border-primary/40 transition-colors"
            onClick={() => {
              setQuickFilter("drawings")
              setSelectedDrawingSet(set.id, set.title)
            }}
          >
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium truncate">{set.title}</p>
              <Badge variant={statusBadgeVariant(set)} className="text-[10px]">
                {set.status}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {set.sheet_count ?? 0} {(set.sheet_count ?? 0) === 1 ? "sheet" : "sheets"}
            </p>
          </button>
        ))}

        {hasMore && (
          <p className="text-xs text-muted-foreground px-1">
            +{filteredSets.length - compactSets.length} more sets
          </p>
        )}

        <div className="flex flex-wrap gap-2 pt-1">
          <Button size="sm" variant="outline" onClick={() => setQuickFilter("drawings")}>
            Manage drawings
          </Button>
          {onUploadDrawingSetClick && (
            <Button size="sm" onClick={onUploadDrawingSetClick}>
              <Upload className="h-4 w-4 mr-2" />
              Upload set
            </Button>
          )}
        </div>
      </div>
    )
  }

  const isSelectedSetLoading = selectedSet ? loadingSetIds.has(selectedSet.id) : false

  return (
    <>
      <div className="py-3">
        <div className="grid gap-3 xl:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="rounded-lg border bg-card p-2 xl:max-h-[72vh] xl:overflow-y-auto">
            <div className="flex items-center justify-between px-2 py-1.5">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Plan Sets
              </p>
              <span className="text-xs text-muted-foreground tabular-nums">
                {filteredSets.length}
              </span>
            </div>
            <div className="space-y-1">
              {filteredSets.map((set) => (
                <SetListItem
                  key={set.id}
                  set={set}
                  selected={selectedSet?.id === set.id}
                  onSelect={() => {
                    setSelectedDrawingSet(set.id, set.title)
                    setSheetPageBySetId((prev) => ({ ...prev, [set.id]: 1 }))
                    void loadSheetsForSet(set.id)
                  }}
                />
              ))}
            </div>
          </aside>

          <section className="rounded-lg border bg-card min-h-[560px] flex flex-col">
            {!selectedSet && (
              <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
                Select a set to view sheets
              </div>
            )}

            {selectedSet && (
              <>
                <div className="border-b px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-semibold text-base truncate">{selectedSet.title}</h3>
                        <Badge variant={statusBadgeVariant(selectedSet)} className="text-[10px]">
                          {selectedSet.status}
                        </Badge>
                        <Badge variant="outline" className="text-[10px]">
                          {selectedSet.sheet_count ?? 0} sheets
                        </Badge>
                      </div>
                      {selectedSet.description && (
                        <p className="mt-1 text-sm text-muted-foreground line-clamp-2">
                          {selectedSet.description}
                        </p>
                      )}
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
                              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                              Retrying
                            </>
                          ) : (
                            <>
                              <RefreshCcw className="h-3.5 w-3.5 mr-1.5" />
                              Retry
                            </>
                          )}
                        </Button>
                      )}

                      {onUploadDrawingSetClick && (
                        <Button size="sm" className="h-8" onClick={onUploadDrawingSetClick}>
                          <Upload className="h-3.5 w-3.5 mr-1.5" />
                          New set
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
                            <Pencil className="h-4 w-4 mr-2" />
                            Edit set metadata
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => openSetRevisionDialog(selectedSet)}>
                            <FilePlus2 className="h-4 w-4 mr-2" />
                            Upload set revision
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() => setDeletingSet(selectedSet)}
                          >
                            <Trash2 className="h-4 w-4 mr-2" />
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
                    <div className="mt-2 text-xs text-destructive flex items-center gap-1.5">
                      <AlertCircle className="h-3.5 w-3.5" />
                      <span>{selectedSet.error_message}</span>
                    </div>
                  )}
                </div>

                {selectedSet.status !== "ready" && (
                  <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
                    Sheets will appear when processing is complete.
                  </div>
                )}

                {selectedSet.status === "ready" && (
                  <>
                    <div className="border-b px-4 py-2 flex flex-wrap items-center gap-2">
                      <Input
                        className="h-8 w-full sm:w-64"
                        placeholder="Search sheets in this set..."
                        value={sheetSearch}
                        onChange={(event) => {
                          setSheetSearch(event.target.value)
                          if (selectedSet) {
                            setSheetPageBySetId((prev) => ({ ...prev, [selectedSet.id]: 1 }))
                          }
                        }}
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8"
                        onClick={() => void loadSheetsForSet(selectedSet.id, true)}
                      >
                        <RefreshCcw className="h-3.5 w-3.5 mr-1.5" />
                        Refresh
                      </Button>
                    </div>

                    {isSelectedSetLoading && (
                      <div className="flex-1 p-3 space-y-2">
                        {Array.from({ length: 6 }).map((_, idx) => (
                          <div
                            key={`${selectedSet.id}-sheet-loading-${idx}`}
                            className="h-[60px] rounded-md border bg-muted/20 animate-pulse"
                          />
                        ))}
                      </div>
                    )}

                    {!isSelectedSetLoading && filteredSelectedSheets.length === 0 && (
                      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
                        No sheets match your search.
                      </div>
                    )}

                    {!isSelectedSetLoading && filteredSelectedSheets.length > 0 && (
                      <>
                        <div className="flex-1 overflow-y-auto p-3 space-y-2">
                          {paginatedSheets.map((sheet) => (
                            <SheetRow
                              key={sheet.id}
                              sheet={sheet}
                              onOpen={onSheetClick}
                              onEdit={() => openSheetEdit(selectedSet.id, sheet)}
                              onDelete={() => setDeletingSheet({ setId: selectedSet.id, sheet })}
                              onAddVersion={() => {
                                void openVersionDialog(selectedSet.id, sheet)
                              }}
                            />
                          ))}
                        </div>

                        <div className="border-t px-4 py-2 flex items-center justify-between">
                          <p className="text-xs text-muted-foreground">
                            Showing {(clampedCurrentPage - 1) * SHEETS_PAGE_SIZE + 1}
                            -
                            {Math.min(
                              clampedCurrentPage * SHEETS_PAGE_SIZE,
                              filteredSelectedSheets.length
                            )}{" "}
                            of {filteredSelectedSheets.length}
                          </p>
                          <div className="flex items-center gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7"
                              disabled={clampedCurrentPage <= 1}
                              onClick={() =>
                                setSheetPageBySetId((prev) => ({
                                  ...prev,
                                  [selectedSet.id]: Math.max(1, clampedCurrentPage - 1),
                                }))
                              }
                            >
                              Prev
                            </Button>
                            <span className="text-xs text-muted-foreground tabular-nums">
                              {clampedCurrentPage}/{totalSheetPages}
                            </span>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7"
                              disabled={clampedCurrentPage >= totalSheetPages}
                              onClick={() =>
                                setSheetPageBySetId((prev) => ({
                                  ...prev,
                                  [selectedSet.id]: Math.min(totalSheetPages, clampedCurrentPage + 1),
                                }))
                              }
                            >
                              Next
                            </Button>
                          </div>
                        </div>
                      </>
                    )}
                  </>
                )}
              </>
            )}
          </section>
        </div>
      </div>

      <Dialog open={Boolean(editingSet)} onOpenChange={(open) => !open && setEditingSet(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit drawing set</DialogTitle>
            <DialogDescription>
              Update metadata for this set.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="set-title">Title</Label>
              <Input
                id="set-title"
                value={setTitle}
                onChange={(event) => setSetTitle(event.target.value)}
                disabled={savingSet}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="set-description">Description</Label>
              <Input
                id="set-description"
                value={setDescription}
                onChange={(event) => setSetDescription(event.target.value)}
                placeholder="Optional"
                disabled={savingSet}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="set-type">Type</Label>
              <select
                id="set-type"
                value={setType}
                onChange={(event) => setSetType(coerceSetType(event.target.value))}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                disabled={savingSet}
              >
                {DRAWING_SET_TYPES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingSet(null)} disabled={savingSet}>
              Cancel
            </Button>
            <Button onClick={saveSetEdit} disabled={savingSet}>
              {savingSet ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(setRevisionTarget)}
        onOpenChange={(open) => !open && setSetRevisionTarget(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Upload set revision</DialogTitle>
            <DialogDescription>
              Upload a new PDF for this set revision. This creates a new set entry linked by title.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <p className="font-medium">{setRevisionTarget?.title}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="set-revision-label">Revision label</Label>
              <Input
                id="set-revision-label"
                value={setRevisionLabelValue}
                onChange={(event) => setSetRevisionLabel(event.target.value)}
                placeholder="Rev 2026-02-20"
                disabled={uploadingSetRevision}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="set-revision-notes">Notes</Label>
              <Input
                id="set-revision-notes"
                value={setRevisionNotesValue}
                onChange={(event) => setSetRevisionNotes(event.target.value)}
                placeholder="Optional"
                disabled={uploadingSetRevision}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="set-revision-file">PDF file</Label>
              <Input
                id="set-revision-file"
                type="file"
                accept=".pdf,application/pdf"
                disabled={uploadingSetRevision}
                onChange={(event) => setSetRevisionFile(event.target.files?.[0] ?? null)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSetRevisionTarget(null)}
              disabled={uploadingSetRevision}
            >
              Cancel
            </Button>
            <Button
              onClick={uploadSetRevision}
              disabled={uploadingSetRevision || !setRevisionFile}
            >
              {uploadingSetRevision ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Uploading...
                </>
              ) : (
                "Upload revision"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(editingSheet)} onOpenChange={(open) => !open && setEditingSheet(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit sheet</DialogTitle>
            <DialogDescription>
              Update sheet metadata and discipline.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="sheet-number">Sheet number</Label>
              <Input
                id="sheet-number"
                value={sheetNumber}
                onChange={(event) => setSheetNumber(event.target.value)}
                disabled={savingSheet}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sheet-title">Sheet title</Label>
              <Input
                id="sheet-title"
                value={sheetTitle}
                onChange={(event) => setSheetTitle(event.target.value)}
                placeholder="Optional"
                disabled={savingSheet}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sheet-discipline">Discipline</Label>
              <select
                id="sheet-discipline"
                value={sheetDiscipline}
                onChange={(event) => setSheetDiscipline(event.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                disabled={savingSheet}
              >
                <option value="">None</option>
                {DISCIPLINE_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {value} - {label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingSheet(null)} disabled={savingSheet}>
              Cancel
            </Button>
            <Button onClick={saveSheetEdit} disabled={savingSheet}>
              {savingSheet ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(versionTarget)} onOpenChange={(open) => !open && setVersionTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add sheet version</DialogTitle>
            <DialogDescription>
              Upload a replacement file and create a new revision for this sheet.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <p className="font-medium">
                {versionTarget?.sheet.sheet_number} {versionTarget?.sheet.sheet_title ?? ""}
              </p>
              <p className="text-xs text-muted-foreground">
                Current versions: {knownVersionCount}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="revision-label">Revision label</Label>
              <Input
                id="revision-label"
                value={revisionLabel}
                onChange={(event) => setRevisionLabel(event.target.value)}
                disabled={savingVersion || loadingVersionMeta}
                placeholder="Rev 3"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="revision-notes">Notes</Label>
              <Input
                id="revision-notes"
                value={revisionNotes}
                onChange={(event) => setRevisionNotes(event.target.value)}
                disabled={savingVersion || loadingVersionMeta}
                placeholder="Optional"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="version-file">Version file</Label>
              <Input
                id="version-file"
                type="file"
                accept=".pdf,image/*"
                disabled={savingVersion || loadingVersionMeta}
                onChange={(event) => setVersionFile(event.target.files?.[0] ?? null)}
              />
              <p className="text-[11px] text-muted-foreground">
                Stored under `/drawings/versions/{versionTarget?.setId}`.
              </p>
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
            <Button variant="outline" onClick={() => setVersionTarget(null)} disabled={savingVersion}>
              Cancel
            </Button>
            <Button onClick={submitSheetVersion} disabled={savingVersion || loadingVersionMeta || !versionFile}>
              {savingVersion ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                "Upload version"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(deletingSet)} onOpenChange={(open) => !open && setDeletingSet(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete drawing set?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes "{deletingSet?.title}" and all linked sheets and versions.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingSetPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deletingSetPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={confirmDeleteSet}
            >
              {deletingSetPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                "Delete"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
              {deletingSheetPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                "Delete"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

const SetListItem = memo(function SetListItem({
  set,
  selected,
  onSelect,
}: {
  set: DrawingSet
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full rounded-md border px-3 py-2 text-left transition-colors",
        selected
          ? "border-primary bg-primary/5"
          : "bg-background hover:border-primary/40"
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium truncate">{set.title}</p>
        <Badge variant={statusBadgeVariant(set)} className="text-[10px]">
          {set.status}
        </Badge>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {set.sheet_count ?? 0} {(set.sheet_count ?? 0) === 1 ? "sheet" : "sheets"}
        {set.set_type && (
          <>
            {" "}
            ·{" "}
            {DRAWING_SET_TYPE_LABELS[coerceSetType(set.set_type)]}
          </>
        )}
      </p>
    </button>
  )
})

const SheetRow = memo(function SheetRow({
  sheet,
  onOpen,
  onEdit,
  onDelete,
  onAddVersion,
}: {
  sheet: DrawingSheet
  onOpen?: (sheet: DrawingSheet) => void
  onEdit: () => void
  onDelete: () => void
  onAddVersion: () => void
}) {
  const thumbnail = sheet.image_thumbnail_url ?? null

  return (
    <div className="rounded-md border bg-background p-2">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => onOpen?.(sheet)}
          disabled={!onOpen}
          className={cn("flex min-w-0 flex-1 items-center gap-3 text-left", !onOpen && "cursor-default")}
        >
          <div className="h-12 w-16 shrink-0 rounded border bg-muted/40 overflow-hidden flex items-center justify-center">
            {thumbnail ? (
              <img
                src={thumbnail}
                alt={sheet.sheet_number}
                className="h-full w-full object-cover"
                loading="lazy"
              />
            ) : (
              <div className="text-[10px] text-muted-foreground px-1 text-center">
                No thumbnail
              </div>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-sm">{sheet.sheet_number}</span>
              {sheet.discipline && (
                <Badge variant="secondary" className="text-[10px] h-5 px-1.5">
                  {sheet.discipline}
                </Badge>
              )}
              {sheet.current_revision_label && (
                <Badge variant="outline" className="text-[10px] h-5 px-1.5">
                  {sheet.current_revision_label}
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground truncate">
              {sheet.sheet_title || "Untitled sheet"}
            </p>
          </div>
        </button>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-8"
            onClick={() => onOpen?.(sheet)}
            disabled={!onOpen}
          >
            <Eye className="h-3.5 w-3.5 mr-1.5" />
            Open
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={onEdit}>
                <Pencil className="h-4 w-4 mr-2" />
                Edit sheet
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onAddVersion}>
                <FilePlus2 className="h-4 w-4 mr-2" />
                Add version
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive" onClick={onDelete}>
                <Trash2 className="h-4 w-4 mr-2" />
                Delete sheet
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  )
})
