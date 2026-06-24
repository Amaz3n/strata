import type { SupabaseClient } from "@supabase/supabase-js"

import type { Contract, Project } from "@/lib/types"
import type { ProjectInput } from "@/lib/validation/projects"
import { projectUpdateSchema } from "@/lib/validation/projects"
import { recordEvent } from "@/lib/services/events"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext, type OrgServiceContext } from "@/lib/services/context"
import { hasPermission, requirePermission } from "@/lib/services/permissions"
import { ensureDefaultProjectFolders } from "@/lib/services/files"
import type { ProjectBillingModel } from "@/lib/financials/billing-model"
import { upsertProjectFinancialSettingsFromProjectInput } from "@/lib/services/project-financial-setup"

function contractTypeForBillingModel(model?: ProjectBillingModel | null): "fixed" | "cost_plus" | "time_materials" {
  if (model === "time_and_materials") return "time_materials"
  if (model === "cost_plus_percent" || model === "cost_plus_fixed_fee" || model === "cost_plus_gmp") return "cost_plus"
  return "fixed"
}

function billingModelForContractInput(input: Partial<ProjectInput>, existing?: any): ProjectBillingModel {
  if (input.billing_model) return input.billing_model as ProjectBillingModel
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

function mapProject(row: any): Project {
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
    project_type: row.project_type ?? undefined,
    description: row.description ?? undefined,
    total_value: row.total_value ?? undefined,
    qbo_class_id: row.qbo_class_id ?? null,
    qbo_class_name: row.qbo_class_name ?? null,
    qbo_customer_id: row.qbo_customer_id ?? null,
    qbo_customer_name: row.qbo_customer_name ?? null,
    excluded_from_reporting: row.excluded_from_reporting ?? false,
    financial_settings: row.project_financial_settings?.[0] ?? null,
    billing_contract: billingContractRow ? mapProjectBillingContract(billingContractRow) : null,
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
    savings_split_owner_pct: row.savings_split_owner_pct != null ? Number(row.savings_split_owner_pct) : undefined,
    savings_split_builder_pct: row.savings_split_builder_pct != null ? Number(row.savings_split_builder_pct) : undefined,
    labor_burden_multiplier: row.labor_burden_multiplier != null ? Number(row.labor_burden_multiplier) : undefined,
    requires_client_cost_approval: row.requires_client_cost_approval ?? undefined,
    open_book: row.open_book ?? undefined,
    retainage_percent: row.retainage_percent != null ? Number(row.retainage_percent) : undefined,
    retainage_release_trigger: row.retainage_release_trigger ?? undefined,
    terms: row.terms ?? undefined,
    effective_date: row.effective_date ?? undefined,
    signed_at: row.signed_at ?? undefined,
    signature_data: row.signature_data ?? undefined,
    snapshot: row.snapshot ?? {},
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

const PROJECT_SELECT = `
  id, org_id, name, status, start_date, end_date, location, client_id, prospect_id, property_type, project_type, description, total_value, qbo_class_id, qbo_class_name, qbo_customer_id, qbo_customer_name, excluded_from_reporting, created_at, updated_at,
  project_financial_settings(id, org_id, project_id, billing_model, paid_costs_required, proof_required, client_cost_approval_required, open_book_required, cost_codes_enabled, setup_completed_at, metadata),
  contracts(id, org_id, project_id, proposal_id, number, title, status, contract_type, total_cents, currency, markup_percent, gmp_cents, savings_split_owner_pct, savings_split_builder_pct, labor_burden_multiplier, requires_client_cost_approval, open_book, retainage_percent, retainage_release_trigger, terms, effective_date, signed_at, signature_data, snapshot, created_at, updated_at)
`

export async function listProjects(orgId?: string, context?: OrgServiceContext): Promise<Project[]> {
  const { supabase, orgId: resolvedOrgId, userId } = context || await requireOrgContext(orgId)
  const canSeeAllProjects =
    (await hasPermission("project.read", { supabase, orgId: resolvedOrgId, userId })) ||
    (await hasPermission("project.manage", { supabase, orgId: resolvedOrgId, userId }))

  if (canSeeAllProjects) {
    return listProjectsWithClient(supabase, resolvedOrgId)
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

  return (data ?? [])
    .map((row: any) => (Array.isArray(row.project) ? row.project[0] : row.project))
    .filter(Boolean)
    .map(mapProject)
}

export async function listProjectsWithClient(supabase: SupabaseClient, orgId: string): Promise<Project[]> {
  const { data, error } = await supabase
    .from("projects")
    .select(PROJECT_SELECT)
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to list projects: ${error.message}`)
  }

  return (data ?? []).map(mapProject)
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

  return mapProject(data)
}

export async function createProject({ input, orgId, context }: { input: ProjectInput; orgId?: string; context?: OrgServiceContext }) {
  const { supabase, orgId: resolvedOrgId, userId } = context || await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })

  const payload = {
    org_id: resolvedOrgId,
    name: input.name,
    status: input.status ?? "active",
    start_date: input.start_date || null,
    end_date: input.end_date || null,
    location: input.location ?? (input.address ? { address: input.address } : null),
    client_id: input.client_id ?? null,
    property_type: input.property_type,
    project_type: input.project_type,
    description: input.description,
    total_value: typeof input.total_value === "number" ? Math.round(input.total_value) : input.total_value,
    qbo_class_id: input.qbo_class_id?.trim() || null,
    qbo_class_name: input.qbo_class_name?.trim() || null,
    qbo_customer_id: input.qbo_customer_id?.trim() || null,
    qbo_customer_name: input.qbo_customer_name?.trim() || null,
    created_by: userId,
    prospect_id: input.prospect_id || null,
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
    payload: { name: input.name },
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
    input,
  })

  // Keep project documents structured from day one.
  await ensureDefaultProjectFolders(data.id as string, resolvedOrgId).catch((error) => {
    console.warn("Failed to seed default project folders:", error)
  })

  return mapProject(data)
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
    qbo_class_id: projectNullableValue<string>(parsed, "qbo_class_id", existing.data.qbo_class_id),
    qbo_class_name: projectNullableValue<string>(parsed, "qbo_class_name", existing.data.qbo_class_name),
    qbo_customer_id: projectNullableValue<string>(parsed, "qbo_customer_id", existing.data.qbo_customer_id),
    qbo_customer_name: projectNullableValue<string>(parsed, "qbo_customer_name", existing.data.qbo_customer_name),
    excluded_from_reporting: parsed.excluded_from_reporting ?? existing.data.excluded_from_reporting ?? false,
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

  return mapProject(data)
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
    "fixed_fee_cents",
    "savings_split_owner_pct",
    "savings_split_builder_pct",
    "labor_burden_multiplier",
    "requires_client_cost_approval",
    "open_book",
    "paid_costs_required",
    "proof_required",
    "cost_codes_enabled",
    "retainage_percent",
    "total_contract_value_cents",
  ]
  const hasBillingInput = billingKeys.some((key) => Object.prototype.hasOwnProperty.call(input, key))
  if (!hasBillingInput) return

  const ownerPct = input.savings_split_owner_pct ?? 0
  const builderPct = input.savings_split_builder_pct ?? 0
  if (ownerPct + builderPct > 100) {
    throw new Error("Savings split percentages cannot exceed 100%.")
  }

  const { data: existing, error: existingError } = await supabase
    .from("contracts")
    .select("*")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existingError) {
    throw new Error(`Failed to load project billing contract: ${existingError.message}`)
  }

  const billingModel = billingModelForContractInput(input, existing)
  const contractType = input.billing_model ? contractTypeForBillingModel(billingModel) : input.contract_type ?? contractTypeForBillingModel(billingModel)
  const isFixedPrice = billingModel === "fixed_price"
  const isFixedFee = billingModel === "cost_plus_fixed_fee"
  const existingSnapshot = (existing?.snapshot ?? {}) as Record<string, any>
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
    savings_split_owner_pct: billingModel === "cost_plus_gmp" ? input.savings_split_owner_pct ?? existing?.savings_split_owner_pct ?? 0 : 0,
    savings_split_builder_pct: billingModel === "cost_plus_gmp" ? input.savings_split_builder_pct ?? existing?.savings_split_builder_pct ?? 0 : 0,
    labor_burden_multiplier: input.labor_burden_multiplier ?? existing?.labor_burden_multiplier ?? 1,
    requires_client_cost_approval: input.requires_client_cost_approval ?? existing?.requires_client_cost_approval ?? false,
    open_book: input.open_book ?? existing?.open_book ?? true,
    retainage_percent: input.retainage_percent ?? existing?.retainage_percent ?? 0,
    snapshot: {
      ...existingSnapshot,
      billing_setup_source: "project_settings",
      billing_model: billingModel,
      base_total_cents: baseTotalCents,
      approved_change_orders_cents: approvedChangeOrdersCents,
      revised_total_cents: revisedTotalCents,
      fixed_fee_cents: isFixedFee ? input.fixed_fee_cents ?? existing?.snapshot?.fixed_fee_cents ?? null : null,
      paid_costs_required: input.paid_costs_required ?? existing?.snapshot?.paid_costs_required ?? false,
      proof_required: input.proof_required ?? existing?.snapshot?.proof_required ?? false,
    },
  }

  if (existing?.id) {
    const { data, error } = await supabase
      .from("contracts")
      .update(payload)
      .eq("org_id", orgId)
      .eq("id", existing.id)
      .select("*")
      .single()

    if (error || !data) {
      throw new Error(`Failed to update project billing contract: ${error?.message}`)
    }

    await upsertProjectFinancialSettingsFromProjectInput({
      supabase,
      orgId,
      projectId,
      userId,
      input,
      existingContract: data,
    })

    await recordAudit({
      orgId,
      actorId: userId,
      action: "update",
      entityType: "contract",
      entityId: existing.id,
      before: existing,
      after: data,
    })
    return
  }

  const { data, error } = await supabase.from("contracts").insert(payload).select("*").single()
  if (error || !data) {
    throw new Error(`Failed to create project billing contract: ${error?.message}`)
  }

  await upsertProjectFinancialSettingsFromProjectInput({
    supabase,
    orgId,
    projectId,
    userId,
    input,
    existingContract: data,
  })

  await recordAudit({
    orgId,
    actorId: userId,
    action: "insert",
    entityType: "contract",
    entityId: data.id,
    after: data,
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
