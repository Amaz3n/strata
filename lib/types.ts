import type React from "react"
// Core domain types for Strata
// Following the spec: every tenant-owned row includes org_id

export interface Org {
  id: string
  name: string
  slug: string
  created_at: string
  updated_at: string
}

export interface User {
  id: string
  email: string
  full_name: string
  avatar_url?: string
}

export interface Membership {
  id: string
  user_id: string
  org_id: string
  role: OrgRole
  status: "active" | "invited" | "deactivated"
  created_at: string
}

export type OrgRole = "owner" | "admin" | "staff" | "readonly"
export type ProjectRole = "pm" | "field" | "accounting" | "client" | "sub"

export interface Address {
  formatted?: string
  street1?: string
  street2?: string
  city?: string
  state?: string
  postal_code?: string
  country?: string
}

// Directory: companies and contacts
export type CompanyType = "subcontractor" | "supplier" | "client" | "architect" | "engineer" | "other"

export interface Company {
  id: string
  org_id: string
  name: string
  company_type: CompanyType
  trade?: string
  phone?: string
  email?: string
  website?: string
  address?: Address
  license_number?: string
  insurance_expiry?: string
  insurance_document_id?: string
  notes?: string
  created_at: string
  updated_at?: string
  contact_count?: number
  project_count?: number
}

export type ContactType = "internal" | "subcontractor" | "client" | "vendor" | "consultant"

export interface Contact {
  id: string
  org_id: string
  full_name: string
  email?: string
  phone?: string
  role?: string
  contact_type: ContactType
  primary_company_id?: string
  primary_company?: Company
  has_portal_access?: boolean
  preferred_contact_method?: string
  notes?: string
  created_at: string
  updated_at?: string
  companies?: ContactCompanyLink[]
}

export interface ContactCompanyLink {
  id: string
  org_id: string
  contact_id: string
  company_id: string
  relationship?: string
  created_at: string
}

export interface TeamMember {
  id: string // membership id
  user: User
  role: OrgRole
  status: "active" | "invited" | "suspended"
  project_count?: number
  last_active_at?: string
  invited_by?: User
  created_at: string
}

export interface Project {
  id: string
  org_id: string
  name: string
  address?: string
  status: ProjectStatus
  start_date?: string
  end_date?: string
  budget?: number
  client_id?: string
  total_value?: number
  property_type?: ProjectPropertyType
  project_type?: ProjectWorkType
  description?: string
  created_at: string
  updated_at: string
}

export type ProjectStatus = "planning" | "bidding" | "active" | "on_hold" | "completed" | "cancelled"
export type ProjectPropertyType = "residential" | "commercial"
export type ProjectWorkType = "new_construction" | "remodel" | "addition" | "renovation" | "repair"

export type ConversationChannel = "internal" | "client" | "sub"

export interface Conversation {
  id: string
  org_id: string
  project_id?: string
  subject?: string | null
  channel: ConversationChannel
  created_by?: string
  created_at: string
}

export interface PortalMessage {
  id: string
  org_id: string
  conversation_id: string
  sender_id?: string
  message_type: string
  body?: string | null
  payload?: Record<string, any>
  sent_at: string
  sender_name?: string
  sender_avatar_url?: string
}

export interface TaskChecklistItem {
  id: string
  text: string
  completed: boolean
  completed_at?: string
  completed_by?: string
}

export interface Task {
  id: string
  org_id: string
  project_id: string
  title: string
  description?: string
  status: TaskStatus
  priority: TaskPriority
  assignee_id?: string
  assignee?: {
    id: string
    full_name: string
    avatar_url?: string
  }
  start_date?: string
  due_date?: string
  completed_at?: string
  // Construction-specific fields stored in metadata
  location?: string // e.g., "Kitchen", "2nd Floor Bathroom"
  trade?: string // e.g., "Electrical", "Plumbing", "Framing"
  estimated_hours?: number
  actual_hours?: number
  checklist?: TaskChecklistItem[]
  tags?: string[]
  // Linked entities
  linked_schedule_item_id?: string
  linked_daily_log_id?: string
  // Activity
  created_by?: string
  created_by_name?: string
  assigned_by?: string
  created_at: string
  updated_at: string
}

export type TaskStatus = "todo" | "in_progress" | "blocked" | "done"
export type TaskPriority = "low" | "normal" | "high" | "urgent"
export type TaskTrade = 
  | "general"
  | "demolition"
  | "concrete"
  | "framing"
  | "roofing"
  | "electrical"
  | "plumbing"
  | "hvac"
  | "insulation"
  | "drywall"
  | "painting"
  | "flooring"
  | "cabinets"
  | "tile"
  | "landscaping"
  | "other"

export interface DailyLog {
  id: string
  org_id: string
  project_id: string
  date: string
  weather?: string
  notes?: string
  created_by?: string
  created_at: string
  updated_at: string
}

