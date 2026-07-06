import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import { normalizeFeePresentation, resolveProjectBillingModel } from "@/lib/financials/billing-model"
import { requireAuthorization } from "@/lib/services/authorization"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import {
  getProjectFinancialSettings,
  saveBillingContractWithAmendment,
} from "@/lib/services/project-financial-setup"

export type BillingRateKind = "labor_role" | "person" | "equipment" | "material"
export type BillingRateUnit = "hour" | "day" | "each"

export interface BillingRateSchedule {
  id: string
  org_id: string
  name: string
  description?: string | null
  status: "draft" | "active" | "archived"
  created_at: string
  updated_at: string
  rates: BillingRate[]
}

export interface BillingRate {
  id: string
  org_id: string
  schedule_id: string
  kind: BillingRateKind
  role_name?: string | null
  user_id?: string | null
  user_name?: string | null
  equipment_name?: string | null
  cost_code_id?: string | null
  cost_code_code?: string | null
  cost_code_name?: string | null
  rate_cents?: number | null
  markup_percent?: number | null
  ot_multiplier: number
  dt_multiplier: number
  unit: BillingRateUnit
  effective_from: string
  effective_to?: string | null
  metadata: Record<string, any>
  created_at: string
}

export interface BillingRateOverride extends Omit<BillingRate, "schedule_id"> {
  project_id: string
  project_name?: string | null
  contract_id?: string | null
  contract_label?: string | null
  schedule_id?: string | null
}

export interface TimeAndMaterialsRateResolution {
  rateCents: number
  unit: BillingRateUnit
  otMultiplier: number
  dtMultiplier: number
  source: "project_override" | "schedule_person" | "schedule_role" | "membership_fallback" | "none"
  scheduleId?: string | null
  rateId?: string | null
  overrideId?: string | null
  roleName?: string | null
  billQuantity: number
  multiplier: number
  billableCents: number
}

export interface TimeAndMaterialsMaterialMarkupResolution {
  percent: number
  source: "tm_project_override" | "tm_material_schedule"
  scheduleId?: string | null
  rateId?: string | null
  overrideId?: string | null
}

const dateInput = z.coerce.date()

export const billingRateScheduleInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000).optional().nullable(),
  status: z.enum(["draft", "active", "archived"]).default("active"),
})

export const billingRateInputSchema = z.object({
  scheduleId: z.string().uuid(),
  kind: z.enum(["labor_role", "person", "equipment", "material"]),
  roleName: z.string().trim().max(120).optional().nullable(),
  userId: z.string().uuid().optional().nullable(),
  equipmentName: z.string().trim().max(160).optional().nullable(),
  costCodeId: z.string().uuid().optional().nullable(),
  rateCents: z.number().int().min(0).optional().nullable(),
  markupPercent: z.number().min(0).max(300).optional().nullable(),
  otMultiplier: z.number().min(1).max(4).default(1.5),
  dtMultiplier: z.number().min(1).max(4).default(2),
  unit: z.enum(["hour", "day", "each"]).default("hour"),
  effectiveFrom: dateInput.optional().nullable(),
  effectiveTo: dateInput.optional().nullable(),
})

export const billingRateOverrideInputSchema = billingRateInputSchema
  .omit({ scheduleId: true })
  .extend({
    projectId: z.string().uuid(),
    contractId: z.string().uuid().optional().nullable(),
    scheduleId: z.string().uuid().optional().nullable(),
  })

export const assignBillingRateScheduleInputSchema = z.object({
  projectId: z.string().uuid(),
  rateScheduleId: z.string().uuid().optional().nullable(),
})

export type BillingRateScheduleInput = z.infer<typeof billingRateScheduleInputSchema>
export type BillingRateInput = z.infer<typeof billingRateInputSchema>
export type BillingRateOverrideInput = z.infer<typeof billingRateOverrideInputSchema>
export type AssignBillingRateScheduleInput = z.infer<typeof assignBillingRateScheduleInputSchema>

