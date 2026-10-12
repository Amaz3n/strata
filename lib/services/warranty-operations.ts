import { warrantyActorAnalyticsEnabled, readActorWarrantyAnalytics } from "@/lib/services/warranty-actor-analytics"
import { warrantyTechQueueSchema, decodeWarrantyTechCursor, encodeWarrantyTechCursor } from "@/lib/warranty/tech-queue"
import { warrantyDeskPage, warrantyDeskSearchPattern, quoteWarrantySearchPattern } from "@/lib/warranty/desk-query"
import { warrantyCompletionTransactionsEnabled, commitOfficeWarrantyCompletion } from "@/lib/services/warranty-completion-transactions"
import { courtesyReservationsEnabled, generateReservedCourtesyInspections, authorizeCourtesyHome } from "@/lib/services/warranty-courtesy-reservations"
import { enrollSystemWarrantyCoverage, readWarrantyEnrollmentTerms, warrantyEffectiveDateSchema } from "@/lib/services/warranty-enrollment"
import type { SupabaseClient } from "@supabase/supabase-js"
import { readAllRows } from "@/lib/land/paging"
import { createServiceSupabaseClient as createBaseServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext as requireBaseOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { requireAuthorization, authorizeMany, getProjectReadScopeForUser } from "@/lib/services/authorization"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { insertWithProjectNumberRetry } from "@/lib/services/project-sequence"
import { NotificationService } from "@/lib/services/notifications"
import { loadWarrantyHomeTimeZone, loadWarrantyHomeTimeZones, loadWarrantyOrgTimeZone } from "@/lib/services/warranty-time-zone"
import { notifyWarrantyBuyerResponse, sendWarrantyVisitNotices } from "@/lib/services/warranty-visit-notices"
import { resolveWarrantyTimeZone, warrantyLocalDate } from "@/lib/services/warranty/visit-time"
import type { NotificationType } from "@/lib/types/notifications"
import { ensurePortalLink, fetchCompanyContacts, fetchContactEmail } from "@/lib/services/portal-links"
import { escapeHtml, getOrgSenderEmail, renderStandardEmailLayout, sendEmail } from "@/lib/services/mailer"
import { createProjectVendorBill, createProjectVendorCredit } from "@/lib/services/vendor-bills"
import {
  warrantyBackchargeInputSchema,
  warrantyProgramInputSchema,
  warrantyRecordRevisionSchema,
  warrantyRequestInputSchema,
  warrantyRequestUpdateSchema,
  warrantySlaTargetsSchema,
  warrantyVisitConflictInputSchema,
  warrantyVisitRescheduleSchema,
  warrantyVisitScheduleSchema,
  type WarrantyBackchargeInput,
  type WarrantyProgramInput,
  type WarrantyRequestInput,
  type WarrantyRequestUpdate,
  type WarrantyVisitScheduleInput,
} from "@/lib/validation/warranty"
import { normalizeProductTier, type ProductTier } from "@/lib/product-tier"
import type { WarrantyRequest } from "@/lib/types"
import {
  assertBackchargeTransition,
  buildCoverageSnapshot,
  classifyCoverage,
  completionAwaitsVerification,
  computeVisitInternalCost,
  dueCourtesyInspections,
  findOverlappingVisits,
  mergeMetadata,
  routingRecordFrom,
  selectWarrantyRoutingRule,
  warrantySlaBreachStamps,
  rankOriginatingCommitments,
  shouldFlagWarrantyCostDump,
  stampWarrantySla,
  validateWarrantyCostBasis,
  type BackchargeStatus,
  type CourtesyMilestoneKey,
  type OriginatingCommitmentCandidate,
  type RankedOriginatingCommitment,
  type WarrantyCostBasisItem,
  type WarrantyCoverageSnapshotTerm,
  type WarrantyCoverageTerm,
  type WarrantyRoutingRule,
  type WarrantySeverity,
  type WarrantyVisitWindow,
} from "@/lib/services/warranty/domain"
import {
  warrantyAcknowledgeSchema,
  warrantyBuyerRescheduleRequestSchema,
  warrantyRejectionReasonSchema,
  warrantyRoutingOverrideReasonSchema,
  warrantyRoutingRuleSchema,
  warrantyScheduleOverrideSchema,
  warrantyVisitCompleteWithCostSchema,
  warrantyVisitPortalOutcomeSchema,
  type WarrantyRoutingRuleInput,
  type WarrantyVisitCompleteWithCostInput,
} from "@/lib/services/warranty/validation"

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://arcnaples.com"

// This service uses dynamic PostgREST select fragments for shared DTO mappers.
// Keep those queries behind the SDK's untyped boundary; Zod and DTO mappers own
// the runtime validation while generated database types cover static queries.
function createServiceSupabaseClient(): SupabaseClient {
  return createBaseServiceSupabaseClient() as unknown as SupabaseClient
}

async function requireOrgContext(orgId?: string) {
  const context = await requireBaseOrgContext(orgId)
  return { ...context, supabase: context.supabase as unknown as SupabaseClient }
}

async function authorizeWarrantyHome(
  context: { supabase: SupabaseClient; orgId: string; userId: string },
  projectId: string,
  permission: "warranty.read" | "warranty.write" | "warranty.backcharge" | "bill.write",
) {
  await requireAuthorization({ ...context, projectId, permission, resourceType: "project", resourceId: projectId, logDecision: true })
}

async function assertWarrantyRequestHome(supabase: SupabaseClient, orgId: string, requestId: string, projectId: string) {
  const { data, error } = await supabase.from("warranty_requests").select("id,project_id").eq("org_id", orgId).eq("id", requestId).maybeSingle()
  if (error) throw new Error(`Unable to verify warranty request home: ${error.message}`)
  if (!data || data.project_id !== projectId) throw new Error("Warranty request belongs to another home or is unavailable")
}

async function assertWarrantyFiles(supabase: SupabaseClient, orgId: string, projectId: string, fileIds: string[]) {
  const ids = [...new Set(fileIds)]
  if (!ids.length) return
  const { data, error } = await supabase.from("files").select("id").eq("org_id", orgId).eq("project_id", projectId).is("archived_at", null).in("id", ids).limit(ids.length + 1)
  if (error) throw new Error(`Unable to verify warranty evidence files: ${error.message}`)
  if (!data || data.length !== ids.length || ids.some((id) => !data.some((row) => row.id === id))) throw new Error("Warranty evidence files must be available and belong to this home")
}

async function warrantyDeskReadScope(orgId: string, userId: string, divisionId?: string) {
  const scope = await getProjectReadScopeForUser({ orgId, userId })
  return { ...scope, divisionIds: divisionId ? (scope.divisionIds === null || scope.divisionIds.includes(divisionId) ? [divisionId] : []) : scope.divisionIds }
}

function warrantyDeskProjectSelect(fields: string, membershipRequired: boolean, communityId?: string) {
  const lot = communityId ? ",lot:lots!lots_project_id_fkey!inner(id,community_id,community:communities!inner(id))" : ""
  return `project:projects!inner(${fields}${lot}${membershipRequired ? ",access:project_members!project_members_project_id_fkey!inner(id)" : ""})`
}

/** Read home history in bounded keyset pages; never report a truncated history. */
async function readWarrantyHistory(
  readPage: (cursor: string | null) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  label: string,
  onRow?: (row: Record<string, unknown>) => void,
  maxRows = 10_000,
) {
  const rows: Record<string, unknown>[] = []
  let cursor: string | null = null, readCount = 0
  for (;;) {
    const { data, error } = await readPage(cursor)
    if (error || !Array.isArray(data)) throw new Error(`${label}: ${error?.message ?? "History page unavailable"}`)
    if (data.length > 100) throw new Error(`${label}: Invalid history page`)
    if (!data.length) return rows
    for (const row of data) {
      if (!row || typeof row.id !== "string" || (cursor && row.id <= cursor)) throw new Error(`${label}: History cursor did not advance`)
      cursor = row.id
      if (++readCount > maxRows) throw new Error(`${label}: History exceeds supported read size and cannot be returned completely`)
      if (onRow) onRow(row); else rows.push(row)
    }
    // A smaller configured response ceiling can clip a requested page. Only an
    // empty page proves exhaustion; continue from the last returned identity.
  }
}

const WARRANTY_SELECT = `
  id,org_id,project_id,request_number,title,description,status,priority,requested_by,
  assigned_company_id,assigned_user_id,scheduled_date,resolution_note,dispatched_at,
  severity,category,cost_code_id,coverage_term_key,coverage_status,coverage_override_reason,
  first_response_due_at,resolution_due_at,first_responded_at,source,cost_dump_flag,
  structural_claim,structural_claim_number,structural_claim_submitted_at,metadata,
  created_at,updated_at,closed_at,
  requested_by_contact:contacts(full_name),assigned_company:companies(name),
  assigned_user:app_users!warranty_requests_assigned_user_id_fkey(full_name)
`.replace(/\s+/g, " ").trim()

const VISIT_SELECT = `
  id,org_id,request_id,project_id,visit_number,assignee_kind,assigned_user_id,
  assigned_company_id,window_start,window_end,status,outcome,outcome_note,confirmed_at,
  completed_at,completed_by,buyer_signoff_name,buyer_signoff_at,buyer_signature_file_id,buyer_confirmed_at,buyer_reschedule_requested_at,buyer_reschedule_note,
  labor_hours,labor_rate_cents,internal_labor_cents,internal_material_cents,
  metadata,created_at,updated_at,assigned_user:app_users!warranty_service_visits_assigned_user_id_fkey(full_name),
  assigned_company:companies(name),photos:warranty_visit_photos(id,file_id,caption,created_at)
`.replace(/\s+/g, " ").trim()

function relationOne(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return (value[0] as unknown as Record<string, unknown> | undefined) ?? null
  return value && typeof value === "object" ? value as unknown as Record<string, unknown> : null
}

function mapWarranty(row: Record<string, unknown>): WarrantyRequest {
  const contact = relationOne(row.requested_by_contact)
  const company = relationOne(row.assigned_company)
  const user = relationOne(row.assigned_user)
  return {
    id: String(row.id), org_id: String(row.org_id), project_id: String(row.project_id),
    request_number: Number(row.request_number ?? 0), title: String(row.title),
    description: typeof row.description === "string" ? row.description : null,
    status: typeof row.status === "string" ? row.status : "open",
    priority: typeof row.priority === "string" ? row.priority : "normal",
    requested_by: typeof row.requested_by === "string" ? row.requested_by : null,
    requested_by_name: typeof contact?.full_name === "string" ? contact.full_name : null,
    assigned_company_id: typeof row.assigned_company_id === "string" ? row.assigned_company_id : null,
    assigned_company_name: typeof company?.name === "string" ? company.name : null,
    assigned_user_id: typeof row.assigned_user_id === "string" ? row.assigned_user_id : null,
    assigned_user_name: typeof user?.full_name === "string" ? user.full_name : null,
    scheduled_date: typeof row.scheduled_date === "string" ? row.scheduled_date : null,
    resolution_note: typeof row.resolution_note === "string" ? row.resolution_note : null,
    dispatched_at: typeof row.dispatched_at === "string" ? row.dispatched_at : null,
    severity: (row.severity as WarrantyRequest["severity"]) ?? "routine_30",
    category: typeof row.category === "string" ? row.category : null,
    cost_code_id: typeof row.cost_code_id === "string" ? row.cost_code_id : null,
    coverage_term_key: typeof row.coverage_term_key === "string" ? row.coverage_term_key : null,
    coverage_status: (row.coverage_status as WarrantyRequest["coverage_status"]) ?? "unclassified",
    coverage_override_reason: typeof row.coverage_override_reason === "string" ? row.coverage_override_reason : null,
    first_response_due_at: typeof row.first_response_due_at === "string" ? row.first_response_due_at : null,
    resolution_due_at: typeof row.resolution_due_at === "string" ? row.resolution_due_at : null,
    first_responded_at: typeof row.first_responded_at === "string" ? row.first_responded_at : null,
    source: (row.source as WarrantyRequest["source"]) ?? "office",
    cost_dump_flag: row.cost_dump_flag === true,
    structural_claim: row.structural_claim === true,
    structural_claim_number: typeof row.structural_claim_number === "string" ? row.structural_claim_number : null,
    structural_claim_submitted_at: typeof row.structural_claim_submitted_at === "string" ? row.structural_claim_submitted_at : null,
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata as unknown as Record<string, unknown> : {},
    created_at: String(row.created_at), updated_at: typeof row.updated_at === "string" ? row.updated_at : null,
    closed_at: typeof row.closed_at === "string" ? row.closed_at : null,
  }
}

export interface WarrantyProgramDTO {
  id: string
  name: string
  description: string | null
  is_default: boolean
  is_active: boolean
  terms: WarrantyCoverageTerm[]
}

/** A program plus the blast radius of editing it: how many homes already enrolled. */
export interface WarrantyProgramWithUsageDTO extends WarrantyProgramDTO {
  enrolled_count: number
}

export interface WarrantySlaTargetDTO {
  severity: WarrantySeverity
  first_response_hours: number
  resolution_days: number
}

export interface ProjectWarrantyCoverageDTO {
  project_id: string
  program_id: string
  effective_date: string
  effective_source: "closing" | "completion" | "manual"
  terms: Array<WarrantyCoverageSnapshotTerm & { expired: boolean }>
  structural_carrier: string | null
  structural_policy_number: string | null
}

export interface WarrantyPhotoDTO { id: string; file_id: string; caption: string | null; created_at: string }
export interface WarrantyServiceVisitDTO {
  id: string; request_id: string; project_id: string; visit_number: number
  assignee_kind: "tech" | "trade"; assigned_user_id: string | null; assigned_user_name: string | null
  assigned_company_id: string | null; assigned_company_name: string | null
  window_start: string; window_end: string; status: string; outcome: string | null; outcome_note: string | null
  confirmed_at: string | null; completed_at: string | null; buyer_signoff_name: string | null
  buyer_signoff_at: string | null; photos: WarrantyPhotoDTO[]; metadata: Record<string, unknown>
  buyer_confirmed_at: string | null; buyer_reschedule_requested_at: string | null; buyer_reschedule_note: string | null
  /** The IANA zone the window is read in at the house; set by the readers that render it. */
  time_zone?: string
  labor_hours: number | null; labor_rate_cents: number | null
  internal_labor_cents: number; internal_material_cents: number
}

export interface WarrantyBackchargeDTO {
  id: string; project_id: string; warranty_request_id: string; company_id: string
  commitment_id: string | null; cost_code_id: string | null; backcharge_number: number
  status: BackchargeStatus; amount_cents: number; recovered_cents: number; reason: string
  cost_basis: WarrantyCostBasisItem[]; vendor_credit_bill_id: string | null
  issued_at: string | null; disputed_at: string | null; dispute_note: string | null
  resolved_at: string | null; notes: string | null; company_name?: string | null; project_name?: string | null
}

function mapVisit(row: Record<string, unknown>): WarrantyServiceVisitDTO {
  const user = relationOne(row.assigned_user)
  const company = relationOne(row.assigned_company)
  const photos = Array.isArray(row.photos) ? row.photos as Array<Record<string, unknown>> : []
  return {
    id: String(row.id), request_id: String(row.request_id), project_id: String(row.project_id),
    visit_number: Number(row.visit_number), assignee_kind: row.assignee_kind as "tech" | "trade",
    assigned_user_id: typeof row.assigned_user_id === "string" ? row.assigned_user_id : null,
    assigned_user_name: typeof user?.full_name === "string" ? user.full_name : null,
    assigned_company_id: typeof row.assigned_company_id === "string" ? row.assigned_company_id : null,
    assigned_company_name: typeof company?.name === "string" ? company.name : null,
    window_start: String(row.window_start), window_end: String(row.window_end), status: String(row.status),
    outcome: typeof row.outcome === "string" ? row.outcome : null,
    outcome_note: typeof row.outcome_note === "string" ? row.outcome_note : null,
    confirmed_at: typeof row.confirmed_at === "string" ? row.confirmed_at : null,
    completed_at: typeof row.completed_at === "string" ? row.completed_at : null,
    buyer_signoff_name: typeof row.buyer_signoff_name === "string" ? row.buyer_signoff_name : null,
    buyer_signoff_at: typeof row.buyer_signoff_at === "string" ? row.buyer_signoff_at : null,
    buyer_confirmed_at: typeof row.buyer_confirmed_at === "string" ? row.buyer_confirmed_at : null,
    buyer_reschedule_requested_at: typeof row.buyer_reschedule_requested_at === "string" ? row.buyer_reschedule_requested_at : null,
    buyer_reschedule_note: typeof row.buyer_reschedule_note === "string" ? row.buyer_reschedule_note : null,
    photos: photos.map((photo) => ({ id: String(photo.id), file_id: String(photo.file_id), caption: typeof photo.caption === "string" ? photo.caption : null, created_at: String(photo.created_at) })),
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata as unknown as Record<string, unknown> : {},
    labor_hours: row.labor_hours === null || row.labor_hours === undefined ? null : Number(row.labor_hours),
    labor_rate_cents: row.labor_rate_cents === null || row.labor_rate_cents === undefined ? null : Number(row.labor_rate_cents),
    internal_labor_cents: Number(row.internal_labor_cents ?? 0),
    internal_material_cents: Number(row.internal_material_cents ?? 0),
  }
}

function mapBackcharge(row: Record<string, unknown>): WarrantyBackchargeDTO {
  const company = relationOne(row.company)
  const project = relationOne(row.project)
  return {
    id: String(row.id), project_id: String(row.project_id), warranty_request_id: String(row.warranty_request_id),
    company_id: String(row.company_id), commitment_id: typeof row.commitment_id === "string" ? row.commitment_id : null,
    cost_code_id: typeof row.cost_code_id === "string" ? row.cost_code_id : null,
    backcharge_number: Number(row.backcharge_number), status: row.status as BackchargeStatus,
    amount_cents: Number(row.amount_cents), recovered_cents: Number(row.recovered_cents ?? 0), reason: String(row.reason),
    cost_basis: Array.isArray(row.cost_basis) ? row.cost_basis as WarrantyCostBasisItem[] : [],
    vendor_credit_bill_id: typeof row.vendor_credit_bill_id === "string" ? row.vendor_credit_bill_id : null,
    issued_at: typeof row.issued_at === "string" ? row.issued_at : null,
    disputed_at: typeof row.disputed_at === "string" ? row.disputed_at : null,
    dispute_note: typeof row.dispute_note === "string" ? row.dispute_note : null,
    resolved_at: typeof row.resolved_at === "string" ? row.resolved_at : null,
    notes: typeof row.notes === "string" ? row.notes : null,
    company_name: typeof company?.name === "string" ? company.name : null,
    project_name: typeof project?.name === "string" ? project.name : null,
  }
}

/**
 * Seeded coverage differs by what the builder actually sells. A production builder
 * sells 1-2-10 with a structural carrier; a custom builder sells a workmanship year;
 * a commercial GC owes the one-year correction-of-work period under the prime
 * contract. Seeding 1-2-10 everywhere put a production artifact in every org.
 */
const DEFAULT_TERMS_BY_TIER: Record<ProductTier, WarrantyCoverageTerm[]> = {
  production: [
    { key: "workmanship", label: "Workmanship & materials", duration_months: 12, is_structural: false, description: "Builder workmanship and installed materials." },
    { key: "systems", label: "Major systems", duration_months: 24, is_structural: false, description: "Plumbing, electrical, and mechanical distribution systems." },
    { key: "structural", label: "Structural", duration_months: 120, is_structural: true, description: "Covered structural defects, subject to the enrolled structural warranty." },
  ],
  residential: [
    { key: "workmanship", label: "Workmanship & materials", duration_months: 12, is_structural: false, description: "Our workmanship and the materials we installed, for one year from substantial completion." },
  ],
  commercial: [
    { key: "correction_of_work", label: "Correction of work", duration_months: 12, is_structural: false, description: "Correction of defective work for one year from substantial completion, per the prime contract." },
  ],
}

const DEFAULT_PROGRAM_BY_TIER: Record<ProductTier, { name: string; description: string }> = {
  production: { name: "Standard 1-2-10", description: "Standard production-home coverage" },
  residential: { name: "Standard warranty", description: "Standard coverage offered to clients" },
  commercial: { name: "Correction period", description: "Standard correction-of-work period" },
}

const DEFAULT_SLAS = [
  { severity: "emergency", first_response_hours: 24, resolution_days: 3 },
  { severity: "routine_30", first_response_hours: 72, resolution_days: 30 },
  { severity: "routine_60", first_response_hours: 120, resolution_days: 60 },
] as const

async function resolveOrgProductTier(supabase: SupabaseClient, orgId: string): Promise<ProductTier> {
  const { data } = await supabase.from("orgs").select("product_tier").eq("id", orgId).maybeSingle()
  return normalizeProductTier(data?.product_tier)
}

/**
 * Seeds the org's first warranty program on first use. Seeding is a system
 * write — the caller has already been authorized for whatever brought them
 * here (logging a request, opening the desk) — and program writes need
 * `warranty.manage` under RLS, so it runs on the service client.
 */
async function ensureWarrantyDefaults(orgId: string) {
  const supabase = createServiceSupabaseClient()
  const { data: existing, error } = await supabase.from("warranty_programs").select("id").eq("org_id", orgId).limit(1)
  if (error) throw new Error(`Failed to load warranty programs: ${error.message}`)
  if ((existing ?? []).length === 0) {
    // Only the first seed per org needs the tier, so it's resolved here rather than
    // threaded through every caller (several run on the service client with no context).
    const tier = await resolveOrgProductTier(supabase, orgId)
    const defaults = DEFAULT_PROGRAM_BY_TIER[tier]
    const { data: program, error: programError } = await supabase.from("warranty_programs").insert({
      org_id: orgId, name: defaults.name, description: defaults.description, is_default: true,
    }).select("id").single()
    // Two first visits can seed at once; the one-default index lets only one win,
    // and the winner seeds the terms.
    const seededConcurrently = programError?.code === "23505"
    if (!seededConcurrently) {
      if (programError || !program) throw new Error(`Failed to seed warranty program: ${programError?.message}`)
      const { error: termsError } = await supabase.from("warranty_coverage_terms").insert(DEFAULT_TERMS_BY_TIER[tier].map((term, index) => ({
        org_id: orgId, program_id: program.id, ...term, sort_order: index,
      })))
      if (termsError) throw new Error(`Failed to seed warranty terms: ${termsError.message}`)
    }
  }
  const { error: slaError } = await supabase.from("warranty_sla_targets").upsert(
    DEFAULT_SLAS.map((target) => ({ org_id: orgId, ...target })), { onConflict: "org_id,severity", ignoreDuplicates: true },
  )
  if (slaError) throw new Error(`Failed to seed warranty SLA targets: ${slaError.message}`)
}

async function loadPrograms(supabase: SupabaseClient, orgId: string): Promise<WarrantyProgramDTO[]> {
  const { data, error } = await supabase.from("warranty_programs").select("id,name,description,is_default,is_active,terms:warranty_coverage_terms(key,label,duration_months,is_structural,description,sort_order)").eq("org_id", orgId).order("name")
  if (error) throw new Error(`Failed to load warranty programs: ${error.message}`)
  return (data ?? []).map((row) => ({
    id: row.id, name: row.name, description: row.description ?? null, is_default: row.is_default, is_active: row.is_active,
    terms: (row.terms ?? []).sort((a, b) => a.sort_order - b.sort_order).map((term) => ({ key: term.key, label: term.label, duration_months: term.duration_months, is_structural: term.is_structural, description: term.description ?? null })),
  }))
}

export async function listWarrantyPrograms(orgId?: string): Promise<WarrantyProgramWithUsageDTO[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.manage", { supabase, orgId: resolvedOrgId, userId })
  await ensureWarrantyDefaults(resolvedOrgId)
  const programs = await loadPrograms(supabase, resolvedOrgId)
  // Counted per program rather than by loading coverage rows — an org can have
  // thousands of enrolled homes, and only the tally is shown.
  const counts = await Promise.all(
    programs.map(async (program) => {
      const { count, error } = await supabase
        .from("project_warranty_coverage")
        .select("id", { count: "exact", head: true })
        .eq("org_id", resolvedOrgId)
        .eq("program_id", program.id)
        .is("voided_at", null)
      if (error) throw new Error(`Failed to load warranty program usage: ${error.message}`)
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
        throw new Error("Warranty program usage is unavailable. Reload before reviewing coverage.")
      }
      return count
    }),
  )
  return programs.map((program, index) => ({ ...program, enrolled_count: counts[index] }))
}

