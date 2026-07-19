import type { SupabaseClient } from "@supabase/supabase-js"

import type { LotStatus } from "@/lib/land/lot-lifecycle"
import { LOT_STATUSES } from "@/lib/land/lot-lifecycle"
import { getDivisionAccessForUser } from "@/lib/services/authorization"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"
import {
  communityInputSchema,
  communityUpdateSchema,
  phaseInputSchema,
  phaseUpdateSchema,
  takedownInputSchema,
  takedownUpdateSchema,
  type CommunityInput,
  type PhaseInput,
  type TakedownInput,
} from "@/lib/validation/communities"

export interface CommunityPhaseDTO {
  id: string
  communityId: string
  name: string
  phaseNumber: number
  status: "planned" | "open" | "built_out"
  targetOpenDate: string | null
  notes: string | null
}

export interface LotTakedownDTO {
  id: string
  communityId: string
  communityPhaseId: string | null
  name: string
  scheduledDate: string | null
  actualDate: string | null
  lotCount: number
  linkedLotCount: number
  pricePerLotCents: number | null
  depositCents: number
  status: "scheduled" | "closed" | "cancelled"
  sellerCompanyId: string | null
  notes: string | null
}

export interface CommunityListItemDTO {
  id: string
  name: string
  code: string | null
  status: "planning" | "active" | "sold_out" | "closed"
  divisionId: string | null
  divisionName: string | null
  city: string | null
  state: string | null
  plannedLotCount: number | null
  lotCounts: Record<LotStatus, number>
}

export interface CommunityDetailDTO extends CommunityListItemDTO {
  address: string | null
  postalCode: string | null
  description: string | null
  phases: CommunityPhaseDTO[]
  takedowns: LotTakedownDTO[]
}

type CommunityRow = {
  id: string
  name: string
  code: string | null
  status: CommunityListItemDTO["status"]
  division_id: string | null
  address: string | null
  city: string | null
  state: string | null
  postal_code: string | null
  description: string | null
  planned_lot_count: number | null
  division?: { name?: string | null } | Array<{ name?: string | null }> | null
}

type PhaseRow = {
  id: string
  community_id: string
  name: string
  phase_number: number
  status: CommunityPhaseDTO["status"]
  target_open_date: string | null
  notes: string | null
}

type TakedownRow = {
  id: string
  community_id: string
  community_phase_id: string | null
  name: string
  scheduled_date: string | null
  actual_date: string | null
  lot_count: number
  price_per_lot_cents: number | null
  deposit_cents: number
  status: LotTakedownDTO["status"]
  seller_company_id: string | null
  notes: string | null
}

function emptyLotCounts(): Record<LotStatus, number> {
  return Object.fromEntries(LOT_STATUSES.map((status) => [status, 0])) as Record<LotStatus, number>
}

function relationName(relation: CommunityRow["division"]) {
  if (Array.isArray(relation)) return relation[0]?.name ?? null
  return relation?.name ?? null
}

function mapCommunity(row: CommunityRow, lotCounts: Record<LotStatus, number>): CommunityListItemDTO {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    status: row.status,
    divisionId: row.division_id,
    divisionName: relationName(row.division),
    city: row.city,
    state: row.state,
    plannedLotCount: row.planned_lot_count,
    lotCounts,
  }
}

function mapPhase(row: PhaseRow): CommunityPhaseDTO {
  return {
    id: row.id,
    communityId: row.community_id,
    name: row.name,
    phaseNumber: row.phase_number,
    status: row.status,
    targetOpenDate: row.target_open_date,
    notes: row.notes,
  }
}

function mapTakedown(row: TakedownRow, linkedLotCount = 0): LotTakedownDTO {
  return {
    id: row.id,
    communityId: row.community_id,
    communityPhaseId: row.community_phase_id,
    name: row.name,
    scheduledDate: row.scheduled_date,
    actualDate: row.actual_date,
    lotCount: Number(row.lot_count),
    linkedLotCount,
    pricePerLotCents: row.price_per_lot_cents == null ? null : Number(row.price_per_lot_cents),
    depositCents: Number(row.deposit_cents),
    status: row.status,
    sellerCompanyId: row.seller_company_id,
    notes: row.notes,
  }
}

