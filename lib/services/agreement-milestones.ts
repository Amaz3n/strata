import "server-only"

import { createHash, randomBytes } from "node:crypto"
import { z } from "zod"
import type { SupabaseClient } from "@supabase/supabase-js"

import { verifyInboundSignature } from "@/lib/inbound/signature"
import { decryptIntegrationSecret, encryptIntegrationSecret } from "@/lib/integrations/secrets"
import { readAllRows } from "@/lib/land/paging"
import { chunk } from "@/lib/utils"
import {
  blockedBy,
  gateBlockers,
  gateRefusal,
  isoToday,
  milestoneAging,
  milestoneDeskSignal,
  milestoneReminderKey,
  milestoneReminderThreshold,
  MILESTONE_KINDS,
  MILESTONE_REMINDER_DAYS,
  reportedLabel,
  satisfyRefusal,
  type MilestoneDeskSignal,
  type MilestoneGate,
} from "@/lib/sales/agreement-milestones"
import { recordAudit } from "@/lib/services/audit"
import { authorize, getDivisionScopedProjectIds, requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import {
  addAgreementMilestoneSchema,
  createMilestoneSourceSchema,
  milestoneReportSchema,
  resolveAgreementMilestoneSchema,
  updateAgreementMilestoneSchema,
} from "@/lib/validation/agreement-milestones"

type OrgContext = Awaited<ReturnType<typeof requireOrgContext>>

const MILESTONE_SELECT =
  "id,org_id,contract_id,project_id,kind,title,is_contingency,source,required_before,due_on,owner_user_id,owner_company_id,evidence_required,status,resolved_on,resolved_at,resolved_by,resolution_note,evidence_file_id,reported_status,reported_on,reported_at,reported_reference,sort_order,metadata,version,created_at"

const rowSchema = z.object({
  id: z.string().uuid(),
  org_id: z.string().uuid(),
  contract_id: z.string().uuid(),
  project_id: z.string().uuid(),
  kind: z.enum(MILESTONE_KINDS),
  title: z.string(),
  is_contingency: z.boolean(),
  source: z.enum(["agreement", "manual"]),
  required_before: z.enum(["start", "closing"]).nullable(),
  due_on: z.string().nullable(),
  owner_user_id: z.string().uuid().nullable(),
  owner_company_id: z.string().uuid().nullable(),
  evidence_required: z.boolean(),
  status: z.enum(["open", "satisfied", "waived", "failed"]),
  resolved_on: z.string().nullable(),
  resolved_at: z.string().nullable(),
  resolved_by: z.string().uuid().nullable(),
  resolution_note: z.string().nullable(),
  evidence_file_id: z.string().uuid().nullable(),
  reported_status: z.enum(["in_progress", "satisfied", "failed"]).nullable(),
  reported_on: z.string().nullable(),
  reported_at: z.string().nullable(),
  reported_reference: z.string().nullable(),
  sort_order: z.number().int(),
  metadata: z.record(z.string(), z.unknown()),
  version: z.number().int(),
  created_at: z.string(),
})
type MilestoneRow = z.infer<typeof rowSchema>

const historySchema = z.object({
  id: z.string().uuid(),
  milestone_id: z.string().uuid(),
  source: z.enum(["materialized", "manual", "external"]),
  from_status: z.string().nullable(),
  to_status: z.string(),
  from_due_on: z.string().nullable(),
  to_due_on: z.string().nullable(),
  reported_status: z.string().nullable(),
  actor_id: z.string().uuid().nullable(),
  note: z.string().nullable(),
  created_at: z.string(),
})

const deliverySchema = z.object({
  id: z.string().uuid(),
  source_id: z.string().uuid(),
  delivery_id: z.string(),
  received_at: z.string(),
  outcome: z.enum(["applied", "reported", "refused"]),
  reason_code: z.string().nullable(),
  project_id: z.string().uuid().nullable(),
  milestone_id: z.string().uuid().nullable(),
  payload: z.record(z.string(), z.unknown()),
})

export type AgreementMilestoneDTO = ReturnType<typeof toDTO>
export type MilestoneDeliveryDTO = z.infer<typeof deliverySchema>

/** Rows on one home past which the workbench says it is truncated. */
const HOME_MILESTONE_CAP = 100
const HOME_HISTORY_CAP = 300
const HOME_DELIVERY_CAP = 25
const EVIDENCE_FILE_CAP = 100
const MEMBER_CAP = 300

function toDTO(row: MilestoneRow, all: MilestoneRow[], dependsOn: string[], today: string) {
  const facts = { id: row.id, title: row.title, status: row.status, dependsOn }
  return {
    id: row.id,
    contractId: row.contract_id,
    projectId: row.project_id,
    kind: row.kind,
    title: row.title,
    isContingency: row.is_contingency,
    source: row.source,
    requiredBefore: row.required_before,
    dueOn: row.due_on,
    ownerUserId: row.owner_user_id,
    ownerCompanyId: row.owner_company_id,
    evidenceRequired: row.evidence_required,
    status: row.status,
    resolvedOn: row.resolved_on,
    resolvedBy: row.resolved_by,
    resolutionNote: row.resolution_note,
    evidenceFileId: row.evidence_file_id,
    reportedStatus: row.reported_status,
    reportedOn: row.reported_on,
    reportedReference: row.reported_reference,
    reportedLabel: reportedLabel({ status: row.status, reportedStatus: row.reported_status, evidenceRequired: row.evidence_required }),
    version: row.version,
    dependsOn,
    blockedBy: blockedBy(facts, all.map((other) => ({ id: other.id, title: other.title, status: other.status }))).map((other) => other.title),
    aging: milestoneAging({ status: row.status, dueOn: row.due_on, createdAt: row.created_at }, today),
  }
}

async function readHomeAgreement(supabase: SupabaseClient, orgId: string, projectId: string) {
  const { data, error } = await supabase.from("contracts").select("id,number,status,buyer_contact_id")
    .eq("org_id", orgId).eq("project_id", projectId).eq("contract_type", "purchase_agreement").eq("status", "active")
    .order("signed_at", { ascending: false }).limit(2)
  if (error) throw new Error(`Unable to read the home's purchase agreement: ${error.message}`)
  if ((data ?? []).length > 1) throw new Error("The home has more than one active purchase agreement; reconcile it before tracking milestones")
  return data?.[0] ?? null
}

async function readMilestoneRows(supabase: SupabaseClient, orgId: string, contractId: string) {
  const rows = await readAllRows((from, to) => supabase.from("agreement_milestones").select(MILESTONE_SELECT)
    .eq("org_id", orgId).eq("contract_id", contractId).order("sort_order").order("id").range(from, to),
  { cap: HOME_MILESTONE_CAP + 1, label: "Unable to read the agreement's milestones" })
  return { rows: z.array(rowSchema).parse(rows.rows), truncated: rows.truncated }
}

async function readDependencies(supabase: SupabaseClient, orgId: string, milestoneIds: string[]) {
  if (!milestoneIds.length) return new Map<string, string[]>()
  const { data, error } = await supabase.from("agreement_milestone_dependencies").select("milestone_id,depends_on_id")
    .eq("org_id", orgId).in("milestone_id", milestoneIds).limit(1000)
  if (error) throw new Error(`Unable to read milestone prerequisites: ${error.message}`)
  const edges = z.array(z.object({ milestone_id: z.string().uuid(), depends_on_id: z.string().uuid() })).parse(data ?? [])
  const map = new Map<string, string[]>()
  for (const edge of edges) map.set(edge.milestone_id, [...(map.get(edge.milestone_id) ?? []), edge.depends_on_id])
  return map
}

/**
 * Everything the closing workbench shows about what the sale still owes: the
 * active agreement's milestones with aging and prerequisites, their history,
 * the external reports that reached this home (refused ones included), and the
 * home's files that can stand as evidence.
 */
export async function getHomeAgreementMilestones(projectId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.read", context)
  await requireAuthorization({ permission: "sales.read", orgId: context.orgId, userId: context.userId, projectId,
    supabase: context.supabase, resourceType: "project", resourceId: projectId, logDecision: true })
  const agreement = await readHomeAgreement(context.supabase, context.orgId, projectId)
  const [milestones, deliveries, files, manage] = await Promise.all([
    agreement ? readMilestoneRows(context.supabase, context.orgId, agreement.id) : Promise.resolve({ rows: [], truncated: false }),
    context.supabase.from("agreement_milestone_deliveries").select("id,source_id,delivery_id,received_at,outcome,reason_code,project_id,milestone_id,payload")
      .eq("org_id", context.orgId).eq("project_id", projectId).order("received_at", { ascending: false }).limit(HOME_DELIVERY_CAP),
    context.supabase.from("files").select("id,file_name,created_at").eq("org_id", context.orgId).eq("project_id", projectId)
      .is("archived_at", null).order("created_at", { ascending: false }).limit(EVIDENCE_FILE_CAP + 1),
    authorize({ permission: "closing.manage", orgId: context.orgId, userId: context.userId, projectId, supabase: context.supabase }),
  ])
  if (deliveries.error) throw new Error(`Unable to read milestone reports: ${deliveries.error.message}`)
  if (files.error) throw new Error(`Unable to read the home's files: ${files.error.message}`)
  const ids = milestones.rows.map((row) => row.id)
  const companyIds = [...new Set(milestones.rows.flatMap((row) => row.owner_company_id ? [row.owner_company_id] : []))]
  const [dependencies, history, members, companies] = await Promise.all([
    readDependencies(context.supabase, context.orgId, ids),
    ids.length
      ? context.supabase.from("agreement_milestone_history").select("id,milestone_id,source,from_status,to_status,from_due_on,to_due_on,reported_status,actor_id,note,created_at")
        .eq("org_id", context.orgId).eq("project_id", projectId).in("milestone_id", ids).order("created_at", { ascending: false }).limit(HOME_HISTORY_CAP)
      : Promise.resolve({ data: [], error: null }),
    context.supabase.from("memberships").select("user_id,user:app_users!memberships_user_id_fkey(full_name,email)").eq("org_id", context.orgId).eq("status", "active").limit(MEMBER_CAP),
    companyIds.length
      ? context.supabase.from("companies").select("id,name").eq("org_id", context.orgId).in("id", companyIds)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (history.error) throw new Error(`Unable to read milestone history: ${history.error.message}`)
  if (members.error) throw new Error(`Unable to read the team: ${members.error.message}`)
  if (companies.error) throw new Error(`Unable to read milestone companies: ${companies.error.message}`)
  const people = (members.data ?? []).map((row) => {
    const user = Array.isArray(row.user) ? row.user[0] : row.user
    const name = z.object({ full_name: z.string().nullable(), email: z.string().nullable() }).nullable().optional().parse(user)
    return { id: z.string().uuid().parse(row.user_id), name: name?.full_name || name?.email || "Team member" }
  }).sort((a, b) => a.name.localeCompare(b.name))
  const companyNames = new Map(z.array(z.object({ id: z.string().uuid(), name: z.string() })).parse(companies.data ?? []).map((row) => [row.id, row.name]))
  const today = isoToday(new Date())
  const fileRows = z.array(z.object({ id: z.string().uuid(), file_name: z.string() })).parse(files.data ?? [])
  return {
    agreement: agreement ? { id: String(agreement.id), number: agreement.number === null ? null : String(agreement.number) } : null,
    milestones: milestones.rows.slice(0, HOME_MILESTONE_CAP).map((row) => toDTO(row, milestones.rows, dependencies.get(row.id) ?? [], today)),
    truncated: milestones.truncated,
    history: z.array(historySchema).parse(history.data ?? []),
    deliveries: z.array(deliverySchema).parse(deliveries.data ?? []),
    evidenceFiles: fileRows.slice(0, EVIDENCE_FILE_CAP).map((row) => ({ id: row.id, name: row.file_name })),
    evidenceFilesTruncated: fileRows.length > EVIDENCE_FILE_CAP,
    canManage: manage.allowed,
    members: people,
    companyNames: Object.fromEntries(companyNames),
  }
}

async function authorizeMilestoneWrite(context: OrgContext, projectId: string, resourceId: string) {
  await requireAuthorization({ permission: "closing.manage", orgId: context.orgId, userId: context.userId, projectId,
    supabase: context.supabase, resourceType: "agreement_milestone", resourceId, logDecision: true })
}

async function loadMilestone(context: OrgContext, milestoneId: string) {
  const { data, error } = await context.supabase.from("agreement_milestones").select(MILESTONE_SELECT)
    .eq("org_id", context.orgId).eq("id", milestoneId).maybeSingle()
  if (error) throw new Error(`Unable to read the milestone: ${error.message}`)
  if (!data) throw new Error("Milestone not found")
  const row = rowSchema.parse(data)
  await authorizeMilestoneWrite(context, row.project_id, row.id)
  return row
}

async function writeMilestone(context: OrgContext, before: MilestoneRow, version: number, patch: Record<string, unknown>) {
  const { data, error } = await context.supabase.from("agreement_milestones").update({ ...patch, updated_by: context.userId })
    .eq("org_id", context.orgId).eq("id", before.id).eq("version", version).select(MILESTONE_SELECT).maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new Error("This milestone changed since you opened it. Refresh and try again.")
  return rowSchema.parse(data)
}

async function recordMilestoneChange(context: OrgContext, eventType: string, before: MilestoneRow | null, after: MilestoneRow) {
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType, entityType: "agreement_milestone", entityId: after.id,
      payload: { project_id: after.project_id, contract_id: after.contract_id, title: after.title, status: after.status, due_on: after.due_on, required_before: after.required_before } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: before ? "update" : "insert", entityType: "agreement_milestone", entityId: after.id,
      before: before ?? undefined, after }),
  ])
}

