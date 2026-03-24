import "server-only"

import { randomUUID } from "node:crypto"

import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAI } from "@ai-sdk/openai"
import { generateText } from "ai"
import { getOrgAiSearchConfigFromContext, type AiProvider } from "@/lib/services/ai-config"
import {
  buildAiActionDraft,
  createAiSearchActionRequest,
  isAiActionToolKey,
  type AiSearchAction,
} from "@/lib/services/ai-search/actions"
import { getAiSearchRuntimeFlags, type AiSearchRuntimeFlags } from "@/lib/services/ai-search-flags"
import { formatAiToolCatalogForPrompt, getAiToolCatalog } from "@/lib/services/ai-search/tool-catalog"
import { executeAiToolInvocation, planAiToolInvocation } from "@/lib/services/ai-search/tools"
import { requireOrgContext } from "@/lib/services/context"
import { searchEntities, type SearchEntityType, type SearchResult } from "@/lib/services/search"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

export interface AiSearchCitation {
  sourceId: string
  id: string
  type: SearchEntityType
  title: string
  href: string
  subtitle?: string
  projectName?: string
  updatedAt?: string
}

export interface AiSearchRelatedResult {
  id: string
  type: SearchEntityType
  title: string
  href: string
  subtitle?: string
  description?: string
  projectName?: string
  updatedAt?: string
}

export type AiArtifactValue = string | number | null

export interface AiChartPoint {
  label: string
  value: number
}

export interface AiSearchArtifact {
  kind: "table" | "chart"
  datasetId: string
  title: string
  table?: {
    columns: string[]
    rows: AiArtifactValue[][]
  }
  chart?: {
    type: "bar"
    points: AiChartPoint[]
    valuePrefix?: string
    valueSuffix?: string
  }
}

export interface AiSearchExportLink {
  format: "csv" | "pdf"
  href: string
  label: string
}

export interface AiSearchTraceEvent {
  id: string
  status: "started" | "running" | "completed" | "warning"
  label: string
  detail?: string
  thought?: string
  timestamp: string
}

export interface AskAiSearchResponse {
  answer: string
  citations: AiSearchCitation[]
  relatedResults: AiSearchRelatedResult[]
  generatedAt: string
  assistantMode: "org" | "general"
  mode: "llm" | "fallback"
  provider?: AiProvider
  model?: string
  configSource?: "org" | "platform" | "env" | "default"
  confidence?: "low" | "medium" | "high"
  missingData?: string[]
  artifact?: AiSearchArtifact
  exports?: AiSearchExportLink[]
  actions?: AiSearchAction[]
  sessionId?: string
}

interface AskAiSearchOptions {
  limit?: number
  onTrace?: (event: AiSearchTraceEvent) => void | Promise<void>
  sessionId?: string
  mode?: "org" | "general"
}

type RetrievedSource = {
  sourceId: string
  result: SearchResult
}

type ParsedModelAnswer = {
  answer: string
  citation_ids: string[]
}

type LlmAnswer = {
  answer: string
  citationIds: string[]
  provider: AiProvider
  model: string
}

type QueryDomain = "org" | "general" | "social"
type QueryDomainConfidence = "low" | "medium" | "high"

type QueryDomainClassification = {
  domain: QueryDomain
  confidence: QueryDomainConfidence
  reason: string
}

type StructuredOperation = "list" | "count" | "list_and_count"

type StructuredIntent = {
  kind: "structured"
  operation: StructuredOperation
  entityType: SearchEntityType
  entityLabel: string
  entityTokens: string[]
  statuses: string[]
  textQuery: string
  limit: number
}

type AnalysisIntent = {
  kind: "analysis"
  operation: "analyze"
  entityTypes: SearchEntityType[]
  projectName?: string
  statuses: string[]
  textQuery: string
  limit: number
  includeFinancialRollup: boolean
}

type PlannedIntent = StructuredIntent | AnalysisIntent | AnalyticsIntent

type CountQueryConfig = {
  table: string
  searchableFields: string[]
}

type ProjectRef = {
  id: string
  name: string
}

type FinancialRollup = {
  project?: ProjectRef
  invoiceCount: number
  invoiceTotalCents: number
  paymentCount: number
  paymentTotalCents: number
  budgetCount: number
  budgetTotalCents: number
  estimateCount: number
  estimateTotalCents: number
  commitmentCount: number
  commitmentTotalCents: number
  changeOrderCount: number
  changeOrderTotalCents: number
}

type StatusBreakdownEntry = {
  status: string
  count: number
}

type StructuredExecution = {
  answer: string
  relatedResults: SearchResult[]
  totalCount: number | null
  statusBreakdown: StatusBreakdownEntry[]
}

type EntityAttributeIntent = {
  entityType: SearchEntityType
  fieldKey: string
  targetHint?: string
}

type EntityAttributeExecution = {
  answer: string
  relatedResult?: SearchResult
  confidence: "low" | "medium" | "high"
  missingData: string[]
}

type EntityAttributeCandidateResolution = {
  reason: "match" | "ambiguous" | "not_found"
  candidate?: SearchResult
  suggestions: SearchResult[]
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

type AnalyticsMetric = "count" | "sum_amount" | "avg_amount"
type AnalyticsGroupBy = "none" | "status" | "project" | "month"

type AnalyticsIntent = {
  kind: "analytics"
  operation: "aggregate"
  entityType: SearchEntityType
  metric: AnalyticsMetric
  groupBy: AnalyticsGroupBy
  statuses: string[]
  textQuery: string
  projectName?: string
  dateRangeDays?: number
  limit: number
}

type AnalyticsEntityConfig = {
  table: string
  titleField: string
  searchableFields: string[]
  statusField?: string
  amountField?: string
  projectIdField?: string
  createdAtField?: string
}

type AnalyticsRow = {
  id: string
  title: string
  status?: string
  amountCents?: number
  projectId?: string
  createdAt?: string
}

type AnalyticsBucket = {
  label: string
  count: number
  amountCents: number
  metricValue: number
}

type AnalyticsExecution = {
  answer: string
  entityLabel: string
  project?: ProjectRef | null
  rowCount: number
  metric: AnalyticsMetric
  groupBy: AnalyticsGroupBy
  buckets: AnalyticsBucket[]
  relatedResults: SearchResult[]
}

type QueryAgentOperation = "list" | "aggregate"

type QueryAgentPlan = {
  operation: QueryAgentOperation
  entityType: SearchEntityType
  relatedEntityTypes?: SearchEntityType[]
  metric: AnalyticsMetric
  groupBy: AnalyticsGroupBy
  statuses: string[]
  textQuery: string
  projectName?: string
  dateRangeDays?: number
  limit: number
}

type QueryAgentExecution = {
  answerFallback: string
  relatedResults: SearchResult[]
  rowCount: number
  additionalContext?: string
  artifactData: { artifact?: AiSearchArtifact; exports?: AiSearchExportLink[] }
  confidence: "low" | "medium" | "high"
  missingData: string[]
}

type QueryAgentStepExecution = {
  step: QueryAgentPlan
  execution: QueryAgentExecution
}

type CanonicalMetricKey =
  | "revenue_billed"
  | "cash_collected"
  | "open_ar"
  | "overdue_ar"
  | "budget_commitment_gap"

type CanonicalMetricIntent = {
  key: CanonicalMetricKey
  label: string
  projectName?: string
  dateRangeDays?: number
  groupBy: AnalyticsGroupBy
  limit: number
}

type CanonicalMetricExecution = {
  summary: string
  metricValue: number
  metricValueCents?: number
  rowCount: number
  relatedResults: SearchResult[]
  additionalContext: string
  artifactData: { artifact?: AiSearchArtifact; exports?: AiSearchExportLink[] }
  confidence: "low" | "medium" | "high"
  missingData: string[]
}

type GroundedAnswerVerification = {
  answer: string
  citationIds: string[]
  downgradedToFallback: boolean
  confidence: "low" | "medium" | "high"
  missingData: string[]
  notes: string[]
}

type SemanticSearchRow = {
  document_id: string
  entity_type: string
  entity_id: string
  project_id: string | null
  title: string | null
  metadata: Record<string, unknown> | null
  updated_at: string | null
  similarity: number
}

type GeneralAssistantAnswer = {
  answer: string
  provider: AiProvider
  model: string
}

export type AiSearchArtifactDataset = {
  id: string
  orgId: string
  title: string
  columns: string[]
  rows: AiArtifactValue[][]
  createdAt: string
}

type StoredArtifactRow = {
  id: string
  org_id: string
  title: string
  columns: string[] | null
  rows: unknown
  created_at: string
}

type EntityIntentDefinition = {
  type: SearchEntityType
  label: string
  tokens: string[]
  aliases: RegExp[]
}

const ENTITY_INTENTS: EntityIntentDefinition[] = [
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
  { type: "conversation", label: "conversation", tokens: ["conversation", "thread"], aliases: [/\bconversations?\b/, /\bthreads?\b/] },
  { type: "message", label: "message", tokens: ["message", "chat"], aliases: [/\bmessages?\b/, /\bchats?\b/] },
  { type: "rfi", label: "rfi", tokens: ["rfi"], aliases: [/\brfis?\b/] },
  { type: "task", label: "task", tokens: ["task", "todo"], aliases: [/\btasks?\b/, /\bto-?dos?\b/, /\baction items?\b/] },
  { type: "project", label: "project", tokens: ["project", "job"], aliases: [/\bprojects?\b/, /\bprojets?\b/, /\bjobs?\b/] },
  { type: "file", label: "file", tokens: ["file", "document", "doc"], aliases: [/\bfiles?\b/, /\bdocuments?\b/, /\bdocs?\b/] },
  { type: "contact", label: "contact", tokens: ["contact", "people"], aliases: [/\bcontacts?\b/, /\bpeople\b/] },
  { type: "company", label: "company", tokens: ["company", "vendor"], aliases: [/\bcompanies?\b/, /\bvendors?\b/] },
  { type: "photo", label: "photo", tokens: ["photo", "image"], aliases: [/\bphotos?\b/, /\bimages?\b/] },
]

const ENTITY_STATUS_VALUES: Partial<Record<SearchEntityType, string[]>> = {
  project: ["planning", "active", "bidding", "on_hold", "completed", "cancelled"],
  task: ["todo", "in_progress", "blocked", "done"],
  invoice: ["draft", "saved", "sent", "partial", "paid", "overdue", "void"],
  rfi: ["open", "pending", "answered", "closed"],
  submittal: ["pending", "open", "approved", "rejected", "closed"],
  schedule_item: ["planned", "in_progress", "at_risk", "blocked", "completed", "cancelled"],
  punch_item: ["open", "in_progress", "resolved", "closed"],
}

const COUNT_QUERY_CONFIGS: Partial<Record<SearchEntityType, CountQueryConfig>> = {
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
  conversation: { table: "conversations", searchableFields: ["subject"] },
  message: { table: "messages", searchableFields: ["body"] },
  rfi: { table: "rfis", searchableFields: ["subject", "question", "drawing_reference", "spec_reference", "location"] },
  submittal: { table: "submittals", searchableFields: ["title", "description", "spec_section"] },
  drawing_set: { table: "drawing_sets", searchableFields: ["title", "description"] },
  drawing_sheet: { table: "drawing_sheets", searchableFields: ["sheet_title", "sheet_number", "discipline"] },
  daily_log: { table: "daily_logs", searchableFields: ["summary"] },
  punch_item: { table: "punch_items", searchableFields: ["title", "description", "location"] },
  schedule_item: { table: "schedule_items", searchableFields: ["name", "phase", "trade", "location"] },
  photo: { table: "photos", searchableFields: ["tags"] },
  portal_access: { table: "portal_access_tokens", searchableFields: [] },
}

const ANALYTICS_ENTITY_CONFIGS: Partial<Record<SearchEntityType, AnalyticsEntityConfig>> = {
  project: { table: "projects", titleField: "name", searchableFields: ["name", "description"], statusField: "status", createdAtField: "created_at" },
  task: { table: "tasks", titleField: "title", searchableFields: ["title", "description"], statusField: "status", projectIdField: "project_id", createdAtField: "created_at" },
  file: { table: "files", titleField: "file_name", searchableFields: ["file_name", "description"], projectIdField: "project_id", createdAtField: "created_at" },
  invoice: { table: "invoices", titleField: "title", searchableFields: ["title", "invoice_number", "notes"], statusField: "status", amountField: "total_cents", projectIdField: "project_id", createdAtField: "created_at" },
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
}

const STATUS_ALIASES: Array<{ pattern: RegExp; normalized: string }> = [
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

const BASE_ENTITY_TYPES: SearchEntityType[] = ["project", "task", "file", "contact", "company"]
const FINANCIAL_ENTITY_TYPES: SearchEntityType[] = [
  "invoice",
  "payment",
  "budget",
  "estimate",
  "commitment",
  "change_order",
  "contract",
  "proposal",
]
const DOCUMENT_ENTITY_TYPES: SearchEntityType[] = ["rfi", "submittal", "drawing_set", "drawing_sheet", "file"]
const FIELD_ENTITY_TYPES: SearchEntityType[] = ["task", "schedule_item", "daily_log", "punch_item", "photo"]
const ENTITY_HREF_FALLBACKS: Record<SearchEntityType, string> = {
  project: "/projects/{id}",
  task: "/tasks/{id}",
  file: "/files/{id}",
  contact: "/contacts/{id}",
  company: "/companies/{id}",
  invoice: "/invoices/{id}",
  payment: "/payments/{id}",
  budget: "/budgets/{id}",
  estimate: "/estimates/{id}",
  commitment: "/commitments/{id}",
  change_order: "/change-orders/{id}",
  contract: "/contracts/{id}",
  proposal: "/proposals/{id}",
  conversation: "/conversations/{id}",
  message: "/messages/{id}",
  rfi: "/rfis/{id}",
  submittal: "/submittals/{id}",
  drawing_set: "/drawings/sets/{id}",
  drawing_sheet: "/drawings/sheets/{id}",
  daily_log: "/daily-logs/{id}",
  punch_item: "/punch-items/{id}",
  schedule_item: "/schedule/{id}",
  photo: "/photos/{id}",
  portal_access: "/portal-access/{id}",
}
const ENTITY_SEMANTIC_FALLBACKS: Partial<Record<SearchEntityType, SearchEntityType[]>> = {
  contract: ["commitment", "proposal", "change_order"],
  commitment: ["contract", "proposal"],
  proposal: ["contract", "commitment"],
  invoice: ["payment", "commitment"],
  payment: ["invoice", "commitment"],
}
const PROJECT_NAME_NOISE_TOKENS = new Set([
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

const ATTRIBUTE_TARGET_NOISE_TOKENS = new Set([
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

function normalizeAttributeScalar(value: unknown) {
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

const ENTITY_ATTRIBUTE_CONFIGS: Partial<Record<SearchEntityType, EntityAttributeConfig>> = {
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

const DEFAULT_LIMIT = 20
const MIN_LIMIT = 8
const MAX_LIMIT = 30
const MAX_CONTEXT_SOURCES = 12
const MAX_CITATIONS = 5
const CACHE_TTL_MS = 90_000
const ARTIFACT_CACHE_TTL_MS = 15 * 60_000
const ANALYTICS_BATCH_SIZE = 1_000
const MAX_ANALYTICS_ROWS_SOFT_LIMIT = 100_000
const MAX_ANALYTICS_RANGE_DAYS = 730
const REQUEST_TIMEOUT_MS = 12_000
const REQUIRE_LLM_FOR_AI_SEARCH = (() => {
  const raw = process.env.AI_SEARCH_REQUIRE_LLM?.trim().toLowerCase()
  if (!raw) return true
  if (raw === "true" || raw === "1" || raw === "yes" || raw === "on") return true
  if (raw === "false" || raw === "0" || raw === "no" || raw === "off") return false
  return true
})()
const AI_SEARCH_CACHE_VERSION = "2026-03-06-hybrid-multistep-v4"
const EMBEDDING_MODEL = process.env.AI_SEARCH_EMBEDDING_MODEL?.trim() || "text-embedding-3-small"
const EMBEDDING_INPUT_MAX_CHARS = 4_000
const MAX_EMBEDDING_BACKFILL_DOCS = 12
const SEMANTIC_RETRIEVAL_LIMIT = 24
const SEMANTIC_SKIP_LEXICAL_THRESHOLD = 10
const MAX_QUERY_LENGTH_CHARS = 1_200
const PLANNER_LOOP_MAX_ATTEMPTS = 3
const MEMORY_FACT_LIMIT = 6
const OPEN_INVOICE_STATUSES = ["sent", "partial", "overdue", "saved", "draft"] as const
const CANONICAL_METRIC_SIGNAL_RE =
  /\b(revenue|sales|income|cash|collected|received|accounts receivable|a\/r|ar|open ar|overdue ar|outstanding|budget|commitment)\b/i
const LLM_SYSTEM_PROMPT =
  "You are an org data assistant for builders. Only answer from provided sources. If evidence is weak, say what is missing. Return strict JSON with keys: answer (string), citation_ids (string[]). Keep answer concise and actionable."
const GENERAL_ASSISTANT_SYSTEM_PROMPT = `You are a helpful assistant for construction teams.
- You can answer broad questions, even when they are not about org records.
- Be direct, practical, and concise.
- If a question needs org-specific facts, say you cannot verify it without org data context.
- Do not fabricate org-specific details.
- Return plain text only.`
const QUERY_PLANNER_SYSTEM_PROMPT = `You are a query planner for org data tools.
Return strict JSON only with keys:
- operation: "list" | "count" | "list_and_count" | "analyze" | "aggregate" | "none"
- entityType: one of "project","task","file","contact","company","invoice","payment","budget","estimate","commitment","change_order","contract","proposal","conversation","message","rfi","submittal","drawing_set","drawing_sheet","daily_log","punch_item","schedule_item","photo","portal_access"
- entityTypes: array of entity types when operation is "analyze"
- statuses: string[]
- textQuery: string
- limit: number
- projectName: string
- includeFinancialRollup: boolean
- metric: "count" | "sum_amount" | "avg_amount"
- groupBy: "none" | "status" | "project" | "month"
- dateRangeDays: number

Rules:
- Convert natural language into one safe tool intent.
- Prefer "list" for requests that ask to show/list records.
- Prefer "count" for "how many"/count/total requests.
- Use "list_and_count" if user asks for both count and list.
- Use "analyze" for broad analytical questions (financial health, risk, trends, status summaries).
- Use "aggregate" for grouped/trended analytics (by project/status/month) or totals/averages.
- Use empty textQuery for broad requests like "list all projects".
- statuses must be lowercase snake_case when applicable.
- Infer entityType from semantics even if user doesn't use exact table words.
- Avoid operation "none" unless the question is unrelated to org data.
- If intent cannot be mapped to one entity, return operation "none".
`
const AGENT_QUERY_PLANNER_SYSTEM_PROMPT = `You are a semantic query planner for an org-scoped analytics assistant.
Return strict JSON only with keys:
- operation: "list" | "aggregate" | "none"
- entityType: one of "project","task","file","contact","company","invoice","payment","budget","estimate","commitment","change_order","contract","proposal","conversation","message","rfi","submittal","drawing_set","drawing_sheet","daily_log","punch_item","schedule_item","photo","portal_access"
- relatedEntityTypes: optional array of additional entity types for cross-domain analysis
- metric: "count" | "sum_amount" | "avg_amount"
- groupBy: "none" | "status" | "project" | "month"
- statuses: string[]
- textQuery: string
- projectName: string
- dateRangeDays: number
- limit: number

Rules:
- Plan for ONE entityType only.
- Use relatedEntityTypes for secondary entities when the question is cross-domain.
- Use "aggregate" for totals, values, averages, trends, or breakdowns.
- Use "list" for record lookup/open-ended listing requests.
- Keep textQuery empty unless specific keywords materially constrain matching.
- statuses must be lowercase snake_case when applicable.
- If question is unrelated to org data, return operation "none".`
const QUERY_DOMAIN_CLASSIFIER_SYSTEM_PROMPT = `Classify the user's question into one domain and return strict JSON only.
Schema:
{
  "domain": "org" | "general" | "social",
  "confidence": "low" | "medium" | "high",
  "reason": string
}

Definitions:
- org: question is about the user's company/workspace data, operations, performance, finances, approvals, projects, or anything that should be answered from internal records.
- general: question is external world knowledge or non-workspace information.
- social: greeting/small talk/chitchat.

Rules:
- Prefer "org" whenever there is plausible business-data intent, even without explicit table/entity names.
- Revenue/profit/cost/performance questions about "we/our/company/business" are "org".
- Keep reason short.
- Output JSON only, no markdown.`
const STRUCTURED_COUNT_HINT_RE = /\b(how many|count|number of|total)\b/
const STRUCTURED_LIST_HINT_RE = /\b(list|show|give me|display|what are|which)\b/
const NON_STRUCTURED_HINT_RE = /\b(summarize|summary|risk|compare|trend|forecast|analysis|analyze|why|how)\b/
const CLARIFICATION_TIME_RANGE_RE = /\b(last|past|this|next)\b/i
const CLARIFICATION_SCOPE_PRONOUN_RE = /\b(that|those|it|them|same|again)\b/i
const CROSS_DOMAIN_INTENT_RE = /\b(compare|versus|vs\b|across|between|against|correlate|relationship)\b/i
const ORG_CONTEXT_HINT_RE =
  /\b(my|our|project|projects|projet|projets|job|jobs|team|client|vendor|invoice|payment|budget|estimate|commitment|change order|proposal|contract|rfi|submittal|drawing|task|file|document|contact|company|schedule|daily log|punch)\b/i
const ORG_BUSINESS_METRIC_HINT_RE =
  /\b(revenue|profit|margin|expenses?|spend|costs?|sales|income|run rate|burn|forecast|cash(flow)?|arr|mrr|kpi|performance)\b/i
const ORG_SUBJECT_HINT_RE = /\b(my|our|we|us|company|business|org|organization|workspace|team)\b/i
const GENERAL_KNOWLEDGE_HINT_RE =
  /\b(weather|temperature|recipe|translate|capital of|exchange rate|stock price|crypto price|nba|nfl|mlb|epl|movie|song lyrics|history of|meaning of|define|who is|what is|when is|where is|explain|tell me about)\b/i
const SOCIAL_GREETING_RE = /^(hi|hello|hey|yo|sup|hola|good (morning|afternoon|evening)|what's up)\b/i
const SMALL_TALK_RE = /\b(how are you|who are you|what can you do|thanks|thank you|goodbye|bye)\b/i
const ASSISTANT_META_HINT_RE =
  /\b(model|llm|chat|assistant|system prompt|provider|engine|powering this chat|running locally|lm studio|openai-compatible)\b/i
const ASSISTANT_RUNTIME_INFO_RE =
  /\b(what|which)\b.*\b(model|llm|provider|engine)\b|\b(model|llm|provider|engine)\b.*\b(power|powering|powers|running|using|backing)\b|\bwhat\b.*\b(chat|assistant)\b.*\b(using|running|powered)\b/i
const GENERAL_QUESTION_START_RE = /^(what|which|who|when|where|why|how|explain|define|tell me about)\b/i
const ANALYTICS_INTENT_HINT_RE =
  /\b(by status|status breakdown|by project|per project|over time|trend|monthly|by month|month over month|breakdown|break down|distribution|average|avg|sum of|total amount|total value)\b/
const ANALYTICS_GROUP_BY_STATUS_RE = /\b(by status|status breakdown|status distribution|per status)\b/
const ANALYTICS_GROUP_BY_PROJECT_RE = /\b(by project|per project|project breakdown)\b/
const ANALYTICS_GROUP_BY_MONTH_RE = /\b(over time|trend|monthly|month over month|by month|per month)\b/
const ANALYTICS_METRIC_AVG_RE = /\b(avg|average|mean)\b/
const ANALYTICS_METRIC_SUM_RE = /\b(sum|totals?|total amount|total value|value|worth|dollars|revenue|cost)\b/
const ANALYTICS_VALUE_HINT_RE = /\b(value|worth|amount|total)\b/
const ANALYTICS_QUERY_NOISE_TOKENS = new Set([
  "avg",
  "average",
  "break",
  "breakdown",
  "by",
  "count",
  "distribution",
  "down",
  "group",
  "last",
  "mean",
  "month",
  "monthly",
  "months",
  "over",
  "past",
  "per",
  "project",
  "quarter",
  "status",
  "sum",
  "this",
  "time",
  "total",
  "totals",
  "trend",
  "week",
  "weeks",
  "year",
  "years",
])
const INTENT_FILLER_TOKENS = new Set([
  "all",
  "any",
  "count",
  "display",
  "every",
  "find",
  "give",
  "list",
  "many",
  "me",
  "number",
  "please",
  "show",
  "total",
])
const MAX_QUERY_PLANNER_TOKENS = 220
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "any",
  "are",
  "at",
  "be",
  "for",
  "from",
  "how",
  "in",
  "is",
  "of",
  "on",
  "or",
  "please",
  "show",
  "the",
  "to",
  "what",
  "where",
  "which",
  "who",
  "with",
])

const aiAnswerCache = new Map<string, { expiresAt: number; response: AskAiSearchResponse }>()
const aiArtifactDatasetCache = new Map<string, { expiresAt: number; dataset: AiSearchArtifactDataset }>()
const aiPlannerCache = new Map<string, { expiresAt: number; plan: QueryAgentPlan | null }>()
type ResolvedOrgContext = Awaited<ReturnType<typeof requireOrgContext>>

function normalizeArtifactRowMatrix(raw: unknown): AiArtifactValue[][] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((row) => {
      if (!Array.isArray(row)) return null
      return row.map((cell) => {
        if (cell === null) return null
        if (typeof cell === "string" || (typeof cell === "number" && Number.isFinite(cell))) {
          return cell
        }
        return String(cell)
      })
    })
    .filter((row): row is AiArtifactValue[] => Array.isArray(row))
}

function toArtifactDatasetFromStorage(row: StoredArtifactRow): AiSearchArtifactDataset {
  return {
    id: row.id,
    orgId: row.org_id,
    title: row.title,
    columns: Array.isArray(row.columns) ? row.columns.filter((item): item is string => typeof item === "string") : [],
    rows: normalizeArtifactRowMatrix(row.rows),
    createdAt: row.created_at,
  }
}

async function persistArtifactDataset(dataset: AiSearchArtifactDataset) {
  try {
    const supabase = createServiceSupabaseClient()
    const { error } = await supabase.from("ai_search_artifacts").upsert(
      {
        id: dataset.id,
        org_id: dataset.orgId,
        title: dataset.title,
        columns: dataset.columns,
        rows: dataset.rows,
        created_at: dataset.createdAt,
        expires_at: new Date(Date.now() + ARTIFACT_CACHE_TTL_MS).toISOString(),
      },
      { onConflict: "id" },
    )

    if (error) {
      console.error("Failed to persist AI artifact dataset", error)
    }
  } catch (error) {
    console.error("Failed to persist AI artifact dataset", error)
  }
}

async function loadPersistedArtifactDataset(datasetId: string, orgId: string): Promise<AiSearchArtifactDataset | null> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("ai_search_artifacts")
    .select("id,org_id,title,columns,rows,created_at,expires_at")
    .eq("id", datasetId)
    .eq("org_id", orgId)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle()

  if (error) {
    console.error("Failed to load persisted AI artifact dataset", error)
    return null
  }
  if (!data) return null

  const dataset = toArtifactDatasetFromStorage(data as StoredArtifactRow)
  aiArtifactDatasetCache.set(dataset.id, {
    expiresAt: Date.now() + ARTIFACT_CACHE_TTL_MS,
    dataset,
  })
  return dataset
}

async function ensureAiSearchSession(
  context: ResolvedOrgContext,
  mode: "org" | "general",
  sessionId?: string,
): Promise<string> {
  const trimmed = typeof sessionId === "string" ? sessionId.trim() : ""
  if (trimmed) {
    const { data, error } = await context.supabase
      .from("ai_search_sessions")
      .select("id,mode")
      .eq("id", trimmed)
      .eq("org_id", context.orgId)
      .eq("user_id", context.userId)
      .maybeSingle()

    if (!error && data?.id) {
      const updates: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      }
      if (data.mode !== mode) {
        updates.mode = mode
      }
      await context.supabase
        .from("ai_search_sessions")
        .update(updates)
        .eq("id", data.id)
        .eq("org_id", context.orgId)
        .eq("user_id", context.userId)
      return data.id
    }
  }

  const { data, error } = await context.supabase
    .from("ai_search_sessions")
    .insert({
      org_id: context.orgId,
      user_id: context.userId,
      mode,
    })
    .select("id")
    .single()

  if (error || !data?.id) {
    console.error("Failed to create AI search session", error)
    return randomUUID()
  }

  return data.id
}

async function appendAiSearchMessage(
  context: ResolvedOrgContext,
  sessionId: string,
  role: "user" | "assistant" | "system",
  content: string,
  metadata?: Record<string, unknown>,
) {
  const trimmed = content.trim()
  if (!trimmed) return
  await context.supabase.from("ai_search_messages").insert({
    session_id: sessionId,
    org_id: context.orgId,
    user_id: context.userId,
    role,
    content: trimmed,
    metadata: metadata ?? {},
  })
}

function normalizeMemoryFact(value: string) {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.?!;:]+$/g, "")
}

function extractSessionMemoryFacts(query: string): string[] {
  const facts: string[] = []
  const normalized = query.trim()
  if (!normalized) return facts
  const lower = normalized.toLowerCase()

  const projectName = extractQuotedProjectName(normalized) ?? extractUnquotedProjectName(normalized)
  if (projectName) {
    facts.push(`project_focus=${projectName}`)
  }

  const dateRangeDays = detectDateRangeDays(lower)
  if (dateRangeDays) {
    facts.push(`time_window_days=${dateRangeDays}`)
  }

  const entities = detectEntityMentions(normalized).slice(0, 4)
  if (entities.length > 0) {
    facts.push(`entity_focus=${entities.join(",")}`)
  }

  const statuses = entities.length > 0 ? detectStructuredStatuses(lower, entities[0] ?? "project").slice(0, 3) : []
  if (statuses.length > 0) {
    facts.push(`status_focus=${statuses.join(",")}`)
  }

  const tokens = extractRetrievalQuery(normalized)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .slice(0, 5)
  if (tokens.length > 0) {
    facts.push(`keywords=${tokens.join(",")}`)
  }

  const canonicalMetric = detectCanonicalMetricIntent(normalized, DEFAULT_LIMIT)
  if (canonicalMetric) {
    facts.push(`metric_focus=${canonicalMetric.key}`)
  }

  return Array.from(new Set(facts.map(normalizeMemoryFact).filter((fact) => fact.length > 0))).slice(0, MEMORY_FACT_LIMIT)
}

async function loadAiSearchSessionContext(context: ResolvedOrgContext, sessionId: string): Promise<string> {
  const { data, error } = await context.supabase
    .from("ai_search_messages")
    .select("role,content,metadata")
    .eq("session_id", sessionId)
    .eq("org_id", context.orgId)
    .eq("user_id", context.userId)
    .order("created_at", { ascending: false })
    .limit(20)

  if (error || !Array.isArray(data) || data.length === 0) {
    return ""
  }

  const memoryFacts = new Set<string>()
  for (const item of data) {
    const metadata = item && typeof item === "object" ? (item as { metadata?: unknown }).metadata : undefined
    if (!metadata || typeof metadata !== "object") continue
    const factList = (metadata as { memoryFacts?: unknown }).memoryFacts
    if (!Array.isArray(factList)) continue
    for (const fact of factList) {
      if (typeof fact !== "string") continue
      const normalized = normalizeMemoryFact(fact)
      if (normalized) memoryFacts.add(normalized)
      if (memoryFacts.size >= MEMORY_FACT_LIMIT) break
    }
    if (memoryFacts.size >= MEMORY_FACT_LIMIT) break
  }

  const lines = data
    .slice()
    .reverse()
    .slice(-8)
    .map((item) => {
      const role = typeof item.role === "string" ? item.role : "user"
      const content = typeof item.content === "string" ? item.content.trim() : ""
      if (!content) return null
      return `${role.toUpperCase()}: ${content}`
    })
    .filter((item): item is string => Boolean(item))

  if (lines.length === 0 && memoryFacts.size === 0) return ""

  const memoryBlock =
    memoryFacts.size > 0
      ? `Persistent memory facts:\n${Array.from(memoryFacts)
          .map((fact) => `- ${fact}`)
          .join("\n")}`
      : ""
  return [memoryBlock, lines.join("\n")].filter((segment) => segment.trim().length > 0).join("\n\n")
}

function clampLimit(limit?: number) {
  if (!limit || Number.isNaN(limit)) return DEFAULT_LIMIT
  return Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Math.floor(limit)))
}