async function getLotCountMap(supabase: SupabaseClient, orgId: string) {
  const { data, error } = await supabase.rpc("get_community_lot_status_counts", { check_org_id: orgId })
  if (error) throw new Error(`Failed to count community lots: ${error.message}`)
  const counts = new Map<string, Record<LotStatus, number>>()
  for (const row of data ?? []) {
    const communityId = String(row.community_id)
    const status = row.status as LotStatus
    const current = counts.get(communityId) ?? emptyLotCounts()
    if (LOT_STATUSES.includes(status)) current[status] = Number(row.lot_count)
    counts.set(communityId, current)
  }
  return counts
}

async function allowedDivisionScope(orgId: string, userId: string) {
  return getDivisionAccessForUser({ orgId, userId })
}

async function assertDivisionBelongsToOrg(
  supabase: SupabaseClient,
  orgId: string,
  divisionId: string | null | undefined,
) {
  if (!divisionId) return
  const { data, error } = await supabase
    .from("divisions")
    .select("id")
    .eq("org_id", orgId)
    .eq("id", divisionId)
    .is("archived_at", null)
    .maybeSingle()
  if (error || !data) throw new Error("Division not found")
}

function applyCommunityInput(parsed: Partial<CommunityInput>) {
  const patch: Record<string, unknown> = {}
  if (parsed.name !== undefined) patch.name = parsed.name
  if (parsed.divisionId !== undefined) patch.division_id = parsed.divisionId
  if (parsed.code !== undefined) patch.code = parsed.code || null
  if (parsed.status !== undefined) patch.status = parsed.status
  if (parsed.address !== undefined) patch.address = parsed.address || null
  if (parsed.city !== undefined) patch.city = parsed.city || null
  if (parsed.state !== undefined) patch.state = parsed.state || null
  if (parsed.postalCode !== undefined) patch.postal_code = parsed.postalCode || null
  if (parsed.description !== undefined) patch.description = parsed.description || null
  if (parsed.plannedLotCount !== undefined) patch.planned_lot_count = parsed.plannedLotCount
  if (parsed.settings !== undefined) patch.settings = parsed.settings
  if (parsed.metadata !== undefined) patch.metadata = parsed.metadata
  return patch
}

export async function listCommunities(
  { divisionId, status }: { divisionId?: string; status?: string } = {},
  orgId?: string,
): Promise<CommunityListItemDTO[]> {
  const context = await requireOrgContext(orgId)
  await requirePermission("community.read", context)
  const scope = await allowedDivisionScope(context.orgId, context.userId)
  if (scope.assignedOnly && scope.divisionIds.length === 0) return []
  let query = context.supabase
    .from("communities")
    .select("id, name, code, status, division_id, address, city, state, postal_code, description, planned_lot_count, division:divisions(name)")
    .eq("org_id", context.orgId)
    .is("archived_at", null)
    .order("name")
    .limit(200)
  if (scope.assignedOnly) query = query.in("division_id", scope.divisionIds)
  if (divisionId) {
    if (scope.assignedOnly && !scope.divisionIds.includes(divisionId)) return []
    query = query.eq("division_id", divisionId)
  }
  if (status) query = query.eq("status", status)
  const [communitiesResult, countMap] = await Promise.all([
    query,
    getLotCountMap(context.supabase, context.orgId),
  ])
  if (communitiesResult.error) throw new Error(`Failed to list communities: ${communitiesResult.error.message}`)
  return (communitiesResult.data ?? []).map((row) => {
    const mapped = row as CommunityRow
    return mapCommunity(mapped, countMap.get(mapped.id) ?? emptyLotCounts())
  })
}

