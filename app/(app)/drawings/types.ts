export type {
  DrawingRevision,
  DrawingSet,
  DrawingSheet,
  DrawingSheetVersion,
} from "@/lib/services/drawings"
export type {
  DrawingMarkup,
  DrawingPin,
  SheetStatusCounts,
} from "@/lib/services/drawing-markups"
export type {
  DrawingDiscipline,
  DrawingMarkupInput,
  DrawingMarkupUpdate,
  DrawingPinInput,
  DrawingPinUpdate,
  DrawingRevisionInput,
  DrawingRevisionUpdate,
  DrawingSetInput,
  DrawingSetUpdate,
  DrawingSheetInput,
  DrawingSheetListFilters,
  DrawingSheetUpdate,
  MarkupType,
  PinEntityType,
  PinStatus,
} from "@/lib/validation/drawings"

import type { DrawingDiscipline } from "@/lib/validation/drawings"

/**
 * A page that has already been split out of an in-flight draft revision. Sheet
 * and version rows are created at split time, so these land well before tiles
 * finish — which is what makes live per-sheet upload progress possible.
 */
export interface DraftRevisionSheetPreview {
  version_id: string
  sheet_id: string
  page_index: number
  sheet_number: string
  sheet_title: string | null
  thumbnail_url: string | null
  tiles_ready: boolean
}

export interface UploadReviewSheet {
  id: string
  drawing_set_id: string
  sheet_number: string
  sheet_title?: string
  discipline?: DrawingDiscipline
  sort_order: number
  updated_at: string
}