export async function upsertWarrantyProgram(input: WarrantyProgramInput, orgId?: string) {
  const parsed = warrantyProgramInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.manage", { supabase, orgId: resolvedOrgId, userId })
  if (parsed.is_default) await supabase.from("warranty_programs").update({ is_default: false }).eq("org_id", resolvedOrgId).eq("is_default", true)
  const payload = { org_id: resolvedOrgId, name: parsed.name, description: parsed.description ?? null, is_default: parsed.is_default, is_active: parsed.is_active }
  const { data: program, error } = parsed.id
    ? await supabase.from("warranty_programs").update(payload).eq("org_id", resolvedOrgId).eq("id", parsed.id).select("id").single()
    : await supabase.from("warranty_programs").insert(payload).select("id").single()
  if (error || !program) throw new Error(`Failed to save warranty program: ${error?.message}`)
  const { error: clearError } = await supabase.from("warranty_coverage_terms").delete().eq("org_id", resolvedOrgId).eq("program_id", program.id)
  if (clearError) throw new Error(`Failed to replace warranty terms: ${clearError.message}`)
  const { error: termsError } = await supabase.from("warranty_coverage_terms").insert(parsed.terms.map((term, index) => ({ org_id: resolvedOrgId, program_id: program.id, ...term, description: term.description ?? null, sort_order: index })))
  if (termsError) throw new Error(`Failed to save warranty terms: ${termsError.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: parsed.id ? "update" : "insert", entityType: "warranty_program", entityId: program.id, after: payload })
  return (await loadPrograms(supabase, resolvedOrgId)).find((candidate) => candidate.id === program.id)!
}

export async function listWarrantySlaTargets(orgId?: string): Promise<WarrantySlaTargetDTO[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.manage", { supabase, orgId: resolvedOrgId, userId })
  await ensureWarrantyDefaults(resolvedOrgId)
  const { data, error } = await supabase.from("warranty_sla_targets").select("severity,first_response_hours,resolution_days").eq("org_id", resolvedOrgId).order("severity")
  if (error) throw new Error(`Failed to load SLA targets: ${error.message}`)
  return (data ?? []).map((row) => ({
    severity: row.severity as WarrantySeverity,
    first_response_hours: row.first_response_hours,
    resolution_days: row.resolution_days,
  }))
}

export async function upsertWarrantySlaTargets(input: unknown, orgId?: string) {
  const parsed = warrantySlaTargetsSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.manage", { supabase, orgId: resolvedOrgId, userId })
  const { error } = await supabase.from("warranty_sla_targets").upsert(parsed.targets.map((target) => ({ org_id: resolvedOrgId, ...target })), { onConflict: "org_id,severity" })
  if (error) throw new Error(`Failed to save SLA targets: ${error.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "warranty_sla_targets", entityId: resolvedOrgId, after: { targets: parsed.targets } })
  return parsed.targets
}

async function loadCoverage(supabase: SupabaseClient, orgId: string, projectId: string): Promise<ProjectWarrantyCoverageDTO | null> {
  const { data, error } = await supabase.from("project_warranty_coverage").select("project_id,program_id,effective_date,effective_source,terms_snapshot,structural_carrier,structural_policy_number").eq("org_id", orgId).eq("project_id", projectId).is("voided_at", null).maybeSingle()
  if (error) throw new Error(`Failed to load warranty coverage: ${error.message}`)
  if (!data) return null
  const today = new Date().toISOString().slice(0, 10)
  const terms = Array.isArray(data.terms_snapshot) ? data.terms_snapshot as WarrantyCoverageSnapshotTerm[] : []
  return { project_id: data.project_id, program_id: data.program_id, effective_date: data.effective_date, effective_source: data.effective_source, terms: terms.map((term) => ({ ...term, expired: term.expires_on < today })), structural_carrier: data.structural_carrier ?? null, structural_policy_number: data.structural_policy_number ?? null }
}

export async function getProjectWarrantyCoverage(projectId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.read", { supabase, orgId: resolvedOrgId, userId })
  await authorizeWarrantyHome({ supabase, orgId: resolvedOrgId, userId }, projectId, "warranty.read")
  return loadCoverage(supabase, resolvedOrgId, projectId)
}

export async function getProjectWarrantyCoverageForPortal(orgId: string, projectId: string) {
  return loadCoverage(createServiceSupabaseClient(), orgId, projectId)
}

export async function enrollProjectWarrantyCoverage(input: { projectId: string; programId?: string; effectiveDate?: string }, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.manage", { supabase, orgId: resolvedOrgId, userId })
  await requireAuthorization({ permission: "warranty.manage", orgId: resolvedOrgId, userId, projectId: input.projectId, supabase, resourceType: "project", resourceId: input.projectId, logDecision: true })
  const [existingResult, closingResult] = await Promise.all([
    supabase.from("project_warranty_coverage").select("id").eq("org_id", resolvedOrgId).eq("project_id", input.projectId).is("voided_at", null).maybeSingle(),
    supabase.from("closings").select("actual_date,status").eq("org_id", resolvedOrgId).eq("project_id", input.projectId).maybeSingle(),
  ])
  if (existingResult.error) throw new Error(`Unable to read existing warranty coverage: ${existingResult.error.message}`)
  if (closingResult.error) throw new Error(`Unable to read warranty closing evidence: ${closingResult.error.message}`)
  const existing = existingResult.data, closing = closingResult.data
  if (existing) throw new Error("This home already has warranty coverage")
  const effectiveDateValue = input.effectiveDate ?? (closing?.status === "closed" ? closing.actual_date : null)
  if (!effectiveDateValue) throw new Error("An effective date is required until the home is closed")
  const effectiveDate = warrantyEffectiveDateSchema.parse(effectiveDateValue)
  await ensureWarrantyDefaults(resolvedOrgId)
  let query = supabase.from("warranty_programs").select("id").eq("org_id", resolvedOrgId).eq("is_active", true)
  query = input.programId ? query.eq("id", input.programId) : query.eq("is_default", true)
  const programResult = await query.order("id").limit(2)
  if (programResult.error) throw new Error(`Unable to read warranty program: ${programResult.error.message}`)
  if (programResult.data?.length !== 1) throw new Error("Exactly one active warranty program is required")
  const program = programResult.data[0]
  const terms = await readWarrantyEnrollmentTerms(supabase, resolvedOrgId, program.id)
  const { data, error } = await supabase.from("project_warranty_coverage").insert({
    org_id: resolvedOrgId, project_id: input.projectId, program_id: program.id, effective_date: effectiveDate,
    effective_source: input.effectiveDate ? "manual" : "closing", terms_snapshot: buildCoverageSnapshot(effectiveDate, terms),
  }).select("id").single()
  if (error || !data) throw new Error(`Failed to enroll warranty coverage: ${error?.message}`)
  await recordEvent({ orgId: resolvedOrgId, eventType: "warranty_coverage_enrolled", entityType: "warranty_coverage", entityId: data.id, payload: { project_id: input.projectId, effective_date: effectiveDate } })
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "warranty_coverage", entityId: data.id, after: { project_id: input.projectId, program_id: program.id, effective_date: effectiveDate } })
  return (await loadCoverage(supabase, resolvedOrgId, input.projectId))!
}

/**
 * System-triggered enrollment. Production homes enroll at closing; residential and
 * commercial projects enroll at substantial completion, since they never close.
 * Both run from the outbox, so a missing program fails the job rather than the
 * user's request.
 */
export async function enrollProjectWarrantyCoverageFromSystem(input: { orgId: string; projectId: string; effectiveDate: string; source: "closing" | "completion" }) {
  const supabase = createServiceSupabaseClient()
  return enrollSystemWarrantyCoverage(supabase, input, () => ensureWarrantyDefaults(input.orgId))
}

async function prepareRequestData(supabase: SupabaseClient, orgId: string, projectId: string, input: WarrantyRequestInput, source: "office" | "buyer_portal" | "mobile") {
  await ensureWarrantyDefaults(orgId)
  const createdAt = new Date()
  const severity = input.severity ?? "routine_30"
  const [{ data: target, error: targetError }, coverage, { count: openPunchCount, error: punchError }] = await Promise.all([
    supabase.from("warranty_sla_targets").select("first_response_hours,resolution_days").eq("org_id", orgId).eq("severity", severity).maybeSingle(),
    loadCoverage(supabase, orgId, projectId),
    supabase.from("punch_items").select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("project_id", projectId).not("status", "in", '("closed","resolved")'),
  ])
  if (targetError) throw new Error(`Failed to load warranty SLA policy: ${targetError.message}`)
  if (punchError) throw new Error(`Failed to load warranty punch evidence: ${punchError.message}`)
  if (typeof openPunchCount !== "number" || !Number.isSafeInteger(openPunchCount) || openPunchCount < 0) {
    throw new Error("Warranty punch evidence is unavailable. Reload before creating a request.")
  }
  const sla = stampWarrantySla(createdAt, target ?? DEFAULT_SLAS.find((item) => item.severity === severity)!)
  const costDump = shouldFlagWarrantyCostDump({ createdAt, effectiveDate: coverage?.effective_date ?? null, openPunchCount })
  return {
    org_id: orgId, project_id: projectId, title: input.title, description: input.description ?? null,
    status: input.status ?? "open", priority: input.priority ?? "normal", severity, category: input.category ?? null,
    cost_code_id: input.cost_code_id ?? null, coverage_term_key: input.coverage_term_key ?? null,
    coverage_status: classifyCoverage(coverage, input.coverage_term_key ?? null, createdAt), source,
    cost_dump_flag: costDump, ...sla,
    metadata: costDump ? { cost_dump_reason: `Created within 60 days of coverage effective date with ${openPunchCount} open punch items` } : {},
  }
}

async function attachRequestPhotos(supabase: SupabaseClient, orgId: string, requestId: string, fileIds: string[], userId: string | null) {
  if (fileIds.length === 0) return
  const { error } = await supabase.from("warranty_request_photos").upsert([...new Set(fileIds)].map((fileId) => ({ org_id: orgId, request_id: requestId, file_id: fileId, created_by: userId })), { onConflict: "request_id,file_id" })
  if (error) throw new Error(`Failed to attach warranty photos: ${error.message}`)
}

const ROUTING_RULE_SELECT = "id,name,priority,severity,category,community_id,cost_code_id,assignee_kind,assigned_user_id,assigned_company_id,is_active"

function mapRoutingRule(row: Record<string, unknown>): WarrantyRoutingRule {
  return {
    id: String(row.id), name: String(row.name), priority: Number(row.priority ?? 100),
    severity: (row.severity as WarrantySeverity | null) ?? null,
    category: typeof row.category === "string" ? row.category : null,
    community_id: typeof row.community_id === "string" ? row.community_id : null,
    cost_code_id: typeof row.cost_code_id === "string" ? row.cost_code_id : null,
    assignee_kind: row.assignee_kind === "trade" ? "trade" : "tech",
    assigned_user_id: typeof row.assigned_user_id === "string" ? row.assigned_user_id : null,
    assigned_company_id: typeof row.assigned_company_id === "string" ? row.assigned_company_id : null,
    is_active: row.is_active !== false,
  }
}

export async function listWarrantyRoutingRules(orgId?: string): Promise<WarrantyRoutingRule[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.read", { supabase, orgId: resolvedOrgId, userId })
  const { data, error } = await supabase.from("warranty_routing_rules").select(ROUTING_RULE_SELECT).eq("org_id", resolvedOrgId).order("priority").order("id").limit(500)
  if (error) throw new Error(`Failed to load warranty routing rules: ${error.message}`)
  return (data ?? []).map((row) => mapRoutingRule(row as unknown as Record<string, unknown>))
}

export async function saveWarrantyRoutingRule(input: WarrantyRoutingRuleInput, orgId?: string) {
  const parsed = warrantyRoutingRuleSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.manage", { supabase, orgId: resolvedOrgId, userId })
  const values = {
    org_id: resolvedOrgId, name: parsed.name, priority: parsed.priority, severity: parsed.severity ?? null, category: parsed.category ?? null,
    community_id: parsed.community_id ?? null, cost_code_id: parsed.cost_code_id ?? null, assignee_kind: parsed.assignee_kind,
    assigned_user_id: parsed.assignee_kind === "tech" ? parsed.assigned_user_id ?? null : null,
    assigned_company_id: parsed.assignee_kind === "trade" ? parsed.assigned_company_id ?? null : null,
    is_active: parsed.is_active,
  }
  let before: Record<string, unknown> | null = null
  if (parsed.id) {
    const existing = await supabase.from("warranty_routing_rules").select(ROUTING_RULE_SELECT).eq("org_id", resolvedOrgId).eq("id", parsed.id).maybeSingle()
    if (existing.error || !existing.data) throw new Error("Warranty routing rule not found")
    before = existing.data as unknown as Record<string, unknown>
  }
  const write = parsed.id
    ? supabase.from("warranty_routing_rules").update(values).eq("org_id", resolvedOrgId).eq("id", parsed.id)
    : supabase.from("warranty_routing_rules").insert({ ...values, created_by: userId })
  const { data, error } = await write.select(ROUTING_RULE_SELECT).single()
  if (error || !data) throw new Error(`Failed to save warranty routing rule: ${error?.message}`)
  const rule = mapRoutingRule(data as unknown as Record<string, unknown>)
  await recordEvent({ orgId: resolvedOrgId, eventType: "warranty_routing_rule_saved", entityType: "warranty_routing_rule", entityId: rule.id, payload: { name: rule.name, is_active: rule.is_active } })
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: before ? "update" : "insert", entityType: "warranty_routing_rule", entityId: rule.id, before, after: data as unknown as Record<string, unknown> })
  return rule
}

