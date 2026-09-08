import type { SupabaseClient } from "@supabase/supabase-js"
import { createServiceSupabaseClient as createBaseServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext as requireBaseOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { getDivisionAccessForUser, getDivisionScopedProjectIds } from "@/lib/services/authorization"
import { intersectProjectReadScopes } from "@/lib/services/authorization-policy"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { insertWithProjectNumberRetry } from "@/lib/services/project-sequence"
import { NotificationService } from "@/lib/services/notifications"
import type { NotificationType } from "@/lib/types/notifications"
import { ensurePortalLink, fetchCompanyContacts, fetchContactEmail } from "@/lib/services/portal-links"
import { escapeHtml, getOrgSenderEmail, renderStandardEmailLayout, sendEmail } from "@/lib/services/mailer"
import { createProjectVendorBill, createProjectVendorCredit } from "@/lib/services/vendor-bills"
import {
  warrantyBackchargeInputSchema,
  warrantyProgramInputSchema,
  warrantyRequestInputSchema,
  warrantyRequestUpdateSchema,
  warrantySlaTargetsSchema,
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
  computeVisitInternalCost,
  dueCourtesyInspections,
  findOverlappingVisits,
  mergeMetadata,
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
  type WarrantySeverity,
  type WarrantyVisitWindow,
} from "@/lib/services/warranty/domain"
import {
  warrantyAcknowledgeSchema,
  warrantyScheduleOverrideSchema,
  warrantyVisitCompleteWithCostSchema,
  warrantyVisitPortalOutcomeSchema,
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

async function canReadProjectInDivisionScope(
  supabase: SupabaseClient,
  orgId: string,
  userId: string,
  projectId: string,
) {
  const authorizedProjectIds = await getDivisionScopedProjectIds({ orgId, userId, supabase })
  return authorizedProjectIds === null || authorizedProjectIds.includes(projectId)
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
  completed_at,completed_by,buyer_signoff_name,buyer_signoff_at,buyer_signature_file_id,
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

async function ensureWarrantyDefaults(supabase: SupabaseClient, orgId: string) {
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
    if (programError || !program) throw new Error(`Failed to seed warranty program: ${programError?.message}`)
    const { error: termsError } = await supabase.from("warranty_coverage_terms").insert(DEFAULT_TERMS_BY_TIER[tier].map((term, index) => ({
      org_id: orgId, program_id: program.id, ...term, sort_order: index,
    })))
    if (termsError) throw new Error(`Failed to seed warranty terms: ${termsError.message}`)
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
  await ensureWarrantyDefaults(supabase, resolvedOrgId)
  const programs = await loadPrograms(supabase, resolvedOrgId)
  // Counted per program rather than by loading coverage rows — an org can have
  // thousands of enrolled homes, and only the tally is shown.
  const counts = await Promise.all(
    programs.map(async (program) => {
      const { count } = await supabase
        .from("project_warranty_coverage")
        .select("id", { count: "exact", head: true })
        .eq("org_id", resolvedOrgId)
        .eq("program_id", program.id)
      return count ?? 0
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
  await supabase.from("warranty_coverage_terms").delete().eq("org_id", resolvedOrgId).eq("program_id", program.id)
  const { error: termsError } = await supabase.from("warranty_coverage_terms").insert(parsed.terms.map((term, index) => ({ org_id: resolvedOrgId, program_id: program.id, ...term, description: term.description ?? null, sort_order: index })))
  if (termsError) throw new Error(`Failed to save warranty terms: ${termsError.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: parsed.id ? "update" : "insert", entityType: "warranty_program", entityId: program.id, after: payload })
  return (await loadPrograms(supabase, resolvedOrgId)).find((candidate) => candidate.id === program.id)!
}

export async function listWarrantySlaTargets(orgId?: string): Promise<WarrantySlaTargetDTO[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.manage", { supabase, orgId: resolvedOrgId, userId })
  await ensureWarrantyDefaults(supabase, resolvedOrgId)
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
  const { data, error } = await supabase.from("project_warranty_coverage").select("project_id,program_id,effective_date,effective_source,terms_snapshot,structural_carrier,structural_policy_number").eq("org_id", orgId).eq("project_id", projectId).maybeSingle()
  if (error) throw new Error(`Failed to load warranty coverage: ${error.message}`)
  if (!data) return null
  const today = new Date().toISOString().slice(0, 10)
  const terms = Array.isArray(data.terms_snapshot) ? data.terms_snapshot as WarrantyCoverageSnapshotTerm[] : []
  return { project_id: data.project_id, program_id: data.program_id, effective_date: data.effective_date, effective_source: data.effective_source, terms: terms.map((term) => ({ ...term, expired: term.expires_on < today })), structural_carrier: data.structural_carrier ?? null, structural_policy_number: data.structural_policy_number ?? null }
}

export async function getProjectWarrantyCoverage(projectId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.read", { supabase, orgId: resolvedOrgId, userId })
  const authorizedProjectIds = await getDivisionScopedProjectIds({ orgId: resolvedOrgId, userId, supabase })
  if (authorizedProjectIds && !authorizedProjectIds.includes(projectId)) return null
  return loadCoverage(supabase, resolvedOrgId, projectId)
}

export async function getProjectWarrantyCoverageForPortal(orgId: string, projectId: string) {
  return loadCoverage(createServiceSupabaseClient(), orgId, projectId)
}

export async function enrollProjectWarrantyCoverage(input: { projectId: string; programId?: string; effectiveDate?: string }, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.manage", { supabase, orgId: resolvedOrgId, userId })
  await ensureWarrantyDefaults(supabase, resolvedOrgId)
  const [{ data: existing }, { data: closing }] = await Promise.all([
    supabase.from("project_warranty_coverage").select("id").eq("org_id", resolvedOrgId).eq("project_id", input.projectId).maybeSingle(),
    supabase.from("closings").select("actual_date,status").eq("org_id", resolvedOrgId).eq("project_id", input.projectId).maybeSingle(),
  ])
  if (existing) throw new Error("This home already has warranty coverage")
  const effectiveDate = input.effectiveDate ?? (closing?.status === "closed" ? closing.actual_date : null)
  if (!effectiveDate) throw new Error("An effective date is required until the home is closed")
  let query = supabase.from("warranty_programs").select("id").eq("org_id", resolvedOrgId).eq("is_active", true)
  query = input.programId ? query.eq("id", input.programId) : query.eq("is_default", true)
  const { data: program } = await query.limit(1).maybeSingle()
  if (!program) throw new Error("Warranty program not found")
  const programs = await loadPrograms(supabase, resolvedOrgId)
  const programDto = programs.find((candidate) => candidate.id === program.id)
  if (!programDto) throw new Error("Warranty program not found")
  const { data, error } = await supabase.from("project_warranty_coverage").insert({
    org_id: resolvedOrgId, project_id: input.projectId, program_id: program.id, effective_date: effectiveDate,
    effective_source: input.effectiveDate ? "manual" : "closing", terms_snapshot: buildCoverageSnapshot(effectiveDate, programDto.terms),
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
  await ensureWarrantyDefaults(supabase, input.orgId)
  const { data: existing } = await supabase.from("project_warranty_coverage").select("id").eq("org_id", input.orgId).eq("project_id", input.projectId).maybeSingle()
  if (existing) return { id: existing.id, enrolled: false }
  const { data: program } = await supabase.from("warranty_programs").select("id").eq("org_id", input.orgId).eq("is_default", true).eq("is_active", true).maybeSingle()
  if (!program) throw new Error("Default warranty program not found")
  const programs = await loadPrograms(supabase, input.orgId), programDto = programs.find((candidate) => candidate.id === program.id)
  if (!programDto) throw new Error("Default warranty program not found")
  const { data, error } = await supabase.from("project_warranty_coverage").insert({ org_id: input.orgId, project_id: input.projectId, program_id: program.id, effective_date: input.effectiveDate, effective_source: input.source, terms_snapshot: buildCoverageSnapshot(input.effectiveDate, programDto.terms) }).select("id").single()
  if (error || !data) throw new Error(`Failed to enroll warranty coverage: ${error?.message}`)
  await recordEvent({ orgId: input.orgId, eventType: "warranty_coverage_enrolled", entityType: "warranty_coverage", entityId: data.id, payload: { project_id: input.projectId, effective_date: input.effectiveDate, source: input.source } })
  return { id: data.id, enrolled: true }
}

async function prepareRequestData(supabase: SupabaseClient, orgId: string, projectId: string, input: WarrantyRequestInput, source: "office" | "buyer_portal" | "mobile") {
  await ensureWarrantyDefaults(supabase, orgId)
  const createdAt = new Date()
  const severity = input.severity ?? "routine_30"
  const [{ data: target }, coverage, { count: openPunchCount }] = await Promise.all([
    supabase.from("warranty_sla_targets").select("first_response_hours,resolution_days").eq("org_id", orgId).eq("severity", severity).maybeSingle(),
    loadCoverage(supabase, orgId, projectId),
    supabase.from("punch_items").select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("project_id", projectId).not("status", "in", '("closed","resolved")'),
  ])
  const sla = stampWarrantySla(createdAt, target ?? DEFAULT_SLAS.find((item) => item.severity === severity)!)
  const costDump = shouldFlagWarrantyCostDump({ createdAt, effectiveDate: coverage?.effective_date ?? null, openPunchCount: openPunchCount ?? 0 })
  return {
    org_id: orgId, project_id: projectId, title: input.title, description: input.description ?? null,
    status: input.status ?? "open", priority: input.priority ?? "normal", severity, category: input.category ?? null,
    cost_code_id: input.cost_code_id ?? null, coverage_term_key: input.coverage_term_key ?? null,
    coverage_status: classifyCoverage(coverage, input.coverage_term_key ?? null, createdAt), source,
    cost_dump_flag: costDump, ...sla,
    metadata: costDump ? { cost_dump_reason: `Created within 60 days of coverage effective date with ${openPunchCount ?? 0} open punch items` } : {},
  }
}

async function attachRequestPhotos(supabase: SupabaseClient, orgId: string, requestId: string, fileIds: string[], userId: string | null) {
  if (fileIds.length === 0) return
  const { error } = await supabase.from("warranty_request_photos").upsert(fileIds.map((fileId) => ({ org_id: orgId, request_id: requestId, file_id: fileId, created_by: userId })), { onConflict: "request_id,file_id" })
  if (error) throw new Error(`Failed to attach warranty photos: ${error.message}`)
}

async function createRequestWithClient(input: WarrantyRequestInput, context: { supabase: SupabaseClient; orgId: string; userId: string | null; contactId?: string | null; source: "office" | "buyer_portal" | "mobile" }) {
  const parsed = warrantyRequestInputSchema.parse(input)
  const payload = await prepareRequestData(context.supabase, context.orgId, parsed.project_id, parsed, context.source)
  const result = await insertWithProjectNumberRetry<Record<string, unknown>>({
    supabase: context.supabase, table: "warranty_requests", numberColumn: "request_number", rpcName: "next_warranty_request_number",
    conflictConstraint: "warranty_requests_project_number_idx", projectId: parsed.project_id,
    payload: { ...payload, requested_by: context.contactId ?? null }, select: WARRANTY_SELECT, entityLabel: "warranty request",
  })
  await attachRequestPhotos(context.supabase, context.orgId, String(result.data.id), parsed.photo_file_ids ?? [], context.userId)
  await recordEvent({ orgId: context.orgId, eventType: "warranty_request_created", entityType: "warranty_request", entityId: String(result.data.id), payload: { project_id: parsed.project_id, title: parsed.title, source: context.source } })
  await recordAudit({ orgId: context.orgId, actorId: context.userId ?? undefined, action: "insert", entityType: "warranty_request", entityId: String(result.data.id), after: result.data })
  return mapWarranty(result.data)
}

export async function listWarrantyRequests(projectId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.read", { supabase, orgId: resolvedOrgId, userId })
  if (!await canReadProjectInDivisionScope(supabase, resolvedOrgId, userId, projectId)) return []
  const { data, error } = await supabase.from("warranty_requests").select(WARRANTY_SELECT).eq("org_id", resolvedOrgId).eq("project_id", projectId).order("created_at", { ascending: false })
  if (error) throw new Error(`Failed to load warranty requests: ${error.message}`)
  return (data ?? []).map((row) => mapWarranty(row as unknown as Record<string, unknown>))
}

export async function createWarrantyRequest({ input, orgId }: { input: WarrantyRequestInput; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.write", { supabase, orgId: resolvedOrgId, userId })
  return createRequestWithClient(input, { supabase, orgId: resolvedOrgId, userId, source: "office" })
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
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.write", { supabase, orgId: resolvedOrgId, userId })
  const { data: existing, error: existingError } = await supabase.from("warranty_requests").select(WARRANTY_SELECT).eq("org_id", resolvedOrgId).eq("id", requestId).maybeSingle()
  if (existingError || !existing) throw new Error("Warranty request not found")
  const current = mapWarranty(existing as unknown as Record<string, unknown>)
  const updates: Record<string, unknown> = {}
  for (const key of ["title","description","priority","category","cost_code_id","coverage_term_key","assigned_company_id","assigned_user_id","scheduled_date","resolution_note","structural_claim","structural_claim_number","structural_claim_submitted_at"] as const) {
    if (parsed[key] !== undefined) updates[key] = parsed[key]
  }
  if (parsed.severity && parsed.severity !== current.severity) {
    const { data: target } = await supabase.from("warranty_sla_targets").select("first_response_hours,resolution_days").eq("org_id", resolvedOrgId).eq("severity", parsed.severity).maybeSingle()
    Object.assign(updates, { severity: parsed.severity, ...stampWarrantySla(new Date(current.created_at), target ?? DEFAULT_SLAS.find((item) => item.severity === parsed.severity)!) })
  }
  if (parsed.coverage_status) {
    const coverage = await loadCoverage(supabase, resolvedOrgId, current.project_id)
    const computed = classifyCoverage(coverage, parsed.coverage_term_key ?? current.coverage_term_key ?? null, new Date())
    if (parsed.coverage_status !== computed && !parsed.coverage_override_reason?.trim()) throw new Error("Coverage override reason is required")
    updates.coverage_status = parsed.coverage_status
    updates.coverage_override_reason = parsed.coverage_status === computed ? null : parsed.coverage_override_reason
  }
  const now = new Date().toISOString()
  if (parsed.assigned_company_id && parsed.assigned_company_id !== current.assigned_company_id) {
    updates.dispatched_at = now
    if ((parsed.status ?? current.status) === "open") updates.status = "in_progress"
  }
  if (parsed.status) {
    updates.status = parsed.status
    updates.closed_at = ["resolved","closed"].includes(parsed.status) ? now : null
  }
  const { data, error } = await supabase.from("warranty_requests").update(updates).eq("org_id", resolvedOrgId).eq("id", requestId).select(WARRANTY_SELECT).single()
  if (error || !data) throw new Error(`Failed to update warranty request: ${error?.message}`)
  const updatedRow = data as unknown as Record<string, unknown>
  await recordEvent({ orgId: resolvedOrgId, eventType: "warranty_request_updated", entityType: "warranty_request", entityId: requestId, payload: { project_id: current.project_id, status: updatedRow.status } })
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "warranty_request", entityId: requestId, before: existing as unknown as Record<string, unknown>, after: updatedRow })
  const updated = mapWarranty(updatedRow)
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
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.write", { supabase, orgId: resolvedOrgId, userId })
  const { data: existing, error: existingError } = await supabase.from("warranty_requests").select(WARRANTY_SELECT).eq("org_id", resolvedOrgId).eq("id", parsed.request_id).maybeSingle()
  if (existingError || !existing) throw new Error("Warranty request not found")
  const current = mapWarranty(existing as unknown as Record<string, unknown>)
  if (current.first_responded_at) return current
  const now = new Date().toISOString()
  const { data, error } = await supabase.from("warranty_requests").update({
    first_responded_at: now,
    metadata: mergeMetadata(current.metadata, {
      first_response_channel: parsed.channel,
      first_response_note: parsed.note?.trim() || null,
      first_response_by: userId,
      first_response_breached_at: undefined,
    }),
  }).eq("org_id", resolvedOrgId).eq("id", parsed.request_id).is("first_responded_at", null).select(WARRANTY_SELECT).maybeSingle()
  if (error) throw new Error(`Failed to record first response: ${error.message}`)
  if (!data) return current
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
  const authorizedProjectIds = await getDivisionScopedProjectIds({ orgId: resolvedOrgId, userId, supabase })
  const divisionProjectIds = params.divisionId ? await projectIdsForDivision(supabase, resolvedOrgId, params.divisionId) : null
  const scopedProjectIds = intersectProjectReadScopes(authorizedProjectIds, divisionProjectIds)
  if (scopedProjectIds?.length === 0) return { rows: [], total: 0 }
  const page = Math.max(1, params.page ?? 1), pageSize = Math.min(200, Math.max(1, params.pageSize ?? 50))
  const lotRelation = params.communityId
    ? "lot:lots!lots_project_id_fkey!inner(community_id,community:communities(name))"
    : "lot:lots!lots_project_id_fkey(community_id,community:communities(name))"
  let query = supabase.from("warranty_requests").select(`${WARRANTY_SELECT},project:projects!inner(name),${lotRelation}`, { count: "exact" }).eq("org_id", resolvedOrgId)
  if (params.status?.length) query = query.in("status", params.status)
  if (params.severity?.length) query = query.in("severity", params.severity)
  if (params.assignedUserId) query = query.eq("assigned_user_id", params.assignedUserId)
  if (params.companyId) query = query.eq("assigned_company_id", params.companyId)
  if (params.communityId) query = query.eq("lot.community_id", params.communityId)
  if (scopedProjectIds) query = query.in("project_id", scopedProjectIds)
  if (params.coverageStatus?.length) query = query.in("coverage_status", params.coverageStatus)
  const nowIso = new Date().toISOString()
  const openStatuses = ["open", "in_progress"]
  if (params.slaState === "breached") query = query.lt("resolution_due_at", nowIso).in("status", openStatuses)
  if (params.slaState === "due_soon") query = query.gte("resolution_due_at", nowIso).lte("resolution_due_at", new Date(Date.now() + 3 * 86_400_000).toISOString()).in("status", openStatuses)
  // First response is its own promise to the homeowner and breaches on its own
  // clock, so it filters independently of the resolution target.
  if (params.slaState === "first_response_breached") query = query.is("first_responded_at", null).lt("first_response_due_at", nowIso).in("status", openStatuses)
  if (params.slaState === "first_response_due_soon") query = query.is("first_responded_at", null).gte("first_response_due_at", nowIso).lte("first_response_due_at", new Date(Date.now() + 12 * 3_600_000).toISOString()).in("status", openStatuses)
  if (params.slaState === "awaiting_first_response") query = query.is("first_responded_at", null).in("status", openStatuses)
  if (params.search?.trim()) query = query.or(`title.ilike.%${params.search.trim()}%,description.ilike.%${params.search.trim()}%`)
  const orderColumn = params.slaState?.startsWith("first_response") || params.slaState === "awaiting_first_response" ? "first_response_due_at" : "resolution_due_at"
  const { data, error, count } = await query.order(orderColumn, { ascending: true, nullsFirst: false }).range((page - 1) * pageSize, page * pageSize - 1)
  if (error) throw new Error(`Failed to load warranty desk: ${error.message}`)
  const rows = (data ?? []).map((row) => {
    const mapped = mapWarranty(row as unknown as Record<string, unknown>), project = relationOne((row as unknown as Record<string, unknown>).project), lot = relationOne((row as unknown as Record<string, unknown>).lot), community = relationOne(lot?.community)
    return { ...mapped, project_name: typeof project?.name === "string" ? project.name : null, community_id: typeof lot?.community_id === "string" ? lot.community_id : null, community_name: typeof community?.name === "string" ? community.name : null }
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
  return mapVisit(data as unknown as Record<string, unknown>)
}

async function sendVisitAppointmentEmail(orgId: string, request: WarrantyRequest, visit: WarrantyServiceVisitDTO) {
  if (!request.requested_by) return
  const { supabase, org, project } = await loadWarrantyEmailContext(orgId, request.project_id)
  const contact = await fetchContactEmail(supabase, request.requested_by)
  if (!contact?.email) return
  const windowText = `${new Date(visit.window_start).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })} – ${new Date(visit.window_end).toLocaleTimeString("en-US", { timeStyle: "short" })}`
  const html = renderStandardEmailLayout({
    title: "Warranty appointment scheduled",
    messageHtml: `<p>${contact.full_name ? `Hi ${escapeHtml(contact.full_name)},` : "Hi,"}</p><p>Service for <strong>${escapeHtml(request.title)}</strong>${project?.name ? ` at ${escapeHtml(project.name)}` : ""} is scheduled for <strong>${escapeHtml(windowText)}</strong>.</p>`,
    orgName: org?.name ?? null, orgLogoUrl: org?.logo_url ?? null, showManageSettings: false,
  })
  await sendEmail({ to: [contact.email], subject: `Warranty appointment — ${request.title}`, html, from: getOrgSenderEmail(org?.slug, org?.name) })
}

async function sendWarrantyVisitDispatchEmail(input: { orgId: string; request: WarrantyRequest; visit: WarrantyServiceVisitDTO; createdBy: string | null }) {
  if (!input.visit.assigned_company_id) return
  const { supabase, org, project } = await loadWarrantyEmailContext(input.orgId, input.request.project_id)
  const [contacts, portalUrl] = await Promise.all([
    fetchCompanyContacts(supabase, input.orgId, input.visit.assigned_company_id),
    ensurePortalLink({ supabase, orgId: input.orgId, projectId: input.request.project_id, portalType: "sub", companyId: input.visit.assigned_company_id, createdBy: input.createdBy, capabilities: { can_view_punch_items: true }, fallbackPath: `/s` }),
  ])
  const recipients = contacts.map((contact) => contact.email).filter((email): email is string => Boolean(email))
  if (recipients.length === 0) return
  const windowText = `${new Date(input.visit.window_start).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })} – ${new Date(input.visit.window_end).toLocaleTimeString("en-US", { timeStyle: "short" })}`
  const location = (project?.location as { address?: string } | null)?.address
  const html = renderStandardEmailLayout({ title: `Warranty service request: ${input.request.title}`, messageHtml: `<p>You have been assigned warranty service${project?.name ? ` on <strong>${escapeHtml(project.name)}</strong>` : ""}.</p>${input.request.description ? `<p style="white-space:pre-wrap;">${escapeHtml(input.request.description)}</p>` : ""}<p>Window: <strong>${escapeHtml(windowText)}</strong>${location ? `<br/>Address: ${escapeHtml(location)}` : ""}</p><p><a href="${portalUrl}" style="display:inline-block;padding:10px 16px;background:#111827;color:#ffffff;text-decoration:none;">Confirm appointment</a></p>`, orgName: org?.name ?? null, orgLogoUrl: org?.logo_url ?? null, showManageSettings: false })
  await sendEmail({ to: recipients, subject: `Warranty service${project?.name ? ` — ${project.name}` : ""}: ${input.request.title}`, html, from: getOrgSenderEmail(org?.slug, org?.name) })
  await recordEvent({ orgId: input.orgId, eventType: "warranty_request_dispatched", entityType: "warranty_request", entityId: input.request.id, payload: { company_id: input.visit.assigned_company_id, visit_id: input.visit.id, recipients: recipients.length } })
}

export async function listWarrantyVisitsForProject(projectId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.read", { supabase, orgId: resolvedOrgId, userId })
  if (!await canReadProjectInDivisionScope(supabase, resolvedOrgId, userId, projectId)) return []
  const { data, error } = await supabase.from("warranty_service_visits").select(VISIT_SELECT).eq("org_id", resolvedOrgId).eq("project_id", projectId).order("window_start", { ascending: false })
  if (error) throw new Error(`Failed to load warranty visits: ${error.message}`)
  return (data ?? []).map((row) => mapVisit(row as unknown as Record<string, unknown>))
}

export async function listWarrantyVisitsForDispatch(params: { from: string; to: string; divisionId?: string; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(params.orgId)
  await requirePermission("warranty.read", { supabase, orgId: resolvedOrgId, userId })
  const authorizedProjectIds = await getDivisionScopedProjectIds({ orgId: resolvedOrgId, userId, supabase })
  const divisionProjectIds = params.divisionId ? await projectIdsForDivision(supabase, resolvedOrgId, params.divisionId) : null
  const scopedProjectIds = intersectProjectReadScopes(authorizedProjectIds, divisionProjectIds)
  if (scopedProjectIds?.length === 0) return []
  let query = supabase.from("warranty_service_visits").select(`${VISIT_SELECT},request:warranty_requests(title,severity),project:projects(name,location)`).eq("org_id", resolvedOrgId).gte("window_start", params.from).lt("window_start", params.to).neq("status", "canceled")
  if (scopedProjectIds) query = query.in("project_id", scopedProjectIds)
  const { data, error } = await query.order("window_start")
  if (error) throw new Error(`Failed to load dispatch board: ${error.message}`)
  return (data ?? []).map((row) => ({ ...mapVisit(row as unknown as Record<string, unknown>), request: relationOne((row as unknown as Record<string, unknown>).request), project: relationOne((row as unknown as Record<string, unknown>).project) }))
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
): Promise<Array<WarrantyVisitWindow & WarrantyVisitConflict>> {
  // A conflicting visit must start before this one ends and end after it starts;
  // the day-wide prefilter keeps the scan off the whole calendar.
  const dayBefore = new Date(new Date(window.start).getTime() - 86_400_000).toISOString()
  const column = assignee.kind === "tech" ? "assigned_user_id" : "assigned_company_id"
  const { data, error } = await supabase
    .from("warranty_service_visits")
    .select("id,request_id,project_id,visit_number,window_start,window_end")
    .eq("org_id", orgId)
    .eq(column, assignee.id)
    .not("status", "in", '("canceled","completed")')
    .gte("window_start", dayBefore)
    .lt("window_start", window.end)
    .limit(200)
  if (error) throw new Error(`Failed to check technician availability: ${error.message}`)
  return (data ?? []).map((row) => ({
    id: String(row.id), visit_id: String(row.id), request_id: String(row.request_id),
    project_id: String(row.project_id), visit_number: Number(row.visit_number),
    window_start: String(row.window_start), window_end: String(row.window_end),
  }))
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
  const assigneeId = input.assignee_kind === "tech" ? input.assigned_user_id : input.assigned_company_id
  if (!assigneeId) return []
  const candidates = await loadAssigneeVisitWindows(supabase, resolvedOrgId, { kind: input.assignee_kind, id: assigneeId }, { start: input.window_start, end: input.window_end })
  return findOverlappingVisits(candidates, { window_start: input.window_start, window_end: input.window_end, exclude_visit_id: input.exclude_visit_id })
}

export async function scheduleWarrantyVisit(input: WarrantyVisitScheduleInput & { allow_conflict?: boolean }, orgId?: string) {
  const parsed = warrantyVisitScheduleSchema.parse(input)
  const { allow_conflict: allowConflict } = warrantyScheduleOverrideSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.write", { supabase, orgId: resolvedOrgId, userId })
  const { data: requestRow } = await supabase.from("warranty_requests").select(WARRANTY_SELECT).eq("org_id", resolvedOrgId).eq("id", parsed.request_id).maybeSingle()
  if (!requestRow) throw new Error("Warranty request not found")
  const request = mapWarranty(requestRow as unknown as Record<string, unknown>)
  const assigneeId = parsed.assignee_kind === "tech" ? parsed.assigned_user_id : parsed.assigned_company_id
  if (!allowConflict && assigneeId) {
    const candidates = await loadAssigneeVisitWindows(supabase, resolvedOrgId, { kind: parsed.assignee_kind, id: assigneeId }, { start: parsed.window_start, end: parsed.window_end })
    const [conflict] = findOverlappingVisits(candidates, { window_start: parsed.window_start, window_end: parsed.window_end })
    if (conflict) {
      throw new Error(`This assignee is already booked for visit ${conflict.visit_number} from ${new Date(conflict.window_start).toLocaleString("en-US")} to ${new Date(conflict.window_end).toLocaleTimeString("en-US")}`)
    }
  }
  const { data: last } = await supabase.from("warranty_service_visits").select("visit_number").eq("org_id", resolvedOrgId).eq("request_id", parsed.request_id).order("visit_number", { ascending: false }).limit(1).maybeSingle()
  const { data, error } = await supabase.from("warranty_service_visits").insert({
    org_id: resolvedOrgId, request_id: parsed.request_id, project_id: request.project_id,
    visit_number: (last?.visit_number ?? 0) + 1, assignee_kind: parsed.assignee_kind,
    assigned_user_id: parsed.assignee_kind === "tech" ? parsed.assigned_user_id : null,
    assigned_company_id: parsed.assignee_kind === "trade" ? parsed.assigned_company_id : null,
    window_start: parsed.window_start, window_end: parsed.window_end,
    metadata: parsed.note ? { schedule_note: parsed.note } : {},
  }).select(VISIT_SELECT).single()
  if (error || !data) throw new Error(`Failed to schedule warranty visit: ${error?.message}`)
  const now = new Date().toISOString()
  // Assignment belongs to the visit. Recording who is going out on visit 2 must
  // not erase who owned visit 1, so the request keeps the most recent assignee
  // of each kind rather than nulling the kind that was not chosen. Dispatching
  // is also not a first response — that is an explicit call to the homeowner.
  await supabase.from("warranty_requests").update({
    status: "in_progress",
    ...(parsed.assignee_kind === "tech" ? { assigned_user_id: parsed.assigned_user_id } : { assigned_company_id: parsed.assigned_company_id, dispatched_at: now }),
    scheduled_date: parsed.window_start.slice(0, 10),
  }).eq("org_id", resolvedOrgId).eq("id", parsed.request_id)
  const visit = mapVisit(data as unknown as Record<string, unknown>)
  await recordEvent({ orgId: resolvedOrgId, eventType: "warranty_visit_scheduled", entityType: "warranty_service_visit", entityId: visit.id, payload: { request_id: request.id, project_id: request.project_id, assignee_kind: visit.assignee_kind } })
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "warranty_service_visit", entityId: visit.id, after: data as unknown as Record<string, unknown> })
  const notifications = new NotificationService()
  await Promise.allSettled([
    visit.assigned_user_id ? notifications.createAndQueue({ orgId: resolvedOrgId, userId: visit.assigned_user_id, type: "warranty_visit_assigned", title: "Warranty visit assigned", message: `${request.title} has been added to your service schedule.`, projectId: request.project_id, entityType: "warranty_service_visit", entityId: visit.id }) : Promise.resolve(),
    sendVisitAppointmentEmail(resolvedOrgId, request, visit),
    visit.assignee_kind === "trade" ? sendWarrantyVisitDispatchEmail({ orgId: resolvedOrgId, request, visit, createdBy: userId }) : Promise.resolve(),
  ])
  return visit
}

export async function rescheduleWarrantyVisit(input: unknown, orgId?: string) {
  const parsed = warrantyVisitRescheduleSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.write", { supabase, orgId: resolvedOrgId, userId })
  const existing = await loadVisit(supabase, resolvedOrgId, parsed.visit_id)
  if (["completed","canceled"].includes(existing.status)) throw new Error("Completed or canceled visits cannot be rescheduled")
  const { data, error } = await supabase.from("warranty_service_visits").update({ window_start: parsed.window_start, window_end: parsed.window_end, status: "scheduled", confirmed_at: null, metadata: mergeMetadata(existing.metadata, { reschedule_note: parsed.note ?? null }) }).eq("org_id", resolvedOrgId).eq("id", parsed.visit_id).select(VISIT_SELECT).single()
  if (error || !data) throw new Error(`Failed to reschedule warranty visit: ${error?.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "warranty_service_visit", entityId: parsed.visit_id, before: existing as unknown as Record<string, unknown>, after: data as unknown as Record<string, unknown> })
  return mapVisit(data as unknown as Record<string, unknown>)
}

export async function cancelWarrantyVisit(visitId: string, note?: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.write", { supabase, orgId: resolvedOrgId, userId })
  const existing = await loadVisit(supabase, resolvedOrgId, visitId)
  if (existing.status === "completed") throw new Error("Completed visits cannot be canceled")
  const { data, error } = await supabase.from("warranty_service_visits").update({ status: "canceled", metadata: mergeMetadata(existing.metadata, { cancel_note: note ?? null }) }).eq("org_id", resolvedOrgId).eq("id", visitId).select(VISIT_SELECT).single()
  if (error || !data) throw new Error(`Failed to cancel warranty visit: ${error?.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "warranty_service_visit", entityId: visitId, before: existing as unknown as Record<string, unknown>, after: data as unknown as Record<string, unknown> })
  return mapVisit(data as unknown as Record<string, unknown>)
}

async function loadRequestMetadata(supabase: SupabaseClient, orgId: string, requestId: string) {
  const { data, error } = await supabase.from("warranty_requests").select("metadata").eq("org_id", orgId).eq("id", requestId).maybeSingle()
  if (error) throw new Error(`Failed to load warranty request: ${error.message}`)
  return data?.metadata ?? {}
}

async function completeVisitWithClient(input: WarrantyVisitCompleteWithCostInput, context: { supabase: SupabaseClient; orgId: string; userId: string | null; portalCompanyId?: string; portalTokenId?: string }) {
  const parsed = warrantyVisitCompleteWithCostSchema.parse(input)
  const existing = await loadVisit(context.supabase, context.orgId, parsed.visit_id)
  if (context.portalCompanyId && (existing.assignee_kind !== "trade" || existing.assigned_company_id !== context.portalCompanyId)) throw new Error("Warranty visit not found")
  if (["completed","canceled"].includes(existing.status)) throw new Error(`This visit is already ${existing.status}`)
  const cost = computeVisitInternalCost({ labor_hours: parsed.labor_hours, labor_rate_cents: parsed.labor_rate_cents, material_cents: parsed.material_cents })
  const now = new Date().toISOString(), pendingVerification = Boolean(context.portalCompanyId)
  const { data, error } = await context.supabase.from("warranty_service_visits").update({
    status: "completed", outcome: parsed.outcome, outcome_note: parsed.outcome_note ?? null, completed_at: now,
    completed_by: context.userId, buyer_signoff_name: parsed.buyer_signoff_name ?? null,
    buyer_signoff_at: parsed.buyer_signoff_name ? now : null, buyer_signature_file_id: parsed.buyer_signature_file_id ?? null,
    labor_hours: cost.labor_hours, labor_rate_cents: cost.labor_rate_cents,
    internal_labor_cents: cost.internal_labor_cents, internal_material_cents: cost.internal_material_cents,
    metadata: mergeMetadata(existing.metadata, { portal_token_id: context.portalTokenId ?? null }),
  }).eq("org_id", context.orgId).eq("id", parsed.visit_id).select(VISIT_SELECT).single()
  if (error || !data) throw new Error(`Failed to complete warranty visit: ${error?.message}`)
  if (parsed.photo_file_ids?.length) {
    const { error: photoError } = await context.supabase.from("warranty_visit_photos").upsert(parsed.photo_file_ids.map((fileId) => ({ org_id: context.orgId, visit_id: parsed.visit_id, file_id: fileId, created_by: context.userId })), { onConflict: "visit_id,file_id" })
    if (photoError) throw new Error(`Failed to attach visit photos: ${photoError.message}`)
  }
  const requestMetadata = await loadRequestMetadata(context.supabase, context.orgId, existing.request_id)
  const requestUpdate = pendingVerification
    ? { status: "in_progress", metadata: mergeMetadata(requestMetadata, { pending_verification: true, completed_visit_id: parsed.visit_id }) }
    : parsed.outcome === "resolved"
      ? { status: "resolved", closed_at: now, metadata: mergeMetadata(requestMetadata, { pending_verification: false, completed_visit_id: parsed.visit_id }) }
      : { status: "in_progress", metadata: mergeMetadata(requestMetadata, { completed_visit_id: parsed.visit_id }) }
  await context.supabase.from("warranty_requests").update(requestUpdate).eq("org_id", context.orgId).eq("id", existing.request_id)
  await recordEvent({ orgId: context.orgId, eventType: "warranty_visit_completed", entityType: "warranty_service_visit", entityId: parsed.visit_id, payload: { request_id: existing.request_id, outcome: parsed.outcome, pending_verification: pendingVerification, internal_cost_cents: cost.internal_total_cents } })
  await recordAudit({ orgId: context.orgId, actorId: context.userId ?? undefined, action: "update", entityType: "warranty_service_visit", entityId: parsed.visit_id, before: existing as unknown as Record<string, unknown>, after: data as unknown as Record<string, unknown> })
  return mapVisit(data as unknown as Record<string, unknown>)
}

export async function completeWarrantyVisit(input: WarrantyVisitCompleteWithCostInput, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.write", { supabase, orgId: resolvedOrgId, userId })
  return completeVisitWithClient(input, { supabase, orgId: resolvedOrgId, userId })
}

/**
 * A trade reporting its own work done is a claim, not a closure. These are the
 * requests still holding `pending_verification` — the office queue that closes
 * the loop on a portal completion.
 */
export async function listWarrantyVisitsPendingVerification(params: { divisionId?: string; limit?: number; orgId?: string } = {}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(params.orgId)
  await requirePermission("warranty.read", { supabase, orgId: resolvedOrgId, userId })
  const authorizedProjectIds = await getDivisionScopedProjectIds({ orgId: resolvedOrgId, userId, supabase })
  const divisionProjectIds = params.divisionId ? await projectIdsForDivision(supabase, resolvedOrgId, params.divisionId) : null
  const scopedProjectIds = intersectProjectReadScopes(authorizedProjectIds, divisionProjectIds)
  if (scopedProjectIds?.length === 0) return []
  const limit = Math.min(200, Math.max(1, params.limit ?? 50))
  let requestQuery = supabase.from("warranty_requests").select("id,project_id,request_number,title,severity,metadata,project:projects(name)").eq("org_id", resolvedOrgId).eq("metadata->>pending_verification", "true").in("status", ["open", "in_progress"])
  if (scopedProjectIds) requestQuery = requestQuery.in("project_id", scopedProjectIds)
  const { data: requests, error: requestError } = await requestQuery.order("updated_at", { ascending: true }).limit(limit)
  if (requestError) throw new Error(`Failed to load visits awaiting verification: ${requestError.message}`)
  const byVisitId = new Map<string, Record<string, unknown>>()
  for (const request of requests ?? []) {
    const metadata = request.metadata && typeof request.metadata === "object" ? request.metadata as Record<string, unknown> : {}
    if (typeof metadata.completed_visit_id === "string") byVisitId.set(metadata.completed_visit_id, request as unknown as Record<string, unknown>)
  }
  if (byVisitId.size === 0) return []
  const { data: visits, error: visitError } = await supabase.from("warranty_service_visits").select(VISIT_SELECT).eq("org_id", resolvedOrgId).eq("status", "completed").in("id", Array.from(byVisitId.keys())).order("completed_at", { ascending: true })
  if (visitError) throw new Error(`Failed to load visits awaiting verification: ${visitError.message}`)
  return (visits ?? []).map((row) => {
    const visit = mapVisit(row as unknown as Record<string, unknown>)
    const request = byVisitId.get(visit.id)
    return { ...visit, request: request ?? null, project: relationOne(request?.project) }
  })
}

export async function verifyWarrantyVisit(visitId: string, resolutionNote?: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.write", { supabase, orgId: resolvedOrgId, userId })
  const visit = await loadVisit(supabase, resolvedOrgId, visitId)
  if (visit.status !== "completed") throw new Error("Only completed visits can be verified")
  const now = new Date().toISOString(), resolved = visit.outcome === "resolved"
  const requestMetadata = await loadRequestMetadata(supabase, resolvedOrgId, visit.request_id)
  const { data: updatedRequest, error } = await supabase.from("warranty_requests").update({
    status: resolved ? "resolved" : "in_progress",
    closed_at: resolved ? now : null,
    ...(resolutionNote?.trim() ? { resolution_note: resolutionNote.trim() } : {}),
    metadata: mergeMetadata(requestMetadata, { pending_verification: false, verified_visit_id: visitId, verified_by: userId, verified_at: now }),
  }).eq("org_id", resolvedOrgId).eq("id", visit.request_id).select(WARRANTY_SELECT).single()
  if (error || !updatedRequest) throw new Error(`Failed to verify warranty visit: ${error?.message}`)
  await recordEvent({ orgId: resolvedOrgId, eventType: "warranty_visit_verified", entityType: "warranty_service_visit", entityId: visitId, payload: { request_id: visit.request_id, resolved } })
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "warranty_request", entityId: visit.request_id, after: { pending_verification: false, visit_id: visitId, resolved } })
  // Verification is what actually closes a request, so it owes the homeowner the
  // same note the office path sends.
  if (resolved) await sendWarrantyResolvedEmail(resolvedOrgId, mapWarranty(updatedRequest as unknown as Record<string, unknown>))
  return visit
}

export async function listWarrantyVisitsForCompanyPortal({ orgId, companyId, projectId }: { orgId: string; companyId: string; projectId?: string }) {
  const supabase = createServiceSupabaseClient()
  let query = supabase.from("warranty_service_visits").select(`${VISIT_SELECT},request:warranty_requests(title,description,severity),project:projects(name,location)`).eq("org_id", orgId).eq("assigned_company_id", companyId).neq("status", "canceled")
  if (projectId) query = query.eq("project_id", projectId)
  const { data, error } = await query.order("window_start")
  if (error) throw new Error(`Failed to load warranty appointments: ${error.message}`)
  return (data ?? []).map((row) => ({ ...mapVisit(row as unknown as Record<string, unknown>), request: relationOne((row as unknown as Record<string, unknown>).request), project: relationOne((row as unknown as Record<string, unknown>).project) }))
}

export async function listWarrantyVisitsForBuyerPortal(orgId: string, projectId: string) {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase.from("warranty_service_visits").select(VISIT_SELECT).eq("org_id", orgId).eq("project_id", projectId).neq("status", "canceled").order("window_start", { ascending: false }).limit(100)
  if (error) throw new Error(`Failed to load warranty appointments: ${error.message}`)
  return (data ?? []).map((row) => mapVisit(row as unknown as Record<string, unknown>))
}

export async function confirmWarrantyVisitFromPortal({ orgId, companyId, visitId }: { orgId: string; companyId: string; visitId: string }) {
  const supabase = createServiceSupabaseClient(), existing = await loadVisit(supabase, orgId, visitId)
  if (existing.assigned_company_id !== companyId || existing.assignee_kind !== "trade") throw new Error("Warranty visit not found")
  if (existing.status !== "scheduled") throw new Error("Only scheduled visits can be confirmed")
  const now = new Date().toISOString()
  const { data, error } = await supabase.from("warranty_service_visits").update({ status: "confirmed", confirmed_at: now }).eq("org_id", orgId).eq("id", visitId).select(VISIT_SELECT).single()
  if (error || !data) throw new Error(`Failed to confirm warranty visit: ${error?.message}`)
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
  if (visit.buyer_signoff_at) return visit
  const now = new Date().toISOString()
  const { data, error } = await supabase.from("warranty_service_visits").update({ buyer_signoff_name: input.name.trim(), buyer_signoff_at: now, buyer_signature_file_id: input.signatureFileId ?? null }).eq("org_id", input.orgId).eq("id", input.visitId).select(VISIT_SELECT).single()
  if (error || !data) throw new Error(`Failed to record buyer sign-off: ${error?.message}`)
  await recordEvent({ orgId: input.orgId, eventType: "warranty_request_signoff", entityType: "warranty_service_visit", entityId: input.visitId, payload: { request_id: visit.request_id } })
  return mapVisit(data as unknown as Record<string, unknown>)
}

const BACKCHARGE_SELECT = `id,org_id,project_id,warranty_request_id,company_id,commitment_id,cost_code_id,backcharge_number,status,amount_cents,recovered_cents,reason,cost_basis,vendor_credit_bill_id,issued_at,disputed_at,dispute_note,resolved_at,notes,metadata,created_at,updated_at,company:companies(name),project:projects(name)`

async function loadBackcharge(supabase: SupabaseClient, orgId: string, backchargeId: string) {
  const { data, error } = await supabase.from("warranty_backcharges").select(BACKCHARGE_SELECT).eq("org_id", orgId).eq("id", backchargeId).maybeSingle()
  if (error || !data) throw new Error("Warranty backcharge not found")
  return { dto: mapBackcharge(data as unknown as Record<string, unknown>), row: data as unknown as Record<string, unknown> }
}

export async function listWarrantyBackcharges(params: { status?: string[]; projectId?: string; divisionId?: string; page?: number; pageSize?: number; orgId?: string } = {}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(params.orgId)
  await requirePermission("warranty.read", { supabase, orgId: resolvedOrgId, userId })
  const authorizedProjectIds = await getDivisionScopedProjectIds({ orgId: resolvedOrgId, userId, supabase })
  const divisionProjectIds = params.divisionId ? await projectIdsForDivision(supabase, resolvedOrgId, params.divisionId) : null
  const scopedProjectIds = intersectProjectReadScopes(authorizedProjectIds, divisionProjectIds)
  if (scopedProjectIds?.length === 0) return { rows: [], total: 0 }
  const page = Math.max(1, params.page ?? 1), pageSize = Math.min(200, Math.max(1, params.pageSize ?? 50))
  let query = supabase.from("warranty_backcharges").select(BACKCHARGE_SELECT, { count: "exact" }).eq("org_id", resolvedOrgId)
  if (params.status?.length) query = query.in("status", params.status)
  if (params.projectId) query = query.eq("project_id", params.projectId)
  if (scopedProjectIds) query = query.in("project_id", scopedProjectIds)
  const { data, error, count } = await query.order("created_at", { ascending: false }).range((page - 1) * pageSize, page * pageSize - 1)
  if (error) throw new Error(`Failed to load warranty backcharges: ${error.message}`)
  return { rows: (data ?? []).map((row) => mapBackcharge(row as unknown as Record<string, unknown>)), total: count ?? 0 }
}

export async function createWarrantyBackcharge(input: WarrantyBackchargeInput, orgId?: string) {
  const parsed = warrantyBackchargeInputSchema.parse(input)
  validateWarrantyCostBasis(parsed.amount_cents, parsed.cost_basis)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.backcharge", { supabase, orgId: resolvedOrgId, userId })
  const [{ data: request }, { data: company }, { data: commitment }] = await Promise.all([
    supabase.from("warranty_requests").select("id,project_id").eq("org_id", resolvedOrgId).eq("id", parsed.warranty_request_id).maybeSingle(),
    supabase.from("companies").select("id").eq("org_id", resolvedOrgId).eq("id", parsed.company_id).maybeSingle(),
    parsed.commitment_id ? supabase.from("commitments").select("id,project_id,company_id").eq("org_id", resolvedOrgId).eq("id", parsed.commitment_id).maybeSingle() : Promise.resolve({ data: null }),
  ])
  if (!request || request.project_id !== parsed.project_id) throw new Error("Warranty request not found")
  if (!company) throw new Error("Trade company not found")
  if (parsed.commitment_id && (!commitment || commitment.project_id !== parsed.project_id)) throw new Error("Originating commitment not found")
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

export async function issueWarrantyBackcharge({ backchargeId }: { backchargeId: string }, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await Promise.all([
    requirePermission("warranty.backcharge", { supabase, orgId: resolvedOrgId, userId }),
    requirePermission("bill.write", { supabase, orgId: resolvedOrgId, userId }),
  ])
  const { dto: existing, row } = await loadBackcharge(supabase, resolvedOrgId, backchargeId)
  assertBackchargeTransition(existing.status, "issued")
  const { count: payableCount } = await supabase.from("vendor_bills").select("id", { count: "exact", head: true }).eq("org_id", resolvedOrgId).eq("company_id", existing.company_id)
  if ((payableCount ?? 0) === 0 && (row.metadata as unknown as Record<string, unknown> | null)?.no_ap_history_confirmed !== true) {
    throw new Error("This trade has no AP history. Confirm recoverability before issuing the backcharge.")
  }
  const credit = await createProjectVendorCredit({
    projectId: existing.project_id, companyId: existing.company_id, commitmentId: existing.commitment_id,
    billNumber: `WB-${existing.backcharge_number}`, billDate: new Date().toISOString().slice(0, 10),
    description: existing.reason, lines: existing.cost_basis.map((item) => ({ description: item.label, amount_cents: -item.amount_cents, cost_code_id: existing.cost_code_id })),
    metadata: { origin: "warranty_backcharge", warranty_backcharge_id: existing.id, warranty_request_id: existing.warranty_request_id, commitment_id: existing.commitment_id },
  }, resolvedOrgId)
  const now = new Date().toISOString()
  const { data, error } = await supabase.from("warranty_backcharges").update({ status: "issued", vendor_credit_bill_id: credit.id, issued_at: now, issued_by: userId }).eq("org_id", resolvedOrgId).eq("id", backchargeId).select(BACKCHARGE_SELECT).single()
  if (error || !data) throw new Error(`Failed to issue warranty backcharge: ${error?.message}`)
  const issued = mapBackcharge(data as unknown as Record<string, unknown>)
  await recordEvent({ orgId: resolvedOrgId, eventType: "warranty_backcharge_issued", entityType: "warranty_backcharge", entityId: backchargeId, payload: { vendor_credit_bill_id: credit.id, amount_cents: issued.amount_cents } })
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "warranty_backcharge", entityId: backchargeId, before: row, after: data })
  await sendBackchargeNotice(resolvedOrgId, issued)
  return issued
}

export async function disputeWarrantyBackcharge({ backchargeId, note }: { backchargeId: string; note: string }, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.backcharge", { supabase, orgId: resolvedOrgId, userId })
  const { dto: existing, row } = await loadBackcharge(supabase, resolvedOrgId, backchargeId)
  assertBackchargeTransition(existing.status, "disputed")
  const { data, error } = await supabase.from("warranty_backcharges").update({ status: "disputed", disputed_at: new Date().toISOString(), dispute_note: note.trim() }).eq("org_id", resolvedOrgId).eq("id", backchargeId).select(BACKCHARGE_SELECT).single()
  if (error || !data) throw new Error(`Failed to dispute warranty backcharge: ${error?.message}`)
  await recordEvent({ orgId: resolvedOrgId, eventType: "warranty_backcharge_disputed", entityType: "warranty_backcharge", entityId: backchargeId, payload: { note: note.trim() } })
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "warranty_backcharge", entityId: backchargeId, before: row, after: data })
  return mapBackcharge(data as unknown as Record<string, unknown>)
}

export async function resolveWarrantyBackcharge({ backchargeId, resolution, recoveredCents, note }: { backchargeId: string; resolution: "recovered" | "written_off" | "waived"; recoveredCents?: number; note?: string }, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.backcharge", { supabase, orgId: resolvedOrgId, userId })
  const { dto: existing, row } = await loadBackcharge(supabase, resolvedOrgId, backchargeId)
  assertBackchargeTransition(existing.status, resolution)
  if (resolution !== "recovered" && !note?.trim()) throw new Error("A resolution note is required")
  const recovered = recoveredCents ?? (resolution === "recovered" ? existing.amount_cents : existing.recovered_cents)
  if (!Number.isInteger(recovered) || recovered < existing.recovered_cents || recovered > existing.amount_cents) throw new Error("Recovered amount is invalid")
  if (resolution === "recovered" && recovered !== existing.amount_cents) throw new Error("A recovered backcharge must be fully recovered")
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : {}
  // Writing off or waiving does not un-happen the credit. Deleting the Arc row
  // stranded a live VendorCredit in the accounting provider with nothing
  // pointing at it; a reversing bill is both the correct artifact and the
  // auditable one, and the original credit stays linked.
  let reversalBillId = typeof metadata.reversal_bill_id === "string" ? metadata.reversal_bill_id : null
  if (resolution !== "recovered" && existing.vendor_credit_bill_id && !reversalBillId) {
    const reversal = await createProjectVendorBill({
      projectId: existing.project_id,
      input: {
        company_id: existing.company_id,
        commitment_id: existing.commitment_id,
        bill_number: `WB-${existing.backcharge_number}-R`,
        bill_date: new Date().toISOString().slice(0, 10),
        total_cents: existing.amount_cents,
        description: `Reversal of warranty backcharge WB-${existing.backcharge_number} (${resolution.replace("_", " ")})`,
        actual_lines: existing.cost_basis.map((item) => ({ description: item.label, amount_cents: item.amount_cents, cost_code_id: existing.cost_code_id })),
      },
      orgId: resolvedOrgId,
    })
    reversalBillId = reversal.id
  }
  const { data, error } = await supabase.from("warranty_backcharges").update({
    status: resolution, recovered_cents: recovered, resolved_at: new Date().toISOString(),
    notes: note?.trim() ?? existing.notes,
    vendor_credit_bill_id: existing.vendor_credit_bill_id,
    metadata: mergeMetadata(metadata, { reversal_bill_id: reversalBillId }),
  }).eq("org_id", resolvedOrgId).eq("id", backchargeId).select(BACKCHARGE_SELECT).single()
  if (error || !data) throw new Error(`Failed to resolve warranty backcharge: ${error?.message}`)
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
  if (!await canReadProjectInDivisionScope(supabase, resolvedOrgId, userId, projectId)) return []
  const { data, error } = await supabase.from("commitments").select("id,title,contract_number,company_id,total_cents,status,company:companies(name),lines:commitment_lines(cost_code_id)").eq("org_id", resolvedOrgId).eq("project_id", projectId).order("created_at", { ascending: false }).limit(200)
  if (error) throw new Error(`Failed to load originating commitments: ${error.message}`)
  const candidates: OriginatingCommitmentCandidate[] = (data ?? []).map((row) => {
    const lines = Array.isArray(row.lines) ? row.lines : []
    const company = relationOne(row.company)
    return {
      id: String(row.id), title: String(row.title), contract_number: row.contract_number ?? null,
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
  const { data, error } = await supabase.from("warranty_service_visits").select("id,visit_number,books_approved_cost_cents").eq("org_id", resolvedOrgId).eq("request_id", requestId).not("books_cost_approved_at", "is", null).order("visit_number")
  if (error) throw new Error(`Failed to load approved warranty costs: ${error.message}`)
  return (data ?? []).filter(row => Number(row.books_approved_cost_cents) > 0).map(row => ({ label: `Approved posted costs — Visit ${row.visit_number}`, amount_cents: Number(row.books_approved_cost_cents), ref_type: "warranty_service_visit", ref_id: row.id }))
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

export async function getWarrantyDefectAnalysis(params: { orgId?: string; divisionId?: string; groupBy: "plan" | "plan_version" | "company" | "cost_code" | "community"; from?: string; to?: string }): Promise<WarrantyDefectAnalysisRow[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(params.orgId)
  await requirePermission("warranty.read", { supabase, orgId: resolvedOrgId, userId })
  const authorizedProjectIds = await getDivisionScopedProjectIds({
    orgId: resolvedOrgId,
    userId,
    supabase,
  })
  const divisionProjectIds = params.divisionId
    ? await projectIdsForDivision(supabase, resolvedOrgId, params.divisionId)
    : null
  const scopedProjectIds = intersectProjectReadScopes(authorizedProjectIds, divisionProjectIds)
  if (scopedProjectIds?.length === 0) return []
  const { data, error } = await supabase.rpc("warranty_defect_analysis_scoped", {
    p_org_id: resolvedOrgId,
    p_group_by: params.groupBy,
    p_project_ids: scopedProjectIds,
    p_from: params.from ?? null,
    p_to: params.to ?? null,
  })
  if (error) throw new Error(`Failed to load warranty defect analysis: ${error.message}`)
  return ((data ?? []) as Array<Record<string, unknown>>).map(mapDefectAnalysisRow)
}

export async function getWarrantyCostSummary(params: { orgId?: string; communityId?: string; divisionId?: string } = {}): Promise<WarrantyCostSummaryRow[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(params.orgId)
  await requirePermission("warranty.read", { supabase, orgId: resolvedOrgId, userId })
  const { data, error } = await supabase.rpc("warranty_cost_summary", { p_org_id: resolvedOrgId, p_community_id: params.communityId ?? null })
  if (error) throw new Error(`Failed to load warranty cost summary: ${error.message}`)
  const communityIds = await allowedWarrantyCommunityIds(supabase, resolvedOrgId, userId, params.divisionId)
  const rows = ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    community_id: String(row.community_id), community_name: typeof row.community_name === "string" ? row.community_name : null,
    warranty_cost_cents: Number(row.warranty_cost_cents ?? 0), recovered_cents: Number(row.recovered_cents ?? 0),
    net_cost_cents: Number(row.net_cost_cents ?? 0), closed_revenue_cents: Number(row.closed_revenue_cents ?? 0),
    cost_percent: row.cost_percent === null || row.cost_percent === undefined ? null : Number(row.cost_percent),
  }))
  return communityIds === null ? rows : rows.filter((row) => communityIds.includes(row.community_id))
}

async function projectIdsForDivision(supabase: SupabaseClient, orgId: string, divisionId: string) {
  const { data, error } = await supabase.from("projects").select("id").eq("org_id", orgId).eq("phase", "delivery").eq("division_id", divisionId).limit(1000)
  if (error) throw new Error(`Failed to scope warranty projects: ${error.message}`)
  return (data ?? []).map((row) => row.id as string)
}

async function allowedWarrantyCommunityIds(
  supabase: SupabaseClient,
  orgId: string,
  userId: string,
  divisionId?: string,
): Promise<string[] | null> {
  const access = await getDivisionAccessForUser({ orgId, userId })
  if (!divisionId && !access.assignedOnly) return null
  let divisionIds = divisionId ? [divisionId] : access.divisionIds
  if (access.assignedOnly) divisionIds = divisionIds.filter((id) => access.divisionIds.includes(id))
  if (!divisionIds.length) return []
  const { data, error } = await supabase.from("communities").select("id").eq("org_id", orgId).in("division_id", divisionIds)
  if (error) throw new Error(`Failed to scope warranty analytics: ${error.message}`)
  return (data ?? []).map((row) => row.id as string)
}

export async function getCompanyWarrantySignal(companyId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.read", { supabase, orgId: resolvedOrgId, userId })
  const authorizedProjectIds = await getDivisionScopedProjectIds({
    orgId: resolvedOrgId,
    userId,
    supabase,
  })
  if (authorizedProjectIds?.length === 0) {
    return { request_count: 0, backcharge_cents: 0, recovered_cents: 0, open_backcharges: 0 }
  }
  let requestsQuery = supabase.from("warranty_requests").select("id", { count: "exact", head: true }).eq("org_id", resolvedOrgId).eq("assigned_company_id", companyId)
  let chargesQuery = supabase.from("warranty_backcharges").select("amount_cents,recovered_cents,status").eq("org_id", resolvedOrgId).eq("company_id", companyId)
  if (authorizedProjectIds) {
    requestsQuery = requestsQuery.in("project_id", authorizedProjectIds)
    chargesQuery = chargesQuery.in("project_id", authorizedProjectIds)
  }
  const [{ count: requestCount }, { data: charges }] = await Promise.all([
    requestsQuery,
    chargesQuery,
  ])
  return { request_count: requestCount ?? 0, backcharge_cents: (charges ?? []).reduce((sum, charge) => sum + Number(charge.amount_cents ?? 0), 0), recovered_cents: (charges ?? []).reduce((sum, charge) => sum + Number(charge.recovered_cents ?? 0), 0), open_backcharges: (charges ?? []).filter((charge) => ["issued","disputed"].includes(charge.status)).length }
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

async function createCourtesyInspectionsForOrg(supabase: SupabaseClient, orgId: string, asOf: Date) {
  const { data: coverage, error } = await supabase
    .from("project_warranty_coverage")
    .select("project_id,effective_date")
    // A 30-day walk and an 11-month walk are the whole ritual, so only homes
    // inside that band can have anything due.
    .eq("org_id", orgId)
    .gte("effective_date", new Date(asOf.getTime() - 425 * 86_400_000).toISOString().slice(0, 10))
    .lte("effective_date", asOf.toISOString().slice(0, 10))
    .limit(2000)
  if (error) throw new Error(`Failed to load warranty coverage: ${error.message}`)
  const due = (coverage ?? []).flatMap((row) => dueCourtesyInspections(String(row.effective_date), asOf).map((milestone) => ({ projectId: String(row.project_id), milestone })))
  if (due.length === 0) return 0
  const projectIds = Array.from(new Set(due.map((item) => item.projectId)))
  const { data: existing, error: existingError } = await supabase
    .from("warranty_requests").select("project_id,metadata")
    .eq("org_id", orgId).in("project_id", projectIds).not("metadata->>courtesy_milestone", "is", null).limit(5000)
  if (existingError) throw new Error(`Failed to load existing courtesy inspections: ${existingError.message}`)
  const alreadyCreated = new Set((existing ?? []).map((row) => {
    const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : {}
    return `${row.project_id}:${String(metadata.courtesy_milestone ?? "")}`
  }))
  let created = 0
  for (const item of due) {
    if (alreadyCreated.has(`${item.projectId}:${item.milestone.key}`)) continue
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
  const { data: orgs, error } = await supabase.from("orgs").select("id").limit(2000)
  if (error) throw new Error(`Failed to load organizations: ${error.message}`)
  let created = 0
  for (const org of orgs ?? []) created += await createCourtesyInspectionsForOrg(supabase, String(org.id), asOf)
  return { created }
}

export async function generateWarrantyCourtesyInspections(orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.manage", { supabase, orgId: resolvedOrgId, userId })
  const created = await createCourtesyInspectionsForOrg(supabase, resolvedOrgId, new Date())
  if (created > 0) await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "warranty_request", entityId: resolvedOrgId, after: { courtesy_inspections_created: created } })
  return { created }
}

export async function listWarrantyTechVisits(params: { date: string; userId?: string }, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.read", { supabase, orgId: resolvedOrgId, userId })
  const authorizedProjectIds = await getDivisionScopedProjectIds({
    orgId: resolvedOrgId,
    userId,
    supabase,
  })
  if (authorizedProjectIds?.length === 0) return []
  const targetUserId = params.userId ?? userId, start = `${params.date}T00:00:00.000Z`, end = new Date(new Date(start).getTime() + 86_400_000).toISOString()
  let query = supabase.from("warranty_service_visits").select(`${VISIT_SELECT},request:warranty_requests(title,description,severity,requested_by,requested_by_contact:contacts(full_name,email,phone)),project:projects(name,location)`).eq("org_id", resolvedOrgId).eq("assigned_user_id", targetUserId).gte("window_start", start).lt("window_start", end).neq("status", "canceled")
  if (authorizedProjectIds) query = query.in("project_id", authorizedProjectIds)
  const { data, error } = await query.order("window_start")
  if (error) throw new Error(`Failed to load technician visits: ${error.message}`)
  return (data ?? []).map((row) => ({ ...mapVisit(row as unknown as Record<string, unknown>), request: relationOne((row as unknown as Record<string, unknown>).request), project: relationOne((row as unknown as Record<string, unknown>).project) }))
}

export async function getWarrantyVisitDetail(visitId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("warranty.read", { supabase, orgId: resolvedOrgId, userId })
  const { data, error } = await supabase.from("warranty_service_visits").select(`${VISIT_SELECT},request:warranty_requests(title,description,severity,requested_by,requested_by_contact:contacts(full_name,email,phone),photos:warranty_request_photos(id,file_id,caption)),project:projects(name,location)`).eq("org_id", resolvedOrgId).eq("id", visitId).maybeSingle()
  if (error || !data) throw new Error("Warranty visit not found")
  const visitRow = data as unknown as Record<string, unknown>
  if (!await canReadProjectInDivisionScope(supabase, resolvedOrgId, userId, String(visitRow.project_id))) {
    throw new Error("Warranty visit not found")
  }
  return { ...mapVisit(visitRow), request: relationOne(visitRow.request), project: relationOne(visitRow.project) }
}