function normalizeQuery(query: string) {
  return query.trim().replace(/\s+/g, " ")
}

function normalizeSpellingHints(query: string) {
  return query
    .replace(/\bprojets?\b/gi, "projects")
    .replace(/\binovices?\b/gi, "invoices")
    .replace(/\baprovals?\b/gi, "approvals")
    .replace(/\bsubmital(s)?\b/gi, "submittal$1")
}

function extractRetrievalQuery(query: string) {
  const normalized = normalizeSpellingHints(query)
  const tokens = normalized
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9_-]/g, ""))
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token))

  if (tokens.length === 0) {
    return normalized
  }

  return tokens.slice(0, 7).join(" ")
}

function pickEntityTypesForQuery(query: string): SearchEntityType[] {
  const lower = normalizeSpellingHints(query).toLowerCase()
  const picked = new Set<SearchEntityType>(BASE_ENTITY_TYPES)

  if (/\b(invoice|payment|bill|budget|forecast|draw|ar|ap|cash|revenue|cost|price|amount)\b/.test(lower)) {
    FINANCIAL_ENTITY_TYPES.forEach((type) => picked.add(type))
  }

  if (/\b(rfi|submittal|drawing|sheet|spec|document|file|contract)\b/.test(lower)) {
    DOCUMENT_ENTITY_TYPES.forEach((type) => picked.add(type))
  }

  if (/\b(contract|agreement|proposal|scope)\b/.test(lower)) {
    picked.add("contract")
    picked.add("proposal")
  }

  if (/\b(task|schedule|milestone|daily\s*log|punch|field|site)\b/.test(lower)) {
    FIELD_ENTITY_TYPES.forEach((type) => picked.add(type))
  }

  return Array.from(picked)
}

function resolveStructuredEntity(query: string) {
  return ENTITY_INTENTS.find((entity) => entity.aliases.some((pattern) => pattern.test(query))) ?? null
}

function normalizeLookupText(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s&-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function tokenizeProjectName(value: string) {
  return normalizeLookupText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !PROJECT_NAME_NOISE_TOKENS.has(token))
}

function buildProjectCandidateScore(query: string, projectName: string) {
  const normalizedQuery = normalizeLookupText(query)
  const normalizedProjectName = normalizeLookupText(projectName)
  if (!normalizedQuery || !normalizedProjectName) return 0

  if (normalizedProjectName === normalizedQuery) return 10_000
  if (normalizedProjectName.includes(normalizedQuery)) return 5_000

  const queryTokens = tokenizeProjectName(normalizedQuery)
  if (queryTokens.length === 0) return 0
  const projectTokens = tokenizeProjectName(normalizedProjectName)
  const projectTokenSet = new Set(projectTokens)

  let score = 0
  for (const token of queryTokens) {
    if (projectTokenSet.has(token)) {
      score += 100
      continue
    }

    const startsWithMatch = projectTokens.some((candidate) => candidate.startsWith(token) || token.startsWith(candidate))
    if (startsWithMatch) {
      score += 45
    }
  }

  const queryBigrams = new Set<string>()
  for (let index = 0; index < queryTokens.length - 1; index += 1) {
    const first = queryTokens[index]
    const second = queryTokens[index + 1]
    if (first && second) {
      queryBigrams.add(`${first} ${second}`)
    }
  }
  for (const bigram of queryBigrams) {
    if (normalizedProjectName.includes(bigram)) {
      score += 80
    }
  }

  score += Math.round((queryTokens.length / Math.max(1, projectTokens.length)) * 10)
  return score
}

function normalizeEntityType(value: unknown): SearchEntityType | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "_")
  if (!normalized) return null

  const direct = ENTITY_INTENTS.find((entity) => entity.type === normalized)
  if (direct) return direct.type

  const singular = normalized.endsWith("s") ? normalized.slice(0, -1) : normalized
  const singularDirect = ENTITY_INTENTS.find((entity) => entity.type === singular)
  if (singularDirect) return singularDirect.type

  const byToken = ENTITY_INTENTS.find((entity) => entity.tokens.includes(normalized) || entity.tokens.includes(singular))
  return byToken?.type ?? null
}

function normalizePlannerOperation(value: unknown): StructuredOperation | "analyze" | "aggregate" | "none" | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase()
  if (
    normalized === "list" ||
    normalized === "count" ||
    normalized === "list_and_count" ||
    normalized === "analyze" ||
    normalized === "aggregate" ||
    normalized === "none"
  ) {
    return normalized
  }
  return null
}

function detectStructuredStatuses(query: string, entityType: SearchEntityType) {
  const allowed = ENTITY_STATUS_VALUES[entityType]
  if (!allowed || allowed.length === 0) return []

  const allowedSet = new Set(allowed)
  const found: string[] = []
  for (const { pattern, normalized } of STATUS_ALIASES) {
    if (!allowedSet.has(normalized)) continue
    if (!pattern.test(query)) continue
    if (!found.includes(normalized)) found.push(normalized)
  }

  return found
}

function detectAnalyticsMetric(query: string): AnalyticsMetric {
  if (ANALYTICS_METRIC_AVG_RE.test(query)) return "avg_amount"
  if (ANALYTICS_METRIC_SUM_RE.test(query)) return "sum_amount"
  return "count"
}

function detectAnalyticsGroupBy(query: string): AnalyticsGroupBy {
  if (ANALYTICS_GROUP_BY_STATUS_RE.test(query)) return "status"
  if (ANALYTICS_GROUP_BY_PROJECT_RE.test(query)) return "project"
  if (ANALYTICS_GROUP_BY_MONTH_RE.test(query)) return "month"
  return "none"
}

function detectDateRangeDays(query: string): number | undefined {
  const lower = query.toLowerCase()

  const daysMatch = /\b(?:last|past)\s+(\d{1,3})\s+days?\b/.exec(lower)
  if (daysMatch?.[1]) {
    const parsed = Number.parseInt(daysMatch[1], 10)
    if (Number.isFinite(parsed)) return parsed
  }

  const weeksMatch = /\b(?:last|past)\s+(\d{1,2})\s+weeks?\b/.exec(lower)
  if (weeksMatch?.[1]) {
    const parsed = Number.parseInt(weeksMatch[1], 10)
    if (Number.isFinite(parsed)) return parsed * 7
  }

  const monthsMatch = /\b(?:last|past)\s+(\d{1,2})\s+months?\b/.exec(lower)
  if (monthsMatch?.[1]) {
    const parsed = Number.parseInt(monthsMatch[1], 10)
    if (Number.isFinite(parsed)) return parsed * 30
  }

  if (/\b(last quarter|past quarter|this quarter)\b/.test(lower)) return 90
  if (/\b(last year|past year|this year|ytd)\b/.test(lower)) return 365
  return undefined
}

function clampDateRangeDays(value?: number) {
  if (!value || Number.isNaN(value)) return undefined
  return Math.max(7, Math.min(MAX_ANALYTICS_RANGE_DAYS, Math.floor(value)))
}

function extractRequestedLimit(query: string, fallback: number) {
  const explicit =
    /\b(?:top|first|last)\s+(\d{1,3})\b/i.exec(query) ??
    /\b(\d{1,3})\s+(?:projects?|tasks?|files?|invoices?|rfis?|submittals?|messages?|contacts?|companies?)\b/i.exec(query)

  if (!explicit) return fallback
  const parsed = Number.parseInt(explicit[1] ?? "", 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(MAX_LIMIT, parsed))
}

function stripIntentTokens(query: string, entityTokens: string[], statuses: string[]) {
  const statusTokens = statuses.flatMap((status) => status.split("_"))
  const removable = new Set<string>([...entityTokens, ...statusTokens, ...INTENT_FILLER_TOKENS])
  return extractRetrievalQuery(query)
    .split(/\s+/)
    .filter((token) => {
      if (token.length === 0) return false
      if (removable.has(token)) return false
      const singular = token.endsWith("s") ? token.slice(0, -1) : token
      return !removable.has(singular)
    })
    .join(" ")
}

function normalizeAnalyticsTextQuery(value: string) {
  const cleaned = value
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9_-]/g, ""))
    .filter((token) => token.length > 0)
    .filter((token) => {
      if (ANALYTICS_QUERY_NOISE_TOKENS.has(token)) return false
      const singular = token.endsWith("s") ? token.slice(0, -1) : token
      return !ANALYTICS_QUERY_NOISE_TOKENS.has(singular)
    })

  return cleaned.join(" ")
}

function parseStructuredIntent(query: string, fallbackLimit: number): StructuredIntent | null {
  const lower = query.toLowerCase()
  const isCount = STRUCTURED_COUNT_HINT_RE.test(lower)
  const isList = STRUCTURED_LIST_HINT_RE.test(lower)
  const entity = resolveStructuredEntity(lower)
  if (!entity) return null

  const hasDirectStatusIntent = /\b(active|planning|bidding|on hold|completed|cancelled|in progress|todo|blocked|done|open|pending|approved|rejected|resolved|overdue)\b/.test(
    lower,
  )
  if (!isCount && !isList && !hasDirectStatusIntent) return null

  // Keep richer analytical prompts on the normal retrieval+synthesis path.
  if (NON_STRUCTURED_HINT_RE.test(lower) && !isCount) {
    return null
  }

  const statuses = detectStructuredStatuses(lower, entity.type)
  const textQuery = stripIntentTokens(query, entity.tokens, statuses)

  return {
    kind: "structured",
    operation: isCount ? "count" : "list",
    entityType: entity.type,
    entityLabel: entity.label,
    entityTokens: entity.tokens,
    statuses,
    textQuery,
    limit: extractRequestedLimit(query, fallbackLimit),
  }
}

function sanitizeAttributeTargetHint(value: string) {
  const candidate = value
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/[?.,!;:]+$/g, "")
    .replace(/\s+/g, " ")
  if (candidate.length < 2) return undefined

  const normalizedTokens = candidate
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !ATTRIBUTE_TARGET_NOISE_TOKENS.has(token))
  if (normalizedTokens.length === 0) return undefined
  return candidate
}

function extractAttributeTargetHint(query: string, entityType: SearchEntityType) {
  const quoted = extractQuotedProjectName(query)
  if (quoted) return quoted

  if (entityType === "project") {
    const projectHint = extractUnquotedProjectName(query)
    if (projectHint) return projectHint
  }

  const compact = query.trim().replace(/\s+/g, " ")
  const patterns = [
    /\b(?:for|of|on|in)\s+(?:the\s+)?(?:project|job|company|vendor|contact|person)?\s*["“]?([^"”]+?)["”]?\s*$/i,
    /\b(?:project|job|company|vendor|contact|person)\s+(?:named|called)?\s*["“]?([^"”]+?)["”]?\s*$/i,
    /\b(?:address|location|jobsite|site address|status|start date|end date|completion date|total value|project value|contract value|description|scope|summary|email|e-mail|phone|telephone|mobile|website|url|role|title|position)\s+(?:for|of)\s+(?:the\s+)?(?:project|job|company|vendor|contact|person)?\s*["“]?([^"”]+?)["”]?\s*$/i,
    /\b(?:project|job|company|vendor|contact|person)\s+(?:named|called)?\s*["“]?([^"”]+?)["”]?\s+(?:address|location|jobsite|site address|status|start date|end date|completion date|total value|project value|contract value|description|scope|summary|email|e-mail|phone|telephone|mobile|website|url|role|title|position)\b/i,
    /\b["“]?([^"”]+?)["”]?\s+(?:project|job|company|vendor|contact|person)\s+(?:address|location|jobsite|site address|status|start date|end date|completion date|total value|project value|contract value|description|scope|summary|email|e-mail|phone|telephone|mobile|website|url|role|title|position)\b/i,
  ]

  for (const pattern of patterns) {
    const match = pattern.exec(compact)
    if (!match?.[1]) continue
    const sanitized = sanitizeAttributeTargetHint(match[1])
    if (sanitized) return sanitized
  }

  return undefined
}

function detectEntityAttributeIntent(query: string): EntityAttributeIntent | null {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return null
  if (STRUCTURED_COUNT_HINT_RE.test(normalized)) return null

  const hasAddressLikeIntent = /\b(address|location|jobsite|site address)\b/.test(normalized)
  const hasContactLikeIntent = /\b(email|e-mail|phone|telephone|mobile|website|url|role|title|position)\b/.test(normalized)
  const hasProjectDetailIntent = /\b(start date|end date|completion|contract value|total value|description|scope|status)\b/.test(normalized)
  const hasAttributeKeyword = hasAddressLikeIntent || hasContactLikeIntent || hasProjectDetailIntent
  const asksAttribute = /\b(what(?:'s| is)?|show|give|tell|where|which|who)\b/.test(normalized)
  const implicitFieldLookup = hasAttributeKeyword && /\b(for|of)\b/.test(normalized)
  if (!asksAttribute && !implicitFieldLookup) return null

  const mentioned = detectEntityMentions(query).filter(
    (entityType): entityType is SearchEntityType => Boolean(ENTITY_ATTRIBUTE_CONFIGS[entityType]),
  )
  let candidateEntities = mentioned

  if (candidateEntities.length === 0) {
    if (hasAddressLikeIntent || hasProjectDetailIntent) {
      candidateEntities = ["project", "company", "contact"]
    } else if (hasContactLikeIntent) {
      candidateEntities = ["contact", "company"]
    } else {
      return null
    }
  }

  for (const entityType of candidateEntities) {
    const config = ENTITY_ATTRIBUTE_CONFIGS[entityType]
    if (!config) continue

    let field = config.fields.find((candidateField) => candidateField.aliases.some((pattern) => pattern.test(normalized)))
    if (!field && /^\s*where\b/.test(normalized) && config.defaultFieldKey) {
      field = config.fields.find((candidateField) => candidateField.key === config.defaultFieldKey)
    }
    if (!field) continue

    const targetHint = extractAttributeTargetHint(query, entityType)
    if (!asksAttribute && !targetHint) {
      continue
    }

    return {
      entityType,
      fieldKey: field.key,
      targetHint,
    }
  }

  return null
}

function normalizeAnalyticsMetric(metric: AnalyticsMetric, entityType: SearchEntityType): AnalyticsMetric {
  const config = ANALYTICS_ENTITY_CONFIGS[entityType]
  if (!config?.amountField && (metric === "sum_amount" || metric === "avg_amount")) {
    return "count"
  }
  return metric
}

function normalizeAnalyticsGroupBy(groupBy: AnalyticsGroupBy, entityType: SearchEntityType): AnalyticsGroupBy {
  const config = ANALYTICS_ENTITY_CONFIGS[entityType]
  if (!config) return "none"
  if (groupBy === "status" && !config.statusField) return "none"
  if (groupBy === "project" && !config.projectIdField) return "none"
  if (groupBy === "month" && !config.createdAtField) return "none"
  return groupBy
}

function parseAnalyticsIntent(query: string, fallbackLimit: number): AnalyticsIntent | null {
  const lower = query.toLowerCase()
  const entity = resolveStructuredEntity(lower)
  const isValueAnalytics = Boolean(entity) && ANALYTICS_VALUE_HINT_RE.test(lower)
  if (!ANALYTICS_INTENT_HINT_RE.test(lower) && !isValueAnalytics) return null
  if (!entity || !ANALYTICS_ENTITY_CONFIGS[entity.type]) return null

  const statuses = detectStructuredStatuses(lower, entity.type)
  const textQuery = normalizeAnalyticsTextQuery(stripIntentTokens(query, entity.tokens, statuses))
  const metric = normalizeAnalyticsMetric(detectAnalyticsMetric(lower), entity.type)
  const groupBy = normalizeAnalyticsGroupBy(detectAnalyticsGroupBy(lower), entity.type)
  const dateRangeDays = clampDateRangeDays(detectDateRangeDays(lower))
  const projectName = extractQuotedProjectName(query) ?? extractUnquotedProjectName(query)

  return {
    kind: "analytics",
    operation: "aggregate",
    entityType: entity.type,
    metric,
    groupBy,
    statuses,
    textQuery,
    projectName,
    dateRangeDays,
    limit: extractRequestedLimit(query, fallbackLimit),
  }
}

function detectCanonicalMetricIntent(query: string, fallbackLimit: number): CanonicalMetricIntent | null {
  const normalized = query.trim()
  if (!normalized) return null
  const lower = normalized.toLowerCase()
  if (!CANONICAL_METRIC_SIGNAL_RE.test(lower)) return null

  const projectName = extractQuotedProjectName(normalized) ?? extractUnquotedProjectName(normalized)
  const dateRangeDays = clampDateRangeDays(detectDateRangeDays(lower))
  const groupBy = normalizeAnalyticsGroupBy(detectAnalyticsGroupBy(lower), "invoice")
  const limit = Math.max(8, Math.min(20, extractRequestedLimit(normalized, fallbackLimit)))

  if (/\b(commitments?\s+(?:exceed|over|vs|versus|against)\s+budgets?|budget(?:s)?\s+(?:vs|versus|against)\s+commitments?)\b/.test(lower)) {
    return {
      key: "budget_commitment_gap",
      label: "Budget vs commitments gap",
      projectName,
      dateRangeDays,
      groupBy: "none",
      limit,
    }
  }

  if (/\b(overdue\s+(?:ar|a\/r|accounts?\s+receivable)|past[-\s]?due\s+(?:ar|a\/r|accounts?\s+receivable))\b/.test(lower)) {
    return {
      key: "overdue_ar",
      label: "Overdue AR",
      projectName,
      dateRangeDays,
      groupBy,
      limit,
    }
  }

  if (
    /\b(open\s+(?:ar|a\/r|accounts?\s+receivable)|outstanding\s+(?:ar|a\/r|receivables?)|unpaid\s+invoices?)\b/.test(
      lower,
    )
  ) {
    return {
      key: "open_ar",
      label: "Open AR",
      projectName,
      dateRangeDays,
      groupBy,
      limit,
    }
  }

  if (/\b(cash\s+(?:in|inflow)|payments?\s+received|collected|cash\s+collected)\b/.test(lower)) {
    return {
      key: "cash_collected",
      label: "Cash collected",
      projectName,
      dateRangeDays,
      groupBy: normalizeAnalyticsGroupBy(groupBy, "payment"),
      limit,
    }
  }

  if (/\b(revenue|sales|income|topline)\b/.test(lower)) {
    return {
      key: "revenue_billed",
      label: "Revenue billed",
      projectName,
      dateRangeDays,
      groupBy,
      limit,
    }
  }

  return null
}

function normalizePlannerStatuses(rawStatuses: unknown, entityType: SearchEntityType) {
  const allowed = new Set(ENTITY_STATUS_VALUES[entityType] ?? [])
  if (allowed.size === 0) return []

  if (!Array.isArray(rawStatuses)) return []
  const normalized: string[] = []
  for (const status of rawStatuses) {
    if (typeof status !== "string") continue
    const candidate = status.trim().toLowerCase().replace(/\s+/g, "_")
    if (!candidate || !allowed.has(candidate)) continue
    if (!normalized.includes(candidate)) normalized.push(candidate)
  }
  return normalized
}

function normalizePlannerEntityTypes(raw: unknown, fallbackQuery: string) {
  const resolved: SearchEntityType[] = []

  if (Array.isArray(raw)) {
    for (const value of raw) {
      const normalized = normalizeEntityType(value)
      if (!normalized) continue
      if (!resolved.includes(normalized)) resolved.push(normalized)
    }
  } else {
    const single = normalizeEntityType(raw)
    if (single) {
      resolved.push(single)
    }
  }

  if (resolved.length > 0) return resolved
  return pickEntityTypesForQuery(fallbackQuery)
}

function normalizeOptionalString(value: unknown) {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function extractQuotedProjectName(query: string) {
  const quoted = query.match(/["']([^"']{3,})["']/)
  if (!quoted) return undefined
  const candidate = quoted[1]?.trim()
  return candidate && candidate.length >= 3 ? candidate : undefined
}

function extractUnquotedProjectName(query: string) {
  const patterns = [
    /\bfor\s+(?:the\s+)?(.+?)\s+project\b/i,
    /\bof\s+(?:the\s+)?(.+?)\s+project\b/i,
    /\bin\s+(?:the\s+)?(.+?)\s+project\b/i,
  ]

  for (const pattern of patterns) {
    const match = pattern.exec(query)
    if (!match?.[1]) continue
    const candidate = match[1]
      .trim()
      .replace(/[?.,!;:]+$/g, "")
      .replace(/\s+/g, " ")

    if (candidate.length >= 3) return candidate
  }

  return undefined
}

function normalizePlannerAnalyticsMetric(
  rawMetric: unknown,
  entityType: SearchEntityType,
  fallbackQuery: string,
): AnalyticsMetric {
  const fromQuery = detectAnalyticsMetric(fallbackQuery.toLowerCase())
  if (typeof rawMetric !== "string") {
    return normalizeAnalyticsMetric(fromQuery, entityType)
  }

  const normalized = rawMetric.trim().toLowerCase()
  if (normalized === "count" || normalized === "sum_amount" || normalized === "avg_amount") {
    return normalizeAnalyticsMetric(normalized, entityType)
  }

  return normalizeAnalyticsMetric(fromQuery, entityType)
}

function normalizePlannerAnalyticsGroupBy(
  rawGroupBy: unknown,
  entityType: SearchEntityType,
  fallbackQuery: string,
): AnalyticsGroupBy {
  const fromQuery = detectAnalyticsGroupBy(fallbackQuery.toLowerCase())
  if (typeof rawGroupBy !== "string") {
    return normalizeAnalyticsGroupBy(fromQuery, entityType)
  }

  const normalized = rawGroupBy.trim().toLowerCase()
  if (normalized === "none" || normalized === "status" || normalized === "project" || normalized === "month") {
    return normalizeAnalyticsGroupBy(normalized, entityType)
  }

  return normalizeAnalyticsGroupBy(fromQuery, entityType)
}

function normalizePlannerDateRangeDays(rawDateRangeDays: unknown, fallbackQuery: string) {
  if (typeof rawDateRangeDays === "number" && Number.isFinite(rawDateRangeDays)) {
    return clampDateRangeDays(rawDateRangeDays)
  }

  return clampDateRangeDays(detectDateRangeDays(fallbackQuery.toLowerCase()))
}

function buildPlannerSchemaContext() {
  const lines: string[] = []
  const toolCatalog = getAiToolCatalog()
  const entitySet = new Set<SearchEntityType>([
    ...ENTITY_INTENTS.map((entity) => entity.type),
    ...(Object.keys(COUNT_QUERY_CONFIGS) as SearchEntityType[]),
    ...(Object.keys(ANALYTICS_ENTITY_CONFIGS) as SearchEntityType[]),
  ])

  for (const entityType of entitySet) {
    const entity = ENTITY_INTENTS.find((item) => item.type === entityType)
    const countConfig = COUNT_QUERY_CONFIGS[entityType]
    const analyticsConfig = ANALYTICS_ENTITY_CONFIGS[entityType]
    const statusValues = ENTITY_STATUS_VALUES[entityType] ?? []
    const aliasHint =
      entity?.tokens.slice(0, 4).join(", ") ??
      entityType.split("_").join(",") ??
      entityType
    const toolKeys = toolCatalog
      .filter((tool) => tool.entities.includes(entityType))
      .map((tool) => tool.key)
      .slice(0, 4)
      .join(",")
    const tableName = analyticsConfig?.table ?? countConfig?.table
    const supports = [
      countConfig ? "list/count" : null,
      analyticsConfig ? "aggregate" : null,
      statusValues.length > 0 ? "status filters" : null,
      analyticsConfig?.amountField ? "amount metrics" : null,
      analyticsConfig?.projectIdField ? "project grouping" : null,
      analyticsConfig?.createdAtField ? "time grouping" : null,
    ]
      .filter((item): item is string => Boolean(item))
      .join(", ")
    const searchFields = [
      ...(countConfig?.searchableFields ?? []),
      ...(analyticsConfig?.searchableFields ?? []),
    ]
    const uniqueSearchFields = Array.from(new Set(searchFields)).slice(0, 5)

    lines.push(
      `- ${entityType}: table=${tableName ?? "n/a"}; aliases=${aliasHint || entityType}; supports=${supports || "n/a"}${
        statusValues.length > 0 ? `; statuses=${statusValues.join(",")}` : ""
      }${uniqueSearchFields.length > 0 ? `; fields=${uniqueSearchFields.join(",")}` : ""}${
        toolKeys ? `; tools=${toolKeys}` : ""
      }`,
    )
  }

  lines.push(
    "- canonical_metrics: revenue_billed, cash_collected, open_ar, overdue_ar, budget_commitment_gap (org-scoped, optionally project/time filtered)",
  )
  return lines.join("\n")
}

function parsePlannerIntent(raw: string, fallbackLimit: number, query: string): PlannedIntent | null {
  const candidate = cleanJsonCandidate(raw)
  const segments = [candidate]
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start >= 0 && end > start) {
    segments.push(raw.slice(start, end + 1).trim())
  }

  for (const segment of segments) {
    try {
      const parsed = JSON.parse(segment) as {
        operation?: unknown
        entityType?: unknown
        entityTypes?: unknown
        statuses?: unknown
        textQuery?: unknown
        limit?: unknown
        projectName?: unknown
        includeFinancialRollup?: unknown
        metric?: unknown
        groupBy?: unknown
        dateRangeDays?: unknown
      }

      const operation = normalizePlannerOperation(parsed.operation)
      if (!operation) continue
      if (operation === "none") return null

      const rawTextQuery = typeof parsed.textQuery === "string" ? parsed.textQuery.trim() : ""
      const limitValue =
        typeof parsed.limit === "number" && Number.isFinite(parsed.limit)
          ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(parsed.limit)))
          : fallbackLimit
      const projectName =
        normalizeOptionalString(parsed.projectName) ??
        extractQuotedProjectName(query) ??
        extractUnquotedProjectName(query)

      if (operation === "analyze") {
        const entityTypes = normalizePlannerEntityTypes(parsed.entityTypes ?? parsed.entityType, query)
        const primaryEntity = entityTypes[0]
        const statuses = primaryEntity ? normalizePlannerStatuses(parsed.statuses, primaryEntity) : []
        const includeFinancialRollup =
          parsed.includeFinancialRollup === true ||
          /\b(financial|finance|cost|revenue|budget|invoice|payment|cash|margin|profit)\b/i.test(query)

        return {
          kind: "analysis",
          operation: "analyze",
          entityTypes,
          projectName,
          statuses,
          textQuery: rawTextQuery,
          limit: limitValue,
          includeFinancialRollup,
        }
      }

      if (operation === "aggregate") {
        const entityType = normalizeEntityType(parsed.entityType)
        if (!entityType || !ANALYTICS_ENTITY_CONFIGS[entityType]) continue

        const statuses = normalizePlannerStatuses(parsed.statuses, entityType)
        const metric = normalizePlannerAnalyticsMetric(parsed.metric, entityType, query)
        const groupBy = normalizePlannerAnalyticsGroupBy(parsed.groupBy, entityType, query)
        const dateRangeDays = normalizePlannerDateRangeDays(parsed.dateRangeDays, query)
        const entityTokens = ENTITY_INTENTS.find((entity) => entity.type === entityType)?.tokens ?? [entityType]
        const querySeed = rawTextQuery || stripIntentTokens(query, entityTokens, statuses)
        const textQuery = normalizeAnalyticsTextQuery(querySeed)

        return {
          kind: "analytics",
          operation: "aggregate",
          entityType,
          metric,
          groupBy,
          statuses,
          textQuery,
          projectName,
          dateRangeDays,
          limit: limitValue,
        }
      }

      const entityType = normalizeEntityType(parsed.entityType)
      if (!entityType) continue
      const statuses = normalizePlannerStatuses(parsed.statuses, entityType)

      const label = ENTITY_INTENTS.find((entity) => entity.type === entityType)?.label ?? formatEntityType(entityType).toLowerCase()
      const tokens = ENTITY_INTENTS.find((entity) => entity.type === entityType)?.tokens ?? [entityType]

      return {
        kind: "structured",
        operation,
        entityType,
        entityLabel: label,
        entityTokens: tokens,
        statuses,
        textQuery: rawTextQuery,
        limit: limitValue,
      }
    } catch {
      continue
    }
  }

  return null
}