function toDateOnly(value?: Date | string | null) {
  if (!value) return new Date().toISOString().slice(0, 10)
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return value.slice(0, 10)
}

function normalizeLookup(value?: string | null) {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^org[\s_-]+/i, "")
    .replace(/[\s_-]+/g, " ")
}

function validateRateTarget(input: {
  kind: BillingRateKind
  roleName?: string | null
  userId?: string | null
  equipmentName?: string | null
  rateCents?: number | null
  markupPercent?: number | null
}) {
  if (input.kind === "labor_role" && !input.roleName?.trim()) {
    throw new Error("Role rates need a role name.")
  }
  if (input.kind === "person" && !input.userId) {
    throw new Error("Person rates need a team member.")
  }
  if (input.kind === "equipment" && !input.equipmentName?.trim()) {
    throw new Error("Equipment rates need an equipment name.")
  }
  if (input.kind === "material" && input.rateCents == null && input.markupPercent == null) {
    throw new Error("Material rates need a rate or markup percent.")
  }
  if (input.kind !== "material" && input.rateCents == null) {
    throw new Error("Labor and equipment rates need a bill rate.")
  }
}

function mapRate(row: any): BillingRate {
  const user = Array.isArray(row.user) ? row.user[0] : row.user
  const costCode = Array.isArray(row.cost_code) ? row.cost_code[0] : row.cost_code
  return {
    id: row.id,
    org_id: row.org_id,
    schedule_id: row.schedule_id,
    kind: row.kind,
    role_name: row.role_name ?? null,
    user_id: row.user_id ?? null,
    user_name: user?.full_name ?? user?.email ?? null,
    equipment_name: row.equipment_name ?? null,
    cost_code_id: row.cost_code_id ?? null,
    cost_code_code: costCode?.code ?? null,
    cost_code_name: costCode?.name ?? null,
    rate_cents: row.rate_cents ?? null,
    markup_percent: row.markup_percent == null ? null : Number(row.markup_percent),
    ot_multiplier: Number(row.ot_multiplier ?? 1.5),
    dt_multiplier: Number(row.dt_multiplier ?? 2),
    unit: row.unit ?? "hour",
    effective_from: row.effective_from,
    effective_to: row.effective_to ?? null,
    metadata: row.metadata ?? {},
    created_at: row.created_at,
  }
}

function mapOverride(row: any): BillingRateOverride {
  const project = Array.isArray(row.project) ? row.project[0] : row.project
  const contract = Array.isArray(row.contract) ? row.contract[0] : row.contract
  const contractLabel = [contract?.number, contract?.title].filter(Boolean).join(" ")
  return {
    ...mapRate({ ...row, schedule_id: row.schedule_id ?? "" }),
    project_id: row.project_id,
    project_name: project?.name ?? null,
    contract_id: row.contract_id ?? null,
    contract_label: contractLabel || null,
    schedule_id: row.schedule_id ?? null,
  }
}

async function requireOrgMember(args: {
  supabase: SupabaseClient
  orgId: string
  userId: string
  resourceType: string
}) {
  await requireAuthorization({
    permission: "org.member",
    userId: args.userId,
    orgId: args.orgId,
    supabase: args.supabase,
    logDecision: true,
    resourceType: args.resourceType,
  })
}

async function requireOrgAdmin(args: {
  supabase: SupabaseClient
  orgId: string
  userId: string
  resourceType: string
  resourceId?: string
}) {
  await requireAuthorization({
    permission: "org.admin",
    userId: args.userId,
    orgId: args.orgId,
    supabase: args.supabase,
    logDecision: true,
    resourceType: args.resourceType,
    resourceId: args.resourceId,
  })
}

