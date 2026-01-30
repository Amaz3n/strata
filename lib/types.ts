import type React from "react"
import type { FileCategory } from "@/lib/validation/files"
// Core domain types for Arc
// Following the spec: every tenant-owned row includes org_id

export interface Org {
  id: string
  name: string
  slug: string
  address?: Address
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
  license_expiry?: string
  license_verified?: boolean
  insurance_expiry?: string
  insurance_provider?: string
  insurance_document_id?: string
  w9_on_file?: boolean
  w9_file_id?: string
  prequalified?: boolean
  prequalified_at?: string
  rating?: number
  default_payment_terms?: string
  internal_notes?: string
  notes?: string
  created_at: string
  updated_at?: string
  contact_count?: number
  project_count?: number
  contacts?: Contact[]
}

export type ComplianceRules = {
  require_w9?: boolean
  require_insurance?: boolean
  require_license?: boolean
  require_lien_waiver?: boolean
  block_payment_on_missing_docs?: boolean
}

export type ComplianceRequirementTemplateItem = {
  document_type_id: string
  is_required?: boolean
  min_coverage_cents?: number
  notes?: string
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
  external_crm_id?: string
  crm_source?: string
  created_at: string
  updated_at?: string
  companies?: ContactCompanyLink[]
  company_details?: Company[]
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
export type ProjectVendorRole = "subcontractor" | "supplier" | "consultant" | "architect" | "engineer" | "client"

export interface ProjectVendor {
  id: string
  org_id: string
  project_id: string
  company_id?: string
  contact_id?: string
  role: ProjectVendorRole
  scope?: string
  status: "active" | "invited" | "inactive"
  notes?: string
  created_at: string
  updated_at: string
  company?: Company
  contact?: Contact
}

export interface Contract {
  id: string
  org_id: string
  project_id: string
  proposal_id?: string
  number?: string
  title: string
  status: "draft" | "active" | "amended" | "completed" | "terminated"
  contract_type?: "fixed_price" | "cost_plus" | "time_materials" | "unit_price"
  total_cents?: number
  currency: string
  markup_percent?: number
  retainage_percent?: number
  retainage_release_trigger?: string
  terms?: string
  effective_date?: string
  signed_at?: string
  signature_data?: {
    signature_svg?: string
    signed_at?: string
    signer_name?: string
    signer_ip?: string
  }
  snapshot: Record<string, any>
  created_at: string
  updated_at: string
}

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
  assignee_kind?: "user" | "contact" | "company"
  assignee?: {
    id: string
    full_name: string
    avatar_url?: string
    email?: string
  }
  assignee_contact?: { id: string; full_name: string; email?: string; company_name?: string }
  assignee_company?: { id: string; name: string; company_type?: string }
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
  entries?: DailyLogEntry[]
}