async function planQueryIntentWithLlm(
  query: string,
  provider: AiProvider,
  model: string,
  fallbackLimit: number,
) {
  const apiKey = getApiKeyForProvider(provider)
  if (!apiKey) return null

  const languageModel = resolveLanguageModel(provider, apiKey, model)
  try {
    const schemaContext = buildPlannerSchemaContext()
    const toolCatalog = formatAiToolCatalogForPrompt()
    const result = await generateText({
      model: languageModel,
      system: QUERY_PLANNER_SYSTEM_PROMPT,
      prompt: `Question:\n${query}\n\nAvailable semantic datasets:\n${schemaContext}\n\nAvailable tools:\n${toolCatalog}`,
      temperature: 0,
      maxOutputTokens: Math.max(MAX_QUERY_PLANNER_TOKENS, 320),
      timeout: REQUEST_TIMEOUT_MS,
    })

    return parsePlannerIntent(result.text, fallbackLimit, query)
  } catch (error) {
    console.error("AI query planning failed", error)
    return null
  }
}

function normalizeQueryAgentOperation(value: unknown): QueryAgentOperation | "none" | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase()
  if (normalized === "list" || normalized === "aggregate" || normalized === "none") {
    return normalized
  }
  return null
}

function deriveRelatedEntitiesFromQuery(query: string, primaryEntity: SearchEntityType): SearchEntityType[] {
  const mentions = detectEntityMentions(query)
  const related = mentions.filter((entityType) => entityType !== primaryEntity)
  return Array.from(new Set(related)).slice(0, 3)
}

function buildHeuristicQueryAgentPlan(query: string, fallbackLimit: number): QueryAgentPlan | null {
  const analytics = parseAnalyticsIntent(query, fallbackLimit)
  if (analytics) {
    return {
      operation: "aggregate",
      entityType: analytics.entityType,
      relatedEntityTypes: deriveRelatedEntitiesFromQuery(query, analytics.entityType),
      metric: analytics.metric,
      groupBy: analytics.groupBy,
      statuses: analytics.statuses,
      textQuery: analytics.textQuery,
      projectName: analytics.projectName,
      dateRangeDays: analytics.dateRangeDays,
      limit: analytics.limit,
    }
  }

  const structured = parseStructuredIntent(query, fallbackLimit)
  if (structured) {
    if (structured.operation === "count" || structured.operation === "list_and_count") {
      return {
        operation: "aggregate",
        entityType: structured.entityType,
        relatedEntityTypes: deriveRelatedEntitiesFromQuery(query, structured.entityType),
        metric: "count",
        groupBy: "none",
        statuses: structured.statuses,
        textQuery: structured.textQuery,
        projectName: extractQuotedProjectName(query) ?? extractUnquotedProjectName(query),
        dateRangeDays: clampDateRangeDays(detectDateRangeDays(query.toLowerCase())),
        limit: structured.limit,
      }
    }

    return {
      operation: "list",
      entityType: structured.entityType,
      relatedEntityTypes: deriveRelatedEntitiesFromQuery(query, structured.entityType),
      metric: "count",
      groupBy: "none",
      statuses: structured.statuses,
      textQuery: structured.textQuery,
      projectName: extractQuotedProjectName(query) ?? extractUnquotedProjectName(query),
      dateRangeDays: clampDateRangeDays(detectDateRangeDays(query.toLowerCase())),
      limit: structured.limit,
    }
  }

  const lower = query.toLowerCase()
  const entity = resolveStructuredEntity(lower)
  if (!entity) return null

  const statuses = detectStructuredStatuses(lower, entity.type)
  const textQuery = stripIntentTokens(query, entity.tokens, statuses)
  const projectName = extractQuotedProjectName(query) ?? extractUnquotedProjectName(query)
  const dateRangeDays = clampDateRangeDays(detectDateRangeDays(lower))
  const isAggregate = ANALYTICS_INTENT_HINT_RE.test(lower) || ANALYTICS_VALUE_HINT_RE.test(lower) || STRUCTURED_COUNT_HINT_RE.test(lower)

  if (isAggregate && ANALYTICS_ENTITY_CONFIGS[entity.type]) {
    return {
      operation: "aggregate",
      entityType: entity.type,
      relatedEntityTypes: deriveRelatedEntitiesFromQuery(query, entity.type),
      metric: normalizeAnalyticsMetric(detectAnalyticsMetric(lower), entity.type),
      groupBy: normalizeAnalyticsGroupBy(detectAnalyticsGroupBy(lower), entity.type),
      statuses,
      textQuery: normalizeAnalyticsTextQuery(textQuery),
      projectName,
      dateRangeDays,
      limit: extractRequestedLimit(query, fallbackLimit),
    }
  }

  return {
    operation: "list",
    entityType: entity.type,
    relatedEntityTypes: deriveRelatedEntitiesFromQuery(query, entity.type),
    metric: "count",
    groupBy: "none",
    statuses,
    textQuery,
    projectName,
    dateRangeDays,
    limit: extractRequestedLimit(query, fallbackLimit),
  }
}

function parseQueryAgentPlan(raw: string, query: string, fallbackLimit: number): QueryAgentPlan | null {
  const candidate = cleanJsonCandidate(raw)
  const segments = [candidate]
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start >= 0 && end > start) {
    segments.push(raw.slice(start, end + 1).trim())
  }

  for (const segment of segments) {
    try {
      const parsed = JSON.parse(segment) as {
        operation?: unknown
        entityType?: unknown
        relatedEntityTypes?: unknown
        metric?: unknown
        groupBy?: unknown
        statuses?: unknown
        textQuery?: unknown
        projectName?: unknown
        dateRangeDays?: unknown
        limit?: unknown
      }

      const operation = normalizeQueryAgentOperation(parsed.operation)
      if (!operation) continue
      if (operation === "none") return null

      const entityType =
        normalizeEntityType(parsed.entityType) ??
        resolveStructuredEntity(query.toLowerCase())?.type ??
        normalizeEntityType(extractRetrievalQuery(query).split(" ")[0] ?? "")
      if (!entityType) continue
      const relatedEntityTypes = normalizePlannerEntityTypes(parsed.relatedEntityTypes, query).filter(
        (candidate) => candidate !== entityType,
      )

      const statuses = normalizePlannerStatuses(parsed.statuses, entityType)
      const limit =
        typeof parsed.limit === "number" && Number.isFinite(parsed.limit)
          ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(parsed.limit)))
          : extractRequestedLimit(query, fallbackLimit)

      const projectName =
        normalizeOptionalString(parsed.projectName) ??
        extractQuotedProjectName(query) ??
        extractUnquotedProjectName(query)
      const dateRangeDays = normalizePlannerDateRangeDays(parsed.dateRangeDays, query)
      const lowerQuery = query.toLowerCase()
      const shouldForceAggregate =
        operation === "list" &&
        ANALYTICS_VALUE_HINT_RE.test(lowerQuery) &&
        Boolean(ANALYTICS_ENTITY_CONFIGS[entityType]?.amountField)

      if (operation === "aggregate" || shouldForceAggregate) {
        const metric = normalizePlannerAnalyticsMetric(parsed.metric, entityType, query)
        const groupBy = normalizePlannerAnalyticsGroupBy(parsed.groupBy, entityType, query)
        const entityTokens = ENTITY_INTENTS.find((entity) => entity.type === entityType)?.tokens ?? [entityType]
        const rawText = typeof parsed.textQuery === "string" ? parsed.textQuery.trim() : ""
        const querySeed = rawText || stripIntentTokens(query, entityTokens, statuses)
        return {
          operation: "aggregate",
          entityType,
          relatedEntityTypes,
          metric,
          groupBy,
          statuses,
          textQuery: normalizeAnalyticsTextQuery(querySeed),
          projectName,
          dateRangeDays,
          limit,
        }
      }

      const entityTokens = ENTITY_INTENTS.find((entity) => entity.type === entityType)?.tokens ?? [entityType]
      const rawText = typeof parsed.textQuery === "string" ? parsed.textQuery.trim() : ""
      return {
        operation: "list",
        entityType,
        relatedEntityTypes,
        metric: "count",
        groupBy: "none",
        statuses,
        textQuery: rawText || stripIntentTokens(query, entityTokens, statuses),
        projectName,
        dateRangeDays,
        limit,
      }
    } catch {
      continue
    }
  }

  return null
}

async function planQueryWithAgent(
  query: string,
  provider: AiProvider,
  model: string,
  fallbackLimit: number,
) {
  const heuristicPlan = buildHeuristicQueryAgentPlan(query, fallbackLimit)
  const plannerCacheKey = `${provider}:${model}:${fallbackLimit}:${query.trim().toLowerCase()}`
  const cached = aiPlannerCache.get(plannerCacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.plan ?? (REQUIRE_LLM_FOR_AI_SEARCH ? null : heuristicPlan)
  }

  const apiKey = getApiKeyForProvider(provider)
  if (!apiKey) {
    const fallbackPlan = REQUIRE_LLM_FOR_AI_SEARCH ? null : heuristicPlan
    aiPlannerCache.set(plannerCacheKey, {
      expiresAt: Date.now() + 60_000,
      plan: fallbackPlan,
    })
    return fallbackPlan
  }

  const languageModel = resolveLanguageModel(provider, apiKey, model)
  try {
    const schemaContext = buildPlannerSchemaContext()
    const toolCatalog = formatAiToolCatalogForPrompt()
    const result = await generateText({
      model: languageModel,
      system: AGENT_QUERY_PLANNER_SYSTEM_PROMPT,
      prompt: `Question:\n${query}\n\nAvailable semantic datasets:\n${schemaContext}\n\nAvailable tools:\n${toolCatalog}`,
      temperature: 0,
      maxOutputTokens: 360,
      timeout: REQUEST_TIMEOUT_MS,
    })

    const planned = parseQueryAgentPlan(result.text, query, fallbackLimit) ?? (REQUIRE_LLM_FOR_AI_SEARCH ? null : heuristicPlan)
    aiPlannerCache.set(plannerCacheKey, {
      expiresAt: Date.now() + 60_000,
      plan: planned,
    })
    return planned
  } catch (error) {
    console.error("Agent query planner failed", error)
    const fallbackPlan = REQUIRE_LLM_FOR_AI_SEARCH ? null : heuristicPlan
    aiPlannerCache.set(plannerCacheKey, {
      expiresAt: Date.now() + 30_000,
      plan: fallbackPlan,
    })
    return fallbackPlan
  }
}

function toStructuredIntentFromAgent(plan: QueryAgentPlan): StructuredIntent {
  const entity = ENTITY_INTENTS.find((item) => item.type === plan.entityType)
  return {
    kind: "structured",
    operation: "list",
    entityType: plan.entityType,
    entityLabel: entity?.label ?? formatEntityType(plan.entityType).toLowerCase(),
    entityTokens: entity?.tokens ?? [plan.entityType],
    statuses: plan.statuses,
    textQuery: plan.textQuery,
    limit: plan.limit,
  }
}

function toAnalyticsIntentFromAgent(plan: QueryAgentPlan): AnalyticsIntent {
  return {
    kind: "analytics",
    operation: "aggregate",
    entityType: plan.entityType,
    metric: plan.metric,
    groupBy: plan.groupBy,
    statuses: plan.statuses,
    textQuery: plan.textQuery,
    projectName: plan.projectName,
    dateRangeDays: plan.dateRangeDays,
    limit: plan.limit,
  }
}

function parseQueryDomainClassification(raw: string): QueryDomainClassification | null {
  const candidate = cleanJsonCandidate(raw)
  const segments = [candidate]
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start >= 0 && end > start) {
    segments.push(raw.slice(start, end + 1).trim())
  }

  for (const segment of segments) {
    try {
      const parsed = JSON.parse(segment) as {
        domain?: unknown
        confidence?: unknown
        reason?: unknown
      }

      const domain =
        typeof parsed.domain === "string" ? (parsed.domain.trim().toLowerCase() as QueryDomain) : undefined
      if (domain !== "org" && domain !== "general" && domain !== "social") {
        continue
      }

      const confidence =
        typeof parsed.confidence === "string"
          ? (parsed.confidence.trim().toLowerCase() as QueryDomainConfidence)
          : "low"
      const normalizedConfidence: QueryDomainConfidence =
        confidence === "low" || confidence === "medium" || confidence === "high" ? confidence : "low"
      const reason = typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : "No reason provided."

      return {
        domain,
        confidence: normalizedConfidence,
        reason,
      }
    } catch {
      continue
    }
  }

  return null
}

async function classifyQueryDomainWithLlm(query: string, provider: AiProvider, model: string): Promise<QueryDomainClassification | null> {
  const apiKey = getApiKeyForProvider(provider)
  if (!apiKey) return null

  const languageModel = resolveLanguageModel(provider, apiKey, model)
  try {
    const result = await generateText({
      model: languageModel,
      system: QUERY_DOMAIN_CLASSIFIER_SYSTEM_PROMPT,
      prompt: `Question:\n${query}`,
      temperature: 0,
      maxOutputTokens: 120,
      timeout: REQUEST_TIMEOUT_MS,
    })
    return parseQueryDomainClassification(result.text)
  } catch (error) {
    console.error("Query domain classification failed", error)
    return null
  }
}

async function resolveAssistantMode(
  requestedMode: AskAiSearchOptions["mode"],
  flags: AiSearchRuntimeFlags,
  query: string,
  provider: AiProvider,
  model: string,
): Promise<"org" | "general"> {
  if (requestedMode === "org") {
    return "org"
  }

  if (requestedMode === "general") {
    return "general"
  }

  // Auto mode: keep org-grounded behavior unless the prompt is clearly general.
  if (isGreetingOrSmallTalkQuery(query)) {
    return "general"
  }

  const hasEntityMentions = detectEntityMentions(query).length > 0
  const hasOrgContextHint = ORG_CONTEXT_HINT_RE.test(query)
  const hasBusinessMetricHint = ORG_BUSINESS_METRIC_HINT_RE.test(query)
  const hasSubjectHint = ORG_SUBJECT_HINT_RE.test(query)
  const hasRelativeTimeHint = CLARIFICATION_TIME_RANGE_RE.test(query)

  if (hasEntityMentions || hasOrgContextHint) {
    return "org"
  }
  if (hasBusinessMetricHint && (hasSubjectHint || hasRelativeTimeHint)) {
    return "org"
  }

  const classified = await classifyQueryDomainWithLlm(query, provider, model)
  if (classified?.domain === "org") {
    return "org"
  }
  if (classified?.domain === "general" || classified?.domain === "social") {
    return "general"
  }

  if (GENERAL_KNOWLEDGE_HINT_RE.test(query)) {
    return "general"
  }
  if (isLikelyGeneralNonOrgQuery(query)) {
    return "general"
  }

  return "org"
}

function detectEntityMentions(query: string): SearchEntityType[] {
  const lower = normalizeSpellingHints(query).toLowerCase()
  const matches: SearchEntityType[] = []
  for (const entity of ENTITY_INTENTS) {
    if (entity.aliases.some((pattern) => pattern.test(lower))) {
      if (!matches.includes(entity.type)) {
        matches.push(entity.type)
      }
    }
  }

  const schemaEntities = Array.from(
    new Set<SearchEntityType>([
      ...(Object.keys(COUNT_QUERY_CONFIGS) as SearchEntityType[]),
      ...(Object.keys(ANALYTICS_ENTITY_CONFIGS) as SearchEntityType[]),
    ]),
  )
  for (const entityType of schemaEntities) {
    if (matches.includes(entityType)) continue
    const explicitPattern = new RegExp(`\\b${entityType.replace(/_/g, "[ _-]?")}s?\\b`, "i")
    if (explicitPattern.test(lower)) {
      matches.push(entityType)
      continue
    }

    const parts = entityType.split("_").filter((part) => part.length > 0)
    if (parts.length === 0) continue
    const phrasePattern = new RegExp(`\\b${parts.join("[\\s_-]+")}s?\\b`, "i")
    if (phrasePattern.test(lower)) {
      matches.push(entityType)
    }
  }

  return matches
}

function isGreetingOrSmallTalkQuery(query: string) {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return false
  if (SOCIAL_GREETING_RE.test(normalized)) return true
  if (SMALL_TALK_RE.test(normalized)) return true
  return false
}

function isLikelyGeneralNonOrgQuery(query: string) {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return false
  if (isGreetingOrSmallTalkQuery(normalized)) return true
  if (ASSISTANT_META_HINT_RE.test(normalized) && !ORG_CONTEXT_HINT_RE.test(normalized)) return true
  if (detectEntityMentions(normalized).length > 0) return false
  if (ORG_CONTEXT_HINT_RE.test(normalized)) return false
  if (ORG_BUSINESS_METRIC_HINT_RE.test(normalized) && (ORG_SUBJECT_HINT_RE.test(normalized) || CLARIFICATION_TIME_RANGE_RE.test(normalized))) {
    return false
  }
  if (GENERAL_KNOWLEDGE_HINT_RE.test(normalized)) return true
  if (GENERAL_QUESTION_START_RE.test(normalized)) return true
  if (normalized.endsWith("?") && normalized.split(/\s+/).length <= 10) return true
  return false
}

function isAssistantRuntimeInfoQuery(query: string) {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return false
  if (!ASSISTANT_META_HINT_RE.test(normalized)) return false
  return ASSISTANT_RUNTIME_INFO_RE.test(normalized)
}

function buildGreetingResponse(query: string) {
  const lower = query.trim().toLowerCase()
  if (/\b(thanks|thank you)\b/.test(lower)) {
    return "You’re welcome. Ask me anything about your company data, or ask a general question."
  }
  if (/\b(bye|goodbye)\b/.test(lower)) {
    return "Any time. I’m here whenever you need help with company data or quick questions."
  }
  if (/\bwhat can you do\b/.test(lower)) {
    return "I can answer company questions, find records, summarize status, and draft actions like tasks or messages."
  }
  return "Hi. I can help with company questions like invoices, projects, approvals, and tasks, or answer general questions."
}

