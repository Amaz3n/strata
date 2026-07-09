"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ElementType } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  ChevronDown,
  ChevronRight,
  FileText,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
  Download,
  Eye,
  AlertTriangle,
  History,
} from "lucide-react"
import {
  disciplineGradientClass,
  disciplineIcon,
} from "@/lib/utils/drawing-utils"

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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import {
  DISCIPLINE_LABELS,
  DRAWING_ISSUANCE_TYPE_LABELS,
} from "@/lib/validation/drawings"
import type { DrawingDiscipline, DrawingIssuanceType } from "@/lib/validation/drawings"
import { uploadDrawingFileToStorage } from "@/lib/services/drawings-client"
import {
  createDrawingMarkupAction,
  createDrawingPinAction,
  createDrawingSetFromUpload,
  createPunchItemFromDrawingAction,
  createRfiFromDrawingAction,
  createTaskFromDrawingAction,
  deleteDrawingMarkupAction,
  deleteDrawingSetAction,
  deleteDrawingSheetAction,
  getProcessingStatusAction,
  getSheetDownloadUrlAction,
  getSheetOptimizedImageUrlsAction,
  listUploadedSheetsAction,
  listDrawingMarkupsAction,
  listDrawingPinsWithEntitiesAction,
  listDrawingSetsAction,
  listDrawingSheetsAction,
  getDrawingRegisterSnapshotAction,
  retryProcessingAction,
  updateDrawingSheetAction,
  listDrawingRevisionsAction,
  listSheetVersionsAction,
  getPendingDraftRevisionAction,
} from "@/app/(app)/drawings/actions"
import type { RevisionDraftStatus } from "@/lib/services/drawings"
import type {
  DrawingMarkup,
  DrawingPin,
  DrawingSet,
  DrawingSheet,
  UploadReviewSheet,
  DrawingRevision,
  DrawingSheetVersion,
} from "@/app/(app)/drawings/types"
import { DrawingViewer } from "./drawing-viewer"
import { RevisionReviewDialog } from "./revision-review-dialog"
import { CreateFromDrawingDialog } from "./create-from-drawing-dialog"

import { unwrapAction } from "@/lib/action-result"

type ProjectOption = { id: string; name: string }

interface DrawingsSetsViewProps {
  initialSets: DrawingSet[]
  initialSheets?: DrawingSheet[]
  projects: ProjectOption[]
  selectedProjectId?: string
  lockProject?: boolean
  initialSelectedSetId?: string
  initialSheetId?: string
}

const DISCIPLINE_ORDER: DrawingDiscipline[] = [
  "G",
  "T",
  "A",
  "S",
  "M",
  "E",
  "P",
  "FP",
  "C",
  "L",
  "I",
  "SP",
  "D",
  "X",
]

const ISSUANCE_TYPE_ORDER: DrawingIssuanceType[] = [
  "revision",
  "asi",
  "bulletin",
  "addendum",
  "ifc_set",
  "permit_set",
  "bid_set",
  "sketch",
  "record_set",
  "other",
]


function formatDate(value?: string | null) {
  if (!value) return "—"
  const date = new Date(value)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  if (diffDays === 0) return "Today"
  if (diffDays === 1) return "Yesterday"
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  })
}

function disciplineLabel(code?: DrawingDiscipline | string | null) {
  if (!code) return "Unassigned"
  return (
    DISCIPLINE_LABELS[code as DrawingDiscipline] ??
    String(code).toUpperCase()
  )
}

function compareSheets(a: DrawingSheet, b: DrawingSheet) {
  if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
  return a.sheet_number.localeCompare(b.sheet_number, undefined, {
    numeric: true,
    sensitivity: "base",
  })
}

function compareDisciplineCodes(a: string, b: string) {
  const ai = DISCIPLINE_ORDER.indexOf(a as DrawingDiscipline)
  const bi = DISCIPLINE_ORDER.indexOf(b as DrawingDiscipline)
  const av = ai === -1 ? Number.MAX_SAFE_INTEGER : ai
  const bv = bi === -1 ? Number.MAX_SAFE_INTEGER : bi
  return av - bv
}

function buildSheetsBySet(sheets: DrawingSheet[]) {
  const map = new Map<string, DrawingSheet[]>()
  for (const sheet of sheets) {
    const existing = map.get(sheet.drawing_set_id)
    if (existing) existing.push(sheet)
    else map.set(sheet.drawing_set_id, [sheet])
  }
  for (const [setId, list] of map) {
    list.sort(compareSheets)
    map.set(setId, list)
  }
  return map
}

function sheetVersionLabel(sheet: DrawingSheet) {
  // Label by the sheet's own published version count: uploaded once -> v1,
  // revised once -> v2, etc. Immune to project-wide revision numbering.
  const count = sheet.version_count ?? 0
  return `v${count > 0 ? count : 1}`
}

function issuanceDisplayLabel(revision: DrawingRevision | RevisionDraftStatus) {
  const type = revision.issuance_type
    ? DRAWING_ISSUANCE_TYPE_LABELS[revision.issuance_type as DrawingIssuanceType]
    : null
  return type ? `${type}: ${revision.revision_label}` : revision.revision_label
}

function DisabledUploadMenuItem({
  icon: Icon,
  label,
  reason,
}: {
  icon: ElementType
  label: string
  reason: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <DropdownMenuItem
          aria-disabled="true"
          onSelect={(event) => event.preventDefault()}
          className="cursor-not-allowed opacity-50 focus:opacity-70"
        >
          <Icon className="mr-2 h-4 w-4" />
          {label}
        </DropdownMenuItem>
      </TooltipTrigger>
      <TooltipContent side="left" className="max-w-64 text-xs">
        {reason}
      </TooltipContent>
    </Tooltip>
  )
}

function describeProcessingStage(set: DrawingSet | null) {
  const processed = set?.processed_pages ?? 0
  const total = set?.total_pages ?? null
  const stage = set?.processing_stage ?? "queued"

  switch (stage) {
    case "queued":
      return {
        title: "Queued for processing",
        detail: "Waiting for the drawings worker to pick up this upload.",
      }
    case "worker_unavailable":
      return {
        title: "Drawing worker unavailable",
        detail: set?.error_message ?? "The upload is queued, but the background worker could not be reached.",
      }
    case "downloading_pdf":
      return {
        title: "Preparing upload",
        detail: "Downloading the source PDF and initializing the import.",
      }
    case "counting_pages":
      return {
        title: "Counting pages",
        detail: "Reading the PDF structure so we know how many sheets to process.",
      }
    case "extracting_text":
      return {
        title: `Processing ${processed}/${total ?? "?"} sheets`,
        detail: "Using OCR and embedded PDF text to read each page.",
      }
    case "rendering_pages":
      return {
        title: `Rendering ${processed}/${total ?? "?"} sheets`,
        detail: "Splitting the uploaded PDF into individual drawing pages.",
      }
    case "detecting_sheets":
      return {
        title: `Detecting sheet metadata`,
        detail: "Using computer vision and text extraction to identify sheet numbers, titles, and trades.",
      }
    case "creating_sheets":
      return {
        title: "Building the drawing register",
        detail: "Creating the page rows that will appear under each trade.",
      }
    case "generating_tiles":
      return {
        title: `Processing ${processed}/${total ?? "?"} sheets`,
        detail: "Generating the zoomable drawing tiles for fast viewing.",
      }
    case "ready":
      return {
        title: "Import complete",
        detail: "The uploaded pages are ready to review.",
      }
    default:
      return {
        title: `Processing ${processed}/${total ?? "?"} sheets`,
        detail: "Working through the uploaded drawing pages.",
      }
  }
}

