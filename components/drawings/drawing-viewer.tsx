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
  Spline,
  Pentagon,
  Hash,
  Calculator,
  Check,
  Loader2,
  Minus,
  Sparkles,
  AlertTriangle,
  Search,
  Link2,
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
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
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
  detectSheetVersionScaleAction,
  getSheetCalibrationAction,
  setSheetVersionCalibrationAction,
  createPhotoFromDrawingAction,
  getPhotoForPinAction,
  reportBrokenSheetTilesAction,
  getSheetCalloutLinksAction,
} from "@/app/(app)/drawings/actions"
import { uploadDocumentFileDirect } from "@/lib/services/files-client"
import { useDrawingKeyboardShortcuts } from "./use-drawing-keyboard-shortcuts"
import { KeyboardShortcutsHelp } from "./keyboard-shortcuts-help"
import { ComparisonViewer } from "./comparison-viewer"
import { SheetThumbnailStrip } from "./sheet-thumbnail-strip"
import { usePrefetchAdjacentSheets } from "./use-prefetch-sheets"
import { useIsMobile } from "@/components/ui/use-mobile"
import { TiledDrawingViewer, type ImageToScreenMatrix, type TileManifest } from "./viewer/tiled-drawing-viewer"
import type { GpuDrawingViewer } from "@/lib/viewer"
import { SVGOverlay, type SVGOverlayHandle } from "./viewer/svg-overlay"
import { useMeasureTools, type MeasureToolType, type NormPoint } from "./viewer/use-measure-tools"
import { useSheetVectors } from "./viewer/use-sheet-vectors"
import { useSheetTextRuns } from "./viewer/use-sheet-text-runs"
import { SheetTextSearch } from "./viewer/sheet-text-search"
import type { TextRunMatch } from "@/lib/drawings/text-runs"
import {
  detectLocalScaleDisagreement,
  extractDimensionTokens,
} from "@/lib/drawings/scale"
import {
  snapPoint,
  type VectorIndex,
} from "@/lib/drawings/vector-snap"
import { findSymbolMatches } from "@/lib/drawings/symbol-match"
import { ASSIST_MAX_SYMBOL_MATCHES } from "@/lib/validation/takeoff"
import { TakeoffPanel } from "./takeoff-panel"
import {
  acceptSymbolMatchesAction,
  assignMarkupsToConditionAction,
  findSymbolMatchesByVisionAction,
  getConditionRollupAction,
  symbolVisionAvailableAction,
} from "@/app/(app)/drawings/takeoff-actions"
import type { TakeoffCondition } from "@/lib/services/takeoff"
import type { ConditionRollup } from "@/lib/services/takeoff"
import { measurementLabel } from "@/lib/drawings/measure"
import type { SheetCalibration } from "@/lib/services/drawings"

import { unwrapAction } from "@/lib/action-result"

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

// Takeoff measuring tools. Kept apart from MARKUP_TOOLS because they behave
// differently (multi-click, commit-on-finish, priced) and appear only in
// takeoff mode.
/** Click this close (rendered-image px) to a proposed point and you mean it. */
const PROPOSAL_HIT_RADIUS_PX = 14

/**
 * The count-by-example review band.
 *
 * It says three things and nothing else: how many were found, that they are a
 * proposal, and how to fix it. The number is deliberately not called a count
 * until someone has accepted it — an unaccepted proposal is evidence, not a
 * quantity.
 */
