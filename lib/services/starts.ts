import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"

import { RELEASE_PRODUCED_GATE_KEYS, canAttestFinalApproval, isGateApplicable, startPackageReadiness, type GateAppliesWhen, type GateStatus } from "@/lib/starts/gate-logic"
import { mondayOfIsoWeek } from "@/lib/starts/even-flow-math"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { NotificationService } from "@/lib/services/notifications"
import { enqueueOutboxJob } from "@/lib/services/outbox"
import { requirePermission } from "@/lib/services/permissions"
import { createProject } from "@/lib/services/projects"
import { triggerStartsPipeline } from "@/lib/services/starts-pipeline-trigger"
import {
  gateAttestSchema,
  gateDefinitionSchema,
  gateWaiveSchema,
  releaseInputSchema,
  startPackageInputSchema,
  startPackageUpdateSchema,
  type GateDefinitionInput,
} from "@/lib/validation/starts"

export type StartPackageStatus = "open" | "ready" | "releasing" | "released" | "attention" | "cancelled"

export interface GateDefinitionDTO {
  id: string
  key: string
  label: string
  description: string | null
  checkKind: "auto" | "manual"
  autoSource: string | null
  requiresAttestationPermission: string | null
  appliesWhen: GateAppliesWhen
  sortOrder: number
  isActive: boolean
}

export interface StartGateDTO {
  id: string
  definitionId: string
  key: string
  label: string
  checkKind: "auto" | "manual"
  status: GateStatus
  passedVia: "auto" | "attested" | "waived" | null
  attestedBy: string | null
  attestedByName: string | null
  attestedAt: string | null
  waivedReason: string | null
  evidenceFileId: string | null
  releaseProduced: boolean
}

export interface StartPackageListItemDTO {
  id: string
  lotId: string
  lotLabel: string
  communityId: string
  communityName: string
  projectId: string | null
  status: StartPackageStatus
  planCode: string | null
  planName: string | null
  elevationCode: string | null
  targetWeek: string | null
  scheduledStartDate: string | null
  gatesPassed: number
  gatesTotal: number
  preconAgeDays: number
  isFinanced: boolean
  releasedAt: string | null
  superintendentId: string | null
  superintendentName: string | null
}

export interface StartPackageDetailDTO extends StartPackageListItemDTO {
  gates: StartGateDTO[]
  steps: Array<{ stepKey: string; status: string; attempt: number; error: string | null; detail: Record<string, unknown>; completedAt: string | null }>
  notes: string | null
}

type Relation = Record<string, unknown>

const DEFAULT_GATE_DEFINITIONS = [
  { key: "permit", label: "Permit approved", check_kind: "manual", auto_source: null, applies_when: "always", sort_order: 10 },
  { key: "plot_plan", label: "Plot/site plan on file", check_kind: "auto", auto_source: "plot_plan_file", applies_when: "always", sort_order: 20 },
  { key: "selections_locked", label: "Structural selections locked", check_kind: "auto", auto_source: "selections_locked", applies_when: "always", sort_order: 30 },
  { key: "plan_pinned", label: "Plan version & elevation pinned", check_kind: "auto", auto_source: "plan_pinned", applies_when: "always", sort_order: 40 },
  { key: "price_book", label: "Price book resolves", check_kind: "auto", auto_source: "po_exceptions_clear", applies_when: "purchasing_enabled", sort_order: 50 },
  { key: "budget", label: "Budget generated", check_kind: "auto", auto_source: "budget_generated", applies_when: "always", sort_order: 60 },
  { key: "po_set", label: "PO set generated", check_kind: "auto", auto_source: "pos_generated", applies_when: "purchasing_enabled", sort_order: 70 },
  { key: "financing", label: "Financing/appraisal cleared", check_kind: "manual", auto_source: null, applies_when: "financed_only", sort_order: 80 },
  { key: "final_approval", label: "Final start approval", check_kind: "manual", auto_source: null, applies_when: "always", sort_order: 90, requires_attestation_permission: "start.release" },
] as const

function relation(value: unknown): Relation | null {
  const row = Array.isArray(value) ? value[0] : value
  return row && typeof row === "object" ? row as Relation : null
}

function text(value: unknown) {
  return typeof value === "string" ? value : null
}

function daysSince(value: string) {
  return Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 86_400_000))
}

function mapDefinition(row: Relation): GateDefinitionDTO {
  return {
    id: String(row.id), key: String(row.key), label: String(row.label),
    description: text(row.description), checkKind: row.check_kind as "auto" | "manual",
    autoSource: text(row.auto_source), requiresAttestationPermission: text(row.requires_attestation_permission),
    appliesWhen: row.applies_when as GateAppliesWhen, sortOrder: Number(row.sort_order), isActive: row.is_active === true,
  }
}