export interface ScheduleItem {
  id: string
  org_id: string
  project_id: string
  name: string
  item_type: ScheduleItemType
  status: ScheduleStatus
  start_date?: string
  end_date?: string
  progress?: number
  assigned_to?: string
  metadata?: Record<string, any>
  created_at: string
  updated_at: string
  dependencies?: string[]
  // Enhanced scheduling fields
  phase?: string
  trade?: string
  location?: string
  planned_hours?: number
  actual_hours?: number
  constraint_type?: ConstraintType
  constraint_date?: string
  is_critical_path?: boolean
  float_days?: number
  color?: string
  sort_order?: number
  // Joined data (optional, populated by service)
  assignments?: ScheduleAssignment[]
  dependency_details?: ScheduleDependency[]
}

export type ScheduleItemType = "task" | "milestone" | "inspection" | "handoff" | "phase" | "delivery"
export type ScheduleStatus = "planned" | "in_progress" | "at_risk" | "completed" | "blocked" | "cancelled"
export type DependencyType = "FS" | "SS" | "FF" | "SF"
export type ConstraintType = "asap" | "alap" | "must_start_on" | "must_finish_on" | "start_no_earlier" | "finish_no_later"

export interface ScheduleDependency {
  id: string
  org_id: string
  project_id: string
  item_id: string
  depends_on_item_id: string
  dependency_type: DependencyType
  lag_days: number
  // Joined data
  depends_on_item?: ScheduleItem
}

export interface ScheduleAssignment {
  id: string
  org_id: string
  project_id: string
  schedule_item_id: string
  user_id?: string
  contact_id?: string
  company_id?: string
  role: string
  planned_hours?: number
  actual_hours?: number
  hourly_rate_cents?: number
  notes?: string
  confirmed_at?: string
  created_at: string
  updated_at: string
  // Joined data
  user?: { id: string; full_name: string; avatar_url?: string }
  contact?: { id: string; full_name: string; email?: string }
  company?: { id: string; name: string; company_type?: string }
}

export interface ScheduleBaseline {
  id: string
  org_id: string
  project_id: string
  name: string
  description?: string
  snapshot_at: string
  items: ScheduleItem[]
  is_active: boolean
  created_by?: string
  created_at: string
}

export interface ScheduleTemplate {
  id: string
  org_id: string
  name: string
  description?: string
  project_type?: string
  property_type?: string
  items: Partial<ScheduleItem>[]
  is_public: boolean
  created_by?: string
  created_at: string
  updated_at: string
}

// Navigation types
export interface NavItem {
  title: string
  href: string
  icon: React.ComponentType<{ className?: string }>
  badge?: number
}

export interface NavSection {
  title?: string
  items: NavItem[]
}

export interface PortalView {
  project: Project
  channel: ConversationChannel
  conversation: Conversation
  messages: PortalMessage[]
  recentLogs: DailyLog[]
  sharedFiles: FileMetadata[]
  schedule: ScheduleItem[]
}

export interface PortalPermissions {
  can_view_schedule: boolean
  can_view_photos: boolean
  can_view_documents: boolean
  can_download_files?: boolean
  can_view_daily_logs: boolean
  can_view_budget: boolean
  can_approve_change_orders: boolean
  can_submit_selections: boolean
  can_create_punch_items: boolean
  can_message: boolean
  can_view_invoices?: boolean
  can_pay_invoices?: boolean
  can_view_rfis?: boolean
  can_view_submittals?: boolean
  can_respond_rfis?: boolean
  can_submit_submittals?: boolean
}

export interface PortalAccessToken {
  id: string
  org_id: string
  project_id: string
  contact_id?: string | null
  company_id?: string | null
  token: string
  portal_type: "client" | "sub"
  created_by?: string | null
  created_at: string
  expires_at?: string | null
  last_accessed_at?: string | null
  revoked_at?: string | null
  access_count: number
  max_access_count?: number | null
  permissions: PortalPermissions
}

export interface PhotoTimelineEntry {
  week_start: string
  week_end: string
  photos: Photo[]
  log_summaries: string[]
}

export interface Photo {
  id: string
  url: string
  taken_at?: string
  tags?: string[]
}

export interface ChangeOrderLine {
  id?: string
  description: string
  quantity: number
  unit?: string | null
  unit_cost_cents: number
  allowance_cents?: number | null
  taxable?: boolean | null
}

export interface ChangeOrderTotals {
  subtotal_cents: number
  tax_cents: number
  markup_cents: number
  allowance_cents: number
  total_cents: number
  tax_rate?: number | null
  markup_percent?: number | null
}

export interface ChangeOrder {
  id: string
  org_id: string
  project_id: string
  title: string
  description?: string
  status: string
  reason?: string
  total_cents?: number
  approved_by?: string | null
  approved_at?: string | null
  summary?: string | null
  days_impact?: number | null
  client_visible?: boolean | null
  requires_signature?: boolean | null
  created_at?: string
  updated_at?: string
  metadata?: Record<string, any>
  lines?: ChangeOrderLine[]
  totals?: ChangeOrderTotals
}