function requiresClarification({
  query,
  mode,
  sessionContext,
}: {
  query: string
  mode: "org" | "general"
  sessionContext: string
}) {
  if (mode !== "org") return null
  const normalized = query.trim()
  if (!normalized) return null

  const mentionedEntities = detectEntityMentions(normalized)
  const asksBroadAnalysis = NON_STRUCTURED_HINT_RE.test(normalized.toLowerCase()) || CROSS_DOMAIN_INTENT_RE.test(normalized)
  const mentionsTimeRange = CLARIFICATION_TIME_RANGE_RE.test(normalized)

  if (CLARIFICATION_SCOPE_PRONOUN_RE.test(normalized) && sessionContext.trim().length === 0) {
    return "Can you clarify what “that” refers to and which project or records you want me to use?"
  }

  if (asksBroadAnalysis && mentionedEntities.length === 0 && !mentionsTimeRange) {
    return "Do you want this org-wide, or for a specific project and time range?"
  }

  return null
}

async function generateGeneralAssistantAnswer({
  query,
  provider,
  model,
  sessionContext,
}: {
  query: string
  provider: AiProvider
  model: string
  sessionContext?: string
}): Promise<GeneralAssistantAnswer | null> {
  const apiKey = getApiKeyForProvider(provider)
  if (!apiKey) return null

  const languageModel = resolveLanguageModel(provider, apiKey, model)
  try {
    const contextBlock = sessionContext?.trim() ? `\n\nRecent conversation context:\n${sessionContext.trim()}` : ""
    const result = await generateText({
      model: languageModel,
      system: GENERAL_ASSISTANT_SYSTEM_PROMPT,
      prompt: `User question:\n${query}${contextBlock}`,
      temperature: 0.4,
      maxOutputTokens: 700,
      timeout: REQUEST_TIMEOUT_MS,
    })

    const answer = result.text.trim()
    if (!answer) return null
    return {
      answer,
      provider,
      model,
    }
  } catch (error) {
    console.error("General assistant generation failed", error)
    return null
  }
}

function getOpenAiApiKeyForEmbeddings() {
  const explicit = process.env.OPENAI_API_KEY?.trim()
  if (explicit) return explicit
  if (getOpenAiBaseUrl()) {
    return process.env.OPENAI_COMPAT_API_KEY?.trim() || "local-dev-key"
  }
  return undefined
}

function getEmbeddingApiBaseUrl() {
  const configured = getOpenAiBaseUrl()
  if (configured) {
    return configured.endsWith("/") ? configured.slice(0, -1) : configured
  }
  return "https://api.openai.com/v1"
}

function normalizeEmbeddingInput(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, EMBEDDING_INPUT_MAX_CHARS)
}

function toPgVectorLiteral(values: number[]) {
  const normalized = values
    .filter((value) => Number.isFinite(value))
    .map((value) => Number(value).toFixed(8))
  return `[${normalized.join(",")}]`
}

async function generateOpenAiEmbeddingVector(input: string) {
  const apiKey = getOpenAiApiKeyForEmbeddings()
  if (!apiKey) return null

  const normalizedInput = normalizeEmbeddingInput(input)
  if (!normalizedInput) return null

  try {
    const endpoint = `${getEmbeddingApiBaseUrl()}/embeddings`
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: normalizedInput,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) {
      return null
    }

    const payload = (await response.json()) as {
      data?: Array<{ embedding?: unknown }>
    }
    const embedding = payload.data?.[0]?.embedding
    if (!Array.isArray(embedding)) {
      return null
    }

    const vector = embedding
      .map((value) => (typeof value === "number" && Number.isFinite(value) ? value : null))
      .filter((value): value is number => value !== null)
    return vector.length > 0 ? vector : null
  } catch {
    return null
  }
}

function toSearchResultFromSemanticRow(raw: SemanticSearchRow): SearchResult | null {
  const type = normalizeEntityType(raw.entity_type)
  if (!type) return null
  const id = typeof raw.entity_id === "string" ? raw.entity_id : null
  if (!id) return null

  const metadata = raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {}
  const typedMetadata = metadata as Record<string, unknown>
  const href =
    typeof typedMetadata.href === "string" && typedMetadata.href.length > 0
      ? typedMetadata.href
      : ENTITY_HREF_FALLBACKS[type].replace("{id}", id)

  const title = typeof raw.title === "string" && raw.title.trim().length > 0 ? raw.title : `Untitled ${type}`
  const score = Number.isFinite(raw.similarity) ? raw.similarity : 0

  return {
    id,
    type,
    title,
    href,
    subtitle: typeof typedMetadata.subtitle === "string" ? typedMetadata.subtitle : undefined,
    description: typeof typedMetadata.description === "string" ? typedMetadata.description : undefined,
    project_id: typeof raw.project_id === "string" ? raw.project_id : undefined,
    project_name: typeof typedMetadata.project_name === "string" ? typedMetadata.project_name : undefined,
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : undefined,
    score,
  }
}

async function searchSemanticDocuments({
  context,
  query,
  entityTypes,
  limit,
}: {
  context: ResolvedOrgContext
  query: string
  entityTypes: SearchEntityType[]
  limit: number
}): Promise<SearchResult[]> {
  const vector = await generateOpenAiEmbeddingVector(query)
  if (!vector) return []

  const { data, error } = await context.supabase.rpc("match_search_embeddings", {
    p_org_id: context.orgId,
    p_query_embedding: toPgVectorLiteral(vector),
    p_limit: Math.max(4, Math.min(limit, SEMANTIC_RETRIEVAL_LIMIT)),
    p_entity_types: entityTypes.length > 0 ? entityTypes : null,
  })

  if (error || !Array.isArray(data)) {
    if (error) {
      console.error("Semantic retrieval query failed", error)
    }
    return []
  }

  return data
    .map((item) => toSearchResultFromSemanticRow(item as SemanticSearchRow))
    .filter((item): item is SearchResult => Boolean(item))
}

function mergeHybridResults(lexical: SearchResult[], semantic: SearchResult[], limit: number) {
  const merged = new Map<string, { result: SearchResult; score: number }>()

  lexical.forEach((item, index) => {
    const key = `${item.type}:${item.id}`
    const lexicalScore = 80 - index
    const previous = merged.get(key)
    if (!previous || lexicalScore > previous.score) {
      merged.set(key, {
        result: {
          ...item,
          score: Math.max(item.score ?? 0, lexicalScore),
        },
        score: lexicalScore,
      })
    }
  })

  semantic.forEach((item, index) => {
    const key = `${item.type}:${item.id}`
    const semanticScore = (item.score ?? 0) * 100 + (40 - index)
    const previous = merged.get(key)
    if (!previous || semanticScore > previous.score) {
      merged.set(key, {
        result: {
          ...previous?.result,
          ...item,
          score: Math.max(previous?.result.score ?? 0, item.score ?? 0),
        },
        score: semanticScore,
      })
      return
    }

    merged.set(key, {
      result: {
        ...item,
        ...previous.result,
        score: Math.max(previous.result.score ?? 0, item.score ?? 0),
      },
      score: previous.score,
    })
  })

  return Array.from(merged.values())
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      const aTime = new Date(a.result.updated_at ?? a.result.created_at ?? 0).getTime()
      const bTime = new Date(b.result.updated_at ?? b.result.created_at ?? 0).getTime()
      return bTime - aTime
    })
    .map((entry) => entry.result)
    .slice(0, limit)
}

function toEmbeddingContent(result: SearchResult) {
  return [formatEntityType(result.type), result.title, result.subtitle, result.description, result.project_name]
    .filter((part): part is string => Boolean(part && part.trim().length > 0))
    .join("\n")
}

async function ensureSemanticEmbeddingsForResults(context: ResolvedOrgContext, results: SearchResult[]) {
  if (results.length === 0) return
  if (!getOpenAiApiKeyForEmbeddings()) return

  const candidates = results.slice(0, MAX_EMBEDDING_BACKFILL_DOCS)
  for (const result of candidates) {
    const { data: doc, error: docError } = await context.supabase
      .from("search_documents")
      .select("id")
      .eq("org_id", context.orgId)
      .eq("entity_type", result.type)
      .eq("entity_id", result.id)
      .maybeSingle()

    if (docError || !doc?.id) {
      continue
    }

    const { data: existing, error: existingError } = await context.supabase
      .from("search_embeddings")
      .select("id")
      .eq("org_id", context.orgId)
      .eq("document_id", doc.id)
      .eq("model", EMBEDDING_MODEL)
      .limit(1)
      .maybeSingle()

    if (existingError || existing?.id) {
      continue
    }

    const embedding = await generateOpenAiEmbeddingVector(toEmbeddingContent(result))
    if (!embedding || embedding.length === 0) continue

    await context.supabase.from("search_embeddings").upsert(
      {
        document_id: doc.id,
        org_id: context.orgId,
        model: EMBEDDING_MODEL,
        embedding: toPgVectorLiteral(embedding),
      },
      { onConflict: "document_id,model" },
    )
  }
}

async function retrieveHybridResults({
  context,
  query,
  entityTypes,
  filters,
  limit,
  enableHybrid,
}: {
  context: ResolvedOrgContext
  query: string
  entityTypes: SearchEntityType[]
  filters: { projectId?: string; status?: string[] }
  limit: number
  enableHybrid: boolean
}) {
  const lexical = await searchEntities(
    query,
    entityTypes,
    filters,
    { limit, sortBy: "updated_at" },
    context.orgId,
    context,
  )

  const lexicalDeduped = dedupeResults(lexical)
  let merged = lexicalDeduped.slice(0, limit)
  const hasStrongLexicalCoverage = lexicalDeduped.length >= Math.min(limit, SEMANTIC_SKIP_LEXICAL_THRESHOLD)

  if (enableHybrid && query.trim().length > 0 && !hasStrongLexicalCoverage) {
    const semantic = await searchSemanticDocuments({
      context,
      query,
      entityTypes,
      limit: Math.min(SEMANTIC_RETRIEVAL_LIMIT, Math.max(limit, 12)),
    })
    merged = mergeHybridResults(merged, semantic, limit)
  }

  void ensureSemanticEmbeddingsForResults(context, merged)

  return merged
}

function buildMultiStepPlans(query: string, basePlan: QueryAgentPlan, maxSteps = 3): QueryAgentPlan[] {
  const plans: QueryAgentPlan[] = [basePlan]
  const mentioned = Array.from(
    new Set<SearchEntityType>([...(basePlan.relatedEntityTypes ?? []), ...detectEntityMentions(query)]),
  )
  if (mentioned.length <= 1 && !CROSS_DOMAIN_INTENT_RE.test(query)) {
    return plans
  }

  for (const entityType of mentioned) {
    if (entityType === basePlan.entityType) continue
    const hasAnalytics = Boolean(ANALYTICS_ENTITY_CONFIGS[entityType])
    const metricHint = hasAnalytics ? normalizeAnalyticsMetric(basePlan.metric, entityType) : "count"
    const groupByHint = hasAnalytics ? normalizeAnalyticsGroupBy(basePlan.groupBy, entityType) : "none"
    const statuses = normalizePlannerStatuses(basePlan.statuses, entityType)

    plans.push({
      ...basePlan,
      operation: hasAnalytics ? "aggregate" : "list",
      entityType,
      metric: hasAnalytics ? metricHint : "count",
      groupBy: hasAnalytics ? groupByHint : "none",
      statuses,
      limit: Math.max(5, Math.min(basePlan.limit, 12)),
    })
    if (plans.length >= maxSteps) break
  }

  return plans
}

function mergeQueryAgentStepExecutions(orgId: string, stepExecutions: QueryAgentStepExecution[]): QueryAgentExecution {
  const mergedResults = dedupeResults(stepExecutions.flatMap((item) => item.execution.relatedResults))
  const rowCount = stepExecutions.reduce((acc, item) => acc + item.execution.rowCount, 0)
  const confidenceOrder = { low: 0, medium: 1, high: 2 } as const
  const mergedConfidence = stepExecutions.reduce<"low" | "medium" | "high">((acc, item) => {
    return confidenceOrder[item.execution.confidence] > confidenceOrder[acc] ? item.execution.confidence : acc
  }, "low")
  const missingData = Array.from(
    new Set(
      stepExecutions.flatMap((item) => item.execution.missingData).filter((value) => value.trim().length > 0),
    ),
  )

  const contextLines = stepExecutions.map((item) => {
    const metricLabel =
      item.step.metric === "count" ? "count" : item.step.metric === "avg_amount" ? "avg_amount" : "sum_amount"
    return `Step ${formatEntityType(item.step.entityType)} -> op=${item.step.operation}, metric=${metricLabel}, rows=${item.execution.rowCount}`
  })

  const answerFallback = stepExecutions
    .map((item) => item.execution.answerFallback.trim())
    .filter((line) => line.length > 0)
    .slice(0, 3)
    .join("\n\n")

  const tableArtifact = buildTableArtifact({
    orgId,
    title: "Cross-domain summary",
    columns: ["Entity", "Operation", "Rows"],
    rows: stepExecutions.map((item) => [formatEntityType(item.step.entityType), item.step.operation, item.execution.rowCount]),
  })

  return {
    answerFallback: answerFallback || `I analyzed ${stepExecutions.length} data slices and found ${rowCount.toLocaleString()} records.`,
    relatedResults: mergedResults.slice(0, 16),
    rowCount,
    additionalContext: contextLines.join("\n"),
    artifactData: tableArtifact ?? stepExecutions[0]?.execution.artifactData ?? {},
    confidence: mergedConfidence,
    missingData,
  }
}

async function recordAiSearchEvent({
  context,
  sessionId,
  query,
  assistantMode,
  success,
  error,
  plan,
  metrics,
  citationsCount,
  resultsCount,
  latencyMs,
}: {
  context: ResolvedOrgContext
  sessionId: string
  query: string
  assistantMode: "org" | "general"
  success: boolean
  error?: string
  plan?: Record<string, unknown>
  metrics?: Record<string, unknown>
  citationsCount: number
  resultsCount: number
  latencyMs: number
}) {
  try {
    await context.supabase.from("ai_search_events").insert({
      org_id: context.orgId,
      user_id: context.userId,
      session_id: sessionId,
      query,
      assistant_mode: assistantMode,
      success,
      error: error ?? null,
      plan: plan ?? {},
      metrics: metrics ?? {},
      citations_count: citationsCount,
      results_count: resultsCount,
      latency_ms: Math.max(0, Math.round(latencyMs)),
    })
  } catch (eventError) {
    console.error("Failed to persist AI search event", eventError)
  }
}

async function executeQueryAgentPlan(
  plan: QueryAgentPlan,
  context: Awaited<ReturnType<typeof requireOrgContext>>,
  options: { enableHybridRetrieval?: boolean } = {},
): Promise<QueryAgentExecution> {
  const enableHybridRetrieval = options.enableHybridRetrieval === true
  if (plan.operation === "aggregate") {
    const execution = await executeAnalyticsToolLayer(toAnalyticsIntentFromAgent(plan), context, {
      enableHybridRetrieval,
    })
    const metricLabel =
      plan.metric === "count" ? "count" : plan.metric === "avg_amount" ? "average amount (USD)" : "total amount (USD)"
    const additionalContext = [
      "Agent execution",
      `Operation: aggregate`,
      `Entity: ${plan.entityType}`,
      `Metric: ${metricLabel}`,
      `GroupBy: ${plan.groupBy}`,
      `Rows: ${execution.rowCount}`,
      ...execution.buckets.slice(0, 8).map((bucket) => `Bucket ${bucket.label}: metric=${bucket.metricValue}; count=${bucket.count}`),
    ].join("\n")
    return {
      answerFallback: execution.answer,
      relatedResults: execution.relatedResults,
      rowCount: execution.rowCount,
      additionalContext,
      artifactData: buildArtifactForAnalyticsIntent({ orgId: context.orgId, execution }),
      confidence: execution.rowCount >= 10 ? "high" : execution.rowCount > 0 ? "medium" : "low",
      missingData:
        execution.rowCount > 0
          ? []
          : [`No ${pluralize(formatEntityType(plan.entityType).toLowerCase(), 2)} matched this scope.`],
    }
  }

  const execution = await executeStructuredToolLayer(toStructuredIntentFromAgent(plan), context, {
    enableHybridRetrieval,
  })
  const rowCount = execution.totalCount ?? execution.relatedResults.length
  const additionalContext = [
    "Agent execution",
    "Operation: list",
    `Entity: ${plan.entityType}`,
    `Rows: ${rowCount}`,
  ].join("\n")
  return {
    answerFallback: execution.answer,
    relatedResults: execution.relatedResults,
    rowCount,
    additionalContext,
    artifactData: buildArtifactForStructuredIntent(context.orgId, toStructuredIntentFromAgent(plan), execution),
    confidence: rowCount >= 8 ? "high" : rowCount > 0 ? "medium" : "low",
    missingData: rowCount > 0 ? [] : [`No ${pluralize(formatEntityType(plan.entityType).toLowerCase(), 2)} matched this scope.`],
  }
}

function normalizePlanForEntity(plan: QueryAgentPlan, entityType: SearchEntityType): QueryAgentPlan {
  const normalizedStatuses = normalizePlannerStatuses(plan.statuses, entityType)
  return {
    ...plan,
    entityType,
    statuses: normalizedStatuses,
    metric: normalizeAnalyticsMetric(plan.metric, entityType),
    groupBy: normalizeAnalyticsGroupBy(plan.groupBy, entityType),
  }
}

function buildAgentRepairCandidates(plan: QueryAgentPlan): QueryAgentPlan[] {
  const variants: QueryAgentPlan[] = [plan]
  if (plan.textQuery.trim().length > 0) {
    variants.push({ ...plan, textQuery: "" })
  }
  if (plan.dateRangeDays) {
    variants.push({ ...plan, dateRangeDays: undefined })
  }
  if (plan.textQuery.trim().length > 0 && plan.dateRangeDays) {
    variants.push({ ...plan, textQuery: "", dateRangeDays: undefined })
  }

  const fallbackEntities = ENTITY_SEMANTIC_FALLBACKS[plan.entityType] ?? []
  for (const fallbackEntity of fallbackEntities.slice(0, 3)) {
    const normalizedFallback = normalizePlanForEntity(plan, fallbackEntity)
    variants.push(normalizedFallback)
    if (normalizedFallback.textQuery.trim().length > 0) {
      variants.push({ ...normalizedFallback, textQuery: "" })
    }
  }

  const deduped: QueryAgentPlan[] = []
  const seen = new Set<string>()
  for (const candidate of variants) {
    const key = JSON.stringify(candidate)
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(candidate)
    if (deduped.length >= 9) break
  }
  return deduped
}

async function executeQueryAgentWithRepairs(
  plan: QueryAgentPlan,
  context: Awaited<ReturnType<typeof requireOrgContext>>,
  options: { enableHybridRetrieval?: boolean } = {},
): Promise<{ finalPlan: QueryAgentPlan; execution: QueryAgentExecution }> {
  const attempts = buildAgentRepairCandidates(plan)
  const [firstAttempt, ...remainingAttempts] = attempts
  const initialPlan = firstAttempt ?? plan

  let bestPlan = initialPlan
  let bestExecution = await executeQueryAgentPlan(initialPlan, context, options)

  if (bestExecution.rowCount > 0) {
    return { finalPlan: bestPlan, execution: bestExecution }
  }

  for (const candidate of remainingAttempts) {
    const candidateExecution = await executeQueryAgentPlan(candidate, context, options)
    if (candidateExecution.rowCount > bestExecution.rowCount) {
      bestExecution = candidateExecution
      bestPlan = candidate
    }
    if (candidateExecution.rowCount > 0) {
      return { finalPlan: candidate, execution: candidateExecution }
    }
  }

  return { finalPlan: bestPlan, execution: bestExecution }
}

async function executeMultiStepQueryAgentPlan({
  context,
  query,
  basePlan,
  enableMultiStep,
  enableHybridRetrieval,
}: {
  context: Awaited<ReturnType<typeof requireOrgContext>>
  query: string
  basePlan: QueryAgentPlan
  enableMultiStep: boolean
  enableHybridRetrieval: boolean
}): Promise<{ finalPlan: QueryAgentPlan; execution: QueryAgentExecution; stepPlans: QueryAgentPlan[] }> {
  const stepPlans = enableMultiStep ? buildMultiStepPlans(query, basePlan) : [basePlan]
  if (stepPlans.length <= 1) {
    const single = await executeQueryAgentWithRepairs(basePlan, context, { enableHybridRetrieval })
    return { finalPlan: single.finalPlan, execution: single.execution, stepPlans: [single.finalPlan] }
  }

  const stepExecutions = (
    await Promise.all(
      stepPlans.map(async (stepPlan) => {
        const step = await executeQueryAgentWithRepairs(stepPlan, context, { enableHybridRetrieval })
        return {
          step: step.finalPlan,
          execution: step.execution,
        } satisfies QueryAgentStepExecution
      }),
    )
  ).filter((item): item is QueryAgentStepExecution => Boolean(item))

  const merged = mergeQueryAgentStepExecutions(context.orgId, stepExecutions)
  return {
    finalPlan: stepExecutions[0]?.step ?? basePlan,
    execution: merged,
    stepPlans: stepExecutions.map((item) => item.step),
  }
}

function buildPlannerRequeryCandidates({
  normalizedQuery,
  plannerQuery,
  sessionContext,
}: {
  normalizedQuery: string
  plannerQuery: string
  sessionContext: string
}) {
  const candidates = [
    plannerQuery,
    normalizedQuery,
    extractRetrievalQuery(normalizedQuery),
    sessionContext
      ? `${normalizedQuery}\nFocus on organization records, and infer the most likely dataset and time range.`
      : "",
  ]
    .map((candidate) => normalizeQuery(candidate))
    .filter((candidate) => candidate.length > 0)

  const unique: string[] = []
  for (const candidate of candidates) {
    if (unique.includes(candidate)) continue
    unique.push(candidate)
    if (unique.length >= PLANNER_LOOP_MAX_ATTEMPTS) break
  }
  return unique
}

async function runPlannerExecutorLoop({
  normalizedQuery,
  plannerQuery,
  sessionContext,
  provider,
  model,
  limit,
  context,
  runtimeFlags,
}: {
  normalizedQuery: string
  plannerQuery: string
  sessionContext: string
  provider: AiProvider
  model: string
  limit: number
  context: Awaited<ReturnType<typeof requireOrgContext>>
  runtimeFlags: AiSearchRuntimeFlags
}) {
  const candidateQueries = buildPlannerRequeryCandidates({
    normalizedQuery,
    plannerQuery,
    sessionContext,
  })

  let bestResult: {
    attempt: number
    plannedFromQuery: string
    agentPlan: QueryAgentPlan
    finalPlan: QueryAgentPlan
    execution: QueryAgentExecution
    stepPlans: QueryAgentPlan[]
  } | null = null

  for (let index = 0; index < candidateQueries.length; index += 1) {
    const planningQuery = candidateQueries[index] ?? normalizedQuery
    const agentPlan = await planQueryWithAgent(planningQuery, provider, model, limit)
    if (!agentPlan) continue

    const { finalPlan, execution, stepPlans } = await executeMultiStepQueryAgentPlan({
      context,
      query: normalizedQuery,
      basePlan: agentPlan,
      enableMultiStep: runtimeFlags.multiStepPlanning,
      enableHybridRetrieval: runtimeFlags.hybridRetrieval,
    })

    const score = execution.rowCount * 10 + (execution.confidence === "high" ? 3 : execution.confidence === "medium" ? 2 : 1)
    const bestScore = bestResult
      ? bestResult.execution.rowCount * 10 +
        (bestResult.execution.confidence === "high" ? 3 : bestResult.execution.confidence === "medium" ? 2 : 1)
      : -1

    if (!bestResult || score > bestScore) {
      bestResult = {
        attempt: index + 1,
        plannedFromQuery: planningQuery,
        agentPlan,
        finalPlan,
        execution,
        stepPlans,
      }
    }

    if (execution.rowCount > 0 && execution.confidence !== "low") {
      break
    }
  }

  return bestResult
}

function verifyGroundedAnswer({
  llmAnswer,
  sources,
  fallbackAnswer,
  rowCount,
  baseConfidence,
  missingData,
}: {
  llmAnswer: LlmAnswer | null
  sources: RetrievedSource[]
  fallbackAnswer: string
  rowCount: number
  baseConfidence: "low" | "medium" | "high"
  missingData?: string[]
}): GroundedAnswerVerification {
  const nextMissingData = [...(missingData ?? [])]
  const defaultCitationIds = sources.slice(0, Math.min(2, MAX_CITATIONS)).map((source) => source.sourceId)

  if (!llmAnswer) {
    if (sources.length > 0 && defaultCitationIds.length === 0) {
      nextMissingData.push("No usable citations were generated from grounded sources.")
    }
    return {
      answer: fallbackAnswer,
      citationIds: defaultCitationIds,
      downgradedToFallback: true,
      confidence: "low",
      missingData: Array.from(new Set(nextMissingData)),
      notes: ["No model answer was available, so deterministic fallback was used."],
    }
  }

  const rawAnswer = llmAnswer.answer.trim()
  const hasNumericClaims = /\$?\d[\d,.]*/.test(rawAnswer)
  const citationIds = llmAnswer.citationIds.filter((id) => sources.some((source) => source.sourceId === id))
  const notes: string[] = []
  let downgraded = false
  let answer = rawAnswer
  let confidence = baseConfidence

  if (sources.length > 0 && citationIds.length === 0) {
    notes.push("Model answer omitted citations.")
    if (defaultCitationIds.length > 0) {
      citationIds.push(...defaultCitationIds)
      if (!nextMissingData.includes("Citations were auto-recovered from top grounded records.")) {
        nextMissingData.push("Citations were auto-recovered from top grounded records.")
      }
    }
  }

  if (rowCount === 0 && hasNumericClaims) {
    downgraded = true
    notes.push("Numeric claims were rejected because no grounded rows were returned.")
    if (!nextMissingData.includes("No grounded rows supported numeric claims.")) {
      nextMissingData.push("No grounded rows supported numeric claims.")
    }
  }

  if (answer.length < 16 && rowCount > 0) {
    downgraded = true
    notes.push("Model answer was too short for grounded synthesis.")
  }

  if (downgraded) {
    answer = fallbackAnswer
    confidence = "low"
  }

  return {
    answer,
    citationIds: citationIds.length > 0 ? citationIds : defaultCitationIds,
    downgradedToFallback: downgraded,
    confidence,
    missingData: Array.from(new Set(nextMissingData)),
    notes,
  }
}