export async function getCommunity(id: string, orgId?: string): Promise<CommunityDetailDTO> {
  const context = await requireOrgContext(orgId)
  const community = (await listCommunities({}, context.orgId)).find((candidate) => candidate.id === id)
  if (!community) throw new Error("Community not found")
  const [detailResult, phasesResult, takedownsResult, linkedLotsResult] = await Promise.all([
    context.supabase
      .from("communities")
      .select("address, postal_code, description")
      .eq("org_id", context.orgId)
      .eq("id", id)
      .single(),
    context.supabase
      .from("community_phases")
      .select("id, community_id, name, phase_number, status, target_open_date, notes")
      .eq("org_id", context.orgId)
      .eq("community_id", id)
      .order("phase_number"),
    context.supabase
      .from("lot_takedowns")
      .select("id, community_id, community_phase_id, name, scheduled_date, actual_date, lot_count, price_per_lot_cents, deposit_cents, status, seller_company_id, notes")
      .eq("org_id", context.orgId)
      .eq("community_id", id)
      .order("scheduled_date", { ascending: true, nullsFirst: false }),
    context.supabase
      .from("lots")
      .select("takedown_id")
      .eq("org_id", context.orgId)
      .eq("community_id", id)
      .not("takedown_id", "is", null),
  ])
  if (detailResult.error) throw new Error(`Failed to load community: ${detailResult.error.message}`)
  if (phasesResult.error) throw new Error(`Failed to load phases: ${phasesResult.error.message}`)
  if (takedownsResult.error) throw new Error(`Failed to load takedowns: ${takedownsResult.error.message}`)
  if (linkedLotsResult.error) throw new Error(`Failed to count takedown lots: ${linkedLotsResult.error.message}`)
  const linkedCounts = new Map<string, number>()
  for (const row of linkedLotsResult.data ?? []) {
    if (!row.takedown_id) continue
    linkedCounts.set(row.takedown_id, (linkedCounts.get(row.takedown_id) ?? 0) + 1)
  }
  return {
    ...community,
    address: detailResult.data.address,
    postalCode: detailResult.data.postal_code,
    description: detailResult.data.description,
    phases: (phasesResult.data ?? []).map((row) => mapPhase(row as PhaseRow)),
    takedowns: (takedownsResult.data ?? []).map((row) =>
      mapTakedown(row as TakedownRow, linkedCounts.get(row.id) ?? 0),
    ),
  }
}

async function logMutation(input: {
  orgId: string
  userId: string
  eventType: string
  entityType: string
  entityId: string
  action: "insert" | "update" | "delete"
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  payload?: Record<string, unknown>
}) {
  await Promise.all([
    recordEvent({ orgId: input.orgId, actorId: input.userId, eventType: input.eventType, entityType: input.entityType, entityId: input.entityId, payload: input.payload }),
    recordAudit({ orgId: input.orgId, actorId: input.userId, action: input.action, entityType: input.entityType, entityId: input.entityId, before: input.before, after: input.after }),
  ])
}

export async function createCommunity(input: CommunityInput, orgId?: string): Promise<CommunityDetailDTO> {
  const parsed = communityInputSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("community.write", context)
  await assertDivisionBelongsToOrg(context.supabase, context.orgId, parsed.divisionId)
  const { data, error } = await context.supabase
    .from("communities")
    .insert({ org_id: context.orgId, ...applyCommunityInput(parsed) })
    .select("id, name, status, division_id")
    .single()
  if (error) throw new Error(`Failed to create community: ${error.message}`)
  await logMutation({ orgId: context.orgId, userId: context.userId, eventType: "community.created", entityType: "community", entityId: data.id, action: "insert", after: data, payload: { name: data.name } })
  return getCommunity(data.id, context.orgId)
}

export async function updateCommunity(
  id: string,
  input: Partial<CommunityInput>,
  orgId?: string,
): Promise<CommunityDetailDTO> {
  const parsed = communityUpdateSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("community.write", context)
  if (parsed.divisionId !== undefined) await assertDivisionBelongsToOrg(context.supabase, context.orgId, parsed.divisionId)
  const { data: before, error: beforeError } = await context.supabase
    .from("communities")
    .select("*")
    .eq("org_id", context.orgId)
    .eq("id", id)
    .maybeSingle()
  if (beforeError || !before) throw new Error("Community not found")
  const { data, error } = await context.supabase
    .from("communities")
    .update(applyCommunityInput(parsed))
    .eq("org_id", context.orgId)
    .eq("id", id)
    .select("*")
    .single()
  if (error) throw new Error(`Failed to update community: ${error.message}`)
  if (parsed.divisionId !== undefined && parsed.divisionId !== before.division_id) {
    const { data: linkedLots, error: lotsError } = await context.supabase
      .from("lots")
      .select("project_id")
      .eq("org_id", context.orgId)
      .eq("community_id", id)
    if (lotsError) throw new Error(`Failed to resolve linked projects: ${lotsError.message}`)
    const projectIds = (linkedLots ?? []).map((row) => row.project_id).filter((value): value is string => Boolean(value))
    const { error: updateLotsError } = await context.supabase
      .from("lots")
      .update({ division_id: parsed.divisionId })
      .eq("org_id", context.orgId)
      .eq("community_id", id)
    if (updateLotsError) throw new Error(`Failed to update lot divisions: ${updateLotsError.message}`)
    if (projectIds.length > 0) {
      const { error: updateProjectsError } = await context.supabase
        .from("projects")
        .update({ division_id: parsed.divisionId })
        .eq("org_id", context.orgId)
        .in("id", projectIds)
      if (updateProjectsError) throw new Error(`Failed to update project divisions: ${updateProjectsError.message}`)
    }
  }
  await logMutation({ orgId: context.orgId, userId: context.userId, eventType: "community.updated", entityType: "community", entityId: id, action: "update", before, after: data, payload: { name: data.name } })
  return getCommunity(id, context.orgId)
}

