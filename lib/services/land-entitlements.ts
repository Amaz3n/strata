import type { SupabaseClient } from "@supabase/supabase-js"

import { pendingReminderThreshold } from "@/lib/land/diligence"
import {
  closingBlockers,
  communityEntitlementPressure,
  entitlementBlockers,
  phaseReadiness,
  type CommunityEntitlementPressure,
  type ConditionFact,
  type ConditionStatus,
  type EntitlementBlocker,
  type EntitlementFact,
  type EntitlementKind,
  type EntitlementMilestone,
  type EntitlementStatus,
  type PhaseReadiness,
} from "@/lib/land/entitlement-readiness"
import { readAllRows } from "@/lib/land/paging"
import { recordAudit } from "@/lib/services/audit"
import { requireCommunityScope } from "@/lib/services/communities"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { hasPermission, requirePermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import {
  conditionInputSchema,
  conditionMeetSchema,
  conditionWaiveSchema,
  entitlementInputSchema,
  entitlementUpdateSchema,
  type ConditionInput,
  type EntitlementInput,
  type EntitlementUpdate,
} from "@/lib/validation/land-entitlements"

type OrgContext = Awaited<ReturnType<typeof requireOrgContext>>

/** A community's approvals are read whole up to this many; past it the tab says so. */
export const ENTITLEMENT_CAP = 200
const CONDITION_CAP = 2_000
const PEOPLE_CAP = 500

export interface EntitlementConditionDTO {
  id: string
  entitlementId: string
  title: string
  description: string | null
  phaseId: string | null
  requiredBefore: EntitlementMilestone | null
  dueOn: string | null
  ownerUserId: string | null
  ownerName: string | null
  status: ConditionStatus
  metOn: string | null
  waivedReason: string | null
}

export interface EntitlementDTO {
  id: string
  communityId: string
  phaseId: string | null
  kind: EntitlementKind
  name: string
  jurisdiction: string | null
  referenceNumber: string | null
  status: EntitlementStatus
  requiredBefore: EntitlementMilestone | null
  submittedOn: string | null
  targetOn: string | null
  approvedOn: string | null
  expiresOn: string | null
  ownerUserId: string | null
  ownerName: string | null
  notes: string | null
  conditions: EntitlementConditionDTO[]
}

export interface CommunityEntitlementsTab {
  communityId: string
  phases: Array<{ id: string; name: string }>
  entitlements: EntitlementDTO[]
  readiness: PhaseReadiness[]
  people: Array<{ id: string; name: string }>
  canWrite: boolean
  /** True when the community holds more than ENTITLEMENT_CAP approvals. */
  truncated: boolean
  today: string
}

type Person = { full_name: string | null; email: string | null }
/** PostgREST answers an embedded row as an object or a one-element array, depending on what it can infer. */
type Embedded<T> = T | T[] | null

function one<T>(value: Embedded<T> | undefined): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null)
}

interface EntitlementRow {
  id: string
  community_id: string
  community_phase_id: string | null
  kind: EntitlementKind
  name: string
  jurisdiction: string | null
  reference_number: string | null
  status: EntitlementStatus
  required_before: EntitlementMilestone | null
  submitted_on: string | null
  target_on: string | null
  approved_on: string | null
  expires_on: string | null
  owner_user_id: string | null
  notes: string | null
  owner?: Embedded<Person>
}

interface ConditionRow {
  id: string
  entitlement_id: string
  community_id: string
  community_phase_id: string | null
  title: string
  description: string | null
  required_before: EntitlementMilestone | null
  due_on: string | null
  owner_user_id: string | null
  status: ConditionStatus
  met_on: string | null
  waived_reason: string | null
  owner?: Embedded<Person>
}

type EntitlementFactRow = Pick<
  EntitlementRow,
  "id" | "name" | "community_phase_id" | "status" | "required_before" | "approved_on" | "expires_on" | "target_on"
>
type ConditionFactRow = Pick<
  ConditionRow,
  "id" | "entitlement_id" | "title" | "community_phase_id" | "status" | "required_before" | "due_on"
>

function today() {
  return new Date().toISOString().slice(0, 10)
}