function mapGate(row: Relation): StartGateDTO {
  const definition = relation(row.definition)
  const user = relation(row.attested_user)
  if (!definition) throw new Error("Start gate definition is missing")
  return {
    id: String(row.id), definitionId: String(row.gate_definition_id), key: String(definition.key),
    label: String(definition.label), checkKind: definition.check_kind as "auto" | "manual",
    status: row.status as GateStatus, passedVia: row.passed_via as StartGateDTO["passedVia"],
    attestedBy: text(row.attested_by), attestedByName: text(user?.full_name), attestedAt: text(row.attested_at),
    waivedReason: text(row.waived_reason), evidenceFileId: text(row.evidence_file_id),
    releaseProduced: RELEASE_PRODUCED_GATE_KEYS.has(String(definition.key)),
  }
}

async function loadPurchasingEnabled(supabase: SupabaseClient, orgId: string, communityId: string) {
  const { count, error } = await supabase.from("vendor_price_agreements")
    .select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("status", "active")
    .or(`community_id.eq.${communityId},community_id.is.null`)
  if (error) throw new Error(`Failed to check purchasing readiness: ${error.message}`)
  return (count ?? 0) > 0
}

export async function seedDefaultGateDefinitions(orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.read", context)
  const { error } = await context.supabase.from("start_gate_definitions").upsert(
    DEFAULT_GATE_DEFINITIONS.map((gate) => ({ org_id: context.orgId, ...gate })),
    { onConflict: "org_id,key", ignoreDuplicates: true },
  )
  if (error) throw new Error(`Failed to seed start gates: ${error.message}`)
}

export async function listGateDefinitions(orgId?: string): Promise<GateDefinitionDTO[]> {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.read", context)
  const { data, error } = await context.supabase.from("start_gate_definitions").select("*")
    .eq("org_id", context.orgId).order("sort_order")
  if (error) throw new Error(`Failed to load start gates: ${error.message}`)
  return (data ?? []).map((row) => mapDefinition(row))
}

export async function upsertGateDefinition(input: GateDefinitionInput, orgId?: string) {
  const parsed = gateDefinitionSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("start.release", context)
  const payload = {
    org_id: context.orgId, key: parsed.key, label: parsed.label, description: parsed.description ?? null,
    check_kind: parsed.checkKind, auto_source: parsed.checkKind === "auto" ? parsed.autoSource : null,
    requires_attestation_permission: parsed.requiresAttestationPermission ?? null,
    applies_when: parsed.appliesWhen, sort_order: parsed.sortOrder, is_active: parsed.isActive,
  }
  const query = parsed.id
    ? context.supabase.from("start_gate_definitions").update(payload).eq("org_id", context.orgId).eq("id", parsed.id)
    : context.supabase.from("start_gate_definitions").upsert(payload, { onConflict: "org_id,key" })
  const { data, error } = await query.select("*").single()
  if (error) throw new Error(`Failed to save start gate: ${error.message}`)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: parsed.id ? "update" : "insert", entityType: "start_gate_definition", entityId: data.id, after: data })
  return mapDefinition(data)
}

async function loadPackageRow(supabase: SupabaseClient, orgId: string, packageId: string) {
  const { data, error } = await supabase.from("start_packages").select("*")
    .eq("org_id", orgId).eq("id", packageId).maybeSingle()
  if (error || !data) throw new Error("Start package not found")
  return data
}

async function loadGateRows(supabase: SupabaseClient, orgId: string, packageId: string) {
  const { data, error } = await supabase.from("start_package_gates").select(`
    *, definition:start_gate_definitions!inner(key,label,check_kind,auto_source,applies_when,requires_attestation_permission,sort_order),
    attested_user:app_users!start_package_gates_attested_by_fkey(full_name)
  `).eq("org_id", orgId).eq("start_package_id", packageId).order("created_at")
  if (error) throw new Error(`Failed to load start gates: ${error.message}`)
  return data ?? []
}

async function recomputePackageStatus(supabase: SupabaseClient, orgId: string, packageId: string) {
  const pkg = await loadPackageRow(supabase, orgId, packageId)
  if (!["open", "ready"].includes(pkg.status)) return pkg.status as StartPackageStatus
  const rows = await loadGateRows(supabase, orgId, packageId)
  const purchasingEnabled = await loadPurchasingEnabled(supabase, orgId, pkg.community_id)
  const readiness = startPackageReadiness(rows.map((row) => {
    const definition = relation(row.definition)
    return { key: String(definition?.key), appliesWhen: definition?.applies_when as GateAppliesWhen, status: row.status as GateStatus }
  }), { isFinanced: pkg.is_financed, purchasingEnabled })
  const nextStatus = readiness.ready ? "ready" : "open"
  if (nextStatus !== pkg.status) {
    await supabase.from("start_packages").update({ status: nextStatus }).eq("org_id", orgId).eq("id", packageId)
    if (nextStatus === "ready") await notifyPermissionHolders(supabase, orgId, "start.release", {
      type: "start_package_ready", title: "Start package ready", message: "A start package has cleared its readiness gates.", entityId: packageId,
    })
  }
  return nextStatus
}

