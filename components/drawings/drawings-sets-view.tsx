"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  FileText,
  MoreHorizontal,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Textarea } from "@/components/ui/textarea"
import { ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"
import { DRAWING_SET_TYPE_LABELS } from "@/lib/validation/drawings"
import { uploadDrawingFileToStorage } from "@/lib/services/drawings-client"
import {
  createDrawingRevisionAction,
  createDrawingSetFromUpload,
  deleteDrawingSetAction,
  getProcessingStatusAction,
  listDrawingSetsAction,
  retryProcessingAction,
} from "@/app/(app)/drawings/actions"
import type { DrawingSet } from "@/app/(app)/drawings/actions"

type ProjectOption = { id: string; name: string }

interface DrawingsSetsViewProps {
  initialSets: DrawingSet[]
  projects: ProjectOption[]
  selectedProjectId?: string
  lockProject?: boolean
}

const SET_TYPE_OPTIONS = Object.entries(DRAWING_SET_TYPE_LABELS).map(
  ([value, label]) => ({ value, label }),
)

function formatDate(value?: string | null) {
  if (!value) return "—"
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value))
}

function resolveSetTypeLabel(value?: string | null) {
  if (!value) return "General"
  return (
    DRAWING_SET_TYPE_LABELS[value as keyof typeof DRAWING_SET_TYPE_LABELS] ??
    value
  )
}

function statusBadgeClass(status?: string | null) {
  switch (status) {
    case "ready":
      return "bg-success/10 text-success border-success/30"
    case "processing":
      return "bg-chart-1/10 text-chart-1 border-chart-1/30"
    case "failed":
      return "bg-destructive/10 text-destructive border-destructive/30"
    default:
      return "bg-muted text-muted-foreground border-muted"
  }
}

function statusLabel(status?: string | null) {
  switch (status) {
    case "ready":
      return "Ready"
    case "processing":
      return "Processing"
    case "failed":
      return "Failed"
    default:
      return "Pending"
  }
}