export async function addAgreementMilestone(input: unknown, orgId?: string) {
  const parsed = addAgreementMilestoneSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("closing.manage", context)
  await authorizeMilestoneWrite(context, parsed.projectId, parsed.projectId)
  const agreement = await readHomeAgreement(context.supabase, context.orgId, parsed.projectId)
  if (!agreement) throw new Error("This home has no executed purchase agreement to track milestones on")
  const { data, error } = await context.supabase.from("agreement_milestones").insert({
    org_id: context.orgId, contract_id: agreement.id, project_id: parsed.projectId,
    template_key: `manual:${randomBytes(8).toString("hex")}`, kind: parsed.kind, title: parsed.title,
    is_contingency: parsed.isContingency, source: "manual", required_before: parsed.requiredBefore, due_on: parsed.dueOn,
    owner_user_id: parsed.ownerUserId, owner_company_id: parsed.ownerCompanyId, evidence_required: parsed.evidenceRequired,
    sort_order: 500, created_by: context.userId, updated_by: context.userId,
  }).select(MILESTONE_SELECT).single()
  if (error || !data) throw new Error(`Failed to add the milestone: ${error?.message ?? "no row returned"}`)
  const row = rowSchema.parse(data)
  if (parsed.dependsOn.length) {
    const { error: edgeError } = await context.supabase.from("agreement_milestone_dependencies")
      .insert(parsed.dependsOn.map((dependsOnId) => ({ org_id: context.orgId, milestone_id: row.id, depends_on_id: dependsOnId })))
    if (edgeError) throw new Error(`The milestone was added, but its prerequisites were refused: ${edgeError.message}`)
  }
  await recordMilestoneChange(context, "agreement_milestone.added", null, row)
  return row
}