async function notifyPermissionHolders(
  supabase: SupabaseClient,
  orgId: string,
  permission: string,
  input: { type: "start_package_ready" | "start_release_failed" | "start_gate_waived"; title: string; message: string; entityId: string },
) {
  const { data: memberships } = await supabase.from("memberships")
    .select("user_id, role_id").eq("org_id", orgId).eq("status", "active")
  const roleIds = Array.from(new Set((memberships ?? []).map((row) => row.role_id)))
  if (!roleIds.length) return
  const { data: grants } = await supabase.from("role_permissions").select("role_id")
    .in("role_id", roleIds).eq("permission_key", permission)
  const allowed = new Set((grants ?? []).map((row) => row.role_id))
  const userIds = Array.from(new Set((memberships ?? []).filter((row) => allowed.has(row.role_id)).map((row) => row.user_id)))
  const notifications = new NotificationService()
  await Promise.allSettled(userIds.map((userId) => notifications.createAndQueue({
    orgId, userId, type: input.type, title: input.title, message: input.message,
    entityType: "start_package", entityId: input.entityId,
  })))
}

async function deriveAutoGate(
  supabase: SupabaseClient,
  orgId: string,
  pkg: Relation,
  source: string,
) {
  const projectId = text(pkg.project_id)
  if (source === "plan_pinned") {
    const { data } = await supabase.from("lots").select("house_plan_version_id,house_plan_elevation_id,version:house_plan_versions(status)")
      .eq("org_id", orgId).eq("id", String(pkg.lot_id)).maybeSingle()
    const version = relation(data?.version)
    return Boolean(data?.house_plan_version_id && data.house_plan_elevation_id && version?.status === "released")
  }
  if (!projectId) return false
  if (source === "plot_plan_file") {
    const { count } = await supabase.from("files").select("id", { count: "exact", head: true })
      .eq("org_id", orgId).eq("project_id", projectId).eq("metadata->>document_kind", "plot_plan").is("archived_at", null)
    return (count ?? 0) > 0
  }
  if (source === "selections_locked") {
    const { count, error } = await supabase.from("project_selection_groups").select("id", { count: "exact", head: true })
      .eq("org_id", orgId).eq("project_id", projectId).eq("status", "open")
    return !error && (count ?? 0) === 0
  }
  if (source === "budget_generated") {
    const { count } = await supabase.from("budgets").select("id", { count: "exact", head: true })
      .eq("org_id", orgId).eq("project_id", projectId)
    return (count ?? 0) > 0
  }
  if (source === "pos_generated") {
    const { count } = await supabase.from("po_generation_runs").select("id", { count: "exact", head: true })
      .eq("org_id", orgId).eq("project_id", projectId).eq("mode", "commit").in("status", ["succeeded", "succeeded_with_exceptions"])
    return (count ?? 0) > 0
  }
  if (source === "po_exceptions_clear") {
    const { count } = await supabase.from("po_generation_exceptions").select("id", { count: "exact", head: true })
      .eq("org_id", orgId).eq("project_id", projectId).eq("status", "open")
    return (count ?? 0) === 0
  }
  return false
}

export async function refreshAutoGates(packageId: string, orgId?: string): Promise<StartGateDTO[]> {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.read", context)
  const pkg = await loadPackageRow(context.supabase, context.orgId, packageId)
  const purchasingEnabled = await loadPurchasingEnabled(context.supabase, context.orgId, pkg.community_id)
  const rows = await loadGateRows(context.supabase, context.orgId, packageId)
  await Promise.all(rows.map(async (row) => {
    const definition = relation(row.definition)
    if (!definition) return
    const applicable = isGateApplicable({ appliesWhen: definition.applies_when as GateAppliesWhen }, { isFinanced: pkg.is_financed, purchasingEnabled })
    if (!applicable) {
      await context.supabase.from("start_package_gates").update({ status: "not_applicable", passed_via: null }).eq("org_id", context.orgId).eq("id", row.id)
      return
    }
    if (row.status === "waived" || definition.check_kind !== "auto") {
      if (row.status === "not_applicable") await context.supabase.from("start_package_gates").update({ status: "pending" }).eq("org_id", context.orgId).eq("id", row.id)
      return
    }
    const passed = await deriveAutoGate(context.supabase, context.orgId, pkg, String(definition.auto_source))
    await context.supabase.from("start_package_gates").update({ status: passed ? "passed" : "pending", passed_via: passed ? "auto" : null }).eq("org_id", context.orgId).eq("id", row.id)
  }))
  await recomputePackageStatus(context.supabase, context.orgId, packageId)
  return (await loadGateRows(context.supabase, context.orgId, packageId)).map((row) => mapGate(row))
}

