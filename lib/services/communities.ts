import type { SupabaseClient } from "@supabase/supabase-js"
import { cache } from "react"
import { z } from "zod"

import { hasApprovedAcquisition } from "@/lib/land/diligence"
import { readSetbacks, type Setbacks } from "@/lib/land/lot-dimensions"
import type { LotStatus } from "@/lib/land/lot-lifecycle"
import { assertLotStatusTransition, LOT_STATUSES } from "@/lib/land/lot-lifecycle"
import { readAllRows } from "@/lib/land/paging"
import { takedownCash, type LandDepositStatus } from "@/lib/land/takedown-cash"
import { divisionIsInScope, resolveDivisionScope } from "@/lib/land/scope"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { getDivisionAccessForUser } from "@/lib/services/authorization"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"
import { phaseDevelopmentLinkSchema } from "@/lib/validation/land-contracts"
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
  /** The project that develops this phase's land, when one is linked. */
  developmentProjectId: string | null
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
  /** The land contract the tranche is under; its deposits are on that contract's schedule. */
  landContractId: string | null
  /** The land deal the tranche came from; closing it needs that deal's acquisition approved. */
  landOpportunityId: string | null
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
  /** Default setbacks; a lot's own value wins over each one. */
  setbacks: Setbacks
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
  setbacks?: Record<string, unknown> | null
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
  development_project_id: string | null
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
  land_contract_id: string | null
  land_opportunity_id: string | null
  status: LotTakedownDTO["status"]
  seller_company_id: string | null
  notes: string | null
}

const PHASE_SELECT = "id, community_id, name, phase_number, status, target_open_date, notes, development_project_id"
const TAKEDOWN_SELECT =
  "id, community_id, community_phase_id, name, scheduled_date, actual_date, lot_count, price_per_lot_cents, land_contract_id, land_opportunity_id, status, seller_company_id, notes"

const COMMUNITY_SELECT =
  "id, name, code, status, division_id, address, city, state, postal_code, description, planned_lot_count, target_absorption_per_month, setbacks, division:divisions(name)"
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
    developmentProjectId: row.development_project_id,
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
    landContractId: row.land_contract_id,
    landOpportunityId: row.land_opportunity_id,
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

/**
 * A community may only be filed under a division the caller works in. Without
 * this a division-scoped `community.write` holder could create a community in,
 * or move one of theirs into, a division they cannot see, and with it every lot
 * and home it holds. Refused as not found, like a division outside the org.
 */
async function assertDivisionInCallerScope(
  context: Awaited<ReturnType<typeof requireOrgContext>>,
  divisionId: string | null | undefined,
) {
  const decision = resolveDivisionScope(await allowedDivisionScope(context.orgId, context.userId))
  if (!divisionIsInScope(decision, divisionId ?? null)) throw new Error("Division not found")
}