export async function deleteWarrantyRoutingRule(ruleId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.manage", { supabase, orgId: resolvedOrgId, userId })
  const { data, error } = await supabase.from("warranty_routing_rules").delete().eq("org_id", resolvedOrgId).eq("id", ruleId).select(ROUTING_RULE_SELECT).maybeSingle()
  if (error) throw new Error(`Failed to delete warranty routing rule: ${error.message}`)
  if (!data) throw new Error("Warranty routing rule not found")
  await recordEvent({ orgId: resolvedOrgId, eventType: "warranty_routing_rule_deleted", entityType: "warranty_routing_rule", entityId: ruleId, payload: { name: data.name } })
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "delete", entityType: "warranty_routing_rule", entityId: ruleId, before: data as unknown as Record<string, unknown> })
}

/**
 * Gives a new request its owner. Runs after the request exists, so a routing
 * failure leaves an unrouted request for manual triage instead of losing the
 * homeowner's report, and the failure is on the record. The write only lands
 * while nobody has assigned the request, so a coordinator who got there first
 * is never overwritten.
 */
async function routeNewWarrantyRequest(supabase: SupabaseClient, orgId: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const requestId = String(request.id), projectId = String(request.project_id)
  try {
    const [rulesResult, lotResult] = await Promise.all([
      supabase.from("warranty_routing_rules").select(ROUTING_RULE_SELECT).eq("org_id", orgId).eq("is_active", true).limit(500),
      supabase.from("lots").select("community_id").eq("org_id", orgId).eq("project_id", projectId).maybeSingle(),
    ])
    if (rulesResult.error) throw new Error(rulesResult.error.message)
    if (lotResult.error) throw new Error(lotResult.error.message)
    const rule = selectWarrantyRoutingRule((rulesResult.data ?? []).map((row) => mapRoutingRule(row as unknown as Record<string, unknown>)), {
      severity: (request.severity as WarrantySeverity) ?? "routine_30",
      category: typeof request.category === "string" ? request.category : null,
      community_id: typeof lotResult.data?.community_id === "string" ? lotResult.data.community_id : null,
      cost_code_id: typeof request.cost_code_id === "string" ? request.cost_code_id : null,
    })
    if (!rule) return request
    const routedAt = new Date().toISOString()
    const { data, error } = await supabase.from("warranty_requests").update({
      ...(rule.assignee_kind === "tech" ? { assigned_user_id: rule.assigned_user_id } : { assigned_company_id: rule.assigned_company_id }),
      metadata: mergeMetadata(request.metadata, { routing: { source: "rule", rule_id: rule.id, rule_name: rule.name, routed_at: routedAt, routed_by: null } }),
    }).eq("org_id", orgId).eq("id", requestId).eq("project_id", projectId).is("assigned_user_id", null).is("assigned_company_id", null).select(WARRANTY_SELECT).maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) return request
    await recordEvent({ orgId, eventType: "warranty_request_routed", entityType: "warranty_request", entityId: requestId, payload: { project_id: projectId, rule_id: rule.id, assignee_kind: rule.assignee_kind, assigned_user_id: rule.assigned_user_id, assigned_company_id: rule.assigned_company_id } })
    await recordAudit({ orgId, action: "update", entityType: "warranty_request", entityId: requestId, before: request, after: data as unknown as Record<string, unknown>, source: "warranty_routing" })
    if (rule.assigned_user_id) {
      await new NotificationService().createAndQueue({
        orgId, userId: rule.assigned_user_id, type: "warranty_request_routed", title: "Warranty request routed to you",
        message: `${String(request.title)} was routed to you by "${rule.name}".`, projectId, entityType: "warranty_request", entityId: requestId, metadata: { href: "/warranty" },
      }).catch(() => undefined)
    }
    return data as unknown as Record<string, unknown>
  } catch (error) {
    await recordEvent({ orgId, eventType: "warranty_request_routing_failed", entityType: "warranty_request", entityId: requestId, payload: { project_id: projectId, error: error instanceof Error ? error.message : "Routing failed" } })
    return request
  }
}

async function createRequestWithClient(input: WarrantyRequestInput, context: { supabase: SupabaseClient; orgId: string; userId: string | null; contactId?: string | null; source: "office" | "buyer_portal" | "mobile" }) {
  const parsed = warrantyRequestInputSchema.parse(input)
  await assertWarrantyFiles(context.supabase, context.orgId, parsed.project_id, parsed.photo_file_ids ?? [])
  const payload = await prepareRequestData(context.supabase, context.orgId, parsed.project_id, parsed, context.source)
  const result = await insertWithProjectNumberRetry<Record<string, unknown>>({
    supabase: context.supabase, table: "warranty_requests", numberColumn: "request_number", rpcName: "next_warranty_request_number",
    conflictConstraint: "warranty_requests_project_number_idx", projectId: parsed.project_id,
    payload: { ...payload, requested_by: context.contactId ?? null }, select: WARRANTY_SELECT, entityLabel: "warranty request",
  })
  await attachRequestPhotos(context.supabase, context.orgId, String(result.data.id), parsed.photo_file_ids ?? [], context.userId)
  await recordEvent({ orgId: context.orgId, eventType: "warranty_request_created", entityType: "warranty_request", entityId: String(result.data.id), payload: { project_id: parsed.project_id, title: parsed.title, source: context.source } })
  await recordAudit({ orgId: context.orgId, actorId: context.userId ?? undefined, action: "insert", entityType: "warranty_request", entityId: String(result.data.id), after: result.data })
  return mapWarranty(await routeNewWarrantyRequest(context.supabase, context.orgId, result.data))
}

export async function listWarrantyRequests(projectId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.read", { supabase, orgId: resolvedOrgId, userId })
  await authorizeWarrantyHome({ supabase, orgId: resolvedOrgId, userId }, projectId, "warranty.read")
  const rows = await readWarrantyHistory((cursor) => {
    let query = supabase.from("warranty_requests").select(WARRANTY_SELECT).eq("org_id", resolvedOrgId).eq("project_id", projectId).order("id").limit(100)
    if (cursor) query = query.gt("id", cursor)
    return query
  }, "Failed to load warranty requests")
  return rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(a.id).localeCompare(String(b.id))).map(mapWarranty)
}

export async function createWarrantyRequest({ input, orgId }: { input: WarrantyRequestInput; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.write", { supabase, orgId: resolvedOrgId, userId })
  const parsed = warrantyRequestInputSchema.parse(input)
  await authorizeWarrantyHome({ supabase, orgId: resolvedOrgId, userId }, parsed.project_id, "warranty.write")
  // The table policy only admits project members and org admins, so a warranty
  // manager who is neither could never open a claim. Authorization above is the gate.
  return createRequestWithClient(parsed, { supabase: createServiceSupabaseClient(), orgId: resolvedOrgId, userId, source: "office" })
}

export async function createWarrantyRequestFromPortal({ orgId, projectId, contactId, input }: { orgId: string; projectId: string; contactId?: string | null; input: WarrantyRequestInput }) {
  return createRequestWithClient({ ...input, project_id: projectId }, { supabase: createServiceSupabaseClient(), orgId, userId: null, contactId, source: "buyer_portal" })
}

export async function listWarrantyRequestsForPortal(orgId: string, projectId: string) {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase.from("warranty_requests").select(WARRANTY_SELECT).eq("org_id", orgId).eq("project_id", projectId).order("created_at", { ascending: false })
  if (error) throw new Error(`Failed to load warranty requests: ${error.message}`)
  return (data ?? []).map((row) => mapWarranty(row as unknown as Record<string, unknown>))
}

export async function updateWarrantyRequest({ requestId, input, orgId }: { requestId: string; input: WarrantyRequestUpdate; orgId?: string }) {
  const parsed = warrantyRequestUpdateSchema.parse(input)
  const { supabase: callerClient, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.write", { supabase: callerClient, orgId: resolvedOrgId, userId })
  // Table policy admits only project members and org admins; authorizeWarrantyHome is the gate.
  const supabase = createServiceSupabaseClient()
  const { data: existing, error: existingError } = await supabase.from("warranty_requests").select(WARRANTY_SELECT).eq("org_id", resolvedOrgId).eq("id", requestId).maybeSingle()
  if (existingError || !existing) throw new Error("Warranty request not found")
  const current = mapWarranty(existing as unknown as Record<string, unknown>)
  await authorizeWarrantyHome({ supabase: callerClient, orgId: resolvedOrgId, userId }, current.project_id, "warranty.write")
  if (!current.updated_at) throw new Error("Warranty request revision is unavailable; refresh before making changes")
  const updates: Record<string, unknown> = {}
  for (const key of ["title","description","priority","category","cost_code_id","coverage_term_key","assigned_company_id","assigned_user_id","scheduled_date","resolution_note","structural_claim","structural_claim_number","structural_claim_submitted_at"] as const) {
    if (parsed[key] !== undefined) updates[key] = parsed[key]
  }
  if (parsed.severity && parsed.severity !== current.severity) {
    const { data: target } = await supabase.from("warranty_sla_targets").select("first_response_hours,resolution_days").eq("org_id", resolvedOrgId).eq("severity", parsed.severity).maybeSingle()
    Object.assign(updates, {
      severity: parsed.severity,
      ...stampWarrantySla(new Date(current.created_at), target ?? DEFAULT_SLAS.find((item) => item.severity === parsed.severity)!),
      // Re-grading moves the due dates; a breach already incurred stays on the record.
      metadata: mergeMetadata(current.metadata, warrantySlaBreachStamps(current, new Date())),
    })
  }
  if (parsed.coverage_status) {
    const coverage = await loadCoverage(supabase, resolvedOrgId, current.project_id)
    const computed = classifyCoverage(coverage, parsed.coverage_term_key ?? current.coverage_term_key ?? null, new Date())
    if (parsed.coverage_status !== computed && !parsed.coverage_override_reason?.trim()) throw new Error("Coverage override reason is required")
    updates.coverage_status = parsed.coverage_status
    updates.coverage_override_reason = parsed.coverage_status === computed ? null : parsed.coverage_override_reason
  }
  const now = new Date().toISOString()
  const reassigned = (parsed.assigned_user_id !== undefined && parsed.assigned_user_id !== current.assigned_user_id)
    || (parsed.assigned_company_id !== undefined && parsed.assigned_company_id !== current.assigned_company_id)
  const priorRouting = routingRecordFrom(current.metadata)
  // A rule chose this owner; taking the request elsewhere is a decision against
  // the rule and says why. Reassigning a manually-triaged request needs no reason.
  const overridesRule = reassigned && priorRouting?.source === "rule"
  const overrideReason = overridesRule ? warrantyRoutingOverrideReasonSchema.parse(parsed.routing_override_reason ?? "") : null
  if (reassigned) {
    updates.metadata = mergeMetadata(updates.metadata ?? current.metadata, {
      routing: { source: "manual", rule_id: null, rule_name: null, routed_at: now, routed_by: userId, overridden_rule_id: overridesRule ? priorRouting?.rule_id ?? null : null, override_reason: overrideReason },
    })
  }
  if (parsed.assigned_company_id && parsed.assigned_company_id !== current.assigned_company_id) {
    updates.dispatched_at = now
    if ((parsed.status ?? current.status) === "open") updates.status = "in_progress"
  }
  if (parsed.status) {
    updates.status = parsed.status
    updates.closed_at = ["resolved","closed"].includes(parsed.status) ? now : null
  }
  const { data, error } = await supabase.from("warranty_requests").update(updates).eq("org_id", resolvedOrgId).eq("id", requestId).eq("project_id", current.project_id).eq("updated_at", current.updated_at).select(WARRANTY_SELECT).single()
  if (error || !data) throw new Error(`Failed to update warranty request: ${error?.message}`)
  const updatedRow = data as unknown as Record<string, unknown>
  await recordEvent({ orgId: resolvedOrgId, eventType: "warranty_request_updated", entityType: "warranty_request", entityId: requestId, payload: { project_id: current.project_id, status: updatedRow.status } })
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "warranty_request", entityId: requestId, before: existing as unknown as Record<string, unknown>, after: updatedRow })
  const updated = mapWarranty(updatedRow)
  if (reassigned) {
    await recordEvent({ orgId: resolvedOrgId, eventType: overridesRule ? "warranty_request_routing_overridden" : "warranty_request_reassigned", entityType: "warranty_request", entityId: requestId, payload: { project_id: current.project_id, from_user_id: current.assigned_user_id, to_user_id: updated.assigned_user_id, from_company_id: current.assigned_company_id, to_company_id: updated.assigned_company_id, overridden_rule_id: overridesRule ? priorRouting?.rule_id ?? null : null, reason: overrideReason } })
    if (updated.assigned_user_id && updated.assigned_user_id !== current.assigned_user_id && updated.assigned_user_id !== userId) {
      await new NotificationService().createAndQueue({
        orgId: resolvedOrgId, userId: updated.assigned_user_id, type: "warranty_request_routed", title: "Warranty request assigned to you",
        message: `${updated.title} was assigned to you.`, projectId: current.project_id, entityType: "warranty_request", entityId: requestId, metadata: { href: "/warranty" },
      }).catch(() => undefined)
    }
  }
  if (["resolved","closed"].includes(updated.status) && !["resolved","closed"].includes(current.status)) await sendWarrantyResolvedEmail(resolvedOrgId, updated)
  return updated
}

/**
 * The first-response SLA measures the moment somebody actually called the
 * homeowner back — not the moment a truck was dispatched. Those are different
 * promises and only one of them is what the homeowner is waiting on.
 */
export async function acknowledgeWarrantyRequest(input: unknown, orgId?: string) {
  const parsed = warrantyAcknowledgeSchema.parse(input)
  const { supabase: callerClient, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.write", { supabase: callerClient, orgId: resolvedOrgId, userId })
  // Table policy admits only project members and org admins; authorizeWarrantyHome is the gate.
  const supabase = createServiceSupabaseClient()
  const { data: existing, error: existingError } = await supabase.from("warranty_requests").select(WARRANTY_SELECT).eq("org_id", resolvedOrgId).eq("id", parsed.request_id).maybeSingle()
  if (existingError || !existing) throw new Error("Warranty request not found")
  const current = mapWarranty(existing as unknown as Record<string, unknown>)
  await authorizeWarrantyHome({ supabase: callerClient, orgId: resolvedOrgId, userId }, current.project_id, "warranty.write")
  if (current.first_responded_at) return current
  if (!current.updated_at) throw new Error("Warranty request revision is unavailable; refresh before making changes")
  const now = new Date().toISOString()
  const { data, error } = await supabase.from("warranty_requests").update({
    first_responded_at: now,
    metadata: mergeMetadata(current.metadata, {
      first_response_channel: parsed.channel,
      first_response_note: parsed.note?.trim() || null,
      first_response_by: userId,
      first_response_breached_at: undefined,
    }),
  }).eq("org_id", resolvedOrgId).eq("id", parsed.request_id).eq("project_id", current.project_id).eq("updated_at", current.updated_at).is("first_responded_at", null).select(WARRANTY_SELECT).maybeSingle()
  if (error) throw new Error(`Failed to record first response: ${error.message}`)
  if (!data) throw new Error("Warranty request changed concurrently; refresh before recording the first response")
  const updated = mapWarranty(data as unknown as Record<string, unknown>)
  await recordEvent({ orgId: resolvedOrgId, eventType: "warranty_first_response_recorded", entityType: "warranty_request", entityId: parsed.request_id, payload: { project_id: current.project_id, channel: parsed.channel, on_time: !current.first_response_due_at || now <= current.first_response_due_at } })
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "warranty_request", entityId: parsed.request_id, before: existing as unknown as Record<string, unknown>, after: data as unknown as Record<string, unknown> })
  return updated
}

export type WarrantySlaFilter =
  | "breached"
  | "due_soon"
  | "first_response_breached"
  | "first_response_due_soon"
  | "awaiting_first_response"

export async function listWarrantyRequestsForOrg(params: { orgId?: string; status?: string[]; severity?: string[]; communityId?: string; divisionId?: string; assignedUserId?: string; companyId?: string; coverageStatus?: string[]; slaState?: WarrantySlaFilter; search?: string; page?: number; pageSize?: number } = {}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(params.orgId)
  await requirePermission("warranty.read", { supabase, orgId: resolvedOrgId, userId })
  const scope = await warrantyDeskReadScope(resolvedOrgId, userId, params.divisionId)
  if (scope.divisionIds?.length === 0) return { rows: [], total: 0 }
  const paging = warrantyDeskPage(params.page, params.pageSize)
  const search = warrantyDeskSearchPattern(params.search)
  const lotRelation = params.communityId
    ? "lot:lots!lots_project_id_fkey!inner(community_id,community:communities!inner(name,time_zone))"
    : "lot:lots!lots_project_id_fkey(community_id,community:communities(name,time_zone))"
  const searchRelations = search ? ",search_home:projects(),search_community:projects(lot:lots!lots_project_id_fkey!inner(community:communities!inner()))" : ""
  let query = supabase.from("warranty_requests").select(`${WARRANTY_SELECT},${warrantyDeskProjectSelect(`name,home_org:orgs!projects_org_id_fkey(time_zone),${lotRelation}`, scope.projectMembershipRequired)}${searchRelations}`, { count: "exact" }).eq("org_id", resolvedOrgId)
  if (params.status?.length) query = query.in("status", params.status)
  if (params.severity?.length) query = query.in("severity", params.severity)
  if (params.assignedUserId) query = query.eq("assigned_user_id", params.assignedUserId)
  if (params.companyId) query = query.eq("assigned_company_id", params.companyId)
  if (params.communityId) query = query.eq("project.lot.community_id", params.communityId).eq("project.lot.org_id", resolvedOrgId).eq("project.lot.community.org_id", resolvedOrgId)
  query = query.eq("project.org_id", resolvedOrgId)
  if (scope.divisionIds) query = query.in("project.division_id", scope.divisionIds)
  if (scope.projectMembershipRequired) query = query.eq("project.access.org_id", resolvedOrgId).eq("project.access.user_id", userId).eq("project.access.status", "active")
  if (params.coverageStatus?.length) query = query.in("coverage_status", params.coverageStatus)
  const nowIso = new Date().toISOString()
  const openStatuses = ["open", "in_progress"]
  // A recorded breach stays breached even after a severity change moved the due date out.
  if (params.slaState === "breached") query = query.or(`resolution_due_at.lt.${nowIso},metadata->>sla_breached_at.not.is.null`).in("status", openStatuses)
  if (params.slaState === "due_soon") query = query.gte("resolution_due_at", nowIso).lte("resolution_due_at", new Date(Date.now() + 3 * 86_400_000).toISOString()).in("status", openStatuses)
  // First response is its own promise to the homeowner and breaches on its own
  // clock, so it filters independently of the resolution target.
  if (params.slaState === "first_response_breached") query = query.is("first_responded_at", null).lt("first_response_due_at", nowIso).in("status", openStatuses)
  if (params.slaState === "first_response_due_soon") query = query.is("first_responded_at", null).gte("first_response_due_at", nowIso).lte("first_response_due_at", new Date(Date.now() + 12 * 3_600_000).toISOString()).in("status", openStatuses)
  if (params.slaState === "awaiting_first_response") query = query.is("first_responded_at", null).in("status", openStatuses)
  if (search) {
    // Filter-only aliases keep display relationships intact when another field matches.
    query = query.filter("search_home.name", "imatch", search)
      .filter("search_community.lot.community.name", "imatch", search)
      .or(`title.imatch.${quoteWarrantySearchPattern(search)},description.imatch.${quoteWarrantySearchPattern(search)},search_home.not.is.null,search_community.not.is.null`)
  }
  const orderColumn = params.slaState?.startsWith("first_response") || params.slaState === "awaiting_first_response" ? "first_response_due_at" : "resolution_due_at"
  const { data, error, count } = await query.order(orderColumn, { ascending: true, nullsFirst: false }).order("id").range(paging.from, paging.to)
  if (error) throw new Error(`Failed to load warranty desk: ${error.message}`)
  const rows = (data ?? []).map((row) => {
    const mapped = mapWarranty(row as unknown as Record<string, unknown>), project = relationOne((row as unknown as Record<string, unknown>).project), lot = relationOne(project?.lot), community = relationOne(lot?.community)
    return { ...mapped, project_name: typeof project?.name === "string" ? project.name : null, community_id: typeof lot?.community_id === "string" ? lot.community_id : null, community_name: typeof community?.name === "string" ? community.name : null, time_zone: resolveWarrantyTimeZone(community?.time_zone, relationOne(project?.home_org)?.time_zone) }
  })
  return { rows, total: count ?? 0 }
}