export async function archiveCommunity(id: string, orgId?: string): Promise<void> {
  const context = await requireOrgContext(orgId)
  await requirePermission("community.write", context)
  const { data: before, error: beforeError } = await context.supabase
    .from("communities")
    .select("*")
    .eq("org_id", context.orgId)
    .eq("id", id)
    .maybeSingle()
  if (beforeError || !before) throw new Error("Community not found")
  const after = { ...before, archived_at: new Date().toISOString() }
  const { error } = await context.supabase.from("communities").update({ archived_at: after.archived_at }).eq("org_id", context.orgId).eq("id", id)
  if (error) throw new Error(`Failed to archive community: ${error.message}`)
  await logMutation({ orgId: context.orgId, userId: context.userId, eventType: "community.archived", entityType: "community", entityId: id, action: "update", before, after, payload: { name: before.name } })
}

function phasePayload(parsed: Partial<PhaseInput>) {
  const patch: Record<string, unknown> = {}
  if (parsed.name !== undefined) patch.name = parsed.name
  if (parsed.phaseNumber !== undefined) patch.phase_number = parsed.phaseNumber
  if (parsed.status !== undefined) patch.status = parsed.status
  if (parsed.targetOpenDate !== undefined) patch.target_open_date = parsed.targetOpenDate
  if (parsed.notes !== undefined) patch.notes = parsed.notes || null
  return patch
}

export async function createCommunityPhase(communityId: string, input: PhaseInput, orgId?: string): Promise<CommunityPhaseDTO> {
  const parsed = phaseInputSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("community.write", context)
  await getCommunity(communityId, context.orgId)
  const { data, error } = await context.supabase.from("community_phases").insert({ org_id: context.orgId, community_id: communityId, ...phasePayload(parsed) }).select("id, community_id, name, phase_number, status, target_open_date, notes").single()
  if (error) throw new Error(`Failed to create phase: ${error.message}`)
  await logMutation({ orgId: context.orgId, userId: context.userId, eventType: "community_phase.created", entityType: "community_phase", entityId: data.id, action: "insert", after: data, payload: { community_id: communityId, name: data.name } })
  return mapPhase(data as PhaseRow)
}

export async function updateCommunityPhase(id: string, input: Partial<PhaseInput>, orgId?: string): Promise<CommunityPhaseDTO> {
  const parsed = phaseUpdateSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("community.write", context)
  const { data: before, error: beforeError } = await context.supabase.from("community_phases").select("*").eq("org_id", context.orgId).eq("id", id).maybeSingle()
  if (beforeError || !before) throw new Error("Community phase not found")
  const { data, error } = await context.supabase.from("community_phases").update(phasePayload(parsed)).eq("org_id", context.orgId).eq("id", id).select("id, community_id, name, phase_number, status, target_open_date, notes").single()
  if (error) throw new Error(`Failed to update phase: ${error.message}`)
  await logMutation({ orgId: context.orgId, userId: context.userId, eventType: "community_phase.updated", entityType: "community_phase", entityId: id, action: "update", before, after: data, payload: { community_id: data.community_id, name: data.name } })
  return mapPhase(data as PhaseRow)
}

export async function deleteCommunityPhase(id: string, orgId?: string): Promise<void> {
  const context = await requireOrgContext(orgId)
  await requirePermission("community.write", context)
  const { count, error: countError } = await context.supabase.from("lots").select("id", { count: "exact", head: true }).eq("org_id", context.orgId).eq("community_phase_id", id)
  if (countError) throw new Error(`Failed to check phase use: ${countError.message}`)
  if ((count ?? 0) > 0) throw new Error("Move this phase's lots before deleting it.")
  const { data: before, error: beforeError } = await context.supabase.from("community_phases").select("*").eq("org_id", context.orgId).eq("id", id).maybeSingle()
  if (beforeError || !before) throw new Error("Community phase not found")
  const { error } = await context.supabase.from("community_phases").delete().eq("org_id", context.orgId).eq("id", id)
  if (error) throw new Error(`Failed to delete phase: ${error.message}`)
  await logMutation({ orgId: context.orgId, userId: context.userId, eventType: "community_phase.deleted", entityType: "community_phase", entityId: id, action: "delete", before, payload: { community_id: before.community_id, name: before.name } })
}