/** Homes standing on the community's lots: what a division move carried with it. */
async function countCommunityHomes(context: Awaited<ReturnType<typeof requireOrgContext>>, communityId: string) {
  const { count, error } = await context.supabase
    .from("lots")
    .select("id", { count: "exact", head: true })
    .eq("org_id", context.orgId)
    .eq("community_id", communityId)
    .not("project_id", "is", null)
  if (error) throw new Error(`Failed to count the community's homes: ${error.message}`)
  return count ?? 0
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
/** Authorized chrome identity, without inventory, phases, or takedown reads. */
export const getCommunityIdentity = cache(async function getCommunityIdentity(
  id: string,
  orgId?: string,
): Promise<Pick<CommunityListItemDTO, "id" | "name" | "status" | "plannedLotCount">> {
  const context = await requireOrgContext(orgId)
  await requirePermission("community.read", context)
  const decision = resolveDivisionScope(await allowedDivisionScope(context.orgId, context.userId))
  if (decision.kind === "none") throw new Error("Community not found")

  let query = context.supabase
    .from("communities")
    .select("id, name, status, planned_lot_count")
    .eq("org_id", context.orgId)
    .eq("id", id)
    .is("archived_at", null)
  if (decision.kind === "limited") query = query.in("division_id", decision.divisionIds)
  const { data, error } = await query.maybeSingle()
  if (error) throw new Error(`Failed to load community identity: ${error.message}`)
  if (!data) throw new Error("Community not found")
  return {
    id: data.id,
    name: data.name,
    status: data.status as CommunityListItemDTO["status"],
    plannedLotCount: data.planned_lot_count,
  }
})

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
      .select(PHASE_SELECT)
      .eq("org_id", context.orgId)
      .eq("community_id", id)
      .order("phase_number"),
    context.supabase
      .from("lot_takedowns")
      .select(TAKEDOWN_SELECT)
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
    setbacks: readSetbacks(row.setbacks),
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
  await Promise.all([
    assertDivisionInCallerScope(context, parsed.divisionId),
    assertDivisionBelongsToOrg(context.supabase, context.orgId, parsed.divisionId),
  ])
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
  if (parsed.divisionId !== undefined) {
    await Promise.all([
      assertDivisionInCallerScope(context, parsed.divisionId),
      assertDivisionBelongsToOrg(context.supabase, context.orgId, parsed.divisionId),
    ])
  }
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
  // The database moves the community's lots and homes with it, in the same
  // statement (communities_cascade_division); this only reports how many homes
  // went. A community taken out of every division leaves its homes where they were.
  const divisionMoved = data.division_id !== before.division_id
  const homesMoved = divisionMoved && data.division_id ? await countCommunityHomes(context, id) : 0
  await logMutation({ orgId: context.orgId, userId: context.userId, eventType: "community.updated", entityType: "community", entityId: id, action: "update", before, after: data, payload: divisionMoved ? { name: data.name, from_division_id: before.division_id, to_division_id: data.division_id, homes_moved: homesMoved } : { name: data.name } })
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
  const { data, error } = await context.supabase.from("community_phases").insert({ org_id: context.orgId, community_id: communityId, ...phasePayload(parsed) }).select(PHASE_SELECT).single()
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
  const { data, error } = await context.supabase.from("community_phases").update(phasePayload(parsed)).eq("org_id", context.orgId).eq("id", id).select(PHASE_SELECT).single()
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

/**
 * Name the job that develops a phase, or unlink it. A development job is an
 * ordinary project in the community's division (the database refuses any other,
 * and a home on a lot); its budget, contracts and cost stay on its workbench.
 * Books development allocations from the job reach only the phases it develops.
 */
export async function linkPhaseDevelopmentProject(phaseId: string, input: { developmentProjectId: string | null }, orgId?: string): Promise<CommunityPhaseDTO> {
  const parsed = phaseDevelopmentLinkSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await Promise.all([requirePermission("community.write", context), requirePermission("project.manage", context)])
  const { data: before, error: beforeError } = await context.supabase.from("community_phases").select(PHASE_SELECT).eq("org_id", context.orgId).eq("id", phaseId).maybeSingle()
  if (beforeError || !before) throw new Error("Community phase not found")
  await requireCommunityScope(before.community_id, context)
  if (parsed.developmentProjectId) {
    const { data: project, error: projectError } = await context.supabase.from("projects").select("id").eq("org_id", context.orgId).eq("id", parsed.developmentProjectId).maybeSingle()
    if (projectError || !project) throw new Error("Project not found")
  }
  const { data, error } = await context.supabase.from("community_phases").update({ development_project_id: parsed.developmentProjectId }).eq("org_id", context.orgId).eq("id", phaseId).select(PHASE_SELECT).single()
  if (error) throw new Error(error.code === "23514" ? error.message : `Failed to link the development job: ${error.message}`)
  await logMutation({ orgId: context.orgId, userId: context.userId, eventType: "community_phase.development_linked", entityType: "community_phase", entityId: phaseId, action: "update", before, after: data, payload: { community_id: data.community_id, name: data.name, development_project_id: parsed.developmentProjectId, previous_development_project_id: before.development_project_id } })
  return mapPhase(data as PhaseRow)
}

function takedownPayload(parsed: Partial<TakedownInput>) {
  const patch: Record<string, unknown> = {}
  if (parsed.name !== undefined) patch.name = parsed.name
  if (parsed.communityPhaseId !== undefined) patch.community_phase_id = parsed.communityPhaseId
  if (parsed.scheduledDate !== undefined) patch.scheduled_date = parsed.scheduledDate
  if (parsed.actualDate !== undefined) patch.actual_date = parsed.actualDate
  if (parsed.lotCount !== undefined) patch.lot_count = parsed.lotCount
  if (parsed.pricePerLotCents !== undefined) patch.price_per_lot_cents = parsed.pricePerLotCents
  if (parsed.landContractId !== undefined) patch.land_contract_id = parsed.landContractId
  if (parsed.landOpportunityId !== undefined) patch.land_opportunity_id = parsed.landOpportunityId
  if (parsed.status !== undefined) patch.status = parsed.status
  if (parsed.sellerCompanyId !== undefined) patch.seller_company_id = parsed.sellerCompanyId
  if (parsed.notes !== undefined) patch.notes = parsed.notes || null
  return patch
}

/**
 * Naming the deal a tranche came from takes land.read and a deal the caller can
 * see that was acquired into this community. The database holds the community
 * half; the division wall is the deal's own row security.
 */
async function requireLinkableLandDeal(context: Awaited<ReturnType<typeof requireOrgContext>>, communityId: string, landOpportunityId: string) {
  await requirePermission("land.read", context)
  const { data, error } = await context.supabase
    .from("land_opportunities")
    .select("id")
    .eq("org_id", context.orgId)
    .eq("id", landOpportunityId)
    .eq("community_id", communityId)
    .maybeSingle()
  if (error) throw new Error(`Failed to read the land deal: ${error.message}`)
  if (!data) throw new Error("Land deal not found for this community")
}

export async function createLotTakedown(communityId: string, input: TakedownInput, orgId?: string): Promise<LotTakedownDTO> {
  const parsed = takedownInputSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("community.write", context)
  await requireCommunityScope(communityId, context)
  if (parsed.landOpportunityId) await requireLinkableLandDeal(context, communityId, parsed.landOpportunityId)
  const { data, error } = await context.supabase.from("lot_takedowns").insert({ org_id: context.orgId, community_id: communityId, ...takedownPayload(parsed) }).select(TAKEDOWN_SELECT).single()
  if (error) throw new Error(`Failed to create takedown: ${error.message}`)
  await logMutation({ orgId: context.orgId, userId: context.userId, eventType: "lot_takedown.created", entityType: "lot_takedown", entityId: data.id, action: "insert", after: data, payload: { community_id: communityId, name: data.name } })
  return mapTakedown(data as TakedownRow)
}

/** The status of the land contract a takedown is under, or null when it has none. */
async function takedownContractStatus(context: Awaited<ReturnType<typeof requireOrgContext>>, landContractId: string | null) {
  if (!landContractId) return null
  const { data, error } = await context.supabase.from("land_contracts").select("status").eq("org_id", context.orgId).eq("id", landContractId).maybeSingle()
  if (error || !data) throw new Error("The takedown's land contract could not be read")
  return String(data.status)
}

/**
 * A takedown under an executed land contract keeps its signed lot count and
 * price, and its close date moves only by a recorded extension
 * (`recordLandContractExtension`). The database holds the same line.
 *
 * A takedown closes only through `closeLotTakedown` and a closed one stays
 * closed. Cancelling (or restoring) one under a signed contract or from a land
 * deal is a land decision: the database refuses a member's direct status write
 * there, so after these checks the row is written as the system — and under a
 * signed contract it also takes land_contract.write. Moving a takedown off its
 * land deal takes land.approve and is written the same way.
 */
export async function updateLotTakedown(id: string, input: Partial<TakedownInput>, orgId?: string): Promise<LotTakedownDTO> {
  const parsed = takedownUpdateSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("community.write", context)
  const { data: before, error: beforeError } = await context.supabase.from("lot_takedowns").select("*").eq("org_id", context.orgId).eq("id", id).maybeSingle()
  if (beforeError || !before) throw new Error("Lot takedown not found")
  await requireCommunityScope(before.community_id, context)
  if (parsed.landOpportunityId && parsed.landOpportunityId !== before.land_opportunity_id) {
    await requireLinkableLandDeal(context, before.community_id, parsed.landOpportunityId)
  }
  const contractStatus = await takedownContractStatus(context, before.land_contract_id)
  const statusChanges = parsed.status !== undefined && parsed.status !== before.status
  if (statusChanges && parsed.status === "closed") throw new Error("Close a takedown with its actual date; closing applies its deposits and acquires its lots.")
  if (statusChanges && before.status === "closed") throw new Error("A closed takedown stays closed.")
  const landDecision = statusChanges && ((contractStatus !== null && contractStatus !== "draft") || Boolean(before.land_opportunity_id))
  if (landDecision && contractStatus !== null && contractStatus !== "draft") await requirePermission("land_contract.write", context)
  // Its deal's approval gates a takedown's closing, so moving it off that deal is the approvers' call.
  const movesDeal = Boolean(before.land_opportunity_id) && parsed.landOpportunityId !== undefined && parsed.landOpportunityId !== before.land_opportunity_id
  if (movesDeal) await requirePermission("land.approve", context)
  if (contractStatus === "executed") {
    const changes = (value: unknown, current: unknown) => value !== undefined && value !== current
    if (changes(parsed.scheduledDate, before.scheduled_date)) throw new Error("This takedown is under an executed land contract. Record an extension with the signed evidence to move its close date.")
    if (changes(parsed.lotCount, before.lot_count) || changes(parsed.pricePerLotCents, before.price_per_lot_cents)) throw new Error("The lot count and price of a takedown under an executed land contract are signed terms. Record an amendment.")
    if (changes(parsed.landContractId, before.land_contract_id)) throw new Error("A takedown cannot move out of an executed land contract.")
  }
  const writer = landDecision || movesDeal ? createServiceSupabaseClient() : context.supabase
  const { data, error } = await writer.from("lot_takedowns").update(takedownPayload(parsed)).eq("org_id", context.orgId).eq("id", id).select(TAKEDOWN_SELECT).single()
  if (error) throw new Error(`Failed to update takedown: ${error.message}`)
  await logMutation({ orgId: context.orgId, userId: context.userId, eventType: "lot_takedown.updated", entityType: "lot_takedown", entityId: id, action: "update", before, after: data, payload: { community_id: data.community_id, name: data.name } })
  return mapTakedown(data as TakedownRow)
}

/**
 * A tranche that came from a land deal closes only once that deal's acquisition
 * is approved; an unlinked takedown (legacy, imported) is unaffected. The review
 * is read as the system: the gate is a fact about the deal, and a closer without
 * land.read, or outside the deal's division, must be refused for the right
 * reason rather than because they cannot see the approval.
 */
async function assertTakedownAcquisitionApproved(orgId: string, landOpportunityId: string | null): Promise<void> {
  if (!landOpportunityId) return
  const { data, error } = await createServiceSupabaseClient()
    .from("land_acquisition_reviews")
    .select("status, decision")
    .eq("org_id", orgId)
    .eq("land_opportunity_id", landOpportunityId)
  if (error) throw new Error(`Failed to read the deal's acquisition reviews: ${error.message}`)
  if (!hasApprovedAcquisition(data ?? [])) {
    throw new Error("This takedown's land deal has no approved acquisition review. Approve the acquisition before closing it.")
  }
}

const takedownClosingSchema = z.object({ lot_ids: z.array(z.string().uuid()), applied_deposit_cents: z.coerce.number().int() })

/**
 * Settle a land tranche: the takedown closes, the paid deposits credited
 * against it are applied, and every lot it controls becomes owned — in one
 * database transaction (`close_lot_takedown`), so a failure never leaves a
 * closed takedown with its deposits still paid or its lots still controlled.
 *
 * The lot half answers to `assertLotStatusTransition` like every other status
 * change, and leaves the trail a bulk lot edit leaves: one status event and one
 * audit row naming every lot moved. The database repeats the gates that are
 * facts about the land (signed contract, paid deposits, approved acquisition).
 */
export async function closeLotTakedown(id: string, { actualDate }: { actualDate: string }, orgId?: string): Promise<LotTakedownDTO> {
  const parsedDate = takedownUpdateSchema.pick({ actualDate: true }).parse({ actualDate }).actualDate
  if (!parsedDate) throw new Error("A takedown closes on its actual date.")
  const context = await requireOrgContext(orgId)
  await requirePermission("community.write", context)
  await requirePermission("lot.write", context)
  const { data: takedown, error: takedownError } = await context.supabase
    .from("lot_takedowns")
    .select("community_id, status, land_contract_id, land_opportunity_id")
    .eq("org_id", context.orgId)
    .eq("id", id)
    .maybeSingle()
  if (takedownError || !takedown) throw new Error("Lot takedown not found")
  await requireCommunityScope(takedown.community_id, context)
  if (takedown.status !== "scheduled") throw new Error("Only a scheduled takedown is closed.")
  await assertTakedownAcquisitionApproved(context.orgId, takedown.land_opportunity_id)

  // A tranche under a contract closes only once the contract is signed, and
  // only with every deposit credited against it actually paid: the credit is
  // what the cash plan netted out of the closing.
  const contractStatus = await takedownContractStatus(context, takedown.land_contract_id)
  if (contractStatus !== null && contractStatus !== "executed") throw new Error("Execute this takedown's land contract before closing it.")
  const { data: credited, error: creditedError } = await context.supabase
    .from("land_contract_deposits")
    .select("id")
    .eq("org_id", context.orgId)
    .eq("takedown_id", id)
    .eq("status", "scheduled")
    .limit(1)
  if (creditedError) throw new Error(`Failed to load the takedown's deposits: ${creditedError.message}`)
  if ((credited ?? []).length > 0) throw new Error("Record the payment of every deposit credited against this takedown before closing it.")

  const { data: linked, error: linkedError } = await context.supabase
    .from("lots")
    .select("id, status, project_id")
    .eq("org_id", context.orgId)
    .eq("takedown_id", id)
    .eq("status", "controlled")
  if (linkedError) throw new Error(`Failed to load the takedown's lots: ${linkedError.message}`)
  const advancing: Array<{ id: string; status: LotStatus; project_id: string | null }> = linked ?? []
  for (const lot of advancing) {
    assertLotStatusTransition({ from: lot.status, to: "owned", hasProject: Boolean(lot.project_id) })
  }

  const service = createServiceSupabaseClient()
  const { data: books, error: booksError } = await service.from("books_settings").select("workspace_enabled,arc_ledger_mode").eq("org_id", context.orgId).maybeSingle()
  if (booksError) throw new Error(`Failed to verify land accounting posture: ${booksError.message}`)
  if (books?.workspace_enabled && books.arc_ledger_mode !== "disabled" && advancing.length > 0) throw new Error("Record the actual land acquisition and funding in Books before closing this takedown. Expected lot prices are not settlement evidence.")

  const { data: result, error: closeError } = await service.rpc("close_lot_takedown", { p_org_id: context.orgId, p_takedown_id: id, p_actual_date: parsedDate, p_actor_id: context.userId })
  if (closeError) throw new Error(closeError.message)
  const closing = takedownClosingSchema.parse(result)
  const { data: closed, error: closedError } = await context.supabase.from("lot_takedowns").select(TAKEDOWN_SELECT).eq("org_id", context.orgId).eq("id", id).single()
  if (closedError || !closed) throw new Error(`Takedown closed, but it could not be read back: ${closedError?.message ?? "not found"}`)
  const dto = mapTakedown(closed)

  const writes: Array<Promise<unknown>> = [
    logMutation({ orgId: context.orgId, userId: context.userId, eventType: "lot_takedown.closed", entityType: "lot_takedown", entityId: id, action: "update", before: { status: takedown.status }, after: { status: "closed", actual_date: parsedDate }, payload: { community_id: dto.communityId, actual_date: parsedDate, lot_count: closing.lot_ids.length, applied_deposit_cents: closing.applied_deposit_cents } }),
  ]
  if (closing.lot_ids.length > 0) {
    writes.push(
      recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "lot.status_changed", entityType: "lot", entityId: closing.lot_ids[0], payload: { community_id: dto.communityId, from: "controlled", to: "owned", count: closing.lot_ids.length, takedown_id: id } }),
      recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "lot", entityId: closing.lot_ids[0], before: { lots: advancing }, after: { lot_ids: closing.lot_ids, status: "owned", acquired_date: parsedDate, takedown_id: id } }),
    )
  }
  await Promise.all(writes)
  return dto
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