export async function listWarrantyTechnicians(orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.read", { supabase, orgId: resolvedOrgId, userId })
  const { data, error } = await supabase.from("memberships").select("user_id,user:app_users!memberships_user_id_fkey(full_name,email),role:roles!inner(permissions:role_permissions!inner(permission_key))").eq("org_id", resolvedOrgId).eq("status", "active").eq("role.permissions.permission_key", "warranty.write").order("created_at").limit(500)
  if (error) throw new Error(`Failed to load warranty technicians: ${error.message}`)
  return (data ?? []).map((row) => { const user = relationOne(row.user); return { id: row.user_id, name: typeof user?.full_name === "string" ? user.full_name : typeof user?.email === "string" ? user.email : "Team member" } })
}

async function loadWarrantyEmailContext(orgId: string, projectId: string) {
  const supabase = createServiceSupabaseClient()
  const [{ data: org }, { data: project }] = await Promise.all([
    supabase.from("orgs").select("name,slug,logo_url").eq("id", orgId).maybeSingle(),
    supabase.from("projects").select("name,location").eq("org_id", orgId).eq("id", projectId).maybeSingle(),
  ])
  return { supabase, org, project }
}

async function sendWarrantyResolvedEmail(orgId: string, request: WarrantyRequest) {
  if (!request.requested_by) return
  const { supabase, org, project } = await loadWarrantyEmailContext(orgId, request.project_id)
  const contact = await fetchContactEmail(supabase, request.requested_by)
  if (!contact?.email) return
  const html = renderStandardEmailLayout({ title: `Warranty request resolved: ${request.title}`, messageHtml: `<p>${contact.full_name ? `Hi ${escapeHtml(contact.full_name)},` : "Hi,"}</p><p>Your warranty request${project?.name ? ` on <strong>${escapeHtml(project.name)}</strong>` : ""} has been marked resolved.</p>${request.resolution_note ? `<p style="white-space:pre-wrap;">${escapeHtml(request.resolution_note)}</p>` : ""}`, orgName: org?.name ?? null, orgLogoUrl: org?.logo_url ?? null, appUrl: APP_URL, showManageSettings: false })
  await sendEmail({ to: [contact.email], subject: `Warranty request resolved: ${request.title}`, html, from: getOrgSenderEmail(org?.slug, org?.name) })
}

async function loadVisit(supabase: SupabaseClient, orgId: string, visitId: string) {
  const { data, error } = await supabase.from("warranty_service_visits").select(VISIT_SELECT).eq("org_id", orgId).eq("id", visitId).maybeSingle()
  if (error || !data) throw new Error("Warranty visit not found")
  const revision = warrantyRecordRevisionSchema.safeParse(data)
  if (!revision.success) throw new Error("Warranty visit revision is unavailable; refresh before making changes")
  return { ...mapVisit(data as unknown as Record<string, unknown>), updated_at: revision.data.updated_at }
}

async function loadWarrantyRequest(supabase: SupabaseClient, orgId: string, requestId: string, projectId: string) {
  const { data, error } = await supabase.from("warranty_requests").select(WARRANTY_SELECT).eq("org_id", orgId).eq("id", requestId).eq("project_id", projectId).maybeSingle()
  if (error || !data) throw new Error("Warranty request not found")
  return mapWarranty(data as unknown as Record<string, unknown>)
}

export async function listWarrantyVisitsForProject(projectId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.read", { supabase, orgId: resolvedOrgId, userId })
  await authorizeWarrantyHome({ supabase, orgId: resolvedOrgId, userId }, projectId, "warranty.read")
  const rows = await readWarrantyHistory((cursor) => {
    let query = supabase.from("warranty_service_visits").select(VISIT_SELECT).eq("org_id", resolvedOrgId).eq("project_id", projectId).order("id").limit(100)
    if (cursor) query = query.gt("id", cursor)
    return query
  }, "Failed to load warranty visits")
  const timeZone = await loadWarrantyHomeTimeZone(supabase, resolvedOrgId, projectId)
  return rows.sort((a, b) => String(b.window_start).localeCompare(String(a.window_start)) || String(a.id).localeCompare(String(b.id))).map((row) => ({ ...mapVisit(row), time_zone: timeZone }))
}

/** The zone the dispatch week is drawn in: the org's, since a week spans many homes. */
export async function getWarrantyDeskTimeZone(orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.read", { supabase, orgId: resolvedOrgId, userId })
  return loadWarrantyOrgTimeZone(supabase, resolvedOrgId)
}

export async function listWarrantyVisitsForDispatch(params: { from: string; to: string; divisionId?: string; communityId?: string; orgId?: string; page?: number; pageSize?: number }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(params.orgId)
  await requirePermission("warranty.read", { supabase, orgId: resolvedOrgId, userId })
  const paging = warrantyDeskPage(params.page, params.pageSize)
  const scope = await warrantyDeskReadScope(resolvedOrgId, userId, params.divisionId)
  if (scope.divisionIds?.length === 0) return { rows: [], total: 0 }
  let query = supabase.from("warranty_service_visits").select(`${VISIT_SELECT},request:warranty_requests(title,severity,org_id,project_id),${warrantyDeskProjectSelect("name,location,home_org:orgs!projects_org_id_fkey(time_zone),home_lot:lots!lots_project_id_fkey(community:communities(time_zone))", scope.projectMembershipRequired, params.communityId)}`, { count: "exact" }).eq("org_id", resolvedOrgId).gte("window_start", params.from).lt("window_start", params.to).neq("status", "canceled")
  query = query.eq("project.org_id", resolvedOrgId)
  if (params.communityId) query = query.eq("project.lot.community_id", params.communityId).eq("project.lot.org_id", resolvedOrgId).eq("project.lot.community.org_id", resolvedOrgId)
  if (scope.divisionIds) query = query.in("project.division_id", scope.divisionIds)
  if (scope.projectMembershipRequired) query = query.eq("project.access.org_id", resolvedOrgId).eq("project.access.user_id", userId).eq("project.access.status", "active")
  const { data, error, count } = await query.order("window_start").order("id").range(paging.from, paging.to)
  if (error) throw new Error(`Failed to load dispatch board: ${error.message}`)
  const rows = (data ?? []).map((value) => {
    const row = value as unknown as Record<string, unknown>, request = relationOne(row.request), project = relationOne(row.project)
    // The community's zone, else the org's — read in the same query as the visit.
    const timeZone = resolveWarrantyTimeZone(relationOne(relationOne(project?.home_lot)?.community)?.time_zone, relationOne(project?.home_org)?.time_zone)
    return { ...mapVisit(row), time_zone: timeZone, request: request?.org_id === resolvedOrgId && request.project_id === row.project_id ? { title: request.title, severity: request.severity } : null, project: project ? { name: project.name, location: project.location } : null }
  })
  return { rows, total: count ?? 0 }
}

export interface WarrantyVisitConflict {
  visit_id: string
  request_id: string
  project_id: string
  visit_number: number
  window_start: string
  window_end: string
}

async function loadAssigneeVisitWindows(
  supabase: SupabaseClient,
  orgId: string,
  assignee: { kind: "tech" | "trade"; id: string },
  window: { start: string; end: string },
  options: { firstOnly?: boolean; excludeVisitId?: string } = {},
): Promise<Array<WarrantyVisitWindow & WarrantyVisitConflict>> {
  const column = assignee.kind === "tech" ? "assigned_user_id" : "assigned_company_id"
  const rows: Array<WarrantyVisitWindow & WarrantyVisitConflict> = []
  let cursor: string | null = null
  const pageSize = options.firstOnly ? 1 : 100
  for (;;) {
    let query = supabase.from("warranty_service_visits")
      .select("id,request_id,project_id,visit_number,window_start,window_end")
      .eq("org_id", orgId).eq(column, assignee.id)
      .not("status", "in", '("canceled","completed")')
      .lt("window_start", window.end).gt("window_end", window.start)
      .order("id").limit(pageSize)
    if (options.excludeVisitId) query = query.neq("id", options.excludeVisitId)
    if (cursor) query = query.gt("id", cursor)
    const { data, error } = await query
    if (error || !data) throw new Error(`Failed to check assignee availability: ${error?.message ?? "Availability page unavailable"}`)
    if (!data.length) return rows
    if (rows.length + data.length > 10000) throw new Error("Availability contains more than 10,000 overlapping visits; reconcile the assignee schedule before booking")
    for (const row of data) {
      if (!row.id || (cursor && row.id <= cursor)) throw new Error("Availability cursor did not advance; refresh before booking")
      rows.push({ id: row.id, visit_id: row.id, request_id: row.request_id, project_id: row.project_id,
        visit_number: Number(row.visit_number), window_start: row.window_start, window_end: row.window_end })
      cursor = row.id
    }
    if (options.firstOnly || data.length < pageSize) return rows
  }
}

/**
 * Dispatch pre-flight: the desk asks before it books so a double-booking is a
 * decision rather than an accident discovered by the homeowner.
 */
export async function findWarrantyVisitConflicts(
  input: { assignee_kind: "tech" | "trade"; assigned_user_id?: string | null; assigned_company_id?: string | null; window_start: string; window_end: string; exclude_visit_id?: string | null },
  orgId?: string,
): Promise<WarrantyVisitConflict[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.read", { supabase, orgId: resolvedOrgId, userId })
  const parsed = warrantyVisitConflictInputSchema.parse(input)
  const assigneeId = parsed.assignee_kind === "tech" ? parsed.assigned_user_id : parsed.assigned_company_id
  if (!assigneeId) return []
  const candidates = await loadAssigneeVisitWindows(supabase, resolvedOrgId, { kind: parsed.assignee_kind, id: assigneeId }, { start: parsed.window_start, end: parsed.window_end })
  const conflicts = findOverlappingVisits(candidates, parsed)
  const projectIds = [...new Set(conflicts.map((visit) => visit.project_id))]
  if (projectIds.length) {
    const access = await authorizeMany({ permission: "warranty.read", userId, orgId: resolvedOrgId, projectIds })
    if (projectIds.some((id) => access.get(id) !== true)) throw new Error("The assignee has overlapping work outside your home access; contact the dispatch coordinator")
  }
  return conflicts
}

const VISIT_DOUBLE_BOOKED = "This assignee is already booked for the requested window"
/** Postgres exclusion_violation: `warranty_service_visits_*_no_double_book` refused an overlapping window. */
const DOUBLE_BOOKING_VIOLATION = "23P01"

export async function scheduleWarrantyVisit(input: WarrantyVisitScheduleInput & { allow_conflict?: boolean; conflict_reason?: string | null }, orgId?: string) {
  const parsed = warrantyVisitScheduleSchema.parse(input)
  const { allow_conflict: allowConflict, conflict_reason: conflictReason } = warrantyScheduleOverrideSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.write", { supabase, orgId: resolvedOrgId, userId })
  const { data: requestRow, error: requestError } = await supabase.from("warranty_requests").select(WARRANTY_SELECT).eq("org_id", resolvedOrgId).eq("id", parsed.request_id).maybeSingle()
  if (requestError) throw new Error(`Unable to read warranty request: ${requestError.message}`)
  if (!requestRow) throw new Error("Warranty request not found")
  const request = mapWarranty(requestRow as unknown as Record<string, unknown>)
  await authorizeWarrantyHome({ supabase, orgId: resolvedOrgId, userId }, request.project_id, "warranty.write")
  const assigneeId = parsed.assignee_kind === "tech" ? parsed.assigned_user_id : parsed.assigned_company_id
  const candidates = assigneeId
    ? await loadAssigneeVisitWindows(supabase, resolvedOrgId, { kind: parsed.assignee_kind, id: assigneeId }, { start: parsed.window_start, end: parsed.window_end }, { firstOnly: true })
    : []
  const [conflict] = findOverlappingVisits(candidates, { window_start: parsed.window_start, window_end: parsed.window_end })
  if (conflict && !allowConflict) throw new Error(VISIT_DOUBLE_BOOKED)
  const timeZone = await loadWarrantyHomeTimeZone(supabase, resolvedOrgId, request.project_id)
  const { data: last } = await supabase.from("warranty_service_visits").select("visit_number").eq("org_id", resolvedOrgId).eq("request_id", parsed.request_id).order("visit_number", { ascending: false }).limit(1).maybeSingle()
  const { data, error } = await supabase.from("warranty_service_visits").insert({
    org_id: resolvedOrgId, request_id: parsed.request_id, project_id: request.project_id,
    visit_number: (last?.visit_number ?? 0) + 1, assignee_kind: parsed.assignee_kind,
    assigned_user_id: parsed.assignee_kind === "tech" ? parsed.assigned_user_id : null,
    assigned_company_id: parsed.assignee_kind === "trade" ? parsed.assigned_company_id : null,
    window_start: parsed.window_start, window_end: parsed.window_end,
    // Only a booking made over a conflict the coordinator saw is exempt from
    // the database's double-booking fence; every other booking is held to it.
    overlap_allowed: Boolean(conflict),
    metadata: {
      ...(parsed.note ? { schedule_note: parsed.note } : {}),
      // The exception is on the row: who double-booked, over which visit, and why.
      ...(conflict ? { overlap_reason: conflictReason ?? null, overlap_with_visit_id: conflict.visit_id, overlap_allowed_by: userId, overlap_allowed_at: new Date().toISOString() } : {}),
    },
  }).select(VISIT_SELECT).single()
  if (error?.code === DOUBLE_BOOKING_VIOLATION) throw new Error(VISIT_DOUBLE_BOOKED)
  if (error || !data) throw new Error(`Failed to schedule warranty visit: ${error?.message}`)
  const now = new Date().toISOString()
  // Assignment belongs to the visit. Recording who is going out on visit 2 must
  // not erase who owned visit 1, so the request keeps the most recent assignee
  // of each kind rather than nulling the kind that was not chosen. Dispatching
  // is also not a first response — that is an explicit call to the homeowner.
  const requestUpdate = await supabase.from("warranty_requests").update({
    status: "in_progress",
    ...(parsed.assignee_kind === "tech" ? { assigned_user_id: parsed.assigned_user_id } : { assigned_company_id: parsed.assigned_company_id, dispatched_at: now }),
    scheduled_date: warrantyLocalDate(parsed.window_start, timeZone),
  }).eq("org_id", resolvedOrgId).eq("id", parsed.request_id).eq("project_id", request.project_id).select("id").single()
  if (requestUpdate.error || !requestUpdate.data) throw new Error(`Warranty visit was created but request dispatch could not be saved: ${requestUpdate.error?.message ?? "Request changed"}`)
  const visit = mapVisit(data as unknown as Record<string, unknown>)
  const notices = await sendWarrantyVisitNotices({ supabase, orgId: resolvedOrgId, request, visit, kind: "scheduled", note: parsed.note ?? null, actorId: userId })
    .catch(() => null)
  await recordEvent({ orgId: resolvedOrgId, eventType: "warranty_visit_scheduled", entityType: "warranty_service_visit", entityId: visit.id, payload: { request_id: request.id, project_id: request.project_id, assignee_kind: visit.assignee_kind, overlap_allowed: Boolean(conflict), notices } })
  if (visit.assignee_kind === "trade" && notices && notices.trade_recipients > 0) {
    await recordEvent({ orgId: resolvedOrgId, eventType: "warranty_request_dispatched", entityType: "warranty_request", entityId: request.id, payload: { company_id: visit.assigned_company_id, visit_id: visit.id, recipients: notices.trade_recipients } })
  }
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "warranty_service_visit", entityId: visit.id, after: data as unknown as Record<string, unknown> })
  return visit
}