export interface InvoiceLine {
  id?: string
  description: string
  quantity: number
  unit?: string | null
  unit_cost_cents: number
  taxable?: boolean | null
}

export interface InvoiceTotals {
  subtotal_cents: number
  tax_cents: number
  total_cents: number
  balance_due_cents?: number
  tax_rate?: number | null
}

export interface Invoice {
  id: string
  org_id: string
  project_id: string
  invoice_number: string
  title: string
  status: "draft" | "sent" | "paid" | "overdue" | "void"
  issue_date?: string | null
  due_date?: string | null
  notes?: string | null
  client_visible?: boolean | null
  subtotal_cents?: number | null
  tax_cents?: number | null
  total_cents?: number | null
  balance_due_cents?: number | null
  metadata?: Record<string, any>
  lines?: InvoiceLine[]
  totals?: InvoiceTotals
  created_at?: string
  updated_at?: string
}

export interface Selection {
  id: string
  org_id: string
  project_id: string
  category_id: string
  selected_option_id?: string | null
  status: "pending" | "selected" | "confirmed" | "ordered" | "received"
  due_date?: string | null
  selected_at?: string | null
  confirmed_at?: string | null
  notes?: string | null
}

export interface SelectionCategory {
  id: string
  org_id: string
  name: string
  description?: string | null
  sort_order?: number | null
}

export interface SelectionOption {
  id: string
  org_id: string
  category_id: string
  name: string
  description?: string | null
  price_cents?: number | null
  price_type?: "included" | "upgrade" | "downgrade" | null
  price_delta_cents?: number | null
  image_url?: string | null
  sku?: string | null
  vendor?: string | null
  lead_time_days?: number | null
  sort_order?: number | null
  is_default?: boolean | null
  is_available?: boolean | null
}

export interface PunchItem {
  id: string
  org_id: string
  project_id: string
  title: string
  description?: string
  status: string
  due_date?: string | null
  severity?: string | null
  location?: string | null
  resolved_at?: string | null
}

export interface RfiDecision {
  decision_status?: "approved" | "revisions_requested" | "rejected"
  decision_note?: string | null
  decided_by_user_id?: string | null
  decided_by_contact_id?: string | null
  decided_at?: string | null
  decided_via_portal?: boolean | null
  decision_portal_token_id?: string | null
}

export interface Rfi {
  id: string
  org_id: string
  project_id: string
  rfi_number: number
  subject: string
  question: string
  status: string
  priority?: string | null
  due_date?: string | null
  answered_at?: string | null
  attachment_file_id?: string | null
  last_response_at?: string | null
  decision_status?: RfiDecision["decision_status"]
  decision_note?: string | null
  decided_by_user_id?: string | null
  decided_by_contact_id?: string | null
  decided_at?: string | null
  decided_via_portal?: boolean | null
  decision_portal_token_id?: string | null
}

export interface SubmittalDecision {
  decision_status?: "approved" | "approved_as_noted" | "revise_resubmit" | "rejected"
  decision_note?: string | null
  decision_by_user_id?: string | null
  decision_by_contact_id?: string | null
  decision_at?: string | null
  decision_via_portal?: boolean | null
  decision_portal_token_id?: string | null
}

export interface Submittal {
  id: string
  org_id: string
  project_id: string
  submittal_number: number
  title: string
  description?: string | null
  status: string
  spec_section?: string | null
  submittal_type?: string | null
  due_date?: string | null
  reviewed_at?: string | null
  attachment_file_id?: string | null
  last_item_submitted_at?: string | null
  decision_status?: SubmittalDecision["decision_status"]
  decision_note?: string | null
  decision_by_user_id?: string | null
  decision_by_contact_id?: string | null
  decision_at?: string | null
  decision_via_portal?: boolean | null
  decision_portal_token_id?: string | null
}

export interface PortalMessageThread {
  messages: PortalMessage[]
}

export interface ClientPortalData {
  org: { name: string; logo_url?: string }
  project: Project
  schedule: ScheduleItem[]
  photos: PhotoTimelineEntry[]
  pendingChangeOrders: ChangeOrder[]
  pendingSelections: Selection[]
  invoices: Invoice[]
  rfis: Rfi[]
  submittals: Submittal[]
  recentLogs: DailyLog[]
  sharedFiles: FileMetadata[]
  messages: PortalMessage[]
  punchItems: PunchItem[]
}

export interface FileMetadata {
  id: string
  org_id: string
  project_id?: string
  file_name: string
  storage_path: string
  mime_type?: string
  size_bytes?: number
  visibility: string
  created_at: string
}

export interface DashboardStats {
  activeProjects: number
  tasksThisWeek: number
  pendingApprovals: number
  recentPhotos: number
}