/** Owner and due date. A signed contingency's due date moves only as an audited extension with a reason. */
export async function updateAgreementMilestone(input: unknown, orgId?: string) {
  const parsed = updateAgreementMilestoneSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("closing.manage", context)
  const before = await loadMilestone(context, parsed.milestoneId)
  const patch: Record<string, unknown> = { change_reason: parsed.reason?.length ? parsed.reason : null }
  if (parsed.ownerUserId !== undefined) patch.owner_user_id = parsed.ownerUserId
  if (parsed.ownerCompanyId !== undefined) patch.owner_company_id = parsed.ownerCompanyId
  if (parsed.dueOn !== undefined && parsed.dueOn !== before.due_on) {
    if (before.source === "agreement" && (parsed.reason?.length ?? 0) < 10) throw new Error("Extending a signed milestone needs a reason of at least 10 characters")
    patch.due_on = parsed.dueOn
  }
  if (parsed.requiredBefore !== undefined && parsed.requiredBefore !== before.required_before) {
    if (before.source === "agreement") throw new Error("What a signed milestone holds changes only by amending the agreement")
    patch.required_before = parsed.requiredBefore
  }
  const after = await writeMilestone(context, before, parsed.version, patch)
  await recordMilestoneChange(context, parsed.dueOn !== undefined && parsed.dueOn !== before.due_on ? "agreement_milestone.extended" : "agreement_milestone.updated", before, after)
  return after
}

