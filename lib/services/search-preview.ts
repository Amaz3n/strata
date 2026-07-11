import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"

import { requireOrgContext, type OrgServiceContext } from "@/lib/services/context"
import {
  SEARCH_CONFIGS,
  buildEntitySelectClause,
  PROJECT_SCOPED_ENTITY_TYPES,
  type SearchEntityType,
} from "@/lib/services/search-config"
import { buildDrawingsImageUrl } from "@/lib/storage/drawings-urls"

// Lightweight, uniform "peek" data for a single entity, used by the morphing
// command-search preview before the user navigates to the full detail
// sheet/page. Reads only the fields the search config already selects, so it
// works for every entity type without bespoke getById coverage and never
// touches columns that may not exist.

export interface EntityPreviewRow {
  label: string
  value: string
}

// Broad visual grouping used by the client to pick an accent color and layout
// for the preview card. Derived purely from the entity type.
export type PreviewCategory = "financial" | "people" | "request" | "schedule" | "document" | "general"

// Semantic meaning of a status string, mapped to a color on the client.
export type StatusTone = "success" | "warning" | "danger" | "info" | "neutral"

// The hero metric shown prominently at the top of a financial preview.
export interface PreviewHeadline {
  value: string
  caption?: string
}

export interface EntityPreview {
  id: string
  type: SearchEntityType
  title: string
  category: PreviewCategory
  status?: string
  statusTone?: StatusTone
  headline?: PreviewHeadline
  rows: EntityPreviewRow[]
  description?: string
  projectId?: string
  projectName?: string
  thumbnailUrl?: string
  href: string
}

const CATEGORY_BY_TYPE: Record<SearchEntityType, PreviewCategory> = {
  invoice: "financial",
  payment: "financial",
  budget: "financial",
  budget_transfer: "financial",
  estimate: "financial",
  commitment: "financial",
  change_order: "financial",
  contract: "financial",
  proposal: "financial",
  pay_application: "financial",
  payable: "financial",
  expense: "financial",
  contact: "people",
  company: "people",
  prospect: "people",
  prequalification: "people",
  rfi: "request",
  submittal: "request",
  meeting: "document",
  transmittal: "document",
  punch_item: "request",
  file: "document",
  drawing_set: "document",
  drawing_sheet: "document",
  daily_log: "document",
  photo: "document",
  task: "schedule",
  schedule_item: "schedule",
  inspection: "request",
  safety_incident: "request",
  observation: "request",
  project: "general",
  portal_access: "general",
}

// Integer-cents columns that can serve as a preview's hero amount, in priority order.
const HEADLINE_AMOUNT_FIELDS = ["total_cents", "amount_cents"] as const

function statusToneFor(status?: string | null): StatusTone {
  if (!status) return "neutral"
  const s = status.toLowerCase()
  if (/(paid|approved|complete|closed|resolved|accepted|active|signed|won|executed|published|answered|installed|done)/.test(s)) {
    return "success"
  }
  if (/(overdue|past[_\s]?due|rejected|fail|void|cancel|declin|expired|lost|disputed|blocked|revise)/.test(s)) {
    return "danger"
  }
  if (/(pending|draft|open|sent|review|submitted|awaiting|hold|partial|in[_\s]?progress|new|requested|active)/.test(s)) {
    return "warning"
  }
  return "neutral"
}

