"use client"

import { useState, useEffect, useCallback, useRef, useMemo } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import {
  Upload,
  FileText,
  Search,
  Filter,
  Grid,
  List,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Clock,
  Download,
  Share2,
  Eye,
  MoreHorizontal,
  Trash2,
  ChevronDown,
  X,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { DISCIPLINE_LABELS } from "@/lib/validation/drawings"
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
  listDrawingMarkupsAction,
  listDrawingPinsWithEntitiesAction,
  createDrawingMarkupAction,
  updateDrawingMarkupAction,
  deleteDrawingMarkupAction,
  createDrawingPinAction,
  createTaskFromDrawingAction,
  createRfiFromDrawingAction,
  createPunchItemFromDrawingAction,
  updateDrawingPinAction,
  deleteDrawingPinAction,
} from "@/app/(app)/drawings/actions"
import { DrawingViewer } from "./drawing-viewer"
import { CreateFromDrawingDialog } from "./index"
import { SheetStatusDots } from "./sheet-status-dots"
import { KeyboardShortcutsHelp } from "./keyboard-shortcuts-help"
import { useDrawingKeyboardShortcuts } from "./use-drawing-keyboard-shortcuts"
import { DisciplineTabs } from "./discipline-tabs"
import { RecentSheetsSection, useRecentSheets } from "./recent-sheets-section"
import { SheetThumbnailStrip } from "./sheet-thumbnail-strip"
import { getSheetStatusCountsAction } from "@/app/(app)/drawings/actions"

type ViewMode = "grid" | "list"
type TabMode = "sets" | "sheets"

interface DrawingsClientProps {
  initialSets: DrawingSet[]
  initialSheets: DrawingSheet[]
  initialDisciplineCounts: Record<string, number>
  projects: Array<{ id: string; name: string }>
  defaultProjectId?: string
  lockProject?: boolean
}

