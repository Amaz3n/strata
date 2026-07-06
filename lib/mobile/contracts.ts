export const MOBILE_API_VERSION = "v1" as const
export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 100

export interface MobileUserDTO {
  id: string
  email: string
  display_name: string | null
  avatar_url: string | null
}

export interface MobileOrganizationDTO {
  id: string
  name: string
  slug: string | null
  logo_url: string | null
  role: string | null
}

export interface MobileProjectDTO {
  id: string
  organization_id: string
  name: string
  status: string
  address: string | null
  start_date: string | null
  end_date: string | null
  updated_at: string
}

export interface MobileDailyLogEntryDTO {
  id: string
  entry_type: string
  description: string | null
  quantity: number | null
  hours: number | null
  progress: number | null
  schedule_item_id: string | null
  task_id: string | null
  punch_item_id: string | null
  location: string | null
  trade: string | null
  inspection_result: string | null
  metadata: Record<string, unknown>
}

export interface MobileDailyLogCommentDTO {
  id: string
  body: string
  created_at: string
  author_name: string | null
  mentioned_user_ids: string[]
}

export interface MobileDailyLogPhotoDTO {
  id: string
  file_name: string
  mime_type: string | null
  download_url: string
}

export interface MobileDailyLogDTO {
  id: string
  organization_id: string
  project_id: string
  date: string
  summary: string | null
  weather: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  entries: MobileDailyLogEntryDTO[]
  comments: MobileDailyLogCommentDTO[]
  mentioned_user_ids: string[]
  photos: MobileDailyLogPhotoDTO[]
  photo_count: number
}

export interface MobileDailyLogContextDTO {
  schedule_items: Array<{ id: string; name: string; status: string; progress: number; trade: string | null; location: string | null }>
  tasks: Array<{ id: string; title: string; status: string }>
  punch_items: Array<{ id: string; title: string; status: string; location: string | null }>
  team: Array<{ id: string; name: string; email: string | null; role: string | null }>
}

export interface MobileDrawingSetDTO {
  id: string
  project_id: string
  title: string
  description: string | null
  status: string
  total_pages: number | null
  processed_pages: number
  sheet_count: number
  updated_at: string
}

export interface MobileDrawingSheetDTO {
  id: string
  drawing_set_id: string
  set_title: string | null
  sheet_number: string
  sheet_title: string | null
  discipline: string | null
  discipline_label: string | null
  current_revision_label: string | null
  version_count: number
  thumbnail_url: string | null
  image_url: string | null
  image_width: number | null
  image_height: number | null
  open_pins_count: number
  total_pins_count: number
  updated_at: string
}

export interface MobileDrawingSheetVersionDTO {
  id: string
  revision_label: string | null
  creator_name: string | null
  change_description: string | null
  created_at: string
  thumbnail_url: string | null
  image_url: string | null
  image_width: number | null
  image_height: number | null
}

export interface MobileDrawingPinDTO {
  id: string
  x_position: number
  y_position: number
  entity_type: string
  entity_id: string
  label: string | null
  status: string | null
  entity_title: string | null
  entity_status: string | null
}

export interface MobileDrawingSheetDetailDTO {
  sheet: MobileDrawingSheetDTO
  versions: MobileDrawingSheetVersionDTO[]
  pins: MobileDrawingPinDTO[]
}

export interface MobileScheduleItemDTO {
  id: string
  project_id: string
  name: string
  item_type: string
  status: string
  start_date: string | null
  end_date: string | null
  progress: number
  phase: string | null
  trade: string | null
  location: string | null
  is_critical_path: boolean
  assignees: string[]
  updated_at: string
}

export interface MobileTaskDTO {
  id: string
  project_id: string
  title: string
  description: string | null
  status: string
  priority: string | null
  due_date: string | null
  completed_at: string | null
  assignees: string[]
  created_at: string
  updated_at: string
}

export interface MobilePunchItemDTO {
  id: string
  project_id: string
  title: string
  description: string | null
  status: string
  severity: string | null
  location: string | null
  due_date: string | null
  resolved_at: string | null
}

export interface MobileExpenseDTO {
  id: string
  project_id: string
  vendor_name: string | null
  description: string | null
  expense_date: string | null
  amount_cents: number
  tax_cents: number
  payment_method: string | null
  status: string
  receipt_url: string | null
  created_at: string
}

export interface MobileReceiptScanDTO {
  vendor_name: string | null
  expense_date: string | null
  total_dollars: number | null
  tax_dollars: number | null
  payment_method: string | null
  description: string | null
  confidence: string
  notes: string[]
}

export interface MobileFileDTO {
  id: string
  file_name: string
  folder_path: string | null
  category: string | null
  mime_type: string | null
  size_bytes: number | null
  download_url: string | null
  is_image: boolean
  updated_at: string
}

export interface MobileFolderDTO {
  path: string
  name: string
  file_count: number
}

export interface MobileFilesDTO {
  folders: MobileFolderDTO[]
  files: MobileFileDTO[]
}

export interface MobileNotificationDTO {
  id: string
  type: string
  title: string
  message: string
  is_read: boolean
  project_id: string | null
  entity_type: string | null
  entity_id: string | null
  created_at: string
}

export interface MobileNotificationsDTO {
  notifications: MobileNotificationDTO[]
  unread_count: number
}

export interface MobilePlatformAuditEntryDTO {
  id: string
  occurred_at: string
  actor_user_id: string | null
  actor_name: string | null
  org_id: string | null
  org_name: string | null
  project_id: string | null
  project_name: string | null
  action_key: string
  resource_type: string | null
  resource_id: string | null
  decision: string
  reason_code: string | null
  request_id: string | null
  ip: string | null
  user_agent: string | null
}

export interface MobilePlatformIssueDTO {
  id: string
  issue_key: string
  title: string
  description: string | null
  status: string
  priority: string
  source: string
  environment: string | null
  org_id: string | null
  org_name: string | null
  project_id: string | null
  project_name: string | null
  assignee_user_id: string | null
  assignee_name: string | null
  created_by: string | null
  creator_name: string | null
  due_at: string | null
  started_at: string | null
  resolved_at: string | null
  attachment_names: string[]
  created_at: string
  updated_at: string
}

export interface MobileRfiDTO {
  id: string
  rfi_number: number
  subject: string
  question: string | null
  status: string
  priority: string | null
  due_date: string | null
  answered_at: string | null
  assignee_name: string | null
  created_at: string
}

export interface MobileTeamMemberDTO {
  id: string
  name: string
  email: string | null
  role: string | null
  avatar_url: string | null
}

export interface MobileSessionDTO {
  user: MobileUserDTO
  organizations: MobileOrganizationDTO[]
  selected_organization_id: string | null
}

export interface MobilePageMeta {
  request_id: string
  next_cursor: string | null
}

export interface MobilePage<T> {
  data: T[]
  meta: MobilePageMeta
}

export function parsePageSize(value: string | null): number {
  if (!value) return DEFAULT_PAGE_SIZE
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_PAGE_SIZE
  return Math.min(parsed, MAX_PAGE_SIZE)
}

export function encodeCursor(updatedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ updated_at: updatedAt, id }), "utf8").toString("base64url")
}

export function decodeCursor(value: string | null): { updated_at: string; id: string } | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>
    if (typeof parsed.updated_at !== "string" || typeof parsed.id !== "string") return null
    return { updated_at: parsed.updated_at, id: parsed.id }
  } catch {
    return null
  }
}
