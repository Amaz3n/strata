import type { SupabaseClient } from "@supabase/supabase-js"
import { cache } from "react"

import type { LotStatus } from "@/lib/land/lot-lifecycle"
import { assertLotStatusTransition, LOT_STATUSES } from "@/lib/land/lot-lifecycle"
import { readAllRows } from "@/lib/land/paging"
import { resolveDivisionScope } from "@/lib/land/scope"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
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
  targetAbsorptionPerMonth: number | null
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
  target_absorption_per_month: number | string | null
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

const COMMUNITY_SELECT =
  "id, name, code, status, division_id, address, city, state, postal_code, description, planned_lot_count, target_absorption_per_month, division:divisions(name)"
/**
 * A ceiling on the community list, not a page size — `listCommunities` reads to
 * exhaustion. Even a large production builder runs tens of communities, so this
 * exists to bound a runaway read rather than to trim a real one.
 */
const COMMUNITY_LIST_CAP = 2_000

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
    targetAbsorptionPerMonth: row.target_absorption_per_month == null ? null : Number(row.target_absorption_per_month),
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

/**
 * Every community's lot status mix, from one Postgres aggregate.
 *
 * Memoized per request: the desk reads it for the board, and the workbench reads
 * it for the community on screen, so a land page load that touched both used to
 * run the aggregation twice. It is also the only place these counts come from —
 * counting lot rows in JS is only ever as right as its row cap.
 */
const getLotCountMap = cache(async function getLotCountMap(orgId: string) {
  const { supabase } = await requireOrgContext(orgId)
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
})

async function allowedDivisionScope(orgId: string, userId: string) {
  return getDivisionAccessForUser({ orgId, userId })
}

export interface CommunityScope {
  id: string
  name: string
  divisionId: string | null
}

/**
 * The gate every community write goes through.
 *
 * `getCommunity` already refuses to read a community outside the caller's
 * divisions; without this, a division-scoped `community.write` holder could edit
 * one — and close its takedowns — in a division they cannot even see. Reads and
 * writes now agree on what exists.
 *
 * Deliberately not `getCommunity`: that one is request-memoized, so a write that
 * warmed it would then return its own stale before-image, and it pulls phases,
 * takedowns, and lot counts that a write does not need.
 */
export async function requireCommunityScope(
  communityId: string,
  context: Awaited<ReturnType<typeof requireOrgContext>>,
): Promise<CommunityScope> {
  const decision = resolveDivisionScope(await allowedDivisionScope(context.orgId, context.userId))
  if (decision.kind === "none") throw new Error("Community not found")
  let query = context.supabase
    .from("communities")
    .select("id, name, division_id")
    .eq("org_id", context.orgId)
    .eq("id", communityId)
    .is("archived_at", null)
  if (decision.kind === "limited") query = query.in("division_id", decision.divisionIds)
  const { data, error } = await query.maybeSingle()
  if (error || !data) throw new Error("Community not found")
  return { id: data.id as string, name: data.name as string, divisionId: (data.division_id as string | null) ?? null }
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
  if (parsed.targetAbsorptionPerMonth !== undefined) patch.target_absorption_per_month = parsed.targetAbsorptionPerMonth
  if (parsed.settings !== undefined) patch.settings = parsed.settings
  if (parsed.metadata !== undefined) patch.metadata = parsed.metadata
  return patch
}

/** Names and scope only: dropdowns must not aggregate every lot in the org. */
export const listCommunityOptions = cache(async (orgId?: string): Promise<CommunityScope[]> => {
  const context = await requireOrgContext(orgId)
  await requirePermission("community.read", context)
  const decision = resolveDivisionScope(await allowedDivisionScope(context.orgId, context.userId))
  if (decision.kind === "none") return []
  const result = await readAllRows<{ id: string; name: string; division_id: string | null }>((from, to) => {
    let query = context.supabase.from("communities").select("id,name,division_id")
      .eq("org_id", context.orgId).is("archived_at", null).order("name").order("id").range(from, to)
    if (decision.kind === "limited") query = query.in("division_id", decision.divisionIds)
    return query
  }, { cap: COMMUNITY_LIST_CAP, label: "Failed to list community options" })
  if (result.truncated) throw new Error("Community options exceeded the supported limit")
  return result.rows.map(row => ({ id: row.id, name: row.name, divisionId: row.division_id }))
})