/** Whole days from today to an ISO date; negative once it has passed. */
function daysUntil(date: string, today: Date) {
  return Math.ceil((Date.parse(date) - today.getTime()) / 86_400_000)
}

/** The tightest threshold crossed and not yet announced. Past due keeps the `0` key, so it fires once. */
function dueThreshold(daysOut: number, announced: (days: number) => boolean) {
  return TAKEDOWN_REMINDER_DAYS.find((days) => daysOut <= days && !announced(days))
}

/**
 * Announce land money coming due: takedown closings, deposits on a contract's
 * schedule, and extension or penalty fees.
 *
 * A multi-million-dollar land close previously had no notification path at all:
 * it sat on the Land tab and was noticed when somebody looked. This runs on a
 * schedule rather than as a side effect of a page load, because a close date has
 * to arrive whether or not anyone opened the community that week.
 *
 * Every announcement is the same `lot_takedown.due` event (the `takedown_due`
 * notification), with `kind` saying which obligation it is. Each threshold
 * fires once per obligation. The marker lives in the takedown's or deposit's
 * own `metadata` — and, because amendments are never rewritten, in the
 * contract's for a fee — so a re-run after a partial failure resumes rather
 * than repeating, the same idempotency the payment sweeps use.
 */
export async function sweepTakedownReminders(): Promise<{ announced: number }> {
  const service = createServiceSupabaseClient()
  const today = new Date()
  const todayIso = today.toISOString().slice(0, 10)
  const horizon = new Date(today)
  horizon.setDate(horizon.getDate() + Math.max(...TAKEDOWN_REMINDER_DAYS))
  const horizonIso = horizon.toISOString().slice(0, 10)

  const [dueTakedowns, dueDeposits, dueFees] = await Promise.all([
    service
      .from("lot_takedowns")
      .select("id, org_id, community_id, name, scheduled_date, lot_count, price_per_lot_cents, status, metadata")
      .eq("status", "scheduled")
      .not("scheduled_date", "is", null)
      .lte("scheduled_date", horizonIso)
      .order("scheduled_date", { ascending: true })
      .limit(TAKEDOWN_SWEEP_BATCH),
    service
      .from("land_contract_deposits")
      .select("id, org_id, land_contract_id, label, due_on, amount_cents, refundability, metadata, contract:land_contracts!inner(community_id, title)")
      .eq("status", "scheduled")
      .lte("due_on", horizonIso)
      .order("due_on", { ascending: true })
      .limit(TAKEDOWN_SWEEP_BATCH),
    service
      .from("land_contract_amendments")
      .select("id, org_id, land_contract_id, kind, fee_cents, due_on, contract:land_contracts!inner(community_id, title, metadata)")
      .gt("fee_cents", 0)
      .is("fee_paid_on", null)
      .gte("due_on", todayIso)
      .lte("due_on", horizonIso)
      .order("due_on", { ascending: true })
      .limit(TAKEDOWN_SWEEP_BATCH),
  ])
  if (dueTakedowns.error) throw new Error(`Failed to load due takedowns: ${dueTakedowns.error.message}`)
  if (dueDeposits.error) throw new Error(`Failed to load due land deposits: ${dueDeposits.error.message}`)
  if (dueFees.error) throw new Error(`Failed to load due land contract fees: ${dueFees.error.message}`)

  const takedownRows = dueTakedowns.data ?? []
  const { data: creditRows, error: creditError } = takedownRows.length
    ? await service.from("land_contract_deposits").select("takedown_id, due_on, amount_cents, status").in("takedown_id", takedownRows.map((row) => row.id as string))
    : { data: [], error: null }
  if (creditError) throw new Error(`Failed to load takedown deposit credits: ${creditError.message}`)
  const credits = (creditRows ?? []).map((row) => ({
    takedownId: row.takedown_id as string,
    dueOn: row.due_on as string,
    amountCents: Number(row.amount_cents),
    status: row.status as LandDepositStatus,
  }))

  const announce = (orgId: string, entityType: string, entityId: string, payload: Record<string, unknown>) =>
    recordEvent({ orgId, actorId: null, eventType: "lot_takedown.due", entityType, entityId, payload })

  let announced = 0
  for (const row of takedownRows) {
    const scheduledDate = row.scheduled_date as string
    const daysOut = daysUntil(scheduledDate, today)
    const metadata = (row.metadata ?? {}) as Record<string, unknown>
    const threshold = dueThreshold(daysOut, (days) => Boolean(metadata[takedownReminderKey(days)]))
    if (threshold === undefined) continue

    const lotCount = Number(row.lot_count ?? 0)
    const cash = takedownCash(
      { id: row.id as string, scheduledDate, lotCount, pricePerLotCents: row.price_per_lot_cents == null ? null : Number(row.price_per_lot_cents), status: "scheduled" },
      credits,
    )
    await announce(row.org_id as string, "lot_takedown", row.id as string, {
      kind: "takedown",
      community_id: row.community_id as string,
      name: row.name as string,
      scheduled_date: scheduledDate,
      days_out: daysOut,
      lot_count: lotCount,
      cash_cents: cash.netCents,
      deposit_cents: cash.creditedDepositCents,
    })
    const { error: markError } = await service
      .from("lot_takedowns")
      .update({ metadata: { ...metadata, [takedownReminderKey(threshold)]: new Date().toISOString() } })
      .eq("id", row.id)
    if (markError) throw new Error(`Failed to record the takedown reminder: ${markError.message}`)
    announced += 1
  }

  for (const row of dueDeposits.data ?? []) {
    const dueOn = row.due_on as string
    const daysOut = daysUntil(dueOn, today)
    const metadata = (row.metadata ?? {}) as Record<string, unknown>
    const threshold = dueThreshold(daysOut, (days) => Boolean(metadata[takedownReminderKey(days)]))
    if (threshold === undefined) continue
    const contract = Array.isArray(row.contract) ? row.contract[0] : row.contract
    await announce(row.org_id as string, "land_contract", row.land_contract_id as string, {
      kind: "deposit",
      community_id: String(contract?.community_id ?? ""),
      name: (row.label as string | null) ?? `${String(contract?.title ?? "Land contract")} deposit`,
      deposit_id: row.id as string,
      due_on: dueOn,
      days_out: daysOut,
      amount_cents: Number(row.amount_cents),
      refundability: row.refundability as string,
    })
    const { error: markError } = await service
      .from("land_contract_deposits")
      .update({ metadata: { ...metadata, [takedownReminderKey(threshold)]: new Date().toISOString() } })
      .eq("id", row.id)
    if (markError) throw new Error(`Failed to record the deposit reminder: ${markError.message}`)
    announced += 1
  }

  for (const row of dueFees.data ?? []) {
    const dueOn = row.due_on as string
    const daysOut = daysUntil(dueOn, today)
    const contract = Array.isArray(row.contract) ? row.contract[0] : row.contract
    const contractMetadata = ((contract?.metadata ?? {}) as Record<string, unknown>)
    const feeKey = (days: number) => `fee_${row.id as string}_${takedownReminderKey(days)}`
    const threshold = dueThreshold(daysOut, (days) => Boolean(contractMetadata[feeKey(days)]))
    if (threshold === undefined) continue
    await announce(row.org_id as string, "land_contract", row.land_contract_id as string, {
      kind: "fee",
      community_id: String(contract?.community_id ?? ""),
      name: `${String(contract?.title ?? "Land contract")} ${row.kind === "extension" ? "extension fee" : "penalty"}`,
      amendment_id: row.id as string,
      due_on: dueOn,
      days_out: daysOut,
      amount_cents: Number(row.fee_cents),
    })
    // Read the contract's metadata fresh: two fees on one contract may both be due.
    const { data: current, error: currentError } = await service.from("land_contracts").select("metadata").eq("id", row.land_contract_id).maybeSingle()
    if (currentError || !current) throw new Error(`Failed to record the fee reminder: ${currentError?.message ?? "contract not found"}`)
    const { error: markError } = await service
      .from("land_contracts")
      .update({ metadata: { ...((current.metadata ?? {}) as Record<string, unknown>), [feeKey(threshold)]: new Date().toISOString() } })
      .eq("id", row.land_contract_id)
    if (markError) throw new Error(`Failed to record the fee reminder: ${markError.message}`)
    announced += 1
  }

  return { announced }
}