async function emitTrace(
  options: AskAiSearchOptions,
  payload: Omit<AiSearchTraceEvent, "timestamp">,
) {
  if (!options.onTrace) return
  const thought =
    payload.thought?.trim() ||
    payload.detail?.trim() ||
    (payload.label.trim().endsWith(".") ? payload.label.trim() : `${payload.label.trim()}.`)
  try {
    await options.onTrace({
      ...payload,
      thought,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("AI trace emission failed", error)
  }
}

function dedupeResults(results: SearchResult[]) {
  const unique: SearchResult[] = []
  const seen = new Set<string>()

  for (const result of results) {
    const key = `${result.type}:${result.id}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(result)
  }

  return unique
}

function formatEntityType(type: SearchEntityType) {
  return type
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function toStatusLabel(status: string) {
  return status.replace(/_/g, " ")
}

function formatStatusPhrase(statuses: string[]) {
  if (statuses.length === 0) return ""
  if (statuses.length === 1) return toStatusLabel(statuses[0] ?? "")
  if (statuses.length === 2) {
    return `${toStatusLabel(statuses[0] ?? "")} or ${toStatusLabel(statuses[1] ?? "")}`
  }
  return `${statuses.slice(0, -1).map(toStatusLabel).join(", ")}, or ${toStatusLabel(statuses[statuses.length - 1] ?? "")}`
}

function pluralize(word: string, count: number) {
  if (count === 1) return word
  if (word.endsWith("s")) return word
  return `${word}s`
}

function buildStructuredListAnswer(intent: StructuredIntent, relatedResults: SearchResult[]) {
  const statusPrefix = intent.statuses.length > 0 ? `${formatStatusPhrase(intent.statuses)} ` : ""
  if (relatedResults.length === 0) {
    return `I found no ${statusPrefix}${pluralize(intent.entityLabel, 2)} in your org for this query.`
  }

  const heading = `Here ${relatedResults.length === 1 ? "is" : "are"} ${relatedResults.length} ${statusPrefix}${pluralize(intent.entityLabel, relatedResults.length)}:`
  const lines = relatedResults.slice(0, intent.limit).map((item) => {
    const projectPart = item.project_name ? ` (${item.project_name})` : ""
    return `- ${item.title}${projectPart}`
  })

  return [heading, ...lines].join("\n")
}

function buildStructuredCountAnswer(intent: StructuredIntent, count: number, relatedResults: SearchResult[]) {
  const statusPrefix = intent.statuses.length > 0 ? `${formatStatusPhrase(intent.statuses)} ` : ""
  const entityLabel = pluralize(intent.entityLabel, count)
  if (count <= 0) {
    return `You currently have 0 ${statusPrefix}${entityLabel}.`
  }

  const highlights = relatedResults
    .slice(0, 3)
    .map((item) => item.title)
    .join(", ")

  if (!highlights) {
    return `You currently have ${count} ${statusPrefix}${entityLabel}.`
  }

  return `You currently have ${count} ${statusPrefix}${entityLabel}. Recent examples: ${highlights}.`
}

function buildStructuredListAndCountAnswer(intent: StructuredIntent, count: number, relatedResults: SearchResult[]) {
  const statusPrefix = intent.statuses.length > 0 ? `${formatStatusPhrase(intent.statuses)} ` : ""
  const entityLabel = pluralize(intent.entityLabel, count)

  if (count <= 0) {
    return `You currently have 0 ${statusPrefix}${entityLabel}.`
  }

  const lines = relatedResults.slice(0, intent.limit).map((item) => {
    const projectPart = item.project_name ? ` (${item.project_name})` : ""
    return `- ${item.title}${projectPart}`
  })

  const heading = `You currently have ${count} ${statusPrefix}${entityLabel}. Top ${Math.min(relatedResults.length, intent.limit)}:`
  return [heading, ...lines].join("\n")
}

function buildTextSearchOrCondition(searchFields: string[], rawQuery: string) {
  const cleaned = rawQuery.replace(/[,%()]/g, " ").trim()
  if (!cleaned) return ""
  return searchFields
    .filter((field) => field && !field.includes("."))
    .map((field) => `${field}.ilike.%${cleaned}%`)
    .join(",")
}

async function countStructuredIntentMatches(
  intent: StructuredIntent,
  context: Awaited<ReturnType<typeof requireOrgContext>>,
) {
  const config = COUNT_QUERY_CONFIGS[intent.entityType]
  if (!config) return null

  let queryBuilder = context.supabase.from(config.table).select("id", { count: "exact", head: true }).eq("org_id", context.orgId)

  if (intent.statuses.length > 0 && ENTITY_STATUS_VALUES[intent.entityType]?.length) {
    queryBuilder = queryBuilder.in("status", intent.statuses)
  }

  if (intent.textQuery) {
    const searchCondition = buildTextSearchOrCondition(config.searchableFields, intent.textQuery)
    if (searchCondition) {
      queryBuilder = queryBuilder.or(searchCondition)
    }
  }

  const { count, error } = await queryBuilder
  if (error) {
    console.error("Structured count query failed", {
      entityType: intent.entityType,
      statuses: intent.statuses,
      textQuery: intent.textQuery,
      error,
    })
    return null
  }

  return count ?? 0
}

async function countStructuredStatusBreakdown(
  intent: StructuredIntent,
  context: Awaited<ReturnType<typeof requireOrgContext>>,
): Promise<StatusBreakdownEntry[]> {
  const allowedStatuses = ENTITY_STATUS_VALUES[intent.entityType]
  const config = COUNT_QUERY_CONFIGS[intent.entityType]
  if (!allowedStatuses || allowedStatuses.length === 0 || !config) return []

  const statuses = intent.statuses.length > 0 ? intent.statuses : allowedStatuses
  if (statuses.length === 0) return []

  const counts = await Promise.all(
    statuses.map(async (status) => {
      let queryBuilder = context.supabase
        .from(config.table)
        .select("id", { count: "exact", head: true })
        .eq("org_id", context.orgId)
        .eq("status", status)

      if (intent.textQuery) {
        const searchCondition = buildTextSearchOrCondition(config.searchableFields, intent.textQuery)
        if (searchCondition) {
          queryBuilder = queryBuilder.or(searchCondition)
        }
      }

      const { count, error } = await queryBuilder
      if (error) {
        console.error("Structured status count query failed", {
          entityType: intent.entityType,
          status,
          textQuery: intent.textQuery,
          error,
        })
        return null
      }

      return {
        status,
        count: count ?? 0,
      } satisfies StatusBreakdownEntry
    }),
  )

  return counts
    .filter((entry): entry is StatusBreakdownEntry => entry !== null && entry.count > 0)
    .sort((a, b) => b.count - a.count)
}

async function executeStructuredToolLayer(
  intent: StructuredIntent,
  context: Awaited<ReturnType<typeof requireOrgContext>>,
  options: { enableHybridRetrieval?: boolean } = {},
): Promise<StructuredExecution> {
  const enableHybridRetrieval = options.enableHybridRetrieval === true
  const hasStatusSupport = Boolean(ENTITY_STATUS_VALUES[intent.entityType]?.length)
  const filters = hasStatusSupport && intent.statuses.length > 0 ? { status: intent.statuses } : {}
  const shouldFetchList = intent.operation === "list" || intent.operation === "list_and_count" || intent.operation === "count"
  const listLimit = intent.operation === "count" ? Math.min(8, intent.limit) : intent.limit

  let rawResults = shouldFetchList
    ? await retrieveHybridResults({
        context,
        query: intent.textQuery,
        entityTypes: [intent.entityType],
        filters,
        limit: listLimit,
        enableHybrid: enableHybridRetrieval,
      })
    : []

  // If text filtering over-constrains the query, retry with no free-text filter.
  if (shouldFetchList && rawResults.length === 0 && intent.textQuery.trim().length > 0) {
    rawResults = await retrieveHybridResults({
      context,
      query: "",
      entityTypes: [intent.entityType],
      filters,
      limit: listLimit,
      enableHybrid: false,
    })
  }

  const relatedResults = dedupeResults(rawResults).slice(0, listLimit)
  const [totalCount, statusBreakdown] = await Promise.all([
    intent.operation === "count" || intent.operation === "list_and_count"
      ? countStructuredIntentMatches(intent, context)
      : Promise.resolve(null),
    countStructuredStatusBreakdown(intent, context),
  ])

  let answer = ""
  if (intent.operation === "count") {
    answer = buildStructuredCountAnswer(intent, totalCount ?? relatedResults.length, relatedResults)
  } else if (intent.operation === "list_and_count") {
    answer = buildStructuredListAndCountAnswer(intent, totalCount ?? relatedResults.length, relatedResults)
  } else {
    answer = buildStructuredListAnswer(intent, relatedResults)
  }

  return {
    answer,
    relatedResults,
    totalCount,
    statusBreakdown,
  }
}

async function resolveProjectByName(projectName: string, context: Awaited<ReturnType<typeof requireOrgContext>>) {
  const trimmed = projectName.trim()
  if (!trimmed) return null

  const exact = await context.supabase
    .from("projects")
    .select("id,name")
    .eq("org_id", context.orgId)
    .ilike("name", `%${trimmed}%`)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!exact.error && exact.data?.id && exact.data?.name) {
    return { id: exact.data.id, name: exact.data.name } satisfies ProjectRef
  }

  const tokens = trimmed
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !PROJECT_NAME_NOISE_TOKENS.has(token))
    .slice(0, 6)
  if (tokens.length === 0) return null

  const tokenOrCondition = tokens
    .map((token) => token.replace(/[^a-z0-9&-]/gi, ""))
    .filter((token) => token.length >= 2)
    .map((token) => `name.ilike.%${token}%`)
    .join(",")

  let queryBuilder = context.supabase
    .from("projects")
    .select("id,name")
    .eq("org_id", context.orgId)
    .order("updated_at", { ascending: false })
    .limit(40)

  if (tokenOrCondition) {
    queryBuilder = queryBuilder.or(tokenOrCondition)
  }

  const fuzzy = await queryBuilder
  if (fuzzy.error || !Array.isArray(fuzzy.data) || fuzzy.data.length === 0) {
    return null
  }

  const ranked = fuzzy.data
    .map((candidate) => {
      const id = typeof candidate.id === "string" ? candidate.id : ""
      const name = typeof candidate.name === "string" ? candidate.name : ""
      if (!id || !name) return null
      return {
        id,
        name,
        score: buildProjectCandidateScore(trimmed, name),
      }
    })
    .filter((candidate): candidate is { id: string; name: string; score: number } => Boolean(candidate))
    .sort((a, b) => b.score - a.score)

  if (ranked.length === 0) return null
  const best = ranked[0]
  if (!best || best.score < 120) {
    return null
  }

  return { id: best.id, name: best.name } satisfies ProjectRef
}

async function resolveProjectFromHints(
  context: Awaited<ReturnType<typeof requireOrgContext>>,
  ...hints: Array<string | undefined>
) {
  for (const hint of hints) {
    if (!hint) continue
    const candidate = hint.trim()
    if (candidate.length < 3) continue
    if (tokenizeProjectName(candidate).length === 0) continue

    const resolved = await resolveProjectByName(candidate, context)
    if (resolved) return resolved
  }

  return null
}

async function resolveEntityAttributeCandidate(
  context: Awaited<ReturnType<typeof requireOrgContext>>,
  intent: EntityAttributeIntent,
  query: string,
): Promise<EntityAttributeCandidateResolution> {
  const target = intent.targetHint?.trim() ?? ""

  if (intent.entityType === "project" && target.length >= 2) {
    const project = await resolveProjectByName(target, context)
    if (project) {
      return {
        reason: "match",
        candidate: {
          id: project.id,
          type: "project",
          title: project.name,
          href: ENTITY_HREF_FALLBACKS.project.replace("{id}", project.id),
        },
        suggestions: [],
      }
    }
  }

  const lookupQuery = target.length > 0 ? target : query
  const candidates = await searchEntities(
    lookupQuery,
    [intent.entityType],
    {},
    { limit: 8, sortBy: "updated_at" },
    context.orgId,
    context,
  )
  if (candidates.length === 0) {
    return {
      reason: "not_found",
      suggestions: [],
    }
  }
  if (!target) {
    return {
      reason: "match",
      candidate: candidates[0] ?? undefined,
      suggestions: candidates.slice(0, 3),
    }
  }

  const ranked = candidates
    .map((candidate) => ({
      candidate,
      score: buildProjectCandidateScore(target, candidate.title),
    }))
    .sort((a, b) => b.score - a.score)

  const best = ranked[0]
  if (!best) {
    return {
      reason: "not_found",
      suggestions: candidates.slice(0, 3),
    }
  }

  const runnerUp = ranked[1]
  const suggestions = ranked.slice(0, 3).map((item) => item.candidate)
  if (best.score < 60) {
    return {
      reason: "not_found",
      suggestions,
    }
  }
  if (runnerUp && best.score < 90 && best.score - runnerUp.score < 10) {
    return {
      reason: "ambiguous",
      suggestions,
    }
  }

  return {
    reason: "match",
    candidate: best.candidate,
    suggestions,
  }
}

async function executeEntityAttributeLookupIntent(
  intent: EntityAttributeIntent,
  query: string,
  context: Awaited<ReturnType<typeof requireOrgContext>>,
): Promise<EntityAttributeExecution> {
  const entityConfig = ENTITY_ATTRIBUTE_CONFIGS[intent.entityType]
  if (!entityConfig) {
    return {
      answer: "I couldn't identify a supported entity for that field lookup.",
      confidence: "low",
      missingData: ["Unsupported entity for field lookup."],
    }
  }

  const fieldConfig = entityConfig.fields.find((field) => field.key === intent.fieldKey)
  if (!fieldConfig) {
    return {
      answer: "I couldn't map that field request to a supported attribute.",
      confidence: "low",
      missingData: ["Unsupported field lookup."],
    }
  }

  const entityLabel = ENTITY_INTENTS.find((entity) => entity.type === intent.entityType)?.label ?? formatEntityType(intent.entityType).toLowerCase()

  if (!intent.targetHint) {
    return {
      answer: `I can fetch ${fieldConfig.label}, but I need the specific ${entityLabel} name. Try quoting it, for example: "${fieldConfig.label} for \\\"Project Name\\\""`,
      confidence: "low",
      missingData: [`Missing ${entityLabel} identifier for field lookup.`],
    }
  }

  const candidateResolution = await resolveEntityAttributeCandidate(context, intent, query)
  const suggestionText =
    candidateResolution.suggestions.length > 0
      ? ` Closest matches: ${candidateResolution.suggestions
          .slice(0, 3)
          .map((result) => `"${result.title}"`)
          .join(", ")}.`
      : ""

  if (candidateResolution.reason === "ambiguous") {
    return {
      answer: `I found multiple ${entityLabel} matches for "${intent.targetHint}". Please specify which one.${suggestionText}`,
      confidence: "low",
      missingData: [`Multiple ${entityLabel} records matched the provided identifier.`],
    }
  }

  const candidate = candidateResolution.candidate
  if (!candidate) {
    return {
      answer: `I couldn’t find a ${entityLabel} matching "${intent.targetHint}" in your org.${suggestionText}`,
      confidence: "low",
      missingData: [`No ${entityLabel} matched the provided identifier.`],
    }
  }

  const { data, error } = await context.supabase
    .from(entityConfig.table)
    .select(entityConfig.rowSelect)
    .eq("org_id", context.orgId)
    .eq("id", candidate.id)
    .maybeSingle()

  if (error || !data) {
    return {
      answer: `I found ${entityLabel} "${candidate.title}" but couldn't load ${fieldConfig.label} right now.`,
      relatedResult: candidate,
      confidence: "low",
      missingData: [`Failed to load ${fieldConfig.label} from ${entityLabel} record.`],
    }
  }

  if (typeof data !== "object" || Array.isArray(data)) {
    return {
      answer: `I found ${entityLabel} "${candidate.title}" but couldn't interpret ${fieldConfig.label} from that record.`,
      relatedResult: candidate,
      confidence: "low",
      missingData: [`Unexpected ${entityLabel} payload shape while reading ${fieldConfig.label}.`],
    }
  }

  const row = data as Record<string, unknown>
  const resolvedTitle = normalizeAttributeScalar(row[entityConfig.titleField]) ?? candidate.title
  const value = fieldConfig.extract(row)
  const fallbackHref = ENTITY_HREF_FALLBACKS[intent.entityType]?.replace("{id}", candidate.id) ?? candidate.href
  const relatedResult: SearchResult = {
    ...candidate,
    title: resolvedTitle,
    href: candidate.href || fallbackHref,
    updated_at: typeof row.updated_at === "string" ? row.updated_at : candidate.updated_at,
  }

  if (!value) {
    return {
      answer: `The ${entityLabel} "${resolvedTitle}" does not have ${fieldConfig.label} set.`,
      relatedResult,
      confidence: "medium",
      missingData: [`${fieldConfig.label} is missing on the matched ${entityLabel}.`],
    }
  }

  return {
    answer: `The ${fieldConfig.label} for ${entityLabel} "${resolvedTitle}" is ${value}.`,
    relatedResult,
    confidence: "high",
    missingData: [],
  }
}

async function sumCentsField({
  context,
  table,
  centsField,
  projectId,
}: {
  context: Awaited<ReturnType<typeof requireOrgContext>>
  table: string
  centsField: string
  projectId?: string
}) {
  let totalCents = 0
  let count = 0
  let offset = 0

  while (offset < MAX_ANALYTICS_ROWS_SOFT_LIMIT) {
    let queryBuilder = context.supabase
      .from(table)
      .select(centsField)
      .eq("org_id", context.orgId)
      .range(offset, offset + ANALYTICS_BATCH_SIZE - 1)

    if (projectId) {
      queryBuilder = queryBuilder.eq("project_id", projectId)
    }

    const { data, error } = await queryBuilder
    if (error || !Array.isArray(data)) {
      if (error) {
        console.error("Failed to aggregate cents field", { table, centsField, projectId, error })
      }
      return { count: 0, totalCents: 0 }
    }

    if (data.length === 0) break
    count += data.length
    for (const row of data) {
      const value = (row as unknown as Record<string, unknown>)[centsField]
      if (typeof value === "number" && Number.isFinite(value)) {
        totalCents += value
      }
    }

    if (data.length < ANALYTICS_BATCH_SIZE) break
    offset += ANALYTICS_BATCH_SIZE
  }

  return { count, totalCents }
}

async function loadFinancialRollup({
  context,
  project,
}: {
  context: Awaited<ReturnType<typeof requireOrgContext>>
  project?: ProjectRef
}): Promise<FinancialRollup> {
  const projectId = project?.id
  const [invoices, payments, budgets, estimates, commitments, changeOrders] = await Promise.all([
    sumCentsField({ context, table: "invoices", centsField: "total_cents", projectId }),
    sumCentsField({ context, table: "payments", centsField: "amount_cents", projectId }),
    sumCentsField({ context, table: "budgets", centsField: "total_cents", projectId }),
    sumCentsField({ context, table: "estimates", centsField: "total_cents", projectId }),
    sumCentsField({ context, table: "commitments", centsField: "total_cents", projectId }),
    sumCentsField({ context, table: "change_orders", centsField: "total_cents", projectId }),
  ])

  return {
    project,
    invoiceCount: invoices.count,
    invoiceTotalCents: invoices.totalCents,
    paymentCount: payments.count,
    paymentTotalCents: payments.totalCents,
    budgetCount: budgets.count,
    budgetTotalCents: budgets.totalCents,
    estimateCount: estimates.count,
    estimateTotalCents: estimates.totalCents,
    commitmentCount: commitments.count,
    commitmentTotalCents: commitments.totalCents,
    changeOrderCount: changeOrders.count,
    changeOrderTotalCents: changeOrders.totalCents,
  }
}

function buildCanonicalGroupKey({
  groupBy,
  status,
  projectName,
  createdAt,
}: {
  groupBy: AnalyticsGroupBy
  status?: string | null
  projectName?: string | null
  createdAt?: string | null
}) {
  if (groupBy === "status") {
    return status ? toStatusLabel(status) : "Unknown"
  }
  if (groupBy === "project") {
    return projectName && projectName.trim().length > 0 ? projectName : "No project"
  }
  if (groupBy === "month") {
    if (createdAt) {
      const date = new Date(createdAt)
      if (Number.isFinite(date.getTime())) {
        return `${date.getUTCFullYear()}-${`${date.getUTCMonth() + 1}`.padStart(2, "0")}`
      }
    }
    return "Unknown month"
  }
  return "Total"
}

function incrementCanonicalBuckets(
  bucketMap: Map<string, { label: string; amountCents: number; count: number }>,
  label: string,
  amountCents: number,
) {
  const current = bucketMap.get(label) ?? { label, amountCents: 0, count: 0 }
  current.amountCents += amountCents
  current.count += 1
  bucketMap.set(label, current)
}

function mapInvoiceMetricResult(row: Record<string, unknown>): SearchResult {
  const id = typeof row.id === "string" ? row.id : randomUUID()
  const titleRaw = typeof row.title === "string" ? row.title.trim() : ""
  const invoiceNumber = typeof row.invoice_number === "string" ? row.invoice_number : ""
  const title = titleRaw || invoiceNumber || "Invoice"
  const status = typeof row.status === "string" ? row.status : undefined
  const totalCents = typeof row.total_cents === "number" ? row.total_cents : 0
  const balanceCents = typeof row.balance_due_cents === "number" ? row.balance_due_cents : 0
  const dueDate = typeof row.due_date === "string" ? row.due_date : undefined
  const projects = row.projects && typeof row.projects === "object" ? (row.projects as { name?: string | null }) : undefined

  const subtitle = [status, totalCents > 0 ? formatUsd(totalCents) : null, balanceCents > 0 ? `open ${formatUsd(balanceCents)}` : null, dueDate]
    .filter((part) => typeof part === "string" && part.trim().length > 0)
    .join(" • ")

  return {
    id,
    type: "invoice",
    title,
    subtitle: subtitle || undefined,
    href: `/invoices/${id}`,
    project_id: typeof row.project_id === "string" ? row.project_id : undefined,
    project_name: typeof projects?.name === "string" ? projects.name : undefined,
    updated_at: typeof row.created_at === "string" ? row.created_at : undefined,
  }
}

function mapPaymentMetricResult(row: Record<string, unknown>): SearchResult {
  const id = typeof row.id === "string" ? row.id : randomUUID()
  const reference = typeof row.reference === "string" ? row.reference.trim() : ""
  const method = typeof row.method === "string" ? row.method : undefined
  const amountCents = typeof row.amount_cents === "number" ? row.amount_cents : 0
  const status = typeof row.status === "string" ? row.status : undefined
  const projects = row.projects && typeof row.projects === "object" ? (row.projects as { name?: string | null }) : undefined

  const subtitle = [status, method, amountCents > 0 ? formatUsd(amountCents) : null]
    .filter((part) => typeof part === "string" && part.trim().length > 0)
    .join(" • ")

  return {
    id,
    type: "payment",
    title: reference || "Payment",
    subtitle: subtitle || undefined,
    href: `/payments/${id}`,
    project_id: typeof row.project_id === "string" ? row.project_id : undefined,
    project_name: typeof projects?.name === "string" ? projects.name : undefined,
    updated_at: typeof row.created_at === "string" ? row.created_at : undefined,
  }
}

async function executeCanonicalMetricIntent(
  intent: CanonicalMetricIntent,
  context: Awaited<ReturnType<typeof requireOrgContext>>,
  options: { enableHybridRetrieval?: boolean } = {},
): Promise<CanonicalMetricExecution> {
  const enableHybridRetrieval = options.enableHybridRetrieval === true
  const resolvedProject = await resolveProjectFromHints(context, intent.projectName)
  const bucketMap = new Map<string, { label: string; amountCents: number; count: number }>()
  const relatedResults: SearchResult[] = []

  const addResult = (result: SearchResult) => {
    if (relatedResults.length >= Math.max(8, Math.min(intent.limit, 16))) return
    relatedResults.push(result)
  }

  const sinceIso = intent.dateRangeDays
    ? new Date(Date.now() - intent.dateRangeDays * 24 * 60 * 60 * 1000).toISOString()
    : undefined
  const todayIso = new Date().toISOString().slice(0, 10)

  if (intent.key === "budget_commitment_gap") {
    const rollup = await loadFinancialRollup({ context, project: resolvedProject ?? undefined })
    const gapCents = rollup.budgetTotalCents - rollup.commitmentTotalCents

    const fallbackRelated = await retrieveHybridResults({
      context,
      query: resolvedProject?.name ?? "budget commitments",
      entityTypes: ["budget", "commitment", "project"],
      filters: resolvedProject?.id ? { projectId: resolvedProject.id } : {},
      limit: Math.max(8, Math.min(intent.limit, 12)),
      enableHybrid: enableHybridRetrieval,
    })
    const dedupedRelated = dedupeResults(fallbackRelated).slice(0, Math.max(8, Math.min(intent.limit, 12)))

    const artifactData =
      buildTableArtifact({
        orgId: context.orgId,
        title: resolvedProject?.name ? `Budget vs commitments - ${resolvedProject.name}` : "Budget vs commitments",
        columns: ["Scope", "Budget (USD)", "Commitments (USD)", "Gap (USD)"],
        rows: [
          [
            resolvedProject?.name ?? "Org-wide",
            Number((rollup.budgetTotalCents / 100).toFixed(2)),
            Number((rollup.commitmentTotalCents / 100).toFixed(2)),
            Number((gapCents / 100).toFixed(2)),
          ],
        ],
      }) ?? {}

    return {
      summary: `Budget is ${formatUsd(rollup.budgetTotalCents)} and commitments are ${formatUsd(rollup.commitmentTotalCents)}${
        resolvedProject?.name ? ` for ${resolvedProject.name}` : ""
      }. Gap is ${formatUsd(gapCents)}.`,
      metricValue: gapCents / 100,
      metricValueCents: gapCents,
      rowCount: rollup.budgetCount + rollup.commitmentCount,
      relatedResults: dedupedRelated,
      additionalContext: [
        "Canonical metric execution",
        `Metric: ${intent.key}`,
        `Scope: ${resolvedProject?.name ?? "org-wide"}`,
        `Budget total cents: ${rollup.budgetTotalCents}`,
        `Commitment total cents: ${rollup.commitmentTotalCents}`,
        `Gap cents: ${gapCents}`,
      ].join("\n"),
      artifactData,
      confidence: "high",
      missingData: [],
    }
  }

  if (intent.key === "cash_collected") {
    let totalCents = 0
    let rowCount = 0
    let offset = 0

    while (offset < MAX_ANALYTICS_ROWS_SOFT_LIMIT) {
      let queryBuilder = context.supabase
        .from("payments")
        .select("id,reference,method,status,amount_cents,project_id,projects(name),created_at")
        .eq("org_id", context.orgId)
        .range(offset, offset + ANALYTICS_BATCH_SIZE - 1)
        .order("created_at", { ascending: false })

      if (resolvedProject?.id) {
        queryBuilder = queryBuilder.eq("project_id", resolvedProject.id)
      }
      if (sinceIso) {
        queryBuilder = queryBuilder.gte("created_at", sinceIso)
      }

      const { data, error } = await queryBuilder
      if (error) {
        console.error("Canonical cash_collected query failed", error)
        break
      }

      const batch = Array.isArray(data) ? data : []
      if (batch.length === 0) break

      for (const row of batch) {
        const record = row as Record<string, unknown>
        const amountCents = typeof record.amount_cents === "number" ? record.amount_cents : 0
        totalCents += amountCents
        rowCount += 1
        addResult(mapPaymentMetricResult(record))
        incrementCanonicalBuckets(
          bucketMap,
          buildCanonicalGroupKey({
            groupBy: intent.groupBy,
            status: typeof record.status === "string" ? record.status : null,
            projectName:
              record.projects && typeof record.projects === "object"
                ? ((record.projects as { name?: string | null }).name ?? null)
                : null,
            createdAt: typeof record.created_at === "string" ? record.created_at : null,
          }),
          amountCents,
        )
      }

      if (batch.length < ANALYTICS_BATCH_SIZE) break
      offset += ANALYTICS_BATCH_SIZE
    }

    const buckets = Array.from(bucketMap.values())
      .sort((a, b) => b.amountCents - a.amountCents)
      .slice(0, 12)
    const artifactData =
      buckets.length > 0
        ? buildTableArtifact({
            orgId: context.orgId,
            title: `Cash collected${resolvedProject?.name ? ` - ${resolvedProject.name}` : ""}`,
            columns: ["Group", "Amount (USD)", "Records"],
            rows: buckets.map((bucket) => [bucket.label, Number((bucket.amountCents / 100).toFixed(2)), bucket.count]),
          }) ?? {}
        : {}

    return {
      summary: `Cash collected is ${formatUsd(totalCents)}${resolvedProject?.name ? ` for ${resolvedProject.name}` : ""}${
        intent.dateRangeDays ? ` in the last ${intent.dateRangeDays} days` : ""
      }.`,
      metricValue: totalCents / 100,
      metricValueCents: totalCents,
      rowCount,
      relatedResults: dedupeResults(relatedResults),
      additionalContext: [
        "Canonical metric execution",
        `Metric: ${intent.key}`,
        `Rows: ${rowCount}`,
        `Total cents: ${totalCents}`,
        `GroupBy: ${intent.groupBy}`,
      ].join("\n"),
      artifactData,
      confidence: rowCount > 0 ? "high" : "low",
      missingData: rowCount > 0 ? [] : ["No payment records matched the requested scope."],
    }
  }

  let totalCents = 0
  let rowCount = 0
  let offset = 0
  while (offset < MAX_ANALYTICS_ROWS_SOFT_LIMIT) {
    let queryBuilder = context.supabase
      .from("invoices")
      .select("id,title,invoice_number,status,total_cents,balance_due_cents,due_date,project_id,projects(name),created_at")
      .eq("org_id", context.orgId)
      .range(offset, offset + ANALYTICS_BATCH_SIZE - 1)
      .order("created_at", { ascending: false })

    if (resolvedProject?.id) {
      queryBuilder = queryBuilder.eq("project_id", resolvedProject.id)
    }
    if (sinceIso) {
      queryBuilder = queryBuilder.gte("created_at", sinceIso)
    }
    if (intent.key === "open_ar" || intent.key === "overdue_ar") {
      queryBuilder = queryBuilder.in("status", [...OPEN_INVOICE_STATUSES]).gt("balance_due_cents", 0)
    }
    if (intent.key === "overdue_ar") {
      queryBuilder = queryBuilder.lt("due_date", todayIso)
    }

    const { data, error } = await queryBuilder
    if (error) {
      console.error("Canonical invoice metric query failed", error)
      break
    }
    const batch = Array.isArray(data) ? data : []
    if (batch.length === 0) break

    for (const row of batch) {
      const record = row as Record<string, unknown>
      const metricCents =
        intent.key === "revenue_billed"
          ? typeof record.total_cents === "number"
            ? record.total_cents
            : 0
          : typeof record.balance_due_cents === "number"
            ? record.balance_due_cents
            : 0
      totalCents += metricCents
      rowCount += 1
      addResult(mapInvoiceMetricResult(record))
      incrementCanonicalBuckets(
        bucketMap,
        buildCanonicalGroupKey({
          groupBy: intent.groupBy,
          status: typeof record.status === "string" ? record.status : null,
          projectName:
            record.projects && typeof record.projects === "object"
              ? ((record.projects as { name?: string | null }).name ?? null)
              : null,
          createdAt: typeof record.created_at === "string" ? record.created_at : null,
        }),
        metricCents,
      )
    }

    if (batch.length < ANALYTICS_BATCH_SIZE) break
    offset += ANALYTICS_BATCH_SIZE
  }

  const bucketRows = Array.from(bucketMap.values())
    .sort((a, b) => b.amountCents - a.amountCents)
    .slice(0, 12)
  const artifactData =
    bucketRows.length > 0
      ? buildTableArtifact({
          orgId: context.orgId,
          title: `${intent.label}${resolvedProject?.name ? ` - ${resolvedProject.name}` : ""}`,
          columns: ["Group", "Amount (USD)", "Records"],
          rows: bucketRows.map((bucket) => [bucket.label, Number((bucket.amountCents / 100).toFixed(2)), bucket.count]),
        }) ?? {}
      : {}

  const label = intent.key === "revenue_billed" ? "Revenue billed" : intent.key === "open_ar" ? "Open AR" : "Overdue AR"
  return {
    summary: `${label} is ${formatUsd(totalCents)}${resolvedProject?.name ? ` for ${resolvedProject.name}` : ""}${
      intent.dateRangeDays ? ` in the last ${intent.dateRangeDays} days` : ""
    }.`,
    metricValue: totalCents / 100,
    metricValueCents: totalCents,
    rowCount,
    relatedResults: dedupeResults(relatedResults),
    additionalContext: [
      "Canonical metric execution",
      `Metric: ${intent.key}`,
      `Rows: ${rowCount}`,
      `Total cents: ${totalCents}`,
      `GroupBy: ${intent.groupBy}`,
    ].join("\n"),
    artifactData,
    confidence: rowCount > 0 ? "high" : "low",
    missingData: rowCount > 0 ? [] : ["No invoice records matched the requested scope."],
  }
}

function formatUsd(cents: number) {
  return `$${(cents / 100).toLocaleString()}`
}

function formatFinancialRollupContext(rollup: FinancialRollup) {
  const scopeLabel = rollup.project?.name ? `Project: ${rollup.project.name}` : "Scope: org-wide"
  return [
    scopeLabel,
    `Invoices: ${rollup.invoiceCount} totaling ${formatUsd(rollup.invoiceTotalCents)}`,
    `Payments: ${rollup.paymentCount} totaling ${formatUsd(rollup.paymentTotalCents)}`,
    `Budgets: ${rollup.budgetCount} totaling ${formatUsd(rollup.budgetTotalCents)}`,
    `Estimates: ${rollup.estimateCount} totaling ${formatUsd(rollup.estimateTotalCents)}`,
    `Commitments: ${rollup.commitmentCount} totaling ${formatUsd(rollup.commitmentTotalCents)}`,
    `Change orders: ${rollup.changeOrderCount} totaling ${formatUsd(rollup.changeOrderTotalCents)}`,
  ].join("\n")
}

function buildAnalysisFallbackAnswer({
  query,
  project,
  financialRollup,
  relatedResults,
}: {
  query: string
  project?: ProjectRef | null
  financialRollup?: FinancialRollup | null
  relatedResults: SearchResult[]
}) {
  if (financialRollup) {
    const scope = project?.name ? `for ${project.name}` : "across your org"
    const topMatches = relatedResults
      .slice(0, 3)
      .map((item) => item.title)
      .join(", ")
    const matchLine = topMatches ? ` Top related records: ${topMatches}.` : ""

    return `I pulled financial records ${scope}. Invoices: ${formatUsd(financialRollup.invoiceTotalCents)} (${financialRollup.invoiceCount}), Payments: ${formatUsd(financialRollup.paymentTotalCents)} (${financialRollup.paymentCount}), Budgets: ${formatUsd(financialRollup.budgetTotalCents)} (${financialRollup.budgetCount}), Estimates: ${formatUsd(financialRollup.estimateTotalCents)} (${financialRollup.estimateCount}), Commitments: ${formatUsd(financialRollup.commitmentTotalCents)} (${financialRollup.commitmentCount}), Change orders: ${formatUsd(financialRollup.changeOrderTotalCents)} (${financialRollup.changeOrderCount}).${matchLine}`
  }

  if (relatedResults.length > 0) {
    return `I found ${relatedResults.length} relevant records for "${query}".`
  }

  if (project?.name) {
    return `I found project "${project.name}" but no matching records for that question yet.`
  }

  return `I couldn't find matching records for "${query}" in your org context.`
}

async function executeAnalysisToolLayer(
  intent: AnalysisIntent,
  context: Awaited<ReturnType<typeof requireOrgContext>>,
  options: { enableHybridRetrieval?: boolean } = {},
) {
  const enableHybridRetrieval = options.enableHybridRetrieval === true
  const resolvedProject = await resolveProjectFromHints(context, intent.projectName, intent.textQuery)
  const filters: { projectId?: string; status?: string[] } = {}
  if (resolvedProject?.id) {
    filters.projectId = resolvedProject.id
  }

  if (intent.statuses.length > 0 && intent.entityTypes.length === 1 && ENTITY_STATUS_VALUES[intent.entityTypes[0]]) {
    filters.status = intent.statuses
  }

  const queryText = intent.textQuery || extractRetrievalQuery(intent.projectName ?? "")
  const rawResults = await retrieveHybridResults({
    context,
    query: queryText,
    entityTypes: intent.entityTypes,
    filters,
    limit: intent.limit,
    enableHybrid: enableHybridRetrieval,
  })
  const relatedResults = dedupeResults(rawResults).slice(0, intent.limit)
  const financialRollup = intent.includeFinancialRollup ? await loadFinancialRollup({ context, project: resolvedProject ?? undefined }) : null

  return {
    project: resolvedProject,
    relatedResults,
    financialRollup,
  }
}

function toFiniteNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function toAnalyticsMetricValue(metric: AnalyticsMetric, bucket: { count: number; amountCents: number }) {
  if (metric === "count") return bucket.count
  if (metric === "avg_amount") {
    if (bucket.count === 0) return 0
    return bucket.amountCents / bucket.count / 100
  }
  return bucket.amountCents / 100
}

function formatAnalyticsMetricValue(metric: AnalyticsMetric, value: number) {
  if (metric === "count") return Math.round(value).toLocaleString()
  if (metric === "avg_amount") {
    return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  }
  return `$${Math.round(value).toLocaleString()}`
}

function formatRangeLabel(days?: number) {
  if (!days) return "all time"
  if (days % 30 === 0) {
    const months = days / 30
    if (months === 1) return "last 1 month"
    return `last ${months} months`
  }
  return `last ${days} days`
}

function buildAnalyticsFallbackAnswer({
  execution,
  intent,
}: {
  execution: AnalyticsExecution
  intent: AnalyticsIntent
}) {
  const { rowCount, buckets, entityLabel, project, metric, groupBy } = execution
  const scope = project?.name ? ` for ${project.name}` : ""
  const range = formatRangeLabel(intent.dateRangeDays)

  if (rowCount === 0 || buckets.length === 0) {
    return `I found no ${pluralize(entityLabel, 2)}${scope} in the ${range} window for that analytics query.`
  }

  if (groupBy === "none") {
    const total = buckets[0]
    if (!total) {
      return `I found ${rowCount} ${pluralize(entityLabel, rowCount)}${scope} in the ${range} window.`
    }

    if (metric === "count") {
      return `I found ${formatAnalyticsMetricValue(metric, total.metricValue)} ${pluralize(entityLabel, rowCount)}${scope} in the ${range} window.`
    }

    const metricLabel = metric === "avg_amount" ? "Average amount" : "Total amount"
    return `${metricLabel} across ${pluralize(entityLabel, rowCount)}${scope} in the ${range} window is ${formatAnalyticsMetricValue(metric, total.metricValue)}.`
  }

  const topGroups = buckets
    .slice(0, 4)
    .map((bucket) => `${bucket.label}: ${formatAnalyticsMetricValue(metric, bucket.metricValue)}`)
    .join("; ")

  const groupLabel =
    groupBy === "status" ? "status" : groupBy === "project" ? "project" : groupBy === "month" ? "month" : "group"

  return `I analyzed ${rowCount.toLocaleString()} ${pluralize(entityLabel, rowCount)}${scope} in the ${range} window. Top ${groupLabel} breakdown: ${topGroups}.`
}

async function executeAnalyticsToolLayer(
  intent: AnalyticsIntent,
  context: Awaited<ReturnType<typeof requireOrgContext>>,
  options: { enableHybridRetrieval?: boolean } = {},
): Promise<AnalyticsExecution> {
  const enableHybridRetrieval = options.enableHybridRetrieval === true
  const config = ANALYTICS_ENTITY_CONFIGS[intent.entityType]
  const entityLabel = ENTITY_INTENTS.find((entity) => entity.type === intent.entityType)?.label ?? formatEntityType(intent.entityType).toLowerCase()
  if (!config) {
    return {
      answer: `I can't run advanced analytics for ${entityLabel} yet. Try asking for a list or count instead.`,
      entityLabel,
      rowCount: 0,
      metric: intent.metric,
      groupBy: intent.groupBy,
      buckets: [],
      relatedResults: [],
    }
  }

  const resolvedProject = await resolveProjectFromHints(context, intent.projectName, intent.textQuery)
  const selectFields = Array.from(
    new Set([
      "id",
      config.titleField,
      config.statusField,
      config.amountField,
      config.projectIdField,
      config.createdAtField,
    ].filter((field): field is string => Boolean(field))),
  )

  const toAnalyticsRow = (entry: unknown): AnalyticsRow => {
    const value = entry as Record<string, unknown>
    const id = typeof value.id === "string" ? value.id : ""
    const titleValue = value[config.titleField]
    const statusValue = config.statusField ? value[config.statusField] : undefined
    const amountValue = config.amountField ? value[config.amountField] : undefined
    const projectIdValue = config.projectIdField ? value[config.projectIdField] : undefined
    const createdAtValue = config.createdAtField ? value[config.createdAtField] : undefined

    return {
      id,
      title: typeof titleValue === "string" && titleValue.trim().length > 0 ? titleValue : id || "Untitled",
      status: typeof statusValue === "string" ? statusValue : undefined,
      amountCents: config.amountField ? toFiniteNumber(amountValue) : undefined,
      projectId: typeof projectIdValue === "string" ? projectIdValue : undefined,
      createdAt: typeof createdAtValue === "string" ? createdAtValue : undefined,
    }
  }

  const runAnalyticsQuery = async (textQuery: string): Promise<{ rows: AnalyticsRow[]; error: unknown | null }> => {
    const rows: AnalyticsRow[] = []
    let offset = 0

    while (offset < MAX_ANALYTICS_ROWS_SOFT_LIMIT) {
      let queryBuilder = context.supabase
        .from(config.table)
        .select(selectFields.join(","))
        .eq("org_id", context.orgId)
        .range(offset, offset + ANALYTICS_BATCH_SIZE - 1)

      if (resolvedProject?.id && config.projectIdField) {
        queryBuilder = queryBuilder.eq(config.projectIdField, resolvedProject.id)
      }

      if (intent.statuses.length > 0 && config.statusField) {
        queryBuilder = queryBuilder.in(config.statusField, intent.statuses)
      }

      if (intent.dateRangeDays && config.createdAtField) {
        const since = new Date(Date.now() - intent.dateRangeDays * 24 * 60 * 60 * 1000).toISOString()
        queryBuilder = queryBuilder.gte(config.createdAtField, since)
      }

      if (textQuery && config.searchableFields.length > 0) {
        const condition = buildTextSearchOrCondition(config.searchableFields, textQuery)
        if (condition) {
          queryBuilder = queryBuilder.or(condition)
        }
      }

      if (config.createdAtField) {
        queryBuilder = queryBuilder.order(config.createdAtField, { ascending: false })
      }

      const { data, error } = await queryBuilder
      if (error) return { rows: [], error }

      const batch = Array.isArray(data) ? data : []
      if (batch.length === 0) break
      rows.push(...batch.map(toAnalyticsRow))
      if (batch.length < ANALYTICS_BATCH_SIZE) break

      offset += ANALYTICS_BATCH_SIZE
    }

    return { rows, error: null }
  }

  let analyticsResult = await runAnalyticsQuery(intent.textQuery)

  // If text filtering likely over-constrained results, retry without text filter.
  if (analyticsResult.rows.length === 0 && intent.textQuery.trim().length > 0) {
    analyticsResult = await runAnalyticsQuery("")
  }
  if (analyticsResult.error) {
    console.error("Analytics query failed", {
      entityType: intent.entityType,
      metric: intent.metric,
      groupBy: intent.groupBy,
      statuses: intent.statuses,
      textQuery: intent.textQuery,
      dateRangeDays: intent.dateRangeDays,
      error: analyticsResult.error,
    })
    return {
      answer: `I couldn't run analytics for ${entityLabel} right now. Please try again.`,
      entityLabel,
      project: resolvedProject,
      rowCount: 0,
      metric: intent.metric,
      groupBy: intent.groupBy,
      buckets: [],
      relatedResults: [],
    }
  }

  const rows = analyticsResult.rows

  const projectNameMap = new Map<string, string>()
  if (intent.groupBy === "project" && config.projectIdField) {
    const projectIds = Array.from(new Set(rows.map((row) => row.projectId).filter((id): id is string => Boolean(id)))).slice(0, 200)
    if (projectIds.length > 0) {
      const { data: projectsData, error: projectsError } = await context.supabase
        .from("projects")
        .select("id,name")
        .eq("org_id", context.orgId)
        .in("id", projectIds)

      if (projectsError) {
        console.error("Failed to resolve project names for analytics", projectsError)
      } else if (Array.isArray(projectsData)) {
        for (const project of projectsData) {
          const id = typeof project.id === "string" ? project.id : null
          const name = typeof project.name === "string" ? project.name : null
          if (id && name) projectNameMap.set(id, name)
        }
      }
    }
  }

  const bucketMap = new Map<string, { label: string; count: number; amountCents: number }>()
  for (const row of rows) {
    let label = "Total"
    if (intent.groupBy === "status") {
      label = row.status ? toStatusLabel(row.status) : "Unknown"
    } else if (intent.groupBy === "project") {
      label = row.projectId ? projectNameMap.get(row.projectId) ?? "Unknown project" : "No project"
    } else if (intent.groupBy === "month") {
      const date = row.createdAt ? new Date(row.createdAt) : null
      if (date && Number.isFinite(date.getTime())) {
        const year = date.getUTCFullYear()
        const month = `${date.getUTCMonth() + 1}`.padStart(2, "0")
        label = `${year}-${month}`
      } else {
        label = "Unknown month"
      }
    }

    const current = bucketMap.get(label) ?? { label, count: 0, amountCents: 0 }
    current.count += 1
    current.amountCents += row.amountCents ?? 0
    bucketMap.set(label, current)
  }

  const buckets = Array.from(bucketMap.values())
    .map((bucket) => ({
      label: bucket.label,
      count: bucket.count,
      amountCents: bucket.amountCents,
      metricValue: toAnalyticsMetricValue(intent.metric, bucket),
    }))
    .filter((bucket) => bucket.count > 0)

  if (intent.groupBy === "month") {
    buckets.sort((a, b) => a.label.localeCompare(b.label))
  } else {
    buckets.sort((a, b) => b.metricValue - a.metricValue)
  }

  const normalizedGroupBy = normalizeAnalyticsGroupBy(intent.groupBy, intent.entityType)
  const filters: { projectId?: string; status?: string[] } = {}
  if (resolvedProject?.id) {
    filters.projectId = resolvedProject.id
  }
  if (intent.statuses.length > 0 && ENTITY_STATUS_VALUES[intent.entityType]?.length) {
    filters.status = intent.statuses
  }

  const rawRelated = await retrieveHybridResults({
    context,
    query: intent.textQuery,
    entityTypes: [intent.entityType],
    filters,
    limit: Math.max(8, Math.min(intent.limit, 12)),
    enableHybrid: enableHybridRetrieval,
  })
  const relatedResults = dedupeResults(rawRelated).slice(0, Math.min(intent.limit, 12))

  const execution: AnalyticsExecution = {
    answer: "",
    entityLabel,
    project: resolvedProject,
    rowCount: rows.length,
    metric: intent.metric,
    groupBy: normalizedGroupBy,
    buckets,
    relatedResults,
  }

  execution.answer = buildAnalyticsFallbackAnswer({
    execution,
    intent: {
      ...intent,
      groupBy: normalizedGroupBy,
    },
  })

  return execution
}

function formatSourceContext(sources: RetrievedSource[]) {
  return sources
    .map(({ sourceId, result }) => {
      const lines = [
        `[${sourceId}]`,
        `Type: ${formatEntityType(result.type)}`,
        `Title: ${result.title}`,
      ]

      if (result.subtitle) lines.push(`Subtitle: ${result.subtitle}`)
      if (result.description) lines.push(`Description: ${result.description}`)
      if (result.project_name) lines.push(`Project: ${result.project_name}`)
      if (result.updated_at) lines.push(`Updated: ${result.updated_at}`)
      lines.push(`Href: ${result.href}`)

      return lines.join("\n")
    })
    .join("\n\n")
}

function buildFallbackAnswer(query: string, relatedResults: SearchResult[]) {
  if (relatedResults.length === 0) {
    if (isGreetingOrSmallTalkQuery(query)) {
      return buildGreetingResponse(query)
    }
    if (isLikelyGeneralNonOrgQuery(query)) {
      return `I did not find company records for "${query}". If this is a general question, I can answer it directly. If it is company-related, include terms like invoice, project, task, or approval.`
    }
    return `I could not find matching records for "${query}" in your current org context. Try adding a project name, document number, or entity type like "invoice" or "RFI".`
  }

  const typeCounts = new Map<string, number>()
  for (const item of relatedResults) {
    const label = formatEntityType(item.type)
    typeCounts.set(label, (typeCounts.get(label) ?? 0) + 1)
  }

  const topTypes = Array.from(typeCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([label, count]) => `${count} ${label}${count > 1 ? "s" : ""}`)
    .join(", ")

  const highlights = relatedResults
    .slice(0, 3)
    .map((item) => (item.project_name ? `${item.title} (${item.project_name})` : item.title))
    .join("; ")

  return `I found ${relatedResults.length} matching records for "${query}". Most relevant: ${topTypes}. Top matches: ${highlights}.`
}

function buildLlmUnavailableResponse({
  nowIso,
  assistantMode,
  provider,
  model,
  configSource,
}: {
  nowIso: string
  assistantMode: "org" | "general"
  provider: AiProvider
  model: string
  configSource?: "org" | "platform" | "env" | "default"
}): AskAiSearchResponse {
  return {
    answer: "I couldn't reach the configured LLM, so I did not generate a fallback answer. Please restart the model endpoint and try again.",
    citations: [],
    relatedResults: [],
    generatedAt: nowIso,
    assistantMode,
    mode: "fallback",
    provider,
    model,
    configSource,
    confidence: "low",
    missingData: ["Configured LLM was unavailable or timed out. Deterministic fallback is disabled."],
  }
}

function mapRelatedResult(result: SearchResult): AiSearchRelatedResult {
  return {
    id: result.id,
    type: result.type,
    title: result.title,
    href: result.href,
    subtitle: result.subtitle,
    description: result.description,
    projectName: result.project_name,
    updatedAt: result.updated_at,
  }
}

function mapCitation(source: RetrievedSource): AiSearchCitation {
  return {
    sourceId: source.sourceId,
    id: source.result.id,
    type: source.result.type,
    title: source.result.title,
    href: source.result.href,
    subtitle: source.result.subtitle,
    projectName: source.result.project_name,
    updatedAt: source.result.updated_at,
  }
}

function toArtifactValue(value: unknown): AiArtifactValue {
  if (value === null || value === undefined) return null
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "boolean") return value ? "Yes" : "No"
  const text = String(value).trim()
  return text.length > 0 ? text : null
}