export async function rescheduleWarrantyVisit(input: unknown, orgId?: string) {
  const parsed = warrantyVisitRescheduleSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.write", { supabase, orgId: resolvedOrgId, userId })
  const existing = await loadVisit(supabase, resolvedOrgId, parsed.visit_id)
  await authorizeWarrantyHome({ supabase, orgId: resolvedOrgId, userId }, existing.project_id, "warranty.write")
  await assertWarrantyRequestHome(supabase, resolvedOrgId, existing.request_id, existing.project_id)
  if (["completed","canceled"].includes(existing.status)) throw new Error("Completed or canceled visits cannot be rescheduled")
  const assigneeId = existing.assignee_kind === "tech" ? existing.assigned_user_id : existing.assigned_company_id
  if (!assigneeId) throw new Error("Warranty visit assignee is unavailable; reassign before rescheduling")
  const candidates = await loadAssigneeVisitWindows(supabase, resolvedOrgId, { kind: existing.assignee_kind, id: assigneeId }, { start: parsed.window_start, end: parsed.window_end }, { firstOnly: true, excludeVisitId: existing.id })
  if (findOverlappingVisits(candidates, { ...parsed, exclude_visit_id: existing.id }).length) throw new Error("This assignee has an overlapping visit; choose another window before rescheduling")
  const [request, timeZone] = await Promise.all([
    loadWarrantyRequest(supabase, resolvedOrgId, existing.request_id, existing.project_id),
    loadWarrantyHomeTimeZone(supabase, resolvedOrgId, existing.project_id),
  ])

  const { data, error } = await supabase.from("warranty_service_visits").update({ window_start: parsed.window_start, window_end: parsed.window_end, status: "scheduled", confirmed_at: null, buyer_confirmed_at: null, buyer_reschedule_requested_at: null, buyer_reschedule_note: null, overlap_allowed: false, metadata: mergeMetadata(existing.metadata, { reschedule_note: parsed.note ?? null }) }).eq("org_id", resolvedOrgId).eq("id", parsed.visit_id).eq("project_id", existing.project_id).eq("request_id", existing.request_id).eq("updated_at", existing.updated_at).eq("status", existing.status).select(VISIT_SELECT).single()
  if (error?.code === DOUBLE_BOOKING_VIOLATION) throw new Error("This assignee has an overlapping visit; choose another window before rescheduling")
  if (error || !data) throw new Error(`Warranty visit changed concurrently or could not be rescheduled: ${error?.message ?? "Refresh before retrying"}`)
  const visit = mapVisit(data as unknown as Record<string, unknown>)
  const moved = await supabase.from("warranty_requests").update({ scheduled_date: warrantyLocalDate(parsed.window_start, timeZone) }).eq("org_id", resolvedOrgId).eq("id", existing.request_id).eq("project_id", existing.project_id)
  if (moved.error) throw new Error(`Warranty visit was rescheduled but the request date could not be saved: ${moved.error.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "warranty_service_visit", entityId: parsed.visit_id, before: existing as unknown as Record<string, unknown>, after: data as unknown as Record<string, unknown> })
  // The homeowner, the trade and the technician all planned around the old time.
  const notices = await sendWarrantyVisitNotices({ supabase, orgId: resolvedOrgId, request, visit, kind: "rescheduled", previousWindow: existing, note: parsed.note ?? null, actorId: userId }).catch(() => null)
  await recordEvent({ orgId: resolvedOrgId, eventType: "warranty_visit_rescheduled", entityType: "warranty_service_visit", entityId: parsed.visit_id, payload: { request_id: existing.request_id, project_id: existing.project_id, previous_window_start: existing.window_start, previous_window_end: existing.window_end, window_start: visit.window_start, window_end: visit.window_end, reason: parsed.note ?? null, notices } })
  return visit
}

export async function cancelWarrantyVisit(visitId: string, note?: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.write", { supabase, orgId: resolvedOrgId, userId })
  const existing = await loadVisit(supabase, resolvedOrgId, visitId)
  await authorizeWarrantyHome({ supabase, orgId: resolvedOrgId, userId }, existing.project_id, "warranty.write")
  await assertWarrantyRequestHome(supabase, resolvedOrgId, existing.request_id, existing.project_id)
  if (existing.status === "completed") throw new Error("Completed visits cannot be canceled")
  const request = await loadWarrantyRequest(supabase, resolvedOrgId, existing.request_id, existing.project_id)
  const { data, error } = await supabase.from("warranty_service_visits").update({ status: "canceled", metadata: mergeMetadata(existing.metadata, { cancel_note: note ?? null }) }).eq("org_id", resolvedOrgId).eq("id", visitId).eq("project_id", existing.project_id).eq("request_id", existing.request_id).eq("updated_at", existing.updated_at).eq("status", existing.status).select(VISIT_SELECT).single()
  if (error || !data) throw new Error(`Warranty visit changed concurrently or could not be canceled: ${error?.message ?? "Refresh before retrying"}`)
  const visit = mapVisit(data as unknown as Record<string, unknown>)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "warranty_service_visit", entityId: visitId, before: existing as unknown as Record<string, unknown>, after: data as unknown as Record<string, unknown> })
  const notices = await sendWarrantyVisitNotices({ supabase, orgId: resolvedOrgId, request, visit, kind: "canceled", note: note ?? null, actorId: userId }).catch(() => null)
  await recordEvent({ orgId: resolvedOrgId, eventType: "warranty_visit_canceled", entityType: "warranty_service_visit", entityId: visitId, payload: { request_id: existing.request_id, project_id: existing.project_id, window_start: existing.window_start, window_end: existing.window_end, reason: note ?? null, notices } })
  return visit
}

async function loadWarrantyRequestState(supabase: SupabaseClient, orgId: string, requestId: string, projectId: string) {
  const { data, error } = await supabase.from("warranty_requests").select("id,project_id,status,metadata,updated_at").eq("org_id", orgId).eq("id", requestId).eq("project_id", projectId).maybeSingle()
  if (error) throw new Error(`Failed to load warranty request: ${error.message}`)
  if (!data || typeof data.updated_at !== "string" || !data.updated_at) throw new Error("Warranty request revision is unavailable; refresh before making changes")
  return { status: String(data.status), metadata: mergeMetadata(data.metadata, {}), updated_at: data.updated_at }
}

async function completeVisitWithClient(input: WarrantyVisitCompleteWithCostInput, context: { supabase: SupabaseClient; orgId: string; userId: string | null; portalCompanyId?: string; portalTokenId?: string; requireTransaction?: boolean; expectedVisitAt?: string }) {
  const parsed = warrantyVisitCompleteWithCostSchema.parse(input)
  const existing = await loadVisit(context.supabase, context.orgId, parsed.visit_id)
  if (context.userId) await authorizeWarrantyHome({ ...context, userId: context.userId }, existing.project_id, "warranty.write")
  await assertWarrantyRequestHome(context.supabase, context.orgId, existing.request_id, existing.project_id)
  if (context.portalCompanyId && (existing.assignee_kind !== "trade" || existing.assigned_company_id !== context.portalCompanyId)) throw new Error("Warranty visit not found")
  if (context.userId && !context.portalCompanyId) {
    const transactionClient = createServiceSupabaseClient()
    if (await warrantyCompletionTransactionsEnabled(transactionClient, context.orgId)) {
      const requestState = await loadWarrantyRequestState(context.supabase, context.orgId, existing.request_id, existing.project_id)
      await commitOfficeWarrantyCompletion({ supabase: transactionClient, orgId: context.orgId, actorId: context.userId,
        visitId: existing.id, requestId: existing.request_id, expectedVisitAt: context.expectedVisitAt ?? existing.updated_at,
        expectedRequestAt: requestState.updated_at, completion: parsed })
      return loadVisit(context.supabase, context.orgId, existing.id)
    }
  }
  if (context.requireTransaction) throw new Error("Transactional warranty completion is unavailable; retry after its approved rollout is restored")
  if (["completed","canceled"].includes(existing.status)) throw new Error(`This visit is already ${existing.status}`)
  const requestState = await loadWarrantyRequestState(context.supabase, context.orgId, existing.request_id, existing.project_id)
  if (["resolved", "closed"].includes(requestState.status)) throw new Error("Resolved or closed warranty requests cannot receive a visit completion; reopen the request first")
  await assertWarrantyFiles(context.supabase, context.orgId, existing.project_id, [...(parsed.photo_file_ids ?? []), ...(parsed.buyer_signature_file_id ? [parsed.buyer_signature_file_id] : [])])
  const cost = computeVisitInternalCost({ labor_hours: parsed.labor_hours, labor_rate_cents: parsed.labor_rate_cents, material_cents: parsed.material_cents })
  const now = new Date().toISOString()
  const pendingVerification = completionAwaitsVerification({
    source: context.portalCompanyId ? "portal" : "office",
    outcome: parsed.outcome,
    photoCount: new Set(parsed.photo_file_ids ?? []).size,
    buyerSignoffName: parsed.buyer_signoff_name,
  })
  const { data, error } = await context.supabase.from("warranty_service_visits").update({
    status: "completed", outcome: parsed.outcome, outcome_note: parsed.outcome_note ?? null, completed_at: now,
    completed_by: context.userId, buyer_signoff_name: parsed.buyer_signoff_name ?? null,
    buyer_signoff_at: parsed.buyer_signoff_name ? now : null, buyer_signature_file_id: parsed.buyer_signature_file_id ?? null,
    labor_hours: cost.labor_hours, labor_rate_cents: cost.labor_rate_cents,
    internal_labor_cents: cost.internal_labor_cents, internal_material_cents: cost.internal_material_cents,
    metadata: mergeMetadata(existing.metadata, { portal_token_id: context.portalTokenId ?? null }),
  }).eq("org_id", context.orgId).eq("id", parsed.visit_id).eq("project_id", existing.project_id).eq("request_id", existing.request_id).eq("updated_at", existing.updated_at).eq("status", existing.status).select(VISIT_SELECT).single()
  if (error || !data) throw new Error(`Warranty visit changed concurrently or could not be completed: ${error?.message ?? "Refresh before retrying"}`)
  if (parsed.photo_file_ids?.length) {
    const { error: photoError } = await context.supabase.from("warranty_visit_photos").upsert([...new Set(parsed.photo_file_ids)].map((fileId) => ({ org_id: context.orgId, visit_id: parsed.visit_id, file_id: fileId, created_by: context.userId })), { onConflict: "visit_id,file_id" })
    if (photoError) throw new Error(`Failed to attach visit photos: ${photoError.message}`)
  }
  const requestMetadata = requestState.metadata
  const requestUpdate = pendingVerification
    ? { status: "in_progress", metadata: mergeMetadata(requestMetadata, { pending_verification: true, completed_visit_id: parsed.visit_id }) }
    : parsed.outcome === "resolved"
      ? { status: "resolved", closed_at: now, metadata: mergeMetadata(requestMetadata, { pending_verification: false, completed_visit_id: parsed.visit_id }) }
      : { status: "in_progress", metadata: mergeMetadata(requestMetadata, { completed_visit_id: parsed.visit_id }) }
  const requestResult = await context.supabase.from("warranty_requests").update(requestUpdate).eq("org_id", context.orgId).eq("id", existing.request_id).eq("project_id", existing.project_id).eq("updated_at", requestState.updated_at).eq("status", requestState.status).select("id").single()
  if (requestResult.error || !requestResult.data) throw new Error(`Warranty visit was completed but request status could not be saved: ${requestResult.error?.message ?? "Request changed"}`)
  await recordEvent({ orgId: context.orgId, eventType: "warranty_visit_completed", entityType: "warranty_service_visit", entityId: parsed.visit_id, payload: { request_id: existing.request_id, outcome: parsed.outcome, pending_verification: pendingVerification, internal_cost_cents: cost.internal_total_cents } })
  await recordAudit({ orgId: context.orgId, actorId: context.userId ?? undefined, action: "update", entityType: "warranty_service_visit", entityId: parsed.visit_id, before: existing as unknown as Record<string, unknown>, after: data as unknown as Record<string, unknown> })
  return mapVisit(data as unknown as Record<string, unknown>)
}

export async function completeWarrantyVisit(input: WarrantyVisitCompleteWithCostInput, orgId?: string, options: { requireTransaction?: boolean; expectedVisitAt?: string } = {}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.write", { supabase, orgId: resolvedOrgId, userId })
  return completeVisitWithClient(input, { supabase, orgId: resolvedOrgId, userId, requireTransaction: options.requireTransaction, expectedVisitAt: options.expectedVisitAt })
}

/**
 * A trade reporting its own work done is a claim, not a closure. These are the
 * requests still holding `pending_verification` — the office queue that closes
 * the loop on a portal completion.
 */
export async function listWarrantyVisitsPendingVerification(params: { divisionId?: string; communityId?: string; limit?: number; page?: number; pageSize?: number; orgId?: string } = {}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(params.orgId)
  await requirePermission("warranty.read", { supabase, orgId: resolvedOrgId, userId })
  const paging = warrantyDeskPage(params.page, params.pageSize ?? params.limit)
  const scope = await warrantyDeskReadScope(resolvedOrgId, userId, params.divisionId)
  if (scope.divisionIds?.length === 0) return { rows: [], total: 0 }
  let requestQuery = supabase.from("warranty_requests").select(`id,project_id,request_number,title,severity,metadata,${warrantyDeskProjectSelect("name", scope.projectMembershipRequired, params.communityId)}`, { count: "exact" }).eq("org_id", resolvedOrgId).eq("metadata->>pending_verification", "true").not("metadata->>completed_visit_id", "is", null).in("status", ["open", "in_progress"])
  requestQuery = requestQuery.eq("project.org_id", resolvedOrgId)
  if (params.communityId) requestQuery = requestQuery.eq("project.lot.community_id", params.communityId).eq("project.lot.org_id", resolvedOrgId).eq("project.lot.community.org_id", resolvedOrgId)
  if (scope.divisionIds) requestQuery = requestQuery.in("project.division_id", scope.divisionIds)
  if (scope.projectMembershipRequired) requestQuery = requestQuery.eq("project.access.org_id", resolvedOrgId).eq("project.access.user_id", userId).eq("project.access.status", "active")
  const { data: requests, error: requestError, count } = await requestQuery.order("updated_at", { ascending: true }).order("id").range(paging.from, paging.to)
  if (requestError) throw new Error(`Failed to load visits awaiting verification: ${requestError.message}`)
  const byVisitId = new Map<string, Record<string, unknown>>()
  for (const request of (requests ?? []) as unknown as Record<string, unknown>[]) {
    const metadata = request.metadata && typeof request.metadata === "object" ? request.metadata as Record<string, unknown> : {}
    if (typeof metadata.completed_visit_id === "string") byVisitId.set(metadata.completed_visit_id, request as unknown as Record<string, unknown>)
  }
  if (byVisitId.size === 0) return { rows: [], total: count ?? 0 }
  const { data: visits, error: visitError } = await supabase.from("warranty_service_visits").select(VISIT_SELECT).eq("org_id", resolvedOrgId).eq("status", "completed").in("id", Array.from(byVisitId.keys())).order("completed_at", { ascending: true })
  if (visitError) throw new Error(`Failed to load visits awaiting verification: ${visitError.message}`)
  const rows = ((visits ?? []) as unknown as Record<string, unknown>[]).filter((row) => {
    const request = byVisitId.get(String(row.id))
    return request && request.id === row.request_id && request.project_id === row.project_id
  }).map((row) => {
    const visit = mapVisit(row as unknown as Record<string, unknown>)
    const request = byVisitId.get(visit.id)
    return { ...visit, request: request ?? null, project: relationOne(request?.project) }
  })
  const order = new Map([...byVisitId.keys()].map((id, index) => [id, index]))
  rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!)
  return { rows, total: count ?? 0 }
}

export async function verifyWarrantyVisit(visitId: string, resolutionNote?: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.write", { supabase, orgId: resolvedOrgId, userId })
  const visit = await loadVisit(supabase, resolvedOrgId, visitId)
  await authorizeWarrantyHome({ supabase, orgId: resolvedOrgId, userId }, visit.project_id, "warranty.write")
  await assertWarrantyRequestHome(supabase, resolvedOrgId, visit.request_id, visit.project_id)
  if (visit.status !== "completed") throw new Error("Only completed visits can be verified")
  const now = new Date().toISOString(), resolved = visit.outcome === "resolved"
  const requestState = await loadWarrantyRequestState(supabase, resolvedOrgId, visit.request_id, visit.project_id)
  const requestMetadata = requestState.metadata
  if (["resolved", "closed"].includes(requestState.status) || requestMetadata.pending_verification !== true || requestMetadata.completed_visit_id !== visitId) throw new Error("This visit is no longer awaiting verification for the request; refresh before making changes")
  const { data: updatedRequest, error } = await supabase.from("warranty_requests").update({
    status: resolved ? "resolved" : "in_progress",
    closed_at: resolved ? now : null,
    ...(resolutionNote?.trim() ? { resolution_note: resolutionNote.trim() } : {}),
    metadata: mergeMetadata(requestMetadata, { pending_verification: false, verified_visit_id: visitId, verified_by: userId, verified_at: now }),
  }).eq("org_id", resolvedOrgId).eq("id", visit.request_id).eq("project_id", visit.project_id).eq("updated_at", requestState.updated_at).eq("status", requestState.status).select(WARRANTY_SELECT).single()
  if (error || !updatedRequest) throw new Error(`Failed to verify warranty visit: ${error?.message}`)
  await recordEvent({ orgId: resolvedOrgId, eventType: "warranty_visit_verified", entityType: "warranty_service_visit", entityId: visitId, payload: { request_id: visit.request_id, resolved } })
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "warranty_request", entityId: visit.request_id, after: { pending_verification: false, visit_id: visitId, resolved } })
  // Verification is what actually closes a request, so it owes the homeowner the
  // same note the office path sends.
  if (resolved) await sendWarrantyResolvedEmail(resolvedOrgId, mapWarranty(updatedRequest as unknown as Record<string, unknown>))
  return visit
}

/**
 * The other answer to a completion claim: the work is not done. The request
 * leaves the verification queue and goes back to in progress with the reason
 * on the record, and the office books the corrective visit from the request.
 * The visit itself stays as reported — what the trade claimed is evidence too.
 */
export async function rejectWarrantyVisitCompletion(visitId: string, reason: string, orgId?: string) {
  const note = warrantyRejectionReasonSchema.parse(reason)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.write", { supabase, orgId: resolvedOrgId, userId })
  const visit = await loadVisit(supabase, resolvedOrgId, visitId)
  await authorizeWarrantyHome({ supabase, orgId: resolvedOrgId, userId }, visit.project_id, "warranty.write")
  await assertWarrantyRequestHome(supabase, resolvedOrgId, visit.request_id, visit.project_id)
  if (visit.status !== "completed") throw new Error("Only completed visits can be sent back")
  const requestState = await loadWarrantyRequestState(supabase, resolvedOrgId, visit.request_id, visit.project_id)
  const requestMetadata = requestState.metadata
  if (["resolved", "closed"].includes(requestState.status) || requestMetadata.pending_verification !== true || requestMetadata.completed_visit_id !== visitId) throw new Error("This visit is no longer awaiting verification for the request; refresh before making changes")
  const now = new Date().toISOString()
  const { data: updatedRequest, error } = await supabase.from("warranty_requests").update({
    status: "in_progress",
    closed_at: null,
    metadata: mergeMetadata(requestMetadata, { pending_verification: false, rejected_visit_id: visitId, rejected_by: userId, rejected_at: now, rejection_reason: note }),
  }).eq("org_id", resolvedOrgId).eq("id", visit.request_id).eq("project_id", visit.project_id).eq("updated_at", requestState.updated_at).eq("status", requestState.status).select("id").maybeSingle()
  if (error) throw new Error(`Failed to send the visit back: ${error.message}`)
  if (!updatedRequest) throw new Error("The warranty request changed while you were reviewing it; refresh before sending the visit back")
  await recordEvent({ orgId: resolvedOrgId, eventType: "warranty_visit_rejected", entityType: "warranty_service_visit", entityId: visitId, payload: { request_id: visit.request_id, project_id: visit.project_id, reason: note } })
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "warranty_request", entityId: visit.request_id, before: { status: requestState.status, pending_verification: true }, after: { status: "in_progress", pending_verification: false, rejected_visit_id: visitId, rejection_reason: note } })
  return visit
}

export async function listWarrantyVisitsForCompanyPortal({ orgId, companyId, projectId }: { orgId: string; companyId: string; projectId?: string }) {
  const supabase = createServiceSupabaseClient()
  let query = supabase.from("warranty_service_visits").select(`${VISIT_SELECT},request:warranty_requests(title,description,severity),project:projects(name,location)`).eq("org_id", orgId).eq("assigned_company_id", companyId).neq("status", "canceled")
  if (projectId) query = query.eq("project_id", projectId)
  const { data, error } = await query.order("window_start")
  if (error) throw new Error(`Failed to load warranty appointments: ${error.message}`)
  const zones = await loadWarrantyHomeTimeZones(supabase, orgId, (data ?? []).map((row) => String((row as unknown as Record<string, unknown>).project_id)))
  return (data ?? []).map((row) => ({ ...mapVisit(row as unknown as Record<string, unknown>), time_zone: zones.get(String((row as unknown as Record<string, unknown>).project_id)), request: relationOne((row as unknown as Record<string, unknown>).request), project: relationOne((row as unknown as Record<string, unknown>).project) }))
}

/** What a homeowner may see of a visit: the window, who is coming and their own answer — never internal notes. */
function buyerPortalVisit(row: Record<string, unknown>, timeZone: string): WarrantyServiceVisitDTO {
  return { ...mapVisit(row), metadata: {}, time_zone: timeZone }
}

export async function listWarrantyVisitsForBuyerPortal(orgId: string, projectId: string) {
  const supabase = createServiceSupabaseClient()
  const [{ data, error }, timeZone] = await Promise.all([
    supabase.from("warranty_service_visits").select(VISIT_SELECT).eq("org_id", orgId).eq("project_id", projectId).neq("status", "canceled").order("window_start", { ascending: false }).limit(100),
    loadWarrantyHomeTimeZone(supabase, orgId, projectId),
  ])
  if (error) throw new Error(`Failed to load warranty appointments: ${error.message}`)
  return (data ?? []).map((row) => buyerPortalVisit(row as unknown as Record<string, unknown>, timeZone))
}

/** One appointment as the homeowner's confirm / change-the-time page shows it. */
export async function getWarrantyVisitForBuyerPortal({ orgId, projectId, visitId }: { orgId: string; projectId: string; visitId: string }) {
  const supabase = createServiceSupabaseClient()
  const visit = await loadVisit(supabase, orgId, visitId)
  if (visit.project_id !== projectId) throw new Error("Warranty visit not found")
  const [request, timeZone, { data: project }] = await Promise.all([
    loadWarrantyRequest(supabase, orgId, visit.request_id, visit.project_id),
    loadWarrantyHomeTimeZone(supabase, orgId, projectId),
    supabase.from("projects").select("name").eq("org_id", orgId).eq("id", projectId).maybeSingle(),
  ])
  return { visit: { ...visit, metadata: {}, time_zone: timeZone }, request_title: request.title, project_name: typeof project?.name === "string" ? project.name : null }
}

async function claimBuyerAppointmentResponse(input: { orgId: string; projectId: string; visitId: string; patch: Record<string, unknown> }) {
  const supabase = createServiceSupabaseClient()
  const existing = await loadVisit(supabase, input.orgId, input.visitId)
  if (existing.project_id !== input.projectId) throw new Error("Warranty visit not found")
  if (!["scheduled", "confirmed"].includes(existing.status)) throw new Error("This appointment can no longer be changed")
  const { data, error } = await supabase.from("warranty_service_visits").update(input.patch).eq("org_id", input.orgId).eq("id", input.visitId).eq("project_id", existing.project_id).eq("request_id", existing.request_id).eq("updated_at", existing.updated_at).in("status", ["scheduled", "confirmed"]).select(VISIT_SELECT).maybeSingle()
  if (error) throw new Error(`Failed to record your answer: ${error.message}`)
  if (!data) throw new Error("This appointment just changed; reload to see the new time")
  return { supabase, existing, visit: mapVisit(data as unknown as Record<string, unknown>), row: data as unknown as Record<string, unknown> }
}

/**
 * The homeowner confirms the appointment. Traceable like any other change: an
 * event and an audit row naming the buyer's contact, and the owner is told.
 */
export async function confirmWarrantyVisitByBuyer({ orgId, projectId, contactId, visitId }: { orgId: string; projectId: string; contactId: string | null; visitId: string }) {
  const supabase = createServiceSupabaseClient(), current = await loadVisit(supabase, orgId, visitId)
  if (current.project_id === projectId && current.buyer_confirmed_at) return { ...current, metadata: {}, time_zone: await loadWarrantyHomeTimeZone(supabase, orgId, projectId) }
  const now = new Date().toISOString()
  const { supabase: client, existing, visit, row } = await claimBuyerAppointmentResponse({ orgId, projectId, visitId, patch: { buyer_confirmed_at: now, buyer_reschedule_requested_at: null, buyer_reschedule_note: null } })
  const request = await loadWarrantyRequest(client, orgId, visit.request_id, visit.project_id)
  await recordEvent({ orgId, eventType: "warranty_visit_buyer_confirmed", entityType: "warranty_service_visit", entityId: visitId, payload: { request_id: visit.request_id, project_id: projectId, contact_id: contactId } })
  await recordAudit({ orgId, action: "update", entityType: "warranty_service_visit", entityId: visitId, before: existing as unknown as Record<string, unknown>, after: row, source: "buyer_portal" })
  const managers = await warrantyManagerRecipients(client, orgId, new Map())
  await notifyWarrantyBuyerResponse({ orgId, request, visit, response: "confirmed", recipientUserIds: managers }).catch(() => 0)
  return buyerPortalVisit(row, await loadWarrantyHomeTimeZone(client, orgId, projectId))
}

/** The homeowner can't make the time. The office sees the ask and moves the visit; the buyer never self-books. */
export async function requestWarrantyVisitRescheduleByBuyer({ orgId, projectId, contactId, visitId, note }: { orgId: string; projectId: string; contactId: string | null; visitId: string; note: string }) {
  const parsed = warrantyBuyerRescheduleRequestSchema.parse({ visit_id: visitId, note })
  const now = new Date().toISOString()
  const { supabase, existing, visit, row } = await claimBuyerAppointmentResponse({ orgId, projectId, visitId: parsed.visit_id, patch: { buyer_confirmed_at: null, buyer_reschedule_requested_at: now, buyer_reschedule_note: parsed.note } })
  const request = await loadWarrantyRequest(supabase, orgId, visit.request_id, visit.project_id)
  await recordEvent({ orgId, eventType: "warranty_visit_buyer_reschedule_requested", entityType: "warranty_service_visit", entityId: visitId, payload: { request_id: visit.request_id, project_id: projectId, contact_id: contactId, note: parsed.note } })
  await recordAudit({ orgId, action: "update", entityType: "warranty_service_visit", entityId: visitId, before: existing as unknown as Record<string, unknown>, after: row, source: "buyer_portal" })
  const managers = await warrantyManagerRecipients(supabase, orgId, new Map())
  await notifyWarrantyBuyerResponse({ orgId, request, visit, response: "reschedule_requested", note: parsed.note, recipientUserIds: managers }).catch(() => 0)
  return buyerPortalVisit(row, await loadWarrantyHomeTimeZone(supabase, orgId, projectId))
}

export async function confirmWarrantyVisitFromPortal({ orgId, companyId, visitId }: { orgId: string; companyId: string; visitId: string }) {
  const supabase = createServiceSupabaseClient(), existing = await loadVisit(supabase, orgId, visitId)
  if (existing.assigned_company_id !== companyId || existing.assignee_kind !== "trade") throw new Error("Warranty visit not found")
  if (existing.status !== "scheduled") throw new Error("Only scheduled visits can be confirmed")
  const now = new Date().toISOString()
  const { data, error } = await supabase.from("warranty_service_visits").update({ status: "confirmed", confirmed_at: now }).eq("org_id", orgId).eq("id", visitId).eq("project_id", existing.project_id).eq("request_id", existing.request_id).eq("updated_at", existing.updated_at).eq("status", existing.status).select(VISIT_SELECT).single()
  if (error || !data) throw new Error(`Warranty visit changed concurrently or could not be confirmed: ${error?.message ?? "Refresh before retrying"}`)
  await recordEvent({ orgId, eventType: "warranty_visit_confirmed", entityType: "warranty_service_visit", entityId: visitId, payload: { company_id: companyId } })
  return mapVisit(data as unknown as Record<string, unknown>)
}

/**
 * The job a visit belongs to. A completion photo has to be filed against that
 * job — never against whatever project the trade's link happened to name, which
 * for a vendor account link is nothing at all.
 */
export async function getWarrantyVisitProjectForCompanyPortal({ orgId, companyId, visitId }: { orgId: string; companyId: string; visitId: string }): Promise<string> {
  const visit = await loadVisit(createServiceSupabaseClient(), orgId, visitId)
  if (visit.assignee_kind !== "trade" || visit.assigned_company_id !== companyId) throw new Error("Warranty visit not found")
  return visit.project_id
}

/**
 * Trades report the real outcome of their own visit. Internal verification is
 * still what closes the request — `pending_verification` stays set for every
 * portal completion — but recording every trade visit as "needs followup" made
 * the visit log lie about what the crew said.
 */
export async function completeWarrantyVisitFromPortal(input: { orgId: string; companyId: string; portalTokenId?: string; visitId: string; outcome: unknown; outcomeNote: unknown; photoFileIds?: string[] }) {
  const parsed = warrantyVisitPortalOutcomeSchema.parse({ visit_id: input.visitId, outcome: input.outcome, outcome_note: input.outcomeNote, photo_file_ids: input.photoFileIds })
  return completeVisitWithClient(
    { visit_id: parsed.visit_id, outcome: parsed.outcome, outcome_note: parsed.outcome_note, photo_file_ids: parsed.photo_file_ids ?? [] },
    { supabase: createServiceSupabaseClient(), orgId: input.orgId, userId: null, portalCompanyId: input.companyId, portalTokenId: input.portalTokenId },
  )
}

export async function signOffWarrantyVisitFromPortal(input: { orgId: string; projectId: string; visitId: string; name: string; signatureFileId?: string | null }) {
  const supabase = createServiceSupabaseClient(), visit = await loadVisit(supabase, input.orgId, input.visitId)
  if (visit.project_id !== input.projectId || visit.status !== "completed") throw new Error("Completed warranty visit not found")
  if (visit.buyer_signoff_at) return { ...visit, metadata: {}, time_zone: await loadWarrantyHomeTimeZone(supabase, input.orgId, input.projectId) }
  const now = new Date().toISOString()
  const { data, error } = await supabase.from("warranty_service_visits").update({ buyer_signoff_name: input.name.trim(), buyer_signoff_at: now, buyer_signature_file_id: input.signatureFileId ?? null }).eq("org_id", input.orgId).eq("id", input.visitId).select(VISIT_SELECT).single()
  if (error || !data) throw new Error(`Failed to record buyer sign-off: ${error?.message}`)
  await recordEvent({ orgId: input.orgId, eventType: "warranty_request_signoff", entityType: "warranty_service_visit", entityId: input.visitId, payload: { request_id: visit.request_id } })
  return buyerPortalVisit(data as unknown as Record<string, unknown>, await loadWarrantyHomeTimeZone(supabase, input.orgId, input.projectId))
}

const BACKCHARGE_SELECT = `id,org_id,project_id,warranty_request_id,company_id,commitment_id,cost_code_id,backcharge_number,status,amount_cents,recovered_cents,reason,cost_basis,vendor_credit_bill_id,issued_at,disputed_at,dispute_note,resolved_at,notes,metadata,created_at,updated_at,company:companies(name),project:projects(name)`

async function loadBackcharge(supabase: SupabaseClient, orgId: string, backchargeId: string) {
  const { data, error } = await supabase.from("warranty_backcharges").select(BACKCHARGE_SELECT).eq("org_id", orgId).eq("id", backchargeId).maybeSingle()
  if (error || !data) throw new Error("Warranty backcharge not found")
  return { dto: mapBackcharge(data as unknown as Record<string, unknown>), row: data as unknown as Record<string, unknown> }
}

export async function listWarrantyBackcharges(params: { status?: string[]; projectId?: string; divisionId?: string; communityId?: string; page?: number; pageSize?: number; orgId?: string } = {}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(params.orgId)
  await requirePermission("warranty.read", { supabase, orgId: resolvedOrgId, userId })
  const scope = await warrantyDeskReadScope(resolvedOrgId, userId, params.divisionId)
  if (scope.divisionIds?.length === 0) return { rows: [], total: 0 }
  const paging = warrantyDeskPage(params.page, params.pageSize)
  let query = supabase.from("warranty_backcharges").select(BACKCHARGE_SELECT.replace("project:projects(name)", warrantyDeskProjectSelect("name", scope.projectMembershipRequired, params.communityId)), { count: "exact" }).eq("org_id", resolvedOrgId)
  if (params.status?.length) query = query.in("status", params.status)
  if (params.projectId) query = query.eq("project_id", params.projectId)
  query = query.eq("project.org_id", resolvedOrgId)
  if (params.communityId) query = query.eq("project.lot.community_id", params.communityId).eq("project.lot.org_id", resolvedOrgId).eq("project.lot.community.org_id", resolvedOrgId)
  if (scope.divisionIds) query = query.in("project.division_id", scope.divisionIds)
  if (scope.projectMembershipRequired) query = query.eq("project.access.org_id", resolvedOrgId).eq("project.access.user_id", userId).eq("project.access.status", "active")
  const { data, error, count } = await query.order("created_at", { ascending: false }).order("id").range(paging.from, paging.to)
  if (error) throw new Error(`Failed to load warranty backcharges: ${error.message}`)
  return { rows: (data ?? []).map((row) => mapBackcharge(row as unknown as Record<string, unknown>)), total: count ?? 0 }
}

export async function createWarrantyBackcharge(input: WarrantyBackchargeInput, orgId?: string) {
  const parsed = warrantyBackchargeInputSchema.parse(input)
  validateWarrantyCostBasis(parsed.amount_cents, parsed.cost_basis)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.backcharge", { supabase, orgId: resolvedOrgId, userId })
  await authorizeWarrantyHome({ supabase, orgId: resolvedOrgId, userId }, parsed.project_id, "warranty.backcharge")
  const [requestResult, companyResult, commitmentResult] = await Promise.all([
    supabase.from("warranty_requests").select("id,project_id").eq("org_id", resolvedOrgId).eq("id", parsed.warranty_request_id).maybeSingle(),
    supabase.from("companies").select("id").eq("org_id", resolvedOrgId).eq("id", parsed.company_id).maybeSingle(),
    parsed.commitment_id ? supabase.from("commitments").select("id,project_id,company_id").eq("org_id", resolvedOrgId).eq("id", parsed.commitment_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ])
  for (const result of [requestResult, companyResult, commitmentResult]) {
    if (result.error) throw new Error(`Unable to verify warranty backcharge references: ${result.error.message}`)
  }
  const request = requestResult.data, company = companyResult.data, commitment = commitmentResult.data
  if (!request || request.project_id !== parsed.project_id) throw new Error("Warranty request not found")
  if (!company) throw new Error("Trade company not found")
  if (parsed.commitment_id && (!commitment || commitment.project_id !== parsed.project_id || commitment.company_id !== parsed.company_id)) throw new Error("Originating commitment not found")
  let attempt = 0, created: Record<string, unknown> | null = null
  while (attempt < 5 && !created) {
    const { data: next } = await supabase.rpc("next_warranty_backcharge_number", { p_org_id: resolvedOrgId })
    const { data, error } = await supabase.from("warranty_backcharges").insert({
      org_id: resolvedOrgId, project_id: parsed.project_id, warranty_request_id: parsed.warranty_request_id,
      company_id: parsed.company_id, commitment_id: parsed.commitment_id ?? null, cost_code_id: parsed.cost_code_id ?? null,
      backcharge_number: Number(next ?? 1), amount_cents: parsed.amount_cents, reason: parsed.reason,
      cost_basis: parsed.cost_basis, notes: parsed.notes ?? null,
      metadata: { no_ap_history_confirmed: parsed.confirm_no_ap_history === true },
    }).select(BACKCHARGE_SELECT).single()
    if (!error && data) created = data as unknown as Record<string, unknown>
    else if (error?.code !== "23505") throw new Error(`Failed to create warranty backcharge: ${error?.message}`)
    attempt += 1
  }
  if (!created) throw new Error("Failed to allocate a warranty backcharge number")
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "warranty_backcharge", entityId: String(created.id), after: created })
  return mapBackcharge(created)
}

async function sendBackchargeNotice(orgId: string, backcharge: WarrantyBackchargeDTO) {
  const supabase = createServiceSupabaseClient()
  const [{ data: org }, contacts] = await Promise.all([
    supabase.from("orgs").select("name,slug,logo_url").eq("id", orgId).maybeSingle(),
    fetchCompanyContacts(supabase, orgId, backcharge.company_id),
  ])
  const recipients = contacts.map((contact) => contact.email).filter((email): email is string => Boolean(email))
  if (!recipients.length) return
  const items = backcharge.cost_basis.map((item) => `<li>${escapeHtml(item.label)} — <strong>${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(item.amount_cents / 100)}</strong></li>`).join("")
  const html = renderStandardEmailLayout({ title: `Warranty backcharge WB-${backcharge.backcharge_number}`, messageHtml: `<p>A warranty backcharge has been issued for <strong>${escapeHtml(backcharge.reason)}</strong>.</p><ul>${items}</ul><p>Total: <strong>${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(backcharge.amount_cents / 100)}</strong></p><p>Reply to this email with supporting documentation if you dispute this charge.</p>`, orgName: org?.name ?? null, orgLogoUrl: org?.logo_url ?? null, showManageSettings: false })
  await sendEmail({ to: recipients, subject: `Warranty backcharge WB-${backcharge.backcharge_number}`, html, from: getOrgSenderEmail(org?.slug, org?.name) })
}

/** A transition claim older than this belongs to an attempt that died; another may take it over. */
const BACKCHARGE_CLAIM_TTL_MS = 10 * 60_000

/**
 * Issuing and resolving a backcharge move money (a vendor credit, a reversing
 * bill) before the status changes. Two clicks used to both pass the status
 * check and both create the credit. The claim is a conditional write on the
 * status the caller read, taken BEFORE any side effect: the loser stops with
 * nothing created. A claim from an attempt that died expires, and the money
 * steps look for what that attempt already created before creating again.
 */
async function claimBackchargeTransition(supabase: SupabaseClient, orgId: string, existing: WarrantyBackchargeDTO, metadata: Record<string, unknown>, target: BackchargeStatus) {
  const claimedAt = new Date().toISOString()
  const stale = new Date(Date.now() - BACKCHARGE_CLAIM_TTL_MS).toISOString()
  const { data, error } = await supabase.from("warranty_backcharges")
    .update({ metadata: mergeMetadata(metadata, { transition_claimed_at: claimedAt, transition_target: target }) })
    .eq("org_id", orgId).eq("id", existing.id).eq("project_id", existing.project_id).eq("status", existing.status)
    .or(`metadata->>transition_claimed_at.is.null,metadata->>transition_claimed_at.lt.${stale}`)
    .select("metadata").maybeSingle()
  if (error) throw new Error(`Unable to claim the warranty backcharge: ${error.message}`)
  if (!data) throw new Error("This backcharge is already being issued or resolved. Refresh before trying again.")
  const claimed = mergeMetadata(data.metadata, {})
  const release = async () => {
    const { error: releaseError } = await supabase.from("warranty_backcharges")
      .update({ metadata: mergeMetadata(claimed, { transition_claimed_at: null, transition_target: null }) })
      .eq("org_id", orgId).eq("id", existing.id).eq("metadata->>transition_claimed_at", claimedAt)
    if (releaseError) throw new Error(`Unable to release the warranty backcharge claim: ${releaseError.message}`)
  }
  return { claimedAt, metadata: claimed, release }
}

/** A vendor bill an earlier, interrupted attempt already created for this backcharge. */
async function findBackchargeBill(supabase: SupabaseClient, orgId: string, backcharge: WarrantyBackchargeDTO, billNumber: string) {
  const { data, error } = await supabase.from("vendor_bills").select("id").eq("org_id", orgId).eq("company_id", backcharge.company_id).eq("bill_number", billNumber).limit(2)
  if (error) throw new Error(`Unable to check for an existing backcharge bill: ${error.message}`)
  if ((data ?? []).length > 1) throw new Error(`More than one bill ${billNumber} exists for this trade; reconcile them before continuing`)
  const existingId = data?.[0]?.id
  return typeof existingId === "string" ? existingId : null
}

export async function issueWarrantyBackcharge({ backchargeId }: { backchargeId: string }, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await Promise.all([
    requirePermission("warranty.backcharge", { supabase, orgId: resolvedOrgId, userId }),
    requirePermission("bill.write", { supabase, orgId: resolvedOrgId, userId }),
  ])
  const { dto: existing, row } = await loadBackcharge(supabase, resolvedOrgId, backchargeId)
  await authorizeWarrantyHome({ supabase, orgId: resolvedOrgId, userId }, existing.project_id, "warranty.backcharge")
  await assertWarrantyRequestHome(supabase, resolvedOrgId, existing.warranty_request_id, existing.project_id)
  await authorizeWarrantyHome({ supabase, orgId: resolvedOrgId, userId }, existing.project_id, "bill.write")
  assertBackchargeTransition(existing.status, "issued")
  const { count: payableCount, error: payableError } = await supabase.from("vendor_bills").select("id", { count: "exact", head: true }).eq("org_id", resolvedOrgId).eq("company_id", existing.company_id)
  if (payableError) throw new Error(`Unable to check the trade's AP history: ${payableError.message}`)
  if ((payableCount ?? 0) === 0 && (row.metadata as unknown as Record<string, unknown> | null)?.no_ap_history_confirmed !== true) {
    throw new Error("This trade has no AP history. Confirm recoverability before issuing the backcharge.")
  }
  const claim = await claimBackchargeTransition(supabase, resolvedOrgId, existing, mergeMetadata(row.metadata, {}), "issued")
  const billNumber = `WB-${existing.backcharge_number}`
  let creditId: string
  try {
    creditId = await findBackchargeBill(supabase, resolvedOrgId, existing, billNumber) ?? (await createProjectVendorCredit({
      projectId: existing.project_id, companyId: existing.company_id, commitmentId: existing.commitment_id,
      billNumber, billDate: new Date().toISOString().slice(0, 10),
      description: existing.reason, lines: existing.cost_basis.map((item) => ({ description: item.label, amount_cents: -item.amount_cents, cost_code_id: existing.cost_code_id })),
      metadata: { origin: "warranty_backcharge", warranty_backcharge_id: existing.id, warranty_request_id: existing.warranty_request_id, commitment_id: existing.commitment_id },
    }, resolvedOrgId)).id
  } catch (creditError) {
    await claim.release()
    throw creditError
  }
  const now = new Date().toISOString()
  const { data, error } = await supabase.from("warranty_backcharges").update({ status: "issued", vendor_credit_bill_id: creditId, issued_at: now, issued_by: userId, metadata: mergeMetadata(claim.metadata, { transition_claimed_at: null, transition_target: null }) })
    .eq("org_id", resolvedOrgId).eq("id", backchargeId).eq("project_id", existing.project_id).eq("warranty_request_id", existing.warranty_request_id)
    .eq("status", existing.status).eq("metadata->>transition_claimed_at", claim.claimedAt).select(BACKCHARGE_SELECT).maybeSingle()
  if (error) throw new Error(`Failed to issue warranty backcharge: ${error.message}`)
  if (!data) throw new Error("The backcharge changed while it was being issued; refresh and reconcile its vendor credit")
  const issued = mapBackcharge(data as unknown as Record<string, unknown>)
  await recordEvent({ orgId: resolvedOrgId, eventType: "warranty_backcharge_issued", entityType: "warranty_backcharge", entityId: backchargeId, payload: { vendor_credit_bill_id: creditId, amount_cents: issued.amount_cents } })
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "warranty_backcharge", entityId: backchargeId, before: row, after: data })
  await sendBackchargeNotice(resolvedOrgId, issued)
  return issued
}