export async function openStartPackage(lotId: string, input: { isFinanced?: boolean; targetWeek?: string | null }, orgId?: string) {
  const parsed = startPackageInputSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("start.write", context)
  await seedDefaultGateDefinitions(context.orgId)
  const { data: lot, error } = await context.supabase.from("lots").select("id,community_id,division_id,project_id,status,lot_number,address,community:communities(name,code)")
    .eq("org_id", context.orgId).eq("id", lotId).maybeSingle()
  if (error || !lot) throw new Error("Lot not found")
  if (!["developed", "assigned"].includes(lot.status)) throw new Error("Only developed or assigned lots can enter the start pipeline.")
  const { count: activePackages } = await context.supabase.from("start_packages")
    .select("id", { count: "exact", head: true }).eq("org_id", context.orgId).eq("lot_id", lot.id).neq("status", "cancelled")
  if ((activePackages ?? 0) > 0) throw new Error("This lot already has an active start package.")

  // A preconstruction project is needed before release so plot-plan files,
  // selections, and price-book dry runs have a stable project scope.
  let projectId = lot.project_id
  if (!projectId) {
    const community = relation(lot.community)
    const project = await createProject({ input: {
      name: `${text(community?.code) ?? text(community?.name) ?? "Lot"} ${lot.lot_number}`,
      status: "active", property_type: "production", address: lot.address ?? undefined,
    }, context })
    projectId = project.id
    const [{ error: projectScopeError }, { error: lotLinkError }] = await Promise.all([
      context.supabase.from("projects").update({ division_id: lot.division_id }).eq("org_id", context.orgId).eq("id", projectId),
      context.supabase.from("lots").update({ project_id: projectId, status: "assigned" }).eq("org_id", context.orgId).eq("id", lot.id),
    ])
    if (projectScopeError) throw new Error(`Failed to scope start project: ${projectScopeError.message}`)
    if (lotLinkError) throw new Error(`Failed to link start project: ${lotLinkError.message}`)
  }
  const { data: pkg, error: insertError } = await context.supabase.from("start_packages").insert({
    org_id: context.orgId, lot_id: lot.id, community_id: lot.community_id, project_id: projectId,
    is_financed: parsed.isFinanced, target_week: parsed.targetWeek ?? null,
  }).select("*").single()
  if (insertError) throw new Error(insertError.code === "23505" ? "This lot already has an active start package." : `Failed to open start package: ${insertError.message}`)
  const { data: definitions, error: definitionsError } = await context.supabase.from("start_gate_definitions").select("id")
    .eq("org_id", context.orgId).eq("is_active", true)
  if (definitionsError) throw new Error(`Failed to load start gates: ${definitionsError.message}`)
  const { error: gatesError } = await context.supabase.from("start_package_gates").insert((definitions ?? []).map((definition) => ({
    org_id: context.orgId, start_package_id: pkg.id, gate_definition_id: definition.id,
  })))
  if (gatesError) throw new Error(`Failed to initialize start gates: ${gatesError.message}`)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "start_package.opened", entityType: "start_package", entityId: pkg.id, payload: { lot_id: lot.id, community_id: lot.community_id } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "start_package", entityId: pkg.id, after: pkg }),
  ])
  await refreshAutoGates(pkg.id, context.orgId)
  return getStartPackage(pkg.id, context.orgId)
}

export async function updateStartPackage(id: string, input: { targetWeek?: string | null; scheduledStartDate?: string | null; isFinanced?: boolean; notes?: string | null }, orgId?: string) {
  const parsed = startPackageUpdateSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("start.write", context)
  const before = await loadPackageRow(context.supabase, context.orgId, id)
  if (!["open", "ready"].includes(before.status)) throw new Error("Only open or ready packages can be edited.")
  const patch = {
    ...(parsed.targetWeek !== undefined ? { target_week: parsed.targetWeek } : {}),
    ...(parsed.scheduledStartDate !== undefined ? { scheduled_start_date: parsed.scheduledStartDate } : {}),
    ...(parsed.isFinanced !== undefined ? { is_financed: parsed.isFinanced } : {}),
    ...(parsed.notes !== undefined ? { notes: parsed.notes } : {}),
  }
  const { data, error } = await context.supabase.from("start_packages").update(patch).eq("org_id", context.orgId).eq("id", id).select("*").single()
  if (error) throw new Error(`Failed to update start package: ${error.message}`)
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "start_package.updated", entityType: "start_package", entityId: id, payload: patch })
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "start_package", entityId: id, before, after: data })
  await refreshAutoGates(id, context.orgId)
  return getStartPackage(id, context.orgId)
}

