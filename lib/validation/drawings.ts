import { z } from "zod"

// Drawing set status
export const drawingSetStatusSchema = z.enum([
  "processing",
  "ready",
  "failed",
])

export type DrawingSetStatus = z.infer<typeof drawingSetStatusSchema>

// Drawing set category (high-level plan type)
export const drawingSetTypeSchema = z.enum([
  "architectural",
  "structural",
  "mep",
  "civil",
  "landscape",
  "interior",
  "specifications",
  "general",
  "other",
])

export type DrawingSetType = z.infer<typeof drawingSetTypeSchema>

export const DRAWING_SET_TYPE_LABELS: Record<DrawingSetType, string> = {
  architectural: "Architectural",
  structural: "Structural",
  mep: "MEP",
  civil: "Civil",
  landscape: "Landscape",
  interior: "Interior",
  specifications: "Specifications",
  general: "General",
  other: "Other",
}

// Drawing issuance/package type. These are the terms builders usually expect
// when a plan package changes hands.
export const drawingIssuanceTypeSchema = z.enum([
  "permit_set",
  "ifc_set",
  "bid_set",
  "addendum",
  "asi",
  "bulletin",
  "revision",
  "sketch",
  "record_set",
  "other",
])

export type DrawingIssuanceType = z.infer<typeof drawingIssuanceTypeSchema>

export const DRAWING_ISSUANCE_TYPE_LABELS: Record<DrawingIssuanceType, string> = {
  permit_set: "Permit Set",
  ifc_set: "Issued for Construction",
  bid_set: "Bid Set",
  addendum: "Addendum",
  asi: "ASI",
  bulletin: "Bulletin",
  revision: "Revision",
  sketch: "Sketch",
  record_set: "Record Set",
  other: "Other",
}

// Drawing discipline codes
export const drawingDisciplineSchema = z.enum([
  "A",   // Architectural
  "S",   // Structural
  "M",   // Mechanical
  "E",   // Electrical
  "P",   // Plumbing
  "C",   // Civil
  "L",   // Landscape
  "I",   // Interior
  "FP",  // Fire Protection
  "G",   // General/Cover
  "T",   // Title/Cover
  "SP",  // Specifications
  "D",   // Details
  "X",   // Other/Unknown
])

export type DrawingDiscipline = z.infer<typeof drawingDisciplineSchema>

// Human-readable discipline names
export const DISCIPLINE_LABELS: Record<DrawingDiscipline, string> = {
  A: "Architectural",
  S: "Structural",
  M: "Mechanical",
  E: "Electrical",
  P: "Plumbing",
  C: "Civil",
  L: "Landscape",
  I: "Interior",
  FP: "Fire Protection",
  G: "General",
  T: "Title/Cover",
  SP: "Specifications",
  D: "Details",
  X: "Other",
}

// ============================================================================
// DRAWING SET SCHEMAS
// ============================================================================

export const drawingSetInputSchema = z.object({
  project_id: z.string().uuid(),
  title: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  set_type: drawingSetTypeSchema.optional(),
  source_file_id: z.string().uuid().optional(),
})

export type DrawingSetInput = z.infer<typeof drawingSetInputSchema>

export const drawingSetUpdateSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional().nullable(),
  set_type: drawingSetTypeSchema.optional().nullable(),
  status: drawingSetStatusSchema.optional(),
  processed_at: z.string().datetime().optional(),
  error_message: z.string().optional().nullable(),
  total_pages: z.number().int().nonnegative().optional(),
  processed_pages: z.number().int().nonnegative().optional(),
})

export type DrawingSetUpdate = z.infer<typeof drawingSetUpdateSchema>

// ============================================================================
// DRAWING REVISION SCHEMAS
// ============================================================================

export const drawingRevisionInputSchema = z.object({
  project_id: z.string().uuid(),
  drawing_set_id: z.string().uuid().optional(),
  revision_label: z.string().min(1).max(50),
  issued_date: z.string().optional(), // ISO date string
  notes: z.string().max(1000).optional(),
  issuance_type: drawingIssuanceTypeSchema.optional(),
  issued_by: z.string().max(255).optional(),
  received_from: z.string().max(255).optional(),
})

export type DrawingRevisionInput = z.infer<typeof drawingRevisionInputSchema>

export const drawingRevisionUpdateSchema = z.object({
  revision_label: z.string().min(1).max(50).optional(),
  issued_date: z.string().optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
  issuance_type: drawingIssuanceTypeSchema.optional().nullable(),
  issued_by: z.string().max(255).optional().nullable(),
  received_from: z.string().max(255).optional().nullable(),
})