export async function disputeWarrantyBackcharge({ backchargeId, note }: { backchargeId: string; note: string }, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.backcharge", { supabase, orgId: resolvedOrgId, userId })
  const { dto: existing, row } = await loadBackcharge(supabase, resolvedOrgId, backchargeId)
  await authorizeWarrantyHome({ supabase, orgId: resolvedOrgId, userId }, existing.project_id, "warranty.backcharge")
  await assertWarrantyRequestHome(supabase, resolvedOrgId, existing.warranty_request_id, existing.project_id)
  assertBackchargeTransition(existing.status, "disputed")
  const { data, error } = await supabase.from("warranty_backcharges").update({ status: "disputed", disputed_at: new Date().toISOString(), dispute_note: note.trim() }).eq("org_id", resolvedOrgId).eq("id", backchargeId).eq("project_id", existing.project_id).eq("warranty_request_id", existing.warranty_request_id).select(BACKCHARGE_SELECT).single()
  if (error || !data) throw new Error(`Failed to dispute warranty backcharge: ${error?.message}`)
  await recordEvent({ orgId: resolvedOrgId, eventType: "warranty_backcharge_disputed", entityType: "warranty_backcharge", entityId: backchargeId, payload: { note: note.trim() } })
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "warranty_backcharge", entityId: backchargeId, before: row, after: data })
  return mapBackcharge(data as unknown as Record<string, unknown>)
}