async function mutateGate(
  packageId: string,
  gateId: string,
  patch: Relation,
  eventType: string,
  orgId?: string,
) {
  const context = await requireOrgContext(orgId)
  const pkg = await loadPackageRow(context.supabase, context.orgId, packageId)
  if (!["open", "ready"].includes(pkg.status)) throw new Error("Gates cannot change after release begins.")
  const { data: gate, error: gateError } = await context.supabase.from("start_package_gates").select("*,definition:start_gate_definitions!inner(*)")
    .eq("org_id", context.orgId).eq("start_package_id", packageId).eq("id", gateId).maybeSingle()
  if (gateError || !gate) throw new Error("Start gate not found")
  const { data, error } = await context.supabase.from("start_package_gates").update(patch)
    .eq("org_id", context.orgId).eq("id", gateId).select("*").single()
  if (error) throw new Error(`Failed to update start gate: ${error.message}`)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType, entityType: "start_gate", entityId: gateId, payload: { start_package_id: packageId } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "start_gate", entityId: gateId, before: gate, after: data }),
  ])
  await recomputePackageStatus(context.supabase, context.orgId, packageId)
  return getStartPackage(packageId, context.orgId)
}

export async function attestGate(packageId: string, gateId: string, input: { evidenceFileId?: string; notes?: string }, orgId?: string) {
  const parsed = gateAttestSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("start.write", context)
  const pkg = await loadPackageRow(context.supabase, context.orgId, packageId)
  const rows = await loadGateRows(context.supabase, context.orgId, packageId)
  const row = rows.find((candidate) => candidate.id === gateId)
  const definition = relation(row?.definition)
  if (!row || !definition || definition.check_kind !== "manual") throw new Error("Only manual gates can be attested.")
  const requiredPermission = text(definition.requires_attestation_permission)
  if (requiredPermission) await requirePermission(requiredPermission, context)
  if (definition.key === "final_approval") {
    const purchasingEnabled = await loadPurchasingEnabled(context.supabase, context.orgId, pkg.community_id)
    const allowed = canAttestFinalApproval(rows.map((gate) => {
      const def = relation(gate.definition)
      return { key: String(def?.key), appliesWhen: def?.applies_when as GateAppliesWhen, status: gate.status as GateStatus }
    }), { isFinanced: pkg.is_financed, purchasingEnabled })
    if (!allowed) throw new Error("Clear every other readiness gate before final approval.")
  }
  return mutateGate(packageId, gateId, {
    status: "passed", passed_via: "attested", attested_by: context.userId,
    attested_at: new Date().toISOString(), evidence_file_id: parsed.evidenceFileId ?? null, notes: parsed.notes ?? null,
    waived_reason: null,
  }, "start_gate.attested", context.orgId)
}

export async function waiveGate(packageId: string, gateId: string, input: { reason: string }, orgId?: string) {
  const parsed = gateWaiveSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("start.release", context)
  const result = await mutateGate(packageId, gateId, {
    status: "waived", passed_via: "waived", attested_by: context.userId,
    attested_at: new Date().toISOString(), waived_reason: parsed.reason,
  }, "start_gate.waived", context.orgId)
  await notifyPermissionHolders(context.supabase, context.orgId, "start.release", {
    type: "start_gate_waived", title: "Start gate waived", message: parsed.reason, entityId: packageId,
  })
  return result
}

export async function reopenGate(packageId: string, gateId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.write", context)
  return mutateGate(packageId, gateId, {
    status: "pending", passed_via: null, attested_by: null, attested_at: null, waived_reason: null,
  }, "start_gate.reopened", context.orgId)
}