function personName(value: Embedded<Person> | undefined): string | null {
  const person = one(value)
  if (!person) return null
  return person.full_name || person.email || null
}

function toEntitlementFact(row: EntitlementFactRow): EntitlementFact {
  return {
    id: row.id,
    name: row.name,
    phaseId: row.community_phase_id,
    status: row.status,
    requiredBefore: row.required_before,
    approvedOn: row.approved_on,
    expiresOn: row.expires_on,
    dueOn: row.target_on,
  }
}

function toConditionFact(row: ConditionFactRow): ConditionFact {
  return {
    id: row.id,
    entitlementId: row.entitlement_id,
    title: row.title,
    phaseId: row.community_phase_id,
    status: row.status,
    requiredBefore: row.required_before,
    dueOn: row.due_on,
  }
}

async function logMutation(input: {
  context: OrgContext
  eventType: string
  entityType: string
  entityId: string
  action: "insert" | "update" | "delete"
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  payload?: Record<string, unknown>
}) {
  const { context } = input
  await Promise.all([
    recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: input.eventType,
      entityType: input.entityType,
      entityId: input.entityId,
      payload: input.payload,
    }),
    recordAudit({
      orgId: context.orgId,
      actorId: context.userId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      before: input.before,
      after: input.after,
    }),
  ])
}

const ENTITLEMENT_SELECT =
  "id, community_id, community_phase_id, kind, name, jurisdiction, reference_number, status, required_before, submitted_on, target_on, approved_on, expires_on, owner_user_id, notes, owner:app_users!land_entitlements_owner_user_id_fkey(full_name, email)"
const CONDITION_SELECT =
  "id, entitlement_id, community_id, community_phase_id, title, description, required_before, due_on, owner_user_id, status, met_on, waived_reason, owner:app_users!land_entitlement_conditions_owner_user_id_fkey(full_name, email)"

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------

/** A community's entitlements with their conditions, and the readiness of each phase. */
export async function listCommunityEntitlements(communityId: string, orgId?: string): Promise<{
  entitlements: EntitlementDTO[]
  readiness: PhaseReadiness[]
  phases: Array<{ id: string; name: string }>
  truncated: boolean
}> {
  const context = await requireOrgContext(orgId)
  await requirePermission("community.read", context)
  await requireCommunityScope(communityId, context)

  const [entitlements, conditions, phases] = await Promise.all([
    context.supabase
      .from("land_entitlements")
      .select(ENTITLEMENT_SELECT)
      .eq("org_id", context.orgId)
      .eq("community_id", communityId)
      .order("created_at")
      .order("id")
      .limit(ENTITLEMENT_CAP + 1),
    readAllRows<ConditionRow>(
      (from, to) =>
        context.supabase
          .from("land_entitlement_conditions")
          .select(CONDITION_SELECT)
          .eq("org_id", context.orgId)
          .eq("community_id", communityId)
          .order("due_on", { ascending: true, nullsFirst: false })
          .order("id")
          .range(from, to),
      { cap: CONDITION_CAP, label: "Failed to load entitlement conditions" },
    ),
    context.supabase
      .from("community_phases")
      .select("id, name, phase_number")
      .eq("org_id", context.orgId)
      .eq("community_id", communityId)
      .order("phase_number"),
  ])
  if (entitlements.error) throw new Error(`Failed to load entitlements: ${entitlements.error.message}`)
  if (phases.error) throw new Error(`Failed to load phases: ${phases.error.message}`)
  const entitlementRows: EntitlementRow[] = (entitlements.data ?? []).slice(0, ENTITLEMENT_CAP)
  const phaseRows: Array<{ id: string; name: string }> = phases.data ?? []

  const conditionsByEntitlement = new Map<string, EntitlementConditionDTO[]>()
  for (const row of conditions.rows) {
    const list = conditionsByEntitlement.get(row.entitlement_id) ?? []
    list.push({
      id: row.id,
      entitlementId: row.entitlement_id,
      title: row.title,
      description: row.description,
      phaseId: row.community_phase_id,
      requiredBefore: row.required_before,
      dueOn: row.due_on,
      ownerUserId: row.owner_user_id,
      ownerName: personName(row.owner),
      status: row.status,
      metOn: row.met_on,
      waivedReason: row.waived_reason,
    })
    conditionsByEntitlement.set(row.entitlement_id, list)
  }

  return {
    entitlements: entitlementRows.map((row) => ({
      id: row.id,
      communityId: row.community_id,
      phaseId: row.community_phase_id,
      kind: row.kind,
      name: row.name,
      jurisdiction: row.jurisdiction,
      referenceNumber: row.reference_number,
      status: row.status,
      requiredBefore: row.required_before,
      submittedOn: row.submitted_on,
      targetOn: row.target_on,
      approvedOn: row.approved_on,
      expiresOn: row.expires_on,
      ownerUserId: row.owner_user_id,
      ownerName: personName(row.owner),
      notes: row.notes,
      conditions: conditionsByEntitlement.get(row.id) ?? [],
    })),
    readiness: phaseReadiness({
      entitlements: entitlementRows.map(toEntitlementFact),
      conditions: conditions.rows.map(toConditionFact),
      phaseIds: phaseRows.map((phase) => phase.id),
      today: today(),
    }),
    phases: phaseRows.map((phase) => ({ id: phase.id, name: phase.name })),
    truncated: (entitlements.data ?? []).length > ENTITLEMENT_CAP || conditions.truncated,
  }
}