export async function listCommunities(
  { divisionId, status }: { divisionId?: string; status?: string } = {},
  orgId?: string,
): Promise<CommunityListItemDTO[]> {
  const context = await requireOrgContext(orgId)
  await requirePermission("community.read", context)
  const decision = resolveDivisionScope(await allowedDivisionScope(context.orgId, context.userId), divisionId)
  if (decision.kind === "none") return []
  // Read to exhaustion rather than to a flat `.limit(200)`: every caller — the
  // runway board, the desk scope, three pickers — treats this as "the org's
  // communities", and a list that quietly stopped at 200 would make the board's
  // totals wrong rather than merely short.
  const [communities, countMap] = await Promise.all([
    readAllRows<CommunityRow>(
      (from, to) => {
        let query = context.supabase
          .from("communities")
          .select(COMMUNITY_SELECT)
          .eq("org_id", context.orgId)
          .is("archived_at", null)
          // `id` breaks name ties: without a total order the pages below can
          // repeat one row and drop another.
          .order("name")
          .order("id")
          .range(from, to)
        if (decision.kind === "limited") query = query.in("division_id", decision.divisionIds)
        if (status) query = query.eq("status", status)
        return query
      },
      { cap: COMMUNITY_LIST_CAP, label: "Failed to list communities" },
    ),
    getLotCountMap(context.orgId),
  ])
  return communities.rows.map((row) => mapCommunity(row, countMap.get(row.id) ?? emptyLotCounts()))
}

/**
 * One community and its structure.
 *
 * Memoized per request: the workbench layout, the tab page, the plat, and the
 * lot status counts each need the community, and without this they would each
 * pay for the whole read. It also used to find the row by scanning
 * `listCommunities()` — 200 rows plus an org-wide lot-count aggregation — so a
 * single page load ran that scan about five times.
 */
export const getCommunity = cache(async function getCommunity(
  id: string,
  orgId?: string,
): Promise<CommunityDetailDTO> {
  const context = await requireOrgContext(orgId)
  await requirePermission("community.read", context)
  // Division scope is enforced here rather than inherited from listCommunities:
  // a community outside the caller's divisions must read as not found.
  const decision = resolveDivisionScope(await allowedDivisionScope(context.orgId, context.userId))
  if (decision.kind === "none") throw new Error("Community not found")

  let communityQuery = context.supabase
    .from("communities")
    .select(COMMUNITY_SELECT)
    .eq("org_id", context.orgId)
    .eq("id", id)
    .is("archived_at", null)
  if (decision.kind === "limited") communityQuery = communityQuery.in("division_id", decision.divisionIds)

  const [detailResult, lotCountMap, phasesResult, takedownsResult] = await Promise.all([
    communityQuery.maybeSingle(),
    // The same aggregate the desk counts with. This used to read up to 5,000 lot
    // rows and tally them here, which made a 400-lot community's status mix a
    // guess the moment a community passed the cap.
    getLotCountMap(context.orgId),
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
  ])
  if (detailResult.error) throw new Error(`Failed to load community: ${detailResult.error.message}`)
  if (!detailResult.data) throw new Error("Community not found")
  if (phasesResult.error) throw new Error(`Failed to load phases: ${phasesResult.error.message}`)
  if (takedownsResult.error) throw new Error(`Failed to load takedowns: ${takedownsResult.error.message}`)

  const lotCounts = lotCountMap.get(id) ?? emptyLotCounts()
  // One exact COUNT per takedown rather than a row scan: a takedown schedule is
  // a handful of land contracts, and counting in Postgres cannot be outgrown.
  const takedownRows = (takedownsResult.data ?? []) as TakedownRow[]
  const linkedResults = await Promise.all(
    takedownRows.map((takedown) =>
      context.supabase
        .from("lots")
        .select("id", { count: "exact", head: true })
        .eq("org_id", context.orgId)
        .eq("takedown_id", takedown.id),
    ),
  )
  const linkedCounts = new Map<string, number>()
  linkedResults.forEach((result, index) => {
    if (result.error) throw new Error(`Failed to count takedown lots: ${result.error.message}`)
    linkedCounts.set(takedownRows[index].id, result.count ?? 0)
  })

  const row = detailResult.data as CommunityRow & { address: string | null; postal_code: string | null; description: string | null }
  return {
    ...mapCommunity(row, lotCounts),
    address: row.address,
    postalCode: row.postal_code,
    description: row.description,
    phases: (phasesResult.data ?? []).map((phase) => mapPhase(phase as PhaseRow)),
    takedowns: takedownRows.map((takedown) => mapTakedown(takedown, linkedCounts.get(takedown.id) ?? 0)),
  }
})

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
  await requireCommunityScope(id, context)
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
  await requireCommunityScope(id, context)
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
  await requireCommunityScope(communityId, context)
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
  await requireCommunityScope(before.community_id, context)
  const { data, error } = await context.supabase.from("community_phases").update(phasePayload(parsed)).eq("org_id", context.orgId).eq("id", id).select("id, community_id, name, phase_number, status, target_open_date, notes").single()
  if (error) throw new Error(`Failed to update phase: ${error.message}`)
  await logMutation({ orgId: context.orgId, userId: context.userId, eventType: "community_phase.updated", entityType: "community_phase", entityId: id, action: "update", before, after: data, payload: { community_id: data.community_id, name: data.name } })
  return mapPhase(data as PhaseRow)
}

