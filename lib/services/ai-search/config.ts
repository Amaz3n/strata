import "server-only"

import type { SearchEntityType } from "@/lib/services/search"

type CountQueryConfig = {
  table: string
  searchableFields: string[]
}

type AnalyticsEntityConfig = {
  table: string
  titleField: string
  searchableFields: string[]
  statusField?: string
  amountField?: string
  projectIdField?: string
  createdAtField?: string
  dueDateField?: string
}

type EntityAttributeFieldConfig = {
  key: string
  label: string
  aliases: RegExp[]
  extract: (row: Record<string, unknown>) => string | null
}

type EntityAttributeConfig = {
  table: string
  titleField: string
  rowSelect: string
  defaultFieldKey?: string
  fields: EntityAttributeFieldConfig[]
}

function toStatusLabel(status: string) {
  return status.replace(/_/g, " ")
}

type EntityIntentDefinition = {
  type: SearchEntityType
  label: string
  tokens: string[]
  aliases: RegExp[]
}

export const ENTITY_INTENTS: EntityIntentDefinition[] = [
  { type: "change_order", label: "change order", tokens: ["change", "order", "change_order", "co"], aliases: [/\bchange orders?\b/, /\bcos?\b/] },
  { type: "drawing_sheet", label: "drawing sheet", tokens: ["drawing", "sheet", "drawing_sheet"], aliases: [/\bdrawing sheets?\b/, /\bsheets?\b/] },
  { type: "drawing_set", label: "drawing set", tokens: ["drawing", "set", "drawing_set"], aliases: [/\bdrawing sets?\b/, /\bsets?\b/] },
  { type: "daily_log", label: "daily log", tokens: ["daily", "log", "daily_log"], aliases: [/\bdaily logs?\b/] },
  { type: "punch_item", label: "punch item", tokens: ["punch", "item", "punch_item"], aliases: [/\bpunch items?\b/, /\bpunch list\b/] },
  { type: "schedule_item", label: "schedule item", tokens: ["schedule", "item", "schedule_item", "milestone"], aliases: [/\bschedule items?\b/, /\bmilestones?\b/, /\bschedule\b/] },
  { type: "portal_access", label: "portal link", tokens: ["portal", "access", "token", "link"], aliases: [/\bportal access\b/, /\bportal links?\b/, /\baccess tokens?\b/] },
  { type: "submittal", label: "submittal", tokens: ["submittal"], aliases: [/\bsubmittals?\b/] },
  { type: "invoice", label: "invoice", tokens: ["invoice"], aliases: [/\binvoices?\b/] },
  { type: "payment", label: "payment", tokens: ["payment"], aliases: [/\bpayments?\b/] },
  { type: "budget", label: "budget", tokens: ["budget"], aliases: [/\bbudgets?\b/] },
  { type: "estimate", label: "estimate", tokens: ["estimate"], aliases: [/\bestimates?\b/] },
  { type: "commitment", label: "commitment", tokens: ["commitment"], aliases: [/\bcommitments?\b/] },
  { type: "contract", label: "contract", tokens: ["contract", "agreement"], aliases: [/\bcontracts?\b/, /\bagreements?\b/] },
  { type: "proposal", label: "proposal", tokens: ["proposal"], aliases: [/\bproposals?\b/] },
  { type: "rfi", label: "rfi", tokens: ["rfi"], aliases: [/\brfis?\b/] },
  { type: "task", label: "task", tokens: ["task", "todo"], aliases: [/\btasks?\b/, /\bto-?dos?\b/, /\baction items?\b/] },
  { type: "project", label: "project", tokens: ["project", "job"], aliases: [/\bprojects?\b/, /\bprojets?\b/, /\bjobs?\b/] },
  { type: "file", label: "file", tokens: ["file", "document", "doc"], aliases: [/\bfiles?\b/, /\bdocuments?\b/, /\bdocs?\b/] },
  { type: "contact", label: "contact", tokens: ["contact", "people"], aliases: [/\bcontacts?\b/, /\bpeople\b/] },
  { type: "company", label: "company", tokens: ["company", "vendor"], aliases: [/\bcompanies?\b/, /\bvendors?\b/] },
  { type: "photo", label: "photo", tokens: ["photo", "image"], aliases: [/\bphotos?\b/, /\bimages?\b/] },
  { type: "project_location", label: "project location", tokens: ["location", "area", "floor"], aliases: [/\bproject locations?\b/, /\bjob locations?\b/, /\bbuilding areas?\b/] },
]