function isLowSignalArtifactValue(value: AiArtifactValue) {
  if (value === null) return true
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    return normalized.length === 0 || normalized === "-" || normalized === "—" || normalized === "n/a" || normalized === "none"
  }
  return false
}

function artifactDistinctKey(value: AiArtifactValue) {
  if (value === null) return "__null__"
  if (typeof value === "number") return `n:${value}`
  return `s:${value.trim().toLowerCase()}`
}

function pruneLowValueArtifactColumns(columns: string[], rows: AiArtifactValue[][]) {
  if (columns.length <= 1 || rows.length === 0) {
    return { columns, rows }
  }

  const keep = new Set<number>()
  const signalScoreByIndex = new Map<number, number>()
  if (columns.length > 0) keep.add(0)

  for (let index = 0; index < columns.length; index += 1) {
    const label = columns[index]?.trim().toLowerCase() ?? ""
    const sparseThreshold = Math.max(1, Math.ceil(rows.length * 0.2))
    const detailThreshold = Math.max(1, Math.ceil(rows.length * 0.5))
    let nonEmpty = 0
    const distinct = new Set<string>()

    for (const row of rows) {
      const value = row[index] ?? null
      if (isLowSignalArtifactValue(value)) continue
      nonEmpty += 1
      if (distinct.size < 6) {
        distinct.add(artifactDistinctKey(value))
      }
    }

    signalScoreByIndex.set(index, nonEmpty * 10 + Math.min(distinct.size, 6))
    if (index === 0) continue

    if (nonEmpty < sparseThreshold) {
      continue
    }
    if ((label === "details" || label === "description") && nonEmpty < detailThreshold) {
      continue
    }
    if (rows.length >= 3 && distinct.size <= 1) {
      continue
    }
    keep.add(index)
  }

  const minimumColumns = Math.min(2, columns.length)
  if (keep.size < minimumColumns) {
    const fallbackIndices = columns
      .map((_, index) => index)
      .filter((index) => !keep.has(index))
      .sort((a, b) => {
        const scoreA = signalScoreByIndex.get(a) ?? 0
        const scoreB = signalScoreByIndex.get(b) ?? 0
        if (scoreA !== scoreB) return scoreB - scoreA
        return a - b
      })

    for (const index of fallbackIndices) {
      keep.add(index)
      if (keep.size >= minimumColumns) break
    }
  }

  const keepIndices = Array.from(keep).sort((a, b) => a - b)
  return {
    columns: keepIndices.map((index) => columns[index] ?? "Value"),
    rows: rows.map((row) => keepIndices.map((index) => row[index] ?? null)),
  }
}

