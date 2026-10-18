import { orFilterTerm } from "@/lib/search-picker"
import { cacheLife } from "next/cache"
import type { SupabaseClient } from "@supabase/supabase-js"

import type { Contract, Project, ProjectNavigationItem } from "@/lib/types"
import type { ProjectInput } from "@/lib/validation/projects"
import { projectUpdateSchema } from "@/lib/validation/projects"
import { recordEvent } from "@/lib/services/events"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext, type OrgServiceContext } from "@/lib/services/context"
import { hasPermission, requirePermission, requireProjectPermission } from "@/lib/services/permissions"
import {
  defaultFeePresentationForBillingModel,
  normalizeFeePresentation,
  type ProjectBillingModel,
} from "@/lib/financials/billing-model"
import {
  getProjectFinancialSettings,
  saveBillingContractWithAmendment,
  upsertProjectFinancialSettingsFromProjectInput,
} from "@/lib/services/project-financial-setup"
import { getDefaultProjectPropertyType, getProjectPosture, isProductionProjectPosture, type ProjectPosture } from "@/lib/product-tier"
import { getDivisionAccessForUser, getDivisionScopedProjectIds, getProjectReadScopeForUser } from "@/lib/services/authorization"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { readAllRows, readPageOrEmpty } from "@/lib/land/paging"
import { chunk } from "@/lib/utils"
import { terminology } from "@/lib/terminology"

function contractTypeForBillingModel(model?: ProjectBillingModel | null): "fixed" | "cost_plus" | "time_materials" {
  if (model === "time_and_materials") return "time_materials"
  if (model === "cost_plus_percent" || model === "cost_plus_fixed_fee" || model === "cost_plus_gmp") return "cost_plus"
  return "fixed"
}

function billingModelForContractInput(input: Partial<ProjectInput>, existing?: any, existingSettings?: { billing_model?: string | null } | null): ProjectBillingModel {
  if (input.billing_model) return input.billing_model as ProjectBillingModel
  const settingsModel = existingSettings?.billing_model
  if (
    settingsModel === "fixed_price" ||
    settingsModel === "cost_plus_percent" ||
    settingsModel === "cost_plus_fixed_fee" ||
    settingsModel === "cost_plus_gmp" ||
    settingsModel === "time_and_materials"
  ) {
    return settingsModel
  }
  const snapshotModel = existing?.snapshot?.billing_model
  if (
    snapshotModel === "fixed_price" ||
    snapshotModel === "cost_plus_percent" ||
    snapshotModel === "cost_plus_fixed_fee" ||
    snapshotModel === "cost_plus_gmp" ||
    snapshotModel === "time_and_materials"
  ) {
    return snapshotModel
  }
  const contractType = input.contract_type ?? existing?.contract_type ?? "fixed"
  if (contractType === "time_materials") return "time_and_materials"
  if (contractType === "cost_plus") return input.gmp_cents ?? existing?.gmp_cents ? "cost_plus_gmp" : "cost_plus_percent"
  return "fixed_price"
}

function projectDateValue(input: Partial<ProjectInput>, key: "start_date" | "end_date", fallback?: string | null) {
  if (!Object.prototype.hasOwnProperty.call(input, key)) return fallback ?? null
  return input[key] || null
}

function projectNullableValue<T>(input: Partial<ProjectInput>, key: keyof ProjectInput, fallback: T | null | undefined) {
  if (!Object.prototype.hasOwnProperty.call(input, key)) return fallback ?? null
  return (input[key] ?? null) as T | null
}

function mapProjectModuleOverrides(row: { project_module_overrides?: unknown }) {
  const overrideRows = Array.isArray(row.project_module_overrides)
    ? row.project_module_overrides
    : []
  return Object.fromEntries(
    overrideRows.map((override: { module_key: string; enabled: boolean }) => [
      override.module_key,
      override.enabled,
    ]),
  )
}

type ProjectAccountingDimensions = {
  class?: { id: string; name?: string | null }
  customer?: { id: string; name?: string | null }
}