export async function releaseStart(packageId: string, input: { scheduledStartDate: string; confirmOverSlot?: boolean }, orgId?: string): Promise<{ released: true } | { requiresConfirm: true; slot: { targetWeek: string; target: number; alreadyTargeted: number } }> {
  const parsed = releaseInputSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("start.release", context)
  await refreshAutoGates(packageId, context.orgId)
  let pkg = await loadPackageRow(context.supabase, context.orgId, packageId)
  if (pkg.status !== "ready") throw new Error("The start package is not ready to release.")
  const targetWeek = pkg.target_week ?? mondayOfIsoWeek(parsed.scheduledStartDate)
  const [{ data: slot }, { count: alreadyTargeted }] = await Promise.all([
    context.supabase.from("community_release_slots").select("target_starts").eq("org_id", context.orgId).eq("community_id", pkg.community_id).eq("week_start", targetWeek).maybeSingle(),
    context.supabase.from("start_packages").select("id", { count: "exact", head: true }).eq("org_id", context.orgId).eq("community_id", pkg.community_id).eq("target_week", targetWeek).in("status", ["releasing", "released"]),
  ])
  const target = Number(slot?.target_starts ?? 0)
  if ((alreadyTargeted ?? 0) >= target && !parsed.confirmOverSlot) {
    return { requiresConfirm: true, slot: { targetWeek, target, alreadyTargeted: alreadyTargeted ?? 0 } }
  }

  if (!pkg.project_id) {
    const { data: lot } = await context.supabase.from("lots").select("lot_number,address,division_id,community:communities(name,code)")
      .eq("org_id", context.orgId).eq("id", pkg.lot_id).maybeSingle()
    if (!lot) throw new Error("Lot not found")
    const community = relation(lot.community)
    const project = await createProject({ input: {
      name: `${text(community?.code) ?? text(community?.name) ?? "Lot"} ${lot.lot_number}`,
      status: "active", start_date: parsed.scheduledStartDate, property_type: "production",
      address: lot.address ?? undefined,
    }, context })
    const { error: projectUpdateError } = await context.supabase.from("projects").update({ division_id: lot.division_id })
      .eq("org_id", context.orgId).eq("id", project.id)
    if (projectUpdateError) throw new Error(`Failed to scope start project: ${projectUpdateError.message}`)
    const { error: lotUpdateError } = await context.supabase.from("lots").update({ project_id: project.id, status: "assigned" })
      .eq("org_id", context.orgId).eq("id", pkg.lot_id)
    if (lotUpdateError) throw new Error(`Failed to link start project: ${lotUpdateError.message}`)
    const { error: packageUpdateError } = await context.supabase.from("start_packages").update({ project_id: project.id })
      .eq("org_id", context.orgId).eq("id", packageId)
    if (packageUpdateError) throw new Error(`Failed to link start package: ${packageUpdateError.message}`)
    pkg = { ...pkg, project_id: project.id }
  }

  const stepKeys = ["project", "budget", "schedule", "checklists", "drawings", "pos", "notify_trades", "finalize"]
  const now = new Date().toISOString()
  const { error: stepError } = await context.supabase.from("start_release_steps").upsert(stepKeys.map((stepKey) => ({
    org_id: context.orgId, start_package_id: packageId, step_key: stepKey,
    status: stepKey === "project" ? "completed" : "pending", completed_at: stepKey === "project" ? now : null,
  })), { onConflict: "start_package_id,step_key" })
  if (stepError) throw new Error(`Failed to initialize release steps: ${stepError.message}`)
  const { error: updateError } = await context.supabase.from("start_packages").update({
    status: "releasing", scheduled_start_date: parsed.scheduledStartDate, target_week: targetWeek,
    released_by: context.userId, metadata: { ...(pkg.metadata ?? {}), release_requested_at: now },
  }).eq("org_id", context.orgId).eq("id", packageId)
  if (updateError) throw new Error(`Failed to queue start release: ${updateError.message}`)
  const queued = await enqueueOutboxJob({
    orgId: context.orgId, jobType: "start_release",
    payload: { start_package_id: packageId, actor_id: context.userId },
    dedupeByPayloadKeys: ["start_package_id"], runAt: now,
  })
  if (!queued.enqueued && queued.reason === "error") throw new Error("Failed to enqueue start release.")
  if ((alreadyTargeted ?? 0) >= target) await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "start.released_over_slot", entityType: "start_package", entityId: packageId, payload: { target_week: targetWeek, target, already_targeted: alreadyTargeted } })
  void triggerStartsPipeline()
  return { released: true }
}

export async function retryRelease(packageId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.release", context)
  const pkg = await loadPackageRow(context.supabase, context.orgId, packageId)
  if (pkg.status !== "attention") throw new Error("Only releases needing attention can be retried.")
  await context.supabase.from("start_packages").update({ status: "releasing", released_by: context.userId }).eq("org_id", context.orgId).eq("id", packageId)
  const dedupeKey = `start_release:start_package_id:${packageId}`
  const { data: job } = await context.supabase.from("outbox").select("id").eq("org_id", context.orgId).eq("dedupe_key", dedupeKey).maybeSingle()
  if (job) await context.supabase.from("outbox").update({ status: "pending", retry_count: 0, last_error: null, run_at: new Date().toISOString(), payload: { start_package_id: packageId, actor_id: context.userId } }).eq("id", job.id)
  else await enqueueOutboxJob({ orgId: context.orgId, jobType: "start_release", payload: { start_package_id: packageId, actor_id: context.userId }, dedupeByPayloadKeys: ["start_package_id"] })
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "start.release_retried", entityType: "start_package", entityId: packageId })
  void triggerStartsPipeline()
}