export async function listBillingRateSchedules(orgId?: string): Promise<BillingRateSchedule[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireOrgMember({ supabase, orgId: resolvedOrgId, userId, resourceType: "billing_rate_schedule" })

  const [schedulesResult, ratesResult] = await Promise.all([
    supabase
      .from("billing_rate_schedules")
      .select("*")
      .eq("org_id", resolvedOrgId)
      .order("status", { ascending: true })
      .order("name", { ascending: true }),
    supabase
      .from("billing_rates")
      .select("*, user:app_users(id, full_name, email), cost_code:cost_codes(id, code, name)")
      .eq("org_id", resolvedOrgId)
      .order("kind", { ascending: true })
      .order("effective_from", { ascending: false }),
  ])

  if (schedulesResult.error) throw new Error(`Failed to load rate schedules: ${schedulesResult.error.message}`)
  if (ratesResult.error) throw new Error(`Failed to load billing rates: ${ratesResult.error.message}`)

  const ratesBySchedule = new Map<string, BillingRate[]>()
  for (const row of ratesResult.data ?? []) {
    const rates = ratesBySchedule.get(row.schedule_id) ?? []
    rates.push(mapRate(row))
    ratesBySchedule.set(row.schedule_id, rates)
  }

  return (schedulesResult.data ?? []).map((row: any) => ({
    id: row.id,
    org_id: row.org_id,
    name: row.name,
    description: row.description ?? null,
    status: row.status ?? "active",
    created_at: row.created_at,
    updated_at: row.updated_at,
    rates: ratesBySchedule.get(row.id) ?? [],
  }))
}

export async function listBillingRateOverrides(orgId?: string): Promise<BillingRateOverride[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireOrgMember({ supabase, orgId: resolvedOrgId, userId, resourceType: "billing_rate_override" })

  const { data, error } = await supabase
    .from("billing_rate_overrides")
    .select("*, user:app_users(id, full_name, email), cost_code:cost_codes(id, code, name), project:projects(id, name), contract:contracts(id, title, number)")
    .eq("org_id", resolvedOrgId)
    .order("created_at", { ascending: false })

  if (error) throw new Error(`Failed to load project rate overrides: ${error.message}`)
  return (data ?? []).map(mapOverride)
}

export async function createBillingRateSchedule(
  input: BillingRateScheduleInput,
  orgId?: string,
): Promise<BillingRateSchedule> {
  const parsed = billingRateScheduleInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireOrgAdmin({ supabase, orgId: resolvedOrgId, userId, resourceType: "billing_rate_schedule" })

  const payload = {
    org_id: resolvedOrgId,
    name: parsed.name,
    description: parsed.description ?? null,
    status: parsed.status,
    created_by: userId,
    updated_by: userId,
  }

  const { data, error } = await supabase.from("billing_rate_schedules").insert(payload).select("*").single()
  if (error || !data) throw new Error(`Failed to create rate schedule: ${error?.message}`)

  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "billing_rate_schedule", entityId: data.id, after: data })
  await recordEvent({ orgId: resolvedOrgId, eventType: "billing_rate_schedule_created", entityType: "billing_rate_schedule", entityId: data.id, payload: { name: data.name } })

  return { ...data, rates: [] } as BillingRateSchedule
}

export async function archiveBillingRateSchedule(scheduleId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireOrgAdmin({ supabase, orgId: resolvedOrgId, userId, resourceType: "billing_rate_schedule", resourceId: scheduleId })

  const { data: before, error: beforeError } = await supabase
    .from("billing_rate_schedules")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", scheduleId)
    .maybeSingle()
  if (beforeError || !before) throw new Error("Rate schedule not found")

  const { data, error } = await supabase
    .from("billing_rate_schedules")
    .update({ status: "archived", updated_by: userId })
    .eq("org_id", resolvedOrgId)
    .eq("id", scheduleId)
    .select("*")
    .single()
  if (error || !data) throw new Error(`Failed to archive rate schedule: ${error?.message}`)

  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "billing_rate_schedule", entityId: scheduleId, before, after: data })
}