export async function resolveWarrantyBackcharge({ backchargeId, resolution, recoveredCents, note }: { backchargeId: string; resolution: "recovered" | "written_off" | "waived"; recoveredCents?: number; note?: string }, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.backcharge", { supabase, orgId: resolvedOrgId, userId })
  const { dto: existing, row } = await loadBackcharge(supabase, resolvedOrgId, backchargeId)
  await authorizeWarrantyHome({ supabase, orgId: resolvedOrgId, userId }, existing.project_id, "warranty.backcharge")
  await assertWarrantyRequestHome(supabase, resolvedOrgId, existing.warranty_request_id, existing.project_id)
  assertBackchargeTransition(existing.status, resolution)
  if (resolution !== "recovered" && !note?.trim()) throw new Error("A resolution note is required")
  const recovered = recoveredCents ?? (resolution === "recovered" ? existing.amount_cents : existing.recovered_cents)
  if (!Number.isInteger(recovered) || recovered < existing.recovered_cents || recovered > existing.amount_cents) throw new Error("Recovered amount is invalid")
  if (resolution === "recovered" && recovered !== existing.amount_cents) throw new Error("A recovered backcharge must be fully recovered")
  const reversing = resolution !== "recovered" && Boolean(existing.vendor_credit_bill_id)
  if (reversing) await authorizeWarrantyHome({ supabase, orgId: resolvedOrgId, userId }, existing.project_id, "bill.write")
  const claim = await claimBackchargeTransition(supabase, resolvedOrgId, existing, mergeMetadata(row.metadata, {}), resolution)
  const metadata = claim.metadata
  // Writing off or waiving does not un-happen the credit. Deleting the Arc row
  // stranded a live VendorCredit in the accounting provider with nothing
  // pointing at it; a reversing bill is both the correct artifact and the
  // auditable one, and the original credit stays linked.
  let reversalBillId = typeof metadata.reversal_bill_id === "string" ? metadata.reversal_bill_id : null
  if (reversing && !reversalBillId) {
    try {
      const reversalNumber = `WB-${existing.backcharge_number}-R`
      reversalBillId = await findBackchargeBill(supabase, resolvedOrgId, existing, reversalNumber) ?? (await createProjectVendorBill({
        projectId: existing.project_id,
        input: {
          company_id: existing.company_id,
          commitment_id: existing.commitment_id,
          bill_number: reversalNumber,
          bill_date: new Date().toISOString().slice(0, 10),
          total_cents: existing.amount_cents,
          description: `Reversal of warranty backcharge WB-${existing.backcharge_number} (${resolution.replace("_", " ")})`,
          actual_lines: existing.cost_basis.map((item) => ({ description: item.label, amount_cents: item.amount_cents, cost_code_id: existing.cost_code_id })),
        },
        orgId: resolvedOrgId,
      })).id
    } catch (reversalError) {
      await claim.release()
      throw reversalError
    }
  }
  const { data, error } = await supabase.from("warranty_backcharges").update({
    status: resolution, recovered_cents: recovered, resolved_at: new Date().toISOString(),
    notes: note?.trim() ?? existing.notes,
    vendor_credit_bill_id: existing.vendor_credit_bill_id,
    metadata: mergeMetadata(metadata, { reversal_bill_id: reversalBillId, transition_claimed_at: null, transition_target: null }),
  }).eq("org_id", resolvedOrgId).eq("id", backchargeId).eq("project_id", existing.project_id).eq("warranty_request_id", existing.warranty_request_id)
    .eq("status", existing.status).eq("metadata->>transition_claimed_at", claim.claimedAt).select(BACKCHARGE_SELECT).maybeSingle()
  if (error) throw new Error(`Failed to resolve warranty backcharge: ${error.message}`)
  if (!data) throw new Error("The backcharge changed while it was being resolved; refresh and reconcile its reversing bill")
  await recordEvent({ orgId: resolvedOrgId, eventType: "warranty_backcharge_resolved", entityType: "warranty_backcharge", entityId: backchargeId, payload: { resolution, recovered_cents: recovered, reversal_bill_id: reversalBillId } })
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "warranty_backcharge", entityId: backchargeId, before: row, after: data })
  return mapBackcharge(data as unknown as Record<string, unknown>)
}

/**
 * Ranked candidates for the purchase order that bought the work now failing.
 * This is the backcharge wedge: without the originating commitment a backcharge
 * is an unsupported invoice line, and the trade wins the dispute.
 */
export async function findOriginatingCommitments({ projectId, costCodeId, companyId }: { projectId: string; costCodeId?: string | null; companyId?: string | null }, orgId?: string): Promise<RankedOriginatingCommitment[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.read", { supabase, orgId: resolvedOrgId, userId })
  await authorizeWarrantyHome({ supabase, orgId: resolvedOrgId, userId }, projectId, "warranty.read")
  const data = await readWarrantyHistory((cursor) => {
    let query = supabase.from("commitments").select("id,title,contract_number,company_id,total_cents,status,company:companies(name),lines:commitment_lines(cost_code_id)").eq("org_id", resolvedOrgId).eq("project_id", projectId).order("id").limit(100)
    if (cursor) query = query.gt("id", cursor)
    return query
  }, "Failed to load originating commitments")
  const candidates: OriginatingCommitmentCandidate[] = (data ?? []).map((row) => {
    const lines = Array.isArray(row.lines) ? row.lines as Record<string, unknown>[] : []
    const company = relationOne(row.company)
    return {
      id: String(row.id), title: String(row.title), contract_number: typeof row.contract_number === "string" ? row.contract_number : null,
      company_id: typeof row.company_id === "string" ? row.company_id : null,
      company_name: typeof company?.name === "string" ? company.name : null,
      total_cents: Number(row.total_cents ?? 0), status: String(row.status),
      cost_code_ids: lines.map((line) => line.cost_code_id).filter((id): id is string => typeof id === "string"),
    }
  })
  return rankOriginatingCommitments(candidates, { costCodeId, companyId })
}

/**
 * The internal cost already recorded against a request, itemised so it can seed
 * a backcharge cost basis that a trade can actually argue with.
 */
export async function getWarrantyRequestCostBasis(requestId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.read", { supabase, orgId: resolvedOrgId, userId })
  const { data: request, error: requestError } = await supabase.from("warranty_requests").select("id,project_id").eq("org_id", resolvedOrgId).eq("id", requestId).maybeSingle()
  if (requestError || !request?.project_id) throw new Error(`Unable to verify warranty cost request: ${requestError?.message ?? "Request unavailable"}`)
  await authorizeWarrantyHome({ supabase, orgId: resolvedOrgId, userId }, request.project_id, "warranty.read")
  const rows = await readWarrantyHistory((cursor) => {
    let query = supabase.from("warranty_service_visits").select("id,visit_number,books_approved_cost_cents").eq("org_id", resolvedOrgId).eq("project_id", request.project_id).eq("request_id", requestId).not("books_cost_approved_at", "is", null).order("id").limit(100)
    if (cursor) query = query.gt("id", cursor)
    return query
  }, "Failed to load approved warranty costs")
  return rows.filter((row) => {
    const cost = row.books_approved_cost_cents
    if ((typeof cost !== "number" && (typeof cost !== "string" || !/^\d+$/.test(cost))) || !Number.isSafeInteger(Number(cost)) || Number(cost) < 0) throw new Error("Invalid approved warranty cost evidence")
    return Number(row.books_approved_cost_cents) > 0
  }).sort((a, b) => Number(a.visit_number) - Number(b.visit_number) || String(a.id).localeCompare(String(b.id))).map(row => ({ label: `Approved posted costs — Visit ${row.visit_number}`, amount_cents: Number(row.books_approved_cost_cents), ref_type: "warranty_service_visit", ref_id: String(row.id) }))
}

export interface WarrantyDefectAnalysisRow {
  group_id: string
  group_name: string | null
  request_count: number
  affected_home_count: number
  closed_home_count: number
  affected_home_percent: number | null
  remediation_cost_cents: number
  recovered_cents: number
  average_cost_cents: number
  top_categories: Array<{ category: string; count: number }>
}

export interface WarrantyCostSummaryRow {
  community_id: string
  community_name: string | null
  warranty_cost_cents: number
  recovered_cents: number
  net_cost_cents: number
  closed_revenue_cents: number
  cost_percent: number | null
}

function mapDefectAnalysisRow(row: Record<string, unknown>): WarrantyDefectAnalysisRow {
  return {
    group_id: String(row.group_id), group_name: typeof row.group_name === "string" ? row.group_name : null,
    request_count: Number(row.request_count ?? 0), affected_home_count: Number(row.affected_home_count ?? 0),
    closed_home_count: Number(row.closed_home_count ?? 0),
    affected_home_percent: row.affected_home_percent === null || row.affected_home_percent === undefined ? null : Number(row.affected_home_percent),
    remediation_cost_cents: Number(row.remediation_cost_cents ?? 0), recovered_cents: Number(row.recovered_cents ?? 0),
    average_cost_cents: Number(row.average_cost_cents ?? 0),
    top_categories: Array.isArray(row.top_categories)
      ? (row.top_categories as Array<Record<string, unknown>>).map((entry) => ({ category: String(entry.category ?? "Uncategorized"), count: Number(entry.count ?? 0) }))
      : [],
  }
}

export async function isWarrantyAnalyticsAvailable(params: { orgId?: string; divisionId?: string; communityId?: string } = {}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(params.orgId)
  await requirePermission("warranty.read", { supabase, orgId: resolvedOrgId, userId })
  if (await warrantyActorAnalyticsEnabled(supabase, resolvedOrgId)) return true
  const scope = await warrantyDeskReadScope(resolvedOrgId, userId)
  return !scope.projectMembershipRequired && scope.divisionIds === null && !params.divisionId && !params.communityId
}

export async function getWarrantyDefectAnalysis(params: { orgId?: string; divisionId?: string; communityId?: string; groupBy: "plan" | "plan_version" | "company" | "cost_code" | "community"; from?: string; to?: string }): Promise<WarrantyDefectAnalysisRow[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(params.orgId)
  await requirePermission("warranty.read", { supabase, orgId: resolvedOrgId, userId })
  if (await warrantyActorAnalyticsEnabled(supabase, resolvedOrgId)) return await readActorWarrantyAnalytics({ supabase, orgId: resolvedOrgId, actorId: userId, kind: "defect", divisionId: params.divisionId, communityId: params.communityId, groupBy: params.groupBy, from: params.from, to: params.to }) as WarrantyDefectAnalysisRow[]
  const scope = await warrantyDeskReadScope(resolvedOrgId, userId)
  if (scope.projectMembershipRequired || scope.divisionIds !== null || params.divisionId || params.communityId) throw new Error("Scoped warranty analytics requires its approved database rollout; broader legacy totals cannot be shown")
  const { data, error } = await supabase.rpc("warranty_defect_analysis_scoped", {
    p_org_id: resolvedOrgId,
    p_group_by: params.groupBy,
    p_project_ids: null,
    p_from: params.from ?? null,
    p_to: params.to ?? null,
  })
  if (error) throw new Error(`Failed to load warranty defect analysis: ${error.message}`)
  return ((data ?? []) as Array<Record<string, unknown>>).map(mapDefectAnalysisRow)
}