export async function cancelRelease(packageId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.release", context)
  const pkg = await loadPackageRow(context.supabase, context.orgId, packageId)
  if (!["releasing", "attention"].includes(pkg.status)) throw new Error("This release is not cancellable.")
  await Promise.all([
    context.supabase.from("start_packages").update({ status: "ready" }).eq("org_id", context.orgId).eq("id", packageId),
    context.supabase.from("start_release_steps").update({ status: "pending", error: null, started_at: null, completed_at: null }).eq("org_id", context.orgId).eq("start_package_id", packageId).neq("step_key", "project"),
    context.supabase.from("outbox").update({ status: "failed", last_error: "Release cancelled by coordinator" }).eq("org_id", context.orgId).eq("dedupe_key", `start_release:start_package_id:${packageId}`).in("status", ["pending", "processing"]),
  ])
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "start_package", entityId: packageId, before: pkg, after: { status: "ready", release_cancelled: true } })
}

export async function cancelStartPackage(id: string, { reason }: { reason: string }, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.write", context)
  const pkg = await loadPackageRow(context.supabase, context.orgId, id)
  if (["releasing", "released"].includes(pkg.status)) throw new Error("A releasing or released start package cannot be cancelled.")
  if (reason.trim().length < 10) throw new Error("Cancellation reason must be at least 10 characters.")
  const { error } = await context.supabase.from("start_packages").update({ status: "cancelled", metadata: { ...(pkg.metadata ?? {}), cancellation_reason: reason } }).eq("org_id", context.orgId).eq("id", id)
  if (error) throw new Error(`Failed to cancel start package: ${error.message}`)
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "start_package.cancelled", entityType: "start_package", entityId: id, payload: { reason } })
}

export async function setProjectSuperintendent(projectId: string, userId: string | null, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("project.manage", context)
  const { data: project, error: projectError } = await context.supabase.from("projects").select("id,superintendent_id")
    .eq("org_id", context.orgId).eq("id", projectId).maybeSingle()
  if (projectError || !project) throw new Error("Project not found")
  if (userId) {
    const { data: membership } = await context.supabase.from("memberships").select("id").eq("org_id", context.orgId).eq("user_id", userId).eq("status", "active").maybeSingle()
    if (!membership) throw new Error("Superintendent must be an active organization member.")
  }
  const { error } = await context.supabase.from("projects").update({ superintendent_id: userId }).eq("org_id", context.orgId).eq("id", projectId)
  if (error) throw new Error(`Failed to assign superintendent: ${error.message}`)
  if (userId) {
    const { data: fieldRole } = await context.supabase.from("roles").select("id").eq("key", "field").eq("scope", "project").maybeSingle()
    if (!fieldRole) throw new Error("Field project role is missing.")
    const { error: memberError } = await context.supabase.from("project_members").upsert({
      org_id: context.orgId, project_id: projectId, user_id: userId, role_id: fieldRole.id, status: "active",
    }, { onConflict: "project_id,user_id" })
    if (memberError) throw new Error(`Failed to scope superintendent to project: ${memberError.message}`)
    await new NotificationService().createAndQueue({ orgId: context.orgId, userId, type: "project_superintendent_assigned", title: "House assigned", message: "You have been assigned as superintendent.", projectId, entityType: "project", entityId: projectId })
  }
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "project.superintendent_changed", entityType: "project", entityId: projectId, payload: { previous_user_id: project.superintendent_id, user_id: userId } })
}