function formatCurrencyCents(value: number): string {
  return `$${(value / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// Promotes the entity's primary amount into a hero metric for financial cards.
// Returns the fields it consumed so they aren't repeated in the facts grid.
function computeHeadline(
  category: PreviewCategory,
  row: Record<string, unknown>,
): { headline?: PreviewHeadline; consumed: Set<string> } {
  const consumed = new Set<string>()
  if (category !== "financial") return { consumed }

  let amountField: string | null = null
  let amountValue: number | null = null
  for (const field of HEADLINE_AMOUNT_FIELDS) {
    const raw = row[field]
    if (raw !== null && raw !== undefined && Number.isFinite(Number(raw))) {
      amountField = field
      amountValue = Number(raw)
      break
    }
  }
  if (amountField === null || amountValue === null) return { consumed }
  consumed.add(amountField)

  let caption: string | undefined
  const rawBalance = row.balance_due_cents
  if (rawBalance !== null && rawBalance !== undefined && Number.isFinite(Number(rawBalance))) {
    consumed.add("balance_due_cents")
    const balance = Number(rawBalance)
    if (balance <= 0) {
      caption = "Paid in full"
    } else if (balance !== amountValue) {
      caption = `Balance due ${formatCurrencyCents(balance)}`
    }
  }

  return { headline: { value: formatCurrencyCents(amountValue), caption }, consumed }
}

const FIELD_LABELS: Record<string, string> = {
  status: "Status",
  priority: "Priority",
  invoice_number: "Invoice #",
  bill_number: "Bill #",
  submittal_number: "Submittal #",
  rfi_number: "RFI #",
  number: "Number",
  total_cents: "Total",
  subtotal_cents: "Subtotal",
  tax_cents: "Tax",
  balance_due_cents: "Balance due",
  amount_cents: "Amount",
  size_bytes: "Size",
  category: "Category",
  company_type: "Type",
  project_type: "Type",
  submittal_type: "Type",
  contact_type: "Type",
  email: "Email",
  phone: "Phone",
  website: "Website",
  address: "Address",
  role: "Role",
  method: "Method",
  payment_method: "Method",
  phase: "Phase",
  discipline: "Discipline",
  severity: "Severity",
  location: "Location",
  log_date: "Date",
  issue_date: "Issued",
  due_date: "Due",
  bill_date: "Billed",
  expense_date: "Date",
  valid_until: "Valid until",
  approved_at: "Approved",
  start_date: "Start",
  end_date: "End",
  version: "Version",
  days_impact: "Schedule impact",
  taken_at: "Taken",
  portal_type: "Portal",
  vendor_name_text: "Vendor",
  spec_section: "Spec section",
  updated_at: "Updated",
}

// Additional columns (beyond the search config's subtitle/description fields)
// surfaced in the preview card, per entity type. Only columns that exist on the
// table — verified against the schema — so the select never 42703s.
const PREVIEW_EXTRA_FIELDS: Partial<Record<SearchEntityType, string[]>> = {
  invoice: ["issue_date", "due_date", "subtotal_cents", "tax_cents", "balance_due_cents"],
  payable: ["bill_date", "due_date"],
  expense: ["expense_date", "tax_cents", "payment_method"],
  change_order: ["days_impact", "approved_at"],
  estimate: ["version", "subtotal_cents", "tax_cents", "valid_until", "approved_at"],
  project: ["location", "start_date", "end_date"],
  contact: ["phone", "contact_type"],
  company: ["phone", "website", "address"],
  rfi: ["priority", "due_date"],
  submittal: ["submittal_type", "spec_section", "due_date"],
}

function humanizeField(field: string): string {
  if (FIELD_LABELS[field]) return FIELD_LABELS[field]
  return field
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

function formatFieldValue(field: string, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null
  if (field.endsWith("_cents")) {
    return `$${(Number(value) / 100).toLocaleString()}`
  }
  if (field === "size_bytes") {
    return `${(Number(value) / (1024 * 1024)).toFixed(1)} MB`
  }
  if (field === "days_impact") {
    const days = Number(value)
    if (!Number.isFinite(days) || days === 0) return null
    return `${days > 0 ? "+" : ""}${days} day${Math.abs(days) === 1 ? "" : "s"}`
  }
  if (field === "version") {
    return `v${value}`
  }
  // Date / timestamp columns.
  if (field.endsWith("_date") || field.endsWith("_at") || field.endsWith("_until")) {
    const date = new Date(String(value))
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString()
  }
  if (field === "status" || field === "priority") {
    const text = String(value)
    return text.charAt(0).toUpperCase() + text.slice(1)
  }
  return String(value)
}

function coerceProjectName(projectRelation: unknown): string | undefined {
  if (projectRelation && typeof projectRelation === "object" && !Array.isArray(projectRelation)) {
    const name = (projectRelation as Record<string, unknown>).name
    return typeof name === "string" ? name : undefined
  }
  if (Array.isArray(projectRelation) && projectRelation[0] && typeof projectRelation[0] === "object") {
    const name = (projectRelation[0] as Record<string, unknown>).name
    return typeof name === "string" ? name : undefined
  }
  return undefined
}

// Entity types worth showing a real image for. Anything else falls back to the
// icon + hero card.
const THUMBNAIL_TYPES = new Set<SearchEntityType>(["file", "photo", "drawing_sheet"])

interface FileThumbnailRow {
  id: string
  mime_type?: string | null
  file_name?: string | null
  storage_path?: string | null
  metadata?: unknown
}

// Mirrors the file-thumbnail resolution used by the files service: a generated
// preview when one exists, the original for direct-renderable images, and the
// on-demand preview endpoint for HEIC/HEIF.
function fileThumbnailUrl(file: FileThumbnailRow): string | undefined {
  const metadata = file.metadata && typeof file.metadata === "object" ? (file.metadata as Record<string, unknown>) : {}
  const preview = metadata.preview && typeof metadata.preview === "object" ? (metadata.preview as Record<string, unknown>) : {}
  if (typeof preview.thumbnail_path === "string" && preview.thumbnail_path.length > 0) {
    return `/api/files/${file.id}/preview`
  }

  const mime = (file.mime_type ?? "").toLowerCase()
  const name = (file.file_name ?? "").toLowerCase()
  const path = (file.storage_path ?? "").toLowerCase()
  const isHeic =
    mime === "image/heic" || mime === "image/heif" || /\.hei[cf]$/.test(name) || /\.hei[cf]$/.test(path)
  if (isHeic) return `/api/files/${file.id}/preview`
  if (mime.startsWith("image/")) return `/api/files/${file.id}/raw`
  return undefined
}

async function fetchFileThumbnail(
  supabase: SupabaseClient,
  orgId: string,
  fileId: string,
): Promise<string | undefined> {
  const { data } = await supabase
    .from("files")
    .select("id, mime_type, file_name, storage_path, metadata")
    .eq("org_id", orgId)
    .eq("id", fileId)
    .maybeSingle<FileThumbnailRow>()
  return data ? fileThumbnailUrl(data) : undefined
}

// Resolves a displayable thumbnail URL for the visual entity types. Runs at most
// two extra lightweight queries, and only for those types.
async function resolveThumbnailUrl(
  type: SearchEntityType,
  id: string,
  supabase: SupabaseClient,
  orgId: string,
): Promise<string | undefined> {
  if (!THUMBNAIL_TYPES.has(type)) return undefined

  try {
    if (type === "file") {
      return await fetchFileThumbnail(supabase, orgId, id)
    }

    if (type === "photo") {
      const { data } = await supabase
        .from("photos")
        .select("file_id")
        .eq("org_id", orgId)
        .eq("id", id)
        .maybeSingle<{ file_id?: string | null }>()
      return data?.file_id ? await fetchFileThumbnail(supabase, orgId, data.file_id) : undefined
    }

    if (type === "drawing_sheet") {
      const { data: sheet } = await supabase
        .from("drawing_sheets")
        .select("current_revision_id")
        .eq("org_id", orgId)
        .eq("id", id)
        .maybeSingle<{ current_revision_id?: string | null }>()
      if (!sheet?.current_revision_id) return undefined

      const { data: version } = await supabase
        .from("drawing_sheet_versions")
        .select("thumb_path, thumbnail_url")
        .eq("org_id", orgId)
        .eq("drawing_sheet_id", id)
        .eq("drawing_revision_id", sheet.current_revision_id)
        .maybeSingle<{ thumb_path?: string | null; thumbnail_url?: string | null }>()
      if (!version) return undefined
      return buildDrawingsImageUrl(version.thumb_path) ?? version.thumbnail_url ?? undefined
    }
  } catch (error) {
    console.warn(`[search-preview] thumbnail resolution failed for ${type}:${id}`, error)
  }

  return undefined
}

export async function getEntityPreview(
  { type, id }: { type: SearchEntityType; id: string },
  orgId?: string,
  context?: OrgServiceContext,
): Promise<EntityPreview | null> {
  const config = SEARCH_CONFIGS[type]
  if (!config || !id) return null

  const { supabase, orgId: resolvedOrgId } = context || (await requireOrgContext(orgId))
  const includeProject = PROJECT_SCOPED_ENTITY_TYPES.has(type)
  const baseSelect = buildEntitySelectClause(type, config, includeProject)
  const extraFields = PREVIEW_EXTRA_FIELDS[type] ?? []

  // Merge the base select with the preview's extra columns, de-duplicated.
  const selectTokens = new Set(baseSelect.split(","))
  for (const field of extraFields) selectTokens.add(field)
  const selectClause = Array.from(selectTokens).join(",")

  const { data: row, error } = await supabase
    .from(config.table)
    .select(selectClause)
    .eq("org_id", resolvedOrgId)
    .eq("id", id)
    .maybeSingle<Record<string, unknown>>()

  if (error || !row) return null

  const projectId =
    type === "project" ? id : typeof row.project_id === "string" ? row.project_id : undefined
  const projectName = includeProject ? coerceProjectName(row.projects) : undefined

  const title =
    typeof row[config.titleField] === "string" && (row[config.titleField] as string).trim().length > 0
      ? (row[config.titleField] as string)
      : `Untitled ${type}`

  const rawStatus = typeof row.status === "string" ? row.status : undefined
  const status = rawStatus ? formatFieldValue("status", rawStatus) ?? undefined : undefined

  const category = CATEGORY_BY_TYPE[type] ?? "general"
  const { headline, consumed } = computeHeadline(category, row)

  // Rows come from the configured subtitle fields plus the per-type extra
  // fields. Fields shown elsewhere (status badge, hero amount/balance) are
  // skipped to avoid duplication. De-duplicated and formatted, with a trailing
  // "Updated" timestamp for context.
  const rows: EntityPreviewRow[] = []
  const seenFields = new Set<string>()
  for (const field of [...(config.subtitleFields ?? []), ...extraFields, "updated_at"]) {
    if (field === "status" || consumed.has(field) || seenFields.has(field)) continue
    seenFields.add(field)
    const value = formatFieldValue(field, row[field])
    if (value !== null) rows.push({ label: humanizeField(field), value })
  }

  const description = (config.descriptionFields ?? [])
    .map((field) => row[field])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")

  const href = config.hrefTemplate.replace("{id}", id).replace("{project_id}", projectId ?? "")

  const thumbnailUrl = await resolveThumbnailUrl(type, id, supabase, resolvedOrgId)

  return {
    id,
    type,
    title,
    category,
    status,
    statusTone: status ? statusToneFor(rawStatus) : undefined,
    headline,
    rows,
    description: description || undefined,
    projectId,
    projectName,
    thumbnailUrl,
    href,
  }
}
