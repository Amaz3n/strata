"use client"

import { useState, useEffect, useCallback, useRef, useMemo } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import {
  Upload,
  FileText,
  Search,
  LayoutGrid,
  List,
  RefreshCw,
  MoreHorizontal,
  Trash2,
  X,
  Share2,
  ChevronLeft,
  ChevronDown,
  Check,
  Users,
  Building2,
  Layers,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { DISCIPLINE_LABELS, DRAWING_SET_TYPE_LABELS } from "@/lib/validation/drawings"
import { uploadDrawingFileToStorage } from "@/lib/services/drawings-client"
import {
  getSheetVersionsForImageGeneration,
  updateSheetVersionImages,
} from "@/app/(app)/drawings/image-gen-actions"
import type {
  DrawingSet,
  DrawingSheet,
  DrawingDiscipline,
  DrawingMarkup,
  DrawingPin,
  SheetStatusCounts,
  DrawingRevision,
} from "@/app/(app)/drawings/actions"
import {
  listDrawingSetsAction,
  listDrawingSheetsWithUrlsAction,
  createDrawingSetFromUpload,
  deleteDrawingSetAction,
  getProcessingStatusAction,
  getDisciplineCountsAction,
  bulkUpdateSheetSharingAction,
  getSheetDownloadUrlAction,
  getSheetOptimizedImageUrlsAction,
  retryProcessingAction,
  listDrawingRevisionsAction,
  listDrawingMarkupsAction,
  listDrawingPinsWithEntitiesAction,
  createDrawingMarkupAction,
  deleteDrawingMarkupAction,
  createDrawingPinAction,
  createTaskFromDrawingAction,
  createRfiFromDrawingAction,
  createPunchItemFromDrawingAction,
  getSheetStatusCountsAction,
} from "@/app/(app)/drawings/actions"
import { DrawingViewer } from "./drawing-viewer"
import { CreateFromDrawingDialog } from "./index"
import { SheetStatusDots } from "./sheet-status-dots"
import { KeyboardShortcutsHelp } from "./keyboard-shortcuts-help"
import { useDrawingKeyboardShortcuts } from "./use-drawing-keyboard-shortcuts"
import { RecentSheetsSection, useRecentSheets } from "./recent-sheets-section"
import { SheetCard } from "./sheet-card"
import { DrawingsEmptyState } from "./drawings-empty-state"

type ViewMode = "grid" | "list"
type TabMode = "sets" | "sheets"

interface DrawingsClientProps {
  initialSets: DrawingSet[]
  initialSheets: DrawingSheet[]
  initialDisciplineCounts: Record<string, number>
  initialRevisions?: DrawingRevision[]
  projects: Array<{ id: string; name: string }>
  defaultProjectId?: string
  lockProject?: boolean
  initialTabMode?: TabMode
  initialSelectedSetId?: string
  lockSet?: boolean
  hideTabs?: boolean
}

// Discipline config for filter chips
const DISCIPLINE_CONFIG: { value: DrawingDiscipline; label: string; color: string }[] = [
  { value: "A", label: "Arch", color: "bg-blue-500/10 text-blue-600 hover:bg-blue-500/20" },
  { value: "S", label: "Struct", color: "bg-orange-500/10 text-orange-600 hover:bg-orange-500/20" },
  { value: "M", label: "Mech", color: "bg-green-500/10 text-green-600 hover:bg-green-500/20" },
  { value: "E", label: "Elec", color: "bg-yellow-500/10 text-yellow-700 hover:bg-yellow-500/20" },
  { value: "P", label: "Plumb", color: "bg-purple-500/10 text-purple-600 hover:bg-purple-500/20" },
]

const DRAWING_SET_TYPES = Object.entries(DRAWING_SET_TYPE_LABELS).map(([value, label]) => ({
  value,
  label,
}))

export function DrawingsClient({
  initialSets,
  initialSheets,
  initialDisciplineCounts,
  initialRevisions = [],
  projects,
  defaultProjectId,
  lockProject = false,
  initialTabMode,
  initialSelectedSetId,
  lockSet = false,
  hideTabs = false,
}: DrawingsClientProps) {
  const USE_TILED_VIEWER = process.env.NEXT_PUBLIC_FEATURE_TILED_VIEWER === "true"
  const ENABLE_CLIENT_IMAGE_GEN = process.env.NEXT_PUBLIC_FEATURE_DRAWINGS_CLIENT_IMAGE_GEN === "true"
  const ENABLE_TILES_AUTH = process.env.NEXT_PUBLIC_DRAWINGS_TILES_SECURE === "true"
  const router = useRouter()
  const searchParams = useSearchParams()

  // Data state
  const [sets, setSets] = useState<DrawingSet[]>(initialSets)
  const [sheets, setSheets] = useState<DrawingSheet[]>(initialSheets)
  const [disciplineCounts, setDisciplineCounts] = useState(initialDisciplineCounts)
  const [revisions, setRevisions] = useState<DrawingRevision[]>(initialRevisions)

  // Filter state
  const [selectedProject, setSelectedProject] = useState<string | undefined>(defaultProjectId)
  const [selectedDiscipline, setSelectedDiscipline] = useState<DrawingDiscipline | "all">("all")
  const [selectedSet, setSelectedSet] = useState<string | undefined>(initialSelectedSetId)
  const [selectedRevision, setSelectedRevision] = useState<string>("all")
  const [searchQuery, setSearchQuery] = useState("")
  const [tabMode, setTabMode] = useState<TabMode>(initialTabMode ?? "sets")

  // View state
  const [viewMode, setViewMode] = useState<ViewMode>("grid")
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Upload state
  const [isUploading, setIsUploading] = useState(false)
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false)
  const [uploadTitle, setUploadTitle] = useState("")
  const [uploadSetType, setUploadSetType] = useState<string>("general")
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [isDragActive, setIsDragActive] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<{
    stage: string
    current: number
    total: number
  } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragCounterRef = useRef(0)

  // Viewer state
  const [viewerOpen, setViewerOpen] = useState(false)
  const [viewerSheet, setViewerSheet] = useState<DrawingSheet | null>(null)
  const tilesCookieRequestedRef = useRef(false)
  const [viewerUrl, setViewerUrl] = useState<string | null>(null)
  const [viewerMarkups, setViewerMarkups] = useState<DrawingMarkup[]>([])
  const [viewerPins, setViewerPins] = useState<DrawingPin[]>([])
  const [viewerHighlightedPinId, setViewerHighlightedPinId] = useState<string | null>(null)

  // Create from drawing dialog
  const [createFromDrawingOpen, setCreateFromDrawingOpen] = useState(false)
  const [createFromDrawingPosition, setCreateFromDrawingPosition] = useState<{ x: number; y: number } | null>(null)

  // Status counts for sheet cards
  const [statusCounts, setStatusCounts] = useState<Record<string, SheetStatusCounts>>({})

  // Keyboard navigation
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Delete confirmation
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [setToDelete, setSetToDelete] = useState<DrawingSet | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  // Loading state
  const [isLoading, setIsLoading] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const sheetOpenRequestIdRef = useRef(0)

  // Recent sheets tracking (per-project)
  const { recentIds, trackView } = useRecentSheets(selectedProject)

  // Polling for processing sets
  const processingSetIds = useMemo(
    () => sets.filter((s) => s.status === "processing").map((s) => s.id),
    [sets]
  )

  // Fetch data
  const fetchSets = useCallback(async () => {
    try {
      const data = await listDrawingSetsAction({
        project_id: selectedProject,
        search: searchQuery || undefined,
      })
      setSets(data)
    } catch (error) {
      console.error("Failed to fetch drawing sets:", error)
    }
  }, [selectedProject, searchQuery])

  const fetchSheets = useCallback(async () => {
    if (!lockSet && tabMode !== "sheets") {
      setSheets([])
      setDisciplineCounts({})
      return
    }

    if (!selectedProject) {
      setSheets([])
      setDisciplineCounts({})
      return
    }

    try {
      const [sheetsData, countsData] = await Promise.all([
        listDrawingSheetsWithUrlsAction({
          project_id: selectedProject,
          discipline: selectedDiscipline === "all" ? undefined : selectedDiscipline,
          search: searchQuery || undefined,
          drawing_set_id: selectedSet,
          revision_id: selectedRevision === "all" ? undefined : selectedRevision,
        }),
        getDisciplineCountsAction(selectedProject),
      ])
      const derivedCounts = selectedSet
        || selectedRevision !== "all"
        ? sheetsData.reduce<Record<string, number>>(
            (acc, sheet) => {
              const disc = sheet.discipline ?? "X"
              acc.all = (acc.all ?? 0) + 1
              acc[disc] = (acc[disc] ?? 0) + 1
              return acc
            },
            { all: 0 }
          )
        : countsData
      setSheets(sheetsData)
      setDisciplineCounts(derivedCounts)

      if (USE_TILED_VIEWER) {
        const derived: Record<string, SheetStatusCounts> = {}
        for (const s of sheetsData as any[]) {
          const byType = (s.pins_by_type ?? {}) as Record<string, number>
          const byStatus = (s.pins_by_status ?? {}) as Record<string, number>
          derived[s.id] = {
            open: Number(s.open_pins_count ?? 0),
            inProgress: Number(s.in_progress_pins_count ?? 0),
            completed: Number(s.completed_pins_count ?? 0),
            total: Number(s.total_pins_count ?? 0),
            byType,
            byStatus,
          }
        }
        setStatusCounts(derived)
      }
    } catch (error) {
      console.error("Failed to fetch sheets:", error)
    }
  }, [
    selectedProject,
    selectedDiscipline,
    searchQuery,
    selectedSet,
    selectedRevision,
    USE_TILED_VIEWER,
    lockSet,
    tabMode,
  ])

  useEffect(() => {
    if (!ENABLE_TILES_AUTH || tilesCookieRequestedRef.current) return
    tilesCookieRequestedRef.current = true

    fetch("/api/drawings/tiles-cookie", {
      method: "POST",
      credentials: "include",
    }).catch((error) => {
      console.warn("[drawings] Failed to set tiles cookie:", error)
    })
  }, [ENABLE_TILES_AUTH])

  useEffect(() => {
    if (processingSetIds.length === 0) return

    const interval = setInterval(async () => {
      for (const setId of processingSetIds) {
        try {
          const status = await getProcessingStatusAction(setId)
          setSets((prev) =>
            prev.map((s) =>
              s.id === setId
                ? { ...s, status: status.status as any, processed_pages: status.processed_pages, total_pages: status.total_pages, error_message: status.error_message }
                : s
            )
          )

          if (status.status === "ready") {
            await fetchSheets()
          }
        } catch (e) {
          console.error("Failed to poll status:", e)
        }
      }
    }, 3000)

    return () => clearInterval(interval)
  }, [processingSetIds, fetchSheets])

  const fetchRevisions = useCallback(async () => {
    if (!selectedSet) {
      setRevisions([])
      return
    }

    try {
      const data = await listDrawingRevisionsAction({
        project_id: selectedProject,
        drawing_set_id: selectedSet,
        limit: 50,
      })
      setRevisions(data)
    } catch (error) {
      console.error("Failed to fetch drawing revisions:", error)
    }
  }, [selectedProject, selectedSet])

  const fetchData = useCallback(async () => {
    const shouldShowSkeleton = sets.length === 0 && sheets.length === 0
    if (shouldShowSkeleton) setIsLoading(true)
    else setIsRefreshing(true)
    try {
      await Promise.all([fetchSets(), fetchSheets()])
    } finally {
      setIsLoading(false)
      setIsRefreshing(false)
    }
  }, [fetchSets, fetchSheets, sets.length, sheets.length])

  useEffect(() => {
    if (!selectedSet) return
    if (!sets.some((set) => set.id === selectedSet)) {
      setSelectedSet(undefined)
    }
  }, [sets, selectedSet])

  useEffect(() => {
    if (!selectedSet || !lockSet) return
    if (initialRevisions.length > 0) return
    fetchRevisions()
  }, [selectedSet, lockSet, fetchRevisions, initialRevisions.length])

  useEffect(() => {
    setSelectedRevision("all")
  }, [selectedSet])

  // Debounce search
  useEffect(() => {
    const timeout = setTimeout(() => {
      fetchData()
    }, 300)
    return () => clearTimeout(timeout)
  }, [fetchData])

  // Fetch status counts when sheets change (legacy path only)
  useEffect(() => {
    if (USE_TILED_VIEWER) return
    async function loadStatusCounts() {
      if (sheets.length === 0) {
        setStatusCounts({})
        return
      }
      try {
        const sheetIds = sheets.map((s) => s.id)
        const counts = await getSheetStatusCountsAction(sheetIds)
        setStatusCounts(counts)
      } catch (error) {
        console.error("Failed to load status counts:", error)
      }
    }
    loadStatusCounts()
  }, [sheets, USE_TILED_VIEWER])

  // Reset selected index when sheets change
  useEffect(() => {
    setSelectedIndex(0)
  }, [sheets.length])

  // Keyboard shortcuts
  useDrawingKeyboardShortcuts({
    enabled: !viewerOpen && tabMode === "sheets",
    context: "list",
    handlers: {
      onNextSheet: () => setSelectedIndex((i) => Math.min(i + 1, sheets.length - 1)),
      onPreviousSheet: () => setSelectedIndex((i) => Math.max(i - 1, 0)),
      onOpenSheet: () => {
        const sheet = sheets[selectedIndex]
        if (sheet) handleViewSheet(sheet)
      },
      onSearch: () => searchInputRef.current?.focus(),
      onEscape: () => {
        setSearchQuery("")
        searchInputRef.current?.blur()
      },
      onFilterDiscipline: (discipline) => {
        setSelectedDiscipline(discipline === null ? "all" : (discipline as DrawingDiscipline))
      },
      onToggleView: () => setViewMode((v) => (v === "grid" ? "list" : "grid")),
      onShowHelp: () => setShowShortcutsHelp(true),
    },
  })

  // Handle project change
  const handleProjectChange = (projectId: string) => {
    if (lockProject) return
    const newProject = projectId === "all" ? undefined : projectId
    setSelectedProject(newProject)
    setSelectedSet(undefined)
    setSelectedIds(new Set())

    if (newProject) {
      router.push(`/drawings?project=${newProject}`)
    } else {
      router.push("/drawings")
    }
  }

  // Handle file selection for upload
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (file.type !== "application/pdf") {
      toast.error("Only PDF files are supported")
      return
    }

    setUploadFile(file)
    setUploadTitle(file.name.replace(/\.pdf$/i, ""))
    setUploadDialogOpen(true)
  }

  const handleDroppedFile = (file: File) => {
    if (!selectedProject) {
      toast.error("Select a project to upload a plan set")
      return
    }

    if (file.type !== "application/pdf") {
      toast.error("Only PDF files are supported")
      return
    }

    setUploadFile(file)
    setUploadTitle(file.name.replace(/\.pdf$/i, ""))
    setUploadDialogOpen(true)
  }

  const isPdfDrag = (event: React.DragEvent) =>
    Array.from(event.dataTransfer.items).some(
      (item) => item.kind === "file" && item.type === "application/pdf"
    )

  useEffect(() => {
    const handleDragEnter = (event: DragEvent) => {
      if (!event.dataTransfer) return
      const hasPdf = Array.from(event.dataTransfer.items).some(
        (item) => item.kind === "file" && item.type === "application/pdf"
      )
      if (!hasPdf) return
      dragCounterRef.current += 1
      setIsDragActive(true)
    }

    const handleDragOver = (event: DragEvent) => {
      if (!event.dataTransfer) return
      const hasPdf = Array.from(event.dataTransfer.items).some(
        (item) => item.kind === "file" && item.type === "application/pdf"
      )
      if (!hasPdf) return
      event.preventDefault()
      setIsDragActive(true)
    }

    const handleDragLeave = () => {
      dragCounterRef.current -= 1
      if (dragCounterRef.current <= 0) {
        dragCounterRef.current = 0
        setIsDragActive(false)
      }
    }

    const handleDrop = () => {
      dragCounterRef.current = 0
      setIsDragActive(false)
    }

    window.addEventListener("dragenter", handleDragEnter)
    window.addEventListener("dragover", handleDragOver)
    window.addEventListener("dragleave", handleDragLeave)
    window.addEventListener("drop", handleDrop)

    return () => {
      window.removeEventListener("dragenter", handleDragEnter)
      window.removeEventListener("dragover", handleDragOver)
      window.removeEventListener("dragleave", handleDragLeave)
      window.removeEventListener("drop", handleDrop)
    }
  }, [])

  // Handle upload
  const handleUpload = async () => {
    if (!uploadFile || !selectedProject) return

    setIsUploading(true)
    setUploadProgress({ stage: "Uploading PDF...", current: 0, total: 1 })

    try {
      const orgId = document.cookie.match(/(?:^|; )org_id=([^;]+)/)?.[1]
      if (!orgId) {
        throw new Error("Organization not found. Please refresh the page.")
      }

      const { storagePath } = await uploadDrawingFileToStorage(
        uploadFile,
        selectedProject,
        orgId
      )

      setUploadProgress({ stage: "Processing PDF...", current: 0, total: 1 })
      const newSet = await createDrawingSetFromUpload({
        projectId: selectedProject,
        title: uploadTitle,
      setType: uploadSetType,
        fileName: uploadFile.name,
        storagePath,
        fileSize: uploadFile.size,
        mimeType: uploadFile.type,
      })

      setSets((prev) => [newSet, ...prev])

      if (USE_TILED_VIEWER) {
        setUploadDialogOpen(false)
        setUploadFile(null)
        setUploadTitle("")
        setUploadSetType("general")
        setUploadProgress(null)
        toast.success("Plan set uploaded. Processing sheets in the background.")
        await fetchSheets()
        return
      }

      if (!ENABLE_CLIENT_IMAGE_GEN) {
        toast.success("Plan set uploaded. Sheets are processing in the background.")
        setUploadDialogOpen(false)
        setUploadFile(null)
        setUploadTitle("")
        setUploadProgress(null)
        await fetchSheets()
        return
      }

      setUploadProgress({ stage: "Waiting for processing...", current: 0, total: 1 })
      let attempts = 0
      let sheetVersions: Array<{ id: string; pageIndex: number }> = []

      while (attempts < 30 && sheetVersions.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        attempts++

        try {
          sheetVersions = await getSheetVersionsForImageGeneration(newSet.id)
        } catch (e) {
          // Keep waiting
        }
      }

      if (sheetVersions.length === 0) {
        toast.warning("PDF processed, but image generation will be skipped.")
        setUploadDialogOpen(false)
        setUploadFile(null)
        setUploadTitle("")
        setUploadSetType("general")
        setUploadProgress(null)
        return
      }

      setUploadProgress({ stage: "Generating optimized images...", current: 0, total: sheetVersions.length })
      toast.info(`Generating optimized images for ${sheetVersions.length} sheets...`)

      const { generateImagesForAllPages } = await import("@/lib/services/drawings-image-gen")
      const imageResults = await generateImagesForAllPages(
        uploadFile,
        orgId,
        selectedProject,
        newSet.id,
        sheetVersions,
        (current, total, stage) => {
          setUploadProgress({ stage, current, total })
        }
      )

      setUploadProgress({ stage: "Saving images...", current: 0, total: imageResults.size })
      let saved = 0
      for (const [versionId, images] of imageResults) {
        try {
          await updateSheetVersionImages(versionId, images)
          saved++
          setUploadProgress({ stage: "Saving images...", current: saved, total: imageResults.size })
        } catch (e) {
          console.error("Failed to save image URLs:", e)
        }
      }

      setUploadDialogOpen(false)
      setUploadFile(null)
      setUploadTitle("")
      setUploadSetType("general")
      setUploadProgress(null)
      toast.success(`Plan set uploaded with optimized images! (${saved}/${sheetVersions.length} sheets)`)

      await fetchSheets()
    } catch (error) {
      console.error("Upload failed:", error)
      toast.error(error instanceof Error ? error.message : "Failed to upload plan set")
      setUploadProgress(null)
    } finally {
      setIsUploading(false)
    }
  }

  // Handle sheet view
  const handleViewSheet = useCallback(async (sheet: DrawingSheet, highlightPinId?: string | null) => {
    const requestId = ++sheetOpenRequestIdRef.current

    trackView(sheet.id)
    setViewerSheet(sheet)
    setViewerHighlightedPinId(highlightPinId ?? null)
    setViewerUrl(null)
    setViewerMarkups([])
    setViewerPins([])
    setViewerOpen(true)

    try {
      const hasTiles = !!(sheet as any).tile_base_url && !!(sheet as any).tile_manifest
      const hasOptimizedImages =
        !!sheet.image_full_url && !!sheet.image_medium_url && !!sheet.image_thumbnail_url

      const [signedImages, url, markups, pins] = await Promise.all([
        hasOptimizedImages && !hasTiles
          ? getSheetOptimizedImageUrlsAction(sheet.id).catch((e) => {
              console.error("Failed to get signed optimized images:", e)
              return null
            })
          : Promise.resolve(null),
        getSheetDownloadUrlAction(sheet.id).catch((e) => {
          console.error("Failed to get sheet URL:", e)
          return null
        }),
        listDrawingMarkupsAction({ drawing_sheet_id: sheet.id }).catch((e) => {
          console.error("Failed to load markups:", e)
          return []
        }),
        listDrawingPinsWithEntitiesAction(sheet.id).catch((e) => {
          console.error("Failed to load pins:", e)
          return []
        }),
      ])

      if (sheetOpenRequestIdRef.current !== requestId) return

      if (signedImages && !hasTiles) {
        setViewerSheet((prev) => {
          if (!prev || prev.id !== sheet.id) return prev
          return {
            ...prev,
            image_thumbnail_url: signedImages.thumbnailUrl ?? prev.image_thumbnail_url ?? null,
            image_medium_url: signedImages.mediumUrl ?? prev.image_medium_url ?? null,
            image_full_url: signedImages.fullUrl ?? prev.image_full_url ?? null,
            image_width: signedImages.width ?? prev.image_width ?? null,
            image_height: signedImages.height ?? prev.image_height ?? null,
          }
        })
      }

      if (!hasOptimizedImages && !hasTiles && !url) {
        toast.error("Sheet file not available")
        setViewerOpen(false)
        return
      }

      setViewerUrl(url)
      setViewerMarkups(markups)
      setViewerPins(pins)
    } catch (error) {
      console.error("Failed to open sheet:", error)
      if (sheetOpenRequestIdRef.current === requestId) {
        toast.error("Failed to load sheet")
      }
    }
  }, [trackView])

  useEffect(() => {
    const sheetId = searchParams?.get("sheetId")
    if (!sheetId) return

    const sheet = sheets.find((s) => s.id === sheetId)
    if (!sheet) return

    const pinId = searchParams?.get("pinId")
    handleViewSheet(sheet, pinId)
  }, [searchParams, sheets, handleViewSheet])

  // Handle markup actions
  const handleSaveMarkup = async (markup: Omit<DrawingMarkup, "id" | "org_id" | "created_at" | "updated_at">) => {
    try {
      const newMarkup = await createDrawingMarkupAction(markup)
      setViewerMarkups(prev => [...prev, newMarkup])
      toast.success("Markup saved")
    } catch (error) {
      console.error("Failed to save markup:", error)
      toast.error("Failed to save markup")
    }
  }

  const handleDeleteMarkup = async (markupId: string) => {
    try {
      await deleteDrawingMarkupAction(markupId)
      setViewerMarkups(prev => prev.filter(m => m.id !== markupId))
      toast.success("Markup deleted")
    } catch (error) {
      console.error("Failed to delete markup:", error)
      toast.error("Failed to delete markup")
    }
  }

  const handleCreatePin = (x: number, y: number) => {
    setCreateFromDrawingPosition({ x, y })
    setCreateFromDrawingOpen(true)
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

  // Handle create from drawing
  const handleCreateFromDrawing = async (input: any) => {
    if (!viewerSheet || !createFromDrawingPosition) return

    try {
      const projectId = input.project_id ?? selectedProject
      if (!projectId) {
        throw new Error("Missing project")
      }

      let entityId: string | null = null
      if (input.entityType === "task") {
        const created = await createTaskFromDrawingAction(projectId, {
          title: input.title,
          description: input.description,
          priority: input.priority === "high" ? "high" : input.priority === "low" ? "low" : "normal",
          status: "todo",
        })
        entityId = created.id
      } else if (input.entityType === "rfi") {
        const created = await createRfiFromDrawingAction({
          projectId,
          subject: input.subject ?? input.title,
          question: input.question ?? input.description ?? "",
          priority: input.priority,
        })
        entityId = created.id
      } else if (input.entityType === "punch_list") {
        const created = await createPunchItemFromDrawingAction({
          projectId,
          title: input.title,
          description: input.description,
          location: input.location,
          severity: input.priority,
        })
        entityId = created.id
      } else if (input.entityType === "issue") {
        const created = await createTaskFromDrawingAction(projectId, {
          title: input.title,
          description: input.description,
          priority: "high",
          status: "todo",
          tags: ["issue"],
        })
        entityId = created.id
      }

      if (!entityId) {
        throw new Error("Unsupported entity type")
      }

      const pin = await createDrawingPinAction({
        project_id: projectId,
        drawing_sheet_id: viewerSheet.id,
        x_position: createFromDrawingPosition.x,
        y_position: createFromDrawingPosition.y,
        entity_type: input.entityType,
        entity_id: entityId,
        label: input.title,
        status: "open",
      })

      setViewerPins(prev => [...prev, pin])
      setCreateFromDrawingOpen(false)
      setCreateFromDrawingPosition(null)
      setViewerHighlightedPinId(pin.id)
      toast.success("Entity created and pinned to drawing")
    } catch (error) {
      console.error("Failed to create entity:", error)
      toast.error("Failed to create entity")
    }
  }

  // Handle delete set
  const handleDeleteSet = async () => {
    if (!setToDelete) return

    setIsDeleting(true)
    try {
      await deleteDrawingSetAction(setToDelete.id)
      setSets((prev) => prev.filter((s) => s.id !== setToDelete.id))
      await fetchSheets()
      toast.success("Drawing set deleted")
    } catch (error) {
      toast.error("Failed to delete drawing set")
    } finally {
      setIsDeleting(false)
      setDeleteDialogOpen(false)
      setSetToDelete(null)
    }
  }

  // Handle retry processing
  const handleRetry = async (setId: string) => {
    try {
      await retryProcessingAction(setId)
      toast.success("Processing restarted")
      await fetchSets()
    } catch (error) {
      toast.error("Failed to restart processing")
    }
  }

  // Handle bulk share
  const handleBulkShare = async (shareWith: "clients" | "subs") => {
    if (selectedIds.size === 0) return

    try {
      await bulkUpdateSheetSharingAction(
        Array.from(selectedIds),
        shareWith === "clients"
          ? { share_with_clients: true }
          : { share_with_subs: true }
      )
      toast.success(`${selectedIds.size} sheets shared`)
      setSelectedIds(new Set())
      await fetchSheets()
    } catch (error) {
      toast.error("Failed to update sharing")
    }
  }

  // Toggle sheet selection
  const toggleSheetSelection = (sheetId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(sheetId)) {
        next.delete(sheetId)
      } else {
        next.add(sheetId)
      }
      return next
    })
  }

  // Clear selection
  const clearSelection = () => {
    setSelectedIds(new Set())
  }

  // Check if any filters are active
  const hasActiveFilters =
    searchQuery ||
    selectedDiscipline !== "all" ||
    (selectedSet && !lockSet) ||
    selectedRevision !== "all"

  // Get available disciplines from counts
  const availableDisciplines = DISCIPLINE_CONFIG.filter(
    (d) => (disciplineCounts[d.value] ?? 0) > 0
  )

  const resolveSetStatus = (status?: string | null) => {
    switch (status) {
      case "processing":
        return { label: "Processing", className: "bg-blue-500/10 text-blue-600 border-blue-500/30" }
      case "ready":
        return { label: "Ready", className: "bg-success/10 text-success border-success/30" }
      case "failed":
        return { label: "Failed", className: "bg-destructive/10 text-destructive border-destructive/30" }
      default:
        return { label: "Pending", className: "bg-muted text-muted-foreground border-muted" }
    }
  }

  const formatDate = (value?: string | null) => {
    if (!value) return "—"
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(
      new Date(value)
    )
  }

  const resolveSetTypeLabel = (value?: string | null) => {
    if (!value) return "—"
    return DRAWING_SET_TYPE_LABELS[value as keyof typeof DRAWING_SET_TYPE_LABELS] ?? value
  }

  const formatRevisionLabel = (revision?: DrawingRevision | null) => {
    if (!revision) return "Unknown"
    if (revision.issued_date) {
      const issued = formatDate(revision.issued_date)
      return `${revision.revision_label} · ${issued}`
    }
    return revision.revision_label
  }

  const projectId = selectedProject ?? defaultProjectId ?? projects[0]?.id

  return (
    <div
      className="relative flex flex-col h-full"
      onDragEnter={(event) => {
        event.preventDefault()
        event.stopPropagation()
        if (!isPdfDrag(event)) return
        dragCounterRef.current += 1
        setIsDragActive(true)
      }}
      onDragOver={(event) => {
        event.preventDefault()
        event.stopPropagation()
        if (!isPdfDrag(event)) return
        setIsDragActive(true)
      }}
      onDragLeave={(event) => {
        event.preventDefault()
        event.stopPropagation()
        dragCounterRef.current -= 1
        if (dragCounterRef.current <= 0) {
          dragCounterRef.current = 0
          setIsDragActive(false)
        }
      }}
      onDrop={(event) => {
        event.preventDefault()
        event.stopPropagation()
        dragCounterRef.current = 0
        setIsDragActive(false)

        const file = event.dataTransfer.files?.[0]
        if (!file) return
        handleDroppedFile(file)
      }}
    >
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf"
        className="hidden"
        onChange={handleFileSelect}
      />

      {/* Header */}
      <div className="shrink-0 bg-background">
        {/* Primary toolbar */}
        <div className="flex flex-col gap-2 sm:gap-3 px-2 py-2 sm:p-3 lg:p-4">
          {/* Top row: project selector, search, upload */}
          <div className="flex items-center gap-2 sm:gap-3">
            {/* Project selector */}
            {!lockProject && (
              <Select value={selectedProject ?? "all"} onValueChange={handleProjectChange}>
                <SelectTrigger className="w-full sm:w-[180px] h-9">
                  <SelectValue placeholder="Select project" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Projects</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {/* Search - grows to fill on mobile when no project selector */}
            <div className={cn(
              "relative flex-1 min-w-0",
              !lockProject ? "max-w-xs" : "max-w-sm"
            )}>
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                ref={searchInputRef}
                placeholder="Search..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 h-9"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            {/* View toggle - visible on tablet+ */}
            <div className="hidden sm:flex items-center border divide-x shrink-0">
              <button
                className={cn(
                  "h-9 w-9 flex items-center justify-center transition-colors",
                  viewMode === "grid" ? "bg-muted" : "hover:bg-muted/50"
                )}
                onClick={() => setViewMode("grid")}
              >
                <LayoutGrid className="h-4 w-4" />
              </button>
              <button
                className={cn(
                  "h-9 w-9 flex items-center justify-center transition-colors",
                  viewMode === "list" ? "bg-muted" : "hover:bg-muted/50"
                )}
                onClick={() => setViewMode("list")}
              >
                <List className="h-4 w-4" />
              </button>
            </div>

            {!lockSet && (
              <Button
                onClick={() => fileInputRef.current?.click()}
                disabled={!selectedProject}
                className="h-9 shrink-0"
                size="sm"
              >
                <Upload className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">Upload</span>
              </Button>
            )}
          </div>

          {/* Secondary row: plan set filter, revision filter (when applicable) */}
          {selectedProject && (tabMode === "sheets" && (sets.length > 0 && !lockSet) || revisions.length > 0) && (
            <div className="flex items-center gap-2 sm:gap-3 overflow-x-auto hide-scrollbar -mx-2 px-2 sm:mx-0 sm:px-0">
              {/* Plan set filter (when viewing sheets) */}
              {tabMode === "sheets" && sets.length > 0 && !lockSet && (
                <Select
                  value={selectedSet ?? "all"}
                  onValueChange={(value) => setSelectedSet(value === "all" ? undefined : value)}
                >
                  <SelectTrigger className="w-[160px] sm:w-[180px] h-9 shrink-0">
                    <SelectValue placeholder="All plan sets" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Plan Sets</SelectItem>
                    {sets.map((set) => (
                      <SelectItem key={set.id} value={set.id}>
                        {set.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              {tabMode === "sheets" && revisions.length > 0 && (
                <Select value={selectedRevision} onValueChange={setSelectedRevision}>
                  <SelectTrigger className="h-9 w-[160px] sm:w-[200px] shrink-0">
                    <SelectValue placeholder="All versions" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All versions</SelectItem>
                    {revisions.map((rev) => (
                      <SelectItem key={rev.id} value={rev.id}>
                        {formatRevisionLabel(rev)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              {/* Mobile view toggle */}
              <div className="flex sm:hidden items-center border divide-x shrink-0 ml-auto">
                <button
                  className={cn(
                    "h-9 w-9 flex items-center justify-center transition-colors",
                    viewMode === "grid" ? "bg-muted" : "hover:bg-muted/50"
                  )}
                  onClick={() => setViewMode("grid")}
                >
                  <LayoutGrid className="h-4 w-4" />
                </button>
                <button
                  className={cn(
                    "h-9 w-9 flex items-center justify-center transition-colors",
                    viewMode === "list" ? "bg-muted" : "hover:bg-muted/50"
                  )}
                  onClick={() => setViewMode("list")}
                >
                  <List className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Secondary toolbar - tabs and filters */}
        {selectedProject && (
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-4 px-2 sm:px-3 lg:px-4 pb-2 sm:pb-3">
            {/* Tabs */}
            {!hideTabs && (
              <div className="flex items-center gap-1 border p-0.5 w-fit">
                <button
                  className={cn(
                    "h-8 sm:h-7 px-3 text-sm font-medium transition-colors",
                    tabMode === "sheets" ? "bg-muted" : "hover:bg-muted/50"
                  )}
                  onClick={() => setTabMode("sheets")}
                >
                  Sheets
                  {disciplineCounts?.all ? (
                    <span className="ml-1.5 text-muted-foreground">{disciplineCounts.all}</span>
                  ) : null}
                </button>
                <button
                  className={cn(
                    "h-8 sm:h-7 px-3 text-sm font-medium transition-colors",
                    tabMode === "sets" ? "bg-muted" : "hover:bg-muted/50"
                  )}
                  onClick={() => setTabMode("sets")}
                >
                  Plan Sets
                  <span className="ml-1.5 text-muted-foreground">{sets.length}</span>
                </button>
              </div>
            )}

            {/* Discipline filters - horizontally scrollable on mobile */}
            {tabMode === "sheets" && availableDisciplines.length > 0 && (
              <div className="flex items-center gap-1.5 overflow-x-auto hide-scrollbar -mx-2 px-2 sm:mx-0 sm:px-0 pb-1 sm:pb-0">
                <button
                  className={cn(
                    "h-8 sm:h-7 px-3 sm:px-2.5 text-xs font-medium border transition-colors shrink-0",
                    selectedDiscipline === "all"
                      ? "bg-foreground text-background border-foreground"
                      : "hover:bg-muted/50"
                  )}
                  onClick={() => setSelectedDiscipline("all")}
                >
                  All
                </button>
                {availableDisciplines.map((disc) => (
                  <button
                    key={disc.value}
                    className={cn(
                      "h-8 sm:h-7 px-3 sm:px-2.5 text-xs font-medium border transition-colors shrink-0",
                      selectedDiscipline === disc.value
                        ? disc.color.replace("hover:", "") + " border-current"
                        : "hover:bg-muted/50"
                    )}
                    onClick={() => setSelectedDiscipline(disc.value)}
                  >
                    {disc.label}
                    <span className="ml-1 opacity-60">{disciplineCounts[disc.value]}</span>
                  </button>
                ))}
              </div>
            )}

          </div>
        )}

        {/* Selection toolbar */}
        {selectedIds.size > 0 && (
          <div className="flex items-center gap-2 sm:gap-3 px-2 sm:px-3 lg:px-4 py-2 bg-muted/50 border-t">
            <span className="text-sm font-medium shrink-0">
              {selectedIds.size} selected
            </span>
            <div className="h-4 w-px bg-border shrink-0" />
            <Button variant="ghost" size="sm" onClick={clearSelection} className="h-8 sm:h-7 px-2 shrink-0">
              <X className="h-3.5 w-3.5 sm:mr-1" />
              <span className="hidden sm:inline">Clear</span>
            </Button>
            <div className="flex items-center gap-1 ml-auto">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleBulkShare("clients")}
                className="h-8 sm:h-7 px-2"
                title="Share with Clients"
              >
                <Users className="h-3.5 w-3.5 sm:mr-1.5" />
                <span className="hidden sm:inline">Clients</span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleBulkShare("subs")}
                className="h-8 sm:h-7 px-2"
                title="Share with Subs"
              >
                <Building2 className="h-3.5 w-3.5 sm:mr-1.5" />
                <span className="hidden sm:inline">Subs</span>
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        <div className="p-2 sm:p-3 lg:p-4">
          {!selectedProject ? (
            <DrawingsEmptyState variant="no-project" />
          ) : isLoading ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2 sm:gap-3">
              {Array.from({ length: 12 }).map((_, i) => (
                <Skeleton key={i} className="aspect-[8.5/11]" />
              ))}
            </div>
          ) : tabMode === "sets" ? (
            /* Plan Sets View */
            <div className="space-y-2">
              {sets.length === 0 ? (
                <DrawingsEmptyState
                  variant="no-sets"
                  onUpload={() => fileInputRef.current?.click()}
                />
              ) : (
                <>
                  {/* Mobile: Card layout */}
                  <div className="md:hidden space-y-2">
                    {sets.map((set) => {
                      const status = resolveSetStatus(set.status)
                      const progress = set.total_pages ? (set.processed_pages / set.total_pages) * 100 : 0
                      const setLink = projectId
                        ? `/projects/${projectId}/drawings/sets/${set.id}`
                        : null

                      return (
                        <div
                          key={set.id}
                          className="bg-card border rounded-lg p-3 space-y-2"
                        >
                          {/* Header row */}
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              {setLink ? (
                                <button
                                  onClick={() => router.push(setLink)}
                                  className="font-semibold text-sm text-left hover:underline line-clamp-2"
                                >
                                  {set.title}
                                </button>
                              ) : (
                                <div className="font-semibold text-sm line-clamp-2">{set.title}</div>
                              )}
                              <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                                <span>{set.sheet_count ?? 0} sheets</span>
                                <span>·</span>
                                <span>{resolveSetTypeLabel(set.set_type ?? null)}</span>
                              </div>
                            </div>
                            <Badge variant="secondary" className={`border shrink-0 ${status.className}`}>
                              {status.label}
                            </Badge>
                          </div>

                          {/* Progress bar for processing */}
                          {set.status === "processing" && (
                            <div className="flex items-center gap-3">
                              <Progress value={progress} className="h-1.5 flex-1" />
                              <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                                {set.processed_pages}/{set.total_pages ?? "?"}
                              </span>
                            </div>
                          )}

                          {/* Error message */}
                          {set.status === "failed" && set.error_message && (
                            <p className="text-xs text-destructive line-clamp-2">
                              {set.error_message}
                            </p>
                          )}

                          {/* Actions row */}
                          <div className="flex items-center justify-between pt-1">
                            <span className="text-xs text-muted-foreground">
                              Updated {formatDate(set.updated_at)}
                            </span>
                            <div className="flex items-center gap-2">
                              {set.status === "failed" && (
                                <Button variant="outline" size="sm" onClick={() => handleRetry(set.id)} className="h-8">
                                  <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                                  Retry
                                </Button>
                              )}
                              {set.status === "ready" && setLink && (
                                <Button
                                  variant="default"
                                  size="sm"
                                  onClick={() => router.push(setLink)}
                                  className="h-8"
                                >
                                  View sheets
                                </Button>
                              )}
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="icon" className="h-8 w-8">
                                    <MoreHorizontal className="h-4 w-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem
                                    onClick={() => {
                                      setSetToDelete(set)
                                      setDeleteDialogOpen(true)
                                    }}
                                    className="text-destructive"
                                  >
                                    <Trash2 className="h-4 w-4 mr-2" />
                                    Delete
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  {/* Desktop: Table layout */}
                  <div className="hidden md:block rounded-lg border overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow className="divide-x">
                          <TableHead className="px-4 py-4">Plan set</TableHead>
                          <TableHead className="px-4 py-4 text-center">Type</TableHead>
                          <TableHead className="px-4 py-4 text-center">Status</TableHead>
                          <TableHead className="px-4 py-4 text-center">Sheets</TableHead>
                          <TableHead className="px-4 py-4 text-center">Updated</TableHead>
                          <TableHead className="px-4 py-4 text-center w-40">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {sets.map((set) => {
                          const status = resolveSetStatus(set.status)
                          const progress = set.total_pages ? (set.processed_pages / set.total_pages) * 100 : 0
                          const setLink = projectId
                            ? `/projects/${projectId}/drawings/sets/${set.id}`
                            : null

                          return (
                            <TableRow key={set.id} className="divide-x">
                              <TableCell className="px-4 py-4">
                                {setLink ? (
                                  <button
                                    onClick={() => router.push(setLink)}
                                    className="font-semibold text-left hover:underline"
                                  >
                                    {set.title}
                                  </button>
                                ) : (
                                  <div className="font-semibold">{set.title}</div>
                                )}
                                {set.description ? (
                                  <div className="text-xs text-muted-foreground mt-1 truncate">
                                    {set.description}
                                  </div>
                                ) : null}
                              </TableCell>
                              <TableCell className="px-4 py-4 text-center text-sm text-muted-foreground">
                                {resolveSetTypeLabel(set.set_type ?? null)}
                              </TableCell>
                              <TableCell className="px-4 py-4 text-center">
                                <div className="flex flex-col items-center gap-2">
                                  <Badge variant="secondary" className={`border ${status.className}`}>
                                    {status.label}
                                  </Badge>
                                  {set.status === "processing" && (
                                    <div className="flex items-center gap-2">
                                      <Progress value={progress} className="h-1.5 w-20" />
                                      <span className="text-xs text-muted-foreground tabular-nums">
                                        {set.processed_pages}/{set.total_pages ?? "?"}
                                      </span>
                                    </div>
                                  )}
                                  {set.status === "failed" && set.error_message && (
                                    <span className="text-xs text-destructive line-clamp-1">
                                      {set.error_message}
                                    </span>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell className="px-4 py-4 text-center">
                                <div className="font-semibold">{set.sheet_count ?? 0}</div>
                              </TableCell>
                              <TableCell className="px-4 py-4 text-center text-muted-foreground text-sm">
                                {formatDate(set.updated_at)}
                              </TableCell>
                              <TableCell className="px-4 py-4 text-center w-40">
                                <div className="flex items-center justify-center gap-2">
                                  {set.status === "failed" && (
                                    <Button variant="outline" size="sm" onClick={() => handleRetry(set.id)} className="h-8">
                                      <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                                      Retry
                                    </Button>
                                  )}
                                  {set.status === "ready" && (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => setLink && router.push(setLink)}
                                      className="h-8"
                                    >
                                      View sheets
                                    </Button>
                                  )}
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <Button variant="ghost" size="icon" className="h-8 w-8">
                                        <MoreHorizontal className="h-4 w-4" />
                                      </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                      <DropdownMenuItem
                                        onClick={() => {
                                          setSetToDelete(set)
                                          setDeleteDialogOpen(true)
                                        }}
                                        className="text-destructive"
                                      >
                                        <Trash2 className="h-4 w-4 mr-2" />
                                        Delete
                                      </DropdownMenuItem>
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                </div>
                              </TableCell>
                            </TableRow>
                          )
                        })}
                      </TableBody>
                    </Table>
                  </div>
                </>
              )}
            </div>
          ) : sheets.length === 0 ? (
            /* Empty sheets state */
            <DrawingsEmptyState
              variant={hasActiveFilters ? "no-results" : "no-sheets"}
              isProcessing={sets.some((s) => s.status === "processing")}
              onUpload={!hasActiveFilters ? () => fileInputRef.current?.click() : undefined}
            />
          ) : (
            /* Sheets View */
            <div className="space-y-6">
              {/* Recent sheets section (only when no filters) */}
              {!hasActiveFilters && !lockSet && (
                <RecentSheetsSection
                  sheets={sheets}
                  projectId={selectedProject}
                  onSelect={handleViewSheet}
                />
              )}

              {/* Grid or List view */}
              {viewMode === "grid" ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2 sm:gap-3">
                  {sheets.map((sheet, index) => (
                    <SheetCard
                      key={sheet.id}
                      sheet={sheet}
                      statusCounts={statusCounts[sheet.id]}
                      isSelected={selectedIds.has(sheet.id)}
                      isKeyboardFocused={index === selectedIndex}
                      onSelect={() => handleViewSheet(sheet)}
                      onToggleSelection={() => toggleSheetSelection(sheet.id)}
                    />
                  ))}
                </div>
              ) : (
                /* List view */
                <>
                  {/* Mobile: Compact list cards */}
                  <div className="md:hidden space-y-1.5">
                    {sheets.map((sheet, index) => {
                      const tileThumbnailUrl =
                        sheet.tile_base_url && sheet.thumbnail_url ? sheet.thumbnail_url : null
                      const thumbnailSrc =
                        tileThumbnailUrl ?? sheet.image_thumbnail_url ?? sheet.thumbnail_url

                      return (
                        <div
                          key={sheet.id}
                          className={cn(
                            "flex items-center gap-2.5 p-2.5 bg-card border rounded-lg cursor-pointer",
                            "active:bg-muted/50",
                            selectedIds.has(sheet.id) && "ring-2 ring-primary ring-offset-1",
                            index === selectedIndex && !selectedIds.has(sheet.id) && "ring-1 ring-primary/50"
                          )}
                          onClick={() => handleViewSheet(sheet)}
                        >
                          {/* Selection checkbox */}
                          <button
                            className={cn(
                              "w-6 h-6 flex items-center justify-center border transition-colors shrink-0",
                              selectedIds.has(sheet.id) && "bg-primary border-primary"
                            )}
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleSheetSelection(sheet.id)
                            }}
                          >
                            {selectedIds.has(sheet.id) && (
                              <Check className="h-4 w-4 text-primary-foreground" strokeWidth={2.5} />
                            )}
                          </button>

                          {/* Thumbnail */}
                          <div className="w-12 h-14 bg-muted/50 border overflow-hidden shrink-0">
                            {thumbnailSrc ? (
                              <img
                                src={thumbnailSrc}
                                alt={sheet.sheet_number}
                                className="w-full h-full object-cover"
                                loading="lazy"
                                decoding="async"
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center">
                                <FileText className="h-5 w-5 text-muted-foreground/60" />
                              </div>
                            )}
                          </div>

                          {/* Info */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm truncate">{sheet.sheet_number}</span>
                              {sheet.discipline && (
                                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 shrink-0">
                                  {sheet.discipline}
                                </Badge>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground truncate mt-0.5">
                              {sheet.sheet_title || "Untitled"}
                            </p>
                            <div className="flex items-center gap-2 mt-1">
                              <SheetStatusDots counts={statusCounts[sheet.id]} size="sm" />
                              {(sheet.share_with_clients || sheet.share_with_subs) && (
                                <div className="flex items-center gap-1">
                                  {sheet.share_with_clients && (
                                    <Users className="h-3 w-3 text-muted-foreground" />
                                  )}
                                  {sheet.share_with_subs && (
                                    <Building2 className="h-3 w-3 text-muted-foreground" />
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  {/* Desktop: Table layout */}
                  <div className="hidden md:block rounded-lg border overflow-hidden">
                    <TooltipProvider delayDuration={200}>
                      <Table>
                        <TableHeader>
                          <TableRow className="divide-x">
                            <TableHead className="px-4 py-4 w-10">‎</TableHead>
                            <TableHead className="px-4 py-4 w-16">Preview</TableHead>
                            <TableHead className="px-4 py-4">Sheet</TableHead>
                            <TableHead className="px-4 py-4">Title</TableHead>
                            {lockSet && <TableHead className="px-4 py-4 text-center">Revision</TableHead>}
                            <TableHead className="px-4 py-4 text-center">Discipline</TableHead>
                            <TableHead className="px-4 py-4 text-center">Status</TableHead>
                            <TableHead className="px-4 py-4 text-center">Sharing</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {sheets.map((sheet, index) => {
                            const tileThumbnailUrl =
                              sheet.tile_base_url && sheet.thumbnail_url ? sheet.thumbnail_url : null
                            const thumbnailSrc =
                              tileThumbnailUrl ?? sheet.image_thumbnail_url ?? sheet.thumbnail_url

                            return (
                              <TableRow
                                key={sheet.id}
                                className={cn(
                                  "divide-x cursor-pointer",
                                  "hover:bg-muted/30",
                                  selectedIds.has(sheet.id) && "bg-primary/5",
                                  index === selectedIndex && !selectedIds.has(sheet.id) && "bg-muted/20"
                                )}
                                onClick={() => handleViewSheet(sheet)}
                              >
                                <TableCell className="px-4 py-3 w-10">
                                  <button
                                    className={cn(
                                      "w-5 h-5 flex items-center justify-center border transition-colors",
                                      selectedIds.has(sheet.id) && "bg-primary border-primary"
                                    )}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      toggleSheetSelection(sheet.id)
                                    }}
                                  >
                                    {selectedIds.has(sheet.id) && (
                                      <Check className="h-3.5 w-3.5 text-primary-foreground" strokeWidth={2.5} />
                                    )}
                                  </button>
                                </TableCell>
                                <TableCell className="px-4 py-3">
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <div className="w-10 h-12 bg-muted/50 border overflow-hidden">
                                        {thumbnailSrc ? (
                                          <img
                                            src={thumbnailSrc}
                                            alt={sheet.sheet_number}
                                            className="w-full h-full object-cover"
                                            loading="lazy"
                                            decoding="async"
                                          />
                                        ) : (
                                          <div className="w-full h-full flex items-center justify-center">
                                            <FileText className="h-4 w-4 text-muted-foreground/60" />
                                          </div>
                                        )}
                                      </div>
                                    </TooltipTrigger>
                                    {thumbnailSrc && (
                                      <TooltipContent
                                        side="right"
                                        sideOffset={12}
                                        className={cn(
                                          "bg-background p-2",
                                          "data-[state=open]:animate-in data-[state=closed]:animate-out",
                                          "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
                                          "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
                                          "data-[side=right]:slide-in-from-left-2 data-[side=left]:slide-in-from-right-2",
                                          "data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2"
                                        )}
                                      >
                                        <div className="w-80 h-[28rem] overflow-hidden border bg-muted/50">
                                          <img
                                            src={thumbnailSrc}
                                            alt={sheet.sheet_number}
                                            className="w-full h-full object-cover"
                                            loading="lazy"
                                            decoding="async"
                                          />
                                        </div>
                                      </TooltipContent>
                                    )}
                                  </Tooltip>
                                </TableCell>
                                <TableCell className="px-4 py-3">
                                  <div className="font-medium text-sm truncate">{sheet.sheet_number}</div>
                                </TableCell>
                                <TableCell className="px-4 py-3 text-sm text-muted-foreground truncate">
                                  {sheet.sheet_title || "—"}
                                </TableCell>
                                {lockSet && (
                                  <TableCell className="px-4 py-3 text-center text-xs text-muted-foreground">
                                    {sheet.current_revision_label ?? "—"}
                                  </TableCell>
                                )}
                                <TableCell className="px-4 py-3 text-center">
                                  {sheet.discipline ? (
                                    <Badge variant="secondary" className="text-xs px-2 py-0 h-5">
                                      {sheet.discipline}
                                    </Badge>
                                  ) : (
                                    <span className="text-xs text-muted-foreground">—</span>
                                  )}
                                </TableCell>
                                <TableCell className="px-4 py-3 text-center">
                                  <SheetStatusDots counts={statusCounts[sheet.id]} size="sm" />
                                </TableCell>
                                <TableCell className="px-4 py-3 text-center">
                                  <div className="flex justify-center gap-1">
                                    {sheet.share_with_clients && (
                                      <div className="w-6 h-6 flex items-center justify-center bg-muted/50">
                                        <Users className="h-3.5 w-3.5 text-muted-foreground" />
                                      </div>
                                    )}
                                    {sheet.share_with_subs && (
                                      <div className="w-6 h-6 flex items-center justify-center bg-muted/50">
                                        <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                                      </div>
                                    )}
                                    {!sheet.share_with_clients && !sheet.share_with_subs && (
                                      <span className="text-xs text-muted-foreground">—</span>
                                    )}
                                  </div>
                                </TableCell>
                              </TableRow>
                            )
                          })}
                        </TableBody>
                      </Table>
                    </TooltipProvider>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Upload Dialog */}
      <Dialog open={uploadDialogOpen} onOpenChange={setUploadDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Upload Plan Set</DialogTitle>
            <DialogDescription>
              Upload a PDF plan set. It will be automatically split into individual sheets.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                value={uploadTitle}
                onChange={(e) => setUploadTitle(e.target.value)}
                placeholder="Enter plan set title"
                disabled={isUploading}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="set-type">Type</Label>
              <Select value={uploadSetType} onValueChange={setUploadSetType} disabled={isUploading}>
                <SelectTrigger id="set-type">
                  <SelectValue placeholder="Select a type" />
                </SelectTrigger>
                <SelectContent>
                  {DRAWING_SET_TYPES.map((type) => (
                    <SelectItem key={type.value} value={type.value}>
                      {type.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {uploadFile && (
              <div className="flex items-center gap-3 p-3 bg-muted/50 border">
                <FileText className="h-5 w-5 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{uploadFile.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {(uploadFile.size / 1024 / 1024).toFixed(2)} MB
                  </p>
                </div>
              </div>
            )}

            {uploadProgress && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{uploadProgress.stage}</span>
                  {uploadProgress.total > 0 && (
                    <span className="text-muted-foreground tabular-nums">
                      {uploadProgress.current}/{uploadProgress.total}
                    </span>
                  )}
                </div>
                <Progress
                  value={uploadProgress.total > 0 ? (uploadProgress.current / uploadProgress.total) * 100 : 0}
                  className="h-1.5"
                />
              </div>
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
            <Button onClick={handleUpload} disabled={isUploading || !uploadTitle}>
              {isUploading ? (
                <>
                  <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                  Uploading...
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4 mr-2" />
                  Upload
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Plan Set</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete "{setToDelete?.title}" and all its sheets.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteSet}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Sheet Viewer */}
      {viewerOpen && viewerSheet && (
        <DrawingViewer
          sheet={viewerSheet}
          fileUrl={viewerUrl ?? undefined}
          markups={viewerMarkups}
          pins={viewerPins}
          highlightedPinId={viewerHighlightedPinId ?? undefined}
          onClose={() => setViewerOpen(false)}
          onSaveMarkup={handleSaveMarkup}
          onDeleteMarkup={handleDeleteMarkup}
          onCreatePin={handleCreatePin}
          onPinClick={handlePinClick}
          sheets={sheets}
          onNavigateSheet={handleViewSheet}
          imageThumbnailUrl={viewerSheet.image_thumbnail_url}
          imageMediumUrl={viewerSheet.image_medium_url}
          imageFullUrl={viewerSheet.image_full_url}
          imageWidth={viewerSheet.image_width}
          imageHeight={viewerSheet.image_height}
        />
      )}

      {/* Create from Drawing Dialog */}
      <CreateFromDrawingDialog
        open={createFromDrawingOpen}
        onOpenChange={setCreateFromDrawingOpen}
        onCreate={handleCreateFromDrawing}
        sheet={viewerSheet}
        position={createFromDrawingPosition || { x: 0, y: 0 }}
        projectId={selectedProject || undefined}
      />

      {/* Keyboard Shortcuts Help */}
      <KeyboardShortcutsHelp
        open={showShortcutsHelp}
        onOpenChange={setShowShortcutsHelp}
        context="list"
      />

      {/* Drag and drop overlay */}
      {isDragActive && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-background/80 backdrop-blur-sm pointer-events-none">
          <div className="flex flex-col items-center gap-2 border border-dashed border-muted-foreground/40 bg-card/80 px-6 py-5">
            <Upload className="h-6 w-6 text-muted-foreground" />
            <div className="text-sm font-medium">Drop PDF to upload</div>
            <div className="text-xs text-muted-foreground">
              We’ll split it into sheets automatically
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
