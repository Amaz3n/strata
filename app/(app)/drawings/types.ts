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

export interface UploadReviewSheet {
  id: string
  drawing_set_id: string
  sheet_number: string
  sheet_title?: string
  discipline?: DrawingDiscipline
  sort_order: number
  updated_at: string
}