export async function listStartPackages(
  filters: { id?: string; communityId?: string; status?: StartPackageStatus[]; targetWeek?: string; page?: number; pageSize?: number } = {},
  orgId?: string,
): Promise<{ packages: StartPackageListItemDTO[]; total: number }> {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.read", context)
  const page = Math.max(1, filters.page ?? 1)
  const pageSize = Math.min(200, Math.max(1, filters.pageSize ?? 50))
  let query = context.supabase.from("start_packages").select(`
    *, lot:lots!inner(lot_number,block,house_plan_id,house_plan_elevation_id,
      plan:house_plans(code,name),elevation:house_plan_elevations(code)),
    community:communities!inner(name), project:projects(superintendent_id,superintendent:app_users!projects_superintendent_id_fkey(full_name)),
    gates:start_package_gates(status,definition:start_gate_definitions(key,applies_when))
  `, { count: "exact" }).eq("org_id", context.orgId)
  if (filters.id) query = query.eq("id", filters.id)
  if (filters.communityId) query = query.eq("community_id", filters.communityId)
  if (filters.status?.length) query = query.in("status", filters.status)
  if (filters.targetWeek) query = query.eq("target_week", filters.targetWeek)
  const { data, error, count } = await query.order("target_week", { ascending: true, nullsFirst: false }).order("created_at").range((page - 1) * pageSize, page * pageSize - 1)
  if (error) throw new Error(`Failed to load start packages: ${error.message}`)
  const packages = await Promise.all((data ?? []).map(async (row) => {
    const lot = relation(row.lot)
    const community = relation(row.community)
    const project = relation(row.project)
    const superintendent = relation(project?.superintendent)
    const plan = relation(lot?.plan)
    const elevation = relation(lot?.elevation)
    const purchasingEnabled = await loadPurchasingEnabled(context.supabase, context.orgId, row.community_id)
    const readiness = startPackageReadiness((row.gates ?? []).map((gate: Relation) => {
      const definition = relation(gate.definition)
      return { key: String(definition?.key), appliesWhen: definition?.applies_when as GateAppliesWhen, status: gate.status as GateStatus }
    }), { isFinanced: row.is_financed, purchasingEnabled })
    return {
      id: row.id, lotId: row.lot_id, lotLabel: lot?.block ? `${lot.block}-${lot.lot_number}` : String(lot?.lot_number ?? "Lot"),
      communityId: row.community_id, communityName: String(community?.name ?? "Community"), projectId: row.project_id,
      status: row.status as StartPackageStatus, planCode: text(plan?.code), planName: text(plan?.name), elevationCode: text(elevation?.code),
      targetWeek: row.target_week, scheduledStartDate: row.scheduled_start_date, gatesPassed: readiness.passed, gatesTotal: readiness.total,
      preconAgeDays: daysSince(row.created_at), isFinanced: row.is_financed, releasedAt: row.released_at,
      superintendentId: text(project?.superintendent_id), superintendentName: text(superintendent?.full_name),
    }
  }))
  return { packages, total: count ?? 0 }
}

export async function getStartPackage(id: string, orgId?: string): Promise<StartPackageDetailDTO> {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.read", context)
  const result = await listStartPackages({ id, pageSize: 1 }, context.orgId)
  const item = result.packages.find((pkg) => pkg.id === id)
  if (!item) throw new Error("Start package not found")
  const [gates, stepsResult, pkg] = await Promise.all([
    loadGateRows(context.supabase, context.orgId, id),
    context.supabase.from("start_release_steps").select("*").eq("org_id", context.orgId).eq("start_package_id", id).order("created_at"),
    loadPackageRow(context.supabase, context.orgId, id),
  ])
  if (stepsResult.error) throw new Error(`Failed to load release steps: ${stepsResult.error.message}`)
  return {
    ...item, notes: pkg.notes, gates: gates.map((gate) => mapGate(gate)),
    steps: (stepsResult.data ?? []).map((step) => ({ stepKey: step.step_key, status: step.status, attempt: Number(step.attempt), error: step.error, detail: step.detail ?? {}, completedAt: step.completed_at })),
  }
}

export async function getStartAttentionCount(orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.read", context)
  const { count } = await context.supabase.from("start_packages").select("id", { count: "exact", head: true }).eq("org_id", context.orgId).eq("status", "attention")
  return count ?? 0
}

export async function listStartPackageCandidates(orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.write", context)
  const { data, error } = await context.supabase.from("lots").select(`
    id,lot_number,block,status,community_id,community:communities!inner(name),
    plan:house_plans(code,name),elevation:house_plan_elevations(code),
    packages:start_packages!start_packages_lot_id_fkey(id,status)
  `).eq("org_id", context.orgId).in("status", ["developed", "assigned"]).order("lot_number").limit(500)
  if (error) throw new Error(`Failed to load start-package lots: ${error.message}`)
  return (data ?? []).filter((lot) => !(lot.packages ?? []).some((pkg: { status: string }) => pkg.status !== "cancelled")).map((lot) => {
    const community = relation(lot.community)
    const plan = relation(lot.plan)
    const elevation = relation(lot.elevation)
    return {
      id: lot.id, communityId: lot.community_id,
      label: `${String(community?.name ?? "Community")} · ${lot.block ? `${lot.block}-` : ""}${lot.lot_number}`,
      plan: [text(plan?.code) ?? text(plan?.name), text(elevation?.code)].filter(Boolean).join(" / ") || null,
    }
  })
}
