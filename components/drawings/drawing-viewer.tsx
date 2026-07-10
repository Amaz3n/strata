"use client"

import { useState, useRef, useCallback, useEffect, useMemo } from "react"
import { toast } from "sonner"
import { track } from "@vercel/analytics"
import { cn } from "@/lib/utils"
import {
  useDrawingPerformance,
  logPerformanceSummary,
  type DrawingPerformanceMetrics,
} from "./use-drawing-performance"
import { ImageViewer, type ImageLoadStage } from "./image-viewer"
import {
  ArrowRight,
  Circle,
  Square,
  Type,
  Pencil,
  MessageSquare,
  Ruler,
  Cloud,
  Highlighter,
  Trash2,
  Undo2,
  Save,
  Download,
  ZoomIn,
  ZoomOut,
  Move,
  X,
  MapPin,
  Eye,
  EyeOff,
  Layers,
  RotateCcw,
  GitCompare,
  History,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Maximize2,
  PanelRight,
  PanelRightClose,
  Keyboard,
  MoreVertical,
  Camera,
  FileDown,
  Crosshair,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Slider } from "@/components/ui/slider"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  PIN_ENTITY_TYPE_LABELS,
  DISCIPLINE_LABELS,
  parseFeetInches,
  formatFeetInches,
} from "@/lib/validation/drawings"
import type { DrawingDiscipline } from "@/lib/validation/drawings"
import {
  disciplineGradientClass,
  disciplineIcon,
  groupSheetsByDiscipline,
  DISCIPLINE_SORT_ORDER,
} from "@/lib/utils/drawing-utils"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import type { DrawingSheet, DrawingSheetVersion, DrawingMarkup, DrawingPin, MarkupType } from "@/app/(app)/drawings/types"
import {
  listSheetVersionsWithUrlsAction,
  getSheetCalibrationAction,
  setSheetVersionCalibrationAction,
  createPhotoFromDrawingAction,
  getPhotoForPinAction,
} from "@/app/(app)/drawings/actions"
import { uploadDocumentFileDirect } from "@/lib/services/files-client"
import { useDrawingKeyboardShortcuts } from "./use-drawing-keyboard-shortcuts"
import { KeyboardShortcutsHelp } from "./keyboard-shortcuts-help"
import { ComparisonViewer } from "./comparison-viewer"
import { DrawingPinLayer } from "./drawing-pin-layer"
import { SheetThumbnailStrip } from "./sheet-thumbnail-strip"
import { useTouchGestures } from "./use-touch-gestures"
import { LongPressMenu } from "./long-press-menu"
import { usePrefetchAdjacentSheets } from "./use-prefetch-sheets"
import { useIsMobile } from "@/components/ui/use-mobile"
import { useIsTouchDevice } from "@/lib/hooks/use-is-touch-device"
import { TiledDrawingViewer, type ImageToScreenMatrix, type TileManifest } from "./viewer/tiled-drawing-viewer"
import { SVGOverlay, type SVGOverlayHandle } from "./viewer/svg-overlay"

import { unwrapAction } from "@/lib/action-result"

// Dynamically import PDF components to avoid SSR issues
interface PDFViewerProps {
  file: string
  onLoadSuccess: () => void
  onPdfImported?: () => void
  onWorkerLoaded?: () => void
  onDocumentLoaded?: () => void
}

const PDFViewer = ({
  file,
  onLoadSuccess,
  onPdfImported,
  onWorkerLoaded,
  onDocumentLoaded,
}: PDFViewerProps) => {
  const [PDFComponents, setPDFComponents] = useState<{
    Document: any;
    Page: any;
    pdfjs: any;
  } | null>(null)
  const importStartRef = useRef<number>(0)
  const callbacksRef = useRef<{
    onLoadSuccess: PDFViewerProps["onLoadSuccess"]
    onPdfImported?: PDFViewerProps["onPdfImported"]
    onWorkerLoaded?: PDFViewerProps["onWorkerLoaded"]
    onDocumentLoaded?: PDFViewerProps["onDocumentLoaded"]
  }>({ onLoadSuccess, onPdfImported, onWorkerLoaded, onDocumentLoaded })

  // Keep latest callbacks without re-running the import effect.
  useEffect(() => {
    callbacksRef.current = { onLoadSuccess, onPdfImported, onWorkerLoaded, onDocumentLoaded }
  }, [onLoadSuccess, onPdfImported, onWorkerLoaded, onDocumentLoaded])

  useEffect(() => {
    const loadPDF = async () => {
      try {
        importStartRef.current = performance.now()

        const { Document, Page, pdfjs } = await import("react-pdf")

        // Track PDF import time
        const importTime = Math.round(performance.now() - importStartRef.current)
        console.log(`[Drawing Performance] PDF.js import: ${importTime}ms`)
        callbacksRef.current.onPdfImported?.()

        // Set worker and track time
        const workerStart = performance.now()
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs"

        // Worker loading happens asynchronously, we track it on document load
        setPDFComponents({ Document, Page, pdfjs })

        const workerTime = Math.round(performance.now() - workerStart)
        console.log(`[Drawing Performance] Worker config: ${workerTime}ms`)
        callbacksRef.current.onWorkerLoaded?.()
      } catch (error) {
        console.error("Failed to load PDF components:", error)
      }
    }

    loadPDF()
  }, [])

  if (!PDFComponents) {
    return null
  }

  const { Document, Page } = PDFComponents

  return (
    <Document
      file={file}
      loading={null}
      error={null}
      onLoadSuccess={() => {
        console.log(`[Drawing Performance] PDF document loaded`)
        callbacksRef.current.onDocumentLoaded?.()
      }}
    >
      <Page
        pageNumber={1}
        width={undefined}
        renderTextLayer={false}
        renderAnnotationLayer={false}
        onLoadSuccess={() => {
          console.log(`[Drawing Performance] PDF page rendered`)
          callbacksRef.current.onLoadSuccess()
        }}
      />
    </Document>
  )
}

// Color palette for markups
const MARKUP_COLORS = [
  "#EF4444", // red
  "#F97316", // orange
  "#EAB308", // yellow
  "#22C55E", // green
  "#3B82F6", // blue
  "#8B5CF6", // purple
  "#EC4899", // pink
  "#000000", // black
]

// Stroke width options
const STROKE_WIDTHS = [1, 2, 3, 4, 6, 8]

function DrawingLoader(_: { sheetNumber?: string }) {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      <div
        className="absolute inset-0 opacity-[0.08]"
        style={{
          backgroundImage:
            "linear-gradient(to right, rgba(255,255,255,0.6) 1px, transparent 1px)," +
            "linear-gradient(to bottom, rgba(255,255,255,0.6) 1px, transparent 1px)",
          backgroundSize: "40px 40px",
        }}
      />
      <div
        className="absolute inset-y-0 w-32 bg-gradient-to-r from-transparent via-white/10 to-transparent animate-[drawing-shimmer_1.4s_ease-in-out_infinite]"
        style={{ left: "-8rem" }}
      />
    </div>
  )
}

// Markup tool definitions
const MARKUP_TOOLS: Array<{
  type: MarkupType
  icon: React.ElementType
  label: string
}> = [
  { type: "arrow", icon: ArrowRight, label: "Arrow" },
  { type: "circle", icon: Circle, label: "Circle" },
  { type: "rectangle", icon: Square, label: "Rectangle" },
  { type: "text", icon: Type, label: "Text" },
  { type: "freehand", icon: Pencil, label: "Freehand" },
  { type: "callout", icon: MessageSquare, label: "Callout" },
  { type: "dimension", icon: Ruler, label: "Dimension" },
  { type: "cloud", icon: Cloud, label: "Cloud" },
  { type: "highlight", icon: Highlighter, label: "Highlight" },
]

interface DrawingViewerProps {
  sheet: DrawingSheet
  fileUrl?: string
  markups?: DrawingMarkup[]
  pins?: DrawingPin[]
  highlightedPinId?: string
  onClose: () => void
  onSaveMarkup?: (markup: Omit<DrawingMarkup, "id" | "org_id" | "created_at" | "updated_at">) => Promise<void>
  onDeleteMarkup?: (markupId: string) => Promise<void>
  onCreatePin?: (x: number, y: number) => void
  onPinClick?: (pin: DrawingPin) => void
  readOnly?: boolean
  // Stage 2: Sheet navigation
  sheets?: DrawingSheet[]
  onNavigateSheet?: (sheet: DrawingSheet) => void
  // Phase 1 Performance: Pre-rendered image URLs (optional - falls back to PDF if not provided)
  imageThumbnailUrl?: string | null
  imageMediumUrl?: string | null
  imageFullUrl?: string | null
  imageWidth?: number | null
  imageHeight?: number | null
}

interface Point {
  x: number
  y: number
}

interface MarkupInProgress {
  type: MarkupType
  points: Point[]
  color: string
  strokeWidth: number
  text?: string
}