function normalizeArtifactDatasetInput(columns: string[], rows: AiArtifactValue[][]) {
  const normalizedColumns = columns
    .map((column) => column.trim())
    .filter((column) => column.length > 0)
    .slice(0, 8)
  if (normalizedColumns.length === 0) {
    normalizedColumns.push("Value")
  }

  const normalizedRows = rows
    .slice(0, 250)
    .map((row) => {
      const nextRow: AiArtifactValue[] = normalizedColumns.map((_, index) => toArtifactValue(row[index]) ?? null)
      return nextRow
    })
  return pruneLowValueArtifactColumns(normalizedColumns, normalizedRows)
}

function storeArtifactDataset(orgId: string, title: string, columns: string[], rows: AiArtifactValue[][]): AiSearchArtifactDataset {
  const normalized = normalizeArtifactDatasetInput(columns, rows)
  const id = randomUUID()
  const dataset: AiSearchArtifactDataset = {
    id,
    orgId,
    title: title.trim() || "AI query export",
    columns: normalized.columns,
    rows: normalized.rows,
    createdAt: new Date().toISOString(),
  }

  aiArtifactDatasetCache.set(id, {
    expiresAt: Date.now() + ARTIFACT_CACHE_TTL_MS,
    dataset,
  })
  void persistArtifactDataset(dataset)

  return dataset
}

function buildExportLinks(datasetId: string): AiSearchExportLink[] {
  const encoded = encodeURIComponent(datasetId)
  return [
    { format: "csv", label: "Export CSV", href: `/api/ai-search/export?datasetId=${encoded}&format=csv` },
    { format: "pdf", label: "Export PDF", href: `/api/ai-search/export?datasetId=${encoded}&format=pdf` },
  ]
}

function buildResultRowsForArtifact(results: SearchResult[]) {
  return results.map((result) => [
    formatEntityType(result.type),
    result.title,
    result.project_name ?? "",
    result.subtitle ?? "",
    result.updated_at ?? "",
  ] satisfies AiArtifactValue[])
}

function buildTableArtifact({
  orgId,
  title,
  columns,
  rows,
}: {
  orgId: string
  title: string
  columns: string[]
  rows: AiArtifactValue[][]
}): { artifact: AiSearchArtifact; exports: AiSearchExportLink[] } | null {
  if (rows.length === 0) return null
  const dataset = storeArtifactDataset(orgId, title, columns, rows)
  return {
    artifact: {
      kind: "table",
      datasetId: dataset.id,
      title: dataset.title,
      table: {
        columns: dataset.columns,
        rows: dataset.rows.slice(0, 12),
      },
    },
    exports: buildExportLinks(dataset.id),
  }
}

function buildChartArtifact({
  orgId,
  title,
  points,
  valuePrefix,
  valueSuffix,
}: {
  orgId: string
  title: string
  points: AiChartPoint[]
  valuePrefix?: string
  valueSuffix?: string
}): { artifact: AiSearchArtifact; exports: AiSearchExportLink[] } | null {
  const normalizedPoints = points
    .map((point) => ({
      label: point.label.trim(),
      value: Number.isFinite(point.value) ? point.value : 0,
    }))
    .filter((point) => point.label.length > 0 && point.value > 0)
    .slice(0, 12)
  if (normalizedPoints.length === 0) return null

  const dataset = storeArtifactDataset(
    orgId,
    title,
    ["Label", "Value"],
    normalizedPoints.map((point) => [point.label, point.value]),
  )

  return {
    artifact: {
      kind: "chart",
      datasetId: dataset.id,
      title: dataset.title,
      chart: {
        type: "bar",
        points: normalizedPoints,
        valuePrefix,
        valueSuffix,
      },
    },
    exports: buildExportLinks(dataset.id),
  }
}

function buildArtifactForStructuredIntent(
  orgId: string,
  intent: StructuredIntent,
  execution: StructuredExecution,
): { artifact?: AiSearchArtifact; exports?: AiSearchExportLink[] } {
  if (execution.statusBreakdown.length > 0) {
    const chart = buildChartArtifact({
      orgId,
      title: `${formatEntityType(intent.entityType)} by status`,
      points: execution.statusBreakdown.map((entry) => ({
        label: toStatusLabel(entry.status),
        value: entry.count,
      })),
    })
    if (chart) return chart
  }

  const table = buildTableArtifact({
    orgId,
    title: `${formatEntityType(intent.entityType)} results`,
    columns: ["Type", "Title", "Project", "Details", "Updated"],
    rows: buildResultRowsForArtifact(execution.relatedResults),
  })
  if (table) return table

  return {}
}

function buildArtifactForAnalysisIntent({
  orgId,
  project,
  financialRollup,
  relatedResults,
}: {
  orgId: string
  project?: ProjectRef | null
  financialRollup?: FinancialRollup | null
  relatedResults: SearchResult[]
}): { artifact?: AiSearchArtifact; exports?: AiSearchExportLink[] } {
  if (financialRollup) {
    const scope = project?.name ? ` - ${project.name}` : ""
    const chart = buildChartArtifact({
      orgId,
      title: `Financial totals${scope}`,
      valuePrefix: "$",
      points: [
        { label: "Invoices", value: Math.round(financialRollup.invoiceTotalCents / 100) },
        { label: "Payments", value: Math.round(financialRollup.paymentTotalCents / 100) },
        { label: "Budgets", value: Math.round(financialRollup.budgetTotalCents / 100) },
        { label: "Estimates", value: Math.round(financialRollup.estimateTotalCents / 100) },
        { label: "Commitments", value: Math.round(financialRollup.commitmentTotalCents / 100) },
        { label: "Change Orders", value: Math.round(financialRollup.changeOrderTotalCents / 100) },
      ],
    })
    if (chart) return chart
  }

  const table = buildTableArtifact({
    orgId,
    title: "Analysis results",
    columns: ["Type", "Title", "Project", "Details", "Updated"],
    rows: buildResultRowsForArtifact(relatedResults),
  })
  if (table) return table

  return {}
}

function buildArtifactForAnalyticsIntent({
  orgId,
  execution,
}: {
  orgId: string
  execution: AnalyticsExecution
}): { artifact?: AiSearchArtifact; exports?: AiSearchExportLink[] } {
  if (execution.buckets.length === 0) {
    return {}
  }

  const valuePrefix = execution.metric === "count" ? undefined : "$"
  const titleSuffix = execution.project?.name ? ` - ${execution.project.name}` : ""
  const title = `${execution.entityLabel.replace(/^./, (char) => char.toUpperCase())} analytics${titleSuffix}`

  if (execution.groupBy !== "none") {
    const chart = buildChartArtifact({
      orgId,
      title,
      points: execution.buckets.slice(0, 12).map((bucket) => ({
        label: bucket.label,
        value: Number.isFinite(bucket.metricValue) ? bucket.metricValue : 0,
      })),
      valuePrefix,
    })
    if (chart) return chart
  }

  const table = buildTableArtifact({
    orgId,
    title,
    columns: execution.metric === "count" ? ["Group", "Record Count"] : ["Group", "Metric Value", "Record Count", "Amount (USD)"],
    rows: execution.buckets.map((bucket) =>
      execution.metric === "count"
        ? ([bucket.label, bucket.count] satisfies AiArtifactValue[])
        : ([
            bucket.label,
            Number(bucket.metricValue.toFixed(2)),
            bucket.count,
            Number((bucket.amountCents / 100).toFixed(2)),
          ] satisfies AiArtifactValue[]),
    ),
  })
  if (table) return table

  return {}
}

function buildArtifactForFallback(
  orgId: string,
  relatedResults: SearchResult[],
): { artifact?: AiSearchArtifact; exports?: AiSearchExportLink[] } {
  return (
    buildTableArtifact({
      orgId,
      title: "Related records",
      columns: ["Type", "Title", "Project", "Details", "Updated"],
      rows: buildResultRowsForArtifact(relatedResults),
    }) ?? {}
  )
}

