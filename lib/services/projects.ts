import type { SupabaseClient } from "@supabase/supabase-js"

import type { Contract, Project, ProjectNavigationItem } from "@/lib/types"
import type { ProjectInput } from "@/lib/validation/projects"
import { projectUpdateSchema } from "@/lib/validation/projects"
import { recordEvent } from "@/lib/services/events"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext, type OrgServiceContext } from "@/lib/services/context"
import { hasPermission, requirePermission } from "@/lib/services/permissions"
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
import { getDefaultProjectPropertyType, getProjectPosture } from "@/lib/product-tier"
import { getDivisionScopedProjectIds } from "@/lib/services/authorization"

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

const PROJECT_SELECT = `
  id, org_id, name, status, start_date, end_date, location, client_id, prospect_id, property_type, project_type, division_id, superintendent_id, description, total_value, retainage_percent, total_contract_value_cents, excluded_from_reporting, is_public_work, require_subtier_waivers, created_at, updated_at,
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
  const dimensions = { ...((existing?.dimensions as ProjectAccountingDimensions | null) ?? {}) }
  if (params.classId !== undefined || params.className !== undefined) {
    if (params.classId) dimensions.class = { id: params.classId, name: params.className ?? null }
    else delete dimensions.class
  }
  if (params.customerId !== undefined || params.customerName !== undefined) {
    if (params.customerId) dimensions.customer = { id: params.customerId, name: params.customerName ?? null }
    else delete dimensions.customer
  }
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

export async function listProjects(orgId?: string, context?: OrgServiceContext): Promise<Project[]> {
  const { supabase, orgId: resolvedOrgId, userId } = context || await requireOrgContext(orgId)
  const divisionProjectIds = await getDivisionScopedProjectIds({ orgId: resolvedOrgId, userId, supabase })
  if (divisionProjectIds?.length === 0) return []

  // Members scoped to "assigned" only see projects they explicitly belong to,
  // regardless of an org-level project.read/manage grant.
  const { data: scopeRows } = await supabase
    .from("memberships")
    .select("project_scope")
    .eq("org_id", resolvedOrgId)
    .eq("user_id", userId)
    .eq("status", "active")
  const assignedOnly = (scopeRows ?? []).some((row) => (row as { project_scope?: string }).project_scope === "assigned")

  const canSeeAllProjects =
    !assignedOnly &&
    ((await hasPermission("project.read", { supabase, orgId: resolvedOrgId, userId })) ||
      (await hasPermission("project.manage", { supabase, orgId: resolvedOrgId, userId })))

  if (canSeeAllProjects) {
    return listProjectsWithClient(supabase, resolvedOrgId, divisionProjectIds)
  }

  const { data, error } = await supabase
    .from("project_members")
    .select(`
      project:projects!inner(${PROJECT_SELECT})
    `)
    .eq("org_id", resolvedOrgId)
    .eq("user_id", userId)
    .eq("status", "active")

  if (error) {
    throw new Error(`Failed to list assigned projects: ${error.message}`)
  }

  const rows = (data ?? [])
    .map((row: any) => (Array.isArray(row.project) ? row.project[0] : row.project))
    .filter((row) => Boolean(row) && (!divisionProjectIds || divisionProjectIds.includes(row.id)))
  return mapProjectsWithAccounting(supabase, resolvedOrgId, rows)
}

export async function listProjectsWithClient(supabase: SupabaseClient, orgId: string, projectIds: string[] | null = null): Promise<Project[]> {
  let query = supabase
    .from("projects")
    .select(PROJECT_SELECT)
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
  if (projectIds) query = query.in("id", projectIds)
  const { data, error } = await query

  if (error) {
    throw new Error(`Failed to list projects: ${error.message}`)
  }

  return mapProjectsWithAccounting(supabase, orgId, data ?? [])
}

export async function listProjectNavigationItemsWithClient(
  supabase: SupabaseClient,
  orgId: string,
): Promise<ProjectNavigationItem[]> {
  const { data, error } = await supabase
    .from("projects")
    .select(`
      id, org_id, name, status, property_type, created_at, updated_at,
      project_financial_settings(project_id, billing_model),
      project_module_overrides(module_key, enabled)
    `)
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to list project navigation items: ${error.message}`)
  }

  return (data ?? []).map(mapProjectNavigationItem)
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

  const propertyType = input.property_type ?? getDefaultProjectPropertyType(productTier)
  const retainagePercent =
    input.retainage_percent ?? (getProjectPosture(propertyType, productTier) === "commercial" ? 10 : 0)
  const normalizedInput: ProjectInput = {
    ...input,
    property_type: propertyType,
    retainage_percent: retainagePercent,
  }

  const payload = {
    org_id: resolvedOrgId,
    name: normalizedInput.name,
    status: normalizedInput.status ?? "active",
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

  const { data, error } = await supabase
    .from("projects")
    .insert(payload)
    .select(PROJECT_SELECT)
    .single()

  if (error) {
    throw new Error(`Failed to create project: ${error.message}`)
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

  await upsertProjectBillingContract({
    supabase,
    orgId: resolvedOrgId,
    userId,
    projectId: data.id as string,
    projectName: data.name,
    input: normalizedInput,
  })

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
  const billingKeys: Array<keyof ProjectInput> = [
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
  const hasBillingInput = billingKeys.some((key) => Object.prototype.hasOwnProperty.call(input, key))
  if (!hasBillingInput) return

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
  const billingModel = billingModelForContractInput(input, existing, existingSettings)
  const contractType = input.billing_model ? contractTypeForBillingModel(billingModel) : input.contract_type ?? contractTypeForBillingModel(billingModel)
  const isFixedPrice = billingModel === "fixed_price"
  const isFixedFee = billingModel === "cost_plus_fixed_fee"
  const feePresentation =
    normalizeFeePresentation(input.fee_presentation) ??
    normalizeFeePresentation(existing?.fee_presentation) ??
    normalizeFeePresentation(existing?.snapshot?.fee_presentation) ??
    (existing ? "embedded" : defaultFeePresentationForBillingModel(billingModel))
  const existingSnapshot = (existing?.snapshot ?? {}) as Record<string, any>
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