export interface DailyLogEntry {
  id: string
  org_id: string
  project_id: string
  daily_log_id: string
  entry_type: string
  description?: string
  quantity?: number
  hours?: number
  progress?: number
  schedule_item_id?: string
  task_id?: string
  punch_item_id?: string
  cost_code_id?: string
  location?: string
  trade?: string
  labor_type?: string
  inspection_result?: string
  metadata?: Record<string, unknown>
  created_at: string
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
  // Cost tracking fields
  cost_code_id?: string | null
  budget_cents?: number | null
  actual_cost_cents?: number | null
  // Joined data (optional, populated by service)
  assignments?: ScheduleAssignment[]
  dependency_details?: ScheduleDependency[]
  change_order_impacts?: ScheduleItemChangeOrder[]
  linked_draws?: DrawSchedule[]
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

export interface ScheduleItemChangeOrder {
  id: string
  org_id: string
  schedule_item_id: string
  change_order_id: string
  days_adjusted: number
  notes?: string | null
  applied_at?: string | null
  created_at: string
  // Joined data
  change_order?: ChangeOrder
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
  // Sub-specific permissions
  can_view_commitments?: boolean     // Can see their contracts
  can_view_bills?: boolean           // Can see their submitted invoices
  can_submit_invoices?: boolean      // Can submit new invoices
  can_upload_compliance_docs?: boolean  // Can upload compliance documents
}

export interface PortalAccessToken {
  id: string
  org_id: string
  project_id: string
  contact_id?: string | null
  company_id?: string | null      // For sub portals
  token: string
  name: string
  portal_type: "client" | "sub"   // Explicit portal type
  permissions: PortalPermissions
  pin_required: boolean
  pin_locked_until?: string | null
  expires_at?: string | null
  access_count: number
  max_access_count?: number | null
  last_accessed_at?: string | null
  revoked_at?: string | null
  created_at: string
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
  cost_code_id?: string | null
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

export interface CostCode {
  id: string
  org_id: string
  parent_id?: string | null
  code: string
  name: string
  division?: string | null
  category?: string | null
  standard?: string | null
  unit?: string | null
  default_unit_cost_cents?: number | null
  is_active?: boolean | null
  metadata?: Record<string, any>
}

export interface ChangeOrder {
  id: string
  org_id: string
  project_id: string
  co_number?: number | string | null
  title: string
  description?: string
  status: string
  reason?: string
  total_cents?: number
  amount_cents?: number // Alias for total_cents used in some components
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
  cost_code_id?: string | null
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
  project_id?: string | null
  token?: string | null
  invoice_number: string
  title: string
  status: "draft" | "sent" | "partial" | "paid" | "overdue" | "void"
  qbo_id?: string | null
  qbo_synced_at?: string | null
  qbo_sync_status?: "pending" | "synced" | "error" | "skipped" | null
  issue_date?: string | null
  due_date?: string | null
  notes?: string | null
  client_visible?: boolean | null
  subtotal_cents?: number | null
  tax_cents?: number | null
  total_cents?: number | null
  currency: string
  balance_due_cents?: number | null
  metadata?: Record<string, any>
  lines?: InvoiceLine[]
  totals?: InvoiceTotals
  created_at?: string
  updated_at?: string
  viewed_at?: string | null
  sent_at?: string | null
  sent_to_emails?: string[] | null
  customer_name?: string | null
}

export type PaymentStatus = "pending" | "processing" | "succeeded" | "failed" | "canceled" | "refunded"
export type PaymentMethodType = "ach" | "card" | "wire" | "check"

export interface Payment {
  id: string
  org_id: string
  project_id?: string | null
  invoice_id?: string | null
  bill_id?: string | null
  amount_cents: number
  currency: string
  method?: PaymentMethodType | string | null
  provider?: string | null
  provider_payment_id?: string | null
  status: PaymentStatus
  reference?: string | null
  fee_cents?: number | null
  net_cents?: number | null
  metadata?: Record<string, any>
  received_at: string
  created_at?: string
  updated_at?: string
}

export interface PaymentIntent {
  id: string
  org_id: string
  project_id?: string | null
  invoice_id?: string | null
  provider: string
  provider_intent_id?: string | null
  status: string
  amount_cents: number
  currency: string
  client_secret?: string | null
  idempotency_key?: string | null
  expires_at?: string | null
  metadata?: Record<string, any>
  created_at?: string
  updated_at?: string
}

export interface PaymentLink {
  id: string
  org_id: string
  invoice_id: string
  token_hash?: string
  nonce?: string
  expires_at?: string | null
  max_uses?: number | null
  used_count?: number
  metadata?: Record<string, any>
  created_at?: string
  updated_at?: string
}

export interface InvoiceView {
  id: string
  org_id: string
  invoice_id: string
  token?: string | null
  user_agent?: string | null
  ip_address?: string | null
  viewed_at: string
  created_at?: string
}

export interface Receipt {
  id: string
  org_id: string
  payment_id: string
  project_id?: string | null
  invoice_id?: string | null
  amount_cents?: number | null
  issued_to_email?: string | null
  issued_at: string
  file_id?: string | null
  metadata?: Record<string, any>
  created_at?: string
}

export interface EstimateItem {
  id?: string
  org_id?: string
  estimate_id?: string
  cost_code_id?: string | null
  item_type?: "line" | "group"
  description: string
  quantity?: number
  unit?: string | null
  unit_cost_cents?: number | null
  markup_pct?: number | null
  sort_order?: number | null
  metadata?: Record<string, any>
}

export interface Estimate {
  id: string
  org_id: string
  project_id?: string | null
  recipient_contact_id?: string | null
  title: string
  status: string
  version: number
  subtotal_cents?: number | null
  tax_cents?: number | null
  total_cents?: number | null
  currency?: string | null
  valid_until?: string | null
  metadata?: Record<string, any>
  created_by?: string | null
  created_at?: string
  updated_at?: string
  items?: EstimateItem[]
}

export interface EstimateTemplate {
  id: string
  org_id: string
  name: string
  description?: string | null
  lines: EstimateItem[]
  is_default?: boolean | null
  created_at?: string
  updated_at?: string
}

export interface DrawSchedule {
  id: string
  org_id: string
  project_id: string
  invoice_id?: string | null
  contract_id?: string | null
  draw_number: number
  title: string
  description?: string | null
  amount_cents: number
  percent_of_contract?: number | null
  due_date?: string | null
  scheduled_date?: string | null // Alias used in some components
  due_trigger?: "date" | "milestone" | "approval" | null
  milestone_id?: string | null
  status: "pending" | "invoiced" | "partial" | "paid"
  invoiced_at?: string | null
  paid_at?: string | null
  metadata?: Record<string, any>
  created_at?: string
  updated_at?: string
}

export interface Retainage {
  id: string
  org_id: string
  project_id: string
  contract_id: string
  invoice_id?: string | null
  amount_cents: number
  status: "held" | "released" | "invoiced" | "paid"
  held_at: string
  released_at?: string | null
  release_invoice_id?: string | null
  metadata?: Record<string, any>
  created_at?: string
  updated_at?: string
}

export interface LienWaiver {
  id: string
  org_id: string
  project_id: string
  payment_id?: string | null
  company_id?: string | null
  contact_id?: string | null
  waiver_type: "conditional" | "unconditional" | "final"
  status: "pending" | "sent" | "signed" | "rejected" | "expired"
  amount_cents: number
  through_date: string
  claimant_name: string
  property_description?: string | null
  document_file_id?: string | null
  signed_file_id?: string | null
  signature_data?: {
    signature_svg?: string
    signed_at?: string
    signer_name?: string
    signer_ip?: string
  }
  sent_at?: string | null
  signed_at?: string | null
  expires_at?: string | null
  metadata?: Record<string, any>
  created_at?: string
  updated_at?: string
}

export interface PaymentSchedule {
  id: string
  org_id: string
  project_id: string
  contact_id?: string | null
  payment_method_id?: string | null
  total_amount_cents: number
  installment_amount_cents: number
  installments_total: number
  installments_paid: number
  frequency: "weekly" | "biweekly" | "monthly"
  next_charge_date?: string | null
  status: "active" | "paused" | "completed" | "canceled" | "failed"
  auto_charge: boolean
  metadata?: Record<string, any>
  created_at?: string
  updated_at?: string
}

export interface ReminderDelivery {
  id: string
  org_id: string
  reminder_id: string
  invoice_id: string
  channel: "email" | "sms"
  status: "pending" | "sent" | "delivered" | "failed" | "clicked"
  sent_at?: string | null
  delivered_at?: string | null
  clicked_at?: string | null
  error_message?: string | null
  provider_message_id?: string | null
  metadata?: Record<string, any>
  created_at?: string
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

export interface Decision {
  id: string
  org_id: string
  project_id: string
  title: string
  description?: string
  status: string
  due_date?: string | null
  approved_at?: string | null
  approved_by?: string | null
  created_at: string
  updated_at: string
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
  created_at: string
  updated_at: string
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
  created_at: string
  updated_at: string
}

export interface PortalMessageThread {
  messages: PortalMessage[]
}

export interface PortalFinancialSummary {
  contractTotal: number
  totalPaid: number
  balanceRemaining: number
  nextDraw?: {
    id: string
    draw_number: number
    title: string
    amount_cents: number
    due_date?: string | null
    status: string
  }
  draws: DrawSchedule[]
}

export interface PortalProjectManager {
  id: string
  full_name: string
  email?: string
  phone?: string
  avatar_url?: string
  role_label?: string
}

export interface ClientPortalData {
  org: { name: string; logo_url?: string }
  project: Project
  projectManager?: PortalProjectManager
  schedule: ScheduleItem[]
  photos: PhotoTimelineEntry[]
  pendingChangeOrders: ChangeOrder[]
  pendingSelections: Selection[]
  warrantyRequests?: WarrantyRequest[]
  invoices: Invoice[]
  rfis: Rfi[]
  submittals: Submittal[]
  recentLogs: DailyLog[]
  sharedFiles: FileMetadata[]
  messages: PortalMessage[]
  punchItems: PunchItem[]
  financialSummary?: PortalFinancialSummary
}

export interface SubPortalCommitment {
  id: string
  title: string
  status: "draft" | "approved" | "complete" | "canceled"
  total_cents: number
  billed_cents: number
  paid_cents: number
  remaining_cents: number
  start_date?: string | null
  end_date?: string | null
  project_name: string
}

export interface SubPortalBill {
  id: string
  bill_number: string
  commitment_id: string
  commitment_title: string
  status: "pending" | "approved" | "partial" | "paid"
  total_cents: number
  paid_cents?: number
  bill_date: string
  due_date?: string | null
  submitted_at: string
  paid_at?: string | null
  payment_reference?: string | null
}

export interface SubPortalFinancialSummary {
  total_committed: number      // Sum of all commitment totals
  total_billed: number         // Sum of all vendor bills
  total_paid: number           // Sum of paid vendor bills
  total_remaining: number      // committed - billed
  pending_approval: number     // Bills in "pending" status
  approved_unpaid: number      // Bills in "approved" status
}

export interface SubPortalData {
  org: {
    id: string
    name: string
    logo_url?: string | null
  }
  project: Project
  company: {
    id: string
    name: string
    trade?: string | null
    insurance_expiry?: string | null
    license_expiry?: string | null
    w9_on_file?: boolean | null
  }
  projectManager?: PortalProjectManager
  commitments: SubPortalCommitment[]
  bills: SubPortalBill[]
  financialSummary: SubPortalFinancialSummary
  schedule: ScheduleItem[]           // Filtered to this company's tasks
  rfis: Rfi[]                        // Assigned to this company
  submittals: Submittal[]            // Assigned to this company
  sharedFiles: FileMetadata[]        // Shared with sub portal
  messages: PortalMessage[]
  pendingRfiCount: number
  pendingSubmittalCount: number
  complianceStatus?: ComplianceStatusSummary  // Compliance document status
}

// Compliance Document Types
export type ComplianceDocumentStatus = "pending_review" | "approved" | "rejected" | "expired"

export interface ComplianceDocumentType {
  id: string
  org_id: string
  name: string
  code: string
  description?: string | null
  has_expiry: boolean
  expiry_warning_days: number
  is_system: boolean
  is_active: boolean
  created_at: string
}

export interface ComplianceRequirement {
  id: string
  org_id: string
  company_id: string
  document_type_id: string
  document_type?: ComplianceDocumentType
  is_required: boolean
  min_coverage_cents?: number | null
  notes?: string | null
  created_at: string
  created_by?: string | null
}

export interface ComplianceDocument {
  id: string
  org_id: string
  company_id: string
  document_type_id: string
  document_type?: ComplianceDocumentType
  requirement_id?: string | null
  file_id?: string | null
  file?: FileMetadata
  status: ComplianceDocumentStatus
  effective_date?: string | null
  expiry_date?: string | null
  policy_number?: string | null
  coverage_amount_cents?: number | null
  carrier_name?: string | null
  reviewed_by?: string | null
  reviewed_at?: string | null
  review_notes?: string | null
  rejection_reason?: string | null
  submitted_via_portal: boolean
  portal_token_id?: string | null
  created_at: string
  updated_at: string
}

export interface ComplianceStatusSummary {
  company_id: string
  requirements: ComplianceRequirement[]
  documents: ComplianceDocument[]
  missing: ComplianceDocumentType[]
  expiring_soon: ComplianceDocument[]  // within 30 days
  expired: ComplianceDocument[]
  pending_review: ComplianceDocument[]
  is_compliant: boolean
}

export interface FileMetadata {
  id: string
  org_id: string
  project_id?: string
  daily_log_id?: string
  schedule_item_id?: string
  file_name: string
  storage_path: string
  mime_type?: string
  size_bytes?: number
  visibility: string
  category?: FileCategory
  tags?: string[]
  folder_path?: string
  url?: string
  created_at: string
}

export interface CloseoutPackage {
  id: string
  org_id: string
  project_id: string
  status: string
  created_at: string
  updated_at?: string
}

export interface CloseoutItem {
  id: string
  org_id: string
  project_id: string
  closeout_package_id?: string | null
  title: string
  status: string
  file_id?: string | null
  created_at: string
  updated_at?: string
}

export interface WarrantyRequest {
  id: string
  org_id: string
  project_id: string
  title: string
  description?: string | null
  status: string
  priority?: string | null
  requested_by?: string | null
  created_at: string
  closed_at?: string | null
}

export interface DashboardStats {
  activeProjects: number
  tasksThisWeek: number
  pendingApprovals: number
  recentPhotos: number
}

export interface Proposal {
  id: string
  org_id: string
  project_id?: string | null
  estimate_id?: string | null
  recipient_contact_id?: string | null
  number?: string | null
  title: string
  summary?: string | null
  terms?: string | null
  status?: "draft" | "sent" | "accepted" | string | null
  total_cents?: number | null
  token_hash?: string | null
  valid_until?: string | null
  sent_at?: string | null
  accepted_at?: string | null
  signature_required?: boolean | null
  created_at?: string | null
  updated_at?: string | null
}