export async function createBillingRate(input: BillingRateInput, orgId?: string): Promise<BillingRate> {
  const parsed = billingRateInputSchema.parse(input)
  validateRateTarget(parsed)

  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireOrgAdmin({ supabase, orgId: resolvedOrgId, userId, resourceType: "billing_rate" })

  const { data: schedule, error: scheduleError } = await supabase
    .from("billing_rate_schedules")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("id", parsed.scheduleId)
    .maybeSingle()
  if (scheduleError || !schedule) throw new Error("Rate schedule not found")

  const payload = ratePayload(resolvedOrgId, parsed)
  const { data, error } = await supabase
    .from("billing_rates")
    .insert(payload)
    .select("*, user:app_users(id, full_name, email), cost_code:cost_codes(id, code, name)")
    .single()
  if (error || !data) throw new Error(`Failed to create billing rate: ${error?.message}`)

  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "billing_rate", entityId: data.id, after: data })
  await recordEvent({ orgId: resolvedOrgId, eventType: "billing_rate_created", entityType: "billing_rate", entityId: data.id, payload: { schedule_id: parsed.scheduleId, kind: parsed.kind } })
  return mapRate(data)
}

export async function deleteBillingRate(rateId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireOrgAdmin({ supabase, orgId: resolvedOrgId, userId, resourceType: "billing_rate", resourceId: rateId })

  const { data: before, error: beforeError } = await supabase
    .from("billing_rates")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", rateId)
    .maybeSingle()
  if (beforeError || !before) throw new Error("Billing rate not found")

  const { error } = await supabase.from("billing_rates").delete().eq("org_id", resolvedOrgId).eq("id", rateId)
  if (error) throw new Error(`Failed to delete billing rate: ${error.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "delete", entityType: "billing_rate", entityId: rateId, before })
}

export async function createBillingRateOverride(
  input: BillingRateOverrideInput,
  orgId?: string,
): Promise<BillingRateOverride> {
  const parsed = billingRateOverrideInputSchema.parse(input)
  validateRateTarget(parsed)

  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "project.manage",
    userId,
    orgId: resolvedOrgId,
    projectId: parsed.projectId,
    supabase,
    logDecision: true,
    resourceType: "billing_rate_override",
  })

  const payload = {
    ...ratePayload(resolvedOrgId, { ...parsed, scheduleId: parsed.scheduleId ?? "" }),
    project_id: parsed.projectId,
    contract_id: parsed.contractId ?? null,
    schedule_id: parsed.scheduleId ?? null,
  }
  const { data, error } = await supabase
    .from("billing_rate_overrides")
    .insert(payload)
    .select("*, user:app_users(id, full_name, email), cost_code:cost_codes(id, code, name)")
    .single()
  if (error || !data) throw new Error(`Failed to create project rate override: ${error?.message}`)

  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "billing_rate_override", entityId: data.id, after: data })
  await recordEvent({ orgId: resolvedOrgId, eventType: "billing_rate_override_created", entityType: "billing_rate_override", entityId: data.id, payload: { project_id: parsed.projectId, kind: parsed.kind } })
  return mapOverride(data)
}

export async function deleteBillingRateOverride(overrideId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const { data: before, error: beforeError } = await supabase
    .from("billing_rate_overrides")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", overrideId)
    .maybeSingle()
  if (beforeError || !before) throw new Error("Project rate override not found")

  await requireAuthorization({
    permission: "project.manage",
    userId,
    orgId: resolvedOrgId,
    projectId: before.project_id,
    supabase,
    logDecision: true,
    resourceType: "billing_rate_override",
    resourceId: overrideId,
  })

  const { error } = await supabase.from("billing_rate_overrides").delete().eq("org_id", resolvedOrgId).eq("id", overrideId)
  if (error) throw new Error(`Failed to delete project rate override: ${error.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "delete", entityType: "billing_rate_override", entityId: overrideId, before })
}

