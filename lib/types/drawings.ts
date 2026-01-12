export interface DrawingSet {
  id: string
  org_id: string
  project_id: string
  title: string
  description?: string
  status: DrawingSetStatus
  source_file_id?: string
  total_pages?: number
  processed_pages: number
  error_message?: string
  created_by?: string
  creator_name?: string
  creator_avatar?: string
  created_at: string
  processed_at?: string
  sheets_count?: number
}

export interface DrawingRevision {
  id: string
  org_id: string
  project_id: string
  drawing_set_id: string
  revision_number: string
  title?: string
  description?: string
  created_by: string
  creator_name?: string
  creator_avatar?: string
  created_at: string
}

export interface DrawingSheet {
  id: string
  org_id: string
  project_id: string
  drawing_set_id: string
  revision_id: string
  sheet_number: string
  title?: string
  discipline?: DrawingDiscipline
  file_id?: string
  storage_path?: string
  signed_url?: string
  status?: DrawingSheetStatus
  created_by: string
  creator_name?: string
  creator_avatar?: string
  created_at: string
  share_with_clients?: boolean
  share_with_subs?: boolean
  // Optimized image URLs for fast rendering (Phase 1 performance)
  image_thumbnail_url?: string | null
  image_medium_url?: string | null
  image_full_url?: string | null
  image_width?: number | null
  image_height?: number | null
}

export interface DrawingSheetVersion {
  id: string
  org_id: string
  sheet_id: string
  file_id: string
  storage_path?: string
  signed_url?: string
  version_number: number
  change_description?: string
  created_by: string
  creator_name?: string
  creator_avatar?: string
  created_at: string
  // Image URLs for fast rendering (Phase 1 performance optimization)
  thumbnail_url?: string | null
  medium_url?: string | null
  full_url?: string | null
  image_width?: number | null
  image_height?: number | null
  images_generated_at?: string | null
}

export interface DrawingMarkup {
  id: string
  org_id: string
  sheet_id: string
  markup_type: MarkupType
  coordinates: Record<string, any>
  content?: string
  status: MarkupStatus
  created_by: string
  creator_name?: string
  creator_avatar?: string
  created_at: string
  updated_at: string
  assigned_to?: string
  assignee_name?: string
  assignee_avatar?: string
  due_date?: string
  resolved_at?: string
  resolved_by?: string
  resolver_name?: string
  resolver_avatar?: string
}

export interface DrawingPin {
  id: string
  org_id: string
  sheet_id: string
  entity_type: PinEntityType
  entity_id: string
  coordinates: Record<string, any>
  status: PinStatus
  created_by: string
  creator_name?: string
  creator_avatar?: string
  created_at: string
  updated_at: string
}

export type DrawingSetStatus = "processing" | "completed" | "failed"
export type DrawingDiscipline =
  | "architectural"
  | "structural"
  | "mechanical"
  | "electrical"
  | "plumbing"
  | "civil"
  | "landscape"
  | "other"

export type DrawingSheetStatus = "active" | "superseded" | "archived"
export type MarkupType = "issue" | "question" | "note" | "measurement" | "area"
export type MarkupStatus = "open" | "resolved" | "closed"
export type PinEntityType =
  | "task"
  | "rfi"
  | "change_order"
  | "punch_item"
  | "decision"
  | "submittal"

export type PinStatus = "open" | "resolved" | "closed"