export const ENTITY_STATUS_VALUES: Partial<Record<SearchEntityType, string[]>> = {
  project: ["planning", "active", "bidding", "on_hold", "completed", "cancelled"],
  task: ["todo", "in_progress", "blocked", "done"],
  invoice: ["draft", "saved", "sent", "partial", "paid", "overdue", "void"],
  rfi: ["open", "pending", "answered", "closed"],
  submittal: ["pending", "open", "approved", "rejected", "closed"],
  schedule_item: ["planned", "in_progress", "at_risk", "blocked", "completed", "cancelled"],
  punch_item: ["open", "in_progress", "resolved", "closed"],
}

export const COUNT_QUERY_CONFIGS: Partial<Record<SearchEntityType, CountQueryConfig>> = {
  project: { table: "projects", searchableFields: ["name", "description"] },
  task: { table: "tasks", searchableFields: ["title", "description"] },
  file: { table: "files", searchableFields: ["file_name", "description"] },
  contact: { table: "contacts", searchableFields: ["full_name", "email", "phone", "role"] },
  company: { table: "companies", searchableFields: ["name", "email", "phone", "website"] },
  invoice: { table: "invoices", searchableFields: ["title", "invoice_number", "notes"] },
  payment: { table: "payments", searchableFields: ["reference", "method"] },
  budget: { table: "budgets", searchableFields: ["status"] },
  estimate: { table: "estimates", searchableFields: ["title", "status"] },
  commitment: { table: "commitments", searchableFields: ["title", "external_reference"] },
  change_order: { table: "change_orders", searchableFields: ["title", "description", "reason", "summary"] },
  contract: { table: "contracts", searchableFields: ["title", "number", "terms"] },
  proposal: { table: "proposals", searchableFields: ["title", "number", "summary", "terms"] },
  rfi: { table: "rfis", searchableFields: ["subject", "question", "drawing_reference", "spec_reference", "location"] },
  submittal: { table: "submittals", searchableFields: ["title", "description", "spec_section"] },
  drawing_set: { table: "drawing_sets", searchableFields: ["title", "description"] },
  drawing_sheet: { table: "drawing_sheets", searchableFields: ["sheet_title", "sheet_number", "discipline"] },
  daily_log: { table: "daily_logs", searchableFields: ["summary"] },
  punch_item: { table: "punch_items", searchableFields: ["title", "description", "location"] },
  schedule_item: { table: "schedule_items", searchableFields: ["name", "phase", "trade", "location"] },
  photo: { table: "photos", searchableFields: ["tags"] },
  portal_access: { table: "portal_access_tokens", searchableFields: [] },
  project_location: { table: "project_locations", searchableFields: ["name", "full_path"] },
}

