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
  ChevronLeft,
  ChevronRight,
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
import { PIN_ENTITY_TYPE_LABELS } from "@/lib/validation/drawings"
import type { DrawingSheet, DrawingSheetVersion, DrawingMarkup, DrawingPin, MarkupType } from "@/app/(app)/drawings/actions"
import { listSheetVersionsWithUrlsAction } from "@/app/(app)/drawings/actions"
import { useDrawingKeyboardShortcuts } from "./use-drawing-keyboard-shortcuts"
import { KeyboardShortcutsHelp } from "./keyboard-shortcuts-help"
import { ComparisonViewer } from "./comparison-viewer"
import { DrawingPinLayer } from "./drawing-pin-layer"
import { SheetThumbnailStrip } from "./sheet-thumbnail-strip"
import { useTouchGestures } from "./use-touch-gestures"
import { MobileDrawingToolbar } from "./mobile-drawing-toolbar"
import { LongPressMenu } from "./long-press-menu"
import { usePrefetchAdjacentSheets } from "./use-prefetch-sheets"
import { useIsMobile } from "@/components/ui/use-mobile"
import { useIsTouchDevice } from "@/lib/hooks/use-is-touch-device"
import { TiledDrawingViewer, type ImageToScreenMatrix, type TileManifest } from "./viewer/tiled-drawing-viewer"
import { SVGOverlay } from "./viewer/svg-overlay"

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
        pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`

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
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-muted-foreground">Loading PDF...</div>
      </div>
    )
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
}: DrawingViewerProps) {
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
        fileSize: metrics.fileSize,
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
  const [activeTool, setActiveTool] = useState<MarkupType | "pan" | "pin" | null>("pan")
  const [selectedColor, setSelectedColor] = useState(MARKUP_COLORS[0])
  const [strokeWidth, setStrokeWidth] = useState(2)
  const [showMarkups, setShowMarkups] = useState(true)
  const [showPins, setShowPins] = useState(true)

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

  // Stage 2: Comparison mode state
  const [showCompare, setShowCompare] = useState(false)
  const [versions, setVersions] = useState<DrawingSheetVersion[]>([])
  const [compareVersions, setCompareVersions] = useState<[string, string] | null>(null)
  const [loadingVersions, setLoadingVersions] = useState(false)

  // Stage 2: Mobile/touch state
  const [longPressPosition, setLongPressPosition] = useState<{ x: number; y: number; clientX: number; clientY: number } | null>(null)
  const [showLongPressMenu, setShowLongPressMenu] = useState(false)
  const [isMarkupMode, setIsMarkupMode] = useState(false)

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
    setOsdViewer(viewer)
  }, [])

  const handleOsdTransformChange = useCallback(({ matrix, container, zoom }: any) => {
    setOsdMatrix(matrix)
    setOsdContainer(container)
    setOsdZoom(zoom)
    if (!tiledPerfMarkedRef.current) {
      tiledPerfMarkedRef.current = true
      markTiming("thumbnailLoad")
      markFullyLoaded()
    }
  }, [])
  const [osdMatrix, setOsdMatrix] = useState<ImageToScreenMatrix | null>(null)
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

  const getNormalizedCoordsFromTiledClient = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
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
    [osdMatrix, tiledImageSize]
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
        case "attach-photo":
          toast.info("Attach photo feature coming soon")
          break
        case "add-measurement":
          setActiveTool("dimension")
          break
      }

      setShowLongPressMenu(false)
      setLongPressPosition(null)
    },
    [longPressPosition, onCreatePin]
  )

  // Stage 2: Mobile toolbar handlers
  const handleMobileDropPin = useCallback(() => {
    setActiveTool("pin")
    toast.info("Tap on the drawing to place a pin")
  }, [])

  const handleMobileMarkupToggle = useCallback(() => {
    setIsMarkupMode((m) => !m)
    if (!isMarkupMode) {
      setActiveTool("freehand")
    } else {
      setActiveTool("pan")
    }
  }, [isMarkupMode])

  const handleMobileCamera = useCallback(() => {
    toast.info("Camera feature coming soon")
  }, [])

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

    return drafts
  }, [currentMarkup, hasTiles, localMarkups, tiledImageSize])

  // Handle mouse down
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      // In tiled mode, OpenSeadragon owns panning.
      if (hasTiles && activeTool === "pan") return
      const coords = getNormalizedCoords(e.clientX, e.clientY)
      if (!coords) return

      if (activeTool === "pan") {
        setIsPanning(true)
        setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y })
        return
      }

      if (activeTool === "pin" && onCreatePin) {
        onCreatePin(coords.x, coords.y)
        return
      }

      // Handle markup tools (not pan or pin which are already handled above)
      if (activeTool && activeTool !== "pin" && !readOnly) {
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
    [activeTool, pan, getNormalizedCoords, selectedColor, strokeWidth, readOnly, onCreatePin, hasTiles]
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
  const handleResetView = () => {
    if (hasTiles && osdViewer) {
      osdViewer.viewport.goHome()
      return
    }
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }

  // Render markup on canvas
  const renderMarkup = useCallback(
    (
      ctx: CanvasRenderingContext2D,
      markup: MarkupInProgress,
      canvasWidth: number,
      canvasHeight: number
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
          ctx.fillText(`${Math.round(dist)}px`, midX, midY - 5)
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
          canvas.height
        )
      }

      // Draw local markups
      for (const markup of localMarkups) {
        renderMarkup(ctx, markup, canvas.width, canvas.height)
      }

      // Draw current markup
      if (currentMarkup) {
        renderMarkup(ctx, currentMarkup, canvas.width, canvas.height)
      }
    }
  }, [markups, localMarkups, currentMarkup, showMarkups, renderMarkup, contentSize])

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

  return (
    <div className="fixed inset-0 z-50 bg-background">
      <div className="h-full w-full flex flex-col">
        {/* Header with tools */}
        <div className="p-4 border-b flex-shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {/* Navigation buttons */}
              {sheets.length > 1 && onNavigateSheet && (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={goToPrevSheet}
                    disabled={!hasPrevSheet}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    {currentSheetIndex + 1} / {sheets.length}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={goToNextSheet}
                    disabled={!hasNextSheet}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                  <div className="w-px h-6 bg-border mx-2" />
                </>
              )}

              <h2 className="flex items-center gap-2 text-lg font-semibold">
                {sheet.sheet_number}
                {sheet.sheet_title && !isMobile && (
                  <span className="text-muted-foreground font-normal">
                    - {sheet.sheet_title}
                  </span>
                )}
                {sheet.discipline && (
                  <Badge variant="outline">{sheet.discipline}</Badge>
                )}
              </h2>
            </div>

            <div className="flex items-center gap-2">
              {/* Compare button */}
              {versions.length >= 2 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCompareClick}
                  disabled={loadingVersions}
                >
                  <GitCompare className="h-4 w-4 mr-1" />
                  {!isMobile && "Compare"}
                </Button>
              )}
              {versions.length === 0 && !loadingVersions && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={loadVersions}
                  disabled={loadingVersions}
                >
                  <GitCompare className="h-4 w-4 mr-1" />
                  {!isMobile && "Load Versions"}
                </Button>
              )}
              <Button variant="ghost" size="icon" onClick={onClose}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Toolbar */}
          {!readOnly && (
            <div className="w-14 border-r bg-muted/30 flex flex-col items-center py-2 gap-1">
              <TooltipProvider>
                {/* Pan tool */}
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
                  <TooltipContent side="right">Pan</TooltipContent>
                </Tooltip>

                {/* Pin tool */}
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
                    <TooltipContent side="right">Add Pin</TooltipContent>
                  </Tooltip>
                )}

                <div className="w-8 border-t my-2" />

                {/* Markup tools */}
                {MARKUP_TOOLS.map((tool) => (
                  <Tooltip key={tool.type}>
                    <TooltipTrigger asChild>
                      <Button
                        variant={activeTool === tool.type ? "secondary" : "ghost"}
                        size="icon"
                        className="h-10 w-10"
                        onClick={() => setActiveTool(tool.type)}
                      >
                        <tool.icon className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="right">{tool.label}</TooltipContent>
                  </Tooltip>
                ))}

                <div className="w-8 border-t my-2" />

                {/* Color picker */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-10 w-10">
                      <div
                        className="h-5 w-5 rounded-full border-2"
                        style={{ backgroundColor: selectedColor }}
                      />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="right" className="p-2">
                    <div className="grid grid-cols-4 gap-1">
                      {MARKUP_COLORS.map((color) => (
                        <button
                          key={color}
                          className={cn(
                            "h-6 w-6 rounded-full border-2",
                            selectedColor === color
                              ? "border-foreground"
                              : "border-transparent"
                          )}
                          style={{ backgroundColor: color }}
                          onClick={() => setSelectedColor(color)}
                        />
                      ))}
                    </div>
                  </DropdownMenuContent>
                </DropdownMenu>

                {/* Stroke width */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-10 w-10">
                      <div
                        className="rounded-full bg-current"
                        style={{ width: strokeWidth * 2, height: strokeWidth * 2 }}
                      />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="right" className="w-40 p-3">
                    <Label className="text-xs">Stroke Width</Label>
                    <Slider
                      value={[strokeWidth]}
                      min={1}
                      max={8}
                      step={1}
                      onValueChange={([v]) => setStrokeWidth(v)}
                      className="mt-2"
                    />
                  </DropdownMenuContent>
                </DropdownMenu>

                <div className="flex-1" />

                {/* Actions */}
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
                  <TooltipContent side="right">Undo</TooltipContent>
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
                  <TooltipContent side="right">Clear</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-10 w-10"
                      onClick={handleSave}
                      disabled={localMarkups.length === 0 || !onSaveMarkup}
                    >
                      <Save className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">Save Markups</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          )}

          {/* Main viewer */}
          <div className="flex-1 flex flex-col min-w-0">
            {/* View controls */}
            <div className="flex items-center justify-between p-2 border-b bg-muted/30">
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" onClick={handleZoomOut}>
                  <ZoomOut className="h-4 w-4" />
                </Button>
                <span className="text-sm w-16 text-center">
                  {Math.round((hasTiles ? osdZoom : zoom) * 100)}%
                </span>
                <Button variant="ghost" size="icon" onClick={handleZoomIn}>
                  <ZoomIn className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" onClick={handleResetView}>
                  <RotateCcw className="h-4 w-4" />
                </Button>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  variant={showMarkups ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setShowMarkups(!showMarkups)}
                >
                  {showMarkups ? (
                    <Eye className="h-4 w-4 mr-1" />
                  ) : (
                    <EyeOff className="h-4 w-4 mr-1" />
                  )}
                  Markups
                </Button>

                <Button
                  variant={showPins ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setShowPins(!showPins)}
                >
                  {showPins ? (
                    <Eye className="h-4 w-4 mr-1" />
                  ) : (
                    <EyeOff className="h-4 w-4 mr-1" />
                  )}
                  Pins
                </Button>

                <Button variant="outline" size="sm" asChild>
                  {fileUrl ? (
                    <a href={fileUrl} download target="_blank" rel="noreferrer">
                      <Download className="h-4 w-4 mr-1" />
                      Download
                    </a>
                  ) : (
                    // Keep layout stable while the signed URL loads in background
                    <button
                      type="button"
                      className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-9 px-3"
                      disabled
                    >
                      <Download className="h-4 w-4 mr-1" />
                      Download
                    </button>
                  )}
                </Button>
              </div>
            </div>

            {/* Drawing area */}
            <div
              ref={(el) => {
                // Combine refs
                (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = el
                if (touchRef) {
                  (touchRef as React.MutableRefObject<HTMLDivElement | null>).current = el
                }
              }}
              className="flex-1 overflow-hidden bg-muted/50 relative"
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
                    container={osdContainer}
                    matrix={osdMatrix}
                    imageSize={tiledImageSize}
                    markups={markups}
                    draftMarkups={tiledDraftMarkups}
                    pins={pins}
                    showMarkups={showMarkups}
                    showPins={showPins}
                    highlightedPinId={highlightedPinId}
                    // Only capture pointer input when not panning.
                    interactive={!readOnly && activeTool !== "pan"}
                    onPinClick={(pin) => onPinClick?.(pin)}
                  />
                </div>
              ) : (
                <div
                  className="absolute inset-0 flex items-start justify-center"
                  style={{
                    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                    transformOrigin: "center",
                  }}
                >
                  {/* PDF/Image - Phase 1: Use optimized images when available */}
                  <div ref={contentRef} className="relative inline-block bg-white shadow-lg">
                    {hasOptimizedImages ? (
                      // Phase 1: Progressive image loading (10x faster than PDF)
                      <ImageViewer
                        thumbnailUrl={imageThumbnailUrl!}
                        mediumUrl={imageMediumUrl!}
                        fullUrl={imageFullUrl!}
                        width={imageWidth || 2400}
                        height={imageHeight || 1800}
                        alt={`${sheet.sheet_number} - ${sheet.sheet_title || ""}`}
                        className="max-w-full max-h-full"
                        onLoadStage={(stage: ImageLoadStage) => {
                          if (stage === "thumbnail") {
                            markTiming("thumbnailLoad")
                            // Set content size based on image dimensions for markup positioning
                            if (imageWidth && imageHeight) {
                              setContentSize({ width: imageWidth, height: imageHeight })
                            }
                          } else if (stage === "medium") {
                            markTiming("mediumLoad")
                          } else if (stage === "full") {
                            markTiming("fullLoad")
                            markFullyLoaded()
                          }
                        }}
                        onError={(error) => {
                          console.error("[DrawingViewer] Image load error:", error)
                          // Could fall back to PDF here if needed
                        }}
                      />
                    ) : !fileUrl ? (
                      <div className="flex items-center justify-center h-[70vh] w-[70vw]">
                        <div className="text-muted-foreground">Loading sheet…</div>
                      </div>
                    ) : isPdf ? (
                      // Legacy: PDF rendering via react-pdf
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
                      // Legacy: Direct image (non-PDF, non-optimized)
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
                          // Track image load time
                          markTiming("fullLoad")
                          markFullyLoaded()
                        }}
                      />
                    )}

                    {/* Canvas overlay for markups */}
                    <canvas
                      ref={canvasRef}
                      className="absolute inset-0 pointer-events-none"
                      style={{
                        width: contentSize?.width ?? "100%",
                        height: contentSize?.height ?? "100%",
                      }}
                    />

                    {/* Enhanced Pins overlay with clustering */}
                    {showPins && contentSize && (
                      <DrawingPinLayer
                        pins={pins}
                        zoom={zoom}
                        containerWidth={contentSize.width}
                        containerHeight={contentSize.height}
                        onPinClick={(pin) => onPinClick?.(pin)}
                        onClusterClick={handleClusterClick}
                        highlightedPinId={highlightedPinId}
                      />
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Pins sidebar */}
          {pins.length > 0 && (
            <div className="w-64 border-l bg-background flex flex-col">
              <div className="p-3 border-b font-medium flex items-center gap-2">
                <Layers className="h-4 w-4" />
                Linked Items ({pins.length})
              </div>
              <ScrollArea className="flex-1">
                <div className="p-2 space-y-2">
                  {pins.map((pin) => (
                    <button
                      key={pin.id}
                      className={`w-full p-2 rounded-md border hover:bg-muted/50 text-left transition-colors ${
                        highlightedPinId === pin.id ? "border-primary bg-primary/5" : ""
                      }`}
                      onClick={() => onPinClick?.(pin)}
                    >
                      <div className="flex items-center gap-2">
                        <MapPin
                          className="h-4 w-4 flex-shrink-0"
                          style={{ color: getStatusColor(pin.status) }}
                        />
                        <span className="text-sm font-medium truncate">
                          {pin.entity_title ?? pin.label ?? "Untitled"}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                        <Badge variant="outline" className="text-xs">
                          {PIN_ENTITY_TYPE_LABELS[pin.entity_type]}
                        </Badge>
                        {pin.status && (
                          <span className="capitalize">{pin.status}</span>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              </ScrollArea>
            </div>
          )}
        </div>

        {/* Stage 2: Thumbnail strip for sheet navigation */}
        {sheets.length > 1 && onNavigateSheet && !isMobile && (
          <SheetThumbnailStrip
            sheets={sheets}
            currentSheetId={sheet.id}
            onSelectSheet={(s) => onNavigateSheet(s)}
            className="border-t"
          />
        )}

        {/* Stage 2: Mobile toolbar */}
        {isMobile && isTouch && !readOnly && (
          <MobileDrawingToolbar
            onPrevious={hasPrevSheet ? goToPrevSheet : undefined}
            onNext={hasNextSheet ? goToNextSheet : undefined}
            onDropPin={handleMobileDropPin}
            onMarkup={handleMobileMarkupToggle}
            onCamera={handleMobileCamera}
            isMarkupActive={isMarkupMode}
          />
        )}

        {/* Stage 2: Long press context menu */}
        <LongPressMenu
          open={showLongPressMenu}
          onClose={() => {
            setShowLongPressMenu(false)
            setLongPressPosition(null)
          }}
          onAction={handleLongPressAction}
          position={longPressPosition ? { x: longPressPosition.clientX, y: longPressPosition.clientY } : { x: 0, y: 0 }}
        />

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
    </div>
  )
}