export function DrawingViewer({
  sheet,
  fileUrl,
  markups = [],
  pins = [],
  highlightedPinId,
  onClose,
  onSaveMarkup,
  onDeleteMarkup,
  onCreatePin,
  onPinClick,
  readOnly = false,
  sheets = [],
  onNavigateSheet,
  // Phase 1 Performance: Pre-rendered images
  imageThumbnailUrl,
  imageMediumUrl,
  imageFullUrl,
  imageWidth,
  imageHeight,
  initialVersionsPanelOpen = false,
}: DrawingViewerProps & { initialVersionsPanelOpen?: boolean }) {
  // Device detection
  const isMobile = useIsMobile()
  const isTouch = useIsTouchDevice()

  // Check if optimized images are available (Phase 1 performance optimization)
  const hasOptimizedImages = !!(imageFullUrl && imageMediumUrl && imageThumbnailUrl)
  const hasTiles =
    !!sheet.tile_base_url &&
    !!sheet.tile_manifest &&
    !!((sheet.tile_manifest as any)?.Image?.Size?.Width ?? sheet.image_width) &&
    !!((sheet.tile_manifest as any)?.Image?.Size?.Height ?? sheet.image_height)

  const isPdfUrl = (value: string) => {
    const lower = value.toLowerCase()
    if (lower.includes("application/pdf")) return true
    // Supabase signed URLs look like ".../file.pdf?token=..."; ignore query params.
    try {
      const u = new URL(value)
      return u.pathname.toLowerCase().endsWith(".pdf")
    } catch {
      return lower.split("?")[0]?.endsWith(".pdf") ?? false
    }
  }

  // Performance tracking
  // If we have optimized images, we're not using PDF rendering
  const isPdf = !hasTiles && !hasOptimizedImages && !!fileUrl && isPdfUrl(fileUrl)
  const {
    markTiming,
    markFullyLoaded,
    getElapsed,
  } = useDrawingPerformance({
    sheetId: sheet.id,
    isPdf,
    onComplete: (metrics) => {
      // Log detailed performance summary
      logPerformanceSummary(metrics)

      // Send to Vercel Analytics
      track("drawing_loaded", {
        sheetId: metrics.sheetId,
        loadTime: metrics.loadTime,
        device: metrics.device,
        connection: metrics.connection || "unknown",
        isPdf: metrics.isPdf,
        fileSize: metrics.fileSize ?? 0,
        usedOptimizedImages: hasOptimizedImages,
      })

      // Performance rating for analytics
      let performanceRating: "excellent" | "good" | "needs_improvement" | "poor"
      if (metrics.loadTime < 300) performanceRating = "excellent"
      else if (metrics.loadTime < 1000) performanceRating = "good"
      else if (metrics.loadTime < 3000) performanceRating = "needs_improvement"
      else performanceRating = "poor"

      track("drawing_performance_rating", {
        rating: performanceRating,
        loadTime: metrics.loadTime,
        device: metrics.device,
        usedOptimizedImages: hasOptimizedImages,
      })
    },
  })

  // View state
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isPanning, setIsPanning] = useState(false)
  const [panStart, setPanStart] = useState({ x: 0, y: 0 })

  // Tool state
  const [activeTool, setActiveTool] = useState<MarkupType | "pan" | "pin" | "photo" | null>("pan")
  const [selectedColor, setSelectedColor] = useState(MARKUP_COLORS[0])
  const [strokeWidth, setStrokeWidth] = useState(2)
  const [showMarkups, setShowMarkups] = useState(true)
  const [showPins, setShowPins] = useState(true)

  // Calibration state (dimension tool scale, stored per sheet version)
  const [calibration, setCalibration] = useState<{
    versionId: string
    feetPerImagePx: number | null
  } | null>(null)
  const [calibrating, setCalibrating] = useState(false)
  const [calibrationPoints, setCalibrationPoints] = useState<Point[]>([])
  const [calibrationDialogOpen, setCalibrationDialogOpen] = useState(false)
  const [calibrationInput, setCalibrationInput] = useState("")
  const [savingCalibration, setSavingCalibration] = useState(false)

  // Photo pin state
  const [photoPins, setPhotoPins] = useState<DrawingPin[]>([])
  const [pendingPhotoPosition, setPendingPhotoPosition] = useState<Point | null>(null)
  const [photoFile, setPhotoFile] = useState<File | null>(null)
  const [photoCaption, setPhotoCaption] = useState("")
  const [photoDialogOpen, setPhotoDialogOpen] = useState(false)
  const [photoUploading, setPhotoUploading] = useState(false)
  const [photoUploadPercent, setPhotoUploadPercent] = useState<number | null>(null)
  const photoInputRef = useRef<HTMLInputElement>(null)

  // Photo pin viewing state
  const [photoView, setPhotoView] = useState<{
    pin: DrawingPin
    loading: boolean
    url?: string
    fileName?: string
    takenAt?: string | null
    error?: string
  } | null>(null)

  // Drawing state
  const [currentMarkup, setCurrentMarkup] = useState<MarkupInProgress | null>(null)
  const [isDrawing, setIsDrawing] = useState(false)
  const [textInput, setTextInput] = useState("")
  const [textDialogOpen, setTextDialogOpen] = useState(false)
  const [textPosition, setTextPosition] = useState<Point | null>(null)

  // History for undo
  const [localMarkups, setLocalMarkups] = useState<MarkupInProgress[]>([])
  const [history, setHistory] = useState<MarkupInProgress[][]>([])

  // Keyboard shortcuts help
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false)

  // New UI state for redesigned viewer
  const [pinsDrawerOpen, setPinsDrawerOpen] = useState(false)
  const [uiHidden, setUiHidden] = useState(false)
  const [sheetListOpen, setSheetListOpen] = useState(false)
  const [sheetListQuery, setSheetListQuery] = useState("")
  const [markupMenuOpen, setMarkupMenuOpen] = useState(false)
  const [versionsPanelOpen, setVersionsPanelOpen] = useState(initialVersionsPanelOpen)
  const [compareSelection, setCompareSelection] = useState<string[]>([])

  // Stage 2: Comparison mode state
  const [showCompare, setShowCompare] = useState(false)
  const [versions, setVersions] = useState<DrawingSheetVersion[]>([])
  const [compareVersions, setCompareVersions] = useState<[string, string] | null>(null)
  const [loadingVersions, setLoadingVersions] = useState(false)

  // Stage 2: Mobile/touch state
  const [longPressPosition, setLongPressPosition] = useState<{ x: number; y: number; clientX: number; clientY: number } | null>(null)
  const [showLongPressMenu, setShowLongPressMenu] = useState(false)

  // Refs
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const pdfCanvasRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  const [contentSize, setContentSize] = useState<{ width: number; height: number } | null>(
    null
  )

  // Tiled viewer (OpenSeadragon) state
  const [osdViewer, setOsdViewer] = useState<any | null>(null)

  const handleOsdReady = useCallback((viewer: any | null) => {
    setOsdViewer((prev: any | null) => (prev === viewer ? prev : viewer))
  }, [])

  // Pan/zoom hot path: viewport-change fires every frame, so the transform is
  // pushed straight to the SVG overlay's DOM node via an imperative handle and
  // kept in a ref for coordinate math. React state only updates for the rare
  // bits (container resize, visible zoom % change).
  const osdMatrixRef = useRef<ImageToScreenMatrix | null>(null)
  const overlayHandleRef = useRef<SVGOverlayHandle | null>(null)

  const setOverlayHandle = useCallback((handle: SVGOverlayHandle | null) => {
    overlayHandleRef.current = handle
    // Replay the latest transform when the overlay mounts after the first emit.
    handle?.setTransform(osdMatrixRef.current)
  }, [])

  const handleOsdTransformChange = useCallback(({ matrix, container, zoom }: any) => {
    osdMatrixRef.current = matrix
    overlayHandleRef.current?.setTransform(matrix)
    setOsdContainer((prev) =>
      prev && prev.width === container.width && prev.height === container.height
        ? prev
        : container
    )
    setOsdZoom((prev) => (Math.round(prev * 100) === Math.round(zoom * 100) ? prev : zoom))
    if (!tiledPerfMarkedRef.current) {
      tiledPerfMarkedRef.current = true
      markTiming("thumbnailLoad")
      markFullyLoaded()
    }
  }, [markTiming, markFullyLoaded])
  const [osdContainer, setOsdContainer] = useState<{ width: number; height: number } | null>(null)
  const [osdZoom, setOsdZoom] = useState<number>(1)
  const tiledPerfMarkedRef = useRef(false)

  const tileBaseUrl = useMemo(() => sheet.tile_base_url ?? null, [sheet.tile_base_url])
  const tileManifest = useMemo(() => (sheet.tile_manifest ?? null) as TileManifest | null, [sheet.tile_manifest])
  const tiledImageSize = useMemo(() => {
    if (!tileManifest?.Image?.Size) {
      const w = sheet.image_width
      const h = sheet.image_height
      if (typeof w === "number" && typeof h === "number") return { width: w, height: h }
      return null
    }
    return { width: tileManifest.Image.Size.Width, height: tileManifest.Image.Size.Height }
  }, [sheet, tileManifest])

  // Rendered-image pixel dimensions: the space markup geometry lives in.
  // Falls back to the displayed content size for legacy PDF/image sheets.
  const rasterImageSize = useMemo(() => {
    if (hasTiles && tiledImageSize) return tiledImageSize
    if (imageWidth && imageHeight) return { width: imageWidth, height: imageHeight }
    return contentSize
  }, [hasTiles, tiledImageSize, imageWidth, imageHeight, contentSize])

  // Load the dimension calibration for this sheet's current version.
  useEffect(() => {
    let cancelled = false
    setCalibration(null)
    getSheetCalibrationAction(sheet.id)
      .then((cal) => {
        if (!cancelled && cal) {
          setCalibration({ versionId: cal.sheet_version_id, feetPerImagePx: cal.feet_per_image_px })
        }
      })
      .catch((error) => {
        console.error("[DrawingViewer] Failed to load calibration:", error)
      })
    return () => {
      cancelled = true
    }
  }, [sheet.id])

  // Per-sheet local state resets when navigating between sheets.
  useEffect(() => {
    setPhotoPins([])
    setCalibrating(false)
    setCalibrationPoints([])
    setPendingPhotoPosition(null)
  }, [sheet.id])

  // Escape cancels calibrate mode (capture phase so the viewer doesn't close).
  useEffect(() => {
    if (!calibrating) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        e.preventDefault()
        setCalibrating(false)
        setCalibrationPoints([])
        setCalibrationDialogOpen(false)
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [calibrating])

  // Keep OpenSeadragon mouse navigation aligned with the active tool.
  useEffect(() => {
    if (!hasTiles || !osdViewer || !osdViewer.gestureSettingsMouse) return
    const enableNav = activeTool === "pan"
    try {
      // OpenSeadragon controls mouse navigation through gesture settings
      osdViewer.gestureSettingsMouse.clickToZoom = enableNav
      osdViewer.gestureSettingsMouse.dblClickToZoom = enableNav
      osdViewer.gestureSettingsMouse.scrollToZoom = enableNav
      // Note: pinchToZoom should probably stay enabled for touch devices
    } catch (e) {
      console.error("[DrawingViewer] Failed to toggle OpenSeadragon nav:", e)
    }
  }, [activeTool, hasTiles, osdViewer])

  // Hide the mobile bottom nav while the drawing viewer is open
  useEffect(() => {
    if (typeof window === "undefined") return
    window.dispatchEvent(
      new CustomEvent("arc-immersive-view", { detail: { active: true } }),
    )
    return () => {
      window.dispatchEvent(
        new CustomEvent("arc-immersive-view", { detail: { active: false } }),
      )
    }
  }, [])

  const getNormalizedCoordsFromTiledClient = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const osdMatrix = osdMatrixRef.current
      if (!containerRef.current || !osdMatrix || !tiledImageSize) return null
      const rect = containerRef.current.getBoundingClientRect()
      const sx = clientX - rect.left
      const sy = clientY - rect.top

      // Invert 2D affine matrix.
      const det = osdMatrix.a * osdMatrix.d - osdMatrix.b * osdMatrix.c
      if (!det) return null

      const dx = sx - osdMatrix.e
      const dy = sy - osdMatrix.f

      const imgX = (osdMatrix.d * dx - osdMatrix.c * dy) / det
      const imgY = (-osdMatrix.b * dx + osdMatrix.a * dy) / det

      const nx = imgX / tiledImageSize.width
      const ny = imgY / tiledImageSize.height
      if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null
      return { x: nx, y: ny }
    },
    [tiledImageSize]
  )

  // Stage 2: Load versions for comparison mode
  const loadVersions = useCallback(async () => {
    if (loadingVersions || versions.length > 0) return
    setLoadingVersions(true)
    try {
      const data = await listSheetVersionsWithUrlsAction(sheet.id)
      setVersions(data)
      // Auto-select first two versions for comparison
      if (data.length >= 2) {
        setCompareVersions([data[0].id, data[1].id])
      }
    } catch (error) {
      console.error("Failed to load versions:", error)
      toast.error("Failed to load versions")
    } finally {
      setLoadingVersions(false)
    }
  }, [sheet.id, loadingVersions, versions.length])

  // Stage 2: Handle compare button click
  const handleCompareClick = useCallback(async () => {
    if (versions.length === 0) {
      await loadVersions()
    }
    if (versions.length >= 2 || !loadingVersions) {
      setShowCompare(true)
    }
  }, [versions.length, loadVersions, loadingVersions])

  // Stage 2: Sheet navigation
  const currentSheetIndex = sheets.findIndex((s) => s.id === sheet.id)
  const hasPrevSheet = currentSheetIndex > 0
  const hasNextSheet = currentSheetIndex < sheets.length - 1

  const goToPrevSheet = useCallback(() => {
    if (hasPrevSheet && onNavigateSheet) {
      onNavigateSheet(sheets[currentSheetIndex - 1])
    }
  }, [hasPrevSheet, onNavigateSheet, sheets, currentSheetIndex])

  const goToNextSheet = useCallback(() => {
    if (hasNextSheet && onNavigateSheet) {
      onNavigateSheet(sheets[currentSheetIndex + 1])
    }
  }, [hasNextSheet, onNavigateSheet, sheets, currentSheetIndex])

  // Stage 2: Touch gestures
  const touchRef = useTouchGestures({
    enabled: isTouch && !textDialogOpen && !showCompare && !hasTiles,
    handlers: {
      onPinchZoom: (scale) => {
        setZoom((z) => Math.max(0.25, Math.min(5, z * scale)))
      },
      onPan: (dx, dy) => {
        setPan((p) => ({ x: p.x + dx, y: p.y + dy }))
      },
      onDoubleTap: () => {
        // Toggle between fit and 100%
        setZoom((z) => (z === 1 ? 2 : 1))
        setPan({ x: 0, y: 0 })
      },
      onSwipeLeft: () => {
        if (hasNextSheet) goToNextSheet()
      },
      onSwipeRight: () => {
        if (hasPrevSheet) goToPrevSheet()
      },
      onLongPress: (position: { x: number; y: number }) => {
        // Position is already normalized (0-1), convert to client coords for menu positioning
        const el = hasTiles ? containerRef.current : contentRef.current
        if (el) {
          const rect = el.getBoundingClientRect()
          const clientX = rect.left + position.x * rect.width
          const clientY = rect.top + position.y * rect.height
          setLongPressPosition({ x: position.x, y: position.y, clientX, clientY })
          setShowLongPressMenu(true)
        }
      },
    },
  })

  // Phase 3: Prefetch adjacent sheets for instant navigation
  usePrefetchAdjacentSheets(sheet.id, sheets, !showCompare)

  // Helper to get normalized coords from client position
  const getNormalizedCoordsFromClient = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      if (hasTiles) {
        return getNormalizedCoordsFromTiledClient(clientX, clientY)
      }
      if (!contentRef.current) return null
      const imgRect = contentRef.current.getBoundingClientRect()
      const x = (clientX - imgRect.left) / imgRect.width
      const y = (clientY - imgRect.top) / imgRect.height
      if (x < 0 || x > 1 || y < 0 || y > 1) return null
      return { x, y }
    },
    [getNormalizedCoordsFromTiledClient, hasTiles]
  )

  // Stage 2: Long press menu handlers
  const handleLongPressAction = useCallback(
    (action: string) => {
      if (!longPressPosition) return

      switch (action) {
        case "drop-pin":
          onCreatePin?.(longPressPosition.x, longPressPosition.y)
          break
        case "new-task":
        case "new-rfi":
        case "new-punch":
          // These will open the create dialog - pass to parent
          onCreatePin?.(longPressPosition.x, longPressPosition.y)
          break
        case "attach-photo": {
          const coords =
            getNormalizedCoordsFromClient(longPressPosition.clientX, longPressPosition.clientY) ?? {
              x: longPressPosition.x,
              y: longPressPosition.y,
            }
          setPendingPhotoPosition(coords)
          photoInputRef.current?.click()
          break
        }
        case "add-measurement":
          setActiveTool("dimension")
          break
      }

      setShowLongPressMenu(false)
      setLongPressPosition(null)
    },
    [longPressPosition, onCreatePin, getNormalizedCoordsFromClient]
  )

  // Stage 2: Handle cluster click - zoom to location
  const handleClusterClick = useCallback(
    (clusterPins: DrawingPin[], center: { x: number; y: number }) => {
      // Zoom in to the cluster location
      setZoom((z) => Math.min(z * 2, 3))
      // Center the view on the cluster (rough calculation)
      if (containerRef.current && contentSize) {
        const containerRect = containerRef.current.getBoundingClientRect()
        const targetX = center.x * contentSize.width * zoom
        const targetY = center.y * contentSize.height * zoom
        setPan({
          x: containerRect.width / 2 - targetX,
          y: containerRect.height / 2 - targetY,
        })
      }
    },
    [contentSize, zoom]
  )

  // Keyboard shortcuts for viewer
  useDrawingKeyboardShortcuts({
    enabled: !textDialogOpen && !showCompare,
    context: "viewer",
    handlers: {
      onZoomIn: () => setZoom((z) => Math.min(z * 1.2, 5)),
      onZoomOut: () => setZoom((z) => Math.max(z / 1.2, 0.5)),
      onFitToScreen: () => {
        setZoom(1)
        setPan({ x: 0, y: 0 })
      },
      onZoom100: () => setZoom(1),
      onToggleMarkup: () => setShowMarkups((v) => !v),
      onTogglePins: () => setShowPins((v) => !v),
      onDownload: () => {
        if (!fileUrl) {
          toast.info("Preparing download…")
          return
        }
        window.open(fileUrl, "_blank")
      },
      onEscape: showCompare ? () => setShowCompare(false) : onClose,
      onShowHelp: () => setShowShortcutsHelp(true),
      onNextSheet: goToNextSheet,
      onPreviousSheet: goToPrevSheet,
    },
  })

  // Auto-load versions when the versions panel is opened
  useEffect(() => {
    if (versionsPanelOpen && versions.length === 0 && !loadingVersions) {
      loadVersions()
    }
  }, [versionsPanelOpen, versions.length, loadingVersions, loadVersions])

  // Toggle all floating UI chrome with "\"
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (textDialogOpen || showCompare) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return
      if (e.key === "\\") {
        e.preventDefault()
        setUiHidden((v) => !v)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [textDialogOpen, showCompare])

  // Get normalized coordinates (0-1)
  const getNormalizedCoords = useCallback(
    (clientX: number, clientY: number): Point | null => {
      if (hasTiles) {
        return getNormalizedCoordsFromTiledClient(clientX, clientY)
      }
      if (!containerRef.current || !contentRef.current) return null

      const imgRect = contentRef.current.getBoundingClientRect()

      // Get position relative to the image
      const x = (clientX - imgRect.left) / imgRect.width
      const y = (clientY - imgRect.top) / imgRect.height

      // Return null if outside image bounds
      if (x < 0 || x > 1 || y < 0 || y > 1) return null

      return { x, y }
    },
    [getNormalizedCoordsFromTiledClient, hasTiles]
  )

  const tiledDraftMarkups = useMemo(() => {
    if (!hasTiles || !tiledImageSize) return []
    const toPx = (p: { x: number; y: number }) => ({
      x: p.x * tiledImageSize.width,
      y: p.y * tiledImageSize.height,
    })

    const drafts = [
      ...localMarkups.map((m) => ({
        type: m.type,
        points: m.points.map(toPx),
        color: m.color,
        strokeWidth: m.strokeWidth,
        text: m.text,
      })),
    ]

    if (currentMarkup) {
      drafts.push({
        type: currentMarkup.type,
        points: currentMarkup.points.map(toPx),
        color: currentMarkup.color,
        strokeWidth: currentMarkup.strokeWidth,
        text: currentMarkup.text,
      })
    }

    // Calibration reference: a dot for the first click, a line once both
    // points are placed.
    if (calibrating && calibrationPoints.length > 0) {
      const px = calibrationPoints.map(toPx)
      if (px.length === 1) {
        drafts.push({
          type: "circle",
          points: [px[0], { x: px[0].x + 6, y: px[0].y }],
          color: "#3B82F6",
          strokeWidth: 2,
          text: undefined,
        })
      } else {
        drafts.push({
          type: "dimension",
          points: px,
          color: "#3B82F6",
          strokeWidth: 2,
          text: undefined,
        })
      }
    }

    return drafts
  }, [currentMarkup, hasTiles, localMarkups, tiledImageSize, calibrating, calibrationPoints])

  // Handle mouse down
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      // In tiled mode, OpenSeadragon owns panning.
      if (hasTiles && activeTool === "pan" && !calibrating) return
      const coords = getNormalizedCoords(e.clientX, e.clientY)
      if (!coords) return

      // Calibrate mode: collect the two reference points, then ask for the
      // real-world distance.
      if (calibrating) {
        setCalibrationPoints((prev) => {
          if (prev.length >= 2) return prev
          const next = [...prev, coords]
          if (next.length === 2) {
            setCalibrationInput("")
            setCalibrationDialogOpen(true)
          }
          return next
        })
        return
      }

      if (activeTool === "photo" && !readOnly) {
        setPendingPhotoPosition(coords)
        photoInputRef.current?.click()
        return
      }

      if (activeTool === "pan") {
        setIsPanning(true)
        setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y })
        return
      }

      if (activeTool === "pin" && onCreatePin) {
        onCreatePin(coords.x, coords.y)
        return
      }

      // Handle markup tools (not pan/pin/photo which are already handled above)
      if (activeTool && activeTool !== "pin" && activeTool !== "photo" && !readOnly) {
        if (activeTool === "text" || activeTool === "callout") {
          setTextPosition(coords)
          setTextDialogOpen(true)
          return
        }

        setIsDrawing(true)
        setCurrentMarkup({
          type: activeTool,
          points: [coords],
          color: selectedColor,
          strokeWidth,
        })
      }
    },
    [activeTool, pan, getNormalizedCoords, selectedColor, strokeWidth, readOnly, onCreatePin, hasTiles, calibrating]
  )

  // Handle mouse move
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (isPanning) {
        if (hasTiles) return
        setPan({
          x: e.clientX - panStart.x,
          y: e.clientY - panStart.y,
        })
        return
      }

      if (!isDrawing || !currentMarkup) return

      const coords = getNormalizedCoords(e.clientX, e.clientY)
      if (!coords) return

      if (currentMarkup.type === "freehand") {
        // Add point for freehand drawing
        setCurrentMarkup((prev) =>
          prev ? { ...prev, points: [...prev.points, coords] } : null
        )
      } else {
        // For other shapes, just update the second point
        setCurrentMarkup((prev) =>
          prev ? { ...prev, points: [prev.points[0], coords] } : null
        )
      }
    },
    [isPanning, panStart, isDrawing, currentMarkup, getNormalizedCoords, hasTiles]
  )

  // Handle mouse up
  const handleMouseUp = useCallback(() => {
    if (isPanning) {
      if (hasTiles) {
        setIsPanning(false)
        return
      }
      setIsPanning(false)
      return
    }

    if (isDrawing && currentMarkup && currentMarkup.points.length >= 2) {
      // Save to local markups
      setHistory((prev) => [...prev, localMarkups])
      setLocalMarkups((prev) => [...prev, currentMarkup])
    }

    setIsDrawing(false)
    setCurrentMarkup(null)
  }, [isPanning, isDrawing, currentMarkup, localMarkups, hasTiles])

  // Handle text submit
  const handleTextSubmit = async () => {
    if (!textPosition || !textInput.trim()) {
      setTextDialogOpen(false)
      setTextInput("")
      setTextPosition(null)
      return
    }

    const markup: MarkupInProgress = {
      type: activeTool === "callout" ? "callout" : "text",
      points: [textPosition],
      color: selectedColor,
      strokeWidth,
      text: textInput,
    }

    setHistory((prev) => [...prev, localMarkups])
    setLocalMarkups((prev) => [...prev, markup])

    setTextDialogOpen(false)
    setTextInput("")
    setTextPosition(null)
  }

  // Undo last markup
  const handleUndo = () => {
    if (history.length === 0) return
    const previousState = history[history.length - 1]
    setLocalMarkups(previousState)
    setHistory((prev) => prev.slice(0, -1))
  }

  // Clear all local markups
  const handleClear = () => {
    if (localMarkups.length === 0) return
    setHistory((prev) => [...prev, localMarkups])
    setLocalMarkups([])
  }

  // Save all markups
  const handleSave = async () => {
    if (!onSaveMarkup || localMarkups.length === 0) return

    try {
      for (const markup of localMarkups) {
        await onSaveMarkup({
          drawing_sheet_id: sheet.id,
          data: {
            type: markup.type,
            points: markup.points.map((p) => [p.x, p.y] as [number, number]),
            color: markup.color,
            strokeWidth: markup.strokeWidth,
            text: markup.text,
          },
          is_private: false,
          share_with_clients: false,
          share_with_subs: false,
        })
      }

      setLocalMarkups([])
      setHistory([])
      toast.success("Markups saved")
    } catch {
      toast.error("Failed to save markups")
    }
  }

  // ---------------------------------------------------------------------------
  // Calibration (dimension tool scale)
  // ---------------------------------------------------------------------------

  const calibrationPixelDistance = useMemo(() => {
    if (calibrationPoints.length < 2 || !rasterImageSize) return null
    const dx = (calibrationPoints[1].x - calibrationPoints[0].x) * rasterImageSize.width
    const dy = (calibrationPoints[1].y - calibrationPoints[0].y) * rasterImageSize.height
    return Math.hypot(dx, dy)
  }, [calibrationPoints, rasterImageSize])

  const exitCalibrateMode = useCallback(() => {
    setCalibrating(false)
    setCalibrationPoints([])
    setCalibrationDialogOpen(false)
    setCalibrationInput("")
  }, [])

  const handleCalibrationSubmit = async () => {
    const feet = parseFeetInches(calibrationInput)
    if (!feet) {
      toast.error('Enter a distance like 24\' 6" or 10.5')
      return
    }
    if (!calibration?.versionId) {
      toast.error("This sheet has no published version to calibrate")
      return
    }
    if (!calibrationPixelDistance || calibrationPixelDistance < 1) {
      toast.error("The two points are too close together — pick a longer known distance")
      setCalibrationDialogOpen(false)
      setCalibrationPoints([])
      return
    }

    setSavingCalibration(true)
    try {
      const saved = unwrapAction(
        await setSheetVersionCalibrationAction({
          sheet_version_id: calibration.versionId,
          feet_per_image_px: feet / calibrationPixelDistance,
        })
      )
      setCalibration({ versionId: saved.sheet_version_id, feetPerImagePx: saved.feet_per_image_px })
      toast.success("Sheet calibrated — dimensions now show real lengths")
      exitCalibrateMode()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save calibration")
    } finally {
      setSavingCalibration(false)
    }
  }

  // ---------------------------------------------------------------------------
  // Photo pins
  // ---------------------------------------------------------------------------

  const photoPreviewUrl = useMemo(
    () => (photoFile ? URL.createObjectURL(photoFile) : null),
    [photoFile]
  )
  useEffect(() => {
    return () => {
      if (photoPreviewUrl) URL.revokeObjectURL(photoPreviewUrl)
    }
  }, [photoPreviewUrl])

  const resetPhotoComposer = useCallback(() => {
    setPhotoDialogOpen(false)
    setPhotoFile(null)
    setPhotoCaption("")
    setPendingPhotoPosition(null)
    setPhotoUploadPercent(null)
  }, [])

  const handlePhotoSubmit = async () => {
    if (!photoFile || !pendingPhotoPosition) return
    setPhotoUploading(true)
    setPhotoUploadPercent(0)
    try {
      const uploaded = await uploadDocumentFileDirect(photoFile, {
        projectId: sheet.project_id,
        category: "photos",
        onProgress: (progress) => setPhotoUploadPercent(progress.percent),
      })
      const pin = unwrapAction(
        await createPhotoFromDrawingAction({
          project_id: sheet.project_id,
          drawing_sheet_id: sheet.id,
          x_position: pendingPhotoPosition.x,
          y_position: pendingPhotoPosition.y,
          file_id: uploaded.id,
          caption: photoCaption.trim() || undefined,
        })
      )
      setPhotoPins((prev) => [...prev, pin])
      toast.success("Photo pinned to drawing")
      resetPhotoComposer()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to attach photo")
    } finally {
      setPhotoUploading(false)
      setPhotoUploadPercent(null)
    }
  }

  const openPhotoPin = useCallback(async (pin: DrawingPin) => {
    setPhotoView({ pin, loading: true })
    try {
      const photo = await getPhotoForPinAction(pin.entity_id)
      if (!photo) {
        setPhotoView({ pin, loading: false, error: "Photo not found" })
        return
      }
      setPhotoView({
        pin,
        loading: false,
        url: photo.url,
        fileName: photo.file_name ?? undefined,
        takenAt: photo.taken_at,
      })
    } catch (error) {
      setPhotoView({
        pin,
        loading: false,
        error: error instanceof Error ? error.message : "Failed to load photo",
      })
    }
  }, [])

  // Photo pins created in this session render immediately without waiting for
  // the parent to refetch the sheet's pins.
  const allPins = useMemo(() => {
    if (photoPins.length === 0) return pins
    const seen = new Set(pins.map((p) => p.id))
    return [...pins, ...photoPins.filter((p) => !seen.has(p.id))]
  }, [pins, photoPins])

  // Photo pins open in-viewer; everything else defers to the parent handler.
  const handlePinActivate = useCallback(
    (pin: DrawingPin) => {
      if (pin.entity_type === "photo") {
        void openPhotoPin(pin)
        return
      }
      onPinClick?.(pin)
    },
    [onPinClick, openPhotoPin]
  )

  // Zoom controls
  const handleZoomIn = () => {
    if (hasTiles && osdViewer) {
      osdViewer.viewport.zoomBy(1.2)
      osdViewer.viewport.applyConstraints()
      return
    }
    setZoom((z) => Math.min(z * 1.2, 5))
  }
  const handleZoomOut = () => {
    if (hasTiles && osdViewer) {
      osdViewer.viewport.zoomBy(1 / 1.2)
      osdViewer.viewport.applyConstraints()
      return
    }
    setZoom((z) => Math.max(z / 1.2, 0.5))
  }
  const computeFitZoom = useCallback((): number => {
    if (!containerRef.current) return 1
    const container = containerRef.current.getBoundingClientRect()
    const naturalW = imageWidth ?? contentSize?.width
    const naturalH = imageHeight ?? contentSize?.height
    if (!naturalW || !naturalH || !container.width || !container.height) return 1
    const padding = 48
    const fitW = (container.width - padding) / naturalW
    const fitH = (container.height - padding) / naturalH
    return Math.min(fitW, fitH, 1)
  }, [contentSize, imageWidth, imageHeight])

  const handleResetView = () => {
    if (hasTiles && osdViewer) {
      osdViewer.viewport.goHome()
      return
    }
    const fit = computeFitZoom()
    setZoom(fit)
    setPan({ x: 0, y: 0 })
  }

  // Auto-fit on first content load for each sheet
  const fittedSheetIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (hasTiles) return
    if (!contentSize) return
    if (fittedSheetIdRef.current === sheet.id) return
    fittedSheetIdRef.current = sheet.id
    const fit = computeFitZoom()
    setZoom(fit)
    setPan({ x: 0, y: 0 })
  }, [contentSize, hasTiles, sheet.id, computeFitZoom])

  // Render markup on canvas
  const renderMarkup = useCallback(
    (
      ctx: CanvasRenderingContext2D,
      markup: MarkupInProgress,
      canvasWidth: number,
      canvasHeight: number,
      feetPerImagePx?: number | null
    ) => {
      ctx.strokeStyle = markup.color
      ctx.fillStyle = markup.color
      ctx.lineWidth = markup.strokeWidth
      ctx.lineCap = "round"
      ctx.lineJoin = "round"

      const toCanvas = (p: Point) => ({
        x: p.x * canvasWidth,
        y: p.y * canvasHeight,
      })

      switch (markup.type) {
        case "arrow": {
          if (markup.points.length < 2) break
          const start = toCanvas(markup.points[0])
          const end = toCanvas(markup.points[1])

          // Draw line
          ctx.beginPath()
          ctx.moveTo(start.x, start.y)
          ctx.lineTo(end.x, end.y)
          ctx.stroke()

          // Draw arrowhead
          const angle = Math.atan2(end.y - start.y, end.x - start.x)
          const headLen = 15
          ctx.beginPath()
          ctx.moveTo(end.x, end.y)
          ctx.lineTo(
            end.x - headLen * Math.cos(angle - Math.PI / 6),
            end.y - headLen * Math.sin(angle - Math.PI / 6)
          )
          ctx.moveTo(end.x, end.y)
          ctx.lineTo(
            end.x - headLen * Math.cos(angle + Math.PI / 6),
            end.y - headLen * Math.sin(angle + Math.PI / 6)
          )
          ctx.stroke()
          break
        }

        case "circle": {
          if (markup.points.length < 2) break
          const center = toCanvas(markup.points[0])
          const edge = toCanvas(markup.points[1])
          const radius = Math.sqrt(
            Math.pow(edge.x - center.x, 2) + Math.pow(edge.y - center.y, 2)
          )
          ctx.beginPath()
          ctx.arc(center.x, center.y, radius, 0, 2 * Math.PI)
          ctx.stroke()
          break
        }

        case "rectangle": {
          if (markup.points.length < 2) break
          const p1 = toCanvas(markup.points[0])
          const p2 = toCanvas(markup.points[1])
          ctx.strokeRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y)
          break
        }

        case "freehand": {
          if (markup.points.length < 2) break
          ctx.beginPath()
          const first = toCanvas(markup.points[0])
          ctx.moveTo(first.x, first.y)
          for (let i = 1; i < markup.points.length; i++) {
            const p = toCanvas(markup.points[i])
            ctx.lineTo(p.x, p.y)
          }
          ctx.stroke()
          break
        }

        case "text":
        case "callout": {
          if (markup.points.length < 1 || !markup.text) break
          const pos = toCanvas(markup.points[0])
          ctx.font = `${14 * (markup.strokeWidth / 2)}px sans-serif`
          ctx.fillText(markup.text, pos.x, pos.y)

          if (markup.type === "callout") {
            // Draw callout bubble
            const metrics = ctx.measureText(markup.text)
            const padding = 8
            ctx.strokeRect(
              pos.x - padding,
              pos.y - 14 * (markup.strokeWidth / 2) - padding,
              metrics.width + padding * 2,
              14 * (markup.strokeWidth / 2) + padding * 2
            )
          }
          break
        }

        case "cloud": {
          if (markup.points.length < 2) break
          const p1 = toCanvas(markup.points[0])
          const p2 = toCanvas(markup.points[1])

          // Draw a cloud-like shape with bumps
          const width = Math.abs(p2.x - p1.x)
          const height = Math.abs(p2.y - p1.y)
          const minX = Math.min(p1.x, p2.x)
          const minY = Math.min(p1.y, p2.y)

          ctx.beginPath()
          const bumps = 8
          const bumpRadius = width / bumps / 2

          for (let i = 0; i < bumps; i++) {
            ctx.arc(
              minX + bumpRadius + (i * width) / bumps,
              minY,
              bumpRadius,
              Math.PI,
              0
            )
          }
          for (let i = 0; i < bumps / 2; i++) {
            ctx.arc(
              minX + width,
              minY + bumpRadius * 2 + (i * height) / (bumps / 2),
              bumpRadius,
              -Math.PI / 2,
              Math.PI / 2
            )
          }
          for (let i = bumps - 1; i >= 0; i--) {
            ctx.arc(
              minX + bumpRadius + (i * width) / bumps,
              minY + height,
              bumpRadius,
              0,
              Math.PI
            )
          }
          for (let i = bumps / 2 - 1; i >= 0; i--) {
            ctx.arc(
              minX,
              minY + bumpRadius * 2 + (i * height) / (bumps / 2),
              bumpRadius,
              Math.PI / 2,
              -Math.PI / 2
            )
          }
          ctx.closePath()
          ctx.stroke()
          break
        }

        case "highlight": {
          if (markup.points.length < 2) break
          const p1 = toCanvas(markup.points[0])
          const p2 = toCanvas(markup.points[1])
          ctx.globalAlpha = 0.3
          ctx.fillRect(
            Math.min(p1.x, p2.x),
            Math.min(p1.y, p2.y),
            Math.abs(p2.x - p1.x),
            Math.abs(p2.y - p1.y)
          )
          ctx.globalAlpha = 1
          break
        }

        case "dimension": {
          if (markup.points.length < 2) break
          const start = toCanvas(markup.points[0])
          const end = toCanvas(markup.points[1])

          // Draw dimension line with ticks
          ctx.beginPath()
          ctx.moveTo(start.x, start.y)
          ctx.lineTo(end.x, end.y)
          ctx.stroke()

          // Draw tick marks
          const angle = Math.atan2(end.y - start.y, end.x - start.x)
          const perpAngle = angle + Math.PI / 2
          const tickLen = 10

          for (const p of [start, end]) {
            ctx.beginPath()
            ctx.moveTo(
              p.x - tickLen * Math.cos(perpAngle),
              p.y - tickLen * Math.sin(perpAngle)
            )
            ctx.lineTo(
              p.x + tickLen * Math.cos(perpAngle),
              p.y + tickLen * Math.sin(perpAngle)
            )
            ctx.stroke()
          }

          // Draw length label
          const dist = Math.sqrt(
            Math.pow(end.x - start.x, 2) + Math.pow(end.y - start.y, 2)
          )
          const midX = (start.x + end.x) / 2
          const midY = (start.y + end.y) / 2
          ctx.font = "12px sans-serif"
          const label =
            feetPerImagePx && feetPerImagePx > 0
              ? formatFeetInches(dist * feetPerImagePx)
              : `${Math.round(dist)}px`
          ctx.fillText(label, midX, midY - 5)
          break
        }
      }
    },
    []
  )

  // Draw canvas (legacy path)
  useEffect(() => {
    if (hasTiles) return
    const canvas = canvasRef.current
    if (!canvas || !contentSize) return

    const ctx = canvas.getContext("2d")
    if (!ctx) return

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    const feetPerImagePx = calibration?.feetPerImagePx ?? null

    // Draw saved markups
    if (showMarkups) {
      for (const markup of markups) {
        renderMarkup(
          ctx,
          {
            type: markup.data.type,
            points: markup.data.points.map(([x, y]) => ({ x, y })),
            color: markup.data.color,
            strokeWidth: markup.data.strokeWidth,
            text: markup.data.text,
          },
          canvas.width,
          canvas.height,
          feetPerImagePx
        )
      }

      // Draw local markups
      for (const markup of localMarkups) {
        renderMarkup(ctx, markup, canvas.width, canvas.height, feetPerImagePx)
      }

      // Draw current markup
      if (currentMarkup) {
        renderMarkup(ctx, currentMarkup, canvas.width, canvas.height, feetPerImagePx)
      }
    }

    // Calibration reference line (drawn regardless of markup visibility)
    if (calibrating && calibrationPoints.length === 2) {
      renderMarkup(
        ctx,
        { type: "dimension", points: calibrationPoints, color: "#3B82F6", strokeWidth: 2 },
        canvas.width,
        canvas.height
      )
    }
  }, [markups, localMarkups, currentMarkup, showMarkups, renderMarkup, contentSize, hasTiles, calibration, calibrating, calibrationPoints])

  useEffect(() => {
    if (!contentSize || !canvasRef.current) return
    canvasRef.current.width = contentSize.width
    canvasRef.current.height = contentSize.height
  }, [contentSize])


  const syncPdfSize = useCallback(() => {
    const pdfContainer = pdfCanvasRef.current
    if (!pdfContainer) return

    // Find the canvas element inside the PDF container
    const canvas = pdfContainer.querySelector('canvas')
    if (!canvas) return

    const rect = canvas.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    setContentSize({ width: rect.width, height: rect.height })
  }, [])

  // Get status color for pins
  const getStatusColor = (status?: string) => {
    switch (status) {
      case "open":
        return "#EF4444" // red
      case "in_progress":
        return "#F97316" // orange
      case "closed":
        return "#22C55E" // green
      case "pending":
        return "#EAB308" // yellow
      case "approved":
        return "#22C55E" // green
      case "rejected":
        return "#EF4444" // red
      default:
        return "#3B82F6" // blue
    }
  }

  // Show comparison viewer if active
  if (showCompare && versions.length >= 2 && compareVersions) {
    return (
      <ComparisonViewer
        sheet={sheet}
        versions={versions}
        leftVersionId={compareVersions[0]}
        rightVersionId={compareVersions[1]}
        onClose={() => setShowCompare(false)}
        onChangeVersions={(left, right) => setCompareVersions([left, right])}
      />
    )
  }

  // Fade chrome while actively drawing; fully hide when uiHidden
  const isInteracting = isDrawing || isPanning
  const chromeClass = cn(
    "transition-opacity duration-200",
    uiHidden
      ? "opacity-0 pointer-events-none"
      : isInteracting
        ? "opacity-30 hover:opacity-100"
        : "opacity-100",
  )

  const filteredSheets = sheets.filter((s) => {
    if (!sheetListQuery) return true
    const q = sheetListQuery.toLowerCase()
    return (
      s.sheet_number?.toLowerCase().includes(q) ||
      s.sheet_title?.toLowerCase().includes(q) ||
      s.discipline?.toLowerCase().includes(q)
    )
  })

  const groupedSheets = groupSheetsByDiscipline(filteredSheets as Array<DrawingSheet & { discipline?: DrawingDiscipline | null }>)
  const orderedDisciplines = DISCIPLINE_SORT_ORDER.filter((d) => groupedSheets.has(d))

  const activeDiscipline = (sheet.discipline as DrawingDiscipline | undefined) ?? "X"
  const ActiveDisciplineIcon = disciplineIcon(activeDiscipline)

  // When searching, auto-expand all matching groups; otherwise expand the current sheet's group.
  const accordionDefault = sheetListQuery
    ? orderedDisciplines.map((d) => String(d))
    : [String(activeDiscipline)]

  const activeToolDef = MARKUP_TOOLS.find((t) => t.type === activeTool)
  const MarkupActiveIcon = activeToolDef?.icon ?? Pencil
  const markupToolActive =
    !!activeTool && activeTool !== "pan" && activeTool !== "pin" && activeTool !== "photo"

  return (
    <div className="fixed inset-0 z-50 bg-neutral-900 overflow-hidden">
      {/* Full-bleed drawing surface */}
      <div
        ref={(el) => {
          ;(containerRef as React.MutableRefObject<HTMLDivElement | null>).current = el
          if (touchRef) {
            ;(touchRef as React.MutableRefObject<HTMLDivElement | null>).current = el
          }
        }}
        className="absolute inset-0 overflow-hidden"
        style={{ cursor: activeTool === "pan" ? "grab" : "crosshair" }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {hasTiles && tileBaseUrl && tileManifest && tiledImageSize ? (
          <div className="absolute inset-0">
            <TiledDrawingViewer
              tileBaseUrl={tileBaseUrl}
              tileManifest={tileManifest}
              thumbnailUrl={imageThumbnailUrl || undefined}
              className="absolute inset-0"
              onReady={handleOsdReady}
              onTransformChange={handleOsdTransformChange}
            />
            <SVGOverlay
              ref={setOverlayHandle}
              container={osdContainer}
              imageSize={tiledImageSize}
              markups={markups}
              draftMarkups={tiledDraftMarkups}
              pins={allPins}
              showMarkups={showMarkups}
              showPins={showPins}
              highlightedPinId={highlightedPinId}
              interactive={!readOnly && activeTool !== "pan"}
              onPinClick={handlePinActivate}
              feetPerImagePx={calibration?.feetPerImagePx ?? null}
            />
          </div>
        ) : !hasOptimizedImages && !fileUrl ? (
          <DrawingLoader sheetNumber={sheet.sheet_number} />
        ) : (
          <>
            {!contentSize && (
              <DrawingLoader sheetNumber={sheet.sheet_number} />
            )}
          <div
            className={cn(
              "absolute inset-0 flex items-center justify-center transition-opacity duration-300",
              !contentSize && "opacity-0",
            )}
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: "center",
            }}
          >
            <div ref={contentRef} className="relative inline-block bg-white shadow-2xl">
              {hasOptimizedImages ? (
                <ImageViewer
                  thumbnailUrl={imageThumbnailUrl!}
                  mediumUrl={imageMediumUrl!}
                  fullUrl={imageFullUrl!}
                  width={imageWidth || 2400}
                  height={imageHeight || 1800}
                  alt={`${sheet.sheet_number} - ${sheet.sheet_title || ""}`}
                  className="max-w-full max-h-full"
                  onLoadStage={(stage: ImageLoadStage) => {
                    // Stages load in parallel and can complete out of order —
                    // size the content on whichever stage lands first.
                    if (imageWidth && imageHeight) {
                      setContentSize((prev) => prev ?? { width: imageWidth, height: imageHeight })
                    }
                    if (stage === "thumbnail") {
                      markTiming("thumbnailLoad")
                    } else if (stage === "medium") {
                      markTiming("mediumLoad")
                    } else if (stage === "full") {
                      markTiming("fullLoad")
                      markFullyLoaded()
                    }
                  }}
                  onError={(error) => {
                    console.error("[DrawingViewer] Image load error:", error)
                  }}
                />
              ) : isPdf ? (
                <div ref={pdfCanvasRef}>
                  <PDFViewer
                    file={fileUrl}
                    onLoadSuccess={() => {
                      syncPdfSize()
                      markTiming("rendering")
                      markFullyLoaded()
                    }}
                    onPdfImported={() => markTiming("pdfImport")}
                    onWorkerLoaded={() => markTiming("workerLoad")}
                    onDocumentLoaded={() => markTiming("pdfParsing")}
                  />
                </div>
              ) : (
                <img
                  ref={imageRef}
                  src={fileUrl}
                  alt={sheet.sheet_number}
                  className="max-w-full max-h-full object-contain bg-white"
                  draggable={false}
                  onDragStart={(e) => e.preventDefault()}
                  onLoad={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect()
                    if (rect.width && rect.height) {
                      setContentSize({ width: rect.width, height: rect.height })
                    }
                    markTiming("fullLoad")
                    markFullyLoaded()
                  }}
                />
              )}

              <canvas
                ref={canvasRef}
                className="absolute inset-0 pointer-events-none"
                style={{
                  width: contentSize?.width ?? "100%",
                  height: contentSize?.height ?? "100%",
                }}
              />

              {showPins && contentSize && (
                <DrawingPinLayer
                  pins={allPins}
                  zoom={zoom}
                  containerWidth={contentSize.width}
                  containerHeight={contentSize.height}
                  onPinClick={handlePinActivate}
                  onClusterClick={handleClusterClick}
                  highlightedPinId={highlightedPinId}
                />
              )}
            </div>
          </div>
          </>
        )}
      </div>

      {/* Top-left: sheet identity + navigation */}
      <div className={cn("absolute top-4 left-4 z-20", chromeClass)}>
        <div className="flex items-center gap-1 rounded-xl border bg-background/95 backdrop-blur-md shadow-lg p-1">
          {sheets.length > 1 && onNavigateSheet && !isMobile && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9"
                onClick={goToPrevSheet}
                disabled={!hasPrevSheet}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-xs text-muted-foreground font-mono tabular-nums w-10 text-center">
                {currentSheetIndex + 1}/{sheets.length}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9"
                onClick={goToNextSheet}
                disabled={!hasNextSheet}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Separator orientation="vertical" className="h-6 mx-1" />
            </>
          )}
          <Popover open={sheetListOpen} onOpenChange={setSheetListOpen}>
            <PopoverTrigger asChild>
              <button className="flex items-center gap-2 px-1.5 h-9 rounded-lg hover:bg-muted/60 transition-colors text-left">
                {sheet.discipline && (
                  <span
                    className={cn(
                      "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border",
                      disciplineGradientClass(sheet.discipline),
                    )}
                  >
                    <ActiveDisciplineIcon className="h-3.5 w-3.5" />
                  </span>
                )}
                <span className="text-sm font-semibold">{sheet.sheet_number}</span>
                {sheets.length > 1 && (
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </button>
            </PopoverTrigger>
            {sheets.length > 1 && onNavigateSheet && (
              <PopoverContent align="start" className="w-[360px] max-md:w-[calc(100vw-2rem)] p-0">
                <div className="p-2 border-b">
                  <Input
                    placeholder="Search sheets..."
                    value={sheetListQuery}
                    onChange={(e) => setSheetListQuery(e.target.value)}
                    className="h-8"
                    autoFocus
                  />
                </div>
                <ScrollArea className="h-[420px]">
                  {orderedDisciplines.length === 0 ? (
                    <div className="text-center text-sm text-muted-foreground py-10">
                      No sheets match
                    </div>
                  ) : (
                    <Accordion
                      type="multiple"
                      defaultValue={accordionDefault}
                      key={sheetListQuery || "default"}
                      className="px-1 py-1"
                    >
                      {orderedDisciplines.map((d) => {
                        const sheetsIn = groupedSheets.get(d) ?? []
                        const DIcon = disciplineIcon(d)
                        const label = DISCIPLINE_LABELS[d] ?? String(d)
                        return (
                          <AccordionItem
                            key={d}
                            value={String(d)}
                            className="border-b-0"
                          >
                            <AccordionTrigger className="py-1.5 px-1.5 hover:no-underline rounded-md hover:bg-muted/40">
                              <div className="flex items-center gap-2 flex-1 min-w-0">
                                <span
                                  className={cn(
                                    "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border",
                                    disciplineGradientClass(d),
                                  )}
                                >
                                  <DIcon className="h-3 w-3" />
                                </span>
                                <span className="text-sm font-medium truncate">
                                  {label}
                                </span>
                                <span className="text-xs text-muted-foreground ml-auto mr-2">
                                  {sheetsIn.length}
                                </span>
                              </div>
                            </AccordionTrigger>
                            <AccordionContent className="pb-1">
                              <div className="space-y-0.5">
                                {sheetsIn.map((s) => (
                                  <button
                                    key={s.id}
                                    onClick={() => {
                                      onNavigateSheet(s)
                                      setSheetListOpen(false)
                                      setSheetListQuery("")
                                    }}
                                    className={cn(
                                      "w-full text-left rounded-md px-2 py-1.5 hover:bg-muted/60 flex items-center gap-2 pl-8",
                                      s.id === sheet.id && "bg-muted",
                                    )}
                                  >
                                    <span className="text-sm font-medium flex-shrink-0 font-mono truncate w-14">
                                      {s.sheet_number}
                                    </span>
                                    <span className="text-sm text-muted-foreground truncate flex-1">
                                      {s.sheet_title ?? ""}
                                    </span>
                                  </button>
                                ))}
                              </div>
                            </AccordionContent>
                          </AccordionItem>
                        )
                      })}
                    </Accordion>
                  )}
                </ScrollArea>
              </PopoverContent>
            )}
          </Popover>
        </div>
      </div>

      {/* Top-right: view + actions */}
      <div
        className={cn(
          "absolute top-4 right-4 z-20 flex items-center gap-2",
          chromeClass,
        )}
      >
        {/* Mobile: a single compact pill — overflow menu + close. */}
        <div className="flex items-center gap-0.5 rounded-xl border bg-background/95 backdrop-blur-md shadow-lg p-1 md:hidden">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-9 w-9">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onClick={() => setShowMarkups((v) => !v)}>
                {showMarkups ? (
                  <EyeOff className="mr-2 h-4 w-4" />
                ) : (
                  <Eye className="mr-2 h-4 w-4" />
                )}
                {showMarkups ? "Hide markups" : "Show markups"}
              </DropdownMenuItem>
              {allPins.length > 0 && (
                <DropdownMenuItem onClick={() => setPinsDrawerOpen(true)}>
                  <Layers className="mr-2 h-4 w-4" />
                  Linked items
                  <Badge variant="secondary" className="ml-auto">
                    {allPins.length}
                  </Badge>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => setVersionsPanelOpen(true)}>
                <GitCompare className="mr-2 h-4 w-4" />
                Versions
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleResetView}>
                <Maximize2 className="mr-2 h-4 w-4" />
                Fit to screen
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {fileUrl && (
                <DropdownMenuItem asChild>
                  <a href={fileUrl} download target="_blank" rel="noreferrer">
                    <Download className="mr-2 h-4 w-4" />
                    Download
                  </a>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={() =>
                  window.open(`/api/drawings/export?sheetId=${sheet.id}`, "_blank")
                }
              >
                <FileDown className="mr-2 h-4 w-4" />
                Download with markups
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="hidden items-center gap-0.5 rounded-xl border bg-background/95 backdrop-blur-md shadow-lg p-1 md:flex">
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9"
            onClick={handleZoomOut}
            title="Zoom out"
          >
            <ZoomOut className="h-4 w-4" />
          </Button>
          <span className="text-xs font-mono tabular-nums w-11 text-center">
            {Math.round((hasTiles ? osdZoom : zoom) * 100)}%
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9"
            onClick={handleZoomIn}
            title="Zoom in"
          >
            <ZoomIn className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9"
            onClick={handleResetView}
            title="Fit to screen (0)"
          >
            <Maximize2 className="h-4 w-4" />
          </Button>
        </div>

        <div className="hidden items-center gap-0.5 rounded-xl border bg-background/95 backdrop-blur-md shadow-lg p-1 md:flex">
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={showMarkups ? "secondary" : "ghost"}
                  size="icon"
                  className="h-9 w-9"
                  onClick={() => setShowMarkups(!showMarkups)}
                >
                  {showMarkups ? (
                    <Eye className="h-4 w-4" />
                  ) : (
                    <EyeOff className="h-4 w-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {showMarkups ? "Hide" : "Show"} markups
              </TooltipContent>
            </Tooltip>

            {allPins.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={pinsDrawerOpen ? "secondary" : "ghost"}
                    size="icon"
                    className="h-9 w-9 relative"
                    onClick={() => setPinsDrawerOpen((v) => !v)}
                  >
                    {pinsDrawerOpen ? (
                      <PanelRightClose className="h-4 w-4" />
                    ) : (
                      <PanelRight className="h-4 w-4" />
                    )}
                    {!pinsDrawerOpen && (
                      <span className="absolute -top-1 -right-1 h-4 min-w-[16px] px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-medium flex items-center justify-center">
                        {allPins.length}
                      </span>
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  Linked items ({allPins.length})
                </TooltipContent>
              </Tooltip>
            )}

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={versionsPanelOpen ? "secondary" : "ghost"}
                  className="h-9 px-3 gap-2"
                  onClick={() => setVersionsPanelOpen((v) => !v)}
                >
                  <History className="h-4 w-4" />
                  <span className="hidden sm:inline">Versions</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Version History</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                {fileUrl ? (
                  <Button variant="ghost" size="icon" className="h-9 w-9" asChild>
                    <a href={fileUrl} download target="_blank" rel="noreferrer">
                      <Download className="h-4 w-4" />
                    </a>
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9"
                    disabled
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                )}
              </TooltipTrigger>
              <TooltipContent side="bottom">Download</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9"
                  onClick={() =>
                    window.open(`/api/drawings/export?sheetId=${sheet.id}`, "_blank")
                  }
                >
                  <FileDown className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Download with markups</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9"
                  onClick={() => setShowShortcutsHelp(true)}
                >
                  <Keyboard className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Shortcuts (?)</TooltipContent>
            </Tooltip>

            <Separator orientation="vertical" className="h-6 mx-1" />

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9"
                  onClick={onClose}
                >
                  <X className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Close (Esc)</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      {/* Versions panel (floats below top-right chrome) */}
      {versionsPanelOpen && (
        <div
          className={cn(
            "absolute top-[72px] right-4 w-80 z-20 rounded-xl border bg-background/95 backdrop-blur-md shadow-xl flex flex-col",
            "max-md:inset-x-3 max-md:top-16 max-md:w-auto",
            uiHidden && "opacity-0 pointer-events-none",
          )}
        >
          <div className="p-3 border-b flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium">
              <GitCompare className="h-4 w-4" />
              Versions
              {versions.length > 0 && (
                <Badge variant="secondary" className="ml-1">
                  {versions.length}
                </Badge>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => {
                setVersionsPanelOpen(false)
                setCompareSelection([])
              }}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>

          <div className="px-3 py-2 text-xs text-muted-foreground border-b">
            {loadingVersions
              ? "Loading versions…"
              : versions.length < 2
                ? "Only one version available"
                : compareSelection.length === 0
                  ? "Select two versions to compare"
                  : compareSelection.length === 1
                    ? "Select one more version"
                    : "Ready to compare"}
          </div>

          <ScrollArea className="flex-1 max-h-[50vh]">
            <div className="p-1.5 space-y-1">
              {loadingVersions && versions.length === 0 ? (
                <div className="flex items-center justify-center py-8">
                  <div className="h-5 w-5 rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground animate-spin" />
                </div>
              ) : versions.length === 0 ? (
                <div className="text-center text-xs text-muted-foreground py-8">
                  No versions
                </div>
              ) : (
                versions.map((v, idx) => {
                  const selIndex = compareSelection.indexOf(v.id)
                  const selected = selIndex >= 0
                  const isCurrent = idx === 0
                  const selLabel =
                    selIndex === 0 ? "A" : selIndex === 1 ? "B" : null
                  return (
                    <button
                      key={v.id}
                      onClick={() => {
                        setCompareSelection((prev) => {
                          if (prev.includes(v.id)) {
                            return prev.filter((id) => id !== v.id)
                          }
                          if (prev.length >= 2) {
                            return [prev[1], v.id]
                          }
                          return [...prev, v.id]
                        })
                      }}
                      className={cn(
                        "w-full text-left rounded-lg border p-2.5 transition-colors flex items-start gap-2.5 hover:bg-muted/50",
                        selected && "border-primary bg-primary/5",
                      )}
                    >
                      <div
                        className={cn(
                          "mt-0.5 flex-shrink-0 h-5 w-5 rounded-md border flex items-center justify-center text-[10px] font-semibold transition-colors",
                          selected
                            ? "bg-primary border-primary text-primary-foreground"
                            : "border-muted-foreground/30 text-muted-foreground",
                        )}
                      >
                        {selLabel ?? ""}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-semibold">
                            v{versions.length - idx}
                          </span>
                          {isCurrent && (
                            <Badge
                              variant="secondary"
                              className="text-[9px] py-0 h-4"
                            >
                              CURRENT
                            </Badge>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {[
                            v.revision_label,
                            v.creator_name,
                            new Date(v.created_at).toLocaleDateString(undefined, {
                              month: "short",
                              day: "numeric",
                              year: "numeric",
                            }),
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                        {v.change_description && (
                          <div className="text-xs text-muted-foreground/80 mt-1 line-clamp-2">
                            {v.change_description}
                          </div>
                        )}
                      </div>
                    </button>
                  )
                })
              )}
            </div>
          </ScrollArea>

          <div className="p-2 border-t">
            <Button
              size="sm"
              className="w-full"
              disabled={compareSelection.length !== 2}
              onClick={() => {
                if (compareSelection.length === 2) {
                  setCompareVersions([compareSelection[0], compareSelection[1]])
                  setShowCompare(true)
                }
              }}
            >
              <GitCompare className="h-4 w-4 mr-2" />
              Compare{compareSelection.length === 2 ? " A vs B" : ""}
            </Button>
          </div>
        </div>
      )}

      {/* Bottom-center: tool dock */}
      {!readOnly && !isMobile && (
        <div
          className={cn(
            "absolute bottom-6 left-1/2 -translate-x-1/2 z-20",
            chromeClass,
          )}
        >
          <div className="flex items-center gap-0.5 rounded-2xl border bg-background/95 backdrop-blur-md shadow-xl p-1.5">
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={activeTool === "pan" ? "secondary" : "ghost"}
                    size="icon"
                    className="h-10 w-10"
                    onClick={() => setActiveTool("pan")}
                  >
                    <Move className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Pan</TooltipContent>
              </Tooltip>

              {onCreatePin && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant={activeTool === "pin" ? "secondary" : "ghost"}
                      size="icon"
                      className="h-10 w-10"
                      onClick={() => setActiveTool("pin")}
                    >
                      <MapPin className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">Drop pin</TooltipContent>
                </Tooltip>
              )}

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={activeTool === "photo" ? "secondary" : "ghost"}
                    size="icon"
                    className="h-10 w-10"
                    onClick={() => setActiveTool("photo")}
                  >
                    <Camera className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Photo pin — click the sheet to attach a photo</TooltipContent>
              </Tooltip>

              <Separator orientation="vertical" className="h-6 mx-1" />

              <Popover open={markupMenuOpen} onOpenChange={setMarkupMenuOpen}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <PopoverTrigger asChild>
                      <Button
                        variant={markupToolActive ? "secondary" : "ghost"}
                        size="sm"
                        className="h-10 gap-1.5 px-2.5"
                      >
                        <MarkupActiveIcon className="h-4 w-4" />
                        <div
                          className="h-3.5 w-3.5 rounded-full border border-background shadow-sm"
                          style={{ backgroundColor: selectedColor }}
                        />
                        <ChevronDown className="h-3 w-3 opacity-60" />
                      </Button>
                    </PopoverTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="top">Markup tools</TooltipContent>
                </Tooltip>
                <PopoverContent side="top" align="center" className="w-64 p-3">
                  <div className="space-y-3">
                    <div>
                      <Label className="text-xs text-muted-foreground mb-2 block">
                        Tool
                      </Label>
                      <div className="grid grid-cols-5 gap-1">
                        {MARKUP_TOOLS.map((tool) => (
                          <Tooltip key={tool.type}>
                            <TooltipTrigger asChild>
                              <Button
                                variant={
                                  activeTool === tool.type ? "secondary" : "ghost"
                                }
                                size="icon"
                                className="h-9 w-9"
                                onClick={() => {
                                  setActiveTool(tool.type)
                                  setMarkupMenuOpen(false)
                                }}
                              >
                                <tool.icon className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent side="bottom">
                              {tool.label}
                            </TooltipContent>
                          </Tooltip>
                        ))}
                      </div>
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground mb-2 block">
                        Color
                      </Label>
                      <div className="flex gap-1.5 flex-wrap">
                        {MARKUP_COLORS.map((color) => (
                          <button
                            key={color}
                            className={cn(
                              "h-6 w-6 rounded-full border-2 transition-transform hover:scale-110",
                              selectedColor === color
                                ? "border-foreground"
                                : "border-transparent",
                            )}
                            style={{ backgroundColor: color }}
                            onClick={() => setSelectedColor(color)}
                          />
                        ))}
                      </div>
                    </div>
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <Label className="text-xs text-muted-foreground">
                          Stroke
                        </Label>
                        <span className="text-xs text-muted-foreground font-mono">
                          {strokeWidth}px
                        </span>
                      </div>
                      <Slider
                        value={[strokeWidth]}
                        min={1}
                        max={8}
                        step={1}
                        onValueChange={([v]) => setStrokeWidth(v)}
                      />
                    </div>
                    {activeTool === "dimension" && !calibration?.feetPerImagePx && (
                      <p className="text-xs text-muted-foreground border-t pt-2">
                        Calibrate this sheet to get real dimensions.
                      </p>
                    )}
                  </div>
                </PopoverContent>
              </Popover>

              {activeTool === "dimension" && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant={calibrating ? "secondary" : "ghost"}
                      size="sm"
                      className="h-10 gap-1.5 px-2.5"
                      onClick={() => {
                        if (calibrating) {
                          exitCalibrateMode()
                        } else {
                          setCalibrating(true)
                          setCalibrationPoints([])
                        }
                      }}
                    >
                      <Crosshair className="h-4 w-4" />
                      Calibrate
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    {calibration?.feetPerImagePx
                      ? "Recalibrate the sheet scale"
                      : "Calibrate this sheet to get real dimensions"}
                  </TooltipContent>
                </Tooltip>
              )}

              <div
                className={cn(
                  "flex items-center gap-0.5 overflow-hidden transition-[max-width,opacity,margin] duration-300 ease-out",
                  markupToolActive || localMarkups.length > 0
                    ? "max-w-[280px] opacity-100 ml-1"
                    : "max-w-0 opacity-0 ml-0 pointer-events-none",
                )}
              >
                <Separator orientation="vertical" className="h-6 mx-1" />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-10 w-10"
                      onClick={handleUndo}
                      disabled={history.length === 0}
                    >
                      <Undo2 className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">Undo</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-10 w-10"
                      onClick={handleClear}
                      disabled={localMarkups.length === 0}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">Clear drafts</TooltipContent>
                </Tooltip>
                <Separator orientation="vertical" className="h-6 mx-1" />
                <Button
                  variant="default"
                  size="sm"
                  className="h-10 rounded-xl gap-1.5 whitespace-nowrap"
                  onClick={handleSave}
                  disabled={localMarkups.length === 0 || !onSaveMarkup}
                >
                  <Save className="h-4 w-4" />
                  Save
                  {localMarkups.length > 0 && ` (${localMarkups.length})`}
                </Button>
              </div>
            </TooltipProvider>
          </div>
        </div>
      )}

      {/* Right pins drawer */}
      {pinsDrawerOpen && allPins.length > 0 && (
        <div
          className={cn(
            "absolute top-20 right-4 bottom-24 w-72 z-20 rounded-xl border bg-background/95 backdrop-blur-md shadow-xl flex flex-col",
            "max-md:inset-x-3 max-md:top-16 max-md:bottom-28 max-md:w-auto",
            uiHidden && "opacity-0 pointer-events-none",
          )}
        >
          <div className="p-3 border-b flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Layers className="h-4 w-4" />
              Linked items
              <Badge variant="secondary" className="ml-1">
                {allPins.length}
              </Badge>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setPinsDrawerOpen(false)}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
          <ScrollArea className="flex-1">
            <div className="p-2 space-y-1.5">
              {allPins.map((pin) => (
                <button
                  key={pin.id}
                  onClick={() => handlePinActivate(pin)}
                  className={cn(
                    "w-full p-2.5 rounded-lg border hover:bg-muted/50 text-left transition-colors",
                    highlightedPinId === pin.id && "border-primary bg-primary/5",
                  )}
                >
                  <div className="flex items-start gap-2">
                    {pin.entity_type === "photo" ? (
                      <Camera
                        className="h-4 w-4 flex-shrink-0 mt-0.5"
                        style={{ color: getStatusColor(pin.status) }}
                      />
                    ) : (
                      <MapPin
                        className="h-4 w-4 flex-shrink-0 mt-0.5"
                        style={{ color: getStatusColor(pin.status) }}
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">
                        {pin.entity_title ?? pin.label ?? "Untitled"}
                      </div>
                      <div className="flex items-center gap-1.5 mt-1">
                        <Badge
                          variant="outline"
                          className="text-[10px] py-0 h-4"
                        >
                          {PIN_ENTITY_TYPE_LABELS[pin.entity_type]}
                        </Badge>
                        {pin.status && (
                          <span className="text-[10px] text-muted-foreground capitalize">
                            {pin.status}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </ScrollArea>
        </div>
      )}

      {/* Mobile: centered sheet-navigation pill. Long-press handles creation. */}
      {sheets.length > 1 && onNavigateSheet && (
        <div
          className={cn(
            "absolute inset-x-0 bottom-0 z-20 flex justify-center md:hidden",
            "pb-[calc(1rem+env(safe-area-inset-bottom))]",
            chromeClass,
          )}
        >
          <div className="flex items-center gap-1 rounded-full border bg-background/95 backdrop-blur-md shadow-lg p-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-11 w-11 rounded-full"
              onClick={goToPrevSheet}
              disabled={!hasPrevSheet}
            >
              <ChevronLeft className="h-5 w-5" />
            </Button>
            <span className="min-w-14 text-center text-sm font-mono tabular-nums">
              {currentSheetIndex + 1} / {sheets.length}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-11 w-11 rounded-full"
              onClick={goToNextSheet}
              disabled={!hasNextSheet}
            >
              <ChevronRight className="h-5 w-5" />
            </Button>
          </div>
        </div>
      )}

      {/* Long press context menu */}
      <LongPressMenu
        open={showLongPressMenu}
        onClose={() => {
          setShowLongPressMenu(false)
          setLongPressPosition(null)
        }}
        onAction={handleLongPressAction}
        position={
          longPressPosition
            ? { x: longPressPosition.clientX, y: longPressPosition.clientY }
            : { x: 0, y: 0 }
        }
      />

      {/* Calibrate mode hint */}
      {calibrating && (
        <div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-20 rounded-lg border bg-background/95 backdrop-blur-md shadow-lg px-3 py-1.5 text-xs text-muted-foreground pointer-events-none">
          {calibrationPoints.length === 0
            ? "Click the two ends of a known dimension — Esc to cancel"
            : calibrationPoints.length === 1
              ? "Click the second point — Esc to cancel"
              : "Enter the real-world distance"}
        </div>
      )}

      {/* Hidden photo input (camera-first on mobile) */}
      <input
        ref={photoInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0] ?? null
          e.target.value = ""
          if (!file) {
            setPendingPhotoPosition(null)
            return
          }
          setPhotoFile(file)
          setPhotoCaption("")
          setPhotoDialogOpen(true)
        }}
      />

      {/* Calibration distance dialog */}
      <Dialog
        open={calibrationDialogOpen}
        onOpenChange={(open) => {
          if (!open && !savingCalibration) {
            setCalibrationDialogOpen(false)
            setCalibrationPoints([])
          }
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Set sheet scale</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="calibration-distance">Known distance between the two points</Label>
            <Input
              id="calibration-distance"
              value={calibrationInput}
              onChange={(e) => setCalibrationInput(e.target.value)}
              placeholder={'e.g. 24\' 6" or 10.5'}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && !savingCalibration) {
                  handleCalibrationSubmit()
                }
              }}
            />
            <p className="text-xs text-muted-foreground">
              Accepts feet-and-inches (24&apos; 6&quot;) or decimal feet (10.5). Dimension
              markups on this sheet will show real lengths.
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={savingCalibration}
              onClick={() => {
                setCalibrationDialogOpen(false)
                setCalibrationPoints([])
              }}
            >
              Cancel
            </Button>
            <Button onClick={handleCalibrationSubmit} disabled={savingCalibration || !calibrationInput.trim()}>
              {savingCalibration ? "Saving…" : "Save scale"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Photo pin composer */}
      <Dialog
        open={photoDialogOpen}
        onOpenChange={(open) => {
          if (!open && !photoUploading) resetPhotoComposer()
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Camera className="h-5 w-5" />
              Attach photo to drawing
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {photoPreviewUrl && (
              <div className="border bg-muted/30 flex items-center justify-center max-h-64 overflow-hidden">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photoPreviewUrl}
                  alt={photoFile?.name ?? "Photo preview"}
                  className="max-h-64 w-auto object-contain"
                />
              </div>
            )}
            <div>
              <Label htmlFor="photo-caption">Caption (optional)</Label>
              <Input
                id="photo-caption"
                value={photoCaption}
                onChange={(e) => setPhotoCaption(e.target.value)}
                placeholder="What does this show?"
                disabled={photoUploading}
              />
            </div>
            {photoUploading && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <div className="h-4 w-4 rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground animate-spin" />
                Uploading
                {photoUploadPercent !== null ? ` ${photoUploadPercent}%` : "…"}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={resetPhotoComposer} disabled={photoUploading}>
              Cancel
            </Button>
            <Button onClick={handlePhotoSubmit} disabled={photoUploading || !photoFile}>
              {photoUploading ? "Uploading…" : "Pin photo"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Photo pin viewer */}
      <Dialog open={!!photoView} onOpenChange={(open) => !open && setPhotoView(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Camera className="h-5 w-5" />
              {photoView?.pin.label ?? photoView?.fileName ?? "Photo"}
            </DialogTitle>
          </DialogHeader>
          {photoView?.loading ? (
            <div className="flex items-center justify-center py-16">
              <div className="h-5 w-5 rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground animate-spin" />
            </div>
          ) : photoView?.error ? (
            <div className="text-sm text-destructive py-8 text-center">{photoView.error}</div>
          ) : photoView?.url ? (
            <div className="space-y-3">
              <div className="border bg-muted/30 flex items-center justify-center max-h-[60vh] overflow-hidden">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photoView.url}
                  alt={photoView.pin.label ?? photoView.fileName ?? "Photo"}
                  className="max-h-[60vh] w-auto object-contain"
                />
              </div>
              <div className="text-xs text-muted-foreground">
                {[
                  photoView.pin.creator_name,
                  new Date(photoView.takenAt ?? photoView.pin.created_at).toLocaleDateString(
                    undefined,
                    { month: "short", day: "numeric", year: "numeric" },
                  ),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Text input dialog */}
      <Dialog open={textDialogOpen} onOpenChange={setTextDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {activeTool === "callout" ? "Add Callout" : "Add Text"}
            </DialogTitle>
          </DialogHeader>
          <div>
            <Label htmlFor="text">Text</Label>
            <Input
              id="text"
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              placeholder="Enter text..."
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleTextSubmit()
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTextDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleTextSubmit}>Add</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Keyboard shortcuts help */}
      <KeyboardShortcutsHelp
        open={showShortcutsHelp}
        onOpenChange={setShowShortcutsHelp}
        context="viewer"
      />
    </div>
  )
}