export const ANALYTICS_ENTITY_CONFIGS: Partial<Record<SearchEntityType, AnalyticsEntityConfig>> = {
  project: { table: "projects", titleField: "name", searchableFields: ["name", "description"], statusField: "status", createdAtField: "created_at" },
  task: { table: "tasks", titleField: "title", searchableFields: ["title", "description"], statusField: "status", projectIdField: "project_id", createdAtField: "created_at" },
  file: { table: "files", titleField: "file_name", searchableFields: ["file_name", "description"], projectIdField: "project_id", createdAtField: "created_at" },
  invoice: { table: "invoices", titleField: "title", searchableFields: ["title", "invoice_number", "notes"], statusField: "status", amountField: "total_cents", projectIdField: "project_id", createdAtField: "created_at", dueDateField: "due_date" },
  payment: { table: "payments", titleField: "reference", searchableFields: ["reference", "method"], statusField: "status", amountField: "amount_cents", projectIdField: "project_id", createdAtField: "created_at" },
  budget: { table: "budgets", titleField: "id", searchableFields: ["status"], statusField: "status", amountField: "total_cents", projectIdField: "project_id", createdAtField: "created_at" },
  estimate: { table: "estimates", titleField: "title", searchableFields: ["title", "status"], statusField: "status", amountField: "total_cents", projectIdField: "project_id", createdAtField: "created_at" },
  commitment: { table: "commitments", titleField: "title", searchableFields: ["title", "external_reference"], statusField: "status", amountField: "total_cents", projectIdField: "project_id", createdAtField: "created_at" },
  change_order: { table: "change_orders", titleField: "title", searchableFields: ["title", "description", "reason", "summary"], statusField: "status", amountField: "total_cents", projectIdField: "project_id", createdAtField: "created_at" },
  contract: { table: "contracts", titleField: "title", searchableFields: ["title", "number", "terms"], statusField: "status", amountField: "total_cents", projectIdField: "project_id", createdAtField: "created_at" },
  proposal: { table: "proposals", titleField: "title", searchableFields: ["title", "number", "summary", "terms"], statusField: "status", amountField: "total_cents", projectIdField: "project_id", createdAtField: "created_at" },
  rfi: { table: "rfis", titleField: "subject", searchableFields: ["subject", "question", "drawing_reference", "spec_reference", "location"], statusField: "status", projectIdField: "project_id", createdAtField: "created_at" },
  submittal: { table: "submittals", titleField: "title", searchableFields: ["title", "description", "spec_section"], statusField: "status", projectIdField: "project_id", createdAtField: "created_at" },
  drawing_set: { table: "drawing_sets", titleField: "title", searchableFields: ["title", "description"], statusField: "status", projectIdField: "project_id", createdAtField: "created_at" },
  daily_log: { table: "daily_logs", titleField: "summary", searchableFields: ["summary"], projectIdField: "project_id", createdAtField: "created_at" },
  punch_item: { table: "punch_items", titleField: "title", searchableFields: ["title", "description", "location"], statusField: "status", projectIdField: "project_id", createdAtField: "created_at" },
  schedule_item: { table: "schedule_items", titleField: "name", searchableFields: ["name", "phase", "trade", "location"], statusField: "status", projectIdField: "project_id", createdAtField: "created_at" },
  photo: { table: "photos", titleField: "id", searchableFields: ["tags"], projectIdField: "project_id", createdAtField: "created_at" },
  project_location: { table: "project_locations", titleField: "full_path", searchableFields: ["name", "full_path"], projectIdField: "project_id", createdAtField: "created_at" },
}

export const STATUS_ALIASES: Array<{ pattern: RegExp; normalized: string }> = [
  { pattern: /\bin progress\b/, normalized: "in_progress" },
  { pattern: /\bon hold\b/, normalized: "on_hold" },
  { pattern: /\bat risk\b/, normalized: "at_risk" },
  { pattern: /\bto do\b/, normalized: "todo" },
  { pattern: /\bcanceled\b/, normalized: "cancelled" },
  { pattern: /\boverdue\b/, normalized: "overdue" },
  { pattern: /\bactive\b/, normalized: "active" },
  { pattern: /\bplanning\b/, normalized: "planning" },
  { pattern: /\bbidding\b/, normalized: "bidding" },
  { pattern: /\bcompleted\b/, normalized: "completed" },
  { pattern: /\bcancelled\b/, normalized: "cancelled" },
  { pattern: /\btodo\b/, normalized: "todo" },
  { pattern: /\bblocked\b/, normalized: "blocked" },
  { pattern: /\bdone\b/, normalized: "done" },
  { pattern: /\bdraft\b/, normalized: "draft" },
  { pattern: /\bsent\b/, normalized: "sent" },
  { pattern: /\bpaid\b/, normalized: "paid" },
  { pattern: /\bvoid\b/, normalized: "void" },
  { pattern: /\bopen\b/, normalized: "open" },
  { pattern: /\bpending\b/, normalized: "pending" },
  { pattern: /\bapproved\b/, normalized: "approved" },
  { pattern: /\brejected\b/, normalized: "rejected" },
  { pattern: /\bresolved\b/, normalized: "resolved" },
  { pattern: /\banswered\b/, normalized: "answered" },
]