function cleanJsonCandidate(raw: string) {
  const trimmed = raw.trim()

  if (trimmed.startsWith("```")) {
    return trimmed
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```$/i, "")
      .trim()
  }

  return trimmed
}

function parseModelAnswer(raw: string): ParsedModelAnswer | null {
  const candidates = [cleanJsonCandidate(raw)]
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start >= 0 && end > start) {
    candidates.push(raw.slice(start, end + 1).trim())
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as {
        answer?: unknown
        citation_ids?: unknown
      }

      if (typeof parsed.answer !== "string" || !parsed.answer.trim()) {
        continue
      }

      const citationIds = Array.isArray(parsed.citation_ids)
        ? parsed.citation_ids.filter((item): item is string => typeof item === "string")
        : []

      return {
        answer: parsed.answer.trim(),
        citation_ids: citationIds,
      }
    } catch {
      continue
    }
  }

  return null
}

function getApiKeyForProvider(provider: AiProvider) {
  if (provider === "openai") {
    const configuredKey = process.env.OPENAI_API_KEY?.trim()
    if (configuredKey) return configuredKey

    // Local OpenAI-compatible servers (LM Studio, Ollama bridges, etc.) often accept any non-empty key.
    if (getOpenAiBaseUrl()) {
      return process.env.OPENAI_COMPAT_API_KEY?.trim() || "local-dev-key"
    }

    return undefined
  }
  if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY
  return process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY
}

function getOpenAiBaseUrl() {
  const configured = process.env.OPENAI_BASE_URL ?? process.env.OPENAI_COMPAT_BASE_URL
  if (!configured) return undefined
  const normalized = configured.trim()
  return normalized.length > 0 ? normalized : undefined
}

function buildPrompt(query: string, sources: RetrievedSource[], additionalContext?: string) {
  const sourceContext = formatSourceContext(sources)
  const contextBlock = additionalContext?.trim() ? `\n\nAdditional context:\n${additionalContext.trim()}` : ""
  return `Question:\n${query}${contextBlock}\n\nSources:\n${sourceContext}`
}

function resolveLanguageModel(provider: AiProvider, apiKey: string, model: string) {
  const normalizedModel = provider === "google" && model.startsWith("models/") ? model.slice("models/".length) : model

  if (provider === "openai") {
    return createOpenAI({
      apiKey,
      baseURL: getOpenAiBaseUrl(),
    })(normalizedModel)
  }

  if (provider === "anthropic") {
    return createAnthropic({ apiKey })(normalizedModel)
  }

  return createGoogleGenerativeAI({ apiKey })(normalizedModel)
}

async function generateAnswerWithLlm(
  query: string,
  sources: RetrievedSource[],
  provider: AiProvider,
  model: string,
  additionalContext?: string,
) {
  const apiKey = getApiKeyForProvider(provider)
  if (!apiKey || sources.length === 0) {
    return null
  }
  const languageModel = resolveLanguageModel(provider, apiKey, model)

  try {
    const result = await generateText({
      model: languageModel,
      system: LLM_SYSTEM_PROMPT,
      prompt: buildPrompt(query, sources, additionalContext),
      temperature: 0.2,
      maxOutputTokens: 700,
      timeout: REQUEST_TIMEOUT_MS,
    })
    const parsed = parseModelAnswer(result.text)
    if (!parsed) {
      return null
    }
    return {
      answer: parsed.answer,
      citationIds: parsed.citation_ids,
      provider,
      model,
    }
  } catch (error) {
    console.error("AI search generation failed", error)
    return null
  }
}

function resolveCitations(sources: RetrievedSource[], citationIds: string[]) {
  const sourceById = new Map(sources.map((source) => [source.sourceId, source]))
  const uniqueIds: string[] = []

  for (const id of citationIds) {
    if (!sourceById.has(id)) continue
    if (uniqueIds.includes(id)) continue
    uniqueIds.push(id)
  }

  const fallbackIds = uniqueIds.length > 0 ? uniqueIds : sources.map((source) => source.sourceId).slice(0, MAX_CITATIONS)
  return fallbackIds
    .slice(0, MAX_CITATIONS)
    .map((sourceId) => sourceById.get(sourceId))
    .filter((source): source is RetrievedSource => Boolean(source))
}

function inferConfidenceFromResponse({
  rowCount,
  citationsCount,
  fallback = "low",
}: {
  rowCount: number
  citationsCount: number
  fallback?: "low" | "medium" | "high"
}) {
  if (rowCount >= 10 && citationsCount >= 2) return "high" as const
  if (rowCount > 0 || citationsCount > 0) return "medium" as const
  return fallback
}

function pruneCache() {
  const now = Date.now()
  for (const [key, value] of aiAnswerCache.entries()) {
    if (value.expiresAt <= now) {
      aiAnswerCache.delete(key)
    }
  }

  for (const [key, value] of aiArtifactDatasetCache.entries()) {
    if (value.expiresAt <= now) {
      aiArtifactDatasetCache.delete(key)
    }
  }

  for (const [key, value] of aiPlannerCache.entries()) {
    if (value.expiresAt <= now) {
      aiPlannerCache.delete(key)
    }
  }
}

export async function getAiSearchArtifactDataset(datasetId: string, orgId: string): Promise<AiSearchArtifactDataset | null> {
  pruneCache()
  const cached = aiArtifactDatasetCache.get(datasetId)
  if (cached && cached.expiresAt > Date.now() && cached.dataset.orgId === orgId) {
    return cached.dataset
  }

  return loadPersistedArtifactDataset(datasetId, orgId)
}

export async function askAiSearch(query: string, options: AskAiSearchOptions = {}): Promise<AskAiSearchResponse> {
  const normalizedQuery = normalizeQuery(query)
  const nowIso = new Date().toISOString()
  const startedAt = Date.now()
  await emitTrace(options, {
    id: "receive-question",
    status: "started",
    label: "Reading your request",
    detail: "I am parsing intent, scope, and the entities we should query.",
    thought: "Reading your request and deciding the best query path.",
  })

  if (!normalizedQuery) {
    await emitTrace(options, {
      id: "empty-question",
      status: "warning",
      label: "No question detected",
      detail: "I need a written question before I can run org-scoped retrieval.",
      thought: "I need a question to continue.",
    })
    return {
      answer: "Ask a question about projects, tasks, files, invoices, or contacts in your org.",
      citations: [],
      relatedResults: [],
      generatedAt: nowIso,
      assistantMode: "org",
      mode: "fallback",
      confidence: "low",
      missingData: ["No question was provided."],
    }
  }

  if (normalizedQuery.length > MAX_QUERY_LENGTH_CHARS) {
    await emitTrace(options, {
      id: "query-too-long",
      status: "warning",
      label: "Question too long",
      detail: `Keep the question under ${MAX_QUERY_LENGTH_CHARS} characters.`,
      thought: "The query is too long for reliable planning. Asking for a shorter prompt.",
    })
    return {
      answer: `Your question is too long (${normalizedQuery.length} characters). Please shorten it to ${MAX_QUERY_LENGTH_CHARS} characters or less and include the key entities or timeframe.`,
      citations: [],
      relatedResults: [],
      generatedAt: nowIso,
      assistantMode: "org",
      mode: "fallback",
      confidence: "low",
      missingData: ["Query exceeded maximum supported length."],
    }
  }

  const context = await requireOrgContext()
  const { orgId, supabase, userId } = context
  const [aiConfig, runtimeFlags] = await Promise.all([
    getOrgAiSearchConfigFromContext(context),
    getAiSearchRuntimeFlags(context),
  ])
  const assistantRuntimeInfoQuery = isAssistantRuntimeInfoQuery(normalizedQuery)
  const assistantMode = assistantRuntimeInfoQuery
    ? "general"
    : await resolveAssistantMode(options.mode, runtimeFlags, normalizedQuery, aiConfig.provider, aiConfig.model)
  const limit = clampLimit(options.limit)
  const sessionId = await ensureAiSearchSession(context, assistantMode, options.sessionId)
  const sessionContext = runtimeFlags.conversationMemory ? await loadAiSearchSessionContext(context, sessionId) : ""
  const memoryFacts = runtimeFlags.conversationMemory ? extractSessionMemoryFacts(normalizedQuery) : []
  const plannerQuery = sessionContext ? `${sessionContext}\nUSER: ${normalizedQuery}` : normalizedQuery
  const cacheKey = `${AI_SEARCH_CACHE_VERSION}:${orgId}:${sessionId}:${assistantMode}:${aiConfig.provider}:${aiConfig.model}:${runtimeFlags.hybridRetrieval ? "hybrid" : "lexical"}:${normalizedQuery.toLowerCase()}:${limit}`
  const sessionContextBlock = sessionContext ? `Conversation context:\n${sessionContext}` : ""
  await emitTrace(options, {
    id: "resolve-context",
    status: "completed",
    label: "Org context secured",
    detail:
      assistantMode === "org"
        ? "All data access is now constrained to your organization."
        : "Non-org response mode is active, so answers are not grounded in org citations.",
    thought:
      assistantMode === "org"
        ? "Org scope is locked, so I will only query your company records."
        : "Non-org mode is active; response quality will rely on model knowledge instead of company data.",
  })
  if (memoryFacts.length > 0) {
    await emitTrace(options, {
      id: "memory-context",
      status: "completed",
      label: "Loaded conversation memory",
      detail: `Using ${memoryFacts.length} persisted memory facts to interpret follow-ups.`,
      thought: "Loaded prior context so follow-up wording can stay natural.",
    })
  }

  pruneCache()
  const cached = aiAnswerCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    if (runtimeFlags.conversationMemory) {
      await appendAiSearchMessage(context, sessionId, "user", normalizedQuery, {
        assistantMode,
        memoryFacts,
      })
      await appendAiSearchMessage(context, sessionId, "assistant", cached.response.answer, {
        mode: cached.response.mode,
        provider: cached.response.provider,
        model: cached.response.model,
        cached: true,
        assistantMode,
      })
    }
    await emitTrace(options, {
      id: "cache-hit",
      status: "completed",
      label: "Using cached answer",
      detail: "Returning recent result for this question.",
    })
    await emitTrace(options, {
      id: "done",
      status: "completed",
      label: "Answer ready",
      detail: "Served from cache.",
    })
    await recordAiSearchEvent({
      context,
      sessionId,
      query: normalizedQuery,
      assistantMode,
      success: true,
      plan: { cache: true },
      metrics: { cache_hit: true, planner_v2: runtimeFlags.plannerV2 },
      citationsCount: cached.response.citations.length,
      resultsCount: cached.response.relatedResults.length,
      latencyMs: Date.now() - startedAt,
    })
    return {
      ...cached.response,
      assistantMode: cached.response.assistantMode ?? assistantMode,
      actions: cached.response.actions ?? [],
      sessionId,
    }
  }

  if (runtimeFlags.conversationMemory) {
    await appendAiSearchMessage(context, sessionId, "user", normalizedQuery, {
      assistantMode,
      memoryFacts,
    })
  }

  const finalizeResponse = async (
    response: AskAiSearchResponse,
    meta: {
      success?: boolean
      error?: string
      plan?: Record<string, unknown>
      metrics?: Record<string, unknown>
    } = {},
  ): Promise<AskAiSearchResponse> => {
    const resolvedAssistantMode = response.assistantMode === "general" || response.assistantMode === "org" ? response.assistantMode : assistantMode
    const withSession: AskAiSearchResponse = {
      ...response,
      assistantMode: resolvedAssistantMode,
      confidence:
        response.confidence ??
        inferConfidenceFromResponse({
          rowCount: response.relatedResults.length,
          citationsCount: response.citations.length,
          fallback: "low",
        }),
      missingData: response.missingData ?? [],
      actions: response.actions ?? [],
      sessionId,
    }
    aiAnswerCache.set(cacheKey, {
      expiresAt: Date.now() + CACHE_TTL_MS,
      response: withSession,
    })
    if (runtimeFlags.conversationMemory) {
      await appendAiSearchMessage(context, sessionId, "assistant", withSession.answer, {
        mode: withSession.mode,
        provider: withSession.provider,
        model: withSession.model,
        assistantMode: resolvedAssistantMode,
      })
    }
    await recordAiSearchEvent({
      context,
      sessionId,
      query: normalizedQuery,
      assistantMode: resolvedAssistantMode,
      success: meta.success ?? true,
      error: meta.error,
      plan: meta.plan,
      metrics: {
        planner_v2: runtimeFlags.plannerV2,
        hybrid_retrieval: runtimeFlags.hybridRetrieval,
        conversation_memory: runtimeFlags.conversationMemory,
        ...(meta.metrics ?? {}),
      },
      citationsCount: withSession.citations.length,
      resultsCount: withSession.relatedResults.length,
      latencyMs: Date.now() - startedAt,
    })
    return withSession
  }

  const finalizeLlmUnavailable = async (
    detail: string,
    meta: {
      plan?: Record<string, unknown>
      metrics?: Record<string, unknown>
    } = {},
  ) => {
    await emitTrace(options, {
      id: "llm-required",
      status: "warning",
      label: "LLM unavailable",
      detail,
      thought: "Model call failed, and deterministic fallback is disabled.",
    })
    return finalizeResponse(
      buildLlmUnavailableResponse({
        nowIso,
        assistantMode,
        provider: aiConfig.provider,
        model: aiConfig.model,
        configSource: aiConfig.source,
      }),
      {
        success: false,
        error: "llm_unavailable",
        plan: meta.plan,
        metrics: {
          llm_required: REQUIRE_LLM_FOR_AI_SEARCH,
          llm_unavailable: true,
          ...(meta.metrics ?? {}),
        },
      },
    )
  }

  if (isGreetingOrSmallTalkQuery(normalizedQuery)) {
    await emitTrace(options, {
      id: "social-intent",
      status: "completed",
      label: "Greeting detected",
      detail: "Responding conversationally without running org data retrieval.",
      thought: "This is a conversational prompt, so I will respond directly.",
    })

    return finalizeResponse(
      {
        answer: buildGreetingResponse(normalizedQuery),
        citations: [],
        relatedResults: [],
        generatedAt: nowIso,
        assistantMode,
        mode: "fallback",
        provider: aiConfig.provider,
        model: aiConfig.model,
        configSource: aiConfig.source,
        confidence: "high",
        missingData: [],
      },
      {
        plan: { social_intent: true },
        metrics: { social_intent: true },
      },
    )
  }

  if (assistantRuntimeInfoQuery) {
    const openAiBaseUrl = aiConfig.provider === "openai" ? getOpenAiBaseUrl() : undefined
    const endpointNote = openAiBaseUrl
      ? ` via the OpenAI-compatible endpoint at ${openAiBaseUrl}`
      : ""
    const sourceNote =
      aiConfig.source === "org"
        ? "This setting is coming from your org override."
        : aiConfig.source === "platform"
          ? "This setting is coming from the platform default."
          : aiConfig.source === "env"
            ? "This setting is coming from local environment defaults."
            : "This is the built-in default configuration."

    await emitTrace(options, {
      id: "assistant-runtime-info",
      status: "completed",
      label: "Resolved assistant runtime",
      detail: "Answered directly from the active AI configuration without querying org data.",
      thought: "This is a question about the assistant itself, so I can answer from config immediately.",
    })

    return finalizeResponse(
      {
        answer: `This chat is currently configured to use the ${aiConfig.provider} provider with the model "${aiConfig.model}"${endpointNote}. ${sourceNote}`,
        citations: [],
        relatedResults: [],
        generatedAt: nowIso,
        assistantMode: "general",
        mode: "fallback",
        provider: aiConfig.provider,
        model: aiConfig.model,
        configSource: aiConfig.source,
        confidence: "high",
        missingData: ["This answer is based on runtime configuration, not org records."],
      },
      {
        plan: { mode: "general", runtime_info: true },
        metrics: { runtime_info: true },
      },
    )
  }

  const clarification = requiresClarification({
    query: normalizedQuery,
    mode: assistantMode,
    sessionContext,
  })
  if (clarification) {
    await emitTrace(options, {
      id: "clarification-needed",
      status: "warning",
      label: "Need more context",
      detail: "Asking a clarifying follow-up before running tools.",
    })

    return finalizeResponse(
      {
        answer: clarification,
        citations: [],
        relatedResults: [],
        generatedAt: nowIso,
        assistantMode,
        mode: "fallback",
        provider: aiConfig.provider,
        model: aiConfig.model,
        configSource: aiConfig.source,
        confidence: "low",
        missingData: ["Scope or time range was ambiguous."],
      },
      {
        plan: { clarification: true },
        metrics: { clarification: true },
      },
    )
  }

  if (assistantMode === "general") {
    await emitTrace(options, {
      id: "general-assistant",
      status: "running",
      label: "Running general response",
      detail: "Using non-org reasoning without company-record citations.",
    })

    const generalAnswer = await generateGeneralAssistantAnswer({
      query: normalizedQuery,
      provider: aiConfig.provider,
      model: aiConfig.model,
      sessionContext: runtimeFlags.conversationMemory ? sessionContext : undefined,
    })

    if (REQUIRE_LLM_FOR_AI_SEARCH && !generalAnswer) {
      return finalizeLlmUnavailable("General model generation failed or timed out.", {
        plan: { mode: "general" },
        metrics: { general_mode: true },
      })
    }

    await emitTrace(options, {
      id: "done",
      status: "completed",
      label: "Answer ready",
      detail: generalAnswer ? "Generated by model synthesis." : "Returned compatibility fallback.",
    })

    return finalizeResponse(
      {
        answer:
          generalAnswer?.answer ??
          "I could not generate a general answer right now. Try again, or ask a company-data question.",
        citations: [],
        relatedResults: [],
        generatedAt: nowIso,
        assistantMode,
        mode: generalAnswer ? "llm" : "fallback",
        provider: generalAnswer?.provider ?? aiConfig.provider,
        model: generalAnswer?.model ?? aiConfig.model,
        configSource: aiConfig.source,
        confidence: generalAnswer ? "medium" : "low",
        missingData: ["This response path is not grounded in company records."],
      },
      {
        plan: { mode: "general" },
        metrics: { general_mode: true },
      },
    )
  }

  if (!REQUIRE_LLM_FOR_AI_SEARCH && assistantMode === "org") {
    const attributeIntent = detectEntityAttributeIntent(normalizedQuery)
    if (attributeIntent) {
      await emitTrace(options, {
        id: "attribute-lookup",
        status: "running",
        label: "Resolving field lookup",
        detail: "Locating the requested record and reading the exact field value.",
        thought: "Running deterministic field lookup before broad retrieval.",
      })

      const attributeExecution = await executeEntityAttributeLookupIntent(attributeIntent, normalizedQuery, context)
      const sources: RetrievedSource[] = attributeExecution.relatedResult
        ? [{ sourceId: "S1", result: attributeExecution.relatedResult }]
        : []
      const citations = sources.map(mapCitation)

      await emitTrace(options, {
        id: "done",
        status: attributeExecution.missingData.length > 0 ? "warning" : "completed",
        label: "Answer ready",
        detail:
          attributeExecution.missingData.length > 0
            ? "Field lookup completed with missing data."
            : "Field lookup completed successfully.",
        thought:
          attributeExecution.missingData.length > 0
            ? "Field lookup ran, but the requested value was missing or ambiguous."
            : "Field lookup produced a deterministic answer.",
      })

      return finalizeResponse(
        {
          answer: attributeExecution.answer,
          citations,
          relatedResults: attributeExecution.relatedResult ? [mapRelatedResult(attributeExecution.relatedResult)] : [],
          generatedAt: nowIso,
          assistantMode,
          mode: "fallback",
          provider: aiConfig.provider,
          model: aiConfig.model,
          configSource: aiConfig.source,
          confidence: attributeExecution.confidence,
          missingData: attributeExecution.missingData,
        },
        {
          plan: {
            planner: "entity_attribute_lookup",
            entity: attributeIntent.entityType,
            field: attributeIntent.fieldKey,
          },
          metrics: {
            attribute_lookup: true,
            has_result: Boolean(attributeExecution.relatedResult),
          },
        },
      )
    }
  }

  const canonicalMetricIntent = detectCanonicalMetricIntent(normalizedQuery, limit)
  if (!REQUIRE_LLM_FOR_AI_SEARCH && assistantMode === "org" && canonicalMetricIntent) {
    await emitTrace(options, {
      id: "canonical-metric",
      status: "running",
      label: "Running canonical metric tool",
      detail: `${canonicalMetricIntent.label} (${canonicalMetricIntent.key})`,
      thought: "Routing to canonical metrics for a reliable business answer.",
    })

    const canonicalExecution = await executeCanonicalMetricIntent(canonicalMetricIntent, context, {
      enableHybridRetrieval: runtimeFlags.hybridRetrieval,
    })
    const relatedResults = canonicalExecution.relatedResults
    const sources: RetrievedSource[] = relatedResults
      .slice(0, MAX_CONTEXT_SOURCES)
      .map((result, index) => ({
        sourceId: `S${index + 1}`,
        result,
      }))
    const canonicalContext = [
      canonicalExecution.additionalContext,
      `Canonical metric: ${canonicalMetricIntent.key}`,
      canonicalMetricIntent.projectName ? `Project hint: ${canonicalMetricIntent.projectName}` : "",
      canonicalMetricIntent.dateRangeDays ? `Date range days: ${canonicalMetricIntent.dateRangeDays}` : "",
    ]
      .filter((line) => line.trim().length > 0)
      .join("\n")

    const llmAnswer = await generateAnswerWithLlm(
      normalizedQuery,
      sources,
      aiConfig.provider,
      aiConfig.model,
      [sessionContextBlock, canonicalContext].filter((line) => line.trim().length > 0).join("\n\n") || undefined,
    )
    if (REQUIRE_LLM_FOR_AI_SEARCH && !llmAnswer) {
      return finalizeLlmUnavailable("Canonical metric synthesis failed or timed out.", {
        plan: {
          planner: "canonical_metric",
          metric: canonicalMetricIntent.key,
          project: canonicalMetricIntent.projectName ?? null,
          groupBy: canonicalMetricIntent.groupBy,
        },
        metrics: {
          canonical_metric: canonicalMetricIntent.key,
          rows_scanned: canonicalExecution.rowCount,
        },
      })
    }

    const verification = verifyGroundedAnswer({
      llmAnswer,
      sources,
      fallbackAnswer: canonicalExecution.summary,
      rowCount: canonicalExecution.rowCount,
      baseConfidence: canonicalExecution.confidence,
      missingData: canonicalExecution.missingData,
    })
    const citations = resolveCitations(sources, verification.citationIds).map(mapCitation)

    await emitTrace(options, {
      id: "canonical-verify",
      status: verification.downgradedToFallback ? "warning" : "completed",
      label: "Verification complete",
      detail: verification.downgradedToFallback
        ? "Model output was corrected to grounded deterministic summary."
        : "Model output passed grounding checks.",
      thought: verification.notes[0] ?? "Grounding and citation checks completed.",
    })

    await emitTrace(options, {
      id: "done",
      status: "completed",
      label: "Answer ready",
      detail: "Delivered from canonical metric pipeline.",
      thought: "Canonical metric response is ready.",
    })

    return finalizeResponse(
      {
        answer: verification.answer,
        citations,
        relatedResults: relatedResults.slice(0, 8).map(mapRelatedResult),
        generatedAt: nowIso,
        assistantMode,
        mode: llmAnswer && !verification.downgradedToFallback ? "llm" : "fallback",
        provider: llmAnswer?.provider ?? aiConfig.provider,
        model: llmAnswer?.model ?? aiConfig.model,
        configSource: aiConfig.source,
        confidence: verification.confidence,
        missingData: verification.missingData,
        artifact: canonicalExecution.artifactData.artifact,
        exports: canonicalExecution.artifactData.exports,
      },
      {
        plan: {
          planner: "canonical_metric",
          metric: canonicalMetricIntent.key,
          project: canonicalMetricIntent.projectName ?? null,
          groupBy: canonicalMetricIntent.groupBy,
        },
        metrics: {
          canonical_metric: canonicalMetricIntent.key,
          rows_scanned: canonicalExecution.rowCount,
          verification_downgraded: verification.downgradedToFallback,
        },
      },
    )
  }

  const mappedTool = planAiToolInvocation(normalizedQuery)
  const shouldRunToolShortcut = Boolean(
    mappedTool &&
      mappedTool.confidence >= 0.8 &&
      (isAiActionToolKey(mappedTool.toolKey) || mappedTool.toolKey === "records.search"),
  )
  if (!REQUIRE_LLM_FOR_AI_SEARCH && mappedTool && shouldRunToolShortcut) {
    await emitTrace(options, {
      id: "tool-router",
      status: "running",
      label: "Selecting best tool",
      detail: `${mappedTool.toolKey} (${Math.round(mappedTool.confidence * 100)}% confidence).`,
      thought: `This request maps best to ${mappedTool.toolKey}, so I am using that path first.`,
    })

    if (isAiActionToolKey(mappedTool.toolKey)) {
      try {
        const actionDraft = buildAiActionDraft(mappedTool.toolKey, mappedTool.args)
        if (actionDraft) {
          await emitTrace(options, {
            id: "action-proposal",
            status: "running",
            label: "Drafting action request",
            detail: "Creating a pending action that requires your approval before execution.",
            thought: "Drafting an executable action and holding it for your approval.",
          })

          const action = await createAiSearchActionRequest(context, {
            sessionId,
            toolKey: mappedTool.toolKey,
            title: actionDraft.title,
            summary: actionDraft.summary,
            args: actionDraft.args,
            requiresApproval: actionDraft.requiresApproval,
          })

          await emitTrace(options, {
            id: "done",
            status: "completed",
            label: "Action draft ready",
            detail: "I prepared the action. It will run only after you approve it.",
            thought: "Action draft is ready. Waiting for your approval.",
          })

          return finalizeResponse(
            {
              answer: "I drafted an action for you. Review it below and click Execute when you want it to run.",
              citations: [],
              relatedResults: [],
              generatedAt: nowIso,
              assistantMode,
              mode: "fallback",
              provider: aiConfig.provider,
              model: aiConfig.model,
              configSource: aiConfig.source,
              confidence: "high",
              missingData: [],
              actions: [action],
            },
            {
              plan: {
                planner: "tool_router",
                tool: mappedTool.toolKey,
                reason: mappedTool.reason,
                confidence: mappedTool.confidence,
                action_proposed: true,
              },
              metrics: {
                action_proposed: true,
              },
            },
          )
        }
      } catch (error) {
        await emitTrace(options, {
          id: "action-proposal-failed",
          status: "warning",
          label: "Action draft failed",
          detail: "I could not create an action draft, so I am switching to read-only planning.",
          thought: "Action draft failed. Falling back to read-only analysis.",
        })
        console.error("Action proposal failed", error)
      }
    }

    try {
      const toolExecution = await executeAiToolInvocation(context, mappedTool)
      if (toolExecution) {
        await emitTrace(options, {
          id: "tool-run",
          status: "completed",
          label: "Tool execution complete",
          detail: `${toolExecution.rows.toLocaleString()} rows processed.`,
          thought: `Tool run complete with ${toolExecution.rows.toLocaleString()} matching rows.`,
        })

        const relatedResults = dedupeResults(toolExecution.relatedResults).slice(0, Math.max(limit, 12))
        const sources: RetrievedSource[] = relatedResults
          .slice(0, MAX_CONTEXT_SOURCES)
          .map((result, index) => ({
            sourceId: `S${index + 1}`,
            result,
          }))

        if (
          assistantMode === "org" && toolExecution.rows === 0 && isLikelyGeneralNonOrgQuery(normalizedQuery)
        ) {
          await emitTrace(options, {
            id: "general-rescue",
            status: "running",
            label: "Switching to general reasoning",
            detail: "Tool execution returned no org rows. Generating a direct general answer.",
            thought: "Tool path had no org evidence, so switching to general fallback.",
          })

          const generalAnswer = await generateGeneralAssistantAnswer({
            query: normalizedQuery,
            provider: aiConfig.provider,
            model: aiConfig.model,
            sessionContext: runtimeFlags.conversationMemory ? sessionContext : undefined,
          })

          if (generalAnswer) {
            await emitTrace(options, {
              id: "done",
              status: "completed",
              label: "Answer ready",
              detail: "Returned from general-assistant fallback.",
              thought: "General fallback succeeded after zero-row tool output.",
            })

            return finalizeResponse(
              {
                answer: generalAnswer.answer,
                citations: [],
                relatedResults: [],
                generatedAt: nowIso,
                assistantMode: "general",
                mode: "llm",
                provider: generalAnswer.provider,
                model: generalAnswer.model,
                configSource: aiConfig.source,
                confidence: "medium",
                missingData: ["No matching org records were found for this query."],
              },
              {
                plan: {
                  planner: "tool_router",
                  tool: mappedTool.toolKey,
                  general_rescue: true,
                },
                metrics: {
                  tool_rows: 0,
                  general_rescue: true,
                },
              },
            )
          }
        }

        const toolContext = [
          `Tool: ${mappedTool.toolKey}`,
          `Reason: ${mappedTool.reason}`,
          `Rows: ${toolExecution.rows}`,
          typeof toolExecution.metric === "number" ? `Metric: ${toolExecution.metric}` : "",
          toolExecution.summary,
        ]
          .filter((line) => line.trim().length > 0)
          .join("\n")

        const llmAnswer = await generateAnswerWithLlm(
          normalizedQuery,
          sources,
          aiConfig.provider,
          aiConfig.model,
          [sessionContextBlock, toolContext].filter((line) => line.trim().length > 0).join("\n\n") || undefined,
        )
        if (REQUIRE_LLM_FOR_AI_SEARCH && !llmAnswer) {
          return finalizeLlmUnavailable("Tool synthesis failed or timed out.", {
            plan: {
              planner: "tool_router",
              tool: mappedTool.toolKey,
              reason: mappedTool.reason,
              confidence: mappedTool.confidence,
            },
            metrics: {
              tool_rows: toolExecution.rows,
              tool_metric: typeof toolExecution.metric === "number" ? toolExecution.metric : null,
            },
          })
        }
        const citations = resolveCitations(sources, llmAnswer?.citationIds ?? []).map(mapCitation)
        const artifactData = buildArtifactForFallback(orgId, relatedResults)
        const response: AskAiSearchResponse = {
          answer: llmAnswer?.answer ?? toolExecution.summary,
          citations,
          relatedResults: relatedResults.slice(0, 8).map(mapRelatedResult),
          generatedAt: nowIso,
          assistantMode,
          mode: llmAnswer ? "llm" : "fallback",
          provider: llmAnswer?.provider ?? aiConfig.provider,
          model: llmAnswer?.model ?? aiConfig.model,
          configSource: aiConfig.source,
          confidence: inferConfidenceFromResponse({
            rowCount: toolExecution.rows,
            citationsCount: citations.length,
            fallback: toolExecution.rows > 0 ? "high" : "low",
          }),
          missingData:
            toolExecution.rows > 0
              ? []
              : ["Tool matched intent but returned no rows in current org scope."],
          artifact: artifactData.artifact,
          exports: artifactData.exports,
        }

        await emitTrace(options, {
          id: "done",
          status: "completed",
          label: "Answer ready",
          detail: "Generated from deterministic tool execution.",
          thought: "Response is ready from deterministic tool output.",
        })

        return finalizeResponse(response, {
          plan: {
            planner: "tool_router",
            tool: mappedTool.toolKey,
            reason: mappedTool.reason,
            confidence: mappedTool.confidence,
          },
          metrics: {
            tool_rows: toolExecution.rows,
            tool_metric: typeof toolExecution.metric === "number" ? toolExecution.metric : null,
          },
        })
      }
    } catch (error) {
      await emitTrace(options, {
        id: "tool-router-failed",
        status: "warning",
        label: "Tool execution fallback",
        detail: "Tool execution failed; continuing with planner path.",
      })
      console.error("Tool-router execution failed", error)
    }
  }

  await emitTrace(options, {
    id: "plan-query",
    status: "running",
    label: "Planning query",
    detail: "Selecting best datasets and query strategy.",
  })
  const plannerLoopResult = runtimeFlags.plannerV2
    ? await runPlannerExecutorLoop({
        normalizedQuery,
        plannerQuery,
        sessionContext,
        provider: aiConfig.provider,
        model: aiConfig.model,
        limit,
        context,
        runtimeFlags,
      })
    : null

  if (runtimeFlags.plannerV2 && plannerLoopResult) {
    const { agentPlan, finalPlan, execution, stepPlans, attempt, plannedFromQuery } = plannerLoopResult
    await emitTrace(options, {
      id: "plan-ready",
      status: "completed",
      label: "Plan ready",
      detail: `${agentPlan.operation} on ${formatEntityType(agentPlan.entityType)} (attempt ${attempt}).`,
      thought: attempt > 1 ? "First plan was weak, so I replanned with adjusted context." : "Planner produced a high-confidence first-pass plan.",
    })
    await emitTrace(options, {
      id: "run-query",
      status: "running",
      label: "Running org-scoped queries",
      detail: "Executing read-only queries with safety guards.",
    })
    await emitTrace(options, {
      id: "query-complete",
      status: "completed",
      label: "Data fetched",
      detail:
        stepPlans.length > 1
          ? `${execution.rowCount.toLocaleString()} records matched across ${stepPlans.length} steps.`
          : `${execution.rowCount.toLocaleString()} records matched after validation.`,
    })
    const relatedResults = execution.relatedResults
    const sources: RetrievedSource[] = relatedResults
      .slice(0, MAX_CONTEXT_SOURCES)
      .map((result, index) => ({
        sourceId: `S${index + 1}`,
        result,
      }))

    const agentContext = [
      execution.additionalContext ?? "",
      `Final plan: operation=${finalPlan.operation}, entity=${finalPlan.entityType}, metric=${finalPlan.metric}, groupBy=${finalPlan.groupBy}`,
      finalPlan.projectName ? `Project hint: ${finalPlan.projectName}` : "",
    ]
      .filter((line) => line.trim().length > 0)
      .join("\n")

    if (
      assistantMode === "org" && relatedResults.length === 0 && isLikelyGeneralNonOrgQuery(normalizedQuery)
    ) {
      await emitTrace(options, {
        id: "general-rescue",
        status: "running",
        label: "Switching to general reasoning",
        detail: "No org records matched the planned query. Generating a direct general answer.",
        thought: "Planner returned no org evidence, so switching to general fallback.",
      })

      const generalAnswer = await generateGeneralAssistantAnswer({
        query: normalizedQuery,
        provider: aiConfig.provider,
        model: aiConfig.model,
        sessionContext: runtimeFlags.conversationMemory ? sessionContext : undefined,
      })

      if (generalAnswer) {
        await emitTrace(options, {
          id: "done",
          status: "completed",
          label: "Answer ready",
          detail: "Returned from general-assistant fallback.",
          thought: "General fallback succeeded after planner returned no records.",
        })

        return finalizeResponse(
          {
            answer: generalAnswer.answer,
            citations: [],
            relatedResults: [],
            generatedAt: nowIso,
            assistantMode: "general",
            mode: "llm",
            provider: generalAnswer.provider,
            model: generalAnswer.model,
            configSource: aiConfig.source,
            confidence: "medium",
            missingData: ["No matching org records were found for this query."],
          },
          {
            plan: {
              planner: "v2_loop",
              general_rescue: true,
              attempts: attempt,
            },
            metrics: {
              rows_scanned: 0,
              general_rescue: true,
            },
          },
        )
      }
    }

    await emitTrace(options, {
      id: "synthesize",
      status: "running",
      label: "Composing response",
      detail: "Summarizing results and preparing citations.",
    })
    const llmAnswer = await generateAnswerWithLlm(
      normalizedQuery,
      sources,
      aiConfig.provider,
      aiConfig.model,
      [sessionContextBlock, agentContext].filter((line) => line.trim().length > 0).join("\n\n") || undefined,
    )
    if (REQUIRE_LLM_FOR_AI_SEARCH && !llmAnswer) {
      return finalizeLlmUnavailable("Planner synthesis failed or timed out.", {
        plan: {
          planner: "v2_loop",
          operation: finalPlan.operation,
          entity: finalPlan.entityType,
          planned_from_query: plannedFromQuery,
          attempts: attempt,
          steps: stepPlans.map((step) => ({
            operation: step.operation,
            entity: step.entityType,
            metric: step.metric,
            groupBy: step.groupBy,
          })),
        },
        metrics: {
          rows_scanned: execution.rowCount,
          step_count: stepPlans.length,
          planner_attempts: attempt,
        },
      })
    }
    const verification = verifyGroundedAnswer({
      llmAnswer,
      sources,
      fallbackAnswer: execution.answerFallback,
      rowCount: execution.rowCount,
      baseConfidence: execution.confidence,
      missingData: execution.missingData,
    })
    const citations = resolveCitations(sources, verification.citationIds).map(mapCitation)
    await emitTrace(options, {
      id: "verify-grounding",
      status: verification.downgradedToFallback ? "warning" : "completed",
      label: "Verifying grounded answer",
      detail: verification.downgradedToFallback
        ? "Model answer was adjusted to deterministic grounded output."
        : "Grounding verification passed.",
      thought: verification.notes[0] ?? "Grounding verification completed.",
    })

    const response: AskAiSearchResponse = {
      answer: verification.answer,
      citations,
      relatedResults: relatedResults.slice(0, 8).map(mapRelatedResult),
      generatedAt: nowIso,
      assistantMode,
      mode: llmAnswer && !verification.downgradedToFallback ? "llm" : "fallback",
      provider: llmAnswer?.provider ?? aiConfig.provider,
      model: llmAnswer?.model ?? aiConfig.model,
      configSource: aiConfig.source,
      confidence: verification.confidence,
      missingData: verification.missingData,
      artifact: execution.artifactData.artifact,
      exports: execution.artifactData.exports,
    }

    await emitTrace(options, {
      id: "done",
      status: "completed",
      label: "Answer ready",
      detail: llmAnswer ? "Generated with model synthesis." : "Generated from deterministic summary.",
    })

    return finalizeResponse(response, {
      plan: {
        planner: "v2_loop",
        operation: finalPlan.operation,
        entity: finalPlan.entityType,
        planned_from_query: plannedFromQuery,
        attempts: attempt,
        steps: stepPlans.map((step) => ({
          operation: step.operation,
          entity: step.entityType,
          metric: step.metric,
          groupBy: step.groupBy,
        })),
      },
      metrics: {
        rows_scanned: execution.rowCount,
        step_count: stepPlans.length,
        planner_attempts: attempt,
        verification_downgraded: verification.downgradedToFallback,
      },
    })
  }

  if (REQUIRE_LLM_FOR_AI_SEARCH && runtimeFlags.plannerV2) {
    return finalizeLlmUnavailable("Planner model was unavailable, so no query plan could be generated.", {
      plan: { planner: "v2_loop", planner_result: "none" },
      metrics: { planner_v2: true, planner_result_none: true },
    })
  }

  await emitTrace(options, {
    id: "planner-no-plan",
    status: "warning",
    label: "Planner could not finalize",
    detail: "I could not produce a reliable v2 plan, so I am switching to grounded retrieval.",
    thought: "Planner confidence was low, so I am falling back to broad grounded retrieval.",
  })

  await emitTrace(options, {
    id: "run-query-fallback",
    status: "running",
    label: "Running broad retrieval",
    detail: "Searching across core entity types in your organization.",
    thought: "Running broad org-scoped retrieval as a safety fallback.",
  })
  const entityTypes = pickEntityTypesForQuery(normalizedQuery)
  const retrievalQuery = extractRetrievalQuery(normalizedQuery)
  const rawResults = await retrieveHybridResults({
    context: { orgId, supabase, userId },
    query: retrievalQuery,
    entityTypes,
    filters: {},
    limit,
    enableHybrid: runtimeFlags.hybridRetrieval,
  })

  const relatedResults = dedupeResults(rawResults).slice(0, limit)
  const sources: RetrievedSource[] = relatedResults
    .slice(0, MAX_CONTEXT_SOURCES)
    .map((result, index) => ({
      sourceId: `S${index + 1}`,
      result,
    }))

  if (
    assistantMode === "org" && relatedResults.length === 0 && isLikelyGeneralNonOrgQuery(normalizedQuery)
  ) {
    await emitTrace(options, {
      id: "general-rescue",
      status: "running",
      label: "Switching to general reasoning",
      detail: "No org records matched. Generating a direct general answer.",
      thought: "No org evidence was found, so switching to general assistance for this query.",
    })

    const generalAnswer = await generateGeneralAssistantAnswer({
      query: normalizedQuery,
      provider: aiConfig.provider,
      model: aiConfig.model,
      sessionContext: runtimeFlags.conversationMemory ? sessionContext : undefined,
    })

    if (generalAnswer) {
      await emitTrace(options, {
        id: "done",
        status: "completed",
        label: "Answer ready",
        detail: "Returned from general-assistant fallback.",
        thought: "General fallback succeeded after org retrieval returned no records.",
      })
      return finalizeResponse(
        {
          answer: generalAnswer.answer,
          citations: [],
          relatedResults: [],
          generatedAt: nowIso,
          assistantMode: "general",
          mode: "llm",
          provider: generalAnswer.provider,
          model: generalAnswer.model,
          configSource: aiConfig.source,
          confidence: "medium",
          missingData: ["No matching org records were found for this query."],
        },
        {
          plan: {
            planner: "v2_retrieval_fallback",
            general_rescue: true,
          },
          metrics: {
            rows_scanned: 0,
            general_rescue: true,
          },
        },
      )
    }
  }

  const llmAnswer = await generateAnswerWithLlm(
    normalizedQuery,
    sources,
    aiConfig.provider,
    aiConfig.model,
    sessionContextBlock || undefined,
  )
  if (REQUIRE_LLM_FOR_AI_SEARCH && !llmAnswer) {
    return finalizeLlmUnavailable("Grounded retrieval synthesis failed or timed out.", {
      plan: {
        planner: "v2_retrieval_fallback",
        entity_types: entityTypes,
      },
      metrics: {
        rows_scanned: relatedResults.length,
      },
    })
  }
  const fallbackAnswer = buildFallbackAnswer(normalizedQuery, relatedResults)
  const verification = verifyGroundedAnswer({
    llmAnswer,
    sources,
    fallbackAnswer,
    rowCount: relatedResults.length,
    baseConfidence: inferConfidenceFromResponse({
      rowCount: relatedResults.length,
      citationsCount: sources.length,
      fallback: relatedResults.length > 0 ? "medium" : "low",
    }),
    missingData:
      relatedResults.length > 0 ? [] : ["No strong matches found. Try adding project, status, or timeframe."],
  })
  const citations = resolveCitations(sources, verification.citationIds).map(mapCitation)
  const artifactData = buildArtifactForFallback(orgId, relatedResults)
  const response: AskAiSearchResponse = {
    answer: verification.answer,
    citations,
    relatedResults: relatedResults.slice(0, 8).map(mapRelatedResult),
    generatedAt: nowIso,
    assistantMode,
    mode: llmAnswer && !verification.downgradedToFallback ? "llm" : "fallback",
    provider: llmAnswer?.provider ?? aiConfig.provider,
    model: llmAnswer?.model ?? aiConfig.model,
    configSource: aiConfig.source,
    confidence: verification.confidence,
    missingData: verification.missingData,
    artifact: artifactData.artifact,
    exports: artifactData.exports,
  }

  await emitTrace(options, {
    id: "verify-grounding-fallback",
    status: verification.downgradedToFallback ? "warning" : "completed",
    label: "Verifying grounded answer",
    detail: verification.downgradedToFallback
      ? "Model answer was replaced with grounded retrieval summary."
      : "Grounding verification passed.",
    thought: verification.notes[0] ?? "Grounding verification completed.",
  })

  await emitTrace(options, {
    id: "done",
    status: "completed",
    label: "Answer ready",
    detail: llmAnswer ? "Generated with model synthesis." : "Generated from retrieval summary.",
  })
  return finalizeResponse(response, {
    plan: {
      planner: "v2_retrieval_fallback",
      entity_types: entityTypes,
    },
    metrics: {
      rows_scanned: relatedResults.length,
      verification_downgraded: verification.downgradedToFallback,
    },
  })
}
