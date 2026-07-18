// Shared, side-effect-free search configuration.
//
// Extracted from search.ts so it can be imported by both the search service
// (a "use server" module, which may only export async functions) and the
// write-through indexer (search-index.ts). Keep this file free of "use server"
// and of any runtime dependencies on the server action modules.

export type SearchEntityType =
  | 'project'
  | 'task'
  | 'file'
  | 'contact'
  | 'company'
  | 'invoice'
  | 'payment'
  | 'budget'
  | 'estimate'
  | 'commitment'
  | 'bid_package'
  | 'change_order'
  | 'contract'
  | 'proposal'
  | 'rfi'
  | 'submittal'
  | 'drawing_set'
  | 'drawing_sheet'
  | 'daily_log'
  | 'punch_item'
  | 'schedule_item'
  | 'photo'
  | 'portal_access'
  | 'payable'
  | 'expense'
  | 'pay_application'
  | 'prospect'
  | 'meeting'
  | 'transmittal'
  | 'inspection'
  | 'safety_incident'
  | 'observation'
  | 'budget_transfer'
  | 'prequalification'
  | 'spec_section'
  | 'certified_payroll_report'
  | 'meeting_transcript'
  | 'project_location'

export type SearchEntityConfig = {
  table: string
  titleField: string
  subtitleFields?: string[]
  descriptionFields?: string[]
  searchableFields: string[]
  hrefTemplate: string
  filters?: Record<string, any>
  joins?: string[]
}