export function DrawingsSetsView({
  initialSets,
  projects,
  selectedProjectId,
  lockProject = false,
}: DrawingsSetsViewProps) {
  const router = useRouter()
  const [sets, setSets] = useState<DrawingSet[]>(initialSets)
  const [search, setSearch] = useState("")
  const [isDragActive, setIsDragActive] = useState(false)
  const dragCounterRef = useRef(0)

  const [uploadDialogOpen, setUploadDialogOpen] = useState(false)
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploadTitle, setUploadTitle] = useState("")
  const [uploadSetType, setUploadSetType] = useState<string>("general")
  const [uploadRevisionLabel, setUploadRevisionLabel] = useState("")
  const [uploadIssuedDate, setUploadIssuedDate] = useState("")
  const [uploadSource, setUploadSource] = useState("")
  const [uploadNotes, setUploadNotes] = useState("")
  const [revisionOpen, setRevisionOpen] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [uploadStage, setUploadStage] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [setToDelete, setSetToDelete] = useState<DrawingSet | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  useEffect(() => {
    setSets(initialSets)
  }, [initialSets])

  const filteredSets = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return sets
    return sets.filter((s) => {
      const haystack = [s.title, s.description, s.set_type]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
      return haystack.includes(q)
    })
  }, [sets, search])

  const processingIds = useMemo(
    () => sets.filter((s) => s.status === "processing").map((s) => s.id),
    [sets],
  )

  const refreshSets = useCallback(async () => {
    if (!selectedProjectId) return
    try {
      const data = await listDrawingSetsAction({
        project_id: selectedProjectId,
        limit: 100,
      })
      setSets(data)
    } catch (err) {
      console.error("Failed to refresh drawing sets:", err)
    }
  }, [selectedProjectId])

  useEffect(() => {
    if (processingIds.length === 0) return
    const interval = setInterval(async () => {
      try {
        const updates = await Promise.all(
          processingIds.map((id) =>
            getProcessingStatusAction(id).then((status) => ({ id, status })),
          ),
        )
        setSets((prev) =>
          prev.map((s) => {
            const match = updates.find((u) => u.id === s.id)
            if (!match) return s
            return {
              ...s,
              status: match.status.status as DrawingSet["status"],
              processed_pages: match.status.processed_pages,
              total_pages: match.status.total_pages,
              error_message: match.status.error_message,
            }
          }),
        )
        if (updates.some((u) => u.status.status === "ready")) {
          await refreshSets()
        }
      } catch (err) {
        console.error("Failed to poll status:", err)
      }
    }, 3000)
    return () => clearInterval(interval)
  }, [processingIds, refreshSets])

  const handleProjectChange = (projectId: string) => {
    if (lockProject) return
    const next = projectId === "all" ? undefined : projectId
    router.push(next ? `/drawings?project=${next}` : "/drawings")
  }

  const openFilePicker = () => {
    if (!selectedProjectId) {
      toast.error("Select a project to upload")
      return
    }
    fileInputRef.current?.click()
  }

  const acceptFile = (file: File) => {
    if (!selectedProjectId) {
      toast.error("Select a project to upload")
      return
    }
    if (file.type !== "application/pdf") {
      toast.error("Only PDF files are supported")
      return
    }
    setUploadFile(file)
    setUploadTitle(file.name.replace(/\.pdf$/i, ""))
    setUploadSetType("general")
    setUploadRevisionLabel("")
    setUploadIssuedDate("")
    setUploadSource("")
    setUploadNotes("")
    setRevisionOpen(false)
    setUploadDialogOpen(true)
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    acceptFile(file)
    e.target.value = ""
  }

  const handleUpload = async () => {
    if (!uploadFile || !selectedProjectId) return
    setIsUploading(true)
    setUploadStage("Uploading PDF…")
    try {
      const orgId = document.cookie.match(/(?:^|; )org_id=([^;]+)/)?.[1]
      if (!orgId) throw new Error("Organization not found. Please refresh.")

      const { storagePath } = await uploadDrawingFileToStorage(
        uploadFile,
        selectedProjectId,
        orgId,
      )

      setUploadStage("Processing PDF…")
      const newSet = await createDrawingSetFromUpload({
        projectId: selectedProjectId,
        title: uploadTitle,
        setType: uploadSetType,
        fileName: uploadFile.name,
        storagePath,
        fileSize: uploadFile.size,
        mimeType: uploadFile.type,
      })

      setSets((prev) => [newSet, ...prev])

      const revisionLabel = uploadRevisionLabel.trim()
      if (revisionLabel) {
        try {
          const noteParts: string[] = []
          const src = uploadSource.trim()
          const note = uploadNotes.trim()
          if (src) noteParts.push(`From: ${src}`)
          if (note) noteParts.push(note)
          await createDrawingRevisionAction({
            project_id: selectedProjectId,
            drawing_set_id: newSet.id,
            revision_label: revisionLabel,
            issued_date: uploadIssuedDate || undefined,
            notes: noteParts.join("\n\n") || undefined,
          })
        } catch (err) {
          console.error("Failed to create initial revision:", err)
          toast.warning("Plan set uploaded, but revision details failed to save.")
        }
      }

      toast.success("Plan set uploaded — sheets processing in the background.")
      setUploadDialogOpen(false)
      setUploadFile(null)
      setUploadTitle("")
      setUploadSetType("general")
      setUploadRevisionLabel("")
      setUploadIssuedDate("")
      setUploadSource("")
      setUploadNotes("")
      setRevisionOpen(false)
    } catch (err) {
      console.error("Upload failed:", err)
      toast.error(
        err instanceof Error ? err.message : "Failed to upload plan set",
      )
    } finally {
      setIsUploading(false)
      setUploadStage(null)
    }
  }

  const handleDelete = async () => {
    if (!setToDelete) return
    setIsDeleting(true)
    try {
      await deleteDrawingSetAction(setToDelete.id)
      setSets((prev) => prev.filter((s) => s.id !== setToDelete.id))
      toast.success("Plan set deleted")
    } catch (err) {
      console.error(err)
      toast.error("Failed to delete plan set")
    } finally {
      setIsDeleting(false)
      setSetToDelete(null)
    }
  }

  const handleRetry = async (setId: string) => {
    try {
      await retryProcessingAction(setId)
      toast.success("Processing restarted")
      await refreshSets()
    } catch {
      toast.error("Failed to restart processing")
    }
  }

  const isPdfDrag = (event: React.DragEvent) =>
    Array.from(event.dataTransfer.items).some(
      (item) => item.kind === "file" && item.type === "application/pdf",
    )

  const selectedProjectName =
    projects.find((p) => p.id === selectedProjectId)?.name ?? null

  return (
    <div
      className="relative flex h-full flex-col"
      onDragEnter={(e) => {
        e.preventDefault()
        e.stopPropagation()
        if (!isPdfDrag(e)) return
        dragCounterRef.current += 1
        setIsDragActive(true)
      }}
      onDragOver={(e) => {
        e.preventDefault()
        e.stopPropagation()
        if (!isPdfDrag(e)) return
        setIsDragActive(true)
      }}
      onDragLeave={(e) => {
        e.preventDefault()
        e.stopPropagation()
        dragCounterRef.current -= 1
        if (dragCounterRef.current <= 0) {
          dragCounterRef.current = 0
          setIsDragActive(false)
        }
      }}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        dragCounterRef.current = 0
        setIsDragActive(false)
        const file = e.dataTransfer.files?.[0]
        if (file) acceptFile(file)
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf"
        className="hidden"
        onChange={handleFileSelect}
      />

      <div className="flex flex-col gap-3 border-b px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-0.5 min-w-0">
          <h1 className="text-xl font-semibold leading-tight">Plan Sets</h1>
          <p className="text-sm text-muted-foreground">
            {selectedProjectName
              ? `Drawings for ${selectedProjectName}`
              : "Select a project to view its drawing sets"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!lockProject && (
            <Select
              value={selectedProjectId ?? "all"}
              onValueChange={handleProjectChange}
            >
              <SelectTrigger className="h-9 w-[200px]">
                <SelectValue placeholder="Select project" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All projects</SelectItem>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button
            onClick={openFilePicker}
            disabled={!selectedProjectId}
            size="sm"
            className="h-9"
          >
            <Upload className="mr-2 h-4 w-4" />
            Upload
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 border-b px-4 py-2">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search plan sets…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 pl-9"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="ml-auto text-xs text-muted-foreground tabular-nums">
          {filteredSets.length} {filteredSets.length === 1 ? "set" : "sets"}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {!selectedProjectId ? (
          <EmptyState
            icon={FileText}
            title="Select a project"
            description="Choose a project to view its plan sets."
          />
        ) : sets.length === 0 ? (
          <EmptyState
            icon={Upload}
            title="No plan sets yet"
            description="Upload a PDF plan set to get started. It will be split into sheets automatically."
            action={
              <Button onClick={openFilePicker} size="sm">
                <Upload className="mr-2 h-4 w-4" />
                Upload plan set
              </Button>
            }
          />
        ) : filteredSets.length === 0 ? (
          <EmptyState
            icon={Search}
            title="No results"
            description="No plan sets match your search."
          />
        ) : (
          <div className="overflow-hidden rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="px-4">Title</TableHead>
                  <TableHead className="px-4">Type</TableHead>
                  <TableHead className="px-4 text-right">Sheets</TableHead>
                  <TableHead className="px-4">Status</TableHead>
                  <TableHead className="px-4">Updated</TableHead>
                  <TableHead className="w-12 px-4" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredSets.map((set) => {
                  const progress =
                    set.total_pages && set.total_pages > 0
                      ? (set.processed_pages / set.total_pages) * 100
                      : 0
                  const href = `/projects/${set.project_id}/drawings/sets/${set.id}`
                  const canOpen = set.status === "ready"

                  return (
                    <TableRow
                      key={set.id}
                      className={cn(
                        "group",
                        canOpen && "cursor-pointer hover:bg-muted/40",
                      )}
                      onClick={() => {
                        if (canOpen) router.push(href)
                      }}
                    >
                      <TableCell className="px-4 py-3">
                        <div className="font-medium">{set.title}</div>
                        {set.description ? (
                          <div className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                            {set.description}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="px-4 py-3 text-sm text-muted-foreground">
                        {resolveSetTypeLabel(set.set_type ?? null)}
                      </TableCell>
                      <TableCell className="px-4 py-3 text-right text-sm tabular-nums">
                        {set.sheet_count ?? 0}
                      </TableCell>
                      <TableCell className="px-4 py-3">
                        <div className="flex flex-col gap-1.5">
                          <Badge
                            variant="secondary"
                            className={cn(
                              "w-fit border text-xs",
                              statusBadgeClass(set.status),
                            )}
                          >
                            {statusLabel(set.status)}
                          </Badge>
                          {set.status === "processing" && (
                            <div className="flex items-center gap-2">
                              <Progress
                                value={progress}
                                className="h-1 w-24"
                              />
                              <span className="text-xs text-muted-foreground tabular-nums">
                                {set.processed_pages}/{set.total_pages ?? "?"}
                              </span>
                            </div>
                          )}
                          {set.status === "failed" && set.error_message && (
                            <span className="line-clamp-1 text-xs text-destructive">
                              {set.error_message}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="px-4 py-3 text-sm text-muted-foreground">
                        {formatDate(set.updated_at)}
                      </TableCell>
                      <TableCell
                        className="px-4 py-3"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                            >
                              <MoreHorizontal className="h-4 w-4" />
                              <span className="sr-only">Actions</span>
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {set.status === "failed" && (
                              <DropdownMenuItem
                                onClick={() => handleRetry(set.id)}
                              >
                                <RefreshCw className="mr-2 h-4 w-4" />
                                Retry processing
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onClick={() => setSetToDelete(set)}
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <Dialog open={uploadDialogOpen} onOpenChange={setUploadDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Upload plan set</DialogTitle>
            <DialogDescription>
              Upload a PDF. It will be split into individual sheets
              automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="upload-title">Title</Label>
              <Input
                id="upload-title"
                value={uploadTitle}
                onChange={(e) => setUploadTitle(e.target.value)}
                placeholder="Plan set title"
                disabled={isUploading}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="upload-type">Type</Label>
              <Select
                value={uploadSetType}
                onValueChange={setUploadSetType}
                disabled={isUploading}
              >
                <SelectTrigger id="upload-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SET_TYPE_OPTIONS.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Collapsible open={revisionOpen} onOpenChange={setRevisionOpen}>
              <CollapsibleTrigger className="flex w-full items-center justify-between py-1 text-sm font-medium text-muted-foreground hover:text-foreground">
                <span>Revision details (optional)</span>
                <ChevronDown
                  className={cn(
                    "h-4 w-4 transition-transform",
                    revisionOpen && "rotate-180",
                  )}
                />
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-3 pt-2">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="upload-rev">Revision</Label>
                    <Input
                      id="upload-rev"
                      value={uploadRevisionLabel}
                      onChange={(e) => setUploadRevisionLabel(e.target.value)}
                      placeholder="Permit Set, Rev 1, IFC…"
                      disabled={isUploading}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="upload-date">Issue date</Label>
                    <Input
                      id="upload-date"
                      type="date"
                      value={uploadIssuedDate}
                      onChange={(e) => setUploadIssuedDate(e.target.value)}
                      disabled={isUploading}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="upload-source">From</Label>
                  <Input
                    id="upload-source"
                    value={uploadSource}
                    onChange={(e) => setUploadSource(e.target.value)}
                    placeholder="Architect / engineer firm"
                    disabled={isUploading}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="upload-notes">Notes</Label>
                  <Textarea
                    id="upload-notes"
                    value={uploadNotes}
                    onChange={(e) => setUploadNotes(e.target.value)}
                    placeholder="Context for this revision…"
                    rows={2}
                    disabled={isUploading}
                  />
                </div>
              </CollapsibleContent>
            </Collapsible>

            {uploadFile && (
              <div className="flex items-center gap-3 border p-3">
                <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {uploadFile.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {(uploadFile.size / 1024 / 1024).toFixed(2)} MB
                  </p>
                </div>
              </div>
            )}
            {uploadStage && (
              <p className="text-xs text-muted-foreground">{uploadStage}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setUploadDialogOpen(false)}
              disabled={isUploading}
            >
              Cancel
            </Button>
            <Button
              onClick={handleUpload}
              disabled={isUploading || !uploadTitle.trim()}
            >
              {isUploading ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Uploading…
                </>
              ) : (
                <>
                  <Upload className="mr-2 h-4 w-4" />
                  Upload
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!setToDelete}
        onOpenChange={(open) => !open && setSetToDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete plan set?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes <b>{setToDelete?.title}</b> and all its
              sheets. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {isDragActive && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 border border-dashed border-muted-foreground/40 bg-card/80 px-6 py-5">
            <Upload className="h-6 w-6 text-muted-foreground" />
            <div className="text-sm font-medium">Drop PDF to upload</div>
            <div className="text-xs text-muted-foreground">
              We'll split it into sheets automatically
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  description: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center border bg-muted/40">
        <Icon className="h-5 w-5 text-muted-foreground" />
      </div>
      <h2 className="mb-1 text-base font-semibold">{title}</h2>
      <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