export async function assignBillingRateScheduleToProject(
  input: AssignBillingRateScheduleInput,
  orgId?: string,
) {
  const parsed = assignBillingRateScheduleInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "project.manage",
    userId,
    orgId: resolvedOrgId,
    projectId: parsed.projectId,
    supabase,
    logDecision: true,
    resourceType: "billing_rate_schedule_assignment",
  })

  if (parsed.rateScheduleId) {
    const { data: schedule, error: scheduleError } = await supabase
      .from("billing_rate_schedules")
      .select("id, status")
      .eq("org_id", resolvedOrgId)
      .eq("id", parsed.rateScheduleId)
      .maybeSingle()
    if (scheduleError || !schedule) throw new Error("Rate schedule not found.")
    if (schedule.status === "archived") throw new Error("Archived rate schedules cannot be assigned to projects.")
  }

  const [projectResult, contractResult, existingSettings] = await Promise.all([
    supabase
      .from("projects")
      .select("id, name")
      .eq("org_id", resolvedOrgId)
      .eq("id", parsed.projectId)
      .maybeSingle(),
    supabase
      .from("contracts")
      .select("id, title, contract_type, total_cents, currency, markup_percent, gmp_cents, contingency_cents, fixed_fee_cents, fee_presentation, savings_split_owner_pct, savings_split_builder_pct, labor_burden_multiplier, rate_schedule_id, retainage_percent, open_book, requires_client_cost_approval, parent_contract_id, snapshot")
      .eq("org_id", resolvedOrgId)
      .eq("project_id", parsed.projectId)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    getProjectFinancialSettings({ supabase, orgId: resolvedOrgId, projectId: parsed.projectId }).catch(() => null),
  ])

  if (projectResult.error || !projectResult.data) throw new Error("Project not found.")
  if (contractResult.error) throw new Error(`Failed to load project billing contract: ${contractResult.error.message}`)
  const existingContract = contractResult.data
  if (!existingContract) throw new Error("Project needs an active billing contract before a rate schedule can be assigned.")

  const billingModel = existingSettings?.billing_model ?? resolveProjectBillingModel(existingContract as any)
  if (billingModel !== "time_and_materials") {
    throw new Error("Rate schedules can only be assigned to time-and-materials projects.")
  }

  const snapshot = ((existingContract.snapshot ?? {}) as Record<string, any>) ?? {}
  const feePresentation =
    normalizeFeePresentation(existingContract.fee_presentation) ??
    normalizeFeePresentation(snapshot.fee_presentation) ??
    "embedded"
  const nextRateScheduleId = parsed.rateScheduleId ?? null
  const contractPayload = {
    org_id: resolvedOrgId,
    project_id: parsed.projectId,
    title: existingContract.title ?? `${projectResult.data.name} Contract`,
    status: "active",
    contract_type: "time_materials",
    total_cents: existingContract.total_cents ?? null,
    currency: existingContract.currency ?? "usd",
    markup_percent: existingContract.markup_percent ?? 0,
    gmp_cents: existingContract.gmp_cents ?? null,
    contingency_cents: existingContract.contingency_cents ?? null,
    fixed_fee_cents: existingContract.fixed_fee_cents ?? null,
    fee_presentation: feePresentation,
    savings_split_owner_pct: existingContract.savings_split_owner_pct ?? 0,
    savings_split_builder_pct: existingContract.savings_split_builder_pct ?? 0,
    labor_burden_multiplier: existingContract.labor_burden_multiplier ?? 1,
    rate_schedule_id: nextRateScheduleId,
    requires_client_cost_approval: existingContract.requires_client_cost_approval ?? existingSettings?.client_cost_approval_required ?? false,
    open_book: existingContract.open_book ?? existingSettings?.open_book_required ?? true,
    retainage_percent: existingContract.retainage_percent ?? 0,
    snapshot: {
      ...snapshot,
      billing_setup_source: "billing_rate_schedule_assignment",
      fee_presentation: feePresentation,
      rate_schedule_id: nextRateScheduleId,
      updated_at: new Date().toISOString(),
    },
  }

  const result = await saveBillingContractWithAmendment({
    supabase,
    orgId: resolvedOrgId,
    userId,
    projectId: parsed.projectId,
    existingContract,
    existingSettings,
    nextBillingModel: "time_and_materials",
    contractPayload,
    auditSource: "billing_rate_schedule_assignment",
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "billing_rate_schedule_assigned",
    entityType: "project",
    entityId: parsed.projectId,
    payload: {
      rate_schedule_id: nextRateScheduleId,
      contract_id: result.contractId,
      contract_action: result.action,
      material_contract_changes: result.materialChanges,
    },
  })

  return result
}