export function DrawingsClient({
  initialSets,
  initialSheets,
  initialDisciplineCounts,
  projects,
  defaultProjectId,
  lockProject = false,
}: DrawingsClientProps) {
  const USE_TILED_VIEWER = process.env.NEXT_PUBLIC_FEATURE_TILED_VIEWER === "true"
  const ENABLE_CLIENT_IMAGE_GEN =
    process.env.NEXT_PUBLIC_FEATURE_DRAWINGS_CLIENT_IMAGE_GEN === "true"
  const router = useRouter()
  const searchParams = useSearchParams()

  // Data state
  const [sets, setSets] = useState<DrawingSet[]>(initialSets)
  const [sheets, setSheets] = useState<DrawingSheet[]>(initialSheets)
  const [disciplineCounts, setDisciplineCounts] = useState(initialDisciplineCounts)

  // Filter state
  const [selectedProject, setSelectedProject] = useState<string | undefined>(defaultProjectId)
  const [selectedDiscipline, setSelectedDiscipline] = useState<DrawingDiscipline | "all">("all")
  const [selectedSet, setSelectedSet] = useState<string | undefined>(undefined)
  const [searchQuery, setSearchQuery] = useState("")
  const [tabMode, setTabMode] = useState<TabMode>("sheets")

  // View state
  const [viewMode, setViewMode] = useState<ViewMode>("grid")
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Upload state
  const [isUploading, setIsUploading] = useState(false)
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false)
  const [uploadTitle, setUploadTitle] = useState("")
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploadProgress, setUploadProgress] = useState<{
    stage: string
    current: number
    total: number
  } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Viewer state
  const [viewerOpen, setViewerOpen] = useState(false)
  const [viewerSheet, setViewerSheet] = useState<DrawingSheet | null>(null)
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

          // If processing complete, refresh sheets
          if (status.status === "ready") {
            await fetchSheets()
          }
        } catch (e) {
          console.error("Failed to poll status:", e)
        }
      }
    }, 3000)

    return () => clearInterval(interval)
  }, [processingSetIds])

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
        }),
        getDisciplineCountsAction(selectedProject),
      ])
      const derivedCounts = selectedSet
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

      // Foundation v2: status counts are already denormalized into the list row.
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
  }, [selectedProject, selectedDiscipline, searchQuery, selectedSet, USE_TILED_VIEWER])

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

  // Debounce search
  useEffect(() => {
    const timeout = setTimeout(() => {
      fetchData()
    }, 300)
    return () => clearTimeout(timeout)
  }, [fetchData])

  // Fetch status counts when sheets change (legacy path only).
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

    // Update URL
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

  // Handle upload
  const handleUpload = async () => {
    if (!uploadFile || !selectedProject) return

    setIsUploading(true)
    setUploadProgress({ stage: "Uploading PDF...", current: 0, total: 1 })

    try {
      // Get orgId from cookie
      const orgId = document.cookie.match(/(?:^|; )org_id=([^;]+)/)?.[1]
      if (!orgId) {
        throw new Error("Organization not found. Please refresh the page.")
      }

      // Step 1: Upload file directly to Supabase Storage
      const { storagePath } = await uploadDrawingFileToStorage(
        uploadFile,
        selectedProject,
        orgId
      )

      // Step 2: Create the drawing set record (triggers edge function)
      setUploadProgress({ stage: "Processing PDF...", current: 0, total: 1 })
      const newSet = await createDrawingSetFromUpload({
        projectId: selectedProject,
        title: uploadTitle,
        fileName: uploadFile.name,
        storagePath,
        fileSize: uploadFile.size,
        mimeType: uploadFile.type,
      })

      setSets((prev) => [newSet, ...prev])

      // Foundation v2: tiles + thumbnails are generated server-side (edge function + outbox).
      // We skip client-side PDF rendering/image generation entirely.
      if (USE_TILED_VIEWER) {
        setUploadDialogOpen(false)
        setUploadFile(null)
        setUploadTitle("")
        setUploadProgress(null)
        toast.success("Plan set uploaded. Processing sheets + tiles in the background.")
        await fetchSheets()
        return
      }

      // Default behavior going forward: do NOT attempt client-side image generation unless explicitly enabled.
      // Client-side uploads into `drawings-images` are brittle due to Storage policies / RLS and should be avoided.
      if (!ENABLE_CLIENT_IMAGE_GEN) {
        toast.success("Plan set uploaded. Sheets are processing in the background.")
        setUploadDialogOpen(false)
        setUploadFile(null)
        setUploadTitle("")
        setUploadProgress(null)
        await fetchSheets()
        return
      }

      // Step 3: Wait for edge function to finish processing
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
        toast.warning("PDF processed, but image generation will be skipped. Sheets will use PDF rendering.")
        setUploadDialogOpen(false)
        setUploadFile(null)
        setUploadTitle("")
        setUploadProgress(null)
        return
      }

      // Step 4: Generate images client-side
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

      // Step 5: Update database with image URLs
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
      setUploadProgress(null)
      toast.success(`Plan set uploaded with optimized images! (${saved}/${sheetVersions.length} sheets)`)

      // Refresh sheets to show the new images
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
    // Open the viewer immediately. Then load everything else in the background.
    // This avoids making the UX depend on a signed-url call + extra DB fetches.
    const requestId = ++sheetOpenRequestIdRef.current

    trackView(sheet.id)
    // With the public drawings-images bucket, the list already carries cacheable URLs.
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
        // If we have optimized images we don't need the PDF URL to render,
        // but we still fetch it in the background so Download works.
        // If we DON'T have images, the viewer will show a loading state until this resolves.
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

      // Ignore stale responses if user navigated quickly.
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

      // If we have no optimized images and couldn't even get the PDF URL, there's nothing to show.
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
      await fetchSheets() // Refresh sheets
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

  // Select all visible sheets
  const selectAllVisible = () => {
    setSelectedIds(new Set(sheets.map((s) => s.id)))
  }

  // Clear selection
  const clearSelection = () => {
    setSelectedIds(new Set())
  }

  // Render sheets content (reused with and without recent section)
  const renderSheetsContent = () => {
    if (sheets.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <FileText className="h-12 w-12 text-muted-foreground mb-4" />
          <h2 className="text-lg font-semibold mb-2">No Sheets</h2>
          <p className="text-muted-foreground">
            {sets.some((s) => s.status === "processing")
              ? "Sheets are being processed..."
              : "Upload a plan set to generate sheets."}
          </p>
        </div>
      )
    }

    if (viewMode === "grid") {
      return (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4">
          {sheets.map((sheet, index) => (
            <div
              key={sheet.id}
              className={cn(
                "relative group cursor-pointer border rounded-lg overflow-hidden bg-card",
                selectedIds.has(sheet.id) && "ring-2 ring-primary",
                index === selectedIndex && !selectedIds.has(sheet.id) && "ring-2 ring-blue-500"
              )}
              onClick={() => handleViewSheet(sheet)}
            >
              {/* Thumbnail */}
              <div className="aspect-[8.5/11] bg-muted flex items-center justify-center">
                {sheet.image_thumbnail_url || sheet.thumbnail_url ? (
                  <img
                    src={
                      (sheet.image_thumbnail_url ?? sheet.thumbnail_url) as string
                    }
                    alt={sheet.sheet_number}
                    className="w-full h-full object-cover"
                    loading="lazy"
                    decoding="async"
                  />
                ) : (
                  <FileText className="h-12 w-12 text-muted-foreground" />
                )}
              </div>

              {/* Selection checkbox */}
              <button
                className={cn(
                  "absolute top-2 left-2 w-5 h-5 rounded border bg-background",
                  "opacity-0 group-hover:opacity-100 transition-opacity",
                  selectedIds.has(sheet.id) && "opacity-100 bg-primary border-primary"
                )}
                onClick={(e) => {
                  e.stopPropagation()
                  toggleSheetSelection(sheet.id)
                }}
              >
                {selectedIds.has(sheet.id) && (
                  <CheckCircle2 className="h-4 w-4 text-primary-foreground" />
                )}
              </button>

              {/* Sharing badges */}
              <div className="absolute top-2 right-2 flex gap-1">
                {sheet.share_with_clients && (
                  <Badge variant="secondary" className="text-xs">C</Badge>
                )}
                {sheet.share_with_subs && (
                  <Badge variant="secondary" className="text-xs">S</Badge>
                )}
              </div>

              {/* Info */}
              <div className="p-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-medium text-sm truncate">
                    {sheet.sheet_number}
                  </p>
                  {sheet.discipline && (
                    <Badge variant="outline" className="text-xs shrink-0">
                      {sheet.discipline}
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground truncate">
                  {sheet.sheet_title}
                </p>
                <SheetStatusDots
                  counts={statusCounts[sheet.id]}
                  size="sm"
                  className="mt-1"
                />
              </div>
            </div>
          ))}
        </div>
      )
    }

    // List view
    return (
      <div className="border rounded-lg divide-y">
        <div className="grid grid-cols-[auto,1fr,1fr,1fr,auto,auto] gap-4 p-3 bg-muted font-medium text-sm">
          <div className="w-5" />
          <div>Sheet #</div>
          <div>Title</div>
          <div>Discipline</div>
          <div className="w-24 text-center">Status</div>
          <div className="w-24 text-center">Sharing</div>
        </div>
        {sheets.map((sheet, index) => (
          <div
            key={sheet.id}
            className={cn(
              "grid grid-cols-[auto,1fr,1fr,1fr,auto,auto] gap-4 p-3 items-center hover:bg-muted/50 cursor-pointer",
              selectedIds.has(sheet.id) && "bg-primary/5",
              index === selectedIndex && !selectedIds.has(sheet.id) && "bg-blue-500/5"
            )}
            onClick={() => handleViewSheet(sheet)}
          >
            <button
              className={cn(
                "w-5 h-5 rounded border",
                selectedIds.has(sheet.id) && "bg-primary border-primary"
              )}
              onClick={(e) => {
                e.stopPropagation()
                toggleSheetSelection(sheet.id)
              }}
            >
              {selectedIds.has(sheet.id) && (
                <CheckCircle2 className="h-4 w-4 text-primary-foreground" />
              )}
            </button>
            <div className="font-medium">{sheet.sheet_number}</div>
            <div className="text-muted-foreground">
              {sheet.sheet_title || "-"}
            </div>
            <div>
              {sheet.discipline ? (
                <Badge variant="outline">
                  {sheet.discipline} - {DISCIPLINE_LABELS[sheet.discipline]}
                </Badge>
              ) : (
                <span className="text-muted-foreground">-</span>
              )}
            </div>
            <div className="w-24 flex justify-center">
              <SheetStatusDots counts={statusCounts[sheet.id]} size="sm" />
            </div>
            <div className="w-24 flex justify-center gap-1">
              {sheet.share_with_clients && (
                <Badge variant="secondary" className="text-xs">Clients</Badge>
              )}
              {sheet.share_with_subs && (
                <Badge variant="secondary" className="text-xs">Subs</Badge>
              )}
              {!sheet.share_with_clients && !sheet.share_with_subs && (
                <span className="text-muted-foreground text-xs">Private</span>
              )}
            </div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex flex-col gap-4 p-4 border-b bg-background">
        <div className="flex flex-wrap items-center gap-2">
          {lockProject ? (
            <div className="rounded-md border px-3 py-2 text-sm">
              {projects.find((p) => p.id === selectedProject)?.name ?? "Project"}
            </div>
          ) : (
            <Select value={selectedProject ?? "all"} onValueChange={handleProjectChange}>
              <SelectTrigger className="w-[200px]">
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

          {selectedProject && tabMode === "sheets" && (
            <Select
              value={selectedSet ?? "all"}
              onValueChange={(value) => setSelectedSet(value === "all" ? undefined : value)}
            >
              <SelectTrigger className="w-[220px]">
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

          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              placeholder="Search drawings..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>

          <div className="flex items-center gap-1 border rounded-md">
            <Button
              variant={viewMode === "grid" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8"
              onClick={() => setViewMode("grid")}
            >
              <Grid className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === "list" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8"
              onClick={() => setViewMode("list")}
            >
              <List className="h-4 w-4" />
            </Button>
          </div>

          <div className="flex-1" />

          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf"
            className="hidden"
            onChange={handleFileSelect}
          />

          <Button
            onClick={() => fileInputRef.current?.click()}
            disabled={!selectedProject}
          >
            <Upload className="h-4 w-4 mr-2" />
            Upload Plan Set
          </Button>
        </div>

        {/* Tabs and discipline filters */}
        {selectedProject && (
          <div className="flex items-center justify-between">
            <Tabs value={tabMode} onValueChange={(v) => setTabMode(v as TabMode)}>
              <TabsList>
                <TabsTrigger value="sheets">
                  Sheets {disciplineCounts?.all ? `(${disciplineCounts.all})` : ""}
                </TabsTrigger>
                <TabsTrigger value="sets">
                  Plan Sets ({sets.length})
                </TabsTrigger>
              </TabsList>
            </Tabs>

            {tabMode === "sheets" && disciplineCounts && (
              <DisciplineTabs
                counts={disciplineCounts}
                selected={selectedDiscipline === "all" ? null : selectedDiscipline}
                onSelect={(disc) => setSelectedDiscipline(disc === null ? "all" : (disc as DrawingDiscipline))}
              />
            )}
          </div>
        )}

        {/* Selection actions */}
        {selectedIds.size > 0 && (
          <div className="flex items-center gap-2 p-2 bg-muted rounded-md">
            <span className="text-sm font-medium">
              {selectedIds.size} selected
            </span>
            <Button variant="outline" size="sm" onClick={clearSelection}>
              <X className="h-4 w-4 mr-1" />
              Clear
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleBulkShare("clients")}
            >
              <Share2 className="h-4 w-4 mr-1" />
              Share with Clients
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleBulkShare("subs")}
            >
              <Share2 className="h-4 w-4 mr-1" />
              Share with Subs
            </Button>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {!selectedProject ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <FileText className="h-16 w-16 text-muted-foreground mb-4" />
            <h2 className="text-xl font-semibold mb-2">Select a Project</h2>
            <p className="text-muted-foreground max-w-md">
              Choose a project from the dropdown above to view and manage drawings.
            </p>
          </div>
        ) : isLoading ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4">
            {Array.from({ length: 12 }).map((_, i) => (
              <Skeleton key={i} className="aspect-[8.5/11] rounded-md" />
            ))}
          </div>
        ) : tabMode === "sheets" && !searchQuery && selectedDiscipline === "all" && !selectedSet ? (
          /* Recent sheets + All sheets */
          <div className="space-y-6">
            <RecentSheetsSection
              sheets={sheets}
              projectId={selectedProject}
              onSelect={handleViewSheet}
            />
            {renderSheetsContent()}
          </div>
        ) : tabMode === "sets" ? (
          /* Drawing Sets View */
          <div className="space-y-4">
            {sets.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Upload className="h-12 w-12 text-muted-foreground mb-4" />
                <h2 className="text-lg font-semibold mb-2">No Plan Sets</h2>
                <p className="text-muted-foreground mb-4">
                  Upload a PDF plan set to get started.
                </p>
                <Button onClick={() => fileInputRef.current?.click()}>
                  <Upload className="h-4 w-4 mr-2" />
                  Upload Plan Set
                </Button>
              </div>
            ) : (
              sets.map((set) => (
                <div
                  key={set.id}
                  className="flex items-center justify-between p-4 border rounded-lg bg-card"
                >
                  <div className="flex items-center gap-4">
                    <div className="p-2 bg-muted rounded-md">
                      <FileText className="h-8 w-8 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">{set.title}</h3>
                      <p className="text-sm text-muted-foreground">
                        {set.sheet_count ?? 0} sheets
                        {set.description && ` - ${set.description}`}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    {set.status === "processing" && (
                      <div className="flex items-center gap-2">
                        <Clock className="h-4 w-4 text-blue-500 animate-pulse" />
                        <div className="w-32">
                          <Progress
                            value={
                              set.total_pages
                                ? (set.processed_pages / set.total_pages) * 100
                                : 0
                            }
                          />
                        </div>
                        <span className="text-sm text-muted-foreground">
                          {set.processed_pages}/{set.total_pages ?? "?"}
                        </span>
                      </div>
                    )}

                    {set.status === "ready" && (
                      <Badge variant="default" className="bg-green-500">
                        <CheckCircle2 className="h-3 w-3 mr-1" />
                        Ready
                      </Badge>
                    )}

                    {set.status === "failed" && (
                      <div className="flex items-center gap-2">
                        <Badge variant="destructive">
                          <AlertCircle className="h-3 w-3 mr-1" />
                          Failed
                        </Badge>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleRetry(set.id)}
                        >
                          <RefreshCw className="h-4 w-4 mr-1" />
                          Retry
                        </Button>
                      </div>
                    )}

                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon">
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
              ))
            )}
          </div>
        ) : (
          /* Sheets View (with search/filter active) */
          renderSheetsContent()
        )}
      </div>

      {/* Upload Dialog */}
      <Dialog open={uploadDialogOpen} onOpenChange={setUploadDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload Plan Set</DialogTitle>
            <DialogDescription>
              Upload a multi-page PDF plan set. It will be automatically split into individual sheets with optimized images for fast loading.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                value={uploadTitle}
                onChange={(e) => setUploadTitle(e.target.value)}
                placeholder="Enter plan set title"
                disabled={isUploading}
              />
            </div>

            {uploadFile && (
              <div className="flex items-center gap-2 p-2 border rounded-md">
                <FileText className="h-5 w-5 text-muted-foreground" />
                <span className="text-sm">{uploadFile.name}</span>
                <span className="text-xs text-muted-foreground">
                  ({(uploadFile.size / 1024 / 1024).toFixed(2)} MB)
                </span>
              </div>
            )}

            {uploadProgress && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{uploadProgress.stage}</span>
                  {uploadProgress.total > 0 && (
                    <span className="text-muted-foreground">
                      {uploadProgress.current}/{uploadProgress.total}
                    </span>
                  )}
                </div>
                <Progress
                  value={uploadProgress.total > 0 ? (uploadProgress.current / uploadProgress.total) * 100 : 0}
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
                  {uploadProgress?.stage || "Processing..."}
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
            <AlertDialogTitle>Delete Drawing Set?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete &quot;{setToDelete?.title}&quot; and all its sheets.
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
          // Phase 1 Performance: Pre-rendered image URLs
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
    </div>
  )
}