export const BASE_ENTITY_TYPES: SearchEntityType[] = ["project", "start_package", "house_plan", "budget_template", "selection_option", "design_studio_appointment", "task", "file", "contact", "company"]
export const FINANCIAL_ENTITY_TYPES: SearchEntityType[] = [
  "price_agreement",
  "commitment_change_order",
  "invoice",
  "payment",
  "budget",
  "estimate",
  "commitment",
  "change_order",
  "contract",
  "proposal",
  "pay_application",
  "certified_payroll_report",
]
export const DOCUMENT_ENTITY_TYPES: SearchEntityType[] = ["rfi", "submittal", "spec_section", "meeting", "meeting_transcript", "transmittal", "drawing_set", "drawing_sheet", "file"]
export const FIELD_ENTITY_TYPES: SearchEntityType[] = ["task", "schedule_item", "daily_log", "punch_item", "photo", "inspection", "safety_incident", "observation", "project_location"]
export const ENTITY_HREF_FALLBACKS: Record<SearchEntityType, string> = {
  warranty_request: "/warranty?request={id}",
  warranty_backcharge: "/warranty?backcharge={id}",
  closing: "/projects/{project_id}/closing",
  start_package: "/starts/pipeline/{id}",
  price_agreement: "/purchasing?tab=price-book&agreement={id}",
  commitment_change_order: "/projects/{project_id}/financials/budget?vpo={id}",
  selection_option: "/design-studio?option={id}",
  design_studio_appointment: "/design-studio?tab=appointments&appointment={id}",
  community: "/communities/{id}",
  lot: "/communities/{community_id}?lot={id}",
  house_plan: "/plans/{id}",
  budget_template: "/settings/templates?budgetTemplate={id}",
  project: "/projects/{id}",
  task: "/tasks/{id}",
  file: "/files/{id}",
  contact: "/contacts/{id}",
  company: "/companies/{id}",
  invoice: "/projects/{project_id}/financials/receivables?invoice={id}",
  payment: "/payments/{id}",
  budget: "/budgets/{id}",
  estimate: "/estimates/{id}",
  commitment: "/commitments/{id}",
  bid_package: "/projects/{project_id}/bids/{id}",
  change_order: "/change-orders/{id}",
  contract: "/contracts/{id}",
  proposal: "/signatures",
  pay_application: "/projects/{project_id}/financials/receivables?payApp={id}",
  rfi: "/rfis/{id}",
  submittal: "/submittals/{id}",
  meeting: "/projects/{project_id}/meetings?meeting={id}",
  meeting_transcript: "/projects/{project_id}/meetings?meeting={meeting_id}",
  transmittal: "/projects/{project_id}/transmittals",
  drawing_set: "/drawings/sets/{id}",
  drawing_sheet: "/drawings/sheets/{id}",
  daily_log: "/daily-logs/{id}",
  punch_item: "/punch-items/{id}",
  schedule_item: "/schedule/{id}",
  photo: "/photos/{id}",
  portal_access: "/portal-access/{id}",
  payable: "/projects/{project_id}/financials/payables?bill={id}",
  expense: "/projects/{project_id}/expenses?expense={id}",
  prospect: "/pipeline?prospectId={id}",
  inspection: "/projects/{project_id}/inspections?inspection={id}",
  safety_incident: "/projects/{project_id}/safety",
  observation: "/projects/{project_id}/safety?tab=observations",
  budget_transfer: "/projects/{project_id}/financials/budget",
  prequalification: "/companies/{company_id}",
  spec_section: "/projects/{project_id}/specs?section={id}",
  certified_payroll_report: "/projects/{project_id}/time/certified-payroll?report={id}",
  project_location: "/projects/{project_id}",
}
export const ENTITY_SEMANTIC_FALLBACKS: Partial<Record<SearchEntityType, SearchEntityType[]>> = {
  contract: ["commitment", "proposal", "change_order"],
  commitment: ["contract", "proposal"],
  proposal: ["contract", "commitment"],
  invoice: ["payment", "commitment"],
  payment: ["invoice", "commitment"],
}
export const PROJECT_NAME_NOISE_TOKENS = new Set([
  "a",
  "an",
  "and",
  "at",
  "for",
  "from",
  "in",
  "job",
  "of",
  "on",
  "project",
  "the",
  "to",
  "with",
])

export const ATTRIBUTE_TARGET_NOISE_TOKENS = new Set([
  "the",
  "a",
  "an",
  "what",
  "whats",
  "what's",
  "is",
  "are",
  "show",
  "give",
  "tell",
  "me",
  "please",
  "named",
  "called",
  "project",
  "projects",
  "job",
  "jobs",
  "company",
  "companies",
  "vendor",
  "vendors",
  "contact",
  "contacts",
  "person",
  "people",
])

export function normalizeAttributeScalar(value: unknown) {
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toLocaleString()
  }
  return null
}

function formatIsoLikeDate(value: unknown) {
  if (typeof value !== "string" || value.trim().length === 0) return null
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) {
    return value.trim()
  }
  return date.toISOString().slice(0, 10)
}

function formatAddressLikeValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null

  const record = value as Record<string, unknown>
  const direct = normalizeAttributeScalar(record.address) ?? normalizeAttributeScalar(record.formatted)
  if (direct) return direct

  const line1 = normalizeAttributeScalar(record.street1) ?? normalizeAttributeScalar(record.street)
  const line2 = normalizeAttributeScalar(record.street2)
  const city = normalizeAttributeScalar(record.city)
  const state = normalizeAttributeScalar(record.state)
  const postal = normalizeAttributeScalar(record.postal_code) ?? normalizeAttributeScalar(record.zip)

  const locality = [city, state].filter((part): part is string => Boolean(part)).join(", ")
  const localityWithPostal = [locality, postal].filter((part): part is string => Boolean(part)).join(" ")
  const parts = [line1, line2, localityWithPostal].filter((part): part is string => Boolean(part))
  if (parts.length === 0) return null
  return parts.join(", ")
}

export const ENTITY_ATTRIBUTE_CONFIGS: Partial<Record<SearchEntityType, EntityAttributeConfig>> = {
  project: {
    table: "projects",
    titleField: "name",
    rowSelect: "id,name,location,status,start_date,end_date,total_value,description,updated_at,created_at",
    defaultFieldKey: "address",
    fields: [
      {
        key: "address",
        label: "address",
        aliases: [/\b(address|location|jobsite|site address)\b/i],
        extract: (row) => formatAddressLikeValue(row.location),
      },
      {
        key: "status",
        label: "status",
        aliases: [/\bstatus\b/i],
        extract: (row) => {
          const status = normalizeAttributeScalar(row.status)
          return status ? toStatusLabel(status) : null
        },
      },
      {
        key: "start_date",
        label: "start date",
        aliases: [/\b(start date|start)\b/i, /\bkickoff\b/i],
        extract: (row) => formatIsoLikeDate(row.start_date),
      },
      {
        key: "end_date",
        label: "end date",
        aliases: [/\b(end date|finish date|completion date|target completion)\b/i],
        extract: (row) => formatIsoLikeDate(row.end_date),
      },
      {
        key: "total_value",
        label: "total value",
        aliases: [/\b(total value|project value|contract value|value)\b/i],
        extract: (row) => normalizeAttributeScalar(row.total_value),
      },
      {
        key: "description",
        label: "description",
        aliases: [/\b(description|scope|summary)\b/i],
        extract: (row) => normalizeAttributeScalar(row.description),
      },
    ],
  },
  company: {
    table: "companies",
    titleField: "name",
    rowSelect: "id,name,address,email,phone,website,company_type,updated_at,created_at",
    defaultFieldKey: "address",
    fields: [
      {
        key: "address",
        label: "address",
        aliases: [/\b(address|location|hq|headquarters)\b/i],
        extract: (row) => formatAddressLikeValue(row.address),
      },
      {
        key: "email",
        label: "email",
        aliases: [/\b(email|e-mail)\b/i],
        extract: (row) => normalizeAttributeScalar(row.email),
      },
      {
        key: "phone",
        label: "phone",
        aliases: [/\b(phone|telephone|cell|mobile)\b/i],
        extract: (row) => normalizeAttributeScalar(row.phone),
      },
      {
        key: "website",
        label: "website",
        aliases: [/\b(website|url|site)\b/i],
        extract: (row) => normalizeAttributeScalar(row.website),
      },
      {
        key: "company_type",
        label: "company type",
        aliases: [/\b(type|category)\b/i],
        extract: (row) => normalizeAttributeScalar(row.company_type),
      },
    ],
  },
  contact: {
    table: "contacts",
    titleField: "full_name",
    rowSelect: "id,full_name,email,phone,role,address,updated_at,created_at",
    fields: [
      {
        key: "address",
        label: "address",
        aliases: [/\b(address|location)\b/i],
        extract: (row) => formatAddressLikeValue(row.address),
      },
      {
        key: "email",
        label: "email",
        aliases: [/\b(email|e-mail)\b/i],
        extract: (row) => normalizeAttributeScalar(row.email),
      },
      {
        key: "phone",
        label: "phone",
        aliases: [/\b(phone|telephone|cell|mobile)\b/i],
        extract: (row) => normalizeAttributeScalar(row.phone),
      },
      {
        key: "role",
        label: "role",
        aliases: [/\b(role|title|position)\b/i],
        extract: (row) => normalizeAttributeScalar(row.role),
      },
    ],
  },
}