// Entity search configurations
export const SEARCH_CONFIGS: Record<SearchEntityType, SearchEntityConfig> = {
  project_location: {
    table: 'project_locations',
    titleField: 'full_path',
    subtitleFields: ['name'],
    searchableFields: ['name', 'full_path'],
    hrefTemplate: '/projects/{project_id}',
    filters: { is_active: true },
  },
  meeting_transcript: {
    table: 'meeting_transcripts',
    titleField: 'source',
    subtitleFields: ['status', 'created_at'],
    descriptionFields: ['transcript_text'],
    searchableFields: ['transcript_text', 'source', 'status'],
    hrefTemplate: '/projects/{project_id}/meetings?meeting={meeting_id}',
  },
  certified_payroll_report: {
    table: 'certified_payroll_reports',
    titleField: 'week_ending',
    subtitleFields: ['payroll_number', 'status'],
    searchableFields: ['week_ending', 'status'],
    hrefTemplate: '/projects/{project_id}/time/certified-payroll?report={id}',
  },
  spec_section: {
    table: 'spec_sections',
    titleField: 'title',
    subtitleFields: ['section_number', 'division'],
    searchableFields: ['title', 'section_number', 'division'],
    hrefTemplate: '/projects/{project_id}/specs?section={id}',
  },
  budget_transfer: {
    table: 'budget_transfers',
    titleField: 'reason',
    subtitleFields: ['transfer_number', 'status'],
    searchableFields: ['reason'],
    hrefTemplate: '/projects/{project_id}/financials/budget',
  },
  prequalification: {
    table: 'prequalifications',
    titleField: 'status',
    subtitleFields: ['expires_at'],
    descriptionFields: ['review_notes'],
    searchableFields: ['status', 'review_notes', 'trades'],
    hrefTemplate: '/companies/{company_id}',
  },
  meeting: {
    table: 'meetings',
    titleField: 'title',
    subtitleFields: ['series', 'meeting_number', 'status'],
    searchableFields: ['title', 'location'],
    hrefTemplate: '/projects/{project_id}/meetings?meeting={id}',
  },
  transmittal: {
    table: 'transmittals',
    titleField: 'subject',
    subtitleFields: ['transmittal_number', 'purpose'],
    descriptionFields: ['notes'],
    searchableFields: ['subject', 'notes', 'purpose'],
    hrefTemplate: '/projects/{project_id}/transmittals',
  },
  inspection: {
    table: 'inspections',
    titleField: 'title',
    subtitleFields: ['inspection_number', 'kind', 'status', 'result'],
    descriptionFields: ['notes'],
    searchableFields: ['title', 'location', 'notes'],
    hrefTemplate: '/projects/{project_id}/inspections?inspection={id}',
  },
  safety_incident: {
    table: 'safety_incidents',
    titleField: 'description',
    subtitleFields: ['incident_number', 'severity', 'status'],
    searchableFields: ['description', 'location', 'involved_person_name'],
    hrefTemplate: '/projects/{project_id}/safety',
  },
  observation: {
    table: 'observations',
    titleField: 'description',
    subtitleFields: ['observation_number', 'kind', 'category', 'status'],
    searchableFields: ['description', 'location'],
    hrefTemplate: '/projects/{project_id}/safety?tab=observations',
  },
  project: {
    table: 'projects',
    titleField: 'name',
    subtitleFields: ['status'],
    descriptionFields: ['description'],
    searchableFields: ['name', 'description'],
    hrefTemplate: '/projects/{id}',
  },
  task: {
    table: 'tasks',
    titleField: 'title',
    subtitleFields: ['status', 'priority'],
    descriptionFields: ['description'],
    searchableFields: ['title', 'description'],
    hrefTemplate: '/tasks/{id}',
    joins: ['LEFT JOIN projects p ON t.project_id = p.id'],
  },
  file: {
    table: 'files',
    titleField: 'file_name',
    subtitleFields: ['category', 'size_bytes'],
    descriptionFields: ['description'],
    searchableFields: ['file_name', 'description', 'tags', 'metadata'],
    hrefTemplate: '/files/{id}',
    joins: ['LEFT JOIN projects p ON f.project_id = p.id'],
  },
  contact: {
    table: 'contacts',
    titleField: 'full_name',
    subtitleFields: ['email', 'role'],
    searchableFields: ['full_name', 'email', 'phone', 'role'],
    hrefTemplate: '/contacts/{id}',
    joins: ['LEFT JOIN companies c ON contacts.primary_company_id = c.id'],
  },
  company: {
    table: 'companies',
    titleField: 'name',
    subtitleFields: ['company_type', 'email'],
    searchableFields: ['name', 'email', 'phone', 'website'],
    hrefTemplate: '/companies/{id}',
  },
  pay_application: {
    table: 'pay_applications',
    titleField: 'application_number',
    subtitleFields: ['status', 'period_end', 'current_payment_due_cents'],
    searchableFields: ['status'],
    hrefTemplate: '/projects/{project_id}/financials/receivables?tab=payapps',
    joins: ['LEFT JOIN projects p ON pa.project_id = p.id'],
  },
  invoice: {
    table: 'invoices',
    titleField: 'title',
    subtitleFields: ['invoice_number', 'status', 'total_cents'],
    searchableFields: ['title', 'invoice_number', 'notes'],
    hrefTemplate: '/projects/{project_id}/financials/receivables?invoice={id}',
    joins: ['LEFT JOIN projects p ON i.project_id = p.id'],
  },
  payment: {
    table: 'payments',
    titleField: 'reference',
    subtitleFields: ['amount_cents', 'method', 'status'],
    searchableFields: ['reference', 'method'],
    hrefTemplate: '/payments/{id}',
    joins: ['LEFT JOIN projects p ON pay.project_id = p.id'],
  },
  budget: {
    table: 'budgets',
    titleField: 'id',
    subtitleFields: ['status', 'total_cents'],
    searchableFields: ['status'],
    hrefTemplate: '/budgets/{id}',
    joins: ['LEFT JOIN projects p ON b.project_id = p.id'],
  },
  estimate: {
    table: 'estimates',
    titleField: 'title',
    subtitleFields: ['status', 'total_cents'],
    searchableFields: ['title', 'status'],
    hrefTemplate: '/estimates/{id}',
    joins: ['LEFT JOIN projects p ON e.project_id = p.id'],
  },
  commitment: {
    table: 'commitments',
    titleField: 'title',
    subtitleFields: ['status', 'total_cents'],
    searchableFields: ['title', 'external_reference'],
    hrefTemplate: '/commitments/{id}',
    joins: ['LEFT JOIN projects p ON c.project_id = p.id'],
  },
  bid_package: {
    // Packages live on a project OR a pipeline prospect; reindexEntity resolves
    // the correct workbench href (project vs. prospect) at index time.
    table: 'bid_packages',
    titleField: 'title',
    subtitleFields: ['trade', 'status'],
    descriptionFields: ['scope'],
    searchableFields: ['title', 'trade', 'scope', 'instructions'],
    hrefTemplate: '/projects/{project_id}/bids/{id}',
  },
  change_order: {
    table: 'change_orders',
    titleField: 'title',
    subtitleFields: ['status', 'total_cents'],
    descriptionFields: ['description', 'reason'],
    searchableFields: ['title', 'description', 'reason', 'summary'],
    hrefTemplate: '/change-orders/{id}',
    joins: ['LEFT JOIN projects p ON co.project_id = p.id'],
  },
  contract: {
    table: 'contracts',
    titleField: 'title',
    subtitleFields: ['status', 'number', 'total_cents'],
    searchableFields: ['title', 'number', 'terms'],
    hrefTemplate: '/contracts/{id}',
    joins: ['LEFT JOIN projects p ON con.project_id = p.id'],
  },
  proposal: {
    table: 'proposals',
    titleField: 'title',
    subtitleFields: ['status', 'number', 'total_cents'],
    descriptionFields: ['summary', 'terms'],
    searchableFields: ['title', 'number', 'summary', 'terms'],
    hrefTemplate: '/signatures',
    joins: ['LEFT JOIN projects p ON prop.project_id = p.id'],
  },
  rfi: {
    table: 'rfis',
    titleField: 'subject',
    subtitleFields: ['rfi_number', 'status'],
    descriptionFields: ['question'],
    searchableFields: ['subject', 'question', 'drawing_reference', 'spec_reference', 'location'],
    hrefTemplate: '/rfis/{id}',
    joins: ['LEFT JOIN projects p ON r.project_id = p.id'],
  },
  submittal: {
    table: 'submittals',
    titleField: 'title',
    subtitleFields: ['submittal_number', 'status'],
    descriptionFields: ['description'],
    searchableFields: ['title', 'description', 'spec_section'],
    hrefTemplate: '/submittals/{id}',
    joins: ['LEFT JOIN projects p ON s.project_id = p.id'],
  },
  drawing_set: {
    table: 'drawing_sets',
    titleField: 'title',
    subtitleFields: ['status'],
    descriptionFields: ['description'],
    searchableFields: ['title', 'description'],
    hrefTemplate: '/drawings/sets/{id}',
    joins: ['LEFT JOIN projects p ON ds.project_id = p.id'],
  },
  drawing_sheet: {
    table: 'drawing_sheets',
    titleField: 'sheet_title',
    subtitleFields: ['sheet_number', 'discipline'],
    searchableFields: ['sheet_title', 'sheet_number', 'discipline'],
    hrefTemplate: '/drawings/sheets/{id}',
    joins: ['LEFT JOIN drawing_sets ds ON ds_sheet.drawing_set_id = ds.id', 'LEFT JOIN projects p ON ds.project_id = p.id'],
  },
  daily_log: {
    table: 'daily_logs',
    titleField: 'summary',
    subtitleFields: ['log_date'],
    searchableFields: ['summary'],
    hrefTemplate: '/daily-logs/{id}',
    joins: ['LEFT JOIN projects p ON dl.project_id = p.id'],
  },
  punch_item: {
    table: 'punch_items',
    titleField: 'title',
    subtitleFields: ['status', 'severity'],
    descriptionFields: ['description', 'location'],
    searchableFields: ['title', 'description', 'location'],
    hrefTemplate: '/punch-items/{id}',
    joins: ['LEFT JOIN projects p ON pi.project_id = p.id'],
  },
  schedule_item: {
    table: 'schedule_items',
    titleField: 'name',
    subtitleFields: ['status', 'phase'],
    searchableFields: ['name', 'phase', 'trade', 'location'],
    hrefTemplate: '/schedule/{id}',
    joins: ['LEFT JOIN projects p ON si.project_id = p.id'],
  },
  photo: {
    table: 'photos',
    titleField: 'id',
    subtitleFields: ['taken_at'],
    searchableFields: ['tags'],
    hrefTemplate: '/photos/{id}',
    joins: ['LEFT JOIN projects p ON ph.project_id = p.id'],
  },
  portal_access: {
    table: 'portal_access_tokens',
    titleField: 'id',
    subtitleFields: ['portal_type'],
    searchableFields: [],
    hrefTemplate: '/portal-access/{id}',
    joins: ['LEFT JOIN projects p ON pat.project_id = p.id'],
  },
  payable: {
    table: 'vendor_bills',
    titleField: 'bill_number',
    subtitleFields: ['status', 'total_cents'],
    searchableFields: ['bill_number', 'status'],
    hrefTemplate: '/projects/{project_id}/financials/payables?bill={id}',
    joins: ['LEFT JOIN projects p ON payable.project_id = p.id'],
  },
  expense: {
    table: 'project_expenses',
    titleField: 'description',
    subtitleFields: ['status', 'amount_cents', 'vendor_name_text'],
    searchableFields: ['description', 'vendor_name_text', 'status'],
    hrefTemplate: '/projects/{project_id}/expenses?expense={id}',
    joins: ['LEFT JOIN projects p ON expense.project_id = p.id'],
  },
  prospect: {
    table: 'prospects',
    titleField: 'name',
    subtitleFields: ['status', 'project_type'],
    searchableFields: ['name', 'status', 'project_type', 'notes'],
    hrefTemplate: '/pipeline?prospectId={id}',
  },
}