export async function getWarrantyCostSummary(params: { orgId?: string; communityId?: string; divisionId?: string } = {}): Promise<WarrantyCostSummaryRow[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(params.orgId)
  await requirePermission("warranty.read", { supabase, orgId: resolvedOrgId, userId })
  if (await warrantyActorAnalyticsEnabled(supabase, resolvedOrgId)) return await readActorWarrantyAnalytics({ supabase, orgId: resolvedOrgId, actorId: userId, kind: "cost", divisionId: params.divisionId, communityId: params.communityId }) as WarrantyCostSummaryRow[]
  const scope = await warrantyDeskReadScope(resolvedOrgId, userId)
  if (scope.projectMembershipRequired || scope.divisionIds !== null || params.divisionId || params.communityId) throw new Error("Scoped warranty analytics requires its approved database rollout; broader legacy totals cannot be shown")
  const { data, error } = await supabase.rpc("warranty_cost_summary", { p_org_id: resolvedOrgId, p_community_id: params.communityId ?? null })
  if (error) throw new Error(`Failed to load warranty cost summary: ${error.message}`)
  const rows = ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    community_id: String(row.community_id), community_name: typeof row.community_name === "string" ? row.community_name : null,
    warranty_cost_cents: Number(row.warranty_cost_cents ?? 0), recovered_cents: Number(row.recovered_cents ?? 0),
    net_cost_cents: Number(row.net_cost_cents ?? 0), closed_revenue_cents: Number(row.closed_revenue_cents ?? 0),
    cost_percent: row.cost_percent === null || row.cost_percent === undefined ? null : Number(row.cost_percent),
  }))
  return rows
}

export async function getCompanyWarrantySignal(companyId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.read", { supabase, orgId: resolvedOrgId, userId })
  if (await warrantyActorAnalyticsEnabled(supabase, resolvedOrgId)) return await readActorWarrantyAnalytics({ supabase, orgId: resolvedOrgId, actorId: userId, kind: "company", companyId }) as { request_count: number; backcharge_cents: number; recovered_cents: number; open_backcharges: number }
  const scope = await warrantyDeskReadScope(resolvedOrgId, userId)
  if (scope.divisionIds?.length === 0) return { request_count: 0, backcharge_cents: 0, recovered_cents: 0, open_backcharges: 0 }
  const project = warrantyDeskProjectSelect("id", scope.projectMembershipRequired)
  let requestsQuery = supabase.from("warranty_requests").select(`id,${project}`, { count: "exact", head: true }).eq("org_id", resolvedOrgId).eq("assigned_company_id", companyId).eq("project.org_id", resolvedOrgId)
  if (scope.divisionIds) requestsQuery = requestsQuery.in("project.division_id", scope.divisionIds)
  if (scope.projectMembershipRequired) requestsQuery = requestsQuery.eq("project.access.org_id", resolvedOrgId).eq("project.access.user_id", userId).eq("project.access.status", "active")
  let amount = BigInt(0), recovered = BigInt(0), open = 0
  const cents = (value: unknown) => {
    if ((typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value))) || !Number.isSafeInteger(Number(value)) || Number(value) < 0) throw new Error("Invalid warranty company monetary evidence")
    return BigInt(Number(value))
  }
  const [requestResult] = await Promise.all([
    requestsQuery,
    readWarrantyHistory((cursor) => {
      let query = supabase.from("warranty_backcharges").select(`id,amount_cents,recovered_cents,status,${project}`).eq("org_id", resolvedOrgId).eq("company_id", companyId).eq("project.org_id", resolvedOrgId).order("id").limit(100)
      if (scope.divisionIds) query = query.in("project.division_id", scope.divisionIds)
      if (scope.projectMembershipRequired) query = query.eq("project.access.org_id", resolvedOrgId).eq("project.access.user_id", userId).eq("project.access.status", "active")
      if (cursor) query = query.gt("id", cursor)
      return query
    }, "Failed to load complete company warranty signal", (row) => {
      const cost = cents(row.amount_cents), recovery = cents(row.recovered_cents)
      if (recovery > cost) throw new Error("Warranty company recovery exceeds its backcharge")
      amount += cost; recovered += recovery
      if (row.status === "issued" || row.status === "disputed") open++
    }, 1_000_000),
  ])
  if (requestResult.error || !Number.isSafeInteger(requestResult.count) || requestResult.count! < 0) throw new Error(`Failed to count company warranty requests: ${requestResult.error?.message ?? "Count unavailable"}`)
  if (amount > BigInt(Number.MAX_SAFE_INTEGER) || recovered > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Warranty company totals exceed safe integer cents")
  return { request_count: requestResult.count!, backcharge_cents: Number(amount), recovered_cents: Number(recovered), open_backcharges: open }
}

const SLA_SWEEP_PAGE_SIZE = 200
const SLA_SWEEP_MAX_PAGES = 100

interface BreachCandidate { id: string; org_id: string; project_id: string; title: string; metadata: unknown }

/**
 * One membership + role-permission lookup per org, cached across the sweep. The
 * previous shape issued both queries per breached request, so a bad night for a
 * single org multiplied into hundreds of round trips and timed the job out.
 */
async function warrantyManagerRecipients(supabase: SupabaseClient, orgId: string, cache: Map<string, string[]>) {
  const cached = cache.get(orgId)
  if (cached) return cached
  const { data: memberships } = await supabase.from("memberships").select("user_id,role_id").eq("org_id", orgId).eq("status", "active").limit(2000)
  const roleIds = Array.from(new Set((memberships ?? []).map((membership) => membership.role_id)))
  const { data: grants } = roleIds.length
    ? await supabase.from("role_permissions").select("role_id").in("role_id", roleIds).eq("permission_key", "warranty.manage")
    : { data: [] as Array<{ role_id: string }> }
  const allowed = new Set((grants ?? []).map((grant) => grant.role_id))
  const recipients = (memberships ?? []).filter((membership) => allowed.has(membership.role_id)).map((membership) => membership.user_id as string)
  cache.set(orgId, recipients)
  return recipients
}

type BreachPhaseKind = "resolution" | "first_response"

const BREACH_PHASES: Record<BreachPhaseKind, { flagKey: "sla_breached_at" | "first_response_breached_at"; eventType: string; notificationType: NotificationType; title: string }> = {
  resolution: { flagKey: "sla_breached_at", eventType: "warranty_sla_breached", notificationType: "warranty_sla_breached", title: "Warranty SLA breached" },
  // A homeowner nobody has called back is a different failure from a repair
  // running long, and someone may want only one of the two in their inbox.
  first_response: { flagKey: "first_response_breached_at", eventType: "warranty_first_response_breached", notificationType: "warranty_first_response_breached", title: "Warranty first response overdue" },
}

async function sweepBreachPhase(
  supabase: SupabaseClient,
  kind: BreachPhaseKind,
  now: string,
  recipientCache: Map<string, string[]>,
) {
  const phase = BREACH_PHASES[kind]
  const notifications = new NotificationService()
  let marked = 0
  for (let page = 0; page < SLA_SWEEP_MAX_PAGES; page += 1) {
    const base = supabase.from("warranty_requests").select("id,org_id,project_id,title,metadata").in("status", ["open", "in_progress"]).is(`metadata->>${phase.flagKey}`, null)
    const scoped = kind === "resolution"
      ? base.lt("resolution_due_at", now)
      : base.is("first_responded_at", null).lt("first_response_due_at", now)
    const { data, error } = await scoped.limit(SLA_SWEEP_PAGE_SIZE)
    if (error) throw new Error(`Failed to load warranty SLA breaches: ${error.message}`)
    const rows = (data ?? []) as unknown as BreachCandidate[]
    if (rows.length === 0) break
    let markedThisPage = 0
    for (const request of rows) {
      const { data: updated } = await supabase.from("warranty_requests")
        .update({ metadata: mergeMetadata(request.metadata, { [phase.flagKey]: now }) })
        .eq("org_id", request.org_id).eq("id", request.id).is(`metadata->>${phase.flagKey}`, null)
        .select("id").maybeSingle()
      if (!updated) continue
      markedThisPage += 1
      marked += 1
      await recordEvent({ orgId: request.org_id, eventType: phase.eventType, entityType: "warranty_request", entityId: request.id, payload: { project_id: request.project_id } })
      const recipients = await warrantyManagerRecipients(supabase, request.org_id, recipientCache)
      await Promise.allSettled(recipients.map((userId) => notifications.createAndQueue({
        orgId: request.org_id, userId, type: phase.notificationType, title: phase.title,
        message: request.title, projectId: request.project_id, entityType: "warranty_request", entityId: request.id,
      })))
    }
    // Every row in the page already carried the flag (a concurrent sweep marked
    // them); nothing further will drop out, so stop instead of spinning.
    if (markedThisPage === 0) break
  }
  return marked
}

export async function sweepWarrantySlaBreaches() {
  const supabase = createServiceSupabaseClient(), now = new Date().toISOString()
  const recipientCache = new Map<string, string[]>()
  const marked = await sweepBreachPhase(supabase, "resolution", now, recipientCache)
  const firstResponseMarked = await sweepBreachPhase(supabase, "first_response", now, recipientCache)
  return { marked, firstResponseMarked }
}

const COURTESY_MILESTONE_SEVERITY: Record<CourtesyMilestoneKey, WarrantySeverity> = {
  day_30: "routine_30",
  month_11: "routine_60",
}

/** Ceiling on rows one courtesy sweep reads per source; hitting it fails the sweep instead of guessing. */
const COURTESY_SCAN_CAP = 50_000

async function createCourtesyInspectionsForOrg(supabase: SupabaseClient, orgId: string, asOf: Date, canCreate?: (projectId: string) => Promise<boolean>, actorId?: string) {
  if (await courtesyReservationsEnabled(supabase, orgId)) return generateReservedCourtesyInspections({ supabase, orgId, asOf, canCreate, actorId })
  // Both reads are exhaustive: a coverage set that stopped short would defer homes
  // forever, and an "existing" set that stopped short would create duplicates. A
  // read that cannot finish fails the sweep rather than guessing.
  const coverage = await readAllRows<{ project_id: string; effective_date: string }>(
    (from, to) => supabase
      .from("project_warranty_coverage")
      .select("project_id,effective_date")
      // A 30-day walk and an 11-month walk are the whole ritual, so only homes
      // inside that band can have anything due.
      .eq("org_id", orgId)
      .is("voided_at", null)
      .gte("effective_date", new Date(asOf.getTime() - 425 * 86_400_000).toISOString().slice(0, 10))
      .lte("effective_date", asOf.toISOString().slice(0, 10))
      .order("project_id", { ascending: true })
      .range(from, to),
    { cap: COURTESY_SCAN_CAP, label: "Failed to load warranty coverage" },
  )
  if (coverage.truncated) throw new Error("Failed to load warranty coverage: more homes than one sweep can read")
  const due = coverage.rows.flatMap((row) => dueCourtesyInspections(String(row.effective_date), asOf).map((milestone) => ({ projectId: String(row.project_id), milestone })))
  if (due.length === 0) return 0
  const projectIds = Array.from(new Set(due.map((item) => item.projectId)))
  const alreadyCreated = new Set<string>()
  // Chunked so the `in` list stays inside the request URL.
  for (let offset = 0; offset < projectIds.length; offset += 100) {
    const chunk = projectIds.slice(offset, offset + 100)
    const existing = await readAllRows<{ id: string; project_id: string; metadata: unknown }>(
      (from, to) => supabase
        .from("warranty_requests").select("id,project_id,metadata")
        .eq("org_id", orgId).in("project_id", chunk).not("metadata->>courtesy_milestone", "is", null)
        .order("id", { ascending: true })
        .range(from, to),
      { cap: COURTESY_SCAN_CAP, label: "Failed to load existing courtesy inspections" },
    )
    if (existing.truncated) throw new Error("Failed to load existing courtesy inspections: more requests than one sweep can read")
    for (const row of existing.rows) {
      const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : {}
      alreadyCreated.add(`${row.project_id}:${String(metadata.courtesy_milestone ?? "")}`)
    }
  }
  let created = 0
  for (const item of due) {
    if (alreadyCreated.has(`${item.projectId}:${item.milestone.key}`) || (canCreate && !await canCreate(item.projectId))) continue
    const severity = COURTESY_MILESTONE_SEVERITY[item.milestone.key]
    const { data: target } = await supabase.from("warranty_sla_targets").select("first_response_hours,resolution_days").eq("org_id", orgId).eq("severity", severity).maybeSingle()
    const result = await insertWithProjectNumberRetry<Record<string, unknown>>({
      supabase, table: "warranty_requests", numberColumn: "request_number", rpcName: "next_warranty_request_number",
      conflictConstraint: "warranty_requests_project_number_idx", projectId: item.projectId,
      payload: {
        org_id: orgId, project_id: item.projectId, title: item.milestone.label,
        description: `Scheduled courtesy inspection due ${item.milestone.due_on}.`,
        status: "open", priority: "normal", severity, category: "Courtesy inspection",
        coverage_status: "in_warranty", source: "office", cost_dump_flag: false,
        scheduled_date: item.milestone.due_on,
        ...stampWarrantySla(asOf, target ?? DEFAULT_SLAS.find((entry) => entry.severity === severity)!),
        metadata: { courtesy_milestone: item.milestone.key, courtesy_due_on: item.milestone.due_on },
      },
      select: "id", entityLabel: "courtesy inspection",
    })
    created += 1
    await recordEvent({ orgId, eventType: "warranty_courtesy_inspection_created", entityType: "warranty_request", entityId: String(result.data.id), payload: { project_id: item.projectId, milestone: item.milestone.key, due_on: item.milestone.due_on } })
  }
  return created
}

/**
 * Cross-org generation of the 30-day and 11-month courtesy inspections, keyed
 * off each home's coverage start date. Idempotent: a home gets one request per
 * milestone no matter how often the sweep runs.
 */
export async function sweepWarrantyCourtesyInspections() {
  const supabase = createServiceSupabaseClient(), asOf = new Date()
  let created = 0, cursor: string | null = null
  for (;;) {
    let query = supabase.from("orgs").select("id").order("id").limit(100)
    if (cursor) query = query.gt("id", cursor)
    const { data: orgs, error } = await query
    if (error || !orgs) throw new Error(`Failed to load organizations: ${error?.message ?? "Page unavailable"}`)
    if (!orgs.length) break
    for (const org of orgs) created += await createCourtesyInspectionsForOrg(supabase, String(org.id), asOf)
    const next = String(orgs[orgs.length - 1].id)
    if (cursor && next <= cursor) throw new Error("Courtesy organization cursor did not advance")
    cursor = next
    if (orgs.length < 100) break
  }
  return { created }
}

export async function generateWarrantyCourtesyInspections(orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.manage", { supabase, orgId: resolvedOrgId, userId })
  const created = await createCourtesyInspectionsForOrg(supabase, resolvedOrgId, new Date(), projectId => authorizeCourtesyHome({ orgId: resolvedOrgId, userId, projectId, supabase }), userId)
  if (created > 0) await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "warranty_request", entityId: resolvedOrgId, after: { courtesy_inspections_created: created } })
  return { created }
}

export async function listWarrantyTechVisits(params: { date: string; userId?: string; cursor?: string; pageSize?: number }, orgId?: string) {
  const parsed = warrantyTechQueueSchema.parse(params)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.read", { supabase, orgId: resolvedOrgId, userId })
  const targetUserId = parsed.userId ?? userId
  const cursorScope = { orgId: resolvedOrgId, actorId: userId, userId: targetUserId, date: parsed.date }
  const cursor = decodeWarrantyTechCursor(parsed.cursor, cursorScope)
  const scope = await warrantyDeskReadScope(resolvedOrgId, userId)
  if (scope.divisionIds?.length === 0) return { rows: [], nextCursor: null }
  const start = `${parsed.date}T00:00:00.000Z`, end = new Date(new Date(start).getTime() + 86_400_000).toISOString()
  let query = supabase.from("warranty_service_visits").select(`${VISIT_SELECT},request:warranty_requests(title,description,severity,org_id,project_id,requested_by,requested_by_contact:contacts(full_name,email,phone)),${warrantyDeskProjectSelect("name,location", scope.projectMembershipRequired)}`, { count: "exact" }).eq("org_id", resolvedOrgId).eq("assigned_user_id", targetUserId).gte("window_start", start).lt("window_start", end).neq("status", "canceled")
  query = query.eq("project.org_id", resolvedOrgId)
  if (scope.divisionIds) query = query.in("project.division_id", scope.divisionIds)
  if (scope.projectMembershipRequired) query = query.eq("project.access.org_id", resolvedOrgId).eq("project.access.user_id", userId).eq("project.access.status", "active")
  if (cursor) query = query.or(`window_start.gt."${cursor.window_start}",and(window_start.eq."${cursor.window_start}",id.gt.${cursor.id})`)
  const { data, error, count } = await query.order("window_start").order("id").limit(parsed.pageSize)
  if (error || !Array.isArray(data) || data.length > parsed.pageSize || !Number.isSafeInteger(count) || count! < data.length || (count! > 0 && !data.length)) throw new Error(`Failed to load complete technician queue page: ${error?.message ?? "Page or count unavailable"}`)
  const rows = data.map((value) => {
    const row = value as unknown as Record<string, unknown>, request = relationOne(row.request)
    return { ...mapVisit(row), request: request?.org_id === resolvedOrgId && request.project_id === row.project_id ? request : null, project: relationOne(row.project) }
  })
  const last = rows.at(-1)
  return { rows, nextCursor: count! > rows.length && last ? encodeWarrantyTechCursor(cursorScope, { id: last.id, window_start: last.window_start }) : null }
}

export async function getWarrantyVisitDetail(visitId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.read", { supabase, orgId: resolvedOrgId, userId })
  const identity = await supabase.from("warranty_service_visits").select("id,project_id,request_id,updated_at").eq("org_id", resolvedOrgId).eq("id", visitId).maybeSingle()
  if (identity.error || !identity.data?.project_id || !identity.data?.request_id) throw new Error("Warranty visit not found")
  const revision = warrantyRecordRevisionSchema.safeParse(identity.data)
  if (!revision.success) throw new Error("Warranty visit revision is unavailable; refresh before retrying")
  const existing = { ...identity.data, updated_at: revision.data.updated_at }
  await authorizeWarrantyHome({ supabase, orgId: resolvedOrgId, userId }, existing.project_id, "warranty.read")
  await assertWarrantyRequestHome(supabase, resolvedOrgId, existing.request_id, existing.project_id)
  const { data, error } = await supabase.from("warranty_service_visits").select(`${VISIT_SELECT},request:warranty_requests!inner(title,description,severity,requested_by,requested_by_contact:contacts(full_name,email,phone),photos:warranty_request_photos(id,file_id,caption)),project:projects(name,location)`).eq("org_id", resolvedOrgId).eq("id", visitId).eq("project_id", existing.project_id).eq("request_id", existing.request_id).eq("updated_at", existing.updated_at).eq("request.org_id", resolvedOrgId).eq("request.project_id", existing.project_id).maybeSingle()
  if (error || !data) throw new Error("Warranty visit changed or could not be loaded; refresh before retrying")
  const visitRow = data as unknown as Record<string, unknown>
  return { ...mapVisit(visitRow), updated_at: existing.updated_at, request: relationOne(visitRow.request), project: relationOne(visitRow.project) }
}
