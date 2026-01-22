export { DrawingsClient } from "./drawings-client"
export { DrawingViewer } from "./drawing-viewer"
export { CreateFromDrawingDialog } from "./create-from-drawing-dialog"
export { PinsList } from "./pins-list"
export { LinkedDrawings } from "./linked-drawings"
export { SheetStatusDots } from "./sheet-status-dots"
export { SheetCard } from "./sheet-card"
export { PlanSetCard } from "./plan-set-card"
export { DrawingsEmptyState } from "./drawings-empty-state"
export { KeyboardShortcutsHelp } from "./keyboard-shortcuts-help"
export { UploadPreviewDialog } from "./upload-preview-dialog"
export type { DetectedSheet } from "./upload-preview-dialog"
export {
  useDrawingKeyboardShortcuts,
  LIST_SHORTCUTS,
  VIEWER_SHORTCUTS,
} from "./use-drawing-keyboard-shortcuts"
export type {
  KeyboardShortcutHandlers,
  UseDrawingKeyboardShortcutsOptions,
} from "./use-drawing-keyboard-shortcuts"

// Stage 2: Navigation components
export { DisciplineTabs } from "./discipline-tabs"
export { RecentSheetsSection, useRecentSheets } from "./recent-sheets-section"
export { SheetThumbnailStrip } from "./sheet-thumbnail-strip"

// Stage 2: Comparison mode
export { ComparisonViewer } from "./comparison-viewer"

// Stage 2: Enhanced pins with clustering
export { DrawingPinLayer } from "./drawing-pin-layer"

// Stage 2: Mobile touch support
export { useTouchGestures } from "./use-touch-gestures"
export { MobileDrawingToolbar } from "./mobile-drawing-toolbar"
export { LongPressMenu } from "./long-press-menu"

// Performance tracking
export {
  useDrawingPerformance,
  measureAsync,
  logPerformanceSummary,
} from "./use-drawing-performance"
export type {
  DrawingPerformanceTimings,
  DrawingPerformanceMetrics,
} from "./use-drawing-performance"

// Progressive image viewer (Phase 1 performance optimization)
export { ImageViewer, SimpleImageViewer } from "./image-viewer"
export type { ImageLoadStage } from "./image-viewer"

// Smart prefetching (Phase 3 performance optimization)
export { usePrefetchAdjacentSheets, prefetchSheet } from "./use-prefetch-sheets"