export type DrawingRevisionUpdate = z.infer<typeof drawingRevisionUpdateSchema>

// ============================================================================
// DRAWING SHEET SCHEMAS
// ============================================================================

export const drawingSheetInputSchema = z.object({
  project_id: z.string().uuid(),
  drawing_set_id: z.string().uuid(),
  sheet_number: z.string().min(1).max(50),
  sheet_title: z.string().max(255).optional(),
  discipline: drawingDisciplineSchema.optional(),
  current_revision_id: z.string().uuid().optional(),
  sort_order: z.number().int().nonnegative().optional(),
  share_with_clients: z.boolean().optional(),
  share_with_subs: z.boolean().optional(),
})

export type DrawingSheetInput = z.infer<typeof drawingSheetInputSchema>

export const drawingSheetUpdateSchema = z.object({
  sheet_number: z.string().min(1).max(50).optional(),
  sheet_title: z.string().max(255).optional().nullable(),
  discipline: drawingDisciplineSchema.optional().nullable(),
  current_revision_id: z.string().uuid().optional().nullable(),
  sort_order: z.number().int().nonnegative().optional(),
  share_with_clients: z.boolean().optional(),
  share_with_subs: z.boolean().optional(),
})

export type DrawingSheetUpdate = z.infer<typeof drawingSheetUpdateSchema>

// ============================================================================
// DRAWING SHEET VERSION SCHEMAS
// ============================================================================

export const drawingSheetVersionInputSchema = z.object({
  drawing_sheet_id: z.string().uuid(),
  drawing_revision_id: z.string().uuid(),
  file_id: z.string().uuid().optional(),
  thumbnail_file_id: z.string().uuid().optional(),
  page_index: z.number().int().nonnegative().optional(),
  extracted_metadata: z.record(z.any()).optional(),
})

export type DrawingSheetVersionInput = z.infer<typeof drawingSheetVersionInputSchema>

// ============================================================================
// SHEET CALIBRATION (dimension tool scale)
// ============================================================================

// Stored under drawing_sheet_versions.extracted_metadata.calibration.
export const setSheetVersionCalibrationInputSchema = z.object({
  sheet_version_id: z.string().uuid(),
  feet_per_image_px: z.number().positive().finite(),
})

export type SetSheetVersionCalibrationInput = z.infer<typeof setSheetVersionCalibrationInputSchema>

/**
 * Format a decimal-feet length as feet-and-inches, rounded to the nearest
 * inch (e.g. 24.5 -> `24'-6"`).
 */
export function formatFeetInches(feet: number): string {
  if (!Number.isFinite(feet) || feet < 0) return ""
  const totalInches = Math.round(feet * 12)
  const ft = Math.floor(totalInches / 12)
  const inches = totalInches % 12
  return `${ft}'-${inches}"`
}

/**
 * Parse a user-entered real-world length into decimal feet. Accepts
 * `24`, `10.5` (decimal feet), `24'`, `24' 6"`, `24'6`, `24 ft 6 in`,
 * and inches-only like `8"`. Returns null when unparseable or non-positive.
 */