export async function deleteCommunityPhase(id: string, orgId?: string): Promise<void> {
  const context = await requireOrgContext(orgId)
  await requirePermission("community.write", context)
  const { data: before, error: beforeError } = await context.supabase.from("community_phases").select("*").eq("org_id", context.orgId).eq("id", id).maybeSingle()
  if (beforeError || !before) throw new Error("Community phase not found")
  await requireCommunityScope(before.community_id, context)
  const { count, error: countError } = await context.supabase.from("lots").select("id", { count: "exact", head: true }).eq("org_id", context.orgId).eq("community_phase_id", id)
  if (countError) throw new Error(`Failed to check phase use: ${countError.message}`)
  if ((count ?? 0) > 0) throw new Error("Move this phase's lots before deleting it.")
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
  await requireCommunityScope(communityId, context)
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
  await requireCommunityScope(before.community_id, context)
  const { data, error } = await context.supabase.from("lot_takedowns").update(takedownPayload(parsed)).eq("org_id", context.orgId).eq("id", id).select("id, community_id, community_phase_id, name, scheduled_date, actual_date, lot_count, price_per_lot_cents, deposit_cents, status, seller_company_id, notes").single()
  if (error) throw new Error(`Failed to update takedown: ${error.message}`)
  await logMutation({ orgId: context.orgId, userId: context.userId, eventType: "lot_takedown.updated", entityType: "lot_takedown", entityId: id, action: "update", before, after: data, payload: { community_id: data.community_id, name: data.name } })
  return mapTakedown(data as TakedownRow)
}

/**
 * Settle a land tranche: the takedown closes and every lot it controls becomes
 * owned.
 *
 * The lot half goes through `assertLotStatusTransition` like every other status
 * change — closing a tranche used to write `status: 'owned'` straight past the
 * lifecycle — and leaves the same trail a bulk lot edit leaves: one status event
 * and one audit row naming every lot moved. Validating in the pure state machine
 * and writing once keeps a forty-lot tranche one round trip rather than forty.
 */
export async function closeLotTakedown(id: string, { actualDate }: { actualDate: string }, orgId?: string): Promise<LotTakedownDTO> {
  const parsedDate = takedownUpdateSchema.pick({ actualDate: true }).parse({ actualDate }).actualDate
  const context = await requireOrgContext(orgId)
  await requirePermission("community.write", context)
  await requirePermission("lot.write", context)
  const { data: takedown, error: takedownError } = await context.supabase
    .from("lot_takedowns")
    .select("community_id")
    .eq("org_id", context.orgId)
    .eq("id", id)
    .maybeSingle()
  if (takedownError || !takedown) throw new Error("Lot takedown not found")
  await requireCommunityScope(takedown.community_id, context)

  const { data: linked, error: linkedError } = await context.supabase
    .from("lots")
    .select("id, status, project_id")
    .eq("org_id", context.orgId)
    .eq("takedown_id", id)
    .eq("status", "controlled")
  if (linkedError) throw new Error(`Failed to load the takedown's lots: ${linkedError.message}`)
  const advancing = (linked ?? []) as Array<{ id: string; status: LotStatus; project_id: string | null }>
  for (const lot of advancing) {
    assertLotStatusTransition({ from: lot.status, to: "owned", hasProject: Boolean(lot.project_id) })
  }

  const { data: books, error: booksError } = await createServiceSupabaseClient().from("books_settings").select("workspace_enabled,arc_ledger_mode").eq("org_id", context.orgId).maybeSingle()
  if (booksError) throw new Error(`Failed to verify land accounting posture: ${booksError.message}`)
  if (books?.workspace_enabled && books.arc_ledger_mode !== "disabled" && advancing.length > 0) throw new Error("Record the actual land acquisition and funding in Books before closing this takedown. Expected lot prices are not settlement evidence.")
  const closed = await updateLotTakedown(id, { status: "closed", actualDate: parsedDate }, context.orgId)

  if (advancing.length > 0) {
    const lotIds = advancing.map((lot) => lot.id)
    const { error } = await context.supabase
      .from("lots")
      .update({ status: "owned", acquired_date: parsedDate })
      .eq("org_id", context.orgId)
      .in("id", lotIds)
    if (error) throw new Error(`Takedown closed, but linked lots could not be advanced: ${error.message}`)
    await Promise.all([
      recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "lot.status_changed", entityType: "lot", entityId: lotIds[0], payload: { community_id: closed.communityId, from: "controlled", to: "owned", count: lotIds.length, takedown_id: id } }),
      recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "lot", entityId: lotIds[0], before: { lots: advancing }, after: { lot_ids: lotIds, status: "owned", acquired_date: parsedDate, takedown_id: id } }),
    ])
  }

  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "lot_takedown.closed", entityType: "lot_takedown", entityId: id, payload: { community_id: closed.communityId, actual_date: parsedDate, lot_count: advancing.length } })
  return closed
}

