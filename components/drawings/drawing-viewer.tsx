"use client";

/**
 * The drawings workspace.
 *
 * One screen, no modes: the sheet rail on the left, the sheet (and its 3D
 * model, side by side or alone) in the middle, the takeoff ledger on the right.
 * One dock of tools is always there. A measuring tool always measures INTO a
 * takeoff item — picking Length, Area or Count asks what for, once, and the
 * next click on the sheet lands in it. One task bar at the top of the sheet
 * says what is happening right now; nothing else floats.
 *
 * The heavy lifting lives in hooks that are tested on their own: tiles in
 * `TiledDrawingViewer`, measuring in `useMeasureTools`, room detection in
 * `useAreaTakeoff`, the model in `useWorkspaceModel`, the takeoff rows in
 * `useTakeoffRollups`. This file wires them to the person.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { track } from "@vercel/analytics";
import { AlertTriangle, Camera, Check, Loader2, MapPin, Maximize, Minus, Move, Plus, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useIsMobile } from "@/components/ui/use-mobile";
import { cn } from "@/lib/utils";
import { unwrapAction } from "@/lib/action-result";
import type { MeasurementContext } from "@/lib/drawings/measurement-context";
import { conditionSourceUom, formatQuantity, measurementLabel, MEASURE_UOM_LABELS } from "@/lib/drawings/measure";
import { detectLocalScaleDisagreement, extractDimensionTokens } from "@/lib/drawings/scale";
import { snapPoint, type VectorIndex } from "@/lib/drawings/vector-snap";
import { findSymbolMatches } from "@/lib/drawings/symbol-match";
import { CONDITION_COLORS } from "@/lib/drawings/takeoff-palette";
import type { TextRunMatch } from "@/lib/drawings/text-runs";
import { MODEL_MATERIAL_COLORS, type BuildingObject, type SurfaceFinish } from "@/lib/drawings/architectural-model";
import { snapToWall } from "@/lib/drawings/furniture-layout";
import { roomAtSheetPoint, roomOutlineOnSheet, wallOutlineOnSheet } from "@/lib/drawings/model-takeoff";
import { ASSIST_MAX_SYMBOL_MATCHES } from "@/lib/validation/takeoff";
import { parseFeetInches } from "@/lib/validation/drawings";
import type { SheetCalibration } from "@/lib/services/drawings";
import type { FloorplanEdit } from "@/lib/drawings/floorplan-model";
import type { FloorplanTarget } from "@/lib/services/floorplan-models";
import type { TakeoffCondition } from "@/lib/services/takeoff";
import type { ReanchorReviewItem } from "@/lib/services/takeoff-reanchor";
import type { GpuDrawingViewer } from "@/lib/viewer";
import type {
  DrawingMarkup,
  DrawingPin,
  DrawingSheet,
  DrawingSheetVersion,
  MarkupType,
} from "@/app/(app)/drawings/types";
import {
  createDrawingMarkupAction,
  createPhotoFromDrawingAction,
  detectSheetVersionScaleAction,
  getPhotoForPinAction,
  getSheetCalibrationAction,
  getSheetCalloutLinksAction,
  listSheetVersionsWithUrlsAction,
  reportBrokenSheetTilesAction,
  setSheetVersionCalibrationAction,
} from "@/app/(app)/drawings/actions";
import {
  acceptSymbolMatchesAction,
  assignMarkupsToConditionAction,
  confirmReanchoredMarkupsAction,
  findSymbolMatchesByVisionAction,
  getTakeoffCoverageAction,
  symbolVisionAvailableAction,
} from "@/app/(app)/drawings/takeoff-actions";
import { uploadDocumentFileDirect } from "@/lib/services/files-client";

import { useDrawingPerformance, logPerformanceSummary } from "./use-drawing-performance";
import { usePrefetchAdjacentSheets } from "./use-prefetch-sheets";
import { KeyboardShortcutsHelp } from "./keyboard-shortcuts-help";
import { ComparisonViewer } from "./comparison-viewer";
import { MeasurementContextBar } from "./measurement-context-bar";
import { TakeoffRevisionBand } from "./takeoff-revision-band";
import { TiledDrawingViewer, type ImageToScreenMatrix, type TileManifest } from "./viewer/tiled-drawing-viewer";
import { SVGOverlay, type SVGOverlayHandle } from "./viewer/svg-overlay";
import { useMeasureTools, type NormPoint } from "./viewer/use-measure-tools";
import { useAreaTakeoff } from "./viewer/use-area-takeoff";
import { AreaTakeoffOverlay } from "./viewer/area-overlay";
import { useSheetVectors } from "./viewer/use-sheet-vectors";
import { useSheetTextRuns } from "./viewer/use-sheet-text-runs";
import { SheetTextSearch } from "./viewer/sheet-text-search";
import { ToolDock } from "./workspace/tool-dock";
import { TaskBar, TaskNote, TaskSwatch, TaskTitle } from "./workspace/task-bar";
import { Segmented } from "./workspace/segmented";
import { ScaleChip } from "./workspace/scale-chip";
import { SheetRail } from "./workspace/sheet-rail";
import { ItemPicker, type TakeoffScope } from "./workspace/item-picker";
import { TakeoffLedger } from "./workspace/takeoff-ledger";
import { EstimateHandoff } from "./workspace/estimate-handoff";
import { LineLedger, type LineMeasuring } from "./workspace/line-ledger";
import { OnSheetPanel, type SheetLink } from "./workspace/on-sheet-panel";
import { WorkspaceHeader } from "./workspace/workspace-header";
import { ModelPane } from "./workspace/model-pane";
import { DesignPanel, type PlacingPiece } from "./workspace/design-panel";
import { useModelExtras } from "./workspace/use-model-extras";
import { SheetScan, type ScanBay } from "./workspace/scan-overlay";
import { useTakeoffRollups } from "./workspace/use-takeoff-rollups";
import { useWorkspaceModel } from "./workspace/use-workspace-model";
import { useModelTakeoff } from "./workspace/use-model-takeoff";
import {
  REDLINE_COLOR,
  REDLINE_STROKE,
  TOOL_LABELS,
  toolForSourceUom,
  type MeasuringTool,
  type RedlineKind,
  type WorkspaceTool,
  type WorkspaceView,
} from "./workspace/workspace-tools";
import type { ModelLook, ModelMode, ModelPick, ModelViewerHandle } from "@/components/plans/model-viewer/model-viewer";
import { ALL_LEVELS } from "@/components/plans/model-viewer/model-controls";

/** A press that moves less than this places a point; further is a pan. */
const POINT_PLACEMENT_SLOP_PX = 4;
/** Screen px a takeoff click reaches for linework, clamped in image px. */
const SNAP_TOLERANCE_SCREEN_PX = 10;
const SNAP_TOLERANCE_MAX_IMAGE_PX = 32;
/** Click this close (image px) to a proposed count dot and you mean that dot. */
const PROPOSAL_HIT_RADIUS_PX = 14;
const MEASURE_FALLBACK_COLOR = CONDITION_COLORS[0];
const VIEW_STORAGE_KEY = "arc:drawings:view";
/** Whether the takeoff panel was left open — opening the drawings is usually just to look. */
const PANEL_STORAGE_KEY = "arc:drawings:panel";

/** What the viewer hands back to persist; the server computes quantity and uom. */
export type SaveMarkupInput = {
  drawing_sheet_id: string;
  sheet_version_id?: string;
  data: DrawingMarkup["data"];
  label?: string;
  is_private?: boolean;
  share_with_clients?: boolean;
  share_with_subs?: boolean;
  condition_id?: string | null;
};

interface DrawingViewerProps {
  measurementContext?: MeasurementContext;
  estimateId?: string;
  /** Measuring one pricing line: its takeoff item stays armed and Done puts the quantity on it. */
  line?: LineMeasuring;
  /**
   * A deal's sheet opened to read: the takeoff shows what was measured but
   * measures nothing new (that starts from a pricing line). Measurements new
   * plans carried over can still be confirmed.
   */
  viewOnly?: boolean;
  /** Open with the takeoff panel showing, as when new plans need measurements confirmed. */
  initialPanelOpen?: boolean;
  sheet: DrawingSheet;
  fileUrl?: string;
  markups?: DrawingMarkup[];
  pins?: DrawingPin[];
  highlightedPinId?: string;
  onClose: () => void;
  onSaveMarkup?: (markup: SaveMarkupInput) => Promise<void>;
  onDeleteMarkup?: (markupId: string) => Promise<void>;
  /** Measurements persist immediately; the host appends the saved row. */
  onSaveMeasurement?: (markup: SaveMarkupInput) => Promise<void>;
  /** Re-read this sheet's markups after a server-side save (rooms, counts). */
  onMarkupsChanged?: () => void;
  takeoffProjectId?: string | null;
  /** Production: measure a house plan; conditions belong to the plan version. */
  takeoffPlanVersionId?: string | null;
  canWriteTakeoff?: boolean;
  initialConditionId?: string | null;
  onCreatePin?: (x: number, y: number) => void;
  onPinClick?: (pin: DrawingPin) => void;
  readOnly?: boolean;
  sheets?: DrawingSheet[];
  onNavigateSheet?: (sheet: DrawingSheet) => void;
  imageThumbnailUrl?: string | null;
  imageWidth?: number | null;
  imageHeight?: number | null;
  /** The building this set describes; null when this workspace can't own one. */
  modelTarget?: FloorplanTarget | null;
  modelUnavailable?: { message: string; href?: string; linkLabel?: string } | null;
  canWriteModel?: boolean;
  initialView?: WorkspaceView;
  /** Opened from a register's "versions" action: show the revisions first. */
  initialVersionsOpen?: boolean;
  /** A saved 3D view or walkthrough to open (a shared `?modelView=` link). */
  initialModelViewId?: string | null;
}

interface Point {
  x: number;
  y: number;
}

interface RedlineDraft {
  type: MarkupType;
  points: Point[];
  text?: string;
}

/** A count, mid-review. `points` includes the clicked exemplar. */
interface CountProposal {
  status: "matching" | "ready" | "saving";
  points: NormPoint[];
  source: "geometry" | "vision" | "manual";
  truncated: boolean;
  discarded?: number;
  unverified?: boolean;
}

const REDLINE_TYPE: Record<RedlineKind, MarkupType> = {
  cloud: "cloud",
  arrow: "arrow",
  text: "text",
  freehand: "freehand",
};

const NO_MARKUPS: DrawingMarkup[] = [];
const NO_PINS: DrawingPin[] = [];
const NO_SHEETS: DrawingSheet[] = [];

const isMeasuringTool = (tool: WorkspaceTool): tool is MeasuringTool => tool === "length" || tool === "area" || tool === "count";

const isAreaCondition = (condition: TakeoffCondition) =>
  (condition.uom === "sf" || condition.uom === "sy") && !condition.height_ft && !condition.pitch_rise;