export function parseFeetInches(raw: string): number | null {
  const input = raw
    .trim()
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
  if (!input) return null

  // Feet marker present, optional inches: 24' 6", 24'6, 24 ft 6 in
  const feetMatch = input.match(
    /^(\d+(?:\.\d+)?)\s*(?:'|ft\.?|feet)\s*(?:(\d+(?:\.\d+)?)\s*(?:"|in\.?|inches)?)?$/,
  )
  if (feetMatch) {
    const feet = Number.parseFloat(feetMatch[1])
    const inches = feetMatch[2] ? Number.parseFloat(feetMatch[2]) : 0
    if (!Number.isFinite(feet) || !Number.isFinite(inches)) return null
    const total = feet + inches / 12
    return total > 0 ? total : null
  }

  // Inches only: 8", 8 in
  const inchesMatch = input.match(/^(\d+(?:\.\d+)?)\s*(?:"|in\.?|inches)$/)
  if (inchesMatch) {
    const inches = Number.parseFloat(inchesMatch[1])
    if (!Number.isFinite(inches)) return null
    return inches > 0 ? inches / 12 : null
  }

  // Plain number = decimal feet
  const plainMatch = input.match(/^(\d+(?:\.\d+)?)$/)
  if (plainMatch) {
    const feet = Number.parseFloat(plainMatch[1])
    if (!Number.isFinite(feet)) return null
    return feet > 0 ? feet : null
  }

  return null
}

// ============================================================================
// LIST FILTER SCHEMAS
// ============================================================================

export const drawingSetListFiltersSchema = z.object({
  project_id: z.string().uuid().optional(),
  status: drawingSetStatusSchema.optional(),
  search: z.string().optional(),
  limit: z.number().int().positive().max(200).default(50),
  offset: z.number().int().nonnegative().default(0),
})

export type DrawingSetListFilters = z.infer<typeof drawingSetListFiltersSchema>

export const drawingSheetListFiltersSchema = z.object({
  project_id: z.string().uuid().optional(),
  drawing_set_id: z.string().uuid().optional(),
  discipline: drawingDisciplineSchema.optional(),
  revision_id: z.string().uuid().optional(),
  search: z.string().optional(),
  share_with_clients: z.boolean().optional(),
  share_with_subs: z.boolean().optional(),
  limit: z.number().int().positive().max(500).default(100),
  offset: z.number().int().nonnegative().default(0),
})

export type DrawingSheetListFilters = z.infer<typeof drawingSheetListFiltersSchema>

export const drawingRevisionListFiltersSchema = z.object({
  project_id: z.string().uuid().optional(),
  drawing_set_id: z.string().uuid().optional(),
  status: z.enum(["processing", "draft", "published"]).optional(),
  include_unpublished: z.boolean().optional(),
  limit: z.number().int().positive().max(100).default(50),
  offset: z.number().int().nonnegative().default(0),
})

export type DrawingRevisionListFilters = z.infer<typeof drawingRevisionListFiltersSchema>

// ============================================================================
// REVISION DISTRIBUTION SCHEMAS
// ============================================================================

export const distributeRevisionInputSchema = z.object({
  revision_id: z.string().uuid(),
  // Portal access token ids (not raw token strings) selected as recipients.
  token_ids: z.array(z.string().uuid()).min(1).max(100),
  message: z.string().max(1000).optional(),
})

export type DistributeRevisionInput = z.infer<typeof distributeRevisionInputSchema>

// ============================================================================
// DRAWING MARKUP SCHEMAS (Phase 4)
// ============================================================================

// Markup types for annotations
export const markupTypeSchema = z.enum([
  "arrow",
  "circle",
  "rectangle",
  "text",
  "freehand",
  "callout",
  "dimension",
  "cloud",
  "highlight",
])

export type MarkupType = z.infer<typeof markupTypeSchema>

// Human-readable markup type labels
export const MARKUP_TYPE_LABELS: Record<MarkupType, string> = {
  arrow: "Arrow",
  circle: "Circle",
  rectangle: "Rectangle",
  text: "Text",
  freehand: "Freehand",
  callout: "Callout",
  dimension: "Dimension",
  cloud: "Cloud",
  highlight: "Highlight",
}

// Markup data structure (stored as JSON)
export const markupDataSchema = z.object({
  type: markupTypeSchema,
  points: z.array(z.tuple([z.number(), z.number()])), // [[x, y], ...]
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#FF0000"),
  strokeWidth: z.number().positive().max(20).default(2),
  text: z.string().max(1000).optional(),
  fontSize: z.number().positive().max(72).optional(),
  style: z.record(z.any()).optional(),
})

export type MarkupData = z.infer<typeof markupDataSchema>

export const drawingMarkupInputSchema = z.object({
  drawing_sheet_id: z.string().uuid(),
  sheet_version_id: z.string().uuid().optional(),
  data: markupDataSchema,
  label: z.string().max(255).optional(),
  is_private: z.boolean().optional(),
  share_with_clients: z.boolean().optional(),
  share_with_subs: z.boolean().optional(),
})

export type DrawingMarkupInput = z.infer<typeof drawingMarkupInputSchema>

export const drawingMarkupUpdateSchema = z.object({
  data: markupDataSchema.optional(),
  label: z.string().max(255).optional().nullable(),
  is_private: z.boolean().optional(),
  share_with_clients: z.boolean().optional(),
  share_with_subs: z.boolean().optional(),
})

export type DrawingMarkupUpdate = z.infer<typeof drawingMarkupUpdateSchema>

export const drawingMarkupListFiltersSchema = z.object({
  drawing_sheet_id: z.string().uuid().optional(),
  sheet_version_id: z.string().uuid().optional(),
  created_by: z.string().uuid().optional(),
  markup_type: markupTypeSchema.optional(),
  include_private: z.boolean().optional(), // If false, excludes other users' private markups
  limit: z.number().int().positive().max(500).default(100),
  offset: z.number().int().nonnegative().default(0),
})

export type DrawingMarkupListFilters = z.infer<typeof drawingMarkupListFiltersSchema>

// ============================================================================
// DRAWING PIN SCHEMAS (Phase 4)
// ============================================================================

// Pin entity types
export const pinEntityTypeSchema = z.enum([
  "task",
  "rfi",
  "punch_list",
  "submittal",
  "daily_log",
  "observation",
  "issue",
  "photo",
])

export type PinEntityType = z.infer<typeof pinEntityTypeSchema>

// Human-readable entity type labels
export const PIN_ENTITY_TYPE_LABELS: Record<PinEntityType, string> = {
  task: "Task",
  rfi: "RFI",
  punch_list: "Punch List Item",
  submittal: "Submittal",
  daily_log: "Daily Log",
  observation: "Observation",
  issue: "Issue",
  photo: "Photo",
}

// Pin status values
export const pinStatusSchema = z.enum([
  "open",
  "in_progress",
  "closed",
  "pending",
  "approved",
  "rejected",
])

export type PinStatus = z.infer<typeof pinStatusSchema>

// Pin style structure (stored as JSON)
export const pinStyleSchema = z.object({
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  icon: z.string().max(50).optional(), // icon name
  size: z.enum(["small", "medium", "large"]).optional(),
})

export type PinStyle = z.infer<typeof pinStyleSchema>

export const drawingPinInputSchema = z.object({
  project_id: z.string().uuid(),
  drawing_sheet_id: z.string().uuid(),
  sheet_version_id: z.string().uuid().optional(),
  x_position: z.number().min(0).max(1),
  y_position: z.number().min(0).max(1),
  entity_type: pinEntityTypeSchema,
  entity_id: z.string().uuid(),
  label: z.string().max(255).optional(),
  style: pinStyleSchema.optional(),
  status: pinStatusSchema.optional(),
  share_with_clients: z.boolean().optional(),
  share_with_subs: z.boolean().optional(),
})

export type DrawingPinInput = z.infer<typeof drawingPinInputSchema>

export const drawingPinUpdateSchema = z.object({
  x_position: z.number().min(0).max(1).optional(),
  y_position: z.number().min(0).max(1).optional(),
  label: z.string().max(255).optional().nullable(),
  style: pinStyleSchema.optional(),
  status: pinStatusSchema.optional(),
  share_with_clients: z.boolean().optional(),
  share_with_subs: z.boolean().optional(),
})

export type DrawingPinUpdate = z.infer<typeof drawingPinUpdateSchema>

export const drawingPinListFiltersSchema = z.object({
  project_id: z.string().uuid().optional(),
  drawing_sheet_id: z.string().uuid().optional(),
  sheet_version_id: z.string().uuid().optional(),
  entity_type: pinEntityTypeSchema.optional(),
  entity_id: z.string().uuid().optional(),
  status: pinStatusSchema.optional(),
  created_by: z.string().uuid().optional(),
  limit: z.number().int().positive().max(500).default(100),
  offset: z.number().int().nonnegative().default(0),
})

export type DrawingPinListFilters = z.infer<typeof drawingPinListFiltersSchema>

// Photo pin creation ("Attach Photo" on a drawing): the image is uploaded
// through the standard files path first; this input ties it to a location.
export const createPhotoFromDrawingInputSchema = z.object({
  project_id: z.string().uuid(),
  drawing_sheet_id: z.string().uuid(),
  x_position: z.number().min(0).max(1),
  y_position: z.number().min(0).max(1),
  file_id: z.string().uuid(),
  caption: z.string().max(255).optional(),
})

export type CreatePhotoFromDrawingInput = z.infer<typeof createPhotoFromDrawingInputSchema>

// Create entity from pin input (for "Create task/RFI from drawing" workflow)
export const createEntityFromPinInputSchema = z.object({
  drawing_sheet_id: z.string().uuid(),
  sheet_version_id: z.string().uuid().optional(),
  x_position: z.number().min(0).max(1),
  y_position: z.number().min(0).max(1),
  entity_type: pinEntityTypeSchema,
  // Entity-specific data (passed to entity creation)
  entity_data: z.record(z.any()),
})

export type CreateEntityFromPinInput = z.infer<typeof createEntityFromPinInputSchema>