function mapProject(row: any, accountingDimensions?: ProjectAccountingDimensions | null): Project {
  const location = (row.location ?? {}) as Record<string, unknown>
  const address = typeof location.address === "string" ? location.address : (location.formatted as string | undefined)

  const contracts = Array.isArray(row.contracts) ? row.contracts : []
  const billingContractRow = contracts.find((contract: any) => contract.status === "active") ?? contracts[0] ?? null

  return {
    id: row.id,
    org_id: row.org_id,
    name: row.name,
    status: row.status,
    phase: row.phase ?? "delivery",
    start_date: row.start_date ?? undefined,
    end_date: row.end_date ?? undefined,
    address,
    client_id: row.client_id ?? undefined,
    prospect_id: row.prospect_id ?? null,
    property_type: row.property_type ?? undefined,
    division_id: row.division_id ?? null,
    superintendent_id: row.superintendent_id ?? null,
    module_overrides: mapProjectModuleOverrides(row),
    project_type: row.project_type ?? undefined,
    description: row.description ?? undefined,
    retainage_percent: row.retainage_percent != null ? Number(row.retainage_percent) : undefined,
    total_value: row.total_value ?? undefined,
    total_contract_value_cents: row.total_contract_value_cents ?? undefined,
    qbo_class_id: accountingDimensions?.class?.id ?? null,
    qbo_class_name: accountingDimensions?.class?.name ?? null,
    qbo_customer_id: accountingDimensions?.customer?.id ?? null,
    qbo_customer_name: accountingDimensions?.customer?.name ?? null,
    excluded_from_reporting: row.excluded_from_reporting ?? false,
    is_public_work: row.is_public_work ?? false,
    require_subtier_waivers: row.require_subtier_waivers ?? false,
    financial_settings: row.project_financial_settings?.[0] ?? null,
    billing_contract: billingContractRow ? mapProjectBillingContract(billingContractRow) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function mapProjectNavigationItem(row: any): ProjectNavigationItem {
  const financialSettings = Array.isArray(row.project_financial_settings)
    ? row.project_financial_settings[0]
    : row.project_financial_settings

  return {
    id: row.id,
    org_id: row.org_id,
    name: row.name,
    status: row.status,
    phase: row.phase ?? "delivery",
    property_type: row.property_type ?? undefined,
    module_overrides: mapProjectModuleOverrides(row),
    financial_settings: financialSettings?.billing_model
      ? { billing_model: financialSettings.billing_model }
      : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function mapProjectBillingContract(row: any): Contract {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    proposal_id: row.proposal_id ?? undefined,
    number: row.number ?? undefined,
    title: row.title,
    status: row.status,
    contract_type: row.contract_type ?? undefined,
    total_cents: row.total_cents ?? undefined,
    currency: row.currency ?? "usd",
    markup_percent: row.markup_percent != null ? Number(row.markup_percent) : undefined,
    gmp_cents: row.gmp_cents ?? undefined,
    contingency_cents: row.contingency_cents ?? undefined,
    fixed_fee_cents: row.fixed_fee_cents ?? undefined,
    fee_presentation: row.fee_presentation ?? row.snapshot?.fee_presentation ?? undefined,
    savings_split_owner_pct: row.savings_split_owner_pct != null ? Number(row.savings_split_owner_pct) : undefined,
    savings_split_builder_pct: row.savings_split_builder_pct != null ? Number(row.savings_split_builder_pct) : undefined,
    labor_burden_multiplier: row.labor_burden_multiplier != null ? Number(row.labor_burden_multiplier) : undefined,
    rate_schedule_id: row.rate_schedule_id ?? null,
    requires_client_cost_approval: row.requires_client_cost_approval ?? undefined,
    open_book: row.open_book ?? undefined,
    retainage_percent: row.retainage_percent != null ? Number(row.retainage_percent) : undefined,
    retainage_applies_to_fee: row.retainage_applies_to_fee ?? row.snapshot?.retainage_applies_to_fee ?? false,
    retainage_release_trigger: row.retainage_release_trigger ?? undefined,
    retainage_schedule: row.retainage_schedule ?? null,
    stored_materials_retainage_percent:
      row.stored_materials_retainage_percent != null ? Number(row.stored_materials_retainage_percent) : null,
    terms: row.terms ?? undefined,
    effective_date: row.effective_date ?? undefined,
    signed_at: row.signed_at ?? undefined,
    signature_data: row.signature_data ?? undefined,
    parent_contract_id: row.parent_contract_id ?? null,
    snapshot: row.snapshot ?? {},
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/** Header fields only: no contract snapshot, no financial settings, no accounting map. */
const PROJECT_IDENTITY_SELECT = `
  id, org_id, name, status, phase, start_date, end_date, location, client_id, prospect_id,
  property_type, project_type, division_id, superintendent_id, description, total_value,
  retainage_percent, total_contract_value_cents, excluded_from_reporting, is_public_work,
  require_subtier_waivers, created_at, updated_at,
  project_module_overrides(module_key, enabled)
`

const PROJECT_SELECT = `
  id, org_id, name, status, phase, start_date, end_date, location, client_id, prospect_id, property_type, project_type, division_id, superintendent_id, description, total_value, retainage_percent, total_contract_value_cents, excluded_from_reporting, is_public_work, require_subtier_waivers, created_at, updated_at,
  project_financial_settings(id, org_id, project_id, billing_model, fixed_price_billing_basis, paid_costs_required, proof_required, client_cost_approval_required, open_book_required, cost_codes_enabled, setup_completed_at, metadata),
  project_module_overrides(module_key, enabled),
  contracts(id, org_id, project_id, proposal_id, number, title, status, contract_type, total_cents, currency, markup_percent, gmp_cents, contingency_cents, fixed_fee_cents, fee_presentation, savings_split_owner_pct, savings_split_builder_pct, labor_burden_multiplier, rate_schedule_id, requires_client_cost_approval, open_book, retainage_percent, retainage_applies_to_fee, retainage_release_trigger, retainage_schedule, stored_materials_retainage_percent, terms, effective_date, signed_at, signature_data, parent_contract_id, snapshot, created_at, updated_at)
`

async function loadProjectAccountingDimensions(supabase: SupabaseClient, orgId: string, projectIds: string[]) {
  const ids = Array.from(new Set(projectIds.filter(Boolean)))
  if (ids.length === 0) return new Map<string, ProjectAccountingDimensions>()
  const { data, error } = await supabase
    .from("accounting_entity_map")
    .select("project_id,dimensions")
    .eq("org_id", orgId)
    .in("project_id", ids)
  if (error) throw new Error(`Failed to load project accounting mappings: ${error.message}`)
  return new Map((data ?? []).map((row: any) => [row.project_id as string, (row.dimensions ?? {}) as ProjectAccountingDimensions]))
}

async function mapProjectsWithAccounting(supabase: SupabaseClient, orgId: string, rows: any[]) {
  const dimensions = await loadProjectAccountingDimensions(supabase, orgId, rows.map((row) => row.id))
  return rows.map((row) => mapProject(row, dimensions.get(row.id)))
}

export async function resolveVisibleProjectIds(input: {
  supabase: SupabaseClient
  orgId: string
  userId: string
  includePrecon: boolean
}): Promise<string[] | null> {
  const divisionProjectIds = await getDivisionScopedProjectIds(input)
  if (divisionProjectIds?.length === 0) return []

  const { data: scopeRows, error: scopeError } = await input.supabase
    .from("memberships")
    .select("project_scope")
    .eq("org_id", input.orgId)
    .eq("user_id", input.userId)
    .eq("status", "active")
  if (scopeError) throw new Error("Unable to resolve project membership scope.")
  const assignedOnly = (scopeRows ?? []).some(
    (row) => (row as { project_scope?: string }).project_scope === "assigned",
  )
  const canSeeAllProjects =
    !assignedOnly &&
    ((await hasPermission("project.read", input)) ||
      (await hasPermission("project.manage", input)))

  if (canSeeAllProjects) return divisionProjectIds

  let membersQuery = input.supabase
    .from("project_members")
    .select("project_id, project:projects!inner(id, phase)")
    .eq("org_id", input.orgId)
    .eq("user_id", input.userId)
    .eq("status", "active")
  if (!input.includePrecon) membersQuery = membersQuery.eq("project.phase", "delivery")
  const { data, error } = await membersQuery
  if (error) throw new Error(`Failed to resolve assigned projects: ${error.message}`)

  const divisionSet = divisionProjectIds ? new Set(divisionProjectIds) : null
  return (data ?? [])
    .map((row) => row.project_id as string | null)
    .filter((id): id is string => id !== null && (!divisionSet || divisionSet.has(id)))
}

export function prepareProjectAccountingDimensions(params: {
  existingDimensions?: ProjectAccountingDimensions | null
  classId?: string | null
  className?: string | null
  customerId?: string | null
  customerName?: string | null
}) {
  const dimensions = { ...(params.existingDimensions ?? {}) }
  if (params.classId !== undefined || params.className !== undefined) {
    if (params.classId) dimensions.class = { id: params.classId, name: params.className ?? null }
    else delete dimensions.class
  }
  if (params.customerId !== undefined || params.customerName !== undefined) {
    if (params.customerId) dimensions.customer = { id: params.customerId, name: params.customerName ?? null }
    else delete dimensions.customer
  }
  return dimensions
}

async function saveProjectAccountingDimensions(params: {
  supabase: SupabaseClient
  orgId: string
  userId: string
  projectId: string
  classId?: string | null
  className?: string | null
  customerId?: string | null
  customerName?: string | null
}) {
  const requested = [params.classId, params.className, params.customerId, params.customerName].some((value) => value !== undefined)
  if (!requested) return
  const { data: existing } = await params.supabase
    .from("accounting_entity_map")
    .select("id,connection_id,dimensions")
    .eq("org_id", params.orgId)
    .eq("project_id", params.projectId)
    .maybeSingle()
  let connectionId = existing?.connection_id ?? null
  if (!connectionId) {
    const { data: defaultMap } = await params.supabase
      .from("accounting_entity_map")
      .select("connection_id")
      .eq("org_id", params.orgId)
      .is("project_id", null)
      .is("community_id", null)
      .is("division_id", null)
      .maybeSingle()
    connectionId = defaultMap?.connection_id ?? null
  }
  if (!connectionId) return
  const dimensions = prepareProjectAccountingDimensions({
    ...params, existingDimensions: existing?.dimensions,
  })
  const query = existing?.id
    ? params.supabase.from("accounting_entity_map").update({ dimensions }).eq("id", existing.id)
    : params.supabase.from("accounting_entity_map").insert({
      org_id: params.orgId,
      connection_id: connectionId,
      project_id: params.projectId,
      dimensions,
      created_by: params.userId,
    })
  const { error } = await query
  if (error) throw new Error(`Failed to save project accounting mapping: ${error.message}`)
}

export async function listProjects(
  orgId?: string,
  context?: OrgServiceContext,
  options?: { includePrecon?: boolean },
): Promise<Project[]> {
  const { supabase, orgId: resolvedOrgId, userId } = context || await requireOrgContext(orgId)
  const includePrecon = options?.includePrecon ?? false
  const visibleProjectIds = await resolveVisibleProjectIds({
    supabase,
    orgId: resolvedOrgId,
    userId,
    includePrecon,
  })
  if (visibleProjectIds?.length === 0) return []
  return listProjectsWithClient(supabase, resolvedOrgId, visibleProjectIds, { includePrecon })
}

/** Minimal project records needed by the cross-project billing desk. */
export async function listBillingDeskProjects(
  orgId?: string,
  context?: OrgServiceContext,
): Promise<Project[]> {
  const { supabase, orgId: resolvedOrgId, userId } = context || await requireOrgContext(orgId)
  const visibleProjectIds = await resolveVisibleProjectIds({
    supabase,
    orgId: resolvedOrgId,
    userId,
    includePrecon: false,
  })
  if (visibleProjectIds?.length === 0) return []
  let query = supabase
    .from("projects")
    .select(`
      id, org_id, name, status, phase, property_type, division_id, created_at, updated_at,
      project_financial_settings(billing_model, fixed_price_billing_basis),
      contracts(id, org_id, project_id, status, contract_type, total_cents, currency, fixed_fee_cents, gmp_cents, open_book, requires_client_cost_approval, snapshot, created_at, updated_at)
    `)
    .eq("org_id", resolvedOrgId)
    .eq("phase", "delivery")
    .order("name")
  if (visibleProjectIds) query = query.in("id", visibleProjectIds)
  const { data, error } = await query
  if (error) throw new Error(`Failed to list billing projects: ${error.message}`)
  return (data ?? []).map((row) => mapProject(row))
}

/** Most projects the summary list reads; a bigger org sees a visible "first N of M". */
export const PROJECT_SUMMARY_CAP = 2_000
const PROJECT_SUMMARY_ID_CHUNK = 100

export interface ProjectSummaryPage {
  projects: Project[]
  /** Projects the caller may see, counted whether or not they were all read. */
  total: number
  truncated: boolean
}

/**
 * Project identity rows for pickers and the schedule desk, newest first. Reads
 * past PostgREST's row cap and stops at PROJECT_SUMMARY_CAP, reporting the cut.
 * `projectIds` narrows to a caller-resolved scope (a community lens); it is
 * intersected with what the caller may see, never widened.
 */
export async function listProjectSummaries(
  orgId?: string,
  context?: OrgServiceContext,
  options?: { includePrecon?: boolean; projectIds?: readonly string[] | null },
): Promise<ProjectSummaryPage> {
  const { supabase, orgId: resolvedOrgId, userId } = context || await requireOrgContext(orgId)
  const includePrecon = options?.includePrecon ?? false
  const visibleProjectIds = await resolveVisibleProjectIds({
    supabase,
    orgId: resolvedOrgId,
    userId,
    includePrecon,
  })
  const requested = options?.projectIds ?? null
  let scopedIds: string[] | null = visibleProjectIds
  if (requested) {
    const visible = visibleProjectIds ? new Set(visibleProjectIds) : null
    scopedIds = requested.filter((id) => !visible || visible.has(id))
  }
  if (scopedIds?.length === 0) return { projects: [], total: 0, truncated: false }

  const base = () => {
    let query = supabase.from("projects").select(PROJECT_IDENTITY_SELECT).eq("org_id", resolvedOrgId)
    if (!includePrecon) query = query.eq("phase", "delivery")
    return query
  }

  if (scopedIds) {
    const batches = await Promise.all(
      chunk(scopedIds, PROJECT_SUMMARY_ID_CHUNK).map(async (ids) => {
        const { data, error } = await base().in("id", ids).order("created_at", { ascending: false }).order("id")
        if (error) throw new Error(`Failed to list project summaries: ${error.message}`)
        return data ?? []
      }),
    )
    const rows = batches
      .flat()
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? -1 : 1))
    return {
      projects: rows.slice(0, PROJECT_SUMMARY_CAP).map((row) => mapProject(row)),
      total: rows.length,
      truncated: rows.length > PROJECT_SUMMARY_CAP,
    }
  }

  const { rows, truncated } = await readAllRows(
    (from, to) => base().order("created_at", { ascending: false }).order("id").range(from, to),
    { cap: PROJECT_SUMMARY_CAP, label: "Failed to list project summaries" },
  )
  let total = rows.length
  if (truncated) {
    const { count, error } = await supabase
      .from("projects")
      .select("id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId)
      .match(includePrecon ? {} : { phase: "delivery" })
    if (error) throw new Error(`Failed to count project summaries: ${error.message}`)
    total = count ?? rows.length
  }
  return { projects: rows.map((row) => mapProject(row)), total, truncated: truncated && total > rows.length }
}

export interface ProjectBillingOption {
  id: string
  name: string
  billingModel: ProjectBillingModel
}

export async function listProjectBillingOptions(
  orgId?: string,
  context?: OrgServiceContext,
): Promise<ProjectBillingOption[]> {
  const { supabase, orgId: resolvedOrgId, userId } = context || await requireOrgContext(orgId)
  const visibleProjectIds = await resolveVisibleProjectIds({
    supabase,
    orgId: resolvedOrgId,
    userId,
    includePrecon: false,
  })
  if (visibleProjectIds?.length === 0) return []

  let query = supabase
    .from("projects")
    .select("id, name, project_financial_settings(billing_model)")
    .eq("org_id", resolvedOrgId)
    .eq("phase", "delivery")
    .order("name")
  if (visibleProjectIds) query = query.in("id", visibleProjectIds)
  const { data, error } = await query
  if (error) throw new Error(`Failed to list project billing options: ${error.message}`)

  return (data ?? []).map((row) => {
    const settings = Array.isArray(row.project_financial_settings)
      ? row.project_financial_settings[0]
      : row.project_financial_settings
    const rawBillingModel = settings?.billing_model
    const billingModel: ProjectBillingModel =
      rawBillingModel === "cost_plus_percent" ||
      rawBillingModel === "cost_plus_fixed_fee" ||
      rawBillingModel === "cost_plus_gmp" ||
      rawBillingModel === "time_and_materials"
        ? rawBillingModel
        : "fixed_price"
    return {
      id: row.id,
      name: row.name,
      billingModel,
    }
  })
}

export interface ProjectSearchResult {
  id: string
  name: string
  /** What this project is called on its own posture: Project, Home. */
  noun: string
  status: string | null
}

export interface ProjectSearchPage {
  projects: ProjectSearchResult[]
  page: number
  pageSize: number
  total: number
}

/**
 * One page of the projects the caller can open, found by name or street address.
 * The picker for "attach this to a project" — it never holds the portfolio, so a
 * 200-project org and a 400-lot community search the same way a small one does.
 */
export async function searchVisibleProjects(
  input: { search?: string; page?: number; pageSize?: number; includePrecon?: boolean },
  orgId?: string,
  context?: OrgServiceContext,
): Promise<ProjectSearchPage> {
  const resolved = context || await requireOrgContext(orgId)
  const page = Math.max(1, input.page ?? 1)
  const pageSize = Math.min(Math.max(1, input.pageSize ?? 25), 50)
  const empty = { projects: [], page, pageSize, total: 0 }
  const visibleProjectIds = await resolveVisibleProjectIds({
    supabase: resolved.supabase,
    orgId: resolved.orgId,
    userId: resolved.userId,
    includePrecon: input.includePrecon ?? true,
  })
  if (visibleProjectIds?.length === 0) return empty

  let query = resolved.supabase
    .from("projects")
    .select("id, name, status, property_type", { count: "exact" })
    .eq("org_id", resolved.orgId)
  if (visibleProjectIds) query = query.in("id", visibleProjectIds)
  const term = input.search ? orFilterTerm(input.search) : ""
  if (term) query = query.or(`name.ilike.%${term}%,location->>address.ilike.%${term}%,location->>formatted.ilike.%${term}%`)
  const from = (page - 1) * pageSize
  const ordered = query.order("name").order("id")
  const { data, error, count } = await readPageOrEmpty((start, end) => ordered.range(start, end), from, from + pageSize - 1)
  if (error) throw new Error(`Failed to search projects: ${error.message}`)

  return {
    projects: data.map((row) => ({
      id: row.id,
      name: row.name || "Untitled project",
      noun: terminology(getProjectPosture(row.property_type, resolved.productTier)).project,
      status: row.status ?? null,
    })),
    page,
    pageSize,
    total: count ?? 0,
  }
}

export async function listProjectsWithClient(
  supabase: SupabaseClient,
  orgId: string,
  projectIds: string[] | null = null,
  options?: { includePrecon?: boolean },
): Promise<Project[]> {
  let query = supabase
    .from("projects")
    .select(PROJECT_SELECT)
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
  if (!options?.includePrecon) query = query.eq("phase", "delivery")
  if (projectIds) query = query.in("id", projectIds)
  const { data, error } = await query

  if (error) {
    throw new Error(`Failed to list projects: ${error.message}`)
  }

  return mapProjectsWithAccounting(supabase, orgId, data ?? [])
}

/**
 * The identity of one project: everything a header renders, and nothing else.
 *
 * Privately cached so it can ride along with a runtime prefetch. `/projects/[id]`
 * is entirely params-dependent, so the route's shared App Shell carries nothing
 * project-specific — a `<Link prefetch>` resolves `params.id` before the click,
 * and this is the only read on the page that can already be resolved by then.
 * That is what makes the name of the project you clicked appear on the click
 * rather than a round trip later.
 *
 * Browser memory only, never the server cache, gone on reload. Every mutation
 * that renames or re-scopes a project already calls `revalidatePath`, which
 * clears the client cache outright.
 */
export async function getProjectIdentity(projectId: string): Promise<Project | null> {
  "use cache: private"
  cacheLife("session")

  const { supabase, orgId, userId } = await requireOrgContext()
  await requireProjectPermission(userId, projectId, "project.read")

  const { data, error } = await supabase
    .from("projects")
    .select(PROJECT_IDENTITY_SELECT)
    .eq("org_id", orgId)
    .eq("id", projectId)
    .maybeSingle()

  // No row here is expected (e.g. a platform admin whose active org differs from
  // the project's org) — return null quietly. Only log genuine query failures.
  if (error) {
    console.error("Failed to fetch project identity:", error.message)
    return null
  }
  if (!data) return null

  return mapProject(data)
}

const PROJECT_NAVIGATION_SELECT = `
  id, org_id, name, status, phase, property_type, created_at, updated_at,
  project_financial_settings(project_id, billing_model),
  project_module_overrides(module_key, enabled)
`

/** The switcher lists this many projects, newest first; a production org has thousands of homes. */
export const PROJECT_NAVIGATION_LIMIT = 200

export async function listProjectNavigationItemsWithClient(
  supabase: SupabaseClient,
  orgId: string,
): Promise<{ items: ProjectNavigationItem[]; truncated: boolean }> {
  const { data, error } = await supabase
    .from("projects")
    .select(PROJECT_NAVIGATION_SELECT)
    .eq("org_id", orgId)
    .eq("phase", "delivery")
    .order("created_at", { ascending: false })
    .limit(PROJECT_NAVIGATION_LIMIT + 1)

  if (error) {
    throw new Error(`Failed to list project navigation items: ${error.message}`)
  }

  const rows = data ?? []
  return { items: rows.slice(0, PROJECT_NAVIGATION_LIMIT).map(mapProjectNavigationItem), truncated: rows.length > PROJECT_NAVIGATION_LIMIT }
}

/** One project's navigation facts, for the project the shell is on when it is outside the switcher's list. */
export async function getProjectNavigationItemWithClient(
  supabase: SupabaseClient,
  orgId: string,
  projectId: string,
): Promise<ProjectNavigationItem | null> {
  const { data, error } = await supabase
    .from("projects")
    .select(PROJECT_NAVIGATION_SELECT)
    .eq("org_id", orgId)
    .eq("id", projectId)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to load project navigation item: ${error.message}`)
  }

  return data ? mapProjectNavigationItem(data) : null
}

// Single-project fetch using the full PROJECT_SELECT so financial_settings and billing_contract
// are populated (unlike the lighter `select("*")` used elsewhere). Used by the settings sheet.
export async function getProjectWithFinancials({
  projectId,
  orgId,
  context,
}: {
  projectId: string
  orgId?: string
  context?: OrgServiceContext
}): Promise<Project | null> {
  const { supabase, orgId: resolvedOrgId } = context || await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("projects")
    .select(PROJECT_SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("id", projectId)
    .single()

  if (error || !data) {
    if (error) console.error("Failed to fetch project with financials:", error.message)
    return null
  }

  const mapped = await mapProjectsWithAccounting(supabase, resolvedOrgId, [data])
  return mapped[0] ?? null
}

/** Prepare the original project row without creating it or its financial records. */
export function prepareProjectCreation({ input, orgId, userId, productTier }: {
  input: ProjectInput
  orgId: string
  userId: string
  productTier: OrgServiceContext["productTier"]
}) {
  const propertyType = input.property_type ?? getDefaultProjectPropertyType(productTier)
  const retainagePercent =
    input.retainage_percent ?? (getProjectPosture(propertyType, productTier) === "commercial" ? 10 : 0)
  const normalizedInput: ProjectInput = {
    ...input,
    property_type: propertyType,
    retainage_percent: retainagePercent,
  }

  const payload = {
    org_id: orgId,
    name: normalizedInput.name,
    status: normalizedInput.status ?? "active",
    phase: normalizedInput.phase ?? "delivery",
    start_date: normalizedInput.start_date || null,
    end_date: normalizedInput.end_date || null,
    location: normalizedInput.location ?? (normalizedInput.address ? { address: normalizedInput.address } : null),
    client_id: normalizedInput.client_id ?? null,
    property_type: normalizedInput.property_type,
    project_type: normalizedInput.project_type,
    description: normalizedInput.description,
    retainage_percent: normalizedInput.retainage_percent,
    total_value: typeof normalizedInput.total_value === "number" ? Math.round(normalizedInput.total_value) : normalizedInput.total_value,
    created_by: userId,
    prospect_id: normalizedInput.prospect_id || null,
  }

  return { input: normalizedInput, project: payload }
}

/**
 * The division a new project is filed under. A member limited to some divisions
 * may only create inside them: with one they get it, with several they choose.
 */
async function resolveNewProjectDivision({ supabase, orgId, requested, access }: {
  supabase: SupabaseClient
  orgId: string
  requested: string | null
  access: { assignedOnly: boolean; divisionIds: string[] }
}): Promise<string | null> {
  if (access.assignedOnly) {
    if (access.divisionIds.length === 0) throw new Error("You are not assigned to any division, so you cannot create a project. Ask an admin to assign you to one.")
    if (!requested) {
      if (access.divisionIds.length === 1) return access.divisionIds[0]
      throw new Error(`Choose a division for this project: you are assigned to ${access.divisionIds.length} divisions.`)
    }
    if (!access.divisionIds.includes(requested)) throw new Error("You can only create projects in the divisions you are assigned to.")
  }
  if (!requested) return null
  const { data, error } = await supabase.from("divisions").select("id").eq("org_id", orgId).eq("id", requested).maybeSingle()
  if (error) throw new Error(`Failed to verify the division: ${error.message}`)
  if (!data) throw new Error("Division not found")
  return requested
}

async function addCreatorToProject({ supabase, orgId, userId, projectId }: {
  supabase: SupabaseClient
  orgId: string
  userId: string
  projectId: string
}) {
  const { data: role, error: roleError } = await supabase.from("roles").select("id").eq("key", "pm").eq("scope", "project").maybeSingle()
  if (roleError || !role) throw new Error("Project manager role is missing, so the new project could not be assigned to you.")
  const { error } = await supabase.from("project_members").upsert(
    { org_id: orgId, project_id: projectId, user_id: userId, role_id: role.id, status: "active" },
    { onConflict: "project_id,user_id" },
  )
  if (error) throw new Error(`Failed to add you to the new project: ${error.message}`)
}

export async function createProject({
  input,
  orgId,
  context,
  authorizationPermission = "project.manage",
}: {
  input: ProjectInput
  orgId?: string
  context?: OrgServiceContext
  authorizationPermission?: string
}) {
  const { supabase, orgId: resolvedOrgId, userId, productTier } = context || await requireOrgContext(orgId)
  await requirePermission(authorizationPermission, { supabase, orgId: resolvedOrgId, userId })

  const { input: normalizedInput, project: payload } = prepareProjectCreation({
    input, orgId: resolvedOrgId, userId, productTier,
  })

  const [divisionAccess, readScope] = await Promise.all([
    getDivisionAccessForUser({ orgId: resolvedOrgId, userId }),
    getProjectReadScopeForUser({ orgId: resolvedOrgId, userId }),
  ])
  const divisionId = await resolveNewProjectDivision({
    supabase, orgId: resolvedOrgId, requested: normalizedInput.division_id ?? null, access: divisionAccess,
  })

  // The database hides a division- or assignment-restricted member's own client
  // from a project outside their scope, and a new project is outside it until
  // its division and project_members row exist, so INSERT ... RETURNING cannot
  // read it back. The authorization above is the gate; the write is the service
  // client's, and the creator is made a member in the same flow.
  const scopedCreator = divisionAccess.assignedOnly || readScope.projectMembershipRequired
  const writer = scopedCreator ? createServiceSupabaseClient() : supabase
  const { data, error } = await writer
    .from("projects")
    .insert({ ...payload, division_id: divisionId })
    .select(PROJECT_SELECT)
    .single()

  if (error) {
    throw new Error(`Failed to create project: ${error.message}`)
  }

  if (readScope.projectMembershipRequired) {
    await addCreatorToProject({ supabase: writer, orgId: resolvedOrgId, userId, projectId: data.id as string })
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "project_created",
    entityType: "project",
    entityId: data.id as string,
    payload: { name: normalizedInput.name },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "project",
    entityId: data.id as string,
    after: data,
  })

  if (opensProjectSettingsContract(getProjectPosture(normalizedInput.property_type, productTier), input)) {
    await upsertProjectBillingContract({
      supabase,
      orgId: resolvedOrgId,
      userId,
      projectId: data.id as string,
      projectName: data.name,
      input: normalizedInput,
    })
  } else {
    await upsertProjectFinancialSettingsFromProjectInput({
      supabase,
      orgId: resolvedOrgId,
      userId,
      projectId: data.id as string,
      input: normalizedInput,
      existingContract: null,
    })
  }

  await saveProjectAccountingDimensions({
    supabase,
    orgId: resolvedOrgId,
    userId,
    projectId: data.id as string,
    classId: normalizedInput.qbo_class_id?.trim() || null,
    className: normalizedInput.qbo_class_name?.trim() || null,
    customerId: normalizedInput.qbo_customer_id?.trim() || null,
    customerName: normalizedInput.qbo_customer_name?.trim() || null,
  })

  const mapped = await mapProjectsWithAccounting(supabase, resolvedOrgId, [data])
  return mapped[0]
}

export async function updateProject({
  projectId,
  input,
  orgId,
  context,
}: {
  projectId: string
  input: Partial<ProjectInput>
  orgId?: string
  context?: OrgServiceContext
}) {
  const parsed = projectUpdateSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = context || await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })

  const existing = await supabase
    .from("projects")
    .select(PROJECT_SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("id", projectId)
    .single()

  if (existing.error || !existing.data) {
    throw new Error(`Project not found or not accessible`)
  }

  const updatePayload = {
    name: parsed.name ?? existing.data.name,
    status: parsed.status ?? existing.data.status,
    start_date: projectDateValue(parsed, "start_date", existing.data.start_date),
    end_date: projectDateValue(parsed, "end_date", existing.data.end_date),
    location:
      parsed.location ?? (parsed.address ? { address: parsed.address } : existing.data.location ?? null),
    client_id: projectNullableValue<string>(parsed, "client_id", existing.data.client_id),
    property_type: parsed.property_type ?? existing.data.property_type,
    project_type: parsed.project_type ?? existing.data.project_type,
    description: parsed.description ?? existing.data.description,
    total_value: typeof parsed.total_value === "number" ? Math.round(parsed.total_value) : (parsed.total_value ?? existing.data.total_value),
    excluded_from_reporting: parsed.excluded_from_reporting ?? existing.data.excluded_from_reporting ?? false,
    is_public_work: parsed.is_public_work ?? existing.data.is_public_work ?? false,
    require_subtier_waivers: parsed.require_subtier_waivers ?? existing.data.require_subtier_waivers ?? false,
  }

  const { data, error } = await supabase
    .from("projects")
    .update(updatePayload)
    .eq("org_id", resolvedOrgId)
    .eq("id", projectId)
    .select(PROJECT_SELECT)
    .single()

  if (error || !data) {
    throw new Error(`Failed to update project: ${error?.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "project_updated",
    entityType: "project",
    entityId: data.id as string,
    payload: { name: data.name, status: data.status },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "project",
    entityId: data.id as string,
    before: existing.data,
    after: data,
  })

  await upsertProjectBillingContract({
    supabase,
    orgId: resolvedOrgId,
    userId,
    projectId,
    projectName: data.name,
    input: parsed,
  })

  await saveProjectAccountingDimensions({
    supabase,
    orgId: resolvedOrgId,
    userId,
    projectId,
    classId: Object.prototype.hasOwnProperty.call(parsed, "qbo_class_id") ? parsed.qbo_class_id?.trim() || null : undefined,
    className: Object.prototype.hasOwnProperty.call(parsed, "qbo_class_name") ? parsed.qbo_class_name?.trim() || null : undefined,
    customerId: Object.prototype.hasOwnProperty.call(parsed, "qbo_customer_id") ? parsed.qbo_customer_id?.trim() || null : undefined,
    customerName: Object.prototype.hasOwnProperty.call(parsed, "qbo_customer_name") ? parsed.qbo_customer_name?.trim() || null : undefined,
  })

  const mapped = await mapProjectsWithAccounting(supabase, resolvedOrgId, [data])
  return mapped[0]
}

/** Preserve billing defaults and existing terms before choosing the commit boundary. */
export function prepareProjectBillingContract({ input, existing, existingSettings, orgId, projectId, projectName }: {
  input: Partial<ProjectInput>
  existing?: Partial<Contract> | null
  existingSettings?: { billing_model?: string | null } | null
  orgId: string
  projectId: string
  projectName: string
}) {
  const ownerPct = input.savings_split_owner_pct ?? 0
  const builderPct = input.savings_split_builder_pct ?? 0
  if (ownerPct + builderPct > 100) throw new Error("Savings split percentages cannot exceed 100%.")
  const billingModel = billingModelForContractInput(input, existing, existingSettings)
  const contractType = input.billing_model ? contractTypeForBillingModel(billingModel) : input.contract_type ?? contractTypeForBillingModel(billingModel)
  const isFixedPrice = billingModel === "fixed_price"
  const isFixedFee = billingModel === "cost_plus_fixed_fee"
  const feePresentation =
    normalizeFeePresentation(input.fee_presentation) ??
    normalizeFeePresentation(existing?.fee_presentation) ??
    normalizeFeePresentation(existing?.snapshot?.fee_presentation) ??
    (existing ? "embedded" : defaultFeePresentationForBillingModel(billingModel))
  const existingSnapshot = existing?.snapshot ?? {}
  const {
    billing_model: _legacySnapshotBillingModel,
    fixed_fee_cents: _legacySnapshotFixedFeeCents,
    ...nextSnapshotBase
  } = existingSnapshot
  const approvedChangeOrdersCents = Number(existingSnapshot.approved_change_orders_cents ?? 0)
  const existingBaseTotalCents = existing
    ? Number(
        existingSnapshot.base_total_cents ??
          Math.max(0, Number(existing.total_cents ?? 0) - approvedChangeOrdersCents),
      )
    : null
  const requestedBaseTotalCents =
    input.total_contract_value_cents ??
    (typeof input.total_value === "number" ? Math.round(input.total_value * 100) : null)
  const baseTotalCents = requestedBaseTotalCents ?? existingBaseTotalCents
  const revisedTotalCents = baseTotalCents == null ? null : baseTotalCents + approvedChangeOrdersCents
  const payload = {
    org_id: orgId,
    project_id: projectId,
    title: existing?.title ?? `${projectName} Contract`,
    status: existing?.status ?? "active",
    contract_type: contractType,
    total_cents: revisedTotalCents,
    currency: existing?.currency ?? "usd",
    markup_percent: isFixedPrice || isFixedFee ? null : input.markup_percent ?? existing?.markup_percent ?? 0,
    gmp_cents: billingModel === "cost_plus_gmp" ? input.gmp_cents ?? existing?.gmp_cents ?? null : null,
    contingency_cents:
      billingModel === "cost_plus_gmp"
        ? input.contingency_cents ?? existing?.contingency_cents ?? existing?.snapshot?.contingency_cents ?? null
        : null,
    fixed_fee_cents: isFixedFee ? input.fixed_fee_cents ?? existing?.fixed_fee_cents ?? existing?.snapshot?.fixed_fee_cents ?? null : null,
    fee_presentation: feePresentation,
    savings_split_owner_pct: billingModel === "cost_plus_gmp" ? input.savings_split_owner_pct ?? existing?.savings_split_owner_pct ?? 0 : 0,
    savings_split_builder_pct: billingModel === "cost_plus_gmp" ? input.savings_split_builder_pct ?? existing?.savings_split_builder_pct ?? 0 : 0,
    labor_burden_multiplier: input.labor_burden_multiplier ?? existing?.labor_burden_multiplier ?? 1,
    rate_schedule_id: billingModel === "time_and_materials" ? input.rate_schedule_id ?? existing?.rate_schedule_id ?? null : null,
    requires_client_cost_approval: input.requires_client_cost_approval ?? existing?.requires_client_cost_approval ?? false,
    open_book: input.open_book ?? existing?.open_book ?? true,
    retainage_percent: input.retainage_percent ?? existing?.retainage_percent ?? 0,
    retainage_applies_to_fee:
      input.retainage_applies_to_fee ?? existing?.retainage_applies_to_fee ?? existing?.snapshot?.retainage_applies_to_fee ?? false,
    retainage_schedule: isFixedPrice ? input.retainage_schedule ?? existing?.retainage_schedule ?? null : null,
    stored_materials_retainage_percent: isFixedPrice
      ? input.stored_materials_retainage_percent ?? existing?.stored_materials_retainage_percent ?? null
      : null,
    snapshot: {
      ...nextSnapshotBase,
      billing_setup_source: "project_settings",
      base_total_cents: baseTotalCents,
      approved_change_orders_cents: approvedChangeOrdersCents,
      revised_total_cents: revisedTotalCents,
      fee_presentation: feePresentation,
      rate_schedule_id: billingModel === "time_and_materials" ? input.rate_schedule_id ?? existing?.rate_schedule_id ?? null : null,
      paid_costs_required: input.paid_costs_required ?? existing?.snapshot?.paid_costs_required ?? false,
      proof_required: input.proof_required ?? existing?.snapshot?.proof_required ?? false,
      retainage_applies_to_fee:
        input.retainage_applies_to_fee ?? existing?.retainage_applies_to_fee ?? existing?.snapshot?.retainage_applies_to_fee ?? false,
    },
  }

  return { billingModel, contract: payload }
}

const BILLING_INPUT_KEYS: ReadonlyArray<keyof ProjectInput> = [
  "contract_type",
  "billing_model",
  "markup_percent",
  "gmp_cents",
  "contingency_cents",
  "fixed_fee_cents",
  "fee_presentation",
  "savings_split_owner_pct",
  "savings_split_builder_pct",
  "labor_burden_multiplier",
  "rate_schedule_id",
  "requires_client_cost_approval",
  "open_book",
  "paid_costs_required",
  "proof_required",
  "cost_codes_enabled",
  "retainage_percent",
  "retainage_applies_to_fee",
  "fixed_price_billing_basis",
  "retainage_schedule",
  "stored_materials_retainage_percent",
  "total_contract_value_cents",
]

function hasBillingInput(input: Partial<ProjectInput>) {
  return BILLING_INPUT_KEYS.some((key) => Object.prototype.hasOwnProperty.call(input, key))
}

/**
 * Whether creating a project opens a project-settings billing contract.
 *
 * A production home earns its revenue through the purchase agreement its buyer
 * signs, so it opens without one unless the caller sets billing terms itself:
 * a placeholder fixed-price contract beside the agreement gives the home two
 * primary contracts that earn differently, and Books refuses to post to it or
 * adopt it as inventory until someone approves a policy for each. Residential
 * and commercial jobs always open one; their contract IS the project's terms.
 */
function opensProjectSettingsContract(posture: ProjectPosture, callerInput: Partial<ProjectInput>) {
  return !isProductionProjectPosture(posture) || hasBillingInput(callerInput)
}

/**
 * The billing contract a new project opens with, or null when its posture
 * earns revenue elsewhere. Every path that creates a home (createProject, the
 * start desk, reservation conversion) asks here, so a production home never
 * opens a placeholder beside its purchase agreement. `callerInput` is what the
 * caller supplied, not the normalized input, which always carries retainage.
 */
export function prepareProjectOpeningContract({ callerInput, input, productTier, orgId, projectId, projectName }: {
  callerInput: Partial<ProjectInput>
  input: Partial<ProjectInput>
  productTier: OrgServiceContext["productTier"]
  orgId: string
  projectId: string
  projectName: string
}) {
  const posture = getProjectPosture(input.property_type, productTier)
  if (!opensProjectSettingsContract(posture, callerInput)) return null
  return prepareProjectBillingContract({ input, orgId, projectId, projectName }).contract
}

async function upsertProjectBillingContract({
  supabase,
  orgId,
  userId,
  projectId,
  projectName,
  input,
}: {
  supabase: SupabaseClient
  orgId: string
  userId: string
  projectId: string
  projectName: string
  input: Partial<ProjectInput>
}) {
  if (!hasBillingInput(input)) return

  const ownerPct = input.savings_split_owner_pct ?? 0
  const builderPct = input.savings_split_builder_pct ?? 0
  if (ownerPct + builderPct > 100) {
    throw new Error("Savings split percentages cannot exceed 100%.")
  }

  const [existingResult, existingSettings] = await Promise.all([
    supabase
      .from("contracts")
      .select("*")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    getProjectFinancialSettings({ supabase, orgId, projectId }).catch(() => null),
  ])

  if (existingResult.error) {
    throw new Error(`Failed to load project billing contract: ${existingResult.error.message}`)
  }

  const existing = existingResult.data
  const { billingModel, contract: payload } = prepareProjectBillingContract({
    input, existing, existingSettings, orgId, projectId, projectName,
  })

  const contractSave = await saveBillingContractWithAmendment({
    supabase,
    orgId,
    userId,
    projectId,
    existingContract: existing,
    existingSettings,
    nextBillingModel: billingModel,
    contractPayload: payload,
    auditSource: "project_settings",
  })

  await upsertProjectFinancialSettingsFromProjectInput({
    supabase,
    orgId,
    projectId,
    userId,
    input,
    existingContract: contractSave.contract,
  })
}

export async function archiveProject(projectId: string, orgId?: string, context?: OrgServiceContext) {
  return updateProject({
    projectId,
    orgId,
    context,
    input: { status: "cancelled" },
  })
}

export async function deleteProject(projectId: string, orgId?: string, context?: OrgServiceContext) {
  const { supabase, orgId: resolvedOrgId, userId } = context || await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })

  const { error } = await supabase
    .from("projects")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("id", projectId)

  if (error) {
    throw new Error(`Failed to delete project: ${error.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "delete",
    entityType: "project",
    entityId: projectId,
    before: { id: projectId },
    after: null,
  })
}