function ratePayload(orgId: string, parsed: BillingRateInput) {
  return {
    org_id: orgId,
    schedule_id: parsed.scheduleId,
    kind: parsed.kind,
    role_name: parsed.kind === "labor_role" ? parsed.roleName?.trim() ?? null : null,
    user_id: parsed.kind === "person" ? parsed.userId ?? null : null,
    equipment_name: parsed.kind === "equipment" ? parsed.equipmentName?.trim() ?? null : null,
    cost_code_id: parsed.kind === "material" ? parsed.costCodeId ?? null : parsed.costCodeId ?? null,
    rate_cents: parsed.rateCents ?? null,
    markup_percent: parsed.markupPercent ?? null,
    ot_multiplier: parsed.otMultiplier,
    dt_multiplier: parsed.dtMultiplier,
    unit: parsed.unit,
    effective_from: toDateOnly(parsed.effectiveFrom ?? new Date()),
    effective_to: parsed.effectiveTo ? toDateOnly(parsed.effectiveTo) : null,
  }
}

async function loadWorkerBillingContext(args: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
  userId?: string | null
  metadata?: Record<string, any> | null
}) {
  const roleCandidates = new Set<string>()
  const addRole = (value?: string | null) => {
    const normalized = normalizeLookup(value)
    if (normalized) roleCandidates.add(normalized)
  }

  addRole(args.metadata?.labor_role)
  addRole(args.metadata?.role_name)

  if (!args.userId) {
    return { roleCandidates, fallbackBillRateCents: 0 }
  }

  const [membershipResult, projectMemberResult] = await Promise.all([
    args.supabase
      .from("memberships")
      .select("labor_bill_rate_cents, role:roles!memberships_role_id_fkey(key, label)")
      .eq("org_id", args.orgId)
      .eq("user_id", args.userId)
      .eq("status", "active")
      .maybeSingle(),
    args.supabase
      .from("project_members")
      .select("role:roles!project_members_role_id_fkey(key, label)")
      .eq("org_id", args.orgId)
      .eq("project_id", args.projectId)
      .eq("user_id", args.userId)
      .eq("status", "active")
      .maybeSingle(),
  ])

  if (membershipResult.error) throw new Error(`Failed to load team bill-rate fallback: ${membershipResult.error.message}`)
  if (projectMemberResult.error) throw new Error(`Failed to load project role for bill-rate resolution: ${projectMemberResult.error.message}`)

  const membershipRole = (membershipResult.data as any)?.role
  const projectRole = (projectMemberResult.data as any)?.role
  addRole(membershipRole?.key)
  addRole(membershipRole?.label)
  addRole(projectRole?.key)
  addRole(projectRole?.label)

  return {
    roleCandidates,
    fallbackBillRateCents: Number((membershipResult.data as any)?.labor_bill_rate_cents ?? 0),
  }
}

function selectEffective(rows: any[], occurredOn: string) {
  return rows
    .filter((row) => row.effective_from <= occurredOn && (!row.effective_to || row.effective_to >= occurredOn))
    .sort((a, b) => {
      const byDate = String(b.effective_from).localeCompare(String(a.effective_from))
      if (byDate !== 0) return byDate
      return String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""))
    })
}

function matchLaborRate(args: {
  rows: any[]
  workerUserId?: string | null
  roleCandidates: Set<string>
}) {
  const person = args.workerUserId
    ? args.rows.find((row) => row.kind === "person" && row.user_id === args.workerUserId)
    : null
  if (person) return person

  return args.rows.find(
    (row) => row.kind === "labor_role" && args.roleCandidates.has(normalizeLookup(row.role_name)),
  )
}

function billingQuantity(hours: number, unit: BillingRateUnit) {
  if (unit === "day") return hours / 8
  if (unit === "each") return 1
  return hours
}