export async function resolveAgreementMilestone(input: unknown, orgId?: string) {
  const parsed = resolveAgreementMilestoneSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("closing.manage", context)
  const before = await loadMilestone(context, parsed.milestoneId)
  let patch: Record<string, unknown>
  if (parsed.resolution === "open") {
    if (before.status === "open") throw new Error("The milestone is already open")
    patch = { status: "open", resolved_on: null, resolved_at: null, resolved_by: null, resolution_note: null, change_reason: parsed.note }
  } else {
    if (before.status !== "open" && !(parsed.resolution === "waived" && before.status === "failed")) {
      throw new Error("Reopen the milestone before recording a different outcome")
    }
    if (parsed.resolution === "satisfied") {
      const siblings = await readMilestoneRows(context.supabase, context.orgId, before.contract_id)
      const dependencies = await readDependencies(context.supabase, context.orgId, [before.id])
      const refusal = satisfyRefusal({ status: before.status, evidenceRequired: before.evidence_required, dependsOn: dependencies.get(before.id) ?? [] },
        siblings.rows.map((row) => ({ id: row.id, title: row.title, status: row.status })), parsed.evidenceFileId)
      if (refusal) throw new Error(refusal)
    }
    patch = {
      status: parsed.resolution, resolved_on: parsed.resolvedOn, resolved_at: new Date().toISOString(), resolved_by: context.userId,
      resolution_note: parsed.note?.length ? parsed.note : null, change_reason: null,
      ...(parsed.resolution === "satisfied" ? { evidence_file_id: parsed.evidenceFileId } : {}),
    }
  }
  const after = await writeMilestone(context, before, parsed.version, patch)
  await recordMilestoneChange(context, `agreement_milestone.${parsed.resolution === "open" ? "reopened" : parsed.resolution}`, before, after)
  return after
}