function SymbolCountBar({
  proposal,
  conditionName,
  visionAvailable,
  onAccept,
  onDismiss,
}: {
  proposal: SymbolProposalState | null
  conditionName: string | null
  visionAvailable: boolean
  onAccept: () => void
  onDismiss: () => void
}) {
  const shell =
    "flex items-center gap-3 rounded-xl border bg-background/95 px-3 py-2 shadow-lg backdrop-blur-md"

  if (!proposal) {
    return (
      <div className={shell}>
        <Sparkles className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="text-xs">
          Click one of them on the sheet — Arc finds the rest.
        </span>
        <Button size="sm" variant="ghost" className="h-7" onClick={onDismiss}>
          Cancel
        </Button>
      </div>
    )
  }

  if (proposal.status === "matching") {
    return (
      <div className={shell}>
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
        <span className="text-xs">
          {proposal.source === "vision"
            ? "No linework to match here — looking at the sheet…"
            : "Matching that symbol across the sheet…"}
        </span>
      </div>
    )
  }

  if (proposal.status === "empty") {
    return (
      <div className={shell}>
        <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
        <div className="text-xs">
          <div>Nothing else on this sheet matches that.</div>
          <div className="text-muted-foreground">
            {visionAvailable
              ? "Try clicking the symbol itself rather than its leader or tag."
              : "This sheet has no usable linework — count these by hand."}
          </div>
        </div>
        <Button size="sm" variant="ghost" className="h-7" onClick={onDismiss}>
          Close
        </Button>
      </div>
    )
  }

  return (
    <div className={shell}>
      <span className="text-sm font-semibold tabular-nums">{proposal.points.length}</span>
      <div className="text-xs">
        <div>
          found{conditionName ? ` for ${conditionName}` : ""}
          {proposal.source === "vision" && (
            <span className="text-muted-foreground"> · read from the image</span>
          )}
        </div>
        <div className="text-muted-foreground">
          Click a dot to drop it, anywhere else to add one
          {proposal.truncated && " · more than the search will return"}
        </div>
      </div>
      <Button
        size="sm"
        className="h-7"
        disabled={proposal.status === "saving" || proposal.points.length === 0}
        onClick={onAccept}
      >
        {proposal.status === "saving" && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
        Accept
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7"
        disabled={proposal.status === "saving"}
        onClick={onDismiss}
      >
        Discard
      </Button>
    </div>
  )
}

/**
 * A count-by-example proposal, mid-review.
 *
 * `points` always includes the exemplar the user clicked — it is one of the
 * things being counted, and leaving it out is an off-by-one in a number that
 * ends up on an estimate.
 */
interface SymbolProposalState {
  status: "matching" | "ready" | "empty" | "saving"
  points: NormPoint[]
  /** Which path produced it, so the review bar can say so plainly. */
  source: "geometry" | "vision"
  /** The search hit its ceiling; the count is a floor, not a total. */
  truncated: boolean
}

const MEASURE_TOOLS: Array<{
  type: MeasureToolType
  icon: React.ElementType
  label: string
  hint: string
}> = [
  { type: "polyline", icon: Spline, label: "Linear", hint: "Click each corner · Enter to finish" },
  { type: "area", icon: Pentagon, label: "Area", hint: "Click the corners · click the first point to close" },
  { type: "count", icon: Hash, label: "Count", hint: "Click each item · Enter to finish" },
]

/**
 * How far a press may travel and still count as placing a point rather than
 * panning the sheet. Tracing a room means clicking, dragging the sheet along,
 * and clicking again — so the two gestures have to share the left button.
 */
const POINT_PLACEMENT_SLOP_PX = 4

/**
 * How far (screen px) a takeoff click reaches for real linework. Converted to
 * image pixels at the current zoom, so snapping feels the same at any
 * magnification, with a clamp so a zoomed-out click can't leap across a room.
 */
const SNAP_TOLERANCE_SCREEN_PX = 10
const SNAP_TOLERANCE_MAX_IMAGE_PX = 32

interface DrawingViewerProps {
  sheet: DrawingSheet
  fileUrl?: string
  markups?: DrawingMarkup[]
  pins?: DrawingPin[]
  highlightedPinId?: string
  onClose: () => void
  onSaveMarkup?: (markup: SaveMarkupInput) => Promise<void>
  onDeleteMarkup?: (markupId: string) => Promise<void>
  /** Measuring markups persist immediately; the host refreshes and returns the saved row. */
  onSaveMeasurement?: (markup: SaveMarkupInput) => Promise<void>
  /** Takeoff is unavailable without a project (the conditions' home). */
  takeoffProjectId?: string | null
  /**
   * Production: measure a house plan against this project's sheets. When set,
   * conditions belong to the PLAN VERSION instead of the project, so the
   * quantities roll up to the plan rather than the lot.
   */
  takeoffPlanVersionId?: string | null
  canWriteTakeoff?: boolean
  /** Deep link: open in takeoff mode with this condition armed. */
  initialConditionId?: string | null
  /** Host refetches the sheet's markups after a reassignment repaints them. */
  onMeasurementReassigned?: () => void
  onCreatePin?: (x: number, y: number) => void
  onPinClick?: (pin: DrawingPin) => void
  readOnly?: boolean
  // Stage 2: Sheet navigation
  sheets?: DrawingSheet[]
  onNavigateSheet?: (sheet: DrawingSheet) => void
  /** Low-res placeholder shown by the tiled viewer until real tiles land. */
  imageThumbnailUrl?: string | null
  imageWidth?: number | null
  imageHeight?: number | null
}

/**
 * What the viewer hands back to be persisted. The server computes `quantity`
 * and `uom` from the geometry, so the viewer never sends them.
 */
export type SaveMarkupInput = {
  drawing_sheet_id: string
  sheet_version_id?: string
  data: DrawingMarkup["data"]
  label?: string
  is_private?: boolean
  share_with_clients?: boolean
  share_with_subs?: boolean
  condition_id?: string | null
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
  imageThumbnailUrl,
  imageWidth,
  imageHeight,
  onSaveMeasurement,
  takeoffProjectId,
  takeoffPlanVersionId,
  canWriteTakeoff = false,
  initialConditionId = null,
  onMeasurementReassigned,
  initialVersionsPanelOpen = false,
}: DrawingViewerProps & { initialVersionsPanelOpen?: boolean }) {
  // Device detection
  const isMobile = useIsMobile()

  /**
   * Tiles are the only render path. A sheet without them has not finished
   * processing yet — there is no legacy renderer to fall back to.
   */
  const hasTiles =
    !!sheet.tile_base_url &&
    !!sheet.tile_manifest &&
    !!((sheet.tile_manifest as any)?.Image?.Size?.Width ?? sheet.image_width) &&
    !!((sheet.tile_manifest as any)?.Image?.Size?.Height ?? sheet.image_height)

  // Performance tracking
  const { markTiming, markFullyLoaded } = useDrawingPerformance({
    sheetId: sheet.id,
    onComplete: (metrics) => {
      // Log detailed performance summary
      logPerformanceSummary(metrics)

      // Send to Vercel Analytics
      track("drawing_loaded", {
        sheetId: metrics.sheetId,
        loadTime: metrics.loadTime,
        device: metrics.device,
        connection: metrics.connection || "unknown",
        fileSize: metrics.fileSize ?? 0,
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
      })
    },
  })

  // Tool state
  const [activeTool, setActiveTool] = useState<MarkupType | "pan" | "pin" | "photo" | null>("pan")
  const [selectedColor, setSelectedColor] = useState(MARKUP_COLORS[0])
  const [strokeWidth, setStrokeWidth] = useState(2)
  const [showMarkups, setShowMarkups] = useState(true)
  const [showPins, setShowPins] = useState(true)

  // Calibration state (measurement scale, stored per sheet version)
  const [calibration, setCalibration] = useState<SheetCalibration | null>(null)
  const [applyingProposal, setApplyingProposal] = useState(false)
  const [scanningScale, setScanningScale] = useState(false)
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

  // Takeoff mode. Measuring is a MODE of the viewer, not a separate page: the
  // conditions panel docks on the right and the tool dock swaps to the three
  // measuring tools. Off by default so nothing changes for a user annotating.
  const [takeoffMode, setTakeoffMode] = useState(!!initialConditionId)
  const [selectedCondition, setSelectedCondition] = useState<TakeoffCondition | null>(null)
  const [hoveredConditionId, setHoveredConditionId] = useState<string | null>(null)
  const [takeoffRefreshToken, setTakeoffRefreshToken] = useState(0)
  const [initialRollup, setInitialRollup] = useState<Promise<ConditionRollup[]> | null>(null)
  const selectedConditionId = selectedCondition?.id ?? null
  /**
   * The next area subtracts instead of adding — a window out of a drywall wall,
   * a stairwell out of a slab. A mode rather than a separate tool, because the
   * gesture is identical and an estimator deducting six windows should not have
   * to switch tools six times.
   */
  const [deductMode, setDeductMode] = useState(false)
  /** Armed for count-by-example: the next click picks the symbol to look for. */
  const [countingByExample, setCountingByExample] = useState(false)
  const [symbolProposal, setSymbolProposal] = useState<SymbolProposalState | null>(null)

  // Refs
  const containerRef = useRef<HTMLDivElement>(null)

  // Tiled viewer (GPU) handle
  const [gpuViewer, setGpuViewer] = useState<GpuDrawingViewer | null>(null)

  const handleViewerReady = useCallback((viewer: GpuDrawingViewer | null) => {
    setGpuViewer((prev) => (prev === viewer ? prev : viewer))
  }, [])

  // Pan/zoom hot path: viewport-change fires every frame, so the transform is
  // pushed straight to the SVG overlay's DOM node via an imperative handle and
  // kept in a ref for coordinate math. React state only updates for the rare
  // bits (container resize, visible zoom % change).
  const viewerMatrixRef = useRef<ImageToScreenMatrix | null>(null)
  const overlayHandleRef = useRef<SVGOverlayHandle | null>(null)

  const setOverlayHandle = useCallback((handle: SVGOverlayHandle | null) => {
    overlayHandleRef.current = handle
    // Replay the latest transform when the overlay mounts after the first emit.
    handle?.setTransform(viewerMatrixRef.current)
  }, [])

  const handleViewerTransformChange = useCallback(({ matrix, container, zoom }: {
    matrix: ImageToScreenMatrix
    container: { width: number; height: number }
    zoom: number
  }) => {
    viewerMatrixRef.current = matrix
    overlayHandleRef.current?.setTransform(matrix)
    setViewerContainer((prev) =>
      prev && prev.width === container.width && prev.height === container.height
        ? prev
        : container
    )
    setViewerZoom((prev) => (Math.round(prev * 100) === Math.round(zoom * 100) ? prev : zoom))
    if (!tiledPerfMarkedRef.current) {
      tiledPerfMarkedRef.current = true
      markTiming("thumbnailLoad")
      markFullyLoaded()
    }
  }, [markTiming, markFullyLoaded])
  const [viewerContainer, setViewerContainer] = useState<{ width: number; height: number } | null>(null)
  const [viewerZoom, setViewerZoom] = useState<number>(1)
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
  const rasterImageSize = useMemo(() => {
    if (tiledImageSize) return tiledImageSize
    if (imageWidth && imageHeight) return { width: imageWidth, height: imageHeight }
    return null
  }, [tiledImageSize, imageWidth, imageHeight])

  // Load the dimension calibration for this sheet's current version.
  useEffect(() => {
    let cancelled = false
    setCalibration(null)
    getSheetCalibrationAction(sheet.id)
      .then((cal) => {
        if (!cancelled) setCalibration(cal)
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

  // ---------------------------------------------------------------------------
  // Takeoff measuring
  // ---------------------------------------------------------------------------

  // Either home will do; the plan-version scope wins when both are present
  // (arriving from a plan sheet means the plan is what is being measured).
  const takeoffAvailable = !!(takeoffPlanVersionId || takeoffProjectId) && !readOnly
  const feetPerImagePx = calibration?.feet_per_image_px ?? null
  // Measurements persist the moment a shape is finished — the panel's rollup
  /**
   * Quick measure: a ruler available to anyone who can read the sheet.
   * Results live only in this session — clearing them or leaving the sheet
   * throws them away, which is exactly what a spot-check wants.
   */
  const [quickMeasureMode, setQuickMeasureMode] = useState(false)
  const [quickMeasurements, setQuickMeasurements] = useState<
    Array<{ type: MeasureToolType; points: Array<[number, number]> }>
  >([])

  // has to be live, so there is no "draft then save" batch here.
  const commitMeasurement = useCallback(
    async (payload: {
      type: MeasureToolType
      points: Array<[number, number]>
      deduction: boolean
    }) => {
      // Quick measure is a ruler, not a takeoff: nothing is persisted, nothing
      // rolls up, and it needs no condition. A super checking a clearance
      // should not have to enter estimating mode to do it.
      if (quickMeasureMode) {
        setQuickMeasurements((prev) => [
          ...prev,
          { type: payload.type, points: payload.points },
        ])
        return
      }

      const save = onSaveMeasurement ?? onSaveMarkup
      if (!save) throw new Error("Measurements cannot be saved here")
      await save({
        drawing_sheet_id: sheet.id,
        sheet_version_id: calibration?.sheet_version_id,
        data: {
          type: payload.type,
          points: payload.points,
          color: selectedCondition?.color ?? MARKUP_COLORS[4],
          strokeWidth: 2,
          // Only set when true: the flag is what makes the server store a
          // negative quantity, and an explicit `false` on every ordinary area
          // would put a meaningless key on every markup in the database.
          ...(payload.deduction ? { style: { deduction: true } } : {}),
        },
        is_private: false,
        share_with_clients: false,
        share_with_subs: false,
        condition_id: selectedConditionId,
      })
      setTakeoffRefreshToken((token) => token + 1)
      checkLocalScaleRef.current(payload.points)
    },
    [
      quickMeasureMode,
      onSaveMeasurement,
      onSaveMarkup,
      sheet.id,
      calibration,
      selectedCondition,
      selectedConditionId,
    ],
  )

  // -------------------------------------------------------------------------
  // Local scale check — the multi-scale sheet
  // -------------------------------------------------------------------------

  /**
   * A sheet is calibrated once, but a real sheet is not drawn at one scale: a
   * 1/4" floor plan shares the page with 1/2" wall sections and 3" details.
   * Measure inside a detail and the answer is wrong by a factor of two to
   * twelve, it looks entirely plausible, and the first time anyone finds out is
   * when the material arrives.
   *
   * So after each measurement, the dimensions PRINTED inside the region it
   * covers get a vote. Advisory only, and one-directional — it never re-scales
   * anything, it just refuses to let the disagreement stay invisible.
   */
  const [localScaleWarning, setLocalScaleWarning] = useState<string | null>(null)
  // Find-in-sheet. Opening it is the other reason to want the sheet's text, so
  // it joins takeoff's local-scale check in arming the loader.
  const [textSearchOpen, setTextSearchOpen] = useState(false)
  const [textMatches, setTextMatches] = useState<TextRunMatch[]>([])
  const [activeTextMatchIndex, setActiveTextMatchIndex] = useState(0)

  const sheetTextRuns = useSheetTextRuns({
    tileBaseUrl,
    active: textSearchOpen || (takeoffMode && !!feetPerImagePx),
  })
  const textRunsRef = useRef(sheetTextRuns.runs)
  textRunsRef.current = sheetTextRuns.runs

  const handleTextMatchesChange = useCallback(
    (matches: TextRunMatch[], index: number) => {
      setTextMatches(matches)
      setActiveTextMatchIndex(index)
    },
    [],
  )

  const handleRevealTextMatch = useCallback(
    (rect: { x: number; y: number; w: number; h: number }) => {
      if (!gpuViewer || !tiledImageSize) return
      gpuViewer.revealImageRect(
        {
          x: rect.x * tiledImageSize.width,
          y: rect.y * tiledImageSize.height,
          width: rect.w * tiledImageSize.width,
          height: rect.h * tiledImageSize.height,
        },
        // Legible-text zoom: a hit found while zoomed way out is useless.
        { minScale: 1 },
      )
    },
    [gpuViewer, tiledImageSize],
  )

  /**
   * Callout hyperlinks. Off by default and loaded on demand: a plan sheet can
   * carry dozens, and drawn always they would compete with the drawing.
   */
  const [calloutLinksOn, setCalloutLinksOn] = useState(false)
  const [calloutLinks, setCalloutLinks] = useState<
    Array<{
      x: number
      y: number
      w: number
      h: number
      targetSheetId: string
      targetSheetNumber: string
    }>
  >([])

  useEffect(() => {
    if (!calloutLinksOn) return
    let cancelled = false
    getSheetCalloutLinksAction(sheet.id)
      .then((result) => {
        if (cancelled) return
        if (result.success) setCalloutLinks(result.data)
        else {
          setCalloutLinks([])
          toast.error(result.error)
        }
      })
      .catch(() => {
        if (!cancelled) setCalloutLinks([])
      })
    return () => {
      cancelled = true
    }
  }, [calloutLinksOn, sheet.id])

  const handleCalloutLinkClick = useCallback(
    (targetSheetId: string) => {
      const target = sheets.find((candidate) => candidate.id === targetSheetId)
      if (!target) {
        toast.error("That sheet is not in this set")
        return
      }
      onNavigateSheet?.(target)
    },
    [sheets, onNavigateSheet],
  )

  const closeTextSearch = useCallback(() => {
    setTextSearchOpen(false)
    setTextMatches([])
    setActiveTextMatchIndex(0)
  }, [])

  // Cmd/Ctrl-F inside the viewer means find-in-sheet, not find-in-page.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault()
        setTextSearchOpen(true)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  // A different sheet has different text; stale hits would point nowhere.
  useEffect(() => {
    setTextMatches([])
    setActiveTextMatchIndex(0)
  }, [tileBaseUrl])

  const checkLocalScale = useCallback(
    (points: Array<[number, number]>) => {
      const runs = textRunsRef.current
      if (runs.length === 0 || !feetPerImagePx || points.length < 2) return

      const xs = points.map(([x]) => x)
      const ys = points.map(([, y]) => y)
      const region = {
        x0: Math.min(...xs),
        y0: Math.min(...ys),
        x1: Math.max(...xs),
        y1: Math.max(...ys),
      }

      // Dimension strings and their positions, in the same normalized space the
      // markup points use — so "feet per unit" here is feet per normalized unit.
      const tokens = runs.flatMap((run) =>
        extractDimensionTokens(run.text, {
          x0: run.x,
          y0: run.y,
          x1: run.x + run.w,
          y1: run.y + run.h,
        }),
      )

      const size = rasterImageSizeRef.current
      if (!size) return
      const disagreement = detectLocalScaleDisagreement({
        tokens,
        region,
        // The sheet's scale expressed per normalized unit along x, which is the
        // axis `extractDimensionTokens` spreads a chain across.
        sheetFeetPerUnit: feetPerImagePx * size.width,
      })
      if (!disagreement) return

      const factor = disagreement.ratio
      setLocalScaleWarning(
        `The dimensions printed here read about ${factor.toFixed(1)}× the sheet's scale — ` +
          `this looks like a detail drawn at its own scale. Check this measurement before pricing it.`,
      )
    },
    [feetPerImagePx],
  )

  // Held in a ref because `commitMeasurement` is memoised on the save handlers
  // and must not churn every time the text runs finish loading.
  const checkLocalScaleRef = useRef(checkLocalScale)
  checkLocalScaleRef.current = checkLocalScale

  // A warning is about one measurement; changing sheets retires it.
  useEffect(() => {
    setLocalScaleWarning(null)
  }, [sheet.id])

  // -------------------------------------------------------------------------
  // Vector snapping (extracted PDF linework, when the sheet has any)
  // -------------------------------------------------------------------------

  const vectorIndexRef = useRef<VectorIndex | null>(null)
  /** Alt held on the last pointer event = snap bypass, resolved here not in the hook. */
  const altKeyRef = useRef(false)
  const rasterImageSizeRef = useRef(rasterImageSize)
  rasterImageSizeRef.current = rasterImageSize
  /** Where the cursor would land (image px); drives the overlay indicator dot. */
  const [snapHit, setSnapHit] = useState<Point | null>(null)

  const snapMeasurePoint = useCallback((p: NormPoint): NormPoint | null => {
    const index = vectorIndexRef.current
    const size = rasterImageSizeRef.current
    if (!index || !size || altKeyRef.current) {
      setSnapHit(null)
      return null
    }
    const matrix = viewerMatrixRef.current
    const scale = matrix ? Math.hypot(matrix.a, matrix.b) : 1
    const tolerance = Math.min(
      SNAP_TOLERANCE_MAX_IMAGE_PX,
      Math.max(1, SNAP_TOLERANCE_SCREEN_PX / Math.max(scale, 1e-6)),
    )
    const hit = snapPoint(index, { x: p.x * size.width, y: p.y * size.height }, tolerance)
    if (!hit) {
      setSnapHit(null)
      return null
    }
    setSnapHit({ x: hit.point.x, y: hit.point.y })
    return { x: hit.point.x / size.width, y: hit.point.y / size.height }
  }, [])

  const measureTools = useMeasureTools({
    imageSize: rasterImageSize,
    feetPerImagePx,
    deduction: deductMode,
    onCommit: commitMeasurement,
    snap: snapMeasurePoint,
  })

  // Vectors load lazily, once a measuring tool is armed or the user asks to
  // count by example; a sheet without vectors.bin resolves to "unavailable" and
  // everything behaves as before.
  const sheetVectors = useSheetVectors({
    tileBaseUrl,
    imageSize: rasterImageSize,
    active: takeoffMode && (!!measureTools.activeTool || countingByExample),
  })
  vectorIndexRef.current = sheetVectors.index

  // The snap indicator dies with the tool, not on the next mouse move.
  useEffect(() => {
    if (!measureTools.activeTool) {
      setSnapHit(null)
    }
  }, [measureTools.activeTool])

  /** Where the current press started, for telling a click from a pan-drag. */
  const pressOriginRef = useRef<{ x: number; y: number } | null>(null)
  // The tools object is rebuilt every render; reading it through a ref keeps
  // the listener effect below from re-subscribing on every rubber-band frame.
  const measureToolsRef = useRef(measureTools)
  measureToolsRef.current = measureTools

  // -------------------------------------------------------------------------
  // Count by example
  // -------------------------------------------------------------------------

  /** Whether the vision fallback is configured, asked once when takeoff opens. */
  const [symbolVisionReady, setSymbolVisionReady] = useState(false)
  useEffect(() => {
    if (!takeoffMode) return
    let cancelled = false
    symbolVisionAvailableAction()
      .then((available) => {
        if (!cancelled) setSymbolVisionReady(available)
      })
      .catch(() => {
        if (!cancelled) setSymbolVisionReady(false)
      })
    return () => {
      cancelled = true
    }
  }, [takeoffMode])

  /**
   * Click one outlet, get the rest.
   *
   * The match runs HERE, in the browser, against the same vectors the snapping
   * already downloaded — so it costs no round trip and no tokens, and it comes
   * back before the user has let go of the mouse. The vision fallback only runs
   * when the sheet's linework cannot support a match, which on the sheets the
   * vector spike sampled was none of them.
   *
   * Nothing is saved. The matches become an ordinary count draft that the
   * estimator trims, adds to, and then accepts — the proposal is a suggestion
   * until a person says otherwise.
   */
  const runSymbolMatch = useCallback(
    async (click: NormPoint) => {
      const size = rasterImageSizeRef.current
      if (!size) return
      setSymbolProposal({ status: "matching", points: [], source: "geometry", truncated: false })

      const segments = sheetVectors.segments
      const geometric = segments
        ? findSymbolMatches(segments, size, click, {
            maxMatches: ASSIST_MAX_SYMBOL_MATCHES,
            region: null,
          })
        : null

      if (geometric && geometric.matches.length > 0) {
        // The matcher already includes the clicked symbol's own placement, and
        // at a better point than the raw click. Adding it back would count it
        // twice — an off-by-one straight into an estimate.
        const points = geometric.matches.map((match) => match.point)
        setSymbolProposal({
          status: "ready",
          points,
          source: "geometry",
          truncated: geometric.truncated,
        })
        measureToolsRef.current.setDraftPoints("count", points)
        return
      }

      // No usable linework here. Say so before spending a model call, and only
      // offer the fallback when one is actually configured.
      if (!symbolVisionReady) {
        setSymbolProposal({
          status: "empty",
          points: [],
          source: "geometry",
          truncated: false,
        })
        return
      }

      setSymbolProposal({ status: "matching", points: [], source: "vision", truncated: false })
      try {
        const proposal = unwrapAction(
          await findSymbolMatchesByVisionAction({
            sheet_version_id: calibration?.sheet_version_id as string,
            drawing_sheet_id: sheet.id,
            x: click.x,
            y: click.y,
          }),
        )
        if (!proposal || proposal.points.length === 0) {
          setSymbolProposal({ status: "empty", points: [], source: "vision", truncated: false })
          return
        }
        // Unlike the geometric path, the vision prompt asks for every OTHER
        // occurrence — a model told to include the example tends to return it
        // twice — so the click is added back here.
        const points = [click, ...proposal.points.map(([x, y]) => ({ x, y }))]
        setSymbolProposal({
          status: "ready",
          points,
          source: "vision",
          truncated: proposal.truncated,
        })
        measureToolsRef.current.setDraftPoints("count", points)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not search this sheet")
        setSymbolProposal(null)
      }
    },
    [sheetVectors.segments, symbolVisionReady, calibration?.sheet_version_id, sheet.id],
  )

  /**
   * While reviewing, a click near a proposed point removes it and a click
   * anywhere else adds one. That is the whole editing model: the false
   * positives you can see are the ones you delete, and the misses you spot are
   * the ones you click.
   */
  const editProposal = useCallback((click: NormPoint) => {
    const size = rasterImageSizeRef.current
    setSymbolProposal((prev) => {
      if (!prev || prev.status !== "ready") return prev
      let nearestIndex = -1
      let nearestDistance = Number.POSITIVE_INFINITY
      if (size) {
        prev.points.forEach((point, index) => {
          const dx = (point.x - click.x) * size.width
          const dy = (point.y - click.y) * size.height
          const distance = Math.hypot(dx, dy)
          if (distance < nearestDistance) {
            nearestDistance = distance
            nearestIndex = index
          }
        })
      }
      const points =
        nearestIndex >= 0 && nearestDistance <= PROPOSAL_HIT_RADIUS_PX
          ? prev.points.filter((_, index) => index !== nearestIndex)
          : [...prev.points, click]
      measureToolsRef.current.setDraftPoints("count", points)
      return { ...prev, points }
    })
  }, [])

  const acceptProposal = useCallback(async () => {
    const proposal = symbolProposal
    if (!proposal || proposal.points.length === 0) return
    const versionId = calibration?.sheet_version_id
    if (!versionId) {
      toast.error("This sheet version can't take a count yet")
      return
    }
    setSymbolProposal({ ...proposal, status: "saving" })
    try {
      const result = unwrapAction(
        await acceptSymbolMatchesAction({
          drawing_sheet_id: sheet.id,
          sheet_version_id: versionId,
          condition_id: selectedConditionId,
          points: proposal.points.map((point) => [point.x, point.y] as [number, number]),
        }),
      )
      toast.success(
        selectedCondition
          ? `Counted ${result.quantity} into ${selectedCondition.name}`
          : `Counted ${result.quantity} — assign it to a condition to price it`,
      )
      measureToolsRef.current.setDraftPoints("count", [])
      setSymbolProposal(null)
      setCountingByExample(false)
      setTakeoffRefreshToken((token) => token + 1)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save the count")
      setSymbolProposal({ ...proposal, status: "ready" })
    }
  }, [symbolProposal, calibration?.sheet_version_id, sheet.id, selectedConditionId, selectedCondition])

  const dismissProposal = useCallback(() => {
    measureToolsRef.current.setDraftPoints("count", [])
    setSymbolProposal(null)
    setCountingByExample(false)
  }, [])

  // Read through a ref inside the capture-phase pointer listener, which is
  // subscribed once per tool change rather than once per proposal edit.
  const symbolProposalRef = useRef(symbolProposal)
  symbolProposalRef.current = symbolProposal

  // Arming a measuring tool ends a review, and vice versa — two things both
  // claiming the next click is how a proposal gets silently discarded.
  useEffect(() => {
    if (measureTools.activeTool && countingByExample) dismissProposal()
  }, [measureTools.activeTool, countingByExample, dismissProposal])

  /**
   * Reassignment gesture: in takeoff mode with a condition armed and no tool
   * active, clicking existing geometry moves it into that condition. This is
   * the fix for "I measured six rooms into the wrong bucket", which otherwise
   * means deleting and re-tracing them.
   */
  const handleMeasurementClick = useCallback(
    async (markup: DrawingMarkup) => {
      if (!takeoffMode || !canWriteTakeoff) return
      if (measureTools.activeTool) return
      if (!markup.uom) return
      if (!selectedCondition) {
        toast.info("Pick a condition first, then click a measurement to move it there")
        return
      }
      if (markup.condition_id === selectedCondition.id) return

      try {
        unwrapAction(
          await assignMarkupsToConditionAction({
            condition_id: selectedCondition.id,
            markup_ids: [markup.id],
          }),
        )
        toast.success(`Moved into ${selectedCondition.name}`)
        setTakeoffRefreshToken((token) => token + 1)
        onMeasurementReassigned?.()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to move the measurement")
      }
    },
    [takeoffMode, canWriteTakeoff, measureTools.activeTool, selectedCondition, onMeasurementReassigned],
  )

  const prefetchTakeoffRollup = useCallback(() => {
    if (initialRollup || (!takeoffProjectId && !takeoffPlanVersionId)) return
    setInitialRollup(
      getConditionRollupAction(
        takeoffPlanVersionId
          ? { house_plan_version_id: takeoffPlanVersionId }
          : { project_id: takeoffProjectId as string },
      ),
    )
  }, [initialRollup, takeoffPlanVersionId, takeoffProjectId])
  const consumeInitialRollup = useCallback(() => setInitialRollup(null), [])

  useEffect(() => {
    if (takeoffMode) prefetchTakeoffRollup()
  }, [takeoffMode, prefetchTakeoffRollup])

  const { setActiveTool: setMeasureTool } = measureTools
  // Leaving takeoff mode must not strand a half-drawn shape or an armed tool.
  useEffect(() => {
    if (!takeoffMode) setMeasureTool(null)
  }, [takeoffMode, setMeasureTool])
  useEffect(() => {
    setMeasureTool(null)
  }, [sheet.id, setMeasureTool])

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

  // Keep viewer mouse navigation aligned with the active tool.
  useEffect(() => {
    if (!gpuViewer) return
    // A measuring tool leaves activeTool on "pan" (it owns clicks itself, and
    // the viewer must keep handling drags). Click-zoom has to go regardless,
    // or every vertex placed would zoom the sheet and double-click-to-finish
    // would fight the viewer for the gesture. Trackpad panning (two-finger
    // scroll) and pinch-zoom stay live while tracing; scrollToZoom only
    // gates notched mouse wheels.
    const measuring = !!measureTools.activeTool
    const enableNav = activeTool === "pan"
    gpuViewer.setGestureOptions({
      clickToZoom: enableNav && !measuring,
      dblClickToZoom: enableNav && !measuring,
      scrollToZoom: enableNav,
    })
  }, [activeTool, gpuViewer, measureTools.activeTool])

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
      const viewerMatrix = viewerMatrixRef.current
      if (!containerRef.current || !viewerMatrix || !tiledImageSize) return null
      const rect = containerRef.current.getBoundingClientRect()
      const sx = clientX - rect.left
      const sy = clientY - rect.top

      // Invert 2D affine matrix.
      const det = viewerMatrix.a * viewerMatrix.d - viewerMatrix.b * viewerMatrix.c
      if (!det) return null

      const dx = sx - viewerMatrix.e
      const dy = sy - viewerMatrix.f

      const imgX = (viewerMatrix.d * dx - viewerMatrix.c * dy) / det
      const imgY = (-viewerMatrix.b * dx + viewerMatrix.a * dy) / det

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

  // Phase 3: Prefetch adjacent sheets for instant navigation
  usePrefetchAdjacentSheets(sheet.id, sheets, !showCompare)

  // Zoom controls. The GPU viewer's camera is the single source of zoom.
  const zoomBy = useCallback(
    (factor: number) => gpuViewer?.zoomBy(factor),
    [gpuViewer]
  )

  const handleZoomIn = useCallback(() => zoomBy(1.2), [zoomBy])
  const handleZoomOut = useCallback(() => zoomBy(1 / 1.2), [zoomBy])
  const handleResetView = useCallback(() => gpuViewer?.goHome(), [gpuViewer])

  // Keyboard shortcuts for viewer
  useDrawingKeyboardShortcuts({
    enabled: !textDialogOpen && !showCompare,
    context: "viewer",
    handlers: {
      onZoomIn: () => zoomBy(1.2),
      onZoomOut: () => zoomBy(1 / 1.2),
      onFitToScreen: () => gpuViewer?.goHome(),
      // True 1:1 with the source raster, not the fit-to-window zoom.
      onZoom100: () => gpuViewer?.zoomToActualSize(),
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

  /** Normalized (0-1) sheet coordinates for a client point. */
  const getNormalizedCoords = getNormalizedCoordsFromTiledClient

  const tiledDraftMarkups = useMemo(() => {
    if (!tiledImageSize) return []
    const toPx = (p: { x: number; y: number }) => ({
      x: p.x * tiledImageSize.width,
      y: p.y * tiledImageSize.height,
    })

    const drafts: Array<{
      type: string
      points: Array<{ x: number; y: number }>
      color: string
      strokeWidth: number
      text?: string
      label?: string | null
      style?: Record<string, unknown> | null
    }> = [
      ...localMarkups.map((m) => ({
        type: m.type as string,
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

    // Measuring shape under construction, with its live measurement as the
    // label — the number climbs as the cursor moves.
    const measureDraft = measureTools.draft
    if (measureDraft) {
      const points = [...measureDraft.points]
      if (measureDraft.cursor && measureDraft.tool !== "count") points.push(measureDraft.cursor)
      drafts.push({
        type: measureDraft.tool,
        points: points.map(toPx),
        color: selectedCondition?.color ?? MARKUP_COLORS[4],
        strokeWidth: 2,
        text: undefined,
        label: measureTools.draftLabel,
        // Carried onto the draft so a deduction hatches WHILE it is traced —
        // finding out an area subtracts only after committing it is exactly the
        // surprise the hatch exists to prevent.
        style: measureDraft.deduction ? { deduction: true } : null,
      })
    }

    // Committed quick measurements. Drafts rather than markups because they
    // are never persisted — they exist for as long as the question does.
    for (const measurement of quickMeasurements) {
      drafts.push({
        type: measurement.type,
        points: measurement.points.map(([x, y]) => toPx({ x, y })),
        color: MARKUP_COLORS[4],
        strokeWidth: 2,
        text: undefined,
        label: measurementLabel(
          { type: measurement.type, points: measurement.points },
          rasterImageSize,
          feetPerImagePx,
        ),
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
          // While picking the reference distance the label shows what the
          // CURRENT scale makes of it — which is how you spot that the sheet
          // is calibrated wrong before typing the real number.
          label: measurementLabel(
            {
              type: "dimension",
              points: calibrationPoints.map((p) => [p.x, p.y] as [number, number]),
            },
            rasterImageSize,
            feetPerImagePx,
          ),
        })
      }
    }

    return drafts
  }, [
    currentMarkup,
    localMarkups,
    tiledImageSize,
    calibrating,
    calibrationPoints,
    rasterImageSize,
    feetPerImagePx,
    measureTools.draft,
    measureTools.draftLabel,
    selectedCondition,
    quickMeasurements,
  ])

  /**
   * Point-placing tools listen for POINTER events in the CAPTURE phase, not
   * through React and not for mouse events.
   *
   * The GPU viewer's gesture layer owns its canvas and calls `preventDefault()`
   * on `pointerdown` for every primary-button press (see lib/viewer/gestures.ts).
   * That sets the browser's prevent-mouse-event flag, so no `mousedown`,
   * `mousemove` or `mouseup` is ever synthesised for the gesture — a mouse
   * listener simply never fires over a tiled sheet, in any phase, React or
   * native. Pointer events and `click` are the only ones that survive, and
   * capture runs root-to-target so this container sees them ahead of the canvas.
   *
   * A press places a point only if the pointer barely moved; anything further
   * belongs to the viewer's pan, which stays live so a forty-click room can be
   * traced across a sheet without disarming the tool.
   *
   * Only attached while a tool actually needs raw clicks, so ordinary panning
   * and zooming are untouched the rest of the time.
   */
  const capturingClicks = !!measureTools.activeTool || calibrating || countingByExample

  useEffect(() => {
    const element = containerRef.current
    if (!element || !capturingClicks) return

    const onPointerDown = (event: PointerEvent) => {
      altKeyRef.current = event.altKey
      if (!event.isPrimary) return
      if (event.pointerType === "mouse" && event.button !== 0) return
      // On a ref, not in this closure: a re-subscribe between press and
      // release (arming a different condition mid-shape) must not lose it.
      pressOriginRef.current = { x: event.clientX, y: event.clientY }
    }

    const onPointerUp = (event: PointerEvent) => {
      altKeyRef.current = event.altKey
      const origin = pressOriginRef.current
      pressOriginRef.current = null
      if (!origin) return
      if (
        Math.hypot(event.clientX - origin.x, event.clientY - origin.y) >
        POINT_PLACEMENT_SLOP_PX
      ) {
        return
      }

      const coords = getNormalizedCoords(event.clientX, event.clientY)
      if (!coords) return

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

      if (countingByExample) {
        // First click picks the exemplar; every click after that edits the
        // proposal, so the same gesture both starts and refines the count.
        if (symbolProposalRef.current?.status === "ready") editProposal(coords)
        else if (symbolProposalRef.current?.status !== "matching") void runSymbolMatch(coords)
        return
      }

      measureToolsRef.current.handleClick(coords)
    }

    // The rubber band follows the cursor; the viewer still needs the move to
    // pan, so this one deliberately does not stop propagation.
    const onPointerMove = (event: PointerEvent) => {
      altKeyRef.current = event.altKey
      if (!measureToolsRef.current.isDrafting) {
        // Before the first point lands, the snap indicator still previews
        // where a click would go (the fn feeds the overlay dot as it runs).
        if (measureToolsRef.current.activeTool) {
          const coords = getNormalizedCoords(event.clientX, event.clientY)
          if (coords) snapMeasurePoint(coords)
          else setSnapHit(null)
        }
        return
      }
      measureToolsRef.current.handleMove(getNormalizedCoords(event.clientX, event.clientY))
    }

    const onPointerCancel = () => {
      pressOriginRef.current = null
    }

    const onDoubleClick = (event: MouseEvent) => {
      if (calibrating) return
      event.preventDefault()
      event.stopPropagation()
      measureToolsRef.current.handleDoubleClick()
    }

    element.addEventListener("pointerdown", onPointerDown, true)
    element.addEventListener("pointerup", onPointerUp, true)
    element.addEventListener("pointermove", onPointerMove, true)
    element.addEventListener("pointercancel", onPointerCancel, true)
    element.addEventListener("dblclick", onDoubleClick, true)
    return () => {
      element.removeEventListener("pointerdown", onPointerDown, true)
      element.removeEventListener("pointerup", onPointerUp, true)
      element.removeEventListener("pointermove", onPointerMove, true)
      element.removeEventListener("pointercancel", onPointerCancel, true)
      element.removeEventListener("dblclick", onDoubleClick, true)
    }
  }, [
    capturingClicks,
    calibrating,
    getNormalizedCoords,
    snapMeasurePoint,
  ])

  // Handle mouse down
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Measuring and calibration are served by the capture-phase pointer
      // listener above; ignoring the bubbled copy keeps a press that reaches
      // React (an interactive SVG overlay swallows it before the canvas can)
      // from placing the point twice.
      if (capturingClicks) return
      e.preventDefault()

      // The GPU viewer owns panning.
      if (activeTool === "pan") return
      const coords = getNormalizedCoords(e.clientX, e.clientY)
      if (!coords) return

      if (activeTool === "photo" && !readOnly) {
        setPendingPhotoPosition(coords)
        photoInputRef.current?.click()
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
    [
      activeTool,
      getNormalizedCoords,
      selectedColor,
      strokeWidth,
      readOnly,
      onCreatePin,
      capturingClicks,
    ]
  )

  // Handle mouse move
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
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
    [isDrawing, currentMarkup, getNormalizedCoords]
  )

  // Handle mouse up
  const handleMouseUp = useCallback(() => {
    if (isDrawing && currentMarkup && currentMarkup.points.length >= 2) {
      // Save to local markups
      setHistory((prev) => [...prev, localMarkups])
      setLocalMarkups((prev) => [...prev, currentMarkup])
    }

    setIsDrawing(false)
    setCurrentMarkup(null)
  }, [isDrawing, currentMarkup, localMarkups])

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
    if (!calibration?.sheet_version_id) {
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
          sheet_version_id: calibration.sheet_version_id,
          feet_per_image_px: feet / calibrationPixelDistance,
          method: "two_point",
        })
      )
      setCalibration(saved)
      // Recalibrating rewrites every stored quantity on this version; saying
      // how many changed is the difference between a scale fix and a silent
      // repricing.
      toast.success(
        saved.recomputed_markups > 0
          ? `Scale saved — ${saved.recomputed_markups} measurement${saved.recomputed_markups === 1 ? "" : "s"} recalculated`
          : "Sheet calibrated — measurements now show real quantities",
      )
      setTakeoffRefreshToken((token) => token + 1)
      exitCalibrateMode()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save calibration")
    } finally {
      setSavingCalibration(false)
    }
  }

  /**
   * Accept a scale the pipeline derived from the sheet itself (title block or
   * printed dimensions). One click, and it is recorded as a real calibration
   * with its method, so the readout can say what it is standing on.
   */
  const handleApplyProposal = useCallback(async () => {
    const proposal = calibration?.proposal
    if (!proposal || !calibration?.sheet_version_id) return

    setApplyingProposal(true)
    try {
      const saved = unwrapAction(
        await setSheetVersionCalibrationAction({
          sheet_version_id: calibration.sheet_version_id,
          feet_per_image_px: proposal.feet_per_image_px,
          method: proposal.method,
          ...(proposal.raw ? { source_label: proposal.raw } : {}),
        }),
      )
      setCalibration(saved)
      toast.success(
        saved.recomputed_markups > 0
          ? `Scale applied — ${saved.recomputed_markups} measurement${saved.recomputed_markups === 1 ? "" : "s"} recalculated`
          : "Scale applied",
      )
      setTakeoffRefreshToken((token) => token + 1)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to apply scale")
    } finally {
      setApplyingProposal(false)
    }
  }, [calibration])

  /**
   * Sheets uploaded before scale detection existed have no proposal and no way
   * to get one. Opening takeoff mode on such a sheet reads its scale off the
   * PDF once, in the background — otherwise "one-click scale" would be dead on
   * every sheet already in the register.
   *
   * Runs at most once per sheet version: the service records that it looked,
   * so a sheet with no readable scale is not re-opened on every visit.
   */
  useEffect(() => {
    if (!takeoffMode || !canWriteTakeoff) return
    if (!calibration?.sheet_version_id) return
    if (calibration.feet_per_image_px || calibration.proposal || calibration.scanned) return

    let cancelled = false
    setScanningScale(true)
    detectSheetVersionScaleAction(calibration.sheet_version_id)
      .then((result) => {
        if (cancelled || !result.success) return
        setCalibration((prev) =>
          prev && prev.sheet_version_id === calibration.sheet_version_id
            ? { ...prev, proposal: result.data, scanned: true }
            : prev,
        )
      })
      .finally(() => {
        if (!cancelled) setScanningScale(false)
      })
    return () => {
      cancelled = true
    }
  }, [takeoffMode, canWriteTakeoff, calibration])

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

  /**
   * Which pin layers are drawn. A sheet on an active job carries RFIs, punch
   * items, photos and tasks at once; a super walking punch wants punch only.
   * Only types actually present are offered, so the control stays honest.
   */
  const pinTypesPresent = useMemo(() => {
    const types = new Set<string>()
    for (const pin of allPins) types.add(pin.entity_type)
    return Array.from(types).sort()
  }, [allPins])

  const [hiddenPinTypes, setHiddenPinTypes] = useState<ReadonlySet<string>>(new Set())

  const visiblePins = useMemo(() => {
    if (hiddenPinTypes.size === 0) return allPins
    return allPins.filter((pin) => !hiddenPinTypes.has(pin.entity_type))
  }, [allPins, hiddenPinTypes])

  const togglePinType = useCallback((entityType: string) => {
    setHiddenPinTypes((prev) => {
      const next = new Set(prev)
      if (next.has(entityType)) next.delete(entityType)
      else next.add(entityType)
      return next
    })
  }, [])

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

  const filteredSheets = useMemo(
    () =>
      sheets.filter((s) => {
        if (!sheetListQuery) return true
        const q = sheetListQuery.toLowerCase()
        return (
          s.sheet_number?.toLowerCase().includes(q) ||
          s.sheet_title?.toLowerCase().includes(q) ||
          s.discipline?.toLowerCase().includes(q)
        )
      }),
    [sheets, sheetListQuery],
  )

  const groupedSheets = useMemo(
    () =>
      groupSheetsByDiscipline(
        filteredSheets as Array<DrawingSheet & { discipline?: DrawingDiscipline | null }>,
      ),
    [filteredSheets],
  )

  const orderedDisciplines = useMemo(
    () => DISCIPLINE_SORT_ORDER.filter((d) => groupedSheets.has(d)),
    [groupedSheets],
  )

  const activeDiscipline = (sheet.discipline as DrawingDiscipline | undefined) ?? "X"

  // When searching, auto-expand all matching groups; otherwise expand the current sheet's group.
  const accordionDefault = useMemo(
    () =>
      sheetListQuery
        ? orderedDisciplines.map((d) => String(d))
        : [String(activeDiscipline)],
    [sheetListQuery, orderedDisciplines, activeDiscipline],
  )

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
  const isInteracting = isDrawing
  const chromeClass = cn(
    "transition-opacity duration-200",
    uiHidden
      ? "opacity-0 pointer-events-none"
      : isInteracting
        ? "opacity-30 hover:opacity-100"
        : "opacity-100",
  )

  const ActiveDisciplineIcon = disciplineIcon(activeDiscipline)

  const activeToolDef = MARKUP_TOOLS.find((t) => t.type === activeTool)
  const MarkupActiveIcon = activeToolDef?.icon ?? Pencil
  const markupToolActive =
    !!activeTool && activeTool !== "pan" && activeTool !== "pin" && activeTool !== "photo"

  // In takeoff mode the panel takes a fixed column and the sheet gets the rest;
  // insetting the drawing surface (rather than overlaying the panel) means the
  // geometry the estimator is measuring is never hidden behind the numbers.
  const panelOpen = takeoffMode && takeoffAvailable

  return (
    <div className="fixed inset-0 z-50 bg-neutral-900 overflow-hidden">
      {/* Full-bleed drawing surface */}
      <div
        ref={containerRef}
        className={cn(
          "absolute inset-y-0 left-0 overflow-hidden transition-[right] duration-200",
          panelOpen ? "right-[380px] max-md:right-0" : "right-0",
        )}
        style={{
          cursor: measureTools.activeTool
            ? "crosshair"
            : activeTool === "pan"
              ? "grab"
              : "crosshair",
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {textSearchOpen && (
          <div className="absolute right-3 top-3 z-20">
            <SheetTextSearch
              runs={sheetTextRuns.runs}
              loading={sheetTextRuns.status === "loading"}
              unavailable={sheetTextRuns.status === "unavailable"}
              onClose={closeTextSearch}
              onMatchesChange={handleTextMatchesChange}
              onReveal={handleRevealTextMatch}
            />
          </div>
        )}
        {hasTiles && tileBaseUrl && tileManifest && tiledImageSize ? (
          <div className="absolute inset-0">
            <TiledDrawingViewer
              tileBaseUrl={tileBaseUrl}
              tileManifest={tileManifest}
              thumbnailUrl={imageThumbnailUrl || undefined}
              className="absolute inset-0"
              onReady={handleViewerReady}
              onTransformChange={handleViewerTransformChange}
              // Tiles that never arrive are a server-side problem. Ask the
              // pipeline to rebuild this sheet; it rate-limits and dedupes.
              onTileLoadFailure={() => {
                void reportBrokenSheetTilesAction(sheet.id)
              }}
            />
            <SVGOverlay
              ref={setOverlayHandle}
              container={viewerContainer}
              imageSize={tiledImageSize}
              markups={markups}
              draftMarkups={tiledDraftMarkups}
              pins={visiblePins}
              showMarkups={showMarkups}
              showPins={showPins}
              highlightedPinId={highlightedPinId}
              interactive={!readOnly && activeTool !== "pan"}
              onPinClick={handlePinActivate}
              feetPerImagePx={feetPerImagePx}
              textMatches={textSearchOpen ? textMatches.map((m) => m.run) : undefined}
              activeTextMatchIndex={activeTextMatchIndex}
              calloutLinks={calloutLinksOn ? calloutLinks : undefined}
              onCalloutLinkClick={handleCalloutLinkClick}
              showTakeoff={takeoffMode}
              selectedConditionId={
                takeoffMode ? hoveredConditionId ?? selectedConditionId : null
              }
              onMarkupClick={
                takeoffMode && canWriteTakeoff && !measureTools.activeTool
                  ? (markup) => void handleMeasurementClick(markup)
                  : undefined
              }
              snapIndicator={
                measureTools.activeTool && snapHit
                  ? {
                      x: snapHit.x,
                      y: snapHit.y,
                      color: selectedCondition?.color ?? MARKUP_COLORS[4],
                    }
                  : null
              }
            />
          </div>
        ) : (
          <div className="absolute inset-0">
            <DrawingLoader sheetNumber={sheet.sheet_number} />
            <div className="absolute inset-0 flex items-center justify-center p-8">
              <div className="max-w-sm text-center">
                <p className="text-sm font-medium text-white">
                  This sheet is still processing
                </p>
                <p className="mt-1 text-xs text-white/60">
                  {sheet.sheet_number} will open as soon as its tiles finish
                  building. Check back in a moment.
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Right dock: the takeoff panel. Occupies real layout, not an overlay. */}
      {panelOpen && (
        <div className="absolute inset-y-0 right-0 z-30 w-[380px] max-md:w-full">
          <TakeoffPanel
            projectId={takeoffPlanVersionId ? null : takeoffProjectId}
            housePlanVersionId={takeoffPlanVersionId}
            sheetProjectId={takeoffProjectId}
            activeSheetId={sheet.id}
            selectedConditionId={selectedConditionId}
            initialRollup={initialRollup}
            onInitialRollupConsumed={consumeInitialRollup}
            initialConditionId={initialConditionId}
            onSelectCondition={setSelectedCondition}
            onHighlightCondition={setHoveredConditionId}
            refreshToken={takeoffRefreshToken}
            canWrite={canWriteTakeoff}
            onClose={() => setTakeoffMode(false)}
          />
        </div>
      )}

      {/* Scale bar. Only in takeoff mode: outside it, scale is a detail of the
          dimension tool; inside it, every number on screen depends on it. */}
      {panelOpen && (
        <div
          className={cn(
            "absolute top-4 left-1/2 z-20 -translate-x-1/2 max-md:left-4 max-md:translate-x-0",
            chromeClass,
          )}
        >
          <ScaleBar
            calibration={calibration}
            applying={applyingProposal}
            scanning={scanningScale}
            onApplyProposal={() => void handleApplyProposal()}
            onCalibrate={() => {
              measureTools.setActiveTool(null)
              setActiveTool("dimension")
              setCalibrating(true)
              setCalibrationPoints([])
            }}
          />
        </div>
      )}

      {/* The measurement you just took disagrees with the dimensions printed
          around it. Dismissible, never blocking — it is a second opinion, and
          sometimes the detail really is at the sheet scale. */}
      {panelOpen && localScaleWarning && (
        <div
          className={cn(
            "absolute top-20 left-1/2 z-20 -translate-x-1/2 max-md:left-4 max-md:right-4 max-md:translate-x-0",
            chromeClass,
          )}
        >
          <div className="flex max-w-lg items-start gap-2.5 rounded-xl border border-warning/40 bg-background/95 px-3 py-2 shadow-lg backdrop-blur-md">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <p className="text-xs">{localScaleWarning}</p>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 shrink-0"
              aria-label="Dismiss scale warning"
              onClick={() => setLocalScaleWarning(null)}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* Count-by-example review. Sits under the scale bar, in the same band,
          because it is the same kind of statement: what the numbers on screen
          currently rest on. */}
      {panelOpen && countingByExample && (
        <div
          className={cn(
            "absolute top-20 left-1/2 z-20 -translate-x-1/2 max-md:left-4 max-md:translate-x-0",
            chromeClass,
          )}
        >
          <SymbolCountBar
            proposal={symbolProposal}
            conditionName={selectedCondition?.name ?? null}
            visionAvailable={symbolVisionReady}
            onAccept={() => void acceptProposal()}
            onDismiss={dismissProposal}
          />
        </div>
      )}

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
            {Math.round(viewerZoom * 100)}%
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
          <Button
            variant={textSearchOpen ? "secondary" : "ghost"}
            size="icon"
            className="h-9 w-9"
            onClick={() => (textSearchOpen ? closeTextSearch() : setTextSearchOpen(true))}
            title="Find in sheet (⌘F)"
          >
            <Search className="h-4 w-4" />
          </Button>
          {/* Tap a detail bubble to open the sheet it names — the single most
              frequent thing anyone does with a set of drawings. */}
          <Button
            variant={calloutLinksOn ? "secondary" : "ghost"}
            size="icon"
            className="h-9 w-9"
            onClick={() => setCalloutLinksOn((on) => !on)}
            title={
              calloutLinksOn
                ? `Hide sheet links${calloutLinks.length > 0 ? ` (${calloutLinks.length})` : ""}`
                : "Show sheet links"
            }
          >
            <Link2 className="h-4 w-4" />
          </Button>
          {/* A ruler for everyone. Takeoff mode owns priced measurement; this
              is the spot-check, and it needs no estimating permission. */}
          {!takeoffMode && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant={quickMeasureMode ? "secondary" : "ghost"}
                  size="icon"
                  className="h-9 w-9"
                  disabled={!feetPerImagePx}
                  title={
                    feetPerImagePx
                      ? "Measure (results are not saved)"
                      : "Set this sheet's scale before measuring"
                  }
                >
                  <Ruler className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="center" className="w-44">
                <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
                  Measure — not saved
                </DropdownMenuLabel>
                <DropdownMenuItem
                  onClick={() => {
                    setQuickMeasureMode(true)
                    setActiveTool("pan")
                    measureTools.setActiveTool("polyline")
                  }}
                >
                  Distance
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    setQuickMeasureMode(true)
                    setActiveTool("pan")
                    measureTools.setActiveTool("area")
                  }}
                >
                  Area
                </DropdownMenuItem>
                {(quickMeasureMode || quickMeasurements.length > 0) && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => {
                        setQuickMeasureMode(false)
                        measureTools.setActiveTool(null)
                        setQuickMeasurements([])
                      }}
                    >
                      Clear and exit
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
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

            {pinTypesPresent.length > 1 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant={hiddenPinTypes.size > 0 ? "secondary" : "ghost"}
                    size="icon"
                    className="h-9 w-9"
                    title="Pin layers"
                  >
                    <Layers className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="center" className="w-48">
                  <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
                    Show on sheet
                  </DropdownMenuLabel>
                  {pinTypesPresent.map((entityType) => {
                    const count = allPins.filter((p) => p.entity_type === entityType).length
                    return (
                      <DropdownMenuCheckboxItem
                        key={entityType}
                        checked={!hiddenPinTypes.has(entityType)}
                        onCheckedChange={() => togglePinType(entityType)}
                      >
                        <span className="flex-1">
                          {PIN_ENTITY_TYPE_LABELS[
                            entityType as keyof typeof PIN_ENTITY_TYPE_LABELS
                          ] ?? entityType}
                        </span>
                        <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                          {count}
                        </span>
                      </DropdownMenuCheckboxItem>
                    )
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

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

      {/* Bottom-center: tool dock. Shifts with the panel so it stays centered
          under the sheet rather than under the whole window. */}
      {!readOnly && !isMobile && (
        <div
          className={cn(
            "absolute bottom-6 z-20 -translate-x-1/2 transition-[left] duration-200",
            panelOpen ? "left-[calc(50%-190px)]" : "left-1/2",
            chromeClass,
          )}
        >
          <div className="flex items-center gap-0.5 rounded-2xl border bg-background/95 backdrop-blur-md shadow-xl p-1.5">
            <TooltipProvider delayDuration={300}>
              {takeoffAvailable && (
                <>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant={takeoffMode ? "secondary" : "ghost"}
                        size="sm"
                        className="h-10 gap-1.5 px-2.5"
                        onClick={() => {
                          if (!takeoffMode) prefetchTakeoffRollup()
                          setTakeoffMode((mode) => !mode)
                        }}
                      >
                        <Calculator className="h-4 w-4" />
                        Takeoff
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      Measure quantities and price them
                    </TooltipContent>
                  </Tooltip>

                  {/* Measuring tools live inside takeoff mode, never beside the
                      annotation tools — they produce money, not marks. */}
                  <div
                    className={cn(
                      "flex items-center gap-0.5 overflow-hidden transition-[max-width,opacity,margin] duration-200 ease-out",
                      takeoffMode
                        ? "ml-1 max-w-[420px] opacity-100"
                        : "pointer-events-none ml-0 max-w-0 opacity-0",
                    )}
                  >
                    <Separator orientation="vertical" className="h-6 mx-1" />
                    {selectedCondition ? (
                      <span
                        className="flex h-8 max-w-[150px] items-center gap-1.5 rounded-lg border px-2 text-xs"
                        title={`Measuring into ${selectedCondition.name}`}
                      >
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: selectedCondition.color }}
                        />
                        <span className="truncate">{selectedCondition.name}</span>
                      </span>
                    ) : (
                      <span className="px-2 text-xs text-muted-foreground">
                        Pick a condition →
                      </span>
                    )}
                    {MEASURE_TOOLS.map((tool) => (
                      <Tooltip key={tool.type}>
                        <TooltipTrigger asChild>
                          <Button
                            variant={measureTools.activeTool === tool.type ? "secondary" : "ghost"}
                            size="icon"
                            className="h-10 w-10"
                            disabled={!canWriteTakeoff || !selectedCondition}
                            onClick={() => {
                              setActiveTool("pan")
                              measureTools.setActiveTool(
                                measureTools.activeTool === tool.type ? null : tool.type,
                              )
                            }}
                          >
                            <tool.icon className="h-4 w-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top">
                          <div className="font-medium">{tool.label}</div>
                          <div className="text-xs opacity-80">{tool.hint}</div>
                        </TooltipContent>
                      </Tooltip>
                    ))}
                    {/* Deduct applies to the area tool only — a run or a count
                        cannot be subtracted, so the toggle appears with the
                        tool it belongs to rather than sitting there greyed. */}
                    {measureTools.activeTool === "area" && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant={deductMode ? "secondary" : "ghost"}
                            size="icon"
                            className="h-10 w-10"
                            aria-pressed={deductMode}
                            disabled={!canWriteTakeoff || !selectedCondition}
                            onClick={() => setDeductMode((mode) => !mode)}
                          >
                            <Minus className="h-4 w-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top">
                          <div className="font-medium">
                            {deductMode ? "Deducting" : "Deduct"}
                          </div>
                          <div className="text-xs opacity-80">
                            Areas you trace subtract — a window out of the wall
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    )}

                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant={countingByExample ? "secondary" : "ghost"}
                          size="icon"
                          className="h-10 w-10"
                          aria-pressed={countingByExample}
                          disabled={!canWriteTakeoff || !selectedCondition}
                          onClick={() => {
                            setActiveTool("pan")
                            measureTools.setActiveTool(null)
                            if (countingByExample) dismissProposal()
                            else setCountingByExample(true)
                          }}
                        >
                          <Sparkles className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        <div className="font-medium">Count by example</div>
                        <div className="text-xs opacity-80">
                          Click one outlet — Arc finds the rest for you to check
                        </div>
                      </TooltipContent>
                    </Tooltip>

                    {measureTools.saving && (
                      <Loader2 className="mx-1 h-4 w-4 animate-spin text-muted-foreground" />
                    )}
                  </div>

                  <Separator orientation="vertical" className="h-6 mx-1" />
                </>
              )}
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
                    {activeTool === "dimension" && !calibration?.feet_per_image_px && (
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
                    {calibration?.feet_per_image_px
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

      {/* Live measurement readout. Sits above the dock while a shape is open so
          the number is where the eye already is, not across the screen. */}
      {measureTools.draft && (
        <div
          className={cn(
            "absolute bottom-24 z-20 -translate-x-1/2 transition-[left] duration-200",
            panelOpen ? "left-[calc(50%-190px)]" : "left-1/2",
          )}
        >
          <div className="flex items-center gap-3 rounded-xl border bg-background/95 px-3 py-2 shadow-xl backdrop-blur-md">
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: selectedCondition?.color ?? MARKUP_COLORS[4] }}
            />
            <span className="text-base font-semibold tabular-nums">
              {measureTools.draftLabel ?? "—"}
            </span>
            <span className="text-xs text-muted-foreground">
              {measureTools.remainingPoints > 0
                ? `${measureTools.remainingPoints} more point${measureTools.remainingPoints === 1 ? "" : "s"}`
                : measureTools.draft.tool === "area"
                  ? "Click the first point to close"
                  : "Enter to finish"}
            </span>
            <Separator orientation="vertical" className="h-5" />
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1"
              disabled={measureTools.remainingPoints > 0}
              onClick={() => measureTools.finish()}
            >
              <Check className="h-3.5 w-3.5" />
              Done
            </Button>
            <Button size="sm" variant="ghost" className="h-7" onClick={() => measureTools.cancel()}>
              Cancel
            </Button>
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

/**
 * The scale readout.
 *
 * Every quantity in takeoff mode is a multiple of this one number, so it gets
 * to say where it came from: dragged by hand, read off the title block, or
 * cross-checked against printed dimensions. A pipeline-derived scale is a
 * PROPOSAL until someone clicks Apply — auto-applying a wrong scale would
 * silently multiply every measurement on the sheet.
 */
function ScaleBar({
  calibration,
  applying,
  scanning,
  onApplyProposal,
  onCalibrate,
}: {
  calibration: SheetCalibration | null
  applying: boolean
  scanning: boolean
  onApplyProposal: () => void
  onCalibrate: () => void
}) {
  if (!calibration) {
    return (
      <div className="flex items-center gap-2 rounded-xl border bg-background/95 px-3 py-2 text-xs shadow-lg backdrop-blur-md">
        <Crosshair className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">This sheet has no published version to scale</span>
      </div>
    )
  }

  const proposal = calibration.proposal

  if (!calibration.feet_per_image_px) {
    if (scanning) {
      return (
        <div className="flex items-center gap-2 rounded-xl border bg-background/95 px-3 py-2 text-xs shadow-lg backdrop-blur-md">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          <span className="text-muted-foreground">Reading the scale off this sheet…</span>
        </div>
      )
    }
    if (proposal) {
      return (
        <div className="flex items-center gap-3 rounded-xl border bg-background/95 px-3 py-2 shadow-lg backdrop-blur-md">
          <div className="text-xs">
            <div className="font-medium">
              Scale detected{proposal.raw ? `: ${proposal.raw}` : ""}
            </div>
            <div className="text-muted-foreground">
              {proposal.method === "dimension_check"
                ? `Cross-checked against ${proposal.sample_count ?? 0} printed dimensions`
                : proposal.method === "space_area"
                  ? `Cross-checked against ${proposal.sample_count ?? 0} printed room areas`
                  : "Read from the title block"}
            </div>
          </div>
          <Button size="sm" className="h-7 gap-1" onClick={onApplyProposal} disabled={applying}>
            {applying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Apply
          </Button>
          <Button size="sm" variant="ghost" className="h-7" onClick={onCalibrate}>
            Set by hand
          </Button>
        </div>
      )
    }

    return (
      <div className="flex items-center gap-3 rounded-xl border bg-background/95 px-3 py-2 shadow-lg backdrop-blur-md">
        <span className="text-xs text-warning">No scale — measurements can&apos;t be priced yet</span>
        <Button size="sm" className="h-7 gap-1" onClick={onCalibrate}>
          <Crosshair className="h-3.5 w-3.5" />
          Set scale
        </Button>
      </div>
    )
  }

  // A scale carried forward from the previous revision is a guess that is
  // usually right — usable immediately, but flagged until someone confirms.
  const carried = !!calibration.carried_from_version_id

  return (
    <div className="flex items-center gap-2.5 rounded-xl border bg-background/95 px-3 py-2 shadow-lg backdrop-blur-md">
      <Crosshair className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="text-xs tabular-nums">
        {calibration.source_label ??
          `1 px = ${formatFeetInches(calibration.feet_per_image_px)}`}
      </span>
      {(calibration.method === "dimension_check" || calibration.method === "space_area") && !carried && (
        <Badge variant="outline" className="h-5 gap-1 px-1.5 text-[10px] font-normal">
          <Check className="h-2.5 w-2.5" />
          Verified
        </Badge>
      )}
      {carried && (
        <Badge
          variant="outline"
          className="h-5 gap-1 border-warning/40 px-1.5 text-[10px] font-normal text-warning"
        >
          Carried forward — verify
        </Badge>
      )}
      <Separator orientation="vertical" className="h-4" />
      <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={onCalibrate}>
        {carried ? "Verify" : "Recalibrate"}
      </Button>
    </div>
  )
}