export function DrawingViewer({
  measurementContext,
  estimateId,
  line,
  viewOnly = false,
  initialPanelOpen = false,
  sheet,
  fileUrl,
  markups = NO_MARKUPS,
  pins = NO_PINS,
  highlightedPinId,
  onClose,
  onSaveMarkup,
  onDeleteMarkup,
  onSaveMeasurement,
  onMarkupsChanged,
  takeoffProjectId,
  takeoffPlanVersionId,
  canWriteTakeoff = false,
  initialConditionId = null,
  onCreatePin,
  onPinClick,
  readOnly = false,
  sheets = NO_SHEETS,
  onNavigateSheet,
  imageThumbnailUrl,
  imageWidth,
  imageHeight,
  modelTarget = null,
  modelUnavailable = null,
  canWriteModel = false,
  initialView,
  initialVersionsOpen = false,
  initialModelViewId = null,
}: DrawingViewerProps) {
  const isMobile = useIsMobile();

  // -------------------------------------------------------------------------
  // Performance
  // -------------------------------------------------------------------------
  const { markTiming, markFullyLoaded } = useDrawingPerformance({
    sheetId: sheet.id,
    onComplete: (metrics) => {
      logPerformanceSummary(metrics);
      track("drawing_loaded", {
        sheetId: metrics.sheetId,
        loadTime: metrics.loadTime,
        device: metrics.device,
        connection: metrics.connection || "unknown",
        fileSize: metrics.fileSize ?? 0,
      });
    },
  });

  // -------------------------------------------------------------------------
  // Workspace layout
  // -------------------------------------------------------------------------
  const modelAvailable = !!modelTarget || !!modelUnavailable;
  const [view, setViewState] = useState<WorkspaceView>(() => {
    if (initialView) return initialView;
    try {
      const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
      if (stored === "split" || stored === "3d") return stored;
    } catch {
      // Storage is a convenience; a blocked one just starts on the sheet.
    }
    return "sheet";
  });
  const effectiveView: WorkspaceView = modelAvailable ? view : "sheet";
  const setView = useCallback((next: WorkspaceView) => {
    setViewState(next);
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // Not persisted; the choice still applies to this session.
    }
  }, []);
  const [railOpen, setRailOpen] = useState(true);
  // Looking at a drawing is the common case; the panel opens for takeoff
  // (an item to measure, a deep link from an estimate) or because this person
  // left it open last time.
  const [panelOpen, setPanelOpenState] = useState(() => {
    if (initialConditionId || measurementContext || line || initialPanelOpen) return true;
    try {
      return window.localStorage.getItem(PANEL_STORAGE_KEY) === "open";
    } catch {
      return false;
    }
  });
  const setPanelOpen = useCallback((open: boolean) => {
    setPanelOpenState(open);
    try {
      window.localStorage.setItem(PANEL_STORAGE_KEY, open ? "open" : "closed");
    } catch {
      // Not persisted; the choice still applies to this session.
    }
  }, []);
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
  const [uiHidden, setUiHidden] = useState(false);
  useEffect(() => {
    if (isMobile) setRailOpen(false);
  }, [isMobile]);

  // -------------------------------------------------------------------------
  // Takeoff scope and rows
  // -------------------------------------------------------------------------
  const scope = useMemo<TakeoffScope | null>(
    () =>
      takeoffPlanVersionId
        ? { house_plan_version_id: takeoffPlanVersionId }
        : takeoffProjectId
          ? { project_id: takeoffProjectId }
          : null,
    [takeoffPlanVersionId, takeoffProjectId],
  );
  const takeoffAvailable = !!scope && !readOnly;
  const canConfirm = takeoffAvailable && canWriteTakeoff;
  const canMeasure = canConfirm && !viewOnly;
  const [refreshToken, setRefreshToken] = useState(0);
  const bump = useCallback(() => setRefreshToken((token) => token + 1), []);
  const { rollups, error: rollupError, reload: reloadRollups } = useTakeoffRollups(takeoffAvailable ? scope : null, refreshToken);
  const [rightTab, setRightTab] = useState<"takeoff" | "design" | "sheet">(takeoffAvailable ? "takeoff" : "sheet");
  useEffect(() => {
    if (rightTab === "design" && effectiveView === "sheet") setRightTab(takeoffAvailable ? "takeoff" : "sheet");
  }, [rightTab, effectiveView, takeoffAvailable]);

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------
  const [tool, setTool] = useState<WorkspaceTool>("select");
  const [armed, setArmed] = useState<TakeoffCondition | null>(null);
  const [picker, setPicker] = useState<{ tool: MeasuringTool | null; purpose: "arm" | "move" | "wall"; markup?: DrawingMarkup; wall?: { levelId: string; wallId: string } } | null>(null);
  const [areaMode, setAreaMode] = useState<"fill" | "draw">("fill");
  const [deductMode, setDeductMode] = useState(false);
  const [redlineKind, setRedlineKind] = useState<RedlineKind>("cloud");
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [hoveredConditionId, setHoveredConditionId] = useState<string | null>(null);
  const [inspected, setInspected] = useState<{ markup: DrawingMarkup; at: Point } | null>(null);
  const [issueAt, setIssueAt] = useState<{ point: Point; at: Point } | null>(null);
  const [textAt, setTextAt] = useState<{ point: Point; at: Point } | null>(null);
  const [textInput, setTextInput] = useState("");
  const [redlineDraft, setRedlineDraft] = useState<RedlineDraft | null>(null);
  const [pendingRedlines, setPendingRedlines] = useState<RedlineDraft[]>([]);
  const [rulerMeasurements, setRulerMeasurements] = useState<Array<Array<[number, number]>>>([]);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [review, setReview] = useState<{ items: ReanchorReviewItem[]; index: number } | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);

  // Layers
  const [showTakeoff, setShowTakeoff] = useState(true);
  const [showRedlines, setShowRedlines] = useState(true);
  const [showPins, setShowPins] = useState(true);
  const [calloutLinksOn, setCalloutLinksOn] = useState(false);
  const [calloutLinks, setCalloutLinks] = useState<SheetLink[]>([]);
  const [calloutLinksLoaded, setCalloutLinksLoaded] = useState(false);

  // -------------------------------------------------------------------------
  // Tiled sheet + transform
  // -------------------------------------------------------------------------
  const containerRef = useRef<HTMLDivElement>(null);
  const [gpuViewer, setGpuViewer] = useState<GpuDrawingViewer | null>(null);
  const handleViewerReady = useCallback((viewer: GpuDrawingViewer | null) => setGpuViewer((previous) => (previous === viewer ? previous : viewer)), []);
  const viewerMatrixRef = useRef<ImageToScreenMatrix | null>(null);
  const overlayHandleRef = useRef<SVGOverlayHandle | null>(null);
  const setOverlayHandle = useCallback((handle: SVGOverlayHandle | null) => {
    overlayHandleRef.current = handle;
    handle?.setTransform(viewerMatrixRef.current);
  }, []);
  const [viewerContainer, setViewerContainer] = useState<{ width: number; height: number } | null>(null);
  const [viewerZoom, setViewerZoom] = useState(1);
  const perfMarkedRef = useRef(false);
  const handleViewerTransformChange = useCallback(
    ({ matrix, container, zoom }: { matrix: ImageToScreenMatrix; container: { width: number; height: number }; zoom: number }) => {
      viewerMatrixRef.current = matrix;
      overlayHandleRef.current?.setTransform(matrix);
      setViewerContainer((previous) => (previous && previous.width === container.width && previous.height === container.height ? previous : container));
      setViewerZoom((previous) => (Math.round(previous * 100) === Math.round(zoom * 100) ? previous : zoom));
      if (!perfMarkedRef.current) {
        perfMarkedRef.current = true;
        markTiming("thumbnailLoad");
        markFullyLoaded();
      }
    },
    [markTiming, markFullyLoaded],
  );
  const tileBaseUrl = sheet.tile_base_url ?? null;
  const tileManifest = (sheet.tile_manifest ?? null) as TileManifest | null;
  const imageSize = useMemo(() => {
    if (tileManifest?.Image?.Size) return { width: tileManifest.Image.Size.Width, height: tileManifest.Image.Size.Height };
    const width = sheet.image_width ?? imageWidth;
    const height = sheet.image_height ?? imageHeight;
    return typeof width === "number" && typeof height === "number" ? { width, height } : null;
  }, [tileManifest, sheet.image_width, sheet.image_height, imageWidth, imageHeight]);
  const imageSizeRef = useRef(imageSize);
  imageSizeRef.current = imageSize;
  const hasTiles = !!tileBaseUrl && !!tileManifest && !!imageSize;

  const toNormalized = useCallback((clientX: number, clientY: number): Point | null => {
    const matrix = viewerMatrixRef.current;
    const size = imageSizeRef.current;
    const element = containerRef.current;
    if (!matrix || !size || !element) return null;
    const rect = element.getBoundingClientRect();
    const det = matrix.a * matrix.d - matrix.b * matrix.c;
    if (!det) return null;
    const dx = clientX - rect.left - matrix.e;
    const dy = clientY - rect.top - matrix.f;
    const x = (matrix.d * dx - matrix.c * dy) / det / size.width;
    const y = (-matrix.b * dx + matrix.a * dy) / det / size.height;
    return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y };
  }, []);
  const toScreen = useCallback((point: Point): Point | null => {
    const matrix = viewerMatrixRef.current;
    const size = imageSizeRef.current;
    if (!matrix || !size) return null;
    const px = point.x * size.width;
    const py = point.y * size.height;
    return { x: matrix.a * px + matrix.c * py + matrix.e, y: matrix.b * px + matrix.d * py + matrix.f };
  }, []);
  const reveal = useCallback(
    (points: Array<[number, number]>, minScale?: number) => {
      const size = imageSizeRef.current;
      if (!gpuViewer || !size || points.length === 0) return;
      const xs = points.map(([x]) => x * size.width);
      const ys = points.map(([, y]) => y * size.height);
      const pad = 80;
      gpuViewer.revealImageRect(
        { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, width: Math.max(...xs) - Math.min(...xs) + pad * 2, height: Math.max(...ys) - Math.min(...ys) + pad * 2 },
        minScale ? { minScale } : undefined,
      );
    },
    [gpuViewer],
  );

  // -------------------------------------------------------------------------
  // Calibration
  // -------------------------------------------------------------------------
  const [calibration, setCalibration] = useState<SheetCalibration | null>(null);
  const [scanningScale, setScanningScale] = useState(false);
  const [applyingProposal, setApplyingProposal] = useState(false);
  const [scaleOpen, setScaleOpen] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [calibrationPoints, setCalibrationPoints] = useState<Point[]>([]);
  const [calibrationInput, setCalibrationInput] = useState("");
  const [savingCalibration, setSavingCalibration] = useState(false);
  /** The tool to resume once a scale exists — measuring asked for one. */
  const resumeAfterScaleRef = useRef<MeasuringTool | "ruler" | null>(null);
  const feetPerImagePx = calibration?.feet_per_image_px ?? null;

  useEffect(() => {
    let cancelled = false;
    setCalibration(null);
    getSheetCalibrationAction(sheet.id)
      .then((value) => {
        if (!cancelled) setCalibration(unwrapAction(value));
      })
      .catch((failure) => {
        if (!cancelled) toast.error(failure instanceof Error ? failure.message : "Couldn't load this sheet's scale");
      });
    return () => {
      cancelled = true;
    };
  }, [sheet.id]);

  // Sheets uploaded before scale detection have no proposal; read it once.
  useEffect(() => {
    if (!canMeasure || !calibration?.sheet_version_id) return;
    if (calibration.feet_per_image_px || calibration.proposal || calibration.scanned) return;
    let cancelled = false;
    setScanningScale(true);
    detectSheetVersionScaleAction(calibration.sheet_version_id)
      .then((result) => {
        if (cancelled) return;
        if (!result.success) {
          toast.error(result.error || "Couldn't detect this sheet's scale. Reload to retry.");
          return;
        }
        setCalibration((previous) => (previous && previous.sheet_version_id === calibration.sheet_version_id ? { ...previous, proposal: result.data, scanned: true } : previous));
      })
      .catch(() => {
        if (!cancelled) toast.error("Couldn't detect this sheet's scale. Reload to retry.");
      })
      .finally(() => {
        if (!cancelled) setScanningScale(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canMeasure, calibration]);

  const exitCalibration = useCallback(() => {
    setCalibrating(false);
    setCalibrationPoints([]);
    setCalibrationInput("");
  }, []);

  const startCalibration = useCallback(() => {
    setScaleOpen(false);
    setCalibrating(true);
    setCalibrationPoints([]);
    setCalibrationInput("");
  }, []);

  // -------------------------------------------------------------------------
  // Measuring
  // -------------------------------------------------------------------------
  const vectorIndexRef = useRef<VectorIndex | null>(null);
  const altKeyRef = useRef(false);
  const [snapHit, setSnapHit] = useState<Point | null>(null);
  const snapMeasurePoint = useCallback((point: NormPoint): NormPoint | null => {
    const index = vectorIndexRef.current;
    const size = imageSizeRef.current;
    if (!index || !size || altKeyRef.current) {
      setSnapHit(null);
      return null;
    }
    const matrix = viewerMatrixRef.current;
    const scale = matrix ? Math.hypot(matrix.a, matrix.b) : 1;
    const tolerance = Math.min(SNAP_TOLERANCE_MAX_IMAGE_PX, Math.max(1, SNAP_TOLERANCE_SCREEN_PX / Math.max(scale, 1e-6)));
    const hit = snapPoint(index, { x: point.x * size.width, y: point.y * size.height }, tolerance);
    if (!hit) {
      setSnapHit(null);
      return null;
    }
    setSnapHit({ x: hit.point.x, y: hit.point.y });
    return { x: hit.point.x / size.width, y: hit.point.y / size.height };
  }, []);

  // Local scale check: printed dimensions inside a new measurement get a vote.
  const [localScaleWarning, setLocalScaleWarning] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [textMatches, setTextMatches] = useState<TextRunMatch[]>([]);
  const [activeTextMatchIndex, setActiveTextMatchIndex] = useState(0);
  const sheetTextRuns = useSheetTextRuns({ tileBaseUrl, active: findOpen || (canMeasure && !!feetPerImagePx) });
  const textRunsRef = useRef(sheetTextRuns.runs);
  textRunsRef.current = sheetTextRuns.runs;
  const checkLocalScale = useCallback(
    (points: Array<[number, number]>) => {
      const runs = textRunsRef.current;
      const size = imageSizeRef.current;
      if (runs.length === 0 || !feetPerImagePx || points.length < 2 || !size) return;
      const xs = points.map(([x]) => x);
      const ys = points.map(([, y]) => y);
      const tokens = runs.flatMap((run) => extractDimensionTokens(run.text, { x0: run.x, y0: run.y, x1: run.x + run.w, y1: run.y + run.h }));
      const disagreement = detectLocalScaleDisagreement({
        tokens,
        region: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) },
        sheetFeetPerUnit: feetPerImagePx * size.width,
      });
      if (disagreement)
        setLocalScaleWarning(
          `The dimensions printed here read about ${disagreement.ratio.toFixed(1)}× the sheet's scale. This looks like a detail at its own scale — check it before pricing.`,
        );
    },
    [feetPerImagePx],
  );
  const checkLocalScaleRef = useRef(checkLocalScale);
  checkLocalScaleRef.current = checkLocalScale;
  useEffect(() => {
    setLocalScaleWarning(null);
    setTextMatches([]);
    setActiveTextMatchIndex(0);
    setInspected(null);
    setIssueAt(null);
    setTextAt(null);
    setRulerMeasurements([]);
    setCalloutLinksLoaded(false);
    setCalloutLinks([]);
    exitCalibration();
  }, [sheet.id, exitCalibration]);

  const rulerModeRef = useRef(false);
  rulerModeRef.current = tool === "ruler";
  const armedRef = useRef(armed);
  armedRef.current = armed;

  const commitMeasurement = useCallback(
    async (payload: { type: "polyline" | "area" | "count"; points: Array<[number, number]>; deduction: boolean }) => {
      if (rulerModeRef.current) {
        setRulerMeasurements((previous) => [...previous.slice(-7), payload.points]);
        return;
      }
      const condition = armedRef.current;
      const save = onSaveMeasurement ?? onSaveMarkup;
      if (!save) throw new Error("Measurements can't be saved here");
      await save({
        drawing_sheet_id: sheet.id,
        sheet_version_id: calibration?.sheet_version_id,
        data: {
          type: payload.type,
          points: payload.points,
          color: condition?.color ?? MEASURE_FALLBACK_COLOR,
          strokeWidth: 2,
          ...(payload.deduction ? { style: { deduction: true } } : {}),
        },
        is_private: false,
        share_with_clients: false,
        share_with_subs: false,
        condition_id: condition?.id ?? null,
      });
      bump();
      checkLocalScaleRef.current(payload.points);
    },
    [onSaveMeasurement, onSaveMarkup, sheet.id, calibration?.sheet_version_id, bump],
  );

  const measureTools = useMeasureTools({
    imageSize,
    feetPerImagePx,
    deduction: deductMode,
    onCommit: commitMeasurement,
    snap: snapMeasurePoint,
  });
  const measureToolsRef = useRef(measureTools);
  measureToolsRef.current = measureTools;

  const autoAreas = useAreaTakeoff({
    sheetVersionId: calibration?.sheet_version_id ?? null,
    conditionId: armed?.id ?? null,
    scale: feetPerImagePx,
    imageSize,
    allowed: canMeasure,
    canAccept: !!armed && isAreaCondition(armed),
    scopeKey: takeoffPlanVersionId ?? takeoffProjectId ?? "",
    sourceKey: sheet.tile_base_url ?? "",
    onSaved: () => {
      bump();
      onMarkupsChanged?.();
    },
  });
  const autoAreasRef = useRef(autoAreas);
  autoAreasRef.current = autoAreas;

  const [countingByExample, setCountingByExample] = useState(false);
  const [countProposal, setCountProposal] = useState<CountProposal | null>(null);
  const countProposalRef = useRef(countProposal);
  countProposalRef.current = countProposal;

  const sheetVectors = useSheetVectors({
    tileBaseUrl,
    imageSize,
    active: canMeasure && (!!measureTools.activeTool || countingByExample || autoAreas.open || calibrating),
  });
  vectorIndexRef.current = sheetVectors.index;

  const [symbolVisionReady, setSymbolVisionReady] = useState(false);
  useEffect(() => {
    if (!canMeasure) return;
    let cancelled = false;
    symbolVisionAvailableAction()
      .then((available) => {
        if (!cancelled) setSymbolVisionReady(available);
      })
      .catch(() => {
        if (!cancelled) setSymbolVisionReady(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canMeasure]);

  /**
   * Count by example is how Count works: the first click finds every symbol
   * like it (on the linework, in the browser — no round trip); when nothing
   * matches, the click simply counts one and every later click adds one.
   */
  const runSymbolMatch = useCallback(
    async (click: NormPoint) => {
      const size = imageSizeRef.current;
      if (!size) return;
      setCountProposal({ status: "matching", points: [click], source: "geometry", truncated: false });
      const geometric = sheetVectors.segments ? findSymbolMatches(sheetVectors.segments, size, click, { maxMatches: ASSIST_MAX_SYMBOL_MATCHES, region: null }) : null;
      if (geometric && geometric.matches.length > 0) {
        // The matcher includes the clicked symbol at a better point than the
        // raw click; adding the click back would count it twice.
        const points = geometric.matches.map((match) => match.point);
        setCountProposal({ status: "ready", points, source: "geometry", truncated: geometric.truncated });
        measureToolsRef.current.setDraftPoints("count", points);
        return;
      }
      if (symbolVisionReady && calibration?.sheet_version_id) {
        setCountProposal({ status: "matching", points: [click], source: "vision", truncated: false });
        try {
          const proposal = unwrapAction(await findSymbolMatchesByVisionAction({ sheet_version_id: calibration.sheet_version_id, drawing_sheet_id: sheet.id, x: click.x, y: click.y }));
          if (proposal && proposal.points.length > 0) {
            const points = [click, ...proposal.points.map(([x, y]) => ({ x, y }))];
            setCountProposal({ status: "ready", points, source: "vision", truncated: proposal.truncated, discarded: proposal.discarded, unverified: proposal.unverified });
            measureToolsRef.current.setDraftPoints("count", points);
            return;
          }
        } catch (failure) {
          toast.error(failure instanceof Error ? failure.message : "Couldn't search this sheet");
        }
      }
      setCountProposal({ status: "ready", points: [click], source: "manual", truncated: false });
      measureToolsRef.current.setDraftPoints("count", [click]);
    },
    [sheetVectors.segments, symbolVisionReady, calibration?.sheet_version_id, sheet.id],
  );

  /** A click near a dot removes it; anywhere else adds one. */
  const editProposal = useCallback((click: NormPoint) => {
    const size = imageSizeRef.current;
    setCountProposal((previous) => {
      if (!previous || previous.status !== "ready") return previous;
      let nearest = -1;
      let nearestDistance = Number.POSITIVE_INFINITY;
      if (size)
        previous.points.forEach((point, index) => {
          const distance = Math.hypot((point.x - click.x) * size.width, (point.y - click.y) * size.height);
          if (distance < nearestDistance) {
            nearestDistance = distance;
            nearest = index;
          }
        });
      const points = nearest >= 0 && nearestDistance <= PROPOSAL_HIT_RADIUS_PX ? previous.points.filter((_, index) => index !== nearest) : [...previous.points, click];
      measureToolsRef.current.setDraftPoints("count", points);
      return { ...previous, points };
    });
  }, []);

  const dismissProposal = useCallback(() => {
    measureToolsRef.current.setDraftPoints("count", []);
    setCountProposal(null);
  }, []);

  const acceptProposal = useCallback(async () => {
    const proposal = countProposal;
    const condition = armedRef.current;
    if (!proposal || proposal.points.length === 0 || !calibration?.sheet_version_id) return;
    setCountProposal({ ...proposal, status: "saving" });
    try {
      const result = unwrapAction(
        await acceptSymbolMatchesAction({
          drawing_sheet_id: sheet.id,
          sheet_version_id: calibration.sheet_version_id,
          condition_id: condition?.id ?? null,
          points: proposal.points.map((point) => [point.x, point.y] as [number, number]),
        }),
      );
      toast.success(condition ? `Counted ${result.quantity} into ${condition.name}` : `Counted ${result.quantity}`);
      measureToolsRef.current.setDraftPoints("count", []);
      setCountProposal(null);
      bump();
      onMarkupsChanged?.();
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : "Couldn't save the count");
      setCountProposal({ ...proposal, status: "ready" });
    }
  }, [countProposal, calibration?.sheet_version_id, sheet.id, bump, onMarkupsChanged]);

  // -------------------------------------------------------------------------
  // Choosing tools
  // -------------------------------------------------------------------------
  const stopMeasuring = useCallback(() => {
    measureToolsRef.current.cancel();
    measureToolsRef.current.setActiveTool(null);
    autoAreasRef.current.close();
    dismissProposal();
    setCountingByExample(false);
    setDeductMode(false);
    setSnapHit(null);
  }, [dismissProposal]);

  const scaleReady = !!feetPerImagePx;

  const startMeasuring = useCallback(
    (condition: TakeoffCondition, next: MeasuringTool, mode = areaMode) => {
      stopMeasuring();
      setInspected(null);
      setIssueAt(null);
      setTool(next);
      if (next !== "count" && !scaleReady) {
        resumeAfterScaleRef.current = next;
        if (calibration?.proposal) setScaleOpen(true);
        else if (calibration) startCalibration();
        return;
      }
      if (next === "length") measureToolsRef.current.setActiveTool("polyline");
      else if (next === "count") setCountingByExample(true);
      else if (mode === "fill" && isAreaCondition(condition)) autoAreasRef.current.activate();
      else measureToolsRef.current.setActiveTool("area");
    },
    [stopMeasuring, areaMode, scaleReady, calibration, startCalibration],
  );

  const arm = useCallback(
    (condition: TakeoffCondition) => {
      setArmed(condition);
      // Measuring is takeoff: the ledger it lands in comes into view.
      setPanelOpenState(true);
      setRightTab("takeoff");
      startMeasuring(condition, toolForSourceUom(conditionSourceUom(condition.uom, condition)));
    },
    [startMeasuring],
  );

  const disarm = useCallback(() => {
    stopMeasuring();
    setArmed(null);
    setTool("select");
  }, [stopMeasuring]);

  const chooseTool = useCallback(
    (next: WorkspaceTool) => {
      setInspected(null);
      setIssueAt(null);
      setTextAt(null);
      if (isMeasuringTool(next)) {
        if (!canMeasure) return;
        if (armed && toolForSourceUom(conditionSourceUom(armed.uom, armed)) === next) {
          startMeasuring(armed, next);
          return;
        }
        if (line) {
          if (armed) toast(`${line.name} is measured by ${TOOL_LABELS[toolForSourceUom(conditionSourceUom(armed.uom, armed))].toLowerCase()}.`);
          return;
        }
        setPicker({ tool: next, purpose: "arm" });
        return;
      }
      stopMeasuring();
      setTool(next);
      if (next === "ruler") {
        if (!scaleReady) {
          resumeAfterScaleRef.current = "ruler";
          if (calibration?.proposal) setScaleOpen(true);
          else if (calibration) startCalibration();
          return;
        }
        measureToolsRef.current.setActiveTool("polyline");
      }
    },
    [canMeasure, armed, line, startMeasuring, stopMeasuring, scaleReady, calibration, startCalibration],
  );

  // Resume the tool that asked for a scale, the moment one exists.
  useEffect(() => {
    if (!scaleReady) return;
    const resume = resumeAfterScaleRef.current;
    if (!resume) return;
    resumeAfterScaleRef.current = null;
    if (resume === "ruler") measureToolsRef.current.setActiveTool("polyline");
    else if (armed) startMeasuring(armed, resume);
  }, [scaleReady, armed, startMeasuring]);

  // Arm the item a deep link or the line being measured names, once. A line's
  // item re-arms when its wall height changes, because that changes the tool.
  const armTarget = line?.conditionId ?? initialConditionId;
  const armedInitialRef = useRef<string | null>(null);
  useEffect(() => {
    if (!armTarget || !rollups || !canMeasure) return;
    const match = rollups.find((row) => row.condition.id === armTarget);
    if (!match) return;
    const reshaped = !!line && armed?.id === armTarget && armed.height_ft !== match.condition.height_ft;
    if (armedInitialRef.current === armTarget && !reshaped) return;
    armedInitialRef.current = armTarget;
    arm(match.condition);
  }, [armTarget, line, armed, rollups, canMeasure, arm]);
  const [lineRate, setLineRate] = useState(line?.rateCents ?? null);
  const [finishing, setFinishing] = useState(false);
  useEffect(() => setLineRate(line?.rateCents ?? null), [line?.conditionId, line?.rateCents]);

  // A tool belongs to a sheet; moving sheets stops whatever was half-drawn
  // but keeps the item armed, so the next sheet measures into it too.
  const startMeasuringRef = useRef(startMeasuring);
  startMeasuringRef.current = startMeasuring;
  const currentToolRef = useRef(tool);
  currentToolRef.current = tool;
  const sheetIdRef = useRef(sheet.id);
  useEffect(() => {
    if (sheetIdRef.current === sheet.id) return;
    sheetIdRef.current = sheet.id;
    measureToolsRef.current.setActiveTool(null);
    setCountProposal(null);
    setRedlineDraft(null);
    const condition = armedRef.current;
    const current = currentToolRef.current;
    if (!condition || !isMeasuringTool(current)) return;
    const timer = window.setTimeout(() => startMeasuringRef.current(condition, current), 0);
    return () => window.clearTimeout(timer);
  }, [sheet.id]);

  // Escape inside room detection closes it (the hook owns that key); when it
  // closes on its own while filling, measuring has ended.
  const detectionOpenRef = useRef<{ open: boolean; sheetId: string }>({ open: false, sheetId: sheet.id });
  useEffect(() => {
    const previous = detectionOpenRef.current;
    detectionOpenRef.current = { open: autoAreas.open, sheetId: sheet.id };
    if (previous.open && !autoAreas.open && previous.sheetId === sheet.id && currentToolRef.current === "area" && areaMode === "fill") disarm();
  }, [autoAreas.open, sheet.id, areaMode, disarm]);

  // -------------------------------------------------------------------------
  // Area fill
  // -------------------------------------------------------------------------
  const fillRoom = useCallback(
    async (point: [number, number]) => {
      const condition = armedRef.current;
      if (!condition) return;
      const { result, area } = await autoAreasRef.current.fillAt(point, condition);
      if (result === "saved" && area) {
        toast.success(`${area.label ?? "Room"} · +${formatQuantity(area.areaSqft)} SF into ${condition.name}`);
      } else if (result === "already" && area && onDeleteMarkup) {
        const inside = (markup: DrawingMarkup) => {
          if (markup.condition_id !== condition.id || markup.data.type !== "area") return false;
          const xs = markup.data.points.map(([x]) => x);
          const ys = markup.data.points.map(([, y]) => y);
          const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
          const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
          return autoAreasRef.current.roomAt([cx, cy])?.id === area.id;
        };
        const existing = markups.find(inside);
        if (existing) {
          await onDeleteMarkup(existing.id);
          autoAreasRef.current.release(area, condition.id);
          bump();
          toast.success(`${area.label ?? "Room"} taken out of ${condition.name}`);
        }
      } else if (result === "missed") {
        toast.info("That's outside every detected room. Switch to Draw outline to trace it.");
      }
    },
    [markups, onDeleteMarkup, bump],
  );

  // -------------------------------------------------------------------------
  // Pointer capture: points, rooms, counts, calibration, issues
  // -------------------------------------------------------------------------
  const pressOriginRef = useRef<{ x: number; y: number } | null>(null);
  const capturingClicks = (!spaceHeld && (!!measureTools.activeTool || calibrating || countingByExample || autoAreas.open || tool === "issue")) || false;
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const areaModeRef = useRef(areaMode);
  areaModeRef.current = areaMode;
  const calibratingRef = useRef(calibrating);
  calibratingRef.current = calibrating;
  const countingRef = useRef(countingByExample);
  countingRef.current = countingByExample;
  const fillRoomRef = useRef(fillRoom);
  fillRoomRef.current = fillRoom;

  useEffect(() => {
    const element = containerRef.current;
    if (!element || !capturingClicks) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-area-handle],[data-workspace-chrome]")) return;
      altKeyRef.current = event.altKey;
      if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
      pressOriginRef.current = { x: event.clientX, y: event.clientY };
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-area-handle],[data-workspace-chrome]")) return;
      altKeyRef.current = event.altKey;
      const origin = pressOriginRef.current;
      pressOriginRef.current = null;
      if (!origin || Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > POINT_PLACEMENT_SLOP_PX) return;
      const coords = toNormalized(event.clientX, event.clientY);
      if (!coords) return;
      const areas = autoAreasRef.current;
      if (calibratingRef.current) {
        const snapped = snapMeasurePoint(coords) ?? coords;
        setCalibrationPoints((previous) => (previous.length >= 2 ? previous : [...previous, snapped]));
        return;
      }
      if (areas.open) {
        if (areas.tool === "select" && toolRef.current === "area" && areaModeRef.current === "fill") {
          void fillRoomRef.current([coords.x, coords.y]);
          return;
        }
        const point = areas.tool === "select" || areas.tool === "region" ? coords : (snapMeasurePoint(coords) ?? coords);
        areas.click([point.x, point.y]);
        return;
      }
      if (countingRef.current) {
        const proposal = countProposalRef.current;
        if (proposal?.status === "ready") editProposal(coords);
        else if (!proposal) void runSymbolMatch(coords);
        return;
      }
      if (toolRef.current === "issue") {
        const rect = element.getBoundingClientRect();
        setIssueAt({ point: coords, at: { x: event.clientX - rect.left, y: event.clientY - rect.top } });
        return;
      }
      measureToolsRef.current.handleClick(coords);
    };
    const onPointerMove = (event: PointerEvent) => {
      altKeyRef.current = event.altKey;
      const coords = toNormalized(event.clientX, event.clientY);
      const areas = autoAreasRef.current;
      if (areas.open && areas.tool === "select") {
        areas.hover(coords ? [coords.x, coords.y] : null);
        return;
      }
      if ((areas.open && areas.tool !== "region") || calibratingRef.current) {
        if (coords) snapMeasurePoint(coords);
        return;
      }
      if (!measureToolsRef.current.isDrafting) {
        if (measureToolsRef.current.activeTool && coords) snapMeasurePoint(coords);
        return;
      }
      measureToolsRef.current.handleMove(coords);
    };
    const onPointerCancel = () => {
      pressOriginRef.current = null;
    };
    const onDoubleClick = (event: MouseEvent) => {
      if (calibratingRef.current || autoAreasRef.current.open) return;
      event.preventDefault();
      event.stopPropagation();
      measureToolsRef.current.handleDoubleClick();
    };
    element.addEventListener("pointerdown", onPointerDown, true);
    element.addEventListener("pointerup", onPointerUp, true);
    element.addEventListener("pointermove", onPointerMove, true);
    element.addEventListener("pointercancel", onPointerCancel, true);
    element.addEventListener("dblclick", onDoubleClick, true);
    return () => {
      element.removeEventListener("pointerdown", onPointerDown, true);
      element.removeEventListener("pointerup", onPointerUp, true);
      element.removeEventListener("pointermove", onPointerMove, true);
      element.removeEventListener("pointercancel", onPointerCancel, true);
      element.removeEventListener("dblclick", onDoubleClick, true);
    };
  }, [capturingClicks, toNormalized, snapMeasurePoint, editProposal, runSymbolMatch]);

  // Gestures follow the tool: click-zoom only while panning, never while
  // placing points (every vertex would zoom the sheet).
  const drawingRedline = tool === "redline" && !spaceHeld;
  useEffect(() => {
    if (!gpuViewer) return;
    const placing = !!measureTools.activeTool || autoAreas.open || calibrating || countingByExample || tool === "issue";
    gpuViewer.setGestureOptions({
      clickToZoom: tool === "pan" && !placing,
      dblClickToZoom: (tool === "pan" || tool === "select") && !placing,
      scrollToZoom: true,
    });
  }, [gpuViewer, tool, measureTools.activeTool, autoAreas.open, calibrating, countingByExample]);

  // -------------------------------------------------------------------------
  // Redlines: drawn on the overlay, saved the moment they are finished
  // -------------------------------------------------------------------------
  const saveRedline = useCallback(
    async (draft: RedlineDraft) => {
      if (!onSaveMarkup) return;
      setPendingRedlines((previous) => [...previous, draft]);
      try {
        await onSaveMarkup({
          drawing_sheet_id: sheet.id,
          sheet_version_id: calibration?.sheet_version_id,
          data: {
            type: draft.type,
            points: draft.points.map((point) => [point.x, point.y] as [number, number]),
            color: REDLINE_COLOR,
            strokeWidth: REDLINE_STROKE,
            ...(draft.text ? { text: draft.text } : {}),
          },
          is_private: false,
          share_with_clients: false,
          share_with_subs: false,
        });
      } finally {
        setPendingRedlines((previous) => previous.filter((item) => item !== draft));
      }
    },
    [onSaveMarkup, sheet.id, calibration?.sheet_version_id],
  );

  const onOverlayMouseDown = useCallback(
    (event: React.MouseEvent) => {
      if (!drawingRedline || readOnly) return;
      const coords = toNormalized(event.clientX, event.clientY);
      if (!coords) return;
      event.preventDefault();
      if (redlineKind === "text") {
        const rect = containerRef.current?.getBoundingClientRect();
        if (rect) setTextAt({ point: coords, at: { x: event.clientX - rect.left, y: event.clientY - rect.top } });
        setTextInput("");
        return;
      }
      setRedlineDraft({ type: REDLINE_TYPE[redlineKind], points: [coords] });
    },
    [drawingRedline, readOnly, toNormalized, redlineKind],
  );
  const onOverlayMouseMove = useCallback(
    (event: React.MouseEvent) => {
      if (!redlineDraft) return;
      const coords = toNormalized(event.clientX, event.clientY);
      if (!coords) return;
      setRedlineDraft((previous) =>
        previous ? { ...previous, points: previous.type === "freehand" ? [...previous.points, coords] : [previous.points[0], coords] } : null,
      );
    },
    [redlineDraft, toNormalized],
  );
  const onOverlayMouseUp = useCallback(() => {
    const draft = redlineDraft;
    setRedlineDraft(null);
    if (!draft || draft.points.length < 2) return;
    const size = imageSizeRef.current;
    const [a, b] = [draft.points[0], draft.points[draft.points.length - 1]];
    if (size && Math.hypot((a.x - b.x) * size.width, (a.y - b.y) * size.height) < 6 && draft.type !== "freehand") return;
    void saveRedline(draft);
  }, [redlineDraft, saveRedline]);

  // -------------------------------------------------------------------------
  // Calibration submit / proposal
  // -------------------------------------------------------------------------
  const saveCalibration = useCallback(async () => {
    const feet = parseFeetInches(calibrationInput);
    const size = imageSizeRef.current;
    if (!feet) {
      toast.error("Type a length like 24' 6\" or 10.5");
      return;
    }
    if (!calibration?.sheet_version_id || !size || calibrationPoints.length < 2) return;
    const pixels = Math.hypot((calibrationPoints[1].x - calibrationPoints[0].x) * size.width, (calibrationPoints[1].y - calibrationPoints[0].y) * size.height);
    if (pixels < 1) {
      toast.error("Those points are too close together. Pick a longer dimension.");
      setCalibrationPoints([]);
      return;
    }
    setSavingCalibration(true);
    try {
      const saved = unwrapAction(await setSheetVersionCalibrationAction({ sheet_version_id: calibration.sheet_version_id, feet_per_image_px: feet / pixels, method: "two_point" }));
      setCalibration(saved);
      toast.success(
        saved.recomputed_markups > 0
          ? `Scale saved · ${saved.recomputed_markups} ${saved.recomputed_markups === 1 ? "measurement" : "measurements"} recalculated`
          : "Scale saved",
      );
      bump();
      exitCalibration();
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : "Couldn't save the scale");
    } finally {
      setSavingCalibration(false);
    }
  }, [calibrationInput, calibration?.sheet_version_id, calibrationPoints, bump, exitCalibration]);

  const applyProposal = useCallback(async () => {
    const proposal = calibration?.proposal;
    if (!proposal || !calibration?.sheet_version_id) return;
    setApplyingProposal(true);
    try {
      const saved = unwrapAction(
        await setSheetVersionCalibrationAction({
          sheet_version_id: calibration.sheet_version_id,
          feet_per_image_px: proposal.feet_per_image_px,
          method: proposal.method,
          ...(proposal.raw ? { source_label: proposal.raw } : {}),
        }),
      );
      setCalibration(saved);
      setScaleOpen(false);
      toast.success(saved.recomputed_markups > 0 ? `Scale confirmed · ${saved.recomputed_markups} recalculated` : "Scale confirmed");
      bump();
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : "Couldn't apply the scale");
    } finally {
      setApplyingProposal(false);
    }
  }, [calibration, bump]);

  // -------------------------------------------------------------------------
  // Photos and issues
  // -------------------------------------------------------------------------
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [photoPins, setPhotoPins] = useState<DrawingPin[]>([]);
  const [pendingPhotoPosition, setPendingPhotoPosition] = useState<Point | null>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoCaption, setPhotoCaption] = useState("");
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoUploadPercent, setPhotoUploadPercent] = useState<number | null>(null);
  const [photoView, setPhotoView] = useState<{ pin: DrawingPin; loading: boolean; url?: string; fileName?: string; takenAt?: string | null; error?: string } | null>(null);
  useEffect(() => {
    setPhotoPins([]);
    setPendingPhotoPosition(null);
  }, [sheet.id]);
  const photoPreviewUrl = useMemo(() => (photoFile ? URL.createObjectURL(photoFile) : null), [photoFile]);
  useEffect(() => () => {
    if (photoPreviewUrl) URL.revokeObjectURL(photoPreviewUrl);
  }, [photoPreviewUrl]);
  const resetPhoto = useCallback(() => {
    setPhotoFile(null);
    setPhotoCaption("");
    setPendingPhotoPosition(null);
    setPhotoUploadPercent(null);
  }, []);
  const submitPhoto = async () => {
    if (!photoFile || !pendingPhotoPosition) return;
    setPhotoUploading(true);
    setPhotoUploadPercent(0);
    try {
      const uploaded = await uploadDocumentFileDirect(photoFile, { projectId: sheet.project_id, category: "photos", onProgress: (progress) => setPhotoUploadPercent(progress.percent) });
      const pin = unwrapAction(
        await createPhotoFromDrawingAction({
          project_id: sheet.project_id,
          drawing_sheet_id: sheet.id,
          x_position: pendingPhotoPosition.x,
          y_position: pendingPhotoPosition.y,
          file_id: uploaded.id,
          caption: photoCaption.trim() || undefined,
        }),
      );
      setPhotoPins((previous) => [...previous, pin]);
      toast.success("Photo pinned");
      resetPhoto();
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : "Couldn't attach the photo");
    } finally {
      setPhotoUploading(false);
      setPhotoUploadPercent(null);
    }
  };
  const openPhotoPin = useCallback(async (pin: DrawingPin) => {
    setPhotoView({ pin, loading: true });
    try {
      const photo = await getPhotoForPinAction(pin.entity_id);
      setPhotoView(photo ? { pin, loading: false, url: photo.url, fileName: photo.file_name ?? undefined, takenAt: photo.taken_at } : { pin, loading: false, error: "Photo not found" });
    } catch (failure) {
      setPhotoView({ pin, loading: false, error: failure instanceof Error ? failure.message : "Couldn't load the photo" });
    }
  }, []);
  const allPins = useMemo(() => {
    if (photoPins.length === 0) return pins;
    const seen = new Set(pins.map((pin) => pin.id));
    return [...pins, ...photoPins.filter((pin) => !seen.has(pin.id))];
  }, [pins, photoPins]);
  const pinTypes = useMemo(() => [...new Set(allPins.map((pin) => pin.entity_type))].sort(), [allPins]);
  const [hiddenPinTypes, setHiddenPinTypes] = useState<ReadonlySet<string>>(new Set());
  const visiblePins = useMemo(() => (hiddenPinTypes.size === 0 ? allPins : allPins.filter((pin) => !hiddenPinTypes.has(pin.entity_type))), [allPins, hiddenPinTypes]);
  const activatePin = useCallback(
    (pin: DrawingPin) => {
      if (pin.entity_type === "photo") void openPhotoPin(pin);
      else onPinClick?.(pin);
    },
    [onPinClick, openPhotoPin],
  );

  // -------------------------------------------------------------------------
  // Callout links
  // -------------------------------------------------------------------------
  const loadCalloutLinks = useCallback(() => {
    getSheetCalloutLinksAction(sheet.id)
      .then((result) => {
        setCalloutLinks(result.success ? result.data : []);
        setCalloutLinksLoaded(true);
        if (!result.success) toast.error(result.error);
      })
      .catch(() => setCalloutLinksLoaded(true));
  }, [sheet.id]);
  useEffect(() => {
    if (calloutLinksOn && !calloutLinksLoaded) loadCalloutLinks();
  }, [calloutLinksOn, calloutLinksLoaded, loadCalloutLinks]);
  const openSheetById = useCallback(
    (sheetId: string) => {
      const target = sheets.find((candidate) => candidate.id === sheetId);
      if (!target) {
        toast.error("That sheet isn't in this set");
        return;
      }
      onNavigateSheet?.(target);
    },
    [sheets, onNavigateSheet],
  );

  // -------------------------------------------------------------------------
  // Versions and compare
  // -------------------------------------------------------------------------
  const [versions, setVersions] = useState<DrawingSheetVersion[]>([]);
  const [versionsOpen, setVersionsOpen] = useState(initialVersionsOpen);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [compare, setCompare] = useState<[string, string] | null>(null);
  const versionsTriedRef = useRef<string | null>(null);
  useEffect(() => {
    setVersions([]);
  }, [sheet.id]);
  const loadVersions = useCallback(async () => {
    if (versionsLoading || versions.length > 0 || versionsTriedRef.current === sheet.id) return;
    versionsTriedRef.current = sheet.id;
    setVersionsLoading(true);
    try {
      setVersions(await listSheetVersionsWithUrlsAction(sheet.id));
    } catch {
      toast.error("Couldn't load this sheet's versions");
    } finally {
      setVersionsLoading(false);
    }
  }, [sheet.id, versions.length, versionsLoading]);
  useEffect(() => {
    if (versionsOpen && versions.length === 0) void loadVersions();
  }, [versionsOpen, versions.length, loadVersions]);

  // -------------------------------------------------------------------------
  // Sheet navigation and coverage
  // -------------------------------------------------------------------------
  const currentIndex = sheets.findIndex((candidate) => candidate.id === sheet.id);
  const busy = autoAreas.busy === "saving" || measureTools.saving;
  const goPrev = useCallback(() => {
    if (!busy && currentIndex > 0) onNavigateSheet?.(sheets[currentIndex - 1]);
  }, [busy, currentIndex, onNavigateSheet, sheets]);
  const goNext = useCallback(() => {
    if (!busy && currentIndex >= 0 && currentIndex < sheets.length - 1) onNavigateSheet?.(sheets[currentIndex + 1]);
  }, [busy, currentIndex, onNavigateSheet, sheets]);
  usePrefetchAdjacentSheets(sheet.id, sheets, !compare);

  const [measuredSheets, setMeasuredSheets] = useState<Map<string, number> | undefined>(undefined);
  useEffect(() => {
    if (!takeoffAvailable || !scope) return;
    let cancelled = false;
    const coverageScope =
      "project_id" in scope ? scope : { house_plan_version_id: scope.house_plan_version_id, source_project_ids: takeoffProjectId ? [takeoffProjectId] : [] };
    getTakeoffCoverageAction(coverageScope)
      .then((result) => {
        if (cancelled) return;
        const sheets = result.success ? result.data.sheets : [];
        setMeasuredSheets(new Map(sheets.filter((entry) => entry.markup_count > 0).map((entry) => [entry.drawing_sheet_id, entry.markup_count])));
      })
      .catch(() => {
        if (!cancelled) setMeasuredSheets(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [takeoffAvailable, scope, takeoffProjectId, refreshToken]);
  // -------------------------------------------------------------------------
  // Revision review walk
  // -------------------------------------------------------------------------
  const reviewItem = review ? review.items[review.index] : null;
  useEffect(() => {
    if (!reviewItem) return;
    if (reviewItem.drawing_sheet_id !== sheet.id) {
      openSheetById(reviewItem.drawing_sheet_id);
      return;
    }
    const markup = markups.find((candidate) => candidate.id === reviewItem.markup_id);
    if (markup) reveal(markup.data.points);
  }, [reviewItem, sheet.id, markups, openSheetById, reveal]);
  const advanceReview = useCallback(() => {
    setReview((current) => {
      if (!current) return null;
      if (current.index + 1 >= current.items.length) {
        toast.success("Revision review done. Totals are up to date.");
        return null;
      }
      return { ...current, index: current.index + 1 };
    });
  }, []);
  const resolveReview = useCallback(
    async (action: "confirm" | "delete") => {
      if (!reviewItem) return;
      setReviewBusy(true);
      try {
        if (action === "confirm") unwrapAction(await confirmReanchoredMarkupsAction([reviewItem.markup_id]));
        else await onDeleteMarkup?.(reviewItem.markup_id);
        bump();
        onMarkupsChanged?.();
        advanceReview();
      } catch (failure) {
        toast.error(failure instanceof Error ? failure.message : "Couldn't update that measurement");
      } finally {
        setReviewBusy(false);
      }
    },
    [reviewItem, onDeleteMarkup, bump, onMarkupsChanged, advanceReview],
  );

  // -------------------------------------------------------------------------
  // The 3D model
  // -------------------------------------------------------------------------
  const modelShown = effectiveView !== "sheet";
  const modelState = useWorkspaceModel(modelTarget, modelShown && !!modelTarget);
  const model = modelState.model;
  const viewerRef = useRef<ModelViewerHandle>(null);
  const [modelFocus, setModelFocus] = useState<string>(ALL_LEVELS);
  const [cutaway, setCutaway] = useState(true);
  const [look, setLook] = useState<ModelLook>("real");
  const [modelMode, setModelMode] = useState<ModelMode>("orbit");
  const [modelSelected, setModelSelected] = useState<ModelPick | null>(null);
  const [modelHover, setModelHover] = useState<ModelPick | null>(null);
  const [placing, setPlacing] = useState<PlacingPiece | null>(null);
  const [sheetHoverRoom, setSheetHoverRoom] = useState<{ levelId: string; roomId: string } | null>(null);
  const modelTakeoff = useModelTakeoff({ model, enabled: modelShown, rollups, activeMarkups: markups, refreshToken });

  const sheetLevel = useMemo(() => {
    if (!model) return null;
    return (
      model.levels.find((level) => level.source.sheetVersionId === calibration?.sheet_version_id) ??
      model.levels.find((level) => level.source.sheetNumber === sheet.sheet_number) ??
      null
    );
  }, [model, calibration?.sheet_version_id, sheet.sheet_number]);
  // The sheet on screen picks the floor, unless someone chose "All".
  useEffect(() => {
    if (sheetLevel) setModelFocus((current) => (current === ALL_LEVELS ? current : sheetLevel.id));
  }, [sheetLevel]);
  const modelSources = useMemo(() => {
    const map = new Map<string, string>();
    if (!model) return map;
    for (const level of model.levels) {
      const match = sheets.find((candidate) => candidate.sheet_number === level.source.sheetNumber);
      if (match) map.set(match.id, level.name);
    }
    return map;
  }, [model, sheets]);

  // While Arc is reading this sheet — rooms, symbols, its scale, or tracing it for 3D — the sheet shows it.
  const tracingThisSheet = modelState.phase === "generating" && (modelSources.has(sheet.id) || modelState.sheets.some((source) => source.sheetNumber === sheet.sheet_number));
  const scanCaption =
    autoAreas.busy === "detecting"
      ? `${sheet.sheet_number} · finding rooms`
      : countProposal?.status === "matching"
        ? `${sheet.sheet_number} · matching symbols`
        : scanningScale
          ? `${sheet.sheet_number} · reading the scale`
          : tracingThisSheet
            ? `${sheet.sheet_number} · tracing for 3D`
            : null;
  const scanBays = useMemo<ScanBay[]>(() => {
    if (modelState.sheets.length > 0) {
      return modelState.sheets.map((source) => ({
        key: source.sheetVersionId,
        name: model?.levels.find((level) => level.source.sheetVersionId === source.sheetVersionId)?.name ?? source.sheetTitle ?? source.sheetNumber ?? "Sheet",
        sheetNumber: source.sheetNumber,
        thumbnailUrl: source.thumbnailUrl,
      }));
    }
    return [{ key: sheet.id, name: sheet.sheet_title ?? sheet.sheet_number, sheetNumber: sheet.sheet_number, thumbnailUrl: imageThumbnailUrl ?? null }];
  }, [modelState.sheets, model, sheet.id, sheet.sheet_title, sheet.sheet_number, imageThumbnailUrl]);

  const modelExtras = useModelExtras({
    model,
    target: modelTarget ?? null,
    projectId: modelTarget?.kind === "project" ? modelTarget.projectId : null,
    enabled: modelShown && !!model,
    takeoff: modelTakeoff.byLevel,
    rollups,
    pins: showPins ? visiblePins : NO_PINS,
    sheetLevel,
  });
  const applyModelEdits = useCallback(
    async (edits: FloorplanEdit[], label: string) => {
      for (let start = 0; start < edits.length; start += 50) {
        if (!(await modelState.applyEdit(edits.slice(start, start + 50)))) return;
      }
      toast.success(label);
    },
    [modelState],
  );

  // Sheet → model: the room under the cursor lights up in 3D.
  useEffect(() => {
    const element = containerRef.current;
    if (!element || effectiveView !== "split" || !sheetLevel) {
      setSheetHoverRoom(null);
      return;
    }
    let frame = 0;
    const onMove = (event: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const coords = toNormalized(event.clientX, event.clientY);
        const room = coords ? roomAtSheetPoint(sheetLevel, coords) : null;
        setSheetHoverRoom((current) =>
          room ? (current?.roomId === room.id ? current : { levelId: sheetLevel.id, roomId: room.id }) : current ? null : current,
        );
      });
    };
    const onLeave = () => setSheetHoverRoom(null);
    element.addEventListener("pointermove", onMove);
    element.addEventListener("pointerleave", onLeave);
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerleave", onLeave);
    };
  }, [effectiveView, sheetLevel, toNormalized]);

  const modelHighlight = useMemo(() => {
    const ids: string[] = [];
    if (hoveredConditionId) ids.push(...(modelTakeoff.byCondition.get(hoveredConditionId) ?? []));
    if (sheetHoverRoom) ids.push(sheetHoverRoom.roomId);
    return ids;
  }, [hoveredConditionId, modelTakeoff.byCondition, sheetHoverRoom]);

  // Model → sheet: the hovered (or selected) surface outlined on its sheet.
  const modelOutline = useMemo(() => {
    const pick = modelHover ?? modelSelected;
    if (!pick || !model || !sheetLevel || pick.levelId !== sheetLevel.id) return null;
    if (pick.kind === "room") return { kind: "room" as const, points: roomOutlineOnSheet(sheetLevel, pick.id) };
    if (pick.kind === "wall") return { kind: "wall" as const, points: wallOutlineOnSheet(sheetLevel, pick.id) };
    return null;
  }, [modelHover, modelSelected, model, sheetLevel]);

  const sourceSheetFor = useCallback(
    (levelId: string) => {
      const level = model?.levels.find((candidate) => candidate.id === levelId);
      if (!level) return null;
      const target = sheets.find((candidate) => candidate.sheet_number === level.source.sheetNumber);
      return target ? { level, sheet: target } : null;
    },
    [model, sheets],
  );

  /** Save a measurement onto a model level's source sheet, wherever it is. */
  const saveOnSourceSheet = useCallback(
    async (levelId: string, input: { type: "area" | "polyline"; points: Array<[number, number]>; condition: TakeoffCondition }) => {
      const source = sourceSheetFor(levelId);
      if (!source) {
        toast.error("The sheet this floor was traced from isn't in this set");
        return false;
      }
      const markup: SaveMarkupInput = {
        drawing_sheet_id: source.sheet.id,
        sheet_version_id: source.level.source.sheetVersionId,
        data: { type: input.type, points: input.points, color: input.condition.color, strokeWidth: 2 },
        is_private: false,
        share_with_clients: false,
        share_with_subs: false,
        condition_id: input.condition.id,
      };
      try {
        if (source.sheet.id === sheet.id && onSaveMeasurement) await onSaveMeasurement(markup);
        else unwrapAction(await createDrawingMarkupAction(markup));
        bump();
        return true;
      } catch (failure) {
        toast.error(failure instanceof Error ? failure.message : "Couldn't add that to the takeoff");
        return false;
      }
    },
    [sourceSheetFor, sheet.id, onSaveMeasurement, bump],
  );

  const assignRoom = useCallback(
    async (levelId: string, roomId: string, conditionId: string) => {
      const condition = rollups?.find((row) => row.condition.id === conditionId)?.condition;
      if (!condition) return;
      const counted = modelTakeoff.byLevel[levelId]?.[roomId];
      if (counted) {
        try {
          unwrapAction(await assignMarkupsToConditionAction({ condition_id: conditionId, markup_ids: counted.markupIds }));
          toast.success(`Moved into ${condition.name}`);
          bump();
          onMarkupsChanged?.();
        } catch (failure) {
          toast.error(failure instanceof Error ? failure.message : "Couldn't move that room");
        }
        return;
      }
      const level = model?.levels.find((candidate) => candidate.id === levelId);
      const outline = level ? roomOutlineOnSheet(level, roomId) : null;
      if (!outline) return;
      if (await saveOnSourceSheet(levelId, { type: "area", points: outline, condition })) toast.success(`Added to ${condition.name}`);
    },
    [rollups, modelTakeoff.byLevel, model, saveOnSourceSheet, bump, onMarkupsChanged],
  );

  const addWallToTakeoff = useCallback((levelId: string, wallId: string) => {
    setPicker({ tool: "length", purpose: "wall", wall: { levelId, wallId } });
  }, []);

  const objectEdit = useCallback(
    (levelId: string, object: BuildingObject | null, removeId?: string) => {
      if (object) void modelState.applyEdit({ type: "object.upsert", levelId, object });
      else if (removeId) {
        void modelState.applyEdit({ type: "object.delete", levelId, objectId: removeId });
        setModelSelected(null);
      }
    },
    [modelState],
  );

  const placeObject = useCallback(
    (point: { levelId: string; xFt: number; yFt: number }) => {
      if (!placing) return;
      const level = model?.levels.find((candidate) => candidate.id === point.levelId);
      // A piece that belongs on a wall backs onto the nearest one within reach.
      const snap = placing.againstWall && level ? snapToWall(level, { xFt: point.xFt, yFt: point.yFt, widthFt: placing.widthFt, depthFt: placing.depthFt }, 2.5) : null;
      const object: BuildingObject = {
        id: `object-${crypto.randomUUID()}`,
        kind: placing.kind,
        name: placing.name,
        xFt: snap?.xFt ?? point.xFt,
        yFt: snap?.yFt ?? point.yFt,
        widthFt: placing.widthFt,
        depthFt: placing.depthFt,
        heightFt: placing.heightFt,
        elevationFt: 0,
        rotationDeg: snap?.rotationDeg ?? 0,
        color: MODEL_MATERIAL_COLORS.furniture,
        ...(placing.modelId ? { modelId: placing.modelId } : {}),
      };
      setPlacing(null);
      void modelState.applyEdit({ type: "object.upsert", levelId: point.levelId, object }).then((saved) => {
        if (saved) setModelSelected({ kind: "object", id: object.id, levelId: point.levelId });
      });
    },
    [placing, modelState, model],
  );

  const moveObject = useCallback(
    (change: { levelId: string; objectId: string; xFt: number; yFt: number }) => {
      const level = model?.levels.find((candidate) => candidate.id === change.levelId);
      const object = level?.objects?.find((candidate) => candidate.id === change.objectId);
      if (object) void modelState.applyEdit({ type: "object.upsert", levelId: change.levelId, object: { ...object, xFt: change.xFt, yFt: change.yFt } });
    },
    [model, modelState],
  );

  const showPickOnSheet = useCallback(
    (pick: ModelPick) => {
      const source = sourceSheetFor(pick.levelId);
      if (!source) return;
      if (effectiveView === "3d") setView("split");
      if (source.sheet.id !== sheet.id) {
        onNavigateSheet?.(source.sheet);
        return;
      }
      const points = pick.kind === "room" ? roomOutlineOnSheet(source.level, pick.id) : pick.kind === "wall" ? wallOutlineOnSheet(source.level, pick.id) : null;
      if (points) reveal(points);
    },
    [sourceSheetFor, effectiveView, setView, sheet.id, onNavigateSheet, reveal],
  );

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------
  const keyHandlers = useRef({
    escape: () => {},
  });
  keyHandlers.current.escape = () => {
    if (busy) return;
    if (picker) return setPicker(null);
    if (placing) return setPlacing(null);
    if (inspected || issueAt || textAt) {
      setInspected(null);
      setIssueAt(null);
      setTextAt(null);
      return;
    }
    if (calibrating) return exitCalibration();
    if (review) return setReview(null);
    if (countProposal) return dismissProposal();
    if (measureTools.isDrafting) return; // the measure hook cancels the shape itself
    if (autoAreas.open && autoAreas.tool !== "select") return;
    if (tool === "ruler" && rulerMeasurements.length) return setRulerMeasurements([]);
    if (line && isMeasuringTool(tool)) {
      stopMeasuring();
      return setTool("select");
    }
    if (isMeasuringTool(tool) || tool !== "select") return disarm();
    if (findOpen) return setFindOpen(false);
    if (modelSelected) return setModelSelected(null);
    onClose();
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      if (target?.closest("[role=dialog],[role=menu]")) return;
      if (event.key === " ") {
        if (!event.repeat) setSpaceHeld(true);
        event.preventDefault();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFindOpen(true);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      // Over the 3D view, W walks; let the viewer have its movement keys.
      if (document.querySelector("[aria-label='3D model of this building']:hover") && ["w", "a", "s", "d"].includes(key)) {
        if (key === "w" && modelMode === "orbit") setModelMode("walk");
        return;
      }
      const toolKeys: Record<string, WorkspaceTool> = { v: "select", h: "pan", l: "length", a: "area", c: "count", r: "ruler", m: "redline", i: "issue" };
      if (toolKeys[key]) {
        event.preventDefault();
        if (toolKeys[key] === "redline" && readOnly) return;
        chooseTool(toolKeys[key]);
        return;
      }
      switch (event.key) {
        case "Escape":
          keyHandlers.current.escape();
          return;
        case "1":
        case "2":
        case "3":
          if (modelAvailable) setView((["sheet", "split", "3d"] as const)[Number(event.key) - 1]);
          return;
        case "[":
        case "ArrowLeft":
          goPrev();
          return;
        case "]":
        case "ArrowRight":
          goNext();
          return;
        case "/":
          event.preventDefault();
          setFindOpen(true);
          return;
        case "+":
        case "=":
          gpuViewer?.zoomBy(1.2);
          return;
        case "-":
          gpuViewer?.zoomBy(1 / 1.2);
          return;
        case "0":
          gpuViewer?.goHome();
          return;
        case "?":
          setShortcutsOpen(true);
          return;
        case "\\":
          setUiHidden((value) => !value);
          return;
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === " ") setSpaceHeld(false);
    };
    const onBlur = () => setSpaceHeld(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [chooseTool, goPrev, goNext, gpuViewer, modelAvailable, setView, readOnly, modelMode]);

  // Hide the app's mobile bottom bar while the workspace is open.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("arc-immersive-view", { detail: { active: true } }));
    return () => {
      window.dispatchEvent(new CustomEvent("arc-immersive-view", { detail: { active: false } }));
    };
  }, []);

  // -------------------------------------------------------------------------
  // Drafts drawn on the overlay
  // -------------------------------------------------------------------------
  const drafts = useMemo(() => {
    if (!imageSize) return [];
    const toPx = (point: Point) => ({ x: point.x * imageSize.width, y: point.y * imageSize.height });
    const list: Array<{ type: string; points: Point[]; color: string; strokeWidth: number; text?: string; label?: string | null; style?: Record<string, unknown> | null }> = [];
    for (const draft of [...pendingRedlines, ...(redlineDraft ? [redlineDraft] : [])])
      list.push({ type: draft.type, points: draft.points.map(toPx), color: REDLINE_COLOR, strokeWidth: REDLINE_STROKE, text: draft.text });
    const shape = measureTools.draft;
    if (shape) {
      const points = [...shape.points];
      if (shape.cursor && shape.tool !== "count") points.push(shape.cursor);
      list.push({
        type: shape.tool,
        points: points.map(toPx),
        color: tool === "ruler" ? MEASURE_FALLBACK_COLOR : (armed?.color ?? MEASURE_FALLBACK_COLOR),
        strokeWidth: 2,
        label: measureTools.draftLabel,
        style: shape.deduction ? { deduction: true } : null,
      });
    }
    for (const points of rulerMeasurements)
      list.push({
        type: "polyline",
        points: points.map(([x, y]) => toPx({ x, y })),
        color: MEASURE_FALLBACK_COLOR,
        strokeWidth: 2,
        label: measurementLabel({ type: "polyline", points }, imageSize, feetPerImagePx),
      });
    if (calibrating && calibrationPoints.length > 0) {
      const px = calibrationPoints.map(toPx);
      list.push(
        px.length === 1
          ? { type: "circle", points: [px[0], { x: px[0].x + 6, y: px[0].y }], color: MEASURE_FALLBACK_COLOR, strokeWidth: 2 }
          : {
              type: "dimension",
              points: px,
              color: MEASURE_FALLBACK_COLOR,
              strokeWidth: 2,
              label: measurementLabel({ type: "dimension", points: calibrationPoints.map((point) => [point.x, point.y] as [number, number]) }, imageSize, feetPerImagePx),
            },
      );
    }
    return list;
  }, [imageSize, pendingRedlines, redlineDraft, measureTools.draft, measureTools.draftLabel, tool, armed?.color, rulerMeasurements, feetPerImagePx, calibrating, calibrationPoints]);

  const highlightedMarkupIds = useMemo(() => {
    const ids = new Set<string>();
    if (reviewItem) ids.add(reviewItem.markup_id);
    if (inspected) ids.add(inspected.markup.id);
    if (modelSelected && sheetLevel && modelSelected.levelId === sheetLevel.id) for (const id of modelTakeoff.byLevel[sheetLevel.id]?.[modelSelected.id]?.markupIds ?? []) ids.add(id);
    return ids;
  }, [reviewItem, inspected, modelSelected, sheetLevel, modelTakeoff.byLevel]);

  const visibleMarkups = useMemo(() => markups.filter((markup) => (markup.condition_id ? showTakeoff : showRedlines)), [markups, showTakeoff, showRedlines]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  if (compare) {
    return (
      <ComparisonViewer
        sheet={sheet}
        versions={versions}
        leftVersionId={compare[0]}
        rightVersionId={compare[1]}
        onClose={() => setCompare(null)}
        onChangeVersions={(left, right) => setCompare([left, right])}
      />
    );
  }

  const measuringTool = isMeasuringTool(tool);
  const armedRow = armed ? rollups?.find((row) => row.condition.id === armed.id) : null;
  const sheetQuantity = armedRow?.sheets.find((entry) => entry.drawing_sheet_id === sheet.id)?.quantity;
  const dockDisabled: Partial<Record<WorkspaceTool, string>> = {};
  if (!canMeasure) {
    const reason = !takeoffAvailable ? "Takeoff isn't available here" : "You can view the takeoff but not measure";
    dockDisabled.length = reason;
    dockDisabled.area = reason;
    dockDisabled.count = reason;
  }
  if (readOnly || !onSaveMarkup) dockDisabled.redline = "Redlines can't be saved here";
  if (readOnly) dockDisabled.issue = "Read-only";

  const taskBar = renderTaskBar();

  const sheetPane = (
    <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-muted">
      <div
        ref={containerRef}
        className={cn("absolute inset-0 overflow-hidden", (measuringTool || tool === "ruler" || tool === "issue" || calibrating) && !spaceHeld && "cursor-crosshair", (tool === "pan" || spaceHeld) && "cursor-grab")}
        onMouseDown={onOverlayMouseDown}
        onMouseMove={onOverlayMouseMove}
        onMouseUp={onOverlayMouseUp}
        onMouseLeave={() => {
          onOverlayMouseUp();
          autoAreas.hover(null);
        }}
      >
        {hasTiles && tileBaseUrl && tileManifest && imageSize ? (
          <>
            <TiledDrawingViewer
              tileBaseUrl={tileBaseUrl}
              tileManifest={tileManifest}
              thumbnailUrl={imageThumbnailUrl || undefined}
              className="absolute inset-0"
              onReady={handleViewerReady}
              onTransformChange={handleViewerTransformChange}
              onTileLoadFailure={() => {
                void reportBrokenSheetTilesAction(sheet.id);
              }}
            />
            <SVGOverlay
              ref={setOverlayHandle}
              container={viewerContainer}
              imageSize={imageSize}
              markups={visibleMarkups}
              draftMarkups={drafts}
              pins={visiblePins}
              showMarkups
              showPins={showPins}
              highlightedPinId={highlightedPinId}
              interactive={drawingRedline && !readOnly}
              onPinClick={activatePin}
              feetPerImagePx={feetPerImagePx}
              textMatches={findOpen ? textMatches.map((match) => match.run) : undefined}
              activeTextMatchIndex={activeTextMatchIndex}
              calloutLinks={calloutLinksOn ? calloutLinks : undefined}
              onCalloutLinkClick={openSheetById}
              showTakeoff={showTakeoff}
              selectedConditionId={hoveredConditionId ?? (measuringTool ? (armed?.id ?? null) : null)}
              highlightedMarkupIds={highlightedMarkupIds}
              onMarkupClick={
                tool === "select" && !spaceHeld
                  ? (markup) => {
                      const xs = markup.data.points.map(([x]) => x);
                      const ys = markup.data.points.map(([, y]) => y);
                      const at = toScreen({ x: Math.max(...xs), y: Math.min(...ys) });
                      setInspected({ markup, at: at ?? { x: 24, y: 64 } });
                    }
                  : undefined
              }
              areaOverlay={
                <>
                  {autoAreas.open && (
                    <AreaTakeoffOverlay
                      controller={autoAreas}
                      imageSize={imageSize}
                      snap={(point) => {
                        const hit = snapMeasurePoint({ x: point[0], y: point[1] });
                        return hit ? [hit.x, hit.y] : point;
                      }}
                    />
                  )}
                  {modelOutline?.points && (
                    <ModelOutline kind={modelOutline.kind} points={modelOutline.points} imageSize={imageSize} />
                  )}
                  {scanCaption && <SheetScan imageSize={imageSize} caption={scanCaption} />}
                </>
              }
              snapIndicator={snapHit && (measureTools.activeTool || calibrating || (autoAreas.open && !["select", "region"].includes(autoAreas.tool))) ? { x: snapHit.x, y: snapHit.y, color: armed?.color ?? MEASURE_FALLBACK_COLOR } : null}
            />
          </>
        ) : (
          <div className="absolute inset-0 grid place-items-center p-8">
            <div className="absolute inset-0 overflow-hidden" aria-hidden>
              <div className="absolute inset-y-0 w-32 bg-gradient-to-r from-transparent via-background/40 to-transparent animate-[drawing-shimmer_1.4s_ease-in-out_infinite]" />
            </div>
            <div className="relative max-w-sm text-center">
              <p className="text-sm font-medium">This sheet is still processing</p>
              <p className="mt-1 text-xs text-muted-foreground">{sheet.sheet_number} opens as soon as its tiles finish building. Check back in a moment.</p>
            </div>
          </div>
        )}
      </div>

      {/* Chrome over the sheet. Pointer capture ignores anything inside data-workspace-chrome. */}
      <div data-workspace-chrome className={cn("pointer-events-none absolute inset-x-0 top-3 z-20 flex flex-col items-center gap-2 transition-opacity duration-150", uiHidden && "opacity-0")}>
        {taskBar}
        {localScaleWarning && (
          <TaskBar tone="warning" label="Scale warning">
            <AlertTriangle className="size-3.5 shrink-0 text-warning" />
            <TaskNote>{localScaleWarning}</TaskNote>
            <Button size="icon-xs" variant="ghost" onClick={() => setLocalScaleWarning(null)} aria-label="Dismiss scale warning">
              <X className="size-3.5" />
            </Button>
          </TaskBar>
        )}
      </div>

      {findOpen && (
        <div data-workspace-chrome className="absolute right-3 top-3 z-30 w-[340px] max-w-[calc(100%-1.5rem)] border bg-popover p-3 shadow-lg" role="complementary" aria-label="Search drawing">
          <SheetTextSearch
            runs={sheetTextRuns.runs}
            loading={sheetTextRuns.status === "loading"}
            unavailable={sheetTextRuns.status === "unavailable"}
            onClose={() => {
              setFindOpen(false);
              setTextMatches([]);
            }}
            onMatchesChange={(matches, index) => {
              setTextMatches(matches);
              setActiveTextMatchIndex(index);
            }}
            onReveal={(rect) => reveal([[rect.x, rect.y], [rect.x + rect.w, rect.y + rect.h]], 1)}
          />
        </div>
      )}

      {inspected && (
        <MarkupCard
          markup={inspected.markup}
          at={inspected.at}
          rollups={rollups}
          canWrite={canMeasure}
          canDelete={!!onDeleteMarkup && !readOnly}
          onClose={() => setInspected(null)}
          onMove={() => {
            const markup = inspected.markup;
            setPicker({ tool: markup.uom === "lf" ? "length" : markup.uom === "ea" ? "count" : "area", purpose: "move", markup });
          }}
          onDelete={async () => {
            await onDeleteMarkup?.(inspected.markup.id);
            setInspected(null);
            bump();
          }}
        />
      )}

      {issueAt && (
        <div data-workspace-chrome className="absolute z-30 w-60 border bg-popover p-1 shadow-lg" style={{ left: Math.min(issueAt.at.x + 12, (viewerContainer?.width ?? 400) - 250), top: Math.max(8, issueAt.at.y - 8) }}>
          <div className="microlabel px-2 pb-1 pt-1.5">Pin to this spot</div>
          {onCreatePin && (
            <button
              type="button"
              className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-muted"
              onClick={() => {
                onCreatePin(issueAt.point.x, issueAt.point.y);
                setIssueAt(null);
              }}
            >
              <MapPin className="size-3.5 text-muted-foreground" />
              RFI, punch item or task…
            </button>
          )}
          <button
            type="button"
            className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-muted"
            onClick={() => {
              setPendingPhotoPosition(issueAt.point);
              setIssueAt(null);
              photoInputRef.current?.click();
            }}
          >
            <Camera className="size-3.5 text-muted-foreground" />
            Pin a photo
          </button>
        </div>
      )}

      {textAt && (
        <form
          data-workspace-chrome
          className="absolute z-30 flex w-64 gap-1.5 border bg-popover p-2 shadow-lg"
          style={{ left: Math.min(textAt.at.x + 8, (viewerContainer?.width ?? 400) - 270), top: Math.max(8, textAt.at.y - 20) }}
          onSubmit={(event) => {
            event.preventDefault();
            const text = textInput.trim();
            if (text) void saveRedline({ type: "text", points: [textAt.point], text });
            setTextAt(null);
          }}
        >
          <Input autoFocus value={textInput} onChange={(event) => setTextInput(event.target.value)} placeholder="What needs attention?" aria-label="Redline note" className="h-8 text-sm" />
          <Button type="submit" size="sm" className="h-8">
            Add
          </Button>
        </form>
      )}

      {calibrating && calibrationPoints.length === 2 && (
        <CalibrationPrompt
          at={toScreen({ x: (calibrationPoints[0].x + calibrationPoints[1].x) / 2, y: (calibrationPoints[0].y + calibrationPoints[1].y) / 2 })}
          bounds={viewerContainer}
          value={calibrationInput}
          onChange={setCalibrationInput}
          saving={savingCalibration}
          onSave={() => void saveCalibration()}
          onCancel={exitCalibration}
        />
      )}

      <div data-workspace-chrome className={cn("pointer-events-none absolute inset-x-0 bottom-3 z-20 flex flex-col items-center gap-1.5 transition-opacity duration-150", uiHidden && "opacity-0")}>
        {toolHint() && (
          <p className="pointer-events-none max-w-[calc(100%-1.5rem)] truncate bg-foreground/85 px-2 py-0.5 text-[11px] text-background" aria-live="polite">
            {toolHint()}
          </p>
        )}
        <ToolDock
          tool={tool}
          onTool={chooseTool}
          armed={armed}
          canMeasure={!viewOnly}
          onChangeArmed={line ? undefined : () => setPicker({ tool: measuringTool ? (tool as MeasuringTool) : null, purpose: "arm" })}
          onDisarm={line ? undefined : disarm}
          disabled={dockDisabled}
          armedTotal={
            armedRow && measuringTool
              ? `${formatQuantity(sheetQuantity ?? 0)} here · ${formatQuantity(armedRow.effective_quantity)} total`
              : null
          }
        />
      </div>

      <div data-workspace-chrome className={cn("absolute bottom-3 right-3 z-20 flex flex-col border bg-popover shadow-lg transition-opacity duration-150 max-md:hidden", uiHidden && "opacity-0")} role="group" aria-label="Zoom">
        <Button size="icon-sm" variant="ghost" className="size-8" aria-label="Zoom in" onClick={() => gpuViewer?.zoomBy(1.2)}>
          <Plus className="size-3.5" />
        </Button>
        <button type="button" className="h-6 border-y font-mono text-[10px] tabular-nums text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Zoom to actual size" title="Actual size" onClick={() => gpuViewer?.zoomToActualSize()}>
          {Math.round(viewerZoom * 100)}%
        </button>
        <Button size="icon-sm" variant="ghost" className="size-8" aria-label="Zoom out" onClick={() => gpuViewer?.zoomBy(1 / 1.2)}>
          <Minus className="size-3.5" />
        </Button>
        <Button size="icon-sm" variant="ghost" className="size-8 border-t" aria-label="Fit sheet" title="Fit (0)" onClick={() => gpuViewer?.goHome()}>
          <Maximize className="size-3.5" />
        </Button>
      </div>
    </div>
  );

  const modelPane = modelAvailable && (
    <div className={cn("relative min-h-0 min-w-0 flex-1 border-l max-md:border-l-0 max-md:border-t", effectiveView === "sheet" && "hidden")}>
      {modelShown && (
        <ModelPane
          state={modelState}
          target={modelTarget}
          unavailable={modelUnavailable}
          canWrite={canWriteModel}
          viewerRef={viewerRef}
          focus={modelFocus}
          onFocus={setModelFocus}
          cutaway={cutaway}
          onCutaway={setCutaway}
          look={look}
          onLook={setLook}
          mode={modelMode}
          onMode={setModelMode}
          highlight={modelHighlight}
          takeoffColors={modelTakeoff.colors}
          takeoff={modelTakeoff.byLevel}
          rollups={rollups}
          selected={modelSelected}
          onSelect={(pick) => {
            setModelSelected(pick);
            if (pick && takeoffAvailable && rightTab === "sheet") setRightTab("design");
          }}
          onHover={setModelHover}
          placing={placing}
          onPlace={placeObject}
          onCancelPlacing={() => setPlacing(null)}
          onObjectMove={moveObject}
          onRoomFinish={(levelId, roomId, finish: SurfaceFinish) => void modelState.applyEdit({ type: "room.update", levelId, roomId, changes: { finish } })}
          onAssignRoom={(levelId, roomId, conditionId) => void assignRoom(levelId, roomId, conditionId)}
          onAddWall={addWallToTakeoff}
          onShowOnSheet={showPickOnSheet}
          onObjectEdit={objectEdit}
          extras={modelExtras}
          onPinSelect={(pinId) => {
            const pin = allPins.find((candidate) => candidate.id === pinId);
            if (pin) activatePin(pin);
          }}
          onSite={(site) => void modelState.applyEdit({ type: "site.set", site })}
          onSaveView={(levelId, view) =>
            void modelState.applyEdit({ type: "view.save", levelId, view }).then((saved) => saved && toast.success(view.path ? "Walkthrough saved" : "View saved"))
          }
          initialViewId={initialModelViewId}
          scanBays={scanBays}
        />
      )}
    </div>
  );

  const lineRollup = line ? rollups?.find((row) => row.condition.id === line.conditionId) : undefined;
  const lineReady = !!lineRollup && lineRollup.markup_count > 0 && lineRollup.pending_review_count === 0 && lineRollup.unscaled_markup_count === 0;
  const finishLine = async () => {
    if (!line) return;
    setFinishing(true);
    try {
      await line.onDone(lineRate);
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : "Couldn't put the quantity on the line");
    } finally {
      setFinishing(false);
    }
  };

  const panelBody = line ? (
    <>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-4">
        <span className="microlabel text-muted-foreground">The line</span>
        <button type="button" className="ml-auto px-2 text-xs text-muted-foreground md:hidden" onClick={() => setMobilePanelOpen((open) => !open)}>
          {mobilePanelOpen ? "Hide" : "Show"}
        </button>
      </div>
      <LineLedger
        line={line}
        rollup={lineRollup}
        rateCents={lineRate}
        onRate={setLineRate}
        markupsHere={markups.filter((markup) => markup.condition_id === line.conditionId)}
        sheetNumber={sheet.sheet_number}
        canWrite={canMeasure}
        onChanged={bump}
        onOpenSheet={openSheetById}
        onDeleteMarkup={(markupId) => void onDeleteMarkup?.(markupId).then(bump)}
      />
    </>
  ) : (
    <>
      <div className="flex h-11 shrink-0 items-stretch border-b px-2" role="tablist" aria-label="Panel">
        {takeoffAvailable && <PanelTab active={rightTab === "takeoff"} onClick={() => setRightTab("takeoff")} label="Takeoff" count={rollups?.length} />}
        {modelShown && model && <PanelTab active={rightTab === "design"} onClick={() => setRightTab("design")} label="Design" />}
        <PanelTab active={rightTab === "sheet"} onClick={() => setRightTab("sheet")} label="On this sheet" count={allPins.length + markups.filter((markup) => !markup.condition_id).length} />
        <button type="button" className="ml-auto px-2 text-xs text-muted-foreground md:hidden" onClick={() => setMobilePanelOpen((open) => !open)}>
          {mobilePanelOpen ? "Hide" : "Show"}
        </button>
      </div>
      {rightTab === "takeoff" && takeoffAvailable && scope ? (
        <TakeoffLedger
          rollups={rollups}
          error={rollupError}
          onRetry={() => void reloadRollups()}
          scope={scope}
          canWrite={canMeasure}
          activeSheetId={sheet.id}
          armedId={armed?.id ?? null}
          onArm={arm}
          onHover={setHoveredConditionId}
          onChanged={bump}
          onNewItem={() => setPicker({ tool: null, purpose: "arm" })}
          onOpenSheet={openSheetById}
          onSendToEstimate={viewOnly ? undefined : () => setHandoffOpen(true)}
          notices={
            <>
              {measurementContext && <MeasurementContextBar context={measurementContext} />}
              {(takeoffProjectId ?? null) && (
                <TakeoffRevisionBand
                  projectId={takeoffProjectId as string}
                  refreshToken={refreshToken}
                  canWrite={canConfirm}
                  onResolved={bump}
                  onReview={(items) => setReview({ items, index: 0 })}
                />
              )}
            </>
          }
        />
      ) : rightTab === "design" ? (
        <DesignPanel
          model={model}
          focus={modelFocus}
          takeoff={modelTakeoff.byLevel}
          rollups={rollups}
          selected={modelSelected}
          canWrite={canWriteModel}
          placing={placing}
          extras={modelExtras}
          onSelectRoom={(levelId, roomId) => {
            setModelSelected({ kind: "room", id: roomId, levelId });
            viewerRef.current?.frame(levelId, roomId);
          }}
          onSelectObject={(levelId, objectId) => {
            setModelSelected({ kind: "object", id: objectId, levelId });
            viewerRef.current?.frame(levelId, objectId);
          }}
          onStartPlacing={setPlacing}
          onApplyEdits={(edits, label) => void applyModelEdits(edits, label)}
        />
      ) : (
        <OnSheetPanel
          pins={allPins}
          markups={markups}
          links={calloutLinks}
          linksLoaded={calloutLinksLoaded}
          onFocusPin={(pin) => reveal([[pin.x_position, pin.y_position]], 0.6)}
          onOpenPin={activatePin}
          onFocusMarkup={(markup) => reveal(markup.data.points)}
          onOpenLink={openSheetById}
          onLoadLinks={loadCalloutLinks}
        />
      )}
    </>
  );

  return (
    <div className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-background text-foreground" data-drawing-workspace>
      <WorkspaceHeader
        task={
          line
            ? {
                label: `Measuring for ${line.section || "the price"}`,
                title: line.name,
                color: armed?.color ?? null,
                action: (
                  <Button size="sm" className="h-8 gap-1.5" disabled={!lineReady || finishing || busy} onClick={() => void finishLine()}>
                    {finishing ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                    Done
                  </Button>
                ),
              }
            : undefined
        }
        sheet={sheet}
        hasPrev={currentIndex > 0}
        hasNext={currentIndex >= 0 && currentIndex < sheets.length - 1}
        onPrev={goPrev}
        onNext={goNext}
        onClose={onClose}
        closeDisabled={busy}
        onToggleRail={() => setRailOpen((open) => !open)}
        railOpen={railOpen}
        onTogglePanel={() => setPanelOpen(!panelOpen)}
        panelOpen={panelOpen}
        view={effectiveView}
        onView={setView}
        modelAvailable={modelAvailable}
        scale={
          <ScaleChip
            calibration={calibration}
            scanning={scanningScale}
            applying={applyingProposal}
            canWrite={canMeasure}
            onApplyProposal={() => void applyProposal()}
            onCalibrate={startCalibration}
            open={scaleOpen}
            onOpenChange={setScaleOpen}
          />
        }
        versions={versions}
        versionsLoading={versionsLoading}
        versionsOpen={versionsOpen}
        onVersionsOpenChange={setVersionsOpen}
        onCompare={(older, newer) => setCompare([older, newer])}
        onFind={() => setFindOpen((open) => !open)}
        findActive={findOpen}
        layers={[
          ...(takeoffAvailable ? [{ key: "takeoff", label: "Takeoff", checked: showTakeoff, onChange: setShowTakeoff }] : []),
          { key: "redlines", label: "Redlines", checked: showRedlines, onChange: setShowRedlines },
          { key: "pins", label: "Issues & photos", checked: showPins, onChange: setShowPins },
          ...pinTypes.map((type) => ({
            key: `pin-${type}`,
            label: `· ${type.replace(/_/g, " ")}`,
            checked: !hiddenPinTypes.has(type),
            onChange: (checked: boolean) =>
              setHiddenPinTypes((previous) => {
                const next = new Set(previous);
                if (checked) next.delete(type);
                else next.add(type);
                return next;
              }),
          })),
          { key: "links", label: "Links to other sheets", checked: calloutLinksOn, onChange: setCalloutLinksOn },
        ]}
        menu={[
          ...(fileUrl ? [{ label: "Download original", href: fileUrl }] : []),
          { label: "Download with markups", onSelect: () => window.open(`/api/drawings/export?sheetId=${sheet.id}`, "_blank") },
          ...(canMeasure && calibration ? [{ label: "Set drawing scale", onSelect: startCalibration }] : []),
        ]}
        onShortcuts={() => setShortcutsOpen(true)}
      />

      <div className="relative flex min-h-0 flex-1 max-md:flex-col">
        {railOpen && (
          <SheetRail
            sheets={sheets.length ? sheets : [sheet]}
            activeSheetId={sheet.id}
            onNavigate={(target) => {
              if (busy) return;
              onNavigateSheet?.(target);
              if (isMobile) setRailOpen(false);
            }}
            measurements={takeoffAvailable ? measuredSheets : undefined}
            modelSources={modelSources}
            setLabel={sheet.set_title ?? null}
            onClose={isMobile ? () => setRailOpen(false) : undefined}
            className="w-64 shrink-0 max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:w-[min(300px,86vw)] max-md:shadow-xl"
          />
        )}
        <main className={cn("flex min-h-0 min-w-0 flex-1", effectiveView === "split" && "max-md:flex-col")}>
          <div className={cn("flex min-h-0 min-w-0 flex-1", effectiveView === "3d" && "hidden")}>{sheetPane}</div>
          {modelPane}
        </main>
        {panelOpen && (
          <aside
            aria-label="Takeoff and sheet details"
            className={cn(
              "flex w-[340px] shrink-0 flex-col border-l bg-card",
              "max-md:w-full max-md:border-l-0 max-md:border-t",
              isMobile && (mobilePanelOpen ? "h-[62vh]" : "h-11 overflow-hidden"),
            )}
          >
            {panelBody}
          </aside>
        )}
      </div>

      <ItemPicker
        open={!!picker}
        onOpenChange={(open) => !open && setPicker(null)}
        tool={picker?.tool ?? null}
        rollups={rollups ?? []}
        scope={scope}
        canWrite={canMeasure && picker?.purpose !== "move"}
        excludeConditionId={picker?.purpose === "move" ? (picker.markup?.condition_id ?? null) : null}
        title={picker?.purpose === "move" ? "Move this measurement to…" : picker?.purpose === "wall" ? "Count this wall in…" : undefined}
        onPick={(condition) => {
          const current = picker;
          setPicker(null);
          if (!current) return;
          if (current.purpose === "move" && current.markup) {
            void assignMarkupsToConditionAction({ condition_id: condition.id, markup_ids: [current.markup.id] })
              .then((result) => {
                unwrapAction(result);
                toast.success(`Moved into ${condition.name}`);
                setInspected(null);
                bump();
                onMarkupsChanged?.();
              })
              .catch((failure: unknown) => toast.error(failure instanceof Error ? failure.message : "Couldn't move that measurement"));
            return;
          }
          if (current.purpose === "wall" && current.wall) {
            const level = model?.levels.find((candidate) => candidate.id === current.wall?.levelId);
            const outline = level ? wallOutlineOnSheet(level, current.wall.wallId) : null;
            if (outline)
              void saveOnSourceSheet(current.wall.levelId, { type: "polyline", points: outline, condition }).then((saved) => saved && toast.success(`Added to ${condition.name}`));
            return;
          }
          arm(condition);
        }}
      />

      {scope && !line && !viewOnly && (
        <EstimateHandoff
          open={handoffOpen}
          onOpenChange={setHandoffOpen}
          rollups={rollups ?? []}
          projectId={takeoffPlanVersionId ? null : (takeoffProjectId ?? null)}
          housePlanVersionId={takeoffPlanVersionId ?? null}
          measurementContext={measurementContext}
          estimateId={estimateId}
          onSent={bump}
          onReviewRevision={() => {
            setHandoffOpen(false);
            setRightTab("takeoff");
          }}
        />
      )}

      <input
        ref={photoInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0] ?? null;
          event.target.value = "";
          if (!file) {
            setPendingPhotoPosition(null);
            return;
          }
          setPhotoFile(file);
          setPhotoCaption("");
        }}
      />
      <Dialog open={!!photoFile} onOpenChange={(open) => !open && !photoUploading && resetPhoto()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Pin a photo to the drawing</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {photoPreviewUrl && (
              <div className="flex max-h-64 items-center justify-center overflow-hidden border bg-muted/30">
                <img src={photoPreviewUrl} alt={photoFile?.name ?? "Photo preview"} className="max-h-64 w-auto object-contain" />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="photo-caption">Caption</Label>
              <Input id="photo-caption" value={photoCaption} onChange={(event) => setPhotoCaption(event.target.value)} placeholder="What does this show?" disabled={photoUploading} />
            </div>
            {photoUploading && (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Uploading{photoUploadPercent !== null ? ` ${photoUploadPercent}%` : "…"}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={resetPhoto} disabled={photoUploading}>
              Cancel
            </Button>
            <Button onClick={() => void submitPhoto()} disabled={photoUploading || !photoFile}>
              {photoUploading ? "Uploading…" : "Pin photo"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!photoView} onOpenChange={(open) => !open && setPhotoView(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{photoView?.pin.label ?? photoView?.fileName ?? "Photo"}</DialogTitle>
          </DialogHeader>
          {photoView?.loading ? (
            <div className="h-64 skeleton-shimmer bg-muted" role="status" aria-label="Loading photo" />
          ) : photoView?.error ? (
            <p className="py-8 text-center text-sm text-destructive">{photoView.error}</p>
          ) : photoView?.url ? (
            <div className="space-y-3">
              <div className="flex max-h-[60vh] items-center justify-center overflow-hidden border bg-muted/30">
                <img src={photoView.url} alt={photoView.pin.label ?? photoView.fileName ?? "Photo"} className="max-h-[60vh] w-auto object-contain" />
              </div>
              <p className="text-xs text-muted-foreground">
                {[photoView.pin.creator_name, new Date(photoView.takenAt ?? photoView.pin.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })].filter(Boolean).join(" · ")}
              </p>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
      <KeyboardShortcutsHelp open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  );

  // -------------------------------------------------------------------------
  // The task bar: what is happening right now, in one strip
  // -------------------------------------------------------------------------
  function renderTaskBar() {
    if (calibrating) {
      return (
        <TaskBar>
          <TaskTitle>Set the scale</TaskTitle>
          <TaskNote>{calibrationPoints.length === 0 ? "Click one end of a dimension you know — an overall is best." : calibrationPoints.length === 1 ? "Now click the other end." : "Type its length."}</TaskNote>
          <Button size="sm" variant="ghost" className="h-7" onClick={exitCalibration}>
            Cancel
          </Button>
        </TaskBar>
      );
    }
    if (reviewItem && review) {
      return (
        <TaskBar tone="warning" label="Revision review">
          <span className="font-mono text-xs text-muted-foreground">
            {review.index + 1}/{review.items.length}
          </span>
          {reviewItem.condition_color && <TaskSwatch color={reviewItem.condition_color} />}
          <TaskTitle>{reviewItem.condition_name ?? "Measurement"}</TaskTitle>
          <TaskNote>Carried onto the new revision. Does it still match the drawing?</TaskNote>
          <Button size="sm" className="h-7 gap-1" disabled={reviewBusy} onClick={() => void resolveReview("confirm")}>
            <Check className="size-3.5" />
            Looks right
          </Button>
          {onDeleteMarkup && (
            <Button size="sm" variant="outline" className="h-7" disabled={reviewBusy} onClick={() => void resolveReview("delete")}>
              Delete
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-7" disabled={reviewBusy} onClick={advanceReview}>
            Skip
          </Button>
        </TaskBar>
      );
    }
    if (measuringTool && armed && !scaleReady && tool !== "count") {
      return (
        <TaskBar tone="warning">
          <TaskSwatch color={armed.color} />
          <TaskTitle>{armed.name}</TaskTitle>
          <TaskNote>{scanningScale ? "Reading the scale off this sheet…" : calibration?.proposal ? `This sheet reads ${calibration.proposal.raw ?? "a scale"}. Confirm it to measure.` : "This sheet needs a scale before it can be measured."}</TaskNote>
          {calibration?.proposal && (
            <Button size="sm" className="h-7" disabled={applyingProposal} onClick={() => void applyProposal()}>
              Confirm scale
            </Button>
          )}
          {calibration && (
            <Button size="sm" variant={calibration.proposal ? "outline" : "default"} className="h-7" onClick={startCalibration}>
              Set from a dimension
            </Button>
          )}
        </TaskBar>
      );
    }
    if (tool === "count" && armed) {
      const proposal = countProposal;
      return (
        <TaskBar tone={proposal?.status === "matching" ? "busy" : "default"}>
          <TaskSwatch color={armed.color} />
          <TaskTitle>{armed.name}</TaskTitle>
          {!proposal ? (
            <TaskNote>Click one symbol. Arc finds the rest.</TaskNote>
          ) : proposal.status === "matching" ? (
            <TaskNote>{proposal.source === "vision" ? "No linework here — reading the sheet image…" : "Matching that symbol across the sheet…"}</TaskNote>
          ) : (
            <>
              <span className="font-mono text-sm font-semibold tabular-nums">{proposal.points.length}</span>
              <TaskNote>
                {proposal.source === "manual" ? "No matches found — click each one to count it." : "found. Click a dot to drop it, anywhere else to add one."}
                {proposal.truncated && " More than the search returns."}
                {proposal.discarded ? ` ${proposal.discarded} discarded with nothing drawn there.` : ""}
                {proposal.unverified && " Not checked against linework."}
              </TaskNote>
              <Button size="sm" className="h-7 gap-1" disabled={proposal.status === "saving" || proposal.points.length === 0} onClick={() => void acceptProposal()}>
                {proposal.status === "saving" && <Loader2 className="size-3 animate-spin" />}
                Add {proposal.points.length}
              </Button>
              <Button size="sm" variant="ghost" className="h-7" disabled={proposal.status === "saving"} onClick={dismissProposal}>
                Discard
              </Button>
            </>
          )}
        </TaskBar>
      );
    }
    if (tool === "area" && armed) {
      const fillable = isAreaCondition(armed);
      const detecting = autoAreas.busy === "detecting";
      return (
        <TaskBar tone={detecting || autoAreas.busy === "saving" ? "busy" : "default"}>
          <TaskSwatch color={armed.color} />
          <TaskTitle>{armed.name}</TaskTitle>
          {fillable && (
            <Segmented
              label="Area method"
              value={areaMode}
              onChange={(mode) => {
                setAreaMode(mode);
                startMeasuring(armed, "area", mode);
              }}
              options={[
                { value: "fill", label: "Fill rooms" },
                { value: "draw", label: "Draw outline" },
              ]}
            />
          )}
          {areaMode === "fill" && fillable ? (
            <>
              <TaskNote>
                {detecting
                  ? "Finding rooms on this sheet…"
                  : autoAreas.error
                    ? autoAreas.error
                    : autoAreas.proposals.length === 0
                      ? "No rooms found. Draw the outline instead."
                      : autoAreas.tool !== "select"
                        ? "Click to mark it on the sheet."
                        : `${autoAreas.proposals.length} rooms found. Click one to add it; click again to take it out.`}
              </TaskNote>
              {!detecting && autoAreas.proposals.length > 0 && autoAreas.tool === "select" && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  disabled={!!autoAreas.busy}
                  onClick={() =>
                    void autoAreas.fillAll(armed).then((count) => count > 0 && toast.success(`${count} ${count === 1 ? "room" : "rooms"} added to ${armed.name}`))
                  }
                >
                  Fill every room
                </Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="ghost" className="h-7" disabled={detecting}>
                    Adjust
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  <DropdownMenuLabel className="microlabel">When detection gets it wrong</DropdownMenuLabel>
                  <DropdownMenuItem onSelect={() => autoAreas.changeTool("region")}>Limit to one plan on the sheet…</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => autoAreas.changeTool("boundary")}>Add a missing wall line…</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuCheckboxItem
                    checked={autoAreas.finishPolicy === "include-fixtures"}
                    onCheckedChange={(checked) => autoAreas.changeFinishPolicy(checked ? "include-fixtures" : "drawn")}
                  >
                    Include area under cabinets and fixtures
                  </DropdownMenuCheckboxItem>
                  {autoAreas.region && <DropdownMenuItem onSelect={autoAreas.wholeSheet}>Use the whole sheet again</DropdownMenuItem>}
                  {autoAreas.canUndo && <DropdownMenuItem onSelect={autoAreas.undo}>Undo the last change</DropdownMenuItem>}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : (
            <>
              <Segmented
                label="Add or deduct"
                value={deductMode ? "deduct" : "add"}
                onChange={(value) => setDeductMode(value === "deduct")}
                options={[
                  { value: "add", label: "Add" },
                  { value: "deduct", label: "Deduct" },
                ]}
              />
              <TaskNote>
                {measureTools.draft
                  ? `${measureTools.draftLabel ?? "—"} · ${measureTools.remainingPoints > 0 ? `${measureTools.remainingPoints} more ${measureTools.remainingPoints === 1 ? "corner" : "corners"}` : "click the first corner to close"}`
                  : "Click the corners."}
              </TaskNote>
            </>
          )}
          <Button size="sm" variant="ghost" className="h-7" onClick={disarm}>
            Done
          </Button>
        </TaskBar>
      );
    }
    if (tool === "length" && armed) {
      return (
        <TaskBar tone={measureTools.saving ? "busy" : "default"}>
          <TaskSwatch color={armed.color} />
          <TaskTitle>{armed.name}</TaskTitle>
          <TaskNote>
            {measureTools.draft
              ? `${measureTools.draftLabel ?? "—"}${armed.height_ft ? ` × ${armed.height_ft}' high` : ""} · Enter or double-click to finish`
              : armed.height_ft
                ? `Click along the wall. Each foot counts as ${armed.height_ft} SF.`
                : "Click points along the run."}
          </TaskNote>
          <Button size="sm" variant="ghost" className="h-7" onClick={disarm}>
            Done
          </Button>
        </TaskBar>
      );
    }
    if (tool === "ruler") {
      return (
        <TaskBar>
          <TaskTitle>Ruler</TaskTitle>
          <TaskNote>{measureTools.draft ? measureTools.draftLabel : "A quick check — nothing is saved."}</TaskNote>
          {rulerMeasurements.length > 0 && (
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setRulerMeasurements([])}>
              Clear
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-7" onClick={() => chooseTool("select")}>
            Done
          </Button>
        </TaskBar>
      );
    }
    if (tool === "redline") {
      return (
        <TaskBar>
          <TaskTitle>Redline</TaskTitle>
          <Segmented
            label="Redline kind"
            value={redlineKind}
            onChange={setRedlineKind}
            options={[
              { value: "cloud", label: "Cloud" },
              { value: "arrow", label: "Arrow" },
              { value: "text", label: "Text" },
              { value: "freehand", label: "Pen" },
            ]}
          />
          <TaskNote>{redlineKind === "text" ? "Click where the note goes." : "Drag on the sheet. Saved as you draw."}</TaskNote>
          <Button size="sm" variant="ghost" className="h-7" onClick={() => chooseTool("select")}>
            Done
          </Button>
        </TaskBar>
      );
    }
    if (tool === "issue") {
      return (
        <TaskBar>
          <TaskTitle>{TOOL_LABELS.issue}</TaskTitle>
          <TaskNote>Click the spot on the sheet.</TaskNote>
          <Button size="sm" variant="ghost" className="h-7" onClick={() => chooseTool("select")}>
            Done
          </Button>
        </TaskBar>
      );
    }
    return null;
  }

  /** One line over the dock, only while a tool has something to teach. Looking needs no instructions. */
  function toolHint(): string | null {
    if (spaceHeld) return "Panning — release Space to go back";
    if (calibrating) return "Points snap to linework and dimension ticks · Alt places freely";
    if (tool === "area" && areaMode === "draw") return "Click corners · Enter or the first point closes · Backspace removes a point";
    if (tool === "area") return "Click inside a room to add it · click it again to take it out";
    if (tool === "count") return "Click a symbol — every one like it on the sheet is counted";
    if (tool === "length") return "Click points · double-click or Enter finishes · Backspace removes the last";
    if (tool === "ruler") return "Click two or more points · Enter finishes · Esc clears";
    return null;
  }
}

function PanelTab({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count?: number }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "relative flex items-center gap-1.5 whitespace-nowrap px-2.5 text-[13px] font-semibold transition-colors",
        active ? "text-foreground after:absolute after:inset-x-2.5 after:-bottom-px after:h-0.5 after:bg-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
      {count !== undefined && <span className="font-mono text-[11px] font-medium text-muted-foreground">{count}</span>}
    </button>
  );
}

function ModelOutline({ kind, points, imageSize }: { kind: "room" | "wall"; points: Array<[number, number]>; imageSize: { width: number; height: number } }) {
  const px = points.map(([x, y]) => `${x * imageSize.width},${y * imageSize.height}`).join(" ");
  return kind === "room" ? (
    <polygon points={px} fill="var(--primary)" fillOpacity={0.1} stroke="var(--primary)" strokeWidth={2.5} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" style={{ pointerEvents: "none" }} />
  ) : (
    <polyline points={px} fill="none" stroke="var(--primary)" strokeWidth={6} strokeOpacity={0.6} vectorEffect="non-scaling-stroke" style={{ pointerEvents: "none" }} />
  );
}

function MarkupCard({
  markup,
  at,
  rollups,
  canWrite,
  canDelete,
  onClose,
  onMove,
  onDelete,
}: {
  markup: DrawingMarkup;
  at: Point;
  rollups: ReturnType<typeof useTakeoffRollups>["rollups"];
  canWrite: boolean;
  canDelete: boolean;
  onClose: () => void;
  onMove: () => void;
  onDelete: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const condition = markup.condition_id ? rollups?.find((row) => row.condition.id === markup.condition_id)?.condition : null;
  const measuring = markup.uom !== null;
  return (
    <div data-workspace-chrome className="absolute z-30 w-64 space-y-2.5 border bg-popover p-3 shadow-lg" style={{ left: Math.max(8, at.x + 12), top: Math.max(8, at.y) }}>
      <div className="flex items-start gap-2">
        {condition && <span className="mt-1 size-2.5 shrink-0" style={{ backgroundColor: condition.color }} aria-hidden />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{condition?.name ?? (measuring ? "Unassigned measurement" : (markup.data.text ?? "Redline"))}</p>
          <p className="text-xs text-muted-foreground">
            {[markup.creator_name, new Date(markup.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })].filter(Boolean).join(" · ")}
          </p>
        </div>
        <button type="button" onClick={onClose} className="grid size-6 place-items-center text-muted-foreground hover:bg-muted" aria-label="Close">
          <X className="size-3.5" />
        </button>
      </div>
      {measuring && (
        <p className="font-mono text-lg font-semibold tabular-nums">
          {markup.quantity !== null ? `${markup.data.style?.deduction ? "−" : ""}${formatQuantity(Math.abs(markup.quantity))}` : "—"}{" "}
          <span className="text-xs text-muted-foreground">{markup.uom ? MEASURE_UOM_LABELS[markup.uom] : ""}</span>
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {measuring && canWrite && (
          <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={onMove}>
            <Move className="size-3" />
            Move to…
          </Button>
        )}
        {canDelete &&
          (confirming ? (
            <Button size="sm" variant="destructive" className="h-7 gap-1 text-xs" onClick={() => void onDelete()}>
              <Trash2 className="size-3" />
              Delete it
            </Button>
          ) : (
            <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs text-muted-foreground hover:text-destructive" onClick={() => setConfirming(true)}>
              <Trash2 className="size-3" />
              Delete
            </Button>
          ))}
      </div>
    </div>
  );
}

function CalibrationPrompt({
  at,
  bounds,
  value,
  onChange,
  saving,
  onSave,
  onCancel,
}: {
  at: Point | null;
  bounds: { width: number; height: number } | null;
  value: string;
  onChange: (value: string) => void;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const left = Math.max(8, Math.min((at?.x ?? 200) - 130, (bounds?.width ?? 600) - 270));
  const top = Math.max(60, Math.min((at?.y ?? 200) + 16, (bounds?.height ?? 600) - 140));
  return (
    <form
      data-workspace-chrome
      className="absolute z-30 w-64 space-y-2 border bg-popover p-3 shadow-lg"
      style={{ left, top }}
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <Label htmlFor="calibration-distance" className="text-sm font-semibold">
        How long is this line?
      </Label>
      <Input id="calibration-distance" autoFocus value={value} onChange={(event) => onChange(event.target.value)} placeholder={"e.g. 24' 6\" or 10.5"} className="h-8 font-mono" />
      <p className="text-[11px] text-muted-foreground">Feet and inches, or decimal feet. Every measurement on this sheet uses it.</p>
      <div className="flex gap-1.5">
        <Button type="submit" size="sm" className="h-7" disabled={saving || !value.trim()}>
          {saving && <Loader2 className="size-3 animate-spin" />}
          Set scale
        </Button>
        <Button type="button" size="sm" variant="ghost" className="h-7" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