export function calculateTimeAndMaterialsBillableCents(
  timeEntry: {
    hours?: number | string | null
    is_overtime?: boolean | null
    is_double_time?: boolean | null
  },
  rate: Pick<TimeAndMaterialsRateResolution, "rateCents" | "unit" | "otMultiplier" | "dtMultiplier">,
) {
  const hours = Math.max(0, Number(timeEntry.hours ?? 0))
  const multiplier = timeEntry.is_double_time ? rate.dtMultiplier : timeEntry.is_overtime ? rate.otMultiplier : 1
  const quantity = billingQuantity(hours, rate.unit)
  return {
    billQuantity: quantity,
    multiplier,
    billableCents: Math.round(quantity * rate.rateCents * multiplier),
  }
}

export async function resolveTimeAndMaterialsRateForTimeEntry(args: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
  contract?: Record<string, any> | null
  timeEntry: Record<string, any>
}): Promise<TimeAndMaterialsRateResolution> {
  const occurredOn = toDateOnly(args.timeEntry.work_date ?? new Date())
  const scheduleId = args.contract?.rate_schedule_id ?? args.contract?.snapshot?.rate_schedule_id ?? null
  const workerContext = await loadWorkerBillingContext({
    supabase: args.supabase,
    orgId: args.orgId,
    projectId: args.projectId,
    userId: args.timeEntry.worker_user_id ?? null,
    metadata: args.timeEntry.metadata ?? {},
  })

  const [overrideResult, rateResult] = await Promise.all([
    args.supabase
      .from("billing_rate_overrides")
      .select("*")
      .eq("org_id", args.orgId)
      .eq("project_id", args.projectId)
      .in("kind", ["person", "labor_role"])
      .lte("effective_from", occurredOn)
      .or(`effective_to.is.null,effective_to.gte.${occurredOn}`),
    scheduleId
      ? args.supabase
          .from("billing_rates")
          .select("*")
          .eq("org_id", args.orgId)
          .eq("schedule_id", scheduleId)
          .in("kind", ["person", "labor_role"])
          .lte("effective_from", occurredOn)
          .or(`effective_to.is.null,effective_to.gte.${occurredOn}`)
      : Promise.resolve({ data: [], error: null }),
  ])

  if (overrideResult.error) throw new Error(`Failed to load project billing-rate overrides: ${overrideResult.error.message}`)
  if (rateResult.error) throw new Error(`Failed to load billing rates: ${rateResult.error.message}`)

  const override = matchLaborRate({
    rows: selectEffective(overrideResult.data ?? [], occurredOn),
    workerUserId: args.timeEntry.worker_user_id ?? null,
    roleCandidates: workerContext.roleCandidates,
  })
  if (override) {
    return buildTimeRateResolution(args.timeEntry, {
      row: override,
      source: "project_override",
      scheduleId: override.schedule_id ?? scheduleId,
      overrideId: override.id,
    })
  }

  const scheduleRate = matchLaborRate({
    rows: selectEffective(rateResult.data ?? [], occurredOn),
    workerUserId: args.timeEntry.worker_user_id ?? null,
    roleCandidates: workerContext.roleCandidates,
  })
  if (scheduleRate) {
    return buildTimeRateResolution(args.timeEntry, {
      row: scheduleRate,
      source: scheduleRate.kind === "person" ? "schedule_person" : "schedule_role",
      scheduleId,
      rateId: scheduleRate.id,
    })
  }

  const fallbackRate = workerContext.fallbackBillRateCents
  if (fallbackRate > 0) {
    return buildTimeRateResolution(args.timeEntry, {
      row: {
        rate_cents: fallbackRate,
        unit: "hour",
        ot_multiplier: args.timeEntry.ot_multiplier ?? 1.5,
        dt_multiplier: args.timeEntry.dt_multiplier ?? 2,
        role_name: null,
      },
      source: "membership_fallback",
      scheduleId,
    })
  }

  return buildTimeRateResolution(args.timeEntry, {
    row: {
      rate_cents: 0,
      unit: "hour",
      ot_multiplier: args.timeEntry.ot_multiplier ?? 1.5,
      dt_multiplier: args.timeEntry.dt_multiplier ?? 2,
    },
    source: "none",
    scheduleId,
  })
}