/**
 * The milestones of the home's executed agreement holding a gate, most urgent
 * first. Read with the caller's client inside a check that already authorized
 * the home (closing readiness, the start gate).
 */
export async function readAgreementMilestoneBlockers(supabase: SupabaseClient, orgId: string, projectId: string, gate: MilestoneGate) {
  const { data, error } = await supabase.from("agreement_milestones")
    .select("id,contract_id,title,status,required_before,due_on")
    .eq("org_id", orgId).eq("project_id", projectId).eq("required_before", gate).in("status", ["open", "failed"]).limit(100)
  if (error) throw new Error(`Unable to verify the agreement's milestones: ${error.message}`)
  const rows = z.array(z.object({ id: z.string().uuid(), contract_id: z.string().uuid(), title: z.string(), status: z.enum(["open", "failed"]), required_before: z.enum(["start", "closing"]), due_on: z.string().nullable() }))
    .parse((data ?? []).map((row) => ({ id: row.id, contract_id: row.contract_id, title: row.title, status: row.status, required_before: row.required_before, due_on: row.due_on })))
  if (!rows.length) return []
  // Only the agreement in force holds anything; a void one's rows are history.
  const { data: active, error: contractError } = await supabase.from("contracts").select("id")
    .eq("org_id", orgId).in("id", [...new Set(rows.map((row) => row.contract_id))]).eq("contract_type", "purchase_agreement").eq("status", "active")
  if (contractError) throw new Error(`Unable to verify the agreement's milestones: ${contractError.message}`)
  const inForce = new Set((active ?? []).map((row) => String(row.id)))
  return gateBlockers(rows.filter((row) => inForce.has(row.contract_id)).map((row) => ({ ...row, requiredBefore: row.required_before, dueOn: row.due_on })), gate)
}

/** Throws the gate's sentence when a milestone holds it. */
export async function assertAgreementMilestonesClear(supabase: SupabaseClient, orgId: string, projectId: string, gate: MilestoneGate) {
  const [blocker] = await readAgreementMilestoneBlockers(supabase, orgId, projectId, gate)
  if (blocker) throw new Error(gateRefusal(blocker, gate))
}

/**
 * The Sales desk's milestone column: one signal per home for the homes the
 * desk lists, scoped to what the reader can reach. Judgment is
 * `milestoneDeskAction` / `nextActionFor`.
 */
export async function readMilestoneDeskSignals(projectIds: string[], orgId?: string): Promise<Record<string, MilestoneDeskSignal>> {
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.read", context)
  const scoped = await getDivisionScopedProjectIds({ orgId: context.orgId, userId: context.userId, supabase: context.supabase })
  const ids = [...new Set(projectIds)].filter((id) => scoped === null || scoped.includes(id)).slice(0, 500)
  const result: Record<string, MilestoneDeskSignal> = {}
  if (!ids.length) return result
  // A hundred homes per request keeps the id list inside the request URL.
  const batches = await Promise.all(chunk(ids, 100).map((batch) => readAllRows((from, to) => context.supabase.from("agreement_milestones")
    .select("project_id,title,status,due_on,contract:contracts!inner(status)")
    .eq("org_id", context.orgId).in("project_id", batch).in("status", ["open", "failed"]).eq("contract.status", "active")
    .order("id").range(from, to), { cap: 5001, label: "Unable to read the desk's milestones" })))
  if (batches.some((rows) => rows.truncated)) throw new Error("Too many open milestones to rank; narrow the desk's scope")
  const parsed = z.array(z.object({ project_id: z.string().uuid(), title: z.string(), status: z.enum(["open", "failed"]), due_on: z.string().nullable() }))
    .parse(batches.flatMap((rows) => rows.rows).map((row) => ({ project_id: row.project_id, title: row.title, status: row.status, due_on: row.due_on })))
  const byHome = new Map<string, Array<{ title: string; status: "open" | "failed"; dueOn: string | null }>>()
  for (const row of parsed) byHome.set(row.project_id, [...(byHome.get(row.project_id) ?? []), { title: row.title, status: row.status, dueOn: row.due_on }])
  const today = isoToday(new Date())
  for (const [projectId, homeRows] of byHome) result[projectId] = milestoneDeskSignal(homeRows, today)
  return result
}

const SWEEP_PAGE = 500

type DueMilestoneRow = {
  id: string; org_id: string; project_id: string; contract_id: string; title: string; due_on: string | null
  owner_user_id: string | null; required_before: string | null; metadata: unknown
}