function takedownPayload(parsed: Partial<TakedownInput>) {
  const patch: Record<string, unknown> = {}
  if (parsed.name !== undefined) patch.name = parsed.name
  if (parsed.communityPhaseId !== undefined) patch.community_phase_id = parsed.communityPhaseId
  if (parsed.scheduledDate !== undefined) patch.scheduled_date = parsed.scheduledDate
  if (parsed.actualDate !== undefined) patch.actual_date = parsed.actualDate
  if (parsed.lotCount !== undefined) patch.lot_count = parsed.lotCount
  if (parsed.pricePerLotCents !== undefined) patch.price_per_lot_cents = parsed.pricePerLotCents
  if (parsed.depositCents !== undefined) patch.deposit_cents = parsed.depositCents
  if (parsed.status !== undefined) patch.status = parsed.status
  if (parsed.sellerCompanyId !== undefined) patch.seller_company_id = parsed.sellerCompanyId
  if (parsed.notes !== undefined) patch.notes = parsed.notes || null
  return patch
}

export async function createLotTakedown(communityId: string, input: TakedownInput, orgId?: string): Promise<LotTakedownDTO> {
  const parsed = takedownInputSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("community.write", context)
  await getCommunity(communityId, context.orgId)
  const { data, error } = await context.supabase.from("lot_takedowns").insert({ org_id: context.orgId, community_id: communityId, ...takedownPayload(parsed) }).select("id, community_id, community_phase_id, name, scheduled_date, actual_date, lot_count, price_per_lot_cents, deposit_cents, status, seller_company_id, notes").single()
  if (error) throw new Error(`Failed to create takedown: ${error.message}`)
  await logMutation({ orgId: context.orgId, userId: context.userId, eventType: "lot_takedown.created", entityType: "lot_takedown", entityId: data.id, action: "insert", after: data, payload: { community_id: communityId, name: data.name } })
  return mapTakedown(data as TakedownRow)
}

export async function updateLotTakedown(id: string, input: Partial<TakedownInput>, orgId?: string): Promise<LotTakedownDTO> {
  const parsed = takedownUpdateSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("community.write", context)
  const { data: before, error: beforeError } = await context.supabase.from("lot_takedowns").select("*").eq("org_id", context.orgId).eq("id", id).maybeSingle()
  if (beforeError || !before) throw new Error("Lot takedown not found")
  const { data, error } = await context.supabase.from("lot_takedowns").update(takedownPayload(parsed)).eq("org_id", context.orgId).eq("id", id).select("id, community_id, community_phase_id, name, scheduled_date, actual_date, lot_count, price_per_lot_cents, deposit_cents, status, seller_company_id, notes").single()
  if (error) throw new Error(`Failed to update takedown: ${error.message}`)
  await logMutation({ orgId: context.orgId, userId: context.userId, eventType: "lot_takedown.updated", entityType: "lot_takedown", entityId: id, action: "update", before, after: data, payload: { community_id: data.community_id, name: data.name } })
  return mapTakedown(data as TakedownRow)
}

export async function closeLotTakedown(id: string, { actualDate }: { actualDate: string }, orgId?: string): Promise<LotTakedownDTO> {
  const parsedDate = takedownUpdateSchema.pick({ actualDate: true }).parse({ actualDate }).actualDate
  const context = await requireOrgContext(orgId)
  await requirePermission("community.write", context)
  const closed = await updateLotTakedown(id, { status: "closed", actualDate: parsedDate }, context.orgId)
  const { error } = await context.supabase
    .from("lots")
    .update({ status: "owned", acquired_date: parsedDate })
    .eq("org_id", context.orgId)
    .eq("takedown_id", id)
    .eq("status", "controlled")
  if (error) throw new Error(`Takedown closed, but linked lots could not be advanced: ${error.message}`)
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "lot_takedown.closed", entityType: "lot_takedown", entityId: id, payload: { community_id: closed.communityId, actual_date: parsedDate } })
  return closed
}