export function DrawingsSetsView({
  initialSets,
  initialSheets = [],
  projects,
  selectedProjectId,
  lockProject = false,
  initialSelectedSetId,
  initialSheetId,
}: DrawingsSetsViewProps) {
  const router = useRouter()
  const [sets, setSets] = useState<DrawingSet[]>(initialSets)
  const [selectedSetId, setSelectedSetId] = useState<string | null>(
    initialSelectedSetId ?? null,
  )
  const [search, setSearch] = useState("")
  const [expandedDisciplines, setExpandedDisciplines] = useState<Set<string>>(
    new Set(),
  )
  const [sheetsBySet, setSheetsBySet] = useState<Map<string, DrawingSheet[]>>(() =>
    buildSheetsBySet(initialSheets),
  )
  const [sheetsLoading, setSheetsLoading] = useState(false)
  // Revision filter: "current" shows each sheet's latest version (default);
  // a revision id scopes the register to that revision's snapshot.
  const [revisionFilter, setRevisionFilter] = useState<string>("current")
  const [registerRevisions, setRegisterRevisions] = useState<DrawingRevision[]>([])
  const [snapshotSheets, setSnapshotSheets] = useState<DrawingSheet[]>([])
  const [snapshotLoading, setSnapshotLoading] = useState(false)
  const [isDragActive, setIsDragActive] = useState(false)
  const [processingMessageIndex, setProcessingMessageIndex] = useState(0)
  const dragCounterRef = useRef(0)

  // Upload dialog
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false)
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [uploadStage, setUploadStage] = useState<string | null>(null)
  const [issuanceLabel, setIssuanceLabel] = useState("")
  const [issuanceType, setIssuanceType] = useState<DrawingIssuanceType>("revision")
  const [issuanceDate, setIssuanceDate] = useState(() =>
    new Date().toISOString().slice(0, 10),
  )
  const [issuanceSource, setIssuanceSource] = useState("")
  const [issuanceNotes, setIssuanceNotes] = useState("")
  const [uploadStep, setUploadStep] = useState<"prepare" | "processing" | "review">("prepare")
  const [uploadSetId, setUploadSetId] = useState<string | null>(null)
  const [uploadSourceFileId, setUploadSourceFileId] = useState<string | null>(null)
  const [uploadStatus, setUploadStatus] = useState<{
    status: string
    processed_pages: number
    total_pages?: number
    processing_stage?: string
    error_message?: string
  } | null>(null)
  const [uploadedReviewSheets, setUploadedReviewSheets] = useState<UploadReviewSheet[]>([])
  // Draft -> publish revision review
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewRevisionId, setReviewRevisionId] = useState<string | null>(null)
  const [pendingDraft, setPendingDraft] = useState<RevisionDraftStatus | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const viewerSheetCacheRef = useRef<
    Map<
      string,
      {
        fileUrl: string | null
        sheet: DrawingSheet
        markups: DrawingMarkup[]
        pins: DrawingPin[]
      }
    >
  >(new Map())

  // Delete confirms
  const [setToDelete, setSetToDelete] = useState<DrawingSet | null>(null)
  const [sheetToDelete, setSheetToDelete] = useState<DrawingSheet | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [disciplineGroupToEdit, setDisciplineGroupToEdit] = useState<{
    code: string
    label: string
    sheets: DrawingSheet[]
  } | null>(null)
  const [disciplineGroupToDelete, setDisciplineGroupToDelete] = useState<{
    code: string
    label: string
    sheets: DrawingSheet[]
  } | null>(null)
  const [groupDisciplineValue, setGroupDisciplineValue] =
    useState<DrawingDiscipline>("X")
  const [isSavingGroup, setIsSavingGroup] = useState(false)
  const [sheetToRename, setSheetToRename] = useState<DrawingSheet | null>(null)
  const [renameSheetNumber, setRenameSheetNumber] = useState("")
  const [renameSheetTitle, setRenameSheetTitle] = useState("")
  const [isRenamingSheet, setIsRenamingSheet] = useState(false)

  // Upload sheet revision state
  const [revisionTargetSheet, setRevisionTargetSheet] = useState<DrawingSheet | null>(null)
  const [revisionFile, setRevisionFile] = useState<File | null>(null)
  const [sheetRevisionLabel, setSheetRevisionLabel] = useState("")
  const [sheetRevisionType, setSheetRevisionType] = useState<DrawingIssuanceType>("revision")
  const [sheetRevisionDate, setSheetRevisionDate] = useState(() =>
    new Date().toISOString().slice(0, 10),
  )
  const [sheetRevisionSource, setSheetRevisionSource] = useState("")
  const [sheetRevisionNotes, setSheetRevisionNotes] = useState("")
  const [savingSheetRevision, setSavingSheetRevision] = useState(false)
  const [loadingRevisionMeta, setLoadingRevisionMeta] = useState(false)
  const [knownRevisions, setKnownRevisions] = useState<DrawingRevision[]>([])
  const [knownVersionCount, setKnownVersionCount] = useState(0)

  // Viewer state
  const [viewerOpen, setViewerOpen] = useState(false)
  const [viewerVersionsOpen, setViewerVersionsOpen] = useState(false)
  const [viewerSheet, setViewerSheet] = useState<DrawingSheet | null>(null)
  const [viewerSheets, setViewerSheets] = useState<DrawingSheet[]>([])
  const [viewerUrl, setViewerUrl] = useState<string | null>(null)
  const [viewerMarkups, setViewerMarkups] = useState<DrawingMarkup[]>([])
  const [viewerPins, setViewerPins] = useState<DrawingPin[]>([])
  const [viewerHighlightedPinId, setViewerHighlightedPinId] = useState<
    string | null
  >(null)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [createPosition, setCreatePosition] = useState<{
    x: number
    y: number
  } | null>(null)
  const sheetOpenRequestIdRef = useRef(0)
  const initialSheetHandledRef = useRef(false)

  useEffect(() => {
    setSets(initialSets)
  }, [initialSets])

  useEffect(() => {
    setSheetsBySet(buildSheetsBySet(initialSheets))
  }, [initialSheets])

  useEffect(() => {
    setSelectedSetId(initialSelectedSetId ?? null)
  }, [initialSelectedSetId, selectedProjectId])

  useEffect(() => {
    initialSheetHandledRef.current = false
  }, [initialSheetId, selectedProjectId])

  // Reset cross-project state when the project changes.
  useEffect(() => {
    setSheetsBySet(buildSheetsBySet(initialSheets))
    setExpandedDisciplines(new Set())
    setSelectedSetId(null)
    setSheetsLoading(false)
  }, [initialSheets, selectedProjectId])

  // Pick a default set once sets load. Prefer the newest ready set so a
  // background upload does not take over the table while it is processing.
  useEffect(() => {
    if (!sets.length) {
      setSelectedSetId((curr) => (curr === null ? curr : null))
      return
    }
    setSelectedSetId((curr) => {
      if (curr && sets.some((s) => s.id === curr)) return curr
      const sorted = [...sets].sort(
        (a, b) =>
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      )
      const preferred =
        sorted.find((set) => set.status === "ready") ?? sorted[0] ?? null
      return preferred?.id ?? null
    })
  }, [sets])

  const loadProjectSheets = useCallback(async () => {
    if (!selectedProjectId) return
    setSheetsLoading(true)
    try {
      const all = await listDrawingSheetsAction({
        project_id: selectedProjectId,
        limit: 500,
      })
      setSheetsBySet(buildSheetsBySet(all))
    } catch (err) {
      console.error("Failed to load sheets:", err)
    } finally {
      setSheetsLoading(false)
    }
  }, [selectedProjectId])

  useEffect(() => {
    void loadProjectSheets()
  }, [loadProjectSheets])

  // Poll processing sets for status changes.
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

  // Surface an in-flight draft revision (pending review) for the project.
  const refreshPendingDraft = useCallback(async () => {
    if (!selectedProjectId) {
      setPendingDraft(null)
      return
    }
    try {
      const draft = await getPendingDraftRevisionAction(selectedProjectId)
      setPendingDraft(draft)
    } catch (err) {
      console.error("Failed to load pending draft revision:", err)
    }
  }, [selectedProjectId])

  useEffect(() => {
    void refreshPendingDraft()
  }, [refreshPendingDraft])

  const handleReviewResolved = useCallback(async () => {
    setReviewOpen(false)
    setReviewRevisionId(null)
    await Promise.all([refreshSets(), loadProjectSheets(), refreshPendingDraft()])
  }, [refreshSets, loadProjectSheets, refreshPendingDraft])

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
          await Promise.all([refreshSets(), loadProjectSheets()])
        }
      } catch (err) {
        console.error("Failed to poll status:", err)
      }
    }, 3000)
    return () => clearInterval(interval)
  }, [processingIds, loadProjectSheets, refreshSets])

  const activeSet = useMemo(
    () => sets.find((s) => s.id === selectedSetId) ?? null,
    [sets, selectedSetId],
  )
  const activeProcessingMessage = useMemo(
    () => describeProcessingStage(activeSet),
    [activeSet],
  )
  const uploadProcessingMessage = useMemo(() => {
    if (!uploadStatus) return null
    return describeProcessingStage({
      id: uploadSetId ?? "",
      org_id: "",
      project_id: selectedProjectId ?? "",
      title: uploadFile?.name ?? "Upload",
      status: uploadStatus.status as DrawingSet["status"],
      processed_pages: uploadStatus.processed_pages,
      total_pages: uploadStatus.total_pages,
      processing_stage: uploadStatus.processing_stage,
      created_at: "",
      updated_at: "",
    } as DrawingSet)
  }, [selectedProjectId, uploadFile?.name, uploadSetId, uploadStatus])
  const liveSheets = useMemo(
    () => (selectedSetId ? sheetsBySet.get(selectedSetId) ?? [] : []),
    [selectedSetId, sheetsBySet],
  )
  // When a past revision is selected, render its snapshot instead of the live set.
  const activeSheets = revisionFilter === "current" ? liveSheets : snapshotSheets

  // Load the set's published revisions for the revision filter. Reset the filter
  // to "current" whenever the selected set changes.
  useEffect(() => {
    setRevisionFilter("current")
    setSnapshotSheets([])
    if (!selectedSetId || !selectedProjectId) {
      setRegisterRevisions([])
      return
    }
    let cancelled = false
    listDrawingRevisionsAction({
      project_id: selectedProjectId,
      drawing_set_id: selectedSetId,
      limit: 100,
    })
      .then((revs) => {
        if (!cancelled) setRegisterRevisions(revs)
      })
      .catch((err) => {
        console.error("Failed to load revisions for filter:", err)
        if (!cancelled) setRegisterRevisions([])
      })
    return () => {
      cancelled = true
    }
  }, [selectedSetId, selectedProjectId])

  // Load the register snapshot for the chosen revision.
  useEffect(() => {
    if (revisionFilter === "current" || !selectedSetId) return
    let cancelled = false
    setSnapshotLoading(true)
    getDrawingRegisterSnapshotAction(selectedSetId, revisionFilter)
      .then((sheets) => {
        if (!cancelled) setSnapshotSheets(sheets)
      })
      .catch((err) => {
        console.error("Failed to load register snapshot:", err)
        if (!cancelled) {
          setSnapshotSheets([])
          toast.error("Could not load that revision")
        }
      })
      .finally(() => {
        if (!cancelled) setSnapshotLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [revisionFilter, selectedSetId])

  const filteredSheets = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return activeSheets
    return activeSheets.filter((s) => {
      const haystack = [
        s.sheet_number,
        s.sheet_title,
        s.discipline,
        disciplineLabel(s.discipline),
        s.current_revision_label,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
      return haystack.includes(q)
    })
  }, [activeSheets, search])

  const disciplineGroups = useMemo(() => {
    const map = new Map<string, DrawingSheet[]>()
    for (const sheet of filteredSheets) {
      const key = sheet.discipline ?? "X"
      const existing = map.get(key)
      if (existing) existing.push(sheet)
      else map.set(key, [sheet])
    }
    return Array.from(map.entries())
      .map(([code, list]) => ({
        code,
        label: disciplineLabel(code),
        sheets: list.sort(compareSheets),
      }))
      .sort((a, b) => compareDisciplineCodes(a.code, b.code))
  }, [filteredSheets])

  // When searching, show all matches expanded; otherwise honor user's manual expand state.
  const effectiveExpanded = useMemo(() => {
    if (!search.trim()) return expandedDisciplines
    return new Set(disciplineGroups.map((g) => g.code))
  }, [search, expandedDisciplines, disciplineGroups])

  const toggleDiscipline = useCallback((code: string) => {
    setExpandedDisciplines((prev) => {
      const next = new Set(prev)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })
  }, [])

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
    if (pendingDraft) {
      setReviewRevisionId(pendingDraft.id)
      setReviewOpen(true)
      return
    }
    fileInputRef.current?.click()
  }

  const openPendingDraftReview = () => {
    if (!pendingDraft) return
    setReviewRevisionId(pendingDraft.id)
    setReviewOpen(true)
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
    setIssuanceLabel("")
    setIssuanceType(sets.length > 0 ? "revision" : "ifc_set")
    setIssuanceDate(new Date().toISOString().slice(0, 10))
    setIssuanceSource("")
    setIssuanceNotes("")
    setUploadStep("prepare")
    setUploadStatus(null)
    setUploadedReviewSheets([])
    setUploadSetId(null)
    setUploadSourceFileId(null)
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
      const { set: newSet, draftRevisionId } = unwrapAction(await createDrawingSetFromUpload({
        projectId: selectedProjectId,
        fileName: uploadFile.name,
        storagePath,
        fileSize: uploadFile.size,
        mimeType: uploadFile.type,
        issuanceLabel: issuanceLabel.trim() || undefined,
        issuanceType,
        issuedDate: issuanceDate || undefined,
        receivedFrom: issuanceSource.trim() || undefined,
        notes: issuanceNotes.trim() || undefined,
      }))

      setSets((prev) => {
        const withoutCurrent = prev.filter((set) => set.id !== newSet.id)
        return [newSet, ...withoutCurrent]
      })
      setSelectedSetId((current) => current ?? newSet.id)

      // Close the upload dialog and hand off to the draft issuance review, which
      // polls processing and lets the user publish or discard.
      setUploadDialogOpen(false)
      setUploadFile(null)
      setReviewRevisionId(draftRevisionId)
      setReviewOpen(true)

      toast.success("Upload received — review the package before publishing.")
    } catch (err) {
      console.error("Upload failed:", err)
      toast.error(
        err instanceof Error ? err.message : "Failed to upload drawings",
      )
    } finally {
      setIsUploading(false)
      setUploadStage(null)
    }
  }

  useEffect(() => {
    if (!uploadDialogOpen || uploadStep !== "processing" || !uploadSetId) return

    let cancelled = false

    const poll = async () => {
      try {
        const status = await getProcessingStatusAction(uploadSetId)
        if (cancelled) return
        setUploadStatus(status)

        setSets((prev) =>
          prev.map((set) =>
            set.id === uploadSetId
              ? {
                  ...set,
                  status: status.status as DrawingSet["status"],
                  processed_pages: status.processed_pages,
                  total_pages: status.total_pages,
                  processing_stage: status.processing_stage,
                  error_message: status.error_message,
                }
              : set,
          ),
        )

        if (status.status === "ready") {
          await Promise.all([refreshSets(), loadProjectSheets()])
          // The worker re-points sheets onto this newly processed set, so the
          // previously selected set is now empty. Switch to the new set so the
          // register isn't left showing an empty table after a revision upload.
          if (!cancelled) setSelectedSetId(uploadSetId)
          if (uploadSourceFileId) {
            const reviewSheets = await listUploadedSheetsAction(uploadSourceFileId)
            if (cancelled) return
            setUploadedReviewSheets(reviewSheets)
          }
          if (!cancelled) {
            setUploadStep("review")
          }
        }
      } catch (error) {
        console.error("Failed to poll upload status:", error)
      }
    }

    void poll()
    const interval = setInterval(() => {
      void poll()
    }, 2500)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [
    loadProjectSheets,
    refreshSets,
    uploadDialogOpen,
    uploadSetId,
    uploadSourceFileId,
    uploadStep,
  ])

  const handleDeleteSet = async () => {
    if (!setToDelete) return
    setIsDeleting(true)
    try {
      unwrapAction(await deleteDrawingSetAction(setToDelete.id))
      setSets((prev) => prev.filter((s) => s.id !== setToDelete.id))
      setSheetsBySet((prev) => {
        const next = new Map(prev)
        next.delete(setToDelete.id)
        return next
      })
      if (selectedSetId === setToDelete.id) setSelectedSetId(null)
      toast.success("Plan set deleted")
    } catch (err) {
      console.error(err)
      toast.error("Failed to delete plan set")
    } finally {
      setIsDeleting(false)
      setSetToDelete(null)
    }
  }

  const handleDeleteSheet = async () => {
    if (!sheetToDelete) return
    setIsDeleting(true)
    try {
      unwrapAction(await deleteDrawingSheetAction(sheetToDelete.id))
      setSheetsBySet((prev) => {
        const next = new Map(prev)
        for (const [k, list] of next) {
          if (list.some((s) => s.id === sheetToDelete.id)) {
            next.set(
              k,
              list.filter((s) => s.id !== sheetToDelete.id),
            )
            break
          }
        }
        return next
      })
      toast.success("Sheet deleted")
    } catch (err) {
      console.error(err)
      toast.error("Failed to delete sheet")
    } finally {
      setIsDeleting(false)
      setSheetToDelete(null)
    }
  }

  const handleUpdateDisciplineGroup = async () => {
    if (!disciplineGroupToEdit) return
    setIsSavingGroup(true)
    try {
      const originalSheets = disciplineGroupToEdit.sheets
      const nextDiscipline = groupDisciplineValue

      setSheetsBySet((curr) => {
        const next = new Map(curr)
        for (const [setId, list] of next) {
          const updated = list.map((sheet) =>
            originalSheets.some((candidate) => candidate.id === sheet.id)
              ? { ...sheet, discipline: nextDiscipline }
              : sheet,
          )
          updated.sort(compareSheets)
          next.set(setId, updated)
        }
        return next
      })

      await Promise.all(
        originalSheets.map((sheet) =>
          updateDrawingSheetAction(sheet.id, { discipline: nextDiscipline }).then(unwrapAction),
        ),
      )

      toast.success(
        `Moved ${originalSheets.length} ${originalSheets.length === 1 ? "sheet" : "sheets"} to ${disciplineLabel(nextDiscipline)}`,
      )
      setDisciplineGroupToEdit(null)
    } catch (err) {
      console.error(err)
      await loadProjectSheets()
      toast.error("Failed to update trade")
    } finally {
      setIsSavingGroup(false)
    }
  }

  const handleDeleteDisciplineGroup = async () => {
    if (!disciplineGroupToDelete) return
    setIsDeleting(true)
    try {
      await Promise.all(
        disciplineGroupToDelete.sheets.map((sheet) =>
          deleteDrawingSheetAction(sheet.id).then(unwrapAction),
        ),
      )
      setSheetsBySet((curr) => {
        const next = new Map(curr)
        for (const [setId, list] of next) {
          next.set(
            setId,
            list.filter(
              (sheet) =>
                !disciplineGroupToDelete.sheets.some(
                  (candidate) => candidate.id === sheet.id,
                ),
            ),
          )
        }
        return next
      })
      toast.success(
        `Deleted ${disciplineGroupToDelete.sheets.length} ${disciplineGroupToDelete.sheets.length === 1 ? "sheet" : "sheets"} from ${disciplineGroupToDelete.label}`,
      )
      setDisciplineGroupToDelete(null)
    } catch (err) {
      console.error(err)
      await loadProjectSheets()
      toast.error("Failed to delete trade pages")
    } finally {
      setIsDeleting(false)
    }
  }

  const handleRenameSheet = async () => {
    if (!sheetToRename) return
    setIsRenamingSheet(true)
    try {
      const updates = {
        sheet_number: renameSheetNumber.trim() || sheetToRename.sheet_number,
        sheet_title: renameSheetTitle.trim() || undefined,
      }

      unwrapAction(await updateDrawingSheetAction(sheetToRename.id, updates))
      setSheetsBySet((curr) => {
        const next = new Map(curr)
        for (const [setId, list] of next) {
          const idx = list.findIndex((sheet) => sheet.id === sheetToRename.id)
          if (idx === -1) continue
          const updated = [...list]
          updated[idx] = { ...updated[idx], ...updates, updated_at: new Date().toISOString() }
          updated.sort(compareSheets)
          next.set(setId, updated)
          break
        }
        return next
      })
      toast.success("Page renamed")
      setSheetToRename(null)
    } catch (err) {
      console.error(err)
      toast.error("Failed to rename page")
    } finally {
      setIsRenamingSheet(false)
    }
  }

  const handleRetry = async (setId: string) => {
    try {
      unwrapAction(await retryProcessingAction(setId))
      toast.success("Processing restarted")
      await refreshSets()
    } catch {
      toast.error("Failed to restart processing")
    }
  }

  const openUploadRevisionDialog = useCallback(
    async (sheet: DrawingSheet) => {
      const targetSetId = sheet.drawing_set_id || selectedSetId
      if (!targetSetId || !selectedProjectId) return
      setRevisionTargetSheet(sheet)
      setRevisionFile(null)
      setSheetRevisionNotes("")
      setSheetRevisionLabel("")
      setSheetRevisionType("revision")
      setSheetRevisionDate(new Date().toISOString().slice(0, 10))
      setSheetRevisionSource("")
      setKnownRevisions([])
      setKnownVersionCount(0)
      setLoadingRevisionMeta(true)
      try {
        const [revisions, versions] = await Promise.all([
          listDrawingRevisionsAction({
            project_id: selectedProjectId,
            drawing_set_id: targetSetId,
            limit: 100,
          }),
          listSheetVersionsAction(sheet.id),
        ])
        setKnownRevisions(revisions)
        setKnownVersionCount(versions.length)
        setSheetRevisionLabel(`Revision ${revisions.length + 1}`)
      } catch (error) {
        console.error("Failed to load version metadata:", error)
        setSheetRevisionLabel("Rev 1")
      } finally {
        setLoadingRevisionMeta(false)
      }
    },
    [selectedProjectId, selectedSetId],
  )

  const handleUploadSheetRevision = useCallback(async () => {
    const targetSetId = revisionTargetSheet?.drawing_set_id || selectedSetId
    if (!revisionTargetSheet || !targetSetId || !selectedProjectId) return
    if (!revisionFile) {
      toast.error("Choose a version file")
      return
    }
    if (revisionFile.type !== "application/pdf") {
      toast.error("Sheet revisions must be uploaded as PDFs")
      return
    }
    const cleanRevisionLabel = sheetRevisionLabel.trim()
    if (!cleanRevisionLabel) {
      toast.error("Package label is required")
      return
    }
    setSavingSheetRevision(true)
    try {
      const orgId = document.cookie.match(/(?:^|; )org_id=([^;]+)/)?.[1]
      if (!orgId) throw new Error("Organization not found. Please refresh.")

      const { storagePath } = await uploadDrawingFileToStorage(
        revisionFile,
        selectedProjectId,
        orgId,
      )
      const { draftRevisionId } = unwrapAction(await createDrawingSetFromUpload({
        projectId: selectedProjectId,
        fileName: revisionFile.name,
        storagePath,
        fileSize: revisionFile.size,
        mimeType: revisionFile.type,
        issuanceLabel: cleanRevisionLabel,
        issuanceType: sheetRevisionType,
        issuedDate: sheetRevisionDate || undefined,
        receivedFrom: sheetRevisionSource.trim() || undefined,
        notes: sheetRevisionNotes.trim() || undefined,
        targetSheetId: revisionTargetSheet.id,
      }))

      await Promise.all([refreshSets(), refreshPendingDraft()])
      setReviewRevisionId(draftRevisionId)
      setReviewOpen(true)
      toast.success("Sheet revision received — review it before publishing.")
      setRevisionTargetSheet(null)
      setRevisionFile(null)
    } catch (error) {
      console.error("Failed to queue sheet revision:", error)
      toast.error("Failed to queue sheet revision")
    } finally {
      setSavingSheetRevision(false)
    }
  }, [
    selectedProjectId,
    selectedSetId,
    sheetRevisionLabel,
    sheetRevisionType,
    sheetRevisionDate,
    sheetRevisionSource,
    sheetRevisionNotes,
    revisionFile,
    revisionTargetSheet,
    refreshSets,
    refreshPendingDraft,
  ])

  const handleDisciplineChange = useCallback(
    async (sheetId: string, discipline: DrawingDiscipline) => {
      const prevMap = sheetsBySet
      setSheetsBySet((curr) => {
        const next = new Map(curr)
        for (const [k, list] of next) {
          const idx = list.findIndex((s) => s.id === sheetId)
          if (idx >= 0) {
            const updated = [...list]
            updated[idx] = { ...updated[idx], discipline }
            updated.sort(compareSheets)
            next.set(k, updated)
            break
          }
        }
        return next
      })
      try {
        unwrapAction(await updateDrawingSheetAction(sheetId, { discipline }))
        toast.success(`Moved to ${disciplineLabel(discipline)}`)
      } catch (err) {
        console.error(err)
        setSheetsBySet(prevMap)
        toast.error("Failed to change discipline")
      }
    },
    [sheetsBySet],
  )

  const handleViewSheet = useCallback(
    async (sheet: DrawingSheet, highlightPinId?: string | null, openVersions?: boolean) => {
      const requestId = ++sheetOpenRequestIdRef.current
      const siblings = sheetsBySet.get(sheet.drawing_set_id) ?? [sheet]
      setViewerSheets(siblings)
      const cached = viewerSheetCacheRef.current.get(sheet.id)
      if (cached) {
        setViewerSheet(cached.sheet)
        setViewerHighlightedPinId(highlightPinId ?? null)
        setViewerUrl(cached.fileUrl)
        setViewerMarkups(cached.markups)
        setViewerPins(cached.pins)
        setViewerVersionsOpen(openVersions ?? false)
        setViewerOpen(true)
        return
      }

      setViewerSheet(sheet)
      setViewerHighlightedPinId(highlightPinId ?? null)
      setViewerUrl(null)
      setViewerMarkups([])
      setViewerPins([])
      setViewerVersionsOpen(openVersions ?? false)
      setViewerOpen(true)

      try {
        const hasTiles =
          !!(sheet as any).tile_base_url && !!(sheet as any).tile_manifest
        const hasOptimized =
          !!sheet.image_full_url &&
          !!sheet.image_medium_url &&
          !!sheet.image_thumbnail_url

        const [signedImages, url, markups, pins] = await Promise.all([
          hasOptimized && !hasTiles
            ? getSheetOptimizedImageUrlsAction(sheet.id).catch(() => null)
            : Promise.resolve(null),
          getSheetDownloadUrlAction(sheet.id).catch(() => null),
          listDrawingMarkupsAction({ drawing_sheet_id: sheet.id }).catch(
            () => [],
          ),
          listDrawingPinsWithEntitiesAction(sheet.id).catch(() => []),
        ])

        if (sheetOpenRequestIdRef.current !== requestId) return

        if (signedImages && !hasTiles) {
          setViewerSheet((prev) => {
            if (!prev || prev.id !== sheet.id) return prev
            return {
              ...prev,
              image_thumbnail_url:
                signedImages.thumbnailUrl ?? prev.image_thumbnail_url ?? null,
              image_medium_url:
                signedImages.mediumUrl ?? prev.image_medium_url ?? null,
              image_full_url:
                signedImages.fullUrl ?? prev.image_full_url ?? null,
              image_width: signedImages.width ?? prev.image_width ?? null,
              image_height: signedImages.height ?? prev.image_height ?? null,
            }
          })
        }

        if (!hasOptimized && !hasTiles && !url) {
          toast.error("Sheet file not available")
          setViewerOpen(false)
          return
        }

        const resolvedSheet =
          signedImages && !hasTiles
            ? {
                ...sheet,
                image_thumbnail_url:
                  signedImages.thumbnailUrl ?? sheet.image_thumbnail_url ?? null,
                image_medium_url:
                  signedImages.mediumUrl ?? sheet.image_medium_url ?? null,
                image_full_url:
                  signedImages.fullUrl ?? sheet.image_full_url ?? null,
                image_width: signedImages.width ?? sheet.image_width ?? null,
                image_height: signedImages.height ?? sheet.image_height ?? null,
              }
            : sheet

        viewerSheetCacheRef.current.set(sheet.id, {
          fileUrl: url,
          sheet: resolvedSheet,
          markups,
          pins,
        })

        setViewerSheet(resolvedSheet)
        setViewerUrl(url)
        setViewerMarkups(markups)
        setViewerPins(pins)
      } catch (err) {
        console.error("Failed to open sheet:", err)
        if (sheetOpenRequestIdRef.current === requestId) {
          toast.error("Failed to load sheet")
        }
      }
    },
    [sheetsBySet],
  )

  useEffect(() => {
    if (!initialSheetId || initialSheetHandledRef.current) return
    for (const sheets of sheetsBySet.values()) {
      const match = sheets.find((sheet) => sheet.id === initialSheetId)
      if (!match) continue
      initialSheetHandledRef.current = true
      setSelectedSetId(match.drawing_set_id)
      void handleViewSheet(match)
      return
    }
  }, [handleViewSheet, initialSheetId, sheetsBySet])

  const handleSaveMarkup = async (
    markup: Omit<DrawingMarkup, "id" | "org_id" | "created_at" | "updated_at">,
  ) => {
    try {
      const created = unwrapAction(await createDrawingMarkupAction(markup))
      setViewerMarkups((prev) => [...prev, created])
      if (viewerSheet) {
        const cached = viewerSheetCacheRef.current.get(viewerSheet.id)
        if (cached) {
          viewerSheetCacheRef.current.set(viewerSheet.id, {
            ...cached,
            markups: [...cached.markups, created],
          })
        }
      }
      toast.success("Markup saved")
    } catch (err) {
      console.error(err)
      toast.error("Failed to save markup")
    }
  }

  const handleDeleteMarkup = async (markupId: string) => {
    try {
      unwrapAction(await deleteDrawingMarkupAction(markupId))
      setViewerMarkups((prev) => prev.filter((m) => m.id !== markupId))
      if (viewerSheet) {
        const cached = viewerSheetCacheRef.current.get(viewerSheet.id)
        if (cached) {
          viewerSheetCacheRef.current.set(viewerSheet.id, {
            ...cached,
            markups: cached.markups.filter((markup) => markup.id !== markupId),
          })
        }
      }
      toast.success("Markup deleted")
    } catch (err) {
      console.error(err)
      toast.error("Failed to delete markup")
    }
  }

  const handleCreatePin = (x: number, y: number) => {
    setCreatePosition({ x, y })
    setCreateDialogOpen(true)
  }

  const handlePinClick = (pin: DrawingPin) => {
    const base = pin.project_id ? `/projects/${pin.project_id}` : null
    if (!base) return
    switch (pin.entity_type) {
      case "task":
        router.push(`${base}/tasks`)
        break
      case "rfi":
        router.push(`${base}/rfis`)
        break
      case "submittal":
        router.push(`${base}/submittals`)
        break
      case "punch_list":
        router.push(`${base}/punch`)
        break
      case "daily_log":
        router.push(`${base}/daily-logs`)
        break
      default:
        router.push(base)
    }
    setViewerOpen(false)
  }

  const handleCreateFromDrawing = async (input: any) => {
    if (!viewerSheet || !createPosition) return
    try {
      const pinProjectId = input.project_id ?? viewerSheet.project_id
      let entityId: string | null = null

      if (input.entityType === "task") {
        const created = unwrapAction(await createTaskFromDrawingAction(pinProjectId, {
          title: input.title,
          description: input.description,
          priority:
            input.priority === "high"
              ? "high"
              : input.priority === "low"
                ? "low"
                : "normal",
          status: "todo",
        }))
        entityId = created.id
      } else if (input.entityType === "rfi") {
        const created = unwrapAction(await createRfiFromDrawingAction({
          projectId: pinProjectId,
          subject: input.subject ?? input.title,
          question: input.question ?? input.description ?? "",
          priority:
            input.priority === "high"
              ? "high"
              : input.priority === "low"
                ? "low"
                : "normal",
        }))
        entityId = created.id
      } else if (input.entityType === "punch_list") {
        const created = unwrapAction(await createPunchItemFromDrawingAction({
          projectId: pinProjectId,
          title: input.title,
          description: input.description,
          location: input.location,
          severity: input.priority,
        }))
        entityId = created.id
      } else if (input.entityType === "issue") {
        const created = unwrapAction(await createTaskFromDrawingAction(pinProjectId, {
          title: input.title,
          description: input.description,
          priority: "high",
          status: "todo",
          tags: ["issue"],
        }))
        entityId = created.id
      }

      if (!entityId) throw new Error("Unsupported entity type")

      const pin = unwrapAction(await createDrawingPinAction({
        project_id: pinProjectId,
        drawing_sheet_id: viewerSheet.id,
        x_position: createPosition.x,
        y_position: createPosition.y,
        entity_type: input.entityType,
        entity_id: entityId,
        label: input.title,
        status: "open",
      }))

      setViewerPins((prev) => [...prev, pin])
      if (viewerSheet) {
        const cached = viewerSheetCacheRef.current.get(viewerSheet.id)
        if (cached) {
          viewerSheetCacheRef.current.set(viewerSheet.id, {
            ...cached,
            pins: [...cached.pins, pin],
          })
        }
      }
      setCreateDialogOpen(false)
      setCreatePosition(null)
      setViewerHighlightedPinId(pin.id)
      toast.success("Created and pinned to drawing")
    } catch (err) {
      console.error(err)
      toast.error("Failed to create entity")
    }
  }

  const isPdfDrag = (event: React.DragEvent) =>
    Array.from(event.dataTransfer.items).some(
      (item) => item.kind === "file" && item.type === "application/pdf",
    )

  const totalSheetsInSet = activeSheets.length
  const activeSetReady = activeSet?.status === "ready"
  const activeSetProcessing = activeSet?.status === "processing"
  const activeSetFailed = activeSet?.status === "failed"

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

      {/* Toolbar */}
      <div className="border-b">
        <div
          className={cn(
            "flex flex-wrap items-center gap-2 px-4 pb-0 sm:pb-3 sm:pt-3",
            // No selector on mobile (locked project) → no empty top band above the search.
            lockProject ? "pt-0" : "pt-3",
          )}
        >
          {!lockProject && (
            <Select
              value={selectedProjectId ?? "all"}
              onValueChange={handleProjectChange}
            >
              <SelectTrigger className="h-9 w-full sm:w-[200px]">
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

          {/* Desktop search lives inline in the toolbar row. */}
          <div className="relative hidden w-full sm:block sm:max-w-sm">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search sheets…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 pl-9 pr-9"
              disabled={!activeSet}
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

          {/* Revision filter: scope the register to a single revision so only
              one version of each sheet shows at a time. Only meaningful once the
              set has more than one revision. */}
          {activeSet && registerRevisions.length > 1 && (
            <div className="hidden items-center gap-2 sm:flex">
              <span className="whitespace-nowrap text-xs text-muted-foreground">
                Showing
              </span>
              <Select value={revisionFilter} onValueChange={setRevisionFilter}>
                <SelectTrigger className="h-9 w-[200px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="current">Current (latest)</SelectItem>
                  {registerRevisions.map((rev) => (
                    <SelectItem key={rev.id} value={rev.id}>
                      {issuanceDisplayLabel(rev)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Upload is desktop-only — mobile is a read/review surface. */}
          <div className="ml-auto hidden items-center gap-2 sm:flex">
            {sets.length === 0 && !pendingDraft ? (
              <Button
                onClick={openFilePicker}
                disabled={!selectedProjectId}
                size="sm"
                className="h-9"
              >
                <Upload className="mr-2 h-4 w-4" />
                Upload drawings
              </Button>
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button disabled={!selectedProjectId} size="sm" className="h-9">
                    {pendingDraft ? (
                      <>
                        <History className="mr-2 h-4 w-4" />
                        Review pending
                      </>
                    ) : (
                      <>
                        <Upload className="mr-2 h-4 w-4" />
                        Add issuance
                      </>
                    )}
                    <ChevronDown className="ml-2 h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <TooltipProvider delayDuration={150}>
                  <DropdownMenuContent align="end" className="w-64">
                    {pendingDraft ? (
                      <DisabledUploadMenuItem
                        icon={Upload}
                        label="Add drawing issuance"
                        reason="Publish or discard the pending issuance before uploading another drawing package."
                      />
                    ) : (
                      <DropdownMenuItem onClick={openFilePicker}>
                        <Upload className="mr-2 h-4 w-4" />
                        Add drawing issuance
                      </DropdownMenuItem>
                    )}
                    {pendingDraft ? (
                      <DropdownMenuItem onClick={openPendingDraftReview}>
                        <History className="mr-2 h-4 w-4" />
                        Review pending issuance
                      </DropdownMenuItem>
                    ) : (
                      <DisabledUploadMenuItem
                        icon={History}
                        label="Review pending issuance"
                        reason="There is no draft issuance waiting for review."
                      />
                    )}
                  </DropdownMenuContent>
                </TooltipProvider>
              </DropdownMenu>
            )}
          </div>
        </div>

        {/* Mobile search: full-bleed bar flush to the toolbar edges. */}
        <div className="relative sm:hidden">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search sheets…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-12 rounded-none border-0 bg-transparent pl-11 pr-11 shadow-none focus-visible:ring-0"
            disabled={!activeSet}
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Viewing a past revision (read-only snapshot of the register). */}
      {revisionFilter !== "current" && (
        <div className="flex items-center gap-3 border-b bg-blue-500/10 px-4 py-2 text-xs">
          <History className="h-4 w-4 shrink-0 text-blue-600" />
          <div className="min-w-0 flex-1 text-muted-foreground">
            <span className="font-medium text-foreground">
              {(() => {
                const revision = registerRevisions.find((r) => r.id === revisionFilter)
                return revision ? issuanceDisplayLabel(revision) : "Revision"
              })()}
            </span>
            {" — showing each sheet as of this revision."}
            {snapshotLoading && " Loading…"}
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            onClick={() => setRevisionFilter("current")}
          >
            Back to current
          </Button>
        </div>
      )}

      {/* Pending draft revision banner */}
      {pendingDraft && (
        <div className="flex items-center gap-3 border-b bg-amber-500/10 px-4 py-2 text-xs">
          <RefreshCw
            className={cn(
              "h-4 w-4 shrink-0 text-amber-600",
              pendingDraft.status === "processing" && "animate-spin",
            )}
          />
          <div className="min-w-0 flex-1">
            <span className="font-medium text-foreground">
              {pendingDraft.status === "processing"
                ? "A drawing package is processing"
                : "A drawing package is waiting for review"}
            </span>
            <span className="text-muted-foreground">
              {" — "}
              {issuanceDisplayLabel(pendingDraft)}. The live drawings are unchanged until
              you publish.
            </span>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            onClick={() => {
              setReviewRevisionId(pendingDraft.id)
              setReviewOpen(true)
            }}
          >
            Review
          </Button>
        </div>
      )}

      {/* Set status banner for failed/processing */}
      {activeSet && activeSetProcessing && (
        <div className="flex items-center gap-3 border-b bg-chart-1/5 px-4 py-2 text-xs">
          <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin text-chart-1" />
          <div className="min-w-0 flex-1 overflow-hidden">
            <div
              key={`${activeSet.id}-${activeSet.processing_stage}-${activeSet.processed_pages}`}
              className="animate-in slide-in-from-bottom-2 fade-in duration-300"
            >
              <div className="truncate text-muted-foreground">
                <b className="font-medium text-foreground">{activeSet.title}</b>
              </div>
              <div className="truncate text-[11px] text-muted-foreground/90">
                {activeProcessingMessage.detail}
              </div>
            </div>
          </div>
          <Progress
            value={
              activeSet.total_pages && activeSet.total_pages > 0
                ? (activeSet.processed_pages / activeSet.total_pages) * 100
                : 0
            }
            className="h-1 max-w-[180px] flex-1"
          />
        </div>
      )}
      {activeSet && activeSetFailed && (
        <div className="flex items-center gap-3 border-b bg-destructive/5 px-4 py-2 text-xs">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
          <span className="text-muted-foreground">
            <b className="font-medium text-destructive">{activeSet.title}</b> failed
            to process
            {activeSet.error_message ? ` — ${activeSet.error_message}` : ""}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-7 text-xs"
            onClick={() => handleRetry(activeSet.id)}
          >
            <RefreshCw className="mr-1.5 h-3 w-3" />
            Retry
          </Button>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {!selectedProjectId ? (
          <EmptyState
            icon={FileText}
            title="Select a project"
            description="Choose a project to view its drawings."
          />
        ) : sets.length === 0 ? (
          <EmptyState
            icon={Upload}
            title="No plan sets yet"
            description="Upload a PDF plan set to get started. It will be split into sheets automatically."
            action={
              <Button onClick={openFilePicker} size="sm">
                <Upload className="mr-2 h-4 w-4" />
                Upload drawing package
              </Button>
            }
          />
        ) : !activeSet ? (
          <EmptyState
            icon={FileText}
            title="No plan set available"
            description="Upload a plan set to start organizing drawings."
          />
        ) : totalSheetsInSet === 0 ? (
          <EmptyState
            icon={FileText}
            title="No sheets yet"
            description={
              activeSetFailed
                ? "Processing failed — retry from above."
                : activeSetProcessing
                  ? "Sheets are processing in the background."
                : "This plan set doesn't have any sheets yet."
            }
          />
        ) : disciplineGroups.length === 0 ? (
          <EmptyState
            icon={Search}
            title="No results"
            description="No sheets match your search."
            action={
              <Button variant="outline" size="sm" onClick={() => setSearch("")}>
                Clear search
              </Button>
            }
          />
        ) : (
          <Table className="table-fixed sm:min-w-[880px]">
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="w-10 pl-4" />
                <TableHead className="w-full sm:w-[44%] sm:min-w-[300px] text-xs font-medium text-muted-foreground">
                  Drawing Register
                </TableHead>
                <TableHead className="hidden sm:table-cell w-[100px] text-center text-xs font-medium text-muted-foreground">
                  Pages
                </TableHead>
                <TableHead className="hidden md:table-cell w-[120px] text-center text-xs font-medium text-muted-foreground">
                  Version
                </TableHead>
                <TableHead className="hidden md:table-cell w-[160px] text-center text-xs font-medium text-muted-foreground">
                  Modified By
                </TableHead>
                <TableHead className="hidden lg:table-cell w-[120px] text-center text-xs font-medium text-muted-foreground">
                  Updated
                </TableHead>
                <TableHead className="w-[60px] pr-4" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {disciplineGroups.map((group) => (
                <DisciplineRows
                  key={group.code}
                  code={group.code}
                  label={group.label}
                  sheets={group.sheets}
                  isExpanded={effectiveExpanded.has(group.code)}
                  onToggle={() => toggleDiscipline(group.code)}
                  onEditGroup={() => {
                    setDisciplineGroupToEdit(group)
                    setGroupDisciplineValue(group.code as DrawingDiscipline)
                  }}
                  onDeleteGroup={() => setDisciplineGroupToDelete(group)}
                  onViewSheet={handleViewSheet}
                  onDisciplineChange={handleDisciplineChange}
                  onRenameSheet={(sheet) => {
                    setSheetToRename(sheet)
                    setRenameSheetNumber(sheet.sheet_number)
                    setRenameSheetTitle(sheet.sheet_title ?? "")
                  }}
                  onDeleteSheet={(s) => setSheetToDelete(s)}
                  onUploadRevisionSheet={openUploadRevisionDialog}
                  highlight={search.trim().toLowerCase()}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <Dialog open={uploadDialogOpen} onOpenChange={setUploadDialogOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {uploadStep === "review"
                ? "Review imported pages"
                : sets.length > 0
                  ? "Upload drawing package"
                  : "Upload initial drawing package"}
            </DialogTitle>
            <DialogDescription>
              {uploadStep === "review"
                ? "The new pages are ready. Review them here and make any quick corrections before closing."
                : sets.length > 0
                  ? "Upload another PDF into this project's single drawing register. We'll process it as a draft package, detect pages by trade, and keep the existing register intact while it runs."
                  : "Upload a PDF and we'll process it, detect page metadata, and separate the pages into trades automatically."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {uploadStep !== "review" && (
              <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
                We process the PDF into a draft issuance first, then let you review what changed before the live register updates.
              </div>
            )}

            {uploadFile && (
              <div className="flex items-center gap-3 rounded-lg border p-3">
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

            {uploadStep === "prepare" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="issuance-type">Package type</Label>
                  <Select
                    value={issuanceType}
                    onValueChange={(value) => setIssuanceType(value as DrawingIssuanceType)}
                  >
                    <SelectTrigger id="issuance-type" className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ISSUANCE_TYPE_ORDER.map((type) => (
                        <SelectItem key={type} value={type}>
                          {DRAWING_ISSUANCE_TYPE_LABELS[type]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="issuance-label">Package label</Label>
                  <Input
                    id="issuance-label"
                    value={issuanceLabel}
                    onChange={(e) => setIssuanceLabel(e.target.value)}
                    placeholder="e.g., ASI 03, Bulletin 02"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="issuance-date">Issued date</Label>
                  <Input
                    id="issuance-date"
                    type="date"
                    value={issuanceDate}
                    onChange={(e) => setIssuanceDate(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="issuance-source">Received from</Label>
                  <Input
                    id="issuance-source"
                    value={issuanceSource}
                    onChange={(e) => setIssuanceSource(e.target.value)}
                    placeholder="Architect, owner, consultant"
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="issuance-notes">Notes</Label>
                  <Input
                    id="issuance-notes"
                    value={issuanceNotes}
                    onChange={(e) => setIssuanceNotes(e.target.value)}
                    placeholder="Optional package notes"
                  />
                </div>
              </div>
            )}

            {uploadStep === "processing" && uploadStatus && uploadProcessingMessage && (
              <div className="space-y-4 rounded-xl border bg-muted/20 p-4">
                <div className="flex items-start gap-3">
                  <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-chart-1" />
                  <div className="min-w-0 flex-1">
                    <div
                      key={`${uploadStatus.processing_stage}-${uploadStatus.processed_pages}`}
                      className="animate-in slide-in-from-bottom-2 fade-in duration-300"
                    >
                      <p className="text-sm font-medium">
                        {uploadProcessingMessage.title}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {uploadProcessingMessage.detail}
                      </p>
                    </div>
                  </div>
                </div>
                <Progress
                  value={
                    uploadStatus.total_pages && uploadStatus.total_pages > 0
                      ? (uploadStatus.processed_pages / uploadStatus.total_pages) * 100
                      : 5
                  }
                  className="h-1.5"
                />
                {uploadStage && (
                  <p className="text-xs text-muted-foreground">{uploadStage}</p>
                )}
                {uploadStatus.error_message && (
                  <p className="text-xs text-destructive">
                    {uploadStatus.error_message}
                  </p>
                )}
              </div>
            )}

            {uploadStep === "review" && (
              <div className="space-y-4">
                <div className="rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
                  Review the imported pages below. You can rename a page or change its trade right here before closing.
                </div>
                <div className="max-h-[420px] overflow-auto rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Page</TableHead>
                        <TableHead>Trade</TableHead>
                        <TableHead className="w-[80px]" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {uploadedReviewSheets.length === 0 ? (
                        <TableRow>
                          <TableCell
                            colSpan={3}
                            className="py-8 text-center text-sm text-muted-foreground"
                          >
                            No imported pages were found for review.
                          </TableCell>
                        </TableRow>
                      ) : (
                        uploadedReviewSheets.map((sheet) => (
                          <TableRow key={sheet.id}>
                            <TableCell className="whitespace-normal break-words">
                              <div className="flex flex-col">
                                <span className="font-medium">
                                  {sheet.sheet_number}
                                </span>
                                {sheet.sheet_title ? (
                                  <span className="text-xs text-muted-foreground">
                                    {sheet.sheet_title}
                                  </span>
                                ) : null}
                              </div>
                            </TableCell>
                            <TableCell>
                              <Select
                                value={sheet.discipline ?? "X"}
                                onValueChange={(value) => {
                                  const nextDiscipline = value as DrawingDiscipline
                                  setUploadedReviewSheets((prev) =>
                                    prev.map((candidate) =>
                                      candidate.id === sheet.id
                                        ? { ...candidate, discipline: nextDiscipline }
                                        : candidate,
                                    ),
                                  )
                                  void handleDisciplineChange(sheet.id, nextDiscipline)
                                }}
                              >
                                <SelectTrigger className="h-8 w-[180px]">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {DISCIPLINE_ORDER.map((code) => (
                                    <SelectItem key={code} value={code}>
                                      {disciplineLabel(code)}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </TableCell>
                            <TableCell className="text-right">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  const liveSheet =
                                    activeSheets.find((candidate) => candidate.id === sheet.id) ??
                                    (({
                                      ...sheet,
                                      org_id: "",
                                      project_id: selectedProjectId ?? "",
                                      share_with_clients: false,
                                      share_with_subs: false,
                                      created_at: sheet.updated_at,
                                    } as unknown) as DrawingSheet)
                                  setSheetToRename(liveSheet)
                                  setRenameSheetNumber(sheet.sheet_number)
                                  setRenameSheetTitle(sheet.sheet_title ?? "")
                                }}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setUploadDialogOpen(false)
                setUploadFile(null)
                setUploadStatus(null)
                setUploadStep("prepare")
                setUploadedReviewSheets([])
                setUploadSetId(null)
                setUploadSourceFileId(null)
              }}
              disabled={
                isUploading ||
                (uploadStep === "processing" &&
                  (uploadStatus?.status ?? "processing") === "processing")
              }
            >
              {uploadStep === "review" ? "Close" : "Cancel"}
            </Button>
            {uploadStep === "prepare" ? (
              <Button onClick={handleUpload} disabled={isUploading}>
                {isUploading ? (
                  <>
                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                    Uploading…
                  </>
                ) : (
                  <>
                    <Upload className="mr-2 h-4 w-4" />
                    Start processing
                  </>
                )}
              </Button>
            ) : uploadStep === "review" ? (
              <Button
                onClick={() => {
                  setUploadDialogOpen(false)
                  setUploadFile(null)
                  setUploadStatus(null)
                  setUploadStep("prepare")
                  setUploadedReviewSheets([])
                  setUploadSetId(null)
                  setUploadSourceFileId(null)
                }}
              >
                Finish review
              </Button>
            ) : uploadStatus?.status === "failed" && uploadSetId ? (
              <Button
                onClick={() => {
                  void handleRetry(uploadSetId)
                }}
              >
                Retry import
              </Button>
            ) : null}
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
              onClick={handleDeleteSet}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!sheetToDelete}
        onOpenChange={(open) => !open && setSheetToDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete sheet?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes sheet{" "}
              <b>{sheetToDelete?.sheet_number}</b>
              {sheetToDelete?.sheet_title ? ` — ${sheetToDelete.sheet_title}` : ""}
              . This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteSheet}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={!!disciplineGroupToEdit}
        onOpenChange={(open) => !open && setDisciplineGroupToEdit(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit trade</DialogTitle>
            <DialogDescription>
              Update the trade for all pages currently in {disciplineGroupToEdit?.label}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="group-discipline">Trade</Label>
              <Select
                value={groupDisciplineValue}
                onValueChange={(value) =>
                  setGroupDisciplineValue(value as DrawingDiscipline)
                }
                disabled={isSavingGroup}
              >
                <SelectTrigger id="group-discipline">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DISCIPLINE_ORDER.map((code) => (
                    <SelectItem key={code} value={code}>
                      {disciplineLabel(code)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDisciplineGroupToEdit(null)}
              disabled={isSavingGroup}
            >
              Cancel
            </Button>
            <Button onClick={handleUpdateDisciplineGroup} disabled={isSavingGroup}>
              {isSavingGroup ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!disciplineGroupToDelete}
        onOpenChange={(open) => !open && setDisciplineGroupToDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete trade pages?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes all {disciplineGroupToDelete?.sheets.length ?? 0} pages in{" "}
              <b>{disciplineGroupToDelete?.label}</b>. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteDisciplineGroup}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={!!sheetToRename}
        onOpenChange={(open) => !open && setSheetToRename(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename page</DialogTitle>
            <DialogDescription>
              Update the page number and title for this drawing page.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="rename-sheet-number">Page number</Label>
              <Input
                id="rename-sheet-number"
                value={renameSheetNumber}
                onChange={(e) => setRenameSheetNumber(e.target.value)}
                disabled={isRenamingSheet}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="rename-sheet-title">Page title</Label>
              <Input
                id="rename-sheet-title"
                value={renameSheetTitle}
                onChange={(e) => setRenameSheetTitle(e.target.value)}
                disabled={isRenamingSheet}
                placeholder="Optional title"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSheetToRename(null)}
              disabled={isRenamingSheet}
            >
              Cancel
            </Button>
            <Button
              onClick={handleRenameSheet}
              disabled={isRenamingSheet || !renameSheetNumber.trim()}
            >
              {isRenamingSheet ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(revisionTargetSheet)}
        onOpenChange={(open) => !open && setRevisionTargetSheet(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Submit sheet issuance</DialogTitle>
            <DialogDescription>
              Upload a revised PDF for this sheet. It will be processed as a draft and will not replace the current sheet until published.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="rounded-lg border bg-muted/30 px-3 py-2 text-sm">
              <p className="font-medium">
                {revisionTargetSheet?.sheet_number}{" "}
                {revisionTargetSheet?.sheet_title ?? ""}
              </p>
              <p className="text-xs text-muted-foreground">
                Current versions: {knownVersionCount}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sheet-revision-label">Package label</Label>
              <Input
                id="sheet-revision-label"
                value={sheetRevisionLabel}
                onChange={(e) => setSheetRevisionLabel(e.target.value)}
                disabled={savingSheetRevision || loadingRevisionMeta}
                placeholder="e.g., ASI 03, Revision B"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="sheet-revision-type">Package type</Label>
                <Select
                  value={sheetRevisionType}
                  onValueChange={(value) => setSheetRevisionType(value as DrawingIssuanceType)}
                  disabled={savingSheetRevision || loadingRevisionMeta}
                >
                  <SelectTrigger id="sheet-revision-type" className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ISSUANCE_TYPE_ORDER.map((type) => (
                      <SelectItem key={type} value={type}>
                        {DRAWING_ISSUANCE_TYPE_LABELS[type]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sheet-revision-date">Issued date</Label>
                <Input
                  id="sheet-revision-date"
                  type="date"
                  value={sheetRevisionDate}
                  onChange={(e) => setSheetRevisionDate(e.target.value)}
                  disabled={savingSheetRevision || loadingRevisionMeta}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sheet-revision-source">Received from</Label>
              <Input
                id="sheet-revision-source"
                value={sheetRevisionSource}
                onChange={(e) => setSheetRevisionSource(e.target.value)}
                disabled={savingSheetRevision || loadingRevisionMeta}
                placeholder="Architect, owner, consultant"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sheet-revision-notes">Notes</Label>
              <Input
                id="sheet-revision-notes"
                value={sheetRevisionNotes}
                onChange={(e) => setSheetRevisionNotes(e.target.value)}
                disabled={savingSheetRevision || loadingRevisionMeta}
                placeholder="Optional notes"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sheet-revision-file">Version file</Label>
              <Input
                id="sheet-revision-file"
                type="file"
                accept=".pdf,application/pdf"
                disabled={savingSheetRevision || loadingRevisionMeta}
                onChange={(e) => setRevisionFile(e.target.files?.[0] ?? null)}
              />
            </div>
            {loadingRevisionMeta && (
              <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground flex items-center gap-2">
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                Loading revision details...
              </div>
            )}
            {knownRevisions.length > 0 && (
              <p className="text-[11px] text-muted-foreground">
                Existing packages:{" "}
                {knownRevisions.map((rev) => issuanceDisplayLabel(rev)).join(", ")}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRevisionTargetSheet(null)}
              disabled={savingSheetRevision}
            >
              Cancel
            </Button>
            <Button
              onClick={handleUploadSheetRevision}
              disabled={savingSheetRevision || loadingRevisionMeta || !revisionFile}
            >
              {savingSheetRevision ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                "Process draft"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {reviewOpen && reviewRevisionId && (
        <RevisionReviewDialog
          open={reviewOpen}
          onOpenChange={(open) => {
            setReviewOpen(open)
            if (!open) setReviewRevisionId(null)
          }}
          revisionId={reviewRevisionId}
          onPublished={handleReviewResolved}
          onDiscarded={handleReviewResolved}
        />
      )}

      {viewerOpen && viewerSheet && (
        <DrawingViewer
          sheet={viewerSheet}
          initialVersionsPanelOpen={viewerVersionsOpen}
          fileUrl={viewerUrl ?? undefined}
          markups={viewerMarkups}
          pins={viewerPins}
          highlightedPinId={viewerHighlightedPinId ?? undefined}
          onClose={() => setViewerOpen(false)}
          onSaveMarkup={handleSaveMarkup}
          onDeleteMarkup={handleDeleteMarkup}
          onCreatePin={handleCreatePin}
          onPinClick={handlePinClick}
          sheets={viewerSheets}
          onNavigateSheet={handleViewSheet}
          imageThumbnailUrl={viewerSheet.image_thumbnail_url}
          imageMediumUrl={viewerSheet.image_medium_url}
          imageFullUrl={viewerSheet.image_full_url}
          imageWidth={viewerSheet.image_width}
          imageHeight={viewerSheet.image_height}
        />
      )}

      <CreateFromDrawingDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onCreate={handleCreateFromDrawing}
        sheet={viewerSheet}
        position={createPosition || { x: 0, y: 0 }}
        projectId={viewerSheet?.project_id ?? selectedProjectId ?? ""}
      />

      {isDragActive && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 border border-dashed border-muted-foreground/40 bg-card/80 px-6 py-5">
            <Upload className="h-6 w-6 text-muted-foreground" />
            <div className="text-sm font-medium">Drop PDF to upload</div>
            <div className="text-xs text-muted-foreground">
              We&apos;ll split it into sheets automatically
            </div>
          </div>
        </div>
      )}

      {sheetsLoading && activeSheets.length === 0 && activeSet && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-center py-2 text-xs text-muted-foreground">
          Loading sheets…
        </div>
      )}
    </div>
  )
}

function DisciplineRows({
  code,
  label,
  sheets,
  isExpanded,
  onToggle,
  onEditGroup,
  onDeleteGroup,
  onViewSheet,
  onDisciplineChange,
  onRenameSheet,
  onDeleteSheet,
  onUploadRevisionSheet,
  highlight,
}: {
  code: string
  label: string
  sheets: DrawingSheet[]
  isExpanded: boolean
  onToggle: () => void
  onEditGroup: () => void
  onDeleteGroup: () => void
  onViewSheet: (sheet: DrawingSheet, highlightPinId?: string | null, openVersions?: boolean) => void
  onDisciplineChange: (sheetId: string, d: DrawingDiscipline) => void
  onRenameSheet: (sheet: DrawingSheet) => void
  onDeleteSheet: (sheet: DrawingSheet) => void
  onUploadRevisionSheet: (sheet: DrawingSheet) => void
  highlight: string
}) {
  const Icon = disciplineIcon(code)
  const latestRev = useMemo(() => {
    const versions = new Set(sheets.map(sheetVersionLabel))
    const arr = Array.from(versions)
    if (arr.length === 0) return "v1"
    if (arr.length === 1) return arr[0]
    return `${arr.length} versions`
  }, [sheets])

  const lastModified = useMemo(() => {
    let max = 0
    for (const s of sheets) {
      const t = new Date(s.updated_at).getTime()
      if (t > max) max = t
    }
    return max > 0 ? new Date(max).toISOString() : null
  }, [sheets])

  return (
    <>
      <TableRow
        className={cn(
          "group cursor-pointer border-t bg-background hover:bg-muted/30",
          isExpanded && "bg-muted/20",
        )}
        onClick={onToggle}
      >
        <TableCell className="w-10 pl-4">
          <ChevronRight
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform",
              isExpanded && "rotate-90",
            )}
          />
        </TableCell>
        <TableCell className="min-w-0">
          <div className="flex items-center gap-3 min-w-0">
            <span
              className={cn(
                "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border",
                disciplineGradientClass(code),
              )}
            >
              <Icon className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{label}</div>
              {/* The Pages column is hidden on mobile — surface the count here instead. */}
              <div className="text-xs text-muted-foreground sm:hidden">
                {sheets.length} {sheets.length === 1 ? "sheet" : "sheets"}
              </div>
            </div>
          </div>
        </TableCell>
        <TableCell className="hidden sm:table-cell text-center text-xs text-muted-foreground">
          {sheets.length}
        </TableCell>
        <TableCell className="hidden md:table-cell text-center text-xs text-muted-foreground">
          {latestRev}
        </TableCell>
        <TableCell className="hidden md:table-cell text-center text-xs text-muted-foreground">
          —
        </TableCell>
        <TableCell className="hidden lg:table-cell text-center text-xs text-muted-foreground">
          {formatDate(lastModified)}
        </TableCell>
        <TableCell className="pr-4" onClick={(e) => e.stopPropagation()}>
          <div className="flex justify-end">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 md:opacity-0 transition-opacity md:group-hover:opacity-100 data-[state=open]:opacity-100"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onClick={onEditGroup}>
                  <Pencil className="mr-2 h-4 w-4" />
                  Edit trade
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={onDeleteGroup}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete pages
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </TableCell>
      </TableRow>

      {isExpanded &&
        sheets.map((sheet) => (
          <SheetRow
            key={sheet.id}
            sheet={sheet}
            onOpen={() => onViewSheet(sheet)}
            onDisciplineChange={(d) => onDisciplineChange(sheet.id, d)}
            onRename={() => onRenameSheet(sheet)}
            onViewVersions={() => onViewSheet(sheet, null, true)}
            onDelete={() => onDeleteSheet(sheet)}
            onUploadRevision={() => onUploadRevisionSheet(sheet)}
            highlight={highlight}
          />
        ))}
    </>
  )
}

function SheetRow({
  sheet,
  onOpen,
  onDisciplineChange,
  onRename,
  onViewVersions,
  onDelete,
  onUploadRevision,
  highlight,
}: {
  sheet: DrawingSheet
  onOpen: () => void
  onDisciplineChange: (d: DrawingDiscipline) => void
  onRename: () => void
  onViewVersions: () => void
  onDelete: () => void
  onUploadRevision: () => void
  highlight: string
}) {
  const currentDiscipline = (sheet.discipline as DrawingDiscipline) ?? "X"
  const title = [sheet.sheet_number, sheet.sheet_title].filter(Boolean).join(" · ")
  return (
    <TableRow
      className="group cursor-pointer border-t border-border/40 hover:bg-muted/20"
      onClick={onOpen}
    >
      <TableCell className="w-10 pl-4">
        {/* indent marker */}
        <span className="ml-2 inline-block h-1 w-1 rounded-full bg-border" />
      </TableCell>
      <TableCell className="min-w-0 pl-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">
            <Highlighted
              text={title || sheet.sheet_number || "Untitled sheet"}
              highlight={highlight}
            />
          </div>
        </div>
      </TableCell>
      <TableCell className="hidden sm:table-cell" />
      <TableCell className="hidden md:table-cell text-center text-xs text-muted-foreground">
        {sheetVersionLabel(sheet)}
      </TableCell>
      <TableCell className="hidden md:table-cell text-center text-xs text-muted-foreground">
        {sheet.last_modified_by_name ?? sheet.current_revision_creator_name ?? "—"}
      </TableCell>
      <TableCell className="hidden lg:table-cell text-center text-xs text-muted-foreground">
        {formatDate(sheet.updated_at)}
      </TableCell>
      <TableCell className="pr-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 md:opacity-0 transition-opacity md:group-hover:opacity-100 data-[state=open]:opacity-100"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
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
              <DropdownMenuItem
                onClick={async () => {
                  const url = await getSheetDownloadUrlAction(sheet.id).catch(
                    () => null,
                  )
                  if (url) window.open(url, "_blank")
                  else toast.error("Download not available")
                }}
              >
                <Download className="mr-2 h-4 w-4" />
                Download
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
                Change discipline
              </DropdownMenuLabel>
              {DISCIPLINE_ORDER.map((dcode) => (
                <DropdownMenuItem
                  key={dcode}
                  onClick={() => {
                    if (dcode !== currentDiscipline) onDisciplineChange(dcode)
                  }}
                  className={cn(
                    "gap-2",
                    dcode === currentDiscipline && "bg-muted font-medium",
                  )}
                >
                  <span
                    className={cn(
                      "inline-flex h-5 w-8 items-center justify-center rounded border font-mono text-[11px]",
                      disciplineGradientClass(dcode),
                    )}
                  >
                    {dcode}
                  </span>
                  <span>{disciplineLabel(dcode)}</span>
                </DropdownMenuItem>
              ))}
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
        </div>
      </TableCell>
    </TableRow>
  )
}

function Highlighted({
  text,
  highlight,
}: {
  text?: string | null
  highlight: string
}) {
  if (!text) return null
  if (!highlight) return <>{text}</>
  const idx = text.toLowerCase().indexOf(highlight)
  if (idx === -1) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded-sm bg-yellow-200/70 px-0.5 text-foreground dark:bg-yellow-500/30">
        {text.slice(idx, idx + highlight.length)}
      </mark>
      {text.slice(idx + highlight.length)}
    </>
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
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-md border bg-muted/40">
        <Icon className="h-5 w-5 text-muted-foreground" />
      </div>
      <h2 className="mb-1 text-base font-semibold">{title}</h2>
      <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