async function announceMilestonePage(service: ReturnType<typeof createServiceSupabaseClient>, page: DueMilestoneRow[], today: string, now: Date) {
  // A home that has closed owes nothing more; its leftover tracked rows stay quiet.
  // Batched: a sweep across every org's homes would overflow one request's URL.
  const homeIds = [...new Set(page.map((row) => String(row.project_id)))]
  const closed = await Promise.all(chunk(homeIds, 100).map((batch) =>
    service.from("closings").select("project_id").in("project_id", batch).eq("status", "closed")))
  const closedError = closed.find((result) => result.error)?.error
  if (closedError) throw new Error(`Failed to read closed homes: ${closedError.message}`)
  const closedHomes = new Set(closed.flatMap((result) => (result.data ?? []).map((row) => String(row.project_id))))
  let announced = 0
  for (const row of page) {
    if (closedHomes.has(String(row.project_id))) continue
    const metadata = z.record(z.string(), z.unknown()).parse(row.metadata ?? {})
    const dueOn = z.string().parse(row.due_on)
    const threshold = milestoneReminderThreshold(dueOn, today, metadata)
    if (threshold === null) continue
    await recordEvent({ orgId: row.org_id, actorId: null, eventType: "agreement_milestone.due", entityType: "agreement_milestone", entityId: row.id,
      payload: { project_id: row.project_id, contract_id: row.contract_id, title: row.title, due_on: dueOn, days_out: Math.round((Date.parse(`${dueOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000),
        required_before: row.required_before, owner_user_id: row.owner_user_id } })
    // The marker is metadata only; it is not a status change, so it leaves no history row.
    const { error: markError } = await service.from("agreement_milestones").update({ metadata: { ...metadata, [milestoneReminderKey(threshold)]: now.toISOString() } })
      .eq("org_id", row.org_id).eq("id", row.id)
    if (markError) throw new Error(`Failed to record the milestone reminder: ${markError.message}`)
    announced += 1
  }
  return announced
}

/**
 * The daily reminder sweep: each open dated milestone is announced once at each
 * threshold (7, 3, 1 days out, then due or late) to its owner, or to whoever
 * runs closings on the home when nobody owns it.
 */
export async function sweepAgreementMilestoneDeadlines(now: Date = new Date()) {
  const service = createServiceSupabaseClient()
  const today = isoToday(now)
  const horizon = new Date(now.getTime() + Math.max(...MILESTONE_REMINDER_DAYS) * 86_400_000).toISOString().slice(0, 10)
  // Paged by (due_on, id): a fixed cap would let a backlog of long-late rows
  // crowd every newly late milestone out of the sweep for good.
  let announced = 0
  let after: { dueOn: string; id: string } | null = null
  for (;;) {
    let query = service.from("agreement_milestones")
      .select("id,org_id,project_id,contract_id,title,due_on,owner_user_id,required_before,metadata,contract:contracts!inner(status)")
      .eq("status", "open").eq("contract.status", "active").not("due_on", "is", null).lte("due_on", horizon)
    if (after) query = query.or(`due_on.gt.${after.dueOn},and(due_on.eq.${after.dueOn},id.gt.${after.id})`)
    const { data, error } = await query.order("due_on").order("id").limit(SWEEP_PAGE)
    if (error) throw new Error(`Failed to load due milestones: ${error.message}`)
    const page = data ?? []
    announced += await announceMilestonePage(service, page, today, now)
    if (page.length < SWEEP_PAGE) break
    const last = page[page.length - 1]
    after = { dueOn: z.string().parse(last.due_on), id: String(last.id) }
  }
  return { announced }
}

// ---------------------------------------------------------------------------
// Signed external updates.
// ---------------------------------------------------------------------------

const SECRET_GRACE_MS = 24 * 3_600_000
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567"

function publicSourceId() {
  return `ams_${Array.from(randomBytes(24), (byte) => BASE32[byte % 32]).join("")}`
}

const sourceSchema = z.object({
  id: z.string().uuid(), name: z.string(), public_id: z.string(), secret_hint: z.string(), status: z.enum(["active", "disabled"]),
  previous_secret_expires_at: z.string().nullable(), last_received_at: z.string().nullable(), last_rejected_at: z.string().nullable(),
  last_rejection_reason: z.string().nullable(), rejected_count: z.number().int(), created_at: z.string(),
})
const SOURCE_SELECT = "id,name,public_id,secret_hint,status,previous_secret_expires_at,last_received_at,last_rejected_at,last_rejection_reason,rejected_count,created_at"
const SOURCE_CAP = 50
const ORG_DELIVERY_CAP = 100

/** Lender and title feeds and the deliveries they sent, for whoever runs the integration. */
export async function listMilestoneSources(orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("org.admin", context)
  const [sources, deliveries] = await Promise.all([
    context.supabase.from("agreement_milestone_sources").select(SOURCE_SELECT).eq("org_id", context.orgId).order("created_at").limit(SOURCE_CAP + 1),
    context.supabase.from("agreement_milestone_deliveries").select("id,source_id,delivery_id,received_at,outcome,reason_code,project_id,milestone_id,payload")
      .eq("org_id", context.orgId).order("received_at", { ascending: false }).limit(ORG_DELIVERY_CAP + 1),
  ])
  if (sources.error) throw new Error(`Unable to read milestone feeds: ${sources.error.message}`)
  if (deliveries.error) throw new Error(`Unable to read milestone deliveries: ${deliveries.error.message}`)
  const sourceRows = z.array(sourceSchema).parse(sources.data ?? [])
  const deliveryRows = z.array(deliverySchema).parse(deliveries.data ?? [])
  return {
    sources: sourceRows.slice(0, SOURCE_CAP), sourcesTruncated: sourceRows.length > SOURCE_CAP,
    deliveries: deliveryRows.slice(0, ORG_DELIVERY_CAP), deliveriesTruncated: deliveryRows.length > ORG_DELIVERY_CAP,
  }
}

function newSecret() {
  const secret = `amsk_${randomBytes(32).toString("hex")}`
  return { secret, encrypted: encryptIntegrationSecret(secret), hint: secret.slice(-4) }
}

/** Creates a feed and returns its signing secret once; it is stored only encrypted. */
export async function createMilestoneSource(input: unknown, orgId?: string) {
  const parsed = createMilestoneSourceSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("org.admin", context)
  const { secret, encrypted, hint } = newSecret()
  // Members never read the secret columns, so the write goes through the service client.
  const { data, error } = await createServiceSupabaseClient().from("agreement_milestone_sources").insert({
    org_id: context.orgId, name: parsed.name, public_id: publicSourceId(), signing_secret_encrypted: encrypted, secret_hint: hint, created_by: context.userId,
  }).select(SOURCE_SELECT).single()
  if (error || !data) throw new Error(`Failed to create the feed: ${error?.message ?? "no row returned"}`)
  const source = sourceSchema.parse(data)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "agreement_milestone_source.created", entityType: "agreement_milestone_source", entityId: source.id, payload: { name: source.name } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "agreement_milestone_source", entityId: source.id, after: source }),
  ])
  return { source, secret }
}

/** A new secret; the previous one keeps working for 24 hours so the sender can switch. */
export async function rotateMilestoneSourceSecret(sourceId: string, orgId?: string) {
  const id = z.string().uuid().parse(sourceId)
  const context = await requireOrgContext(orgId)
  await requirePermission("org.admin", context)
  const service = createServiceSupabaseClient()
  const { data: current, error: readError } = await service.from("agreement_milestone_sources").select("id,status,signing_secret_encrypted")
    .eq("org_id", context.orgId).eq("id", id).maybeSingle()
  if (readError) throw new Error(`Unable to read the feed: ${readError.message}`)
  if (!current || current.status !== "active") throw new Error("Active feed not found")
  const { secret, encrypted, hint } = newSecret()
  const { data, error } = await service.from("agreement_milestone_sources").update({
    signing_secret_encrypted: encrypted, secret_hint: hint, previous_secret_encrypted: current.signing_secret_encrypted,
    previous_secret_expires_at: new Date(Date.now() + SECRET_GRACE_MS).toISOString(),
  }).eq("org_id", context.orgId).eq("id", id).eq("signing_secret_encrypted", current.signing_secret_encrypted).select(SOURCE_SELECT).maybeSingle()
  if (error) throw new Error(`Failed to rotate the secret: ${error.message}`)
  if (!data) throw new Error("The feed's secret changed concurrently. Refresh and try again.")
  const source = sourceSchema.parse(data)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "agreement_milestone_source.rotated", entityType: "agreement_milestone_source", entityId: id, payload: { name: source.name } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "agreement_milestone_source", entityId: id, after: { secret_hint: hint } }),
  ])
  return { source, secret }
}

export async function disableMilestoneSource(sourceId: string, orgId?: string) {
  const id = z.string().uuid().parse(sourceId)
  const context = await requireOrgContext(orgId)
  await requirePermission("org.admin", context)
  const { data, error } = await createServiceSupabaseClient().from("agreement_milestone_sources")
    .update({ status: "disabled", previous_secret_encrypted: null, previous_secret_expires_at: null })
    .eq("org_id", context.orgId).eq("id", id).eq("status", "active").select(SOURCE_SELECT).maybeSingle()
  if (error) throw new Error(`Failed to disable the feed: ${error.message}`)
  if (!data) throw new Error("Active feed not found")
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "agreement_milestone_source.disabled", entityType: "agreement_milestone_source", entityId: id, payload: {} }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "agreement_milestone_source", entityId: id, after: { status: "disabled" } }),
  ])
  return sourceSchema.parse(data)
}

/** Largest body the endpoint reads. */
export const MILESTONE_REPORT_MAX_BYTES = 64 * 1024

export type MilestoneReportReceipt = { status: number; body: Record<string, unknown> }

const reportResultSchema = z.object({
  outcome: z.enum(["applied", "reported", "refused", "duplicate", "conflict"]),
  reason_code: z.string().nullable().optional(),
  original_outcome: z.string().optional(),
  milestone_id: z.string().uuid().nullable().optional(),
  delivery_id: z.string().uuid().nullable().optional(),
})

/**
 * One signed POST from a lender or title company. Unknown feeds and bad
 * signatures learn nothing (401); a signed delivery is always kept, and one that
 * does not reconcile to the agreement, buyer and home is refused with its code.
 */
export async function receiveMilestoneReport(input: {
  sourcePublicId: string | null
  deliveryId: string | null
  timestamp: string | null
  signature: string | null
  rawBody: string
  now?: Date
}): Promise<MilestoneReportReceipt> {
  const unauthorized = { status: 401, body: { error: "unauthorized" } }
  if (!input.sourcePublicId || !/^ams_[a-z2-7]{24}$/.test(input.sourcePublicId)) return unauthorized
  const service = createServiceSupabaseClient()
  const { data: source, error } = await service.from("agreement_milestone_sources")
    .select("id,org_id,status,signing_secret_encrypted,previous_secret_encrypted,previous_secret_expires_at")
    .eq("public_id", input.sourcePublicId).maybeSingle()
  if (error) throw new Error(`Unable to read the milestone feed: ${error.message}`)
  if (!source || source.status !== "active") return unauthorized
  const now = input.now ?? new Date()
  const secrets = [decryptIntegrationSecret(source.signing_secret_encrypted)]
  if (source.previous_secret_encrypted && source.previous_secret_expires_at && Date.parse(source.previous_secret_expires_at) > now.getTime()) {
    secrets.push(decryptIntegrationSecret(source.previous_secret_encrypted))
  }
  const verdict = verifyInboundSignature({ secrets, timestamp: input.timestamp, signature: input.signature, rawBody: input.rawBody, now })
  if (!verdict.ok) {
    const { error: rejectError } = await service.rpc("record_agreement_milestone_rejection", {
      p_source_id: source.id, p_reason: verdict.reason, p_at: now.toISOString(),
    })
    if (rejectError) throw new Error(`Unable to record the rejected delivery: ${rejectError.message}`)
    return unauthorized
  }

  // The delivery id is read from the signed body; the header, when sent, must agree.
  let raw: unknown = null
  try {
    raw = JSON.parse(input.rawBody)
  } catch {
    raw = null
  }
  const body = z.record(z.string(), z.unknown()).safeParse(raw).data ?? {}
  const deliveryId = typeof body.delivery_id === "string" ? body.delivery_id.trim() : ""
  if (!deliveryId || deliveryId.length > 200 || (input.deliveryId && input.deliveryId !== deliveryId)) {
    return { status: 400, body: { error: "delivery_id is required in the signed body and must match x-arc-delivery" } }
  }
  const parsed = milestoneReportSchema.safeParse(body)
  const payload: Record<string, unknown> = parsed.success ? parsed.data : body
  const invalid = parsed.success ? null : "invalid_payload"
  const digest = createHash("sha256").update(input.rawBody).digest("hex")
  const { data, error: applyError } = await service.rpc("apply_agreement_milestone_report", {
    p_source_id: source.id, p_delivery_id: deliveryId, p_digest: digest, p_payload: payload, p_invalid_reason: invalid,
  })
  if (applyError) throw new Error(`Unable to apply the milestone report: ${applyError.message}`)
  const result = reportResultSchema.parse(data)
  if (result.outcome === "conflict") return { status: 409, body: { outcome: "conflict", reason_code: "delivery_conflict" } }
  if (result.outcome === "refused" || (result.outcome === "duplicate" && result.original_outcome === "refused")) {
    return { status: 422, body: { outcome: result.outcome, reason_code: result.reason_code ?? null } }
  }
  return { status: 200, body: { outcome: result.outcome, ...(result.original_outcome ? { original_outcome: result.original_outcome } : {}), milestone_id: result.milestone_id ?? null } }
}