// Entity types that carry a project_id column. Org-level entities
// (contact, company, prospect) and project itself are excluded.
export const PROJECT_SCOPED_ENTITY_TYPES = new Set<SearchEntityType>([
  "task",
  "file",
  "invoice",
  "payment",
  "budget",
  "estimate",
  "commitment",
  "bid_package",
  "change_order",
  "contract",
  "proposal",
  "rfi",
  "submittal",
  "drawing_set",
  "drawing_sheet",
  "daily_log",
  "punch_item",
  "schedule_item",
  "photo",
  "portal_access",
  "payable",
  "expense",
  "pay_application",
  "spec_section",
  "certified_payroll_report",
  "meeting_transcript",
  "project_location",
])

// Builds a PostgREST select clause limited to the fields needed to render and
// index a result. Only project-scoped tables get project_id / projects(name);
// org-level entities (contacts, companies, prospects) have no project_id column
// and selecting it would 42703.
export function buildEntitySelectClause(
  entityType: SearchEntityType,
  config: SearchEntityConfig,
  includeProject: boolean,
) {
  const fields = new Set<string>(["id", "created_at", "updated_at", config.titleField])
  if (includeProject) fields.add("project_id")
  for (const field of config.subtitleFields ?? []) fields.add(field)
  for (const field of config.descriptionFields ?? []) fields.add(field)
  for (const field of config.searchableFields ?? []) fields.add(field)

  const baseSelect = Array.from(fields).join(",")
  return includeProject && entityType !== "project" ? `${baseSelect},projects(name)` : baseSelect
}