/**
 * How far ahead a takedown starts calling for attention. A land tranche is a
 * contractual close date with a deposit riding on it, so the first warning has
 * to arrive while there is still time to fund or renegotiate it.
 */
export const TAKEDOWN_REMINDER_DAYS = [30, 7, 0] as const
/** Drains in batches, so a backlog is worked through rather than silently capped. */
const TAKEDOWN_SWEEP_BATCH = 200

function takedownReminderKey(days: number) {
  return `reminded_at_${days}d`
}

/**
 * Announce takedowns whose contractual close date is approaching.
 *
 * A multi-million-dollar land close previously had no notification path at all:
 * it sat on the Land tab and was noticed when somebody looked. This runs on a
 * schedule rather than as a side effect of a page load, because a close date has
 * to arrive whether or not anyone opened the community that week.
 *
 * Each threshold fires once per takedown. The marker lives in the takedown's own
 * `metadata`, so a re-run after a partial failure resumes rather than repeating —
 * the same idempotency the payment sweeps use.
 */
export async function sweepTakedownReminders(): Promise<{ announced: number }> {
  const service = createServiceSupabaseClient()
  const today = new Date()
  const horizon = new Date(today)
  horizon.setDate(horizon.getDate() + Math.max(...TAKEDOWN_REMINDER_DAYS))

  const { data: due, error } = await service
    .from("lot_takedowns")
    .select("id, org_id, community_id, name, scheduled_date, lot_count, price_per_lot_cents, deposit_cents, metadata")
    .eq("status", "scheduled")
    .not("scheduled_date", "is", null)
    .lte("scheduled_date", horizon.toISOString().slice(0, 10))
    .order("scheduled_date", { ascending: true })
    .limit(TAKEDOWN_SWEEP_BATCH)
  if (error) throw new Error(`Failed to load due takedowns: ${error.message}`)

  let announced = 0
  for (const row of due ?? []) {
    const scheduledDate = row.scheduled_date as string
    const daysOut = Math.ceil((Date.parse(scheduledDate) - today.getTime()) / 86_400_000)
    const metadata = (row.metadata ?? {}) as Record<string, unknown>
    // The tightest threshold this takedown has crossed and not yet announced.
    // Past due keeps firing the `0` threshold's key, so it is announced once.
    const threshold = TAKEDOWN_REMINDER_DAYS.find(
      (days) => daysOut <= days && !metadata[takedownReminderKey(days)],
    )
    if (threshold === undefined) continue

    const lotCount = Number(row.lot_count ?? 0)
    await recordEvent({
      orgId: row.org_id as string,
      actorId: null,
      eventType: "lot_takedown.due",
      entityType: "lot_takedown",
      entityId: row.id as string,
      payload: {
        community_id: row.community_id as string,
        name: row.name as string,
        scheduled_date: scheduledDate,
        days_out: daysOut,
        lot_count: lotCount,
        cash_cents: lotCount * Number(row.price_per_lot_cents ?? 0),
        deposit_cents: Number(row.deposit_cents ?? 0),
      },
    })
    const { error: markError } = await service
      .from("lot_takedowns")
      .update({ metadata: { ...metadata, [takedownReminderKey(threshold)]: new Date().toISOString() } })
      .eq("id", row.id)
    if (markError) throw new Error(`Failed to record the takedown reminder: ${markError.message}`)
    announced += 1
  }

  return { announced }
}