/**
 * Everything the Community → Land tab's Entitlements section needs, in one
 * call: the entitlements, the phases they narrow to, readiness, the people an
 * item can be owned by, and whether the caller may record them.
 */
export async function loadCommunityEntitlementsTab(communityId: string, orgId?: string): Promise<CommunityEntitlementsTab> {
  const context = await requireOrgContext(orgId)
  const [data, canWrite, members] = await Promise.all([
    listCommunityEntitlements(communityId, context.orgId),
    hasPermission("community.write", context),
    createServiceSupabaseClient()
      .from("memberships")
      .select("user_id, user:app_users!memberships_user_id_fkey(full_name, email)")
      .eq("org_id", context.orgId)
      .eq("status", "active")
      .order("created_at")
      .order("id")
      .limit(PEOPLE_CAP),
  ])
  if (members.error) throw new Error(`Failed to load the team: ${members.error.message}`)
  const memberRows: Array<{ user_id: string; user: Embedded<Person> }> = members.data ?? []
  return {
    communityId,
    ...data,
    people: memberRows
      .map((row) => ({ id: row.user_id, name: personName(row.user) ?? "Unnamed member" }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    canWrite,
    today: today(),
  }
}

/**
 * What holds a vertical start on a lot: every unmet entitlement or condition
 * required before vertical start (or lot delivery) for the lot's phase. Read
 * with the caller's client -- the starts gate's, which already proved access to
 * the package.
 */
export async function loadEntitlementBlockersForLot(
  supabase: SupabaseClient,
  orgId: string,
  lot: { communityId: string; phaseId: string | null },
  through: EntitlementMilestone = "vertical_start",
): Promise<EntitlementBlocker[]> {
  const facts = await readLotEntitlementFacts(supabase, orgId, lot.communityId)
  return entitlementBlockers({ ...facts, phaseId: lot.phaseId, through, today: today() })
}

/** What is due before this lot's home closes. Informational: the closing workbench shows it, nothing gates on it. */
export async function loadClosingBlockersForLot(
  supabase: SupabaseClient,
  orgId: string,
  lot: { communityId: string; phaseId: string | null },
): Promise<EntitlementBlocker[]> {
  const facts = await readLotEntitlementFacts(supabase, orgId, lot.communityId)
  return closingBlockers({ ...facts, phaseId: lot.phaseId, today: today() })
}

async function readLotEntitlementFacts(supabase: SupabaseClient, orgId: string, communityId: string) {
  const [entitlements, conditions] = await Promise.all([
    supabase
      .from("land_entitlements")
      .select("id, name, community_phase_id, status, required_before, approved_on, expires_on, target_on")
      .eq("org_id", orgId)
      .eq("community_id", communityId)
      .not("required_before", "is", null)
      .limit(ENTITLEMENT_CAP + 1),
    supabase
      .from("land_entitlement_conditions")
      .select("id, entitlement_id, title, community_phase_id, status, required_before, due_on")
      .eq("org_id", orgId)
      .eq("community_id", communityId)
      .eq("status", "open")
      .not("required_before", "is", null)
      .limit(CONDITION_CAP + 1),
  ])
  if (entitlements.error) throw new Error(`Failed to check entitlements: ${entitlements.error.message}`)
  if (conditions.error) throw new Error(`Failed to check entitlement conditions: ${conditions.error.message}`)
  // A read that hit its ceiling cannot prove nothing else blocks.
  if ((entitlements.data ?? []).length > ENTITLEMENT_CAP || (conditions.data ?? []).length > CONDITION_CAP) {
    throw new Error("Too many entitlements to verify this lot; narrow them by phase")
  }
  const entitlementRows: EntitlementFactRow[] = entitlements.data ?? []
  const conditionRows: ConditionFactRow[] = conditions.data ?? []
  return { entitlements: entitlementRows.map(toEntitlementFact), conditions: conditionRows.map(toConditionFact) }
}

/** Per community: unmet items holding delivery or starts, and how many are overdue. For the portfolio lanes. */
export async function countEntitlementBlockersByCommunity(
  supabase: SupabaseClient,
  orgId: string,
  communityIds: string[],
): Promise<Map<string, CommunityEntitlementPressure>> {
  const result = new Map<string, CommunityEntitlementPressure>()
  if (communityIds.length === 0) return result
  const [entitlements, conditions] = await Promise.all([
    readAllRows<EntitlementFactRow & { community_id: string }>(
      (from, to) =>
        supabase
          .from("land_entitlements")
          .select("id, community_id, name, community_phase_id, status, required_before, approved_on, expires_on, target_on")
          .eq("org_id", orgId)
          .in("community_id", communityIds)
          .not("required_before", "is", null)
          .order("id")
          .range(from, to),
      { cap: 20_000, label: "Failed to load entitlements" },
    ),
    readAllRows<ConditionFactRow & { community_id: string }>(
      (from, to) =>
        supabase
          .from("land_entitlement_conditions")
          .select("id, community_id, entitlement_id, title, community_phase_id, status, required_before, due_on")
          .eq("org_id", orgId)
          .in("community_id", communityIds)
          .eq("status", "open")
          .not("required_before", "is", null)
          .order("id")
          .range(from, to),
      { cap: 20_000, label: "Failed to load entitlement conditions" },
    ),
  ])
  const byCommunity = new Map<string, { entitlements: EntitlementFact[]; conditions: ConditionFact[] }>()
  const bucket = (communityId: string) => {
    const existing = byCommunity.get(communityId)
    if (existing) return existing
    const created: { entitlements: EntitlementFact[]; conditions: ConditionFact[] } = { entitlements: [], conditions: [] }
    byCommunity.set(communityId, created)
    return created
  }
  for (const row of entitlements.rows) bucket(row.community_id).entitlements.push(toEntitlementFact(row))
  for (const row of conditions.rows) bucket(row.community_id).conditions.push(toConditionFact(row))
  const now = today()
  for (const [communityId, facts] of byCommunity) {
    const pressure = communityEntitlementPressure({ ...facts, today: now })
    if (pressure.open > 0) result.set(communityId, pressure)
  }
  return result
}

// ---------------------------------------------------------------------------
// Entitlement mutations (community.write).
// ---------------------------------------------------------------------------

function entitlementPatch(parsed: EntitlementUpdate) {
  const patch: Record<string, unknown> = {}
  if (parsed.communityPhaseId !== undefined) patch.community_phase_id = parsed.communityPhaseId ?? null
  if (parsed.kind !== undefined) patch.kind = parsed.kind
  if (parsed.name !== undefined) patch.name = parsed.name
  if (parsed.jurisdiction !== undefined) patch.jurisdiction = parsed.jurisdiction || null
  if (parsed.agencyCompanyId !== undefined) patch.agency_company_id = parsed.agencyCompanyId ?? null
  if (parsed.referenceNumber !== undefined) patch.reference_number = parsed.referenceNumber || null
  if (parsed.status !== undefined) patch.status = parsed.status
  if (parsed.requiredBefore !== undefined) patch.required_before = parsed.requiredBefore ?? null
  if (parsed.submittedOn !== undefined) patch.submitted_on = parsed.submittedOn || null
  if (parsed.targetOn !== undefined) patch.target_on = parsed.targetOn || null
  if (parsed.approvedOn !== undefined) patch.approved_on = parsed.approvedOn || null
  if (parsed.expiresOn !== undefined) patch.expires_on = parsed.expiresOn || null
  if (parsed.ownerUserId !== undefined) patch.owner_user_id = parsed.ownerUserId ?? null
  if (parsed.notes !== undefined) patch.notes = parsed.notes || null
  return patch
}

async function requireEntitlement(context: OrgContext, entitlementId: string) {
  const { data, error } = await context.supabase
    .from("land_entitlements")
    .select("*")
    .eq("org_id", context.orgId)
    .eq("id", entitlementId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load entitlement: ${error.message}`)
  if (!data) throw new Error("Entitlement not found")
  await requireCommunityScope(data.community_id, context)
  return data
}

async function requireCondition(context: OrgContext, conditionId: string) {
  const { data, error } = await context.supabase
    .from("land_entitlement_conditions")
    .select("*")
    .eq("org_id", context.orgId)
    .eq("id", conditionId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load condition: ${error.message}`)
  if (!data) throw new Error("Condition not found")
  await requireCommunityScope(data.community_id, context)
  return data
}

export async function createEntitlement(communityId: string, input: EntitlementInput, orgId?: string): Promise<{ id: string }> {
  const parsed = entitlementInputSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("community.write", context)
  await requireCommunityScope(communityId, context)
  const { data, error } = await context.supabase
    .from("land_entitlements")
    .insert({ org_id: context.orgId, community_id: communityId, created_by: context.userId, ...entitlementPatch(parsed) })
    .select("*")
    .single()
  if (error) throw new Error(`Failed to record entitlement: ${error.message}`)
  await logMutation({
    context,
    eventType: "land_entitlement.created",
    entityType: "land_entitlement",
    entityId: data.id,
    action: "insert",
    after: data,
    payload: { community_id: communityId, name: data.name, kind: data.kind, status: data.status },
  })
  return { id: data.id }
}

export async function updateEntitlement(entitlementId: string, input: EntitlementUpdate, orgId?: string): Promise<void> {
  const parsed = entitlementUpdateSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("community.write", context)
  const before = await requireEntitlement(context, entitlementId)
  const status = parsed.status ?? before.status
  const approvedOn = parsed.approvedOn !== undefined ? parsed.approvedOn : before.approved_on
  if (status === "approved" && !approvedOn) throw new Error("An approved entitlement needs its approval date")
  const patch = entitlementPatch(parsed)
  if (Object.keys(patch).length === 0) return
  const { data, error } = await context.supabase
    .from("land_entitlements")
    .update(patch)
    .eq("org_id", context.orgId)
    .eq("id", entitlementId)
    .select("*")
    .single()
  if (error) throw new Error(`Failed to update entitlement: ${error.message}`)
  const statusChanged = data.status !== before.status
  await logMutation({
    context,
    eventType: statusChanged ? "land_entitlement.status_changed" : "land_entitlement.updated",
    entityType: "land_entitlement",
    entityId: entitlementId,
    action: "update",
    before,
    after: data,
    payload: { community_id: data.community_id, name: data.name, from_status: before.status, status: data.status },
  })
}

/** Only an entitlement nobody has started, with no conditions recorded, can be removed. */
export async function deleteEntitlement(entitlementId: string, orgId?: string): Promise<void> {
  const context = await requireOrgContext(orgId)
  await requirePermission("community.write", context)
  const before = await requireEntitlement(context, entitlementId)
  if (before.status !== "not_started") throw new Error("Only a not-started entitlement can be removed; withdraw it instead")
  const { count, error: countError } = await context.supabase
    .from("land_entitlement_conditions")
    .select("id", { count: "exact", head: true })
    .eq("org_id", context.orgId)
    .eq("entitlement_id", entitlementId)
  if (countError) throw new Error(`Failed to check conditions: ${countError.message}`)
  if ((count ?? 0) > 0) throw new Error("This entitlement has conditions recorded; withdraw it instead")
  const { error } = await context.supabase.from("land_entitlements").delete().eq("org_id", context.orgId).eq("id", entitlementId)
  if (error) throw new Error(`Failed to remove entitlement: ${error.message}`)
  await logMutation({
    context,
    eventType: "land_entitlement.deleted",
    entityType: "land_entitlement",
    entityId: entitlementId,
    action: "delete",
    before,
    payload: { community_id: before.community_id, name: before.name },
  })
}

// ---------------------------------------------------------------------------
// Conditions.
// ---------------------------------------------------------------------------

function conditionPatch(parsed: Partial<ConditionInput>) {
  const patch: Record<string, unknown> = {}
  if (parsed.title !== undefined) patch.title = parsed.title
  if (parsed.description !== undefined) patch.description = parsed.description || null
  if (parsed.communityPhaseId !== undefined) patch.community_phase_id = parsed.communityPhaseId ?? null
  if (parsed.requiredBefore !== undefined) patch.required_before = parsed.requiredBefore ?? null
  if (parsed.dueOn !== undefined) patch.due_on = parsed.dueOn || null
  if (parsed.ownerUserId !== undefined) patch.owner_user_id = parsed.ownerUserId ?? null
  if (parsed.ownerCompanyId !== undefined) patch.owner_company_id = parsed.ownerCompanyId ?? null
  return patch
}

/** A condition inherits its entitlement's phase unless it names a narrower one, and its milestone unless it names its own. */
export async function createCondition(entitlementId: string, input: ConditionInput, orgId?: string): Promise<{ id: string }> {
  const parsed = conditionInputSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("community.write", context)
  const entitlement = await requireEntitlement(context, entitlementId)
  const patch = conditionPatch(parsed)
  const { data, error } = await context.supabase
    .from("land_entitlement_conditions")
    .insert({
      org_id: context.orgId,
      entitlement_id: entitlementId,
      community_id: entitlement.community_id,
      ...patch,
      community_phase_id: parsed.communityPhaseId ?? entitlement.community_phase_id,
      required_before: parsed.requiredBefore ?? entitlement.required_before,
    })
    .select("*")
    .single()
  if (error) throw new Error(`Failed to record condition: ${error.message}`)
  await logMutation({
    context,
    eventType: "land_entitlement_condition.created",
    entityType: "land_entitlement_condition",
    entityId: data.id,
    action: "insert",
    after: data,
    payload: { community_id: data.community_id, entitlement_id: entitlementId, title: data.title },
  })
  return { id: data.id }
}

export async function updateCondition(conditionId: string, input: Partial<ConditionInput>, orgId?: string): Promise<void> {
  const parsed = conditionInputSchema.partial().parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("community.write", context)
  const before = await requireCondition(context, conditionId)
  const patch = conditionPatch(parsed)
  if (Object.keys(patch).length === 0) return
  const { data, error } = await context.supabase
    .from("land_entitlement_conditions")
    .update(patch)
    .eq("org_id", context.orgId)
    .eq("id", conditionId)
    .select("*")
    .single()
  if (error) throw new Error(`Failed to update condition: ${error.message}`)
  await logMutation({
    context,
    eventType: "land_entitlement_condition.updated",
    entityType: "land_entitlement_condition",
    entityId: conditionId,
    action: "update",
    before,
    after: data,
    payload: { community_id: data.community_id, entitlement_id: data.entitlement_id, title: data.title },
  })
}

async function setConditionStatus(
  conditionId: string,
  next: { status: ConditionStatus; met_on: string | null; waived_reason: string | null },
  eventType: string,
  orgId?: string,
) {
  const context = await requireOrgContext(orgId)
  await requirePermission("community.write", context)
  const before = await requireCondition(context, conditionId)
  const { data, error } = await context.supabase
    .from("land_entitlement_conditions")
    .update({ ...next, resolved_by: next.status === "open" ? null : context.userId })
    .eq("org_id", context.orgId)
    .eq("id", conditionId)
    .select("*")
    .single()
  if (error) throw new Error(`Failed to update condition: ${error.message}`)
  await logMutation({
    context,
    eventType,
    entityType: "land_entitlement_condition",
    entityId: conditionId,
    action: "update",
    before,
    after: data,
    payload: { community_id: data.community_id, entitlement_id: data.entitlement_id, title: data.title, status: data.status },
  })
}

export async function meetCondition(conditionId: string, input: { metOn: string }, orgId?: string): Promise<void> {
  const { metOn } = conditionMeetSchema.parse(input)
  await setConditionStatus(conditionId, { status: "met", met_on: metOn, waived_reason: null }, "land_entitlement_condition.met", orgId)
}

export async function waiveCondition(conditionId: string, input: { reason: string }, orgId?: string): Promise<void> {
  const { reason } = conditionWaiveSchema.parse(input)
  await setConditionStatus(conditionId, { status: "waived", met_on: null, waived_reason: reason }, "land_entitlement_condition.waived", orgId)
}

export async function reopenCondition(conditionId: string, orgId?: string): Promise<void> {
  await setConditionStatus(conditionId, { status: "open", met_on: null, waived_reason: null }, "land_entitlement_condition.reopened", orgId)
}

export async function deleteCondition(conditionId: string, orgId?: string): Promise<void> {
  const context = await requireOrgContext(orgId)
  await requirePermission("community.write", context)
  const before = await requireCondition(context, conditionId)
  if (before.status !== "open") throw new Error("Only an open condition can be removed; reopen it first")
  const { error } = await context.supabase.from("land_entitlement_conditions").delete().eq("org_id", context.orgId).eq("id", conditionId)
  if (error) throw new Error(`Failed to remove condition: ${error.message}`)
  await logMutation({
    context,
    eventType: "land_entitlement_condition.deleted",
    entityType: "land_entitlement_condition",
    entityId: conditionId,
    action: "delete",
    before,
    payload: { community_id: before.community_id, entitlement_id: before.entitlement_id, title: before.title },
  })
}

// ---------------------------------------------------------------------------
// Deadlines.
// ---------------------------------------------------------------------------

/** Conditions coming due, and entitlements not yet in hand coming up on their target date. */
export const CONDITION_REMINDER_DAYS = [30, 7, 0] as const
/** Approved entitlements running out. */
export const ENTITLEMENT_EXPIRY_REMINDER_DAYS = [60, 30, 0] as const
const SWEEP_BATCH = 200

function reminderKey(days: number) {
  return `reminded_at_${days}d`
}

function expiryKey(days: number) {
  return `expiry_reminded_at_${days}d`
}

/**
 * Announce open conditions coming due, unapproved entitlements reaching their
 * target date and approved ones about to expire. Each threshold fires once per
 * row (marker in its metadata). Runs as the system, from the land deadlines cron.
 */
export async function sweepEntitlementDeadlines(now: Date = new Date()): Promise<{ conditions: number; entitlements: number }> {
  const service = createServiceSupabaseClient()
  const todayIso = now.toISOString().slice(0, 10)
  const horizon = (days: number) => {
    const date = new Date(now)
    date.setUTCDate(date.getUTCDate() + days)
    return date.toISOString().slice(0, 10)
  }
  const daysOut = (date: string) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / 86_400_000)

  const [conditionsResult, targetsResult, expiringResult] = await Promise.all([
    service
      .from("land_entitlement_conditions")
      .select("id, org_id, community_id, entitlement_id, title, due_on, owner_user_id, required_before, metadata")
      .eq("status", "open")
      .not("due_on", "is", null)
      .lte("due_on", horizon(Math.max(...CONDITION_REMINDER_DAYS)))
      .order("due_on")
      .order("id")
      .limit(SWEEP_BATCH),
    service
      .from("land_entitlements")
      .select("id, org_id, community_id, name, target_on, owner_user_id, required_before, status, metadata")
      .in("status", ["not_started", "submitted"])
      .not("target_on", "is", null)
      .lte("target_on", horizon(Math.max(...CONDITION_REMINDER_DAYS)))
      .order("target_on")
      .order("id")
      .limit(SWEEP_BATCH),
    service
      .from("land_entitlements")
      .select("id, org_id, community_id, name, expires_on, owner_user_id, required_before, status, metadata")
      .eq("status", "approved")
      .not("expires_on", "is", null)
      .lte("expires_on", horizon(Math.max(...ENTITLEMENT_EXPIRY_REMINDER_DAYS)))
      .order("expires_on")
      .order("id")
      .limit(SWEEP_BATCH),
  ])
  if (conditionsResult.error) throw new Error(`Failed to load due conditions: ${conditionsResult.error.message}`)
  if (targetsResult.error) throw new Error(`Failed to load entitlement targets: ${targetsResult.error.message}`)
  if (expiringResult.error) throw new Error(`Failed to load expiring entitlements: ${expiringResult.error.message}`)

  let conditions = 0
  const conditionRows: Array<{
    id: string
    org_id: string
    community_id: string
    entitlement_id: string
    title: string
    due_on: string
    owner_user_id: string | null
    required_before: string | null
    metadata: Record<string, unknown> | null
  }> = conditionsResult.data ?? []
  for (const row of conditionRows) {
    const metadata = row.metadata ?? {}
    const out = daysOut(row.due_on)
    const threshold = pendingReminderThreshold(CONDITION_REMINDER_DAYS, out, metadata, reminderKey)
    if (threshold === null) continue
    await recordEvent({
      orgId: row.org_id,
      actorId: null,
      eventType: "land_entitlement_condition.due",
      entityType: "land_entitlement_condition",
      entityId: row.id,
      payload: {
        community_id: row.community_id,
        entitlement_id: row.entitlement_id,
        title: row.title,
        due_on: row.due_on,
        days_out: out,
        required_before: row.required_before,
        owner_user_id: row.owner_user_id,
      },
    })
    const { error } = await service
      .from("land_entitlement_conditions")
      .update({ metadata: { ...metadata, [reminderKey(threshold)]: now.toISOString() } })
      .eq("org_id", row.org_id)
      .eq("id", row.id)
    if (error) throw new Error(`Failed to record the condition reminder: ${error.message}`)
    conditions += 1
  }

  let entitlements = 0
  type EntitlementSweepRow = {
    id: string
    org_id: string
    community_id: string
    name: string
    target_on?: string
    expires_on?: string
    owner_user_id: string | null
    required_before: string | null
    status: string
    metadata: Record<string, unknown> | null
  }
  const announce = async (row: EntitlementSweepRow, date: string, kind: "due" | "expiring", thresholds: ReadonlyArray<number>, keyFor: (days: number) => string) => {
    const metadata = row.metadata ?? {}
    const out = daysOut(date)
    const threshold = pendingReminderThreshold(thresholds, out, metadata, keyFor)
    if (threshold === null) return
    await recordEvent({
      orgId: row.org_id,
      actorId: null,
      eventType: kind === "due" ? "land_entitlement.due" : "land_entitlement.expiring",
      entityType: "land_entitlement",
      entityId: row.id,
      payload: {
        community_id: row.community_id,
        title: row.name,
        due_on: date,
        days_out: out,
        required_before: row.required_before,
        owner_user_id: row.owner_user_id,
      },
    })
    const { error } = await service
      .from("land_entitlements")
      .update({ metadata: { ...metadata, [keyFor(threshold)]: now.toISOString() } })
      .eq("org_id", row.org_id)
      .eq("id", row.id)
    if (error) throw new Error(`Failed to record the entitlement reminder: ${error.message}`)
    entitlements += 1
  }
  const targetRows: EntitlementSweepRow[] = targetsResult.data ?? []
  for (const row of targetRows) {
    if (row.target_on) await announce(row, row.target_on, "due", CONDITION_REMINDER_DAYS, reminderKey)
  }
  const expiringRows: EntitlementSweepRow[] = expiringResult.data ?? []
  for (const row of expiringRows) {
    if (row.expires_on) await announce(row, row.expires_on, "expiring", ENTITLEMENT_EXPIRY_REMINDER_DAYS, expiryKey)
  }

  return { conditions, entitlements }
}