function buildTimeRateResolution(
  timeEntry: Record<string, any>,
  args: {
    row: Record<string, any>
    source: TimeAndMaterialsRateResolution["source"]
    scheduleId?: string | null
    rateId?: string | null
    overrideId?: string | null
  },
): TimeAndMaterialsRateResolution {
  const rateCents = Math.max(0, Number(args.row.rate_cents ?? 0))
  const unit = (args.row.unit ?? "hour") as BillingRateUnit
  const otMultiplier = Number(args.row.ot_multiplier ?? timeEntry.ot_multiplier ?? 1.5)
  const dtMultiplier = Number(args.row.dt_multiplier ?? timeEntry.dt_multiplier ?? 2)
  const billed = calculateTimeAndMaterialsBillableCents(timeEntry, {
    rateCents,
    unit,
    otMultiplier,
    dtMultiplier,
  })
  return {
    rateCents,
    unit,
    otMultiplier,
    dtMultiplier,
    source: args.source,
    scheduleId: args.scheduleId ?? null,
    rateId: args.rateId ?? null,
    overrideId: args.overrideId ?? null,
    roleName: args.row.role_name ?? null,
    ...billed,
  }
}

export async function resolveTimeAndMaterialsMaterialMarkup(args: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
  contract?: Record<string, any> | null
  costCodeId?: string | null
  costCodeCategory?: string | null
  occurredOn: Date | string
}): Promise<TimeAndMaterialsMaterialMarkupResolution | null> {
  const occurredOn = toDateOnly(args.occurredOn)
  const scheduleId = args.contract?.rate_schedule_id ?? args.contract?.snapshot?.rate_schedule_id ?? null
  const [overrideResult, rateResult] = await Promise.all([
    args.supabase
      .from("billing_rate_overrides")
      .select("*")
      .eq("org_id", args.orgId)
      .eq("project_id", args.projectId)
      .eq("kind", "material")
      .lte("effective_from", occurredOn)
      .or(`effective_to.is.null,effective_to.gte.${occurredOn}`),
    scheduleId
      ? args.supabase
          .from("billing_rates")
          .select("*")
          .eq("org_id", args.orgId)
          .eq("schedule_id", scheduleId)
          .eq("kind", "material")
          .lte("effective_from", occurredOn)
          .or(`effective_to.is.null,effective_to.gte.${occurredOn}`)
      : Promise.resolve({ data: [], error: null }),
  ])

  if (overrideResult.error) throw new Error(`Failed to load material rate overrides: ${overrideResult.error.message}`)
  if (rateResult.error) throw new Error(`Failed to load material billing rates: ${rateResult.error.message}`)

  const override = matchMaterialRate(selectEffective(overrideResult.data ?? [], occurredOn), args.costCodeId, args.costCodeCategory)
  if (override?.markup_percent != null) {
    return {
      percent: Number(override.markup_percent),
      source: "tm_project_override",
      scheduleId: override.schedule_id ?? scheduleId,
      overrideId: override.id,
    }
  }

  const rate = matchMaterialRate(selectEffective(rateResult.data ?? [], occurredOn), args.costCodeId, args.costCodeCategory)
  if (rate?.markup_percent != null) {
    return {
      percent: Number(rate.markup_percent),
      source: "tm_material_schedule",
      scheduleId,
      rateId: rate.id,
    }
  }

  return null
}

function matchMaterialRate(rows: any[], costCodeId?: string | null, category?: string | null) {
  return (
    (costCodeId ? rows.find((row) => row.cost_code_id === costCodeId) : null) ??
    (category ? rows.find((row) => normalizeLookup(row.metadata?.category) === normalizeLookup(category)) : null) ??
    rows.find((row) => !row.cost_code_id && !row.metadata?.category)
  )
}
