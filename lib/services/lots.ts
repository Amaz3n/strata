import { orFilterTerm } from "@/lib/search-picker"
import type { SupabaseClient } from "@supabase/supabase-js"

import {
  assertLotAttachTransition,
  assertLotDetachTransition,
  assertLotStatusTransition,
  ATTACHED_LOT_STATUS,
  DETACHED_LOT_STATUS,
  LOT_DELIVERY_EXCEPTIONS_EMBED,
  lotDeliveryRefusal,
  type LotStatus,
} from "@/lib/land/lot-lifecycle"
import { readLotDimensions, storeLotDimensions, type LotDimensions } from "@/lib/land/lot-dimensions"
import type { LotSwing } from "@/lib/land/lot-fit"
import { readAllRows } from "@/lib/land/paging"
import { LIVE_RESERVATION_STATUSES, liveReservationOrFilter } from "@/lib/sales/live-reservation"
import { isPlanOffered, offeringOverrideFor, PLAN_OFFERING_REFUSAL } from "@/lib/sales/plan-offering"
import { resolveDivisionScope } from "@/lib/land/scope"
import { checkLotFits, reevaluatePinnedLotFits, type LotFitVerdict } from "@/lib/services/lot-fit"
import { getDivisionAccessForUser } from "@/lib/services/authorization"
import { recordAudit } from "@/lib/services/audit"
import { requireCommunityScope } from "@/lib/services/communities"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"
import {
  bulkLotPatchSchema,
  createLotsInputSchema,
  lotDeliveryExceptionSchema,
  lotPlanAssignmentSchema,
  lotStatusSchema,
  lotUpdateSchema,
  type LotPlanAssignmentInput,
  type LotCreateInput,
  type LotUpdateInput,
} from "@/lib/validation/lots"

export type { LotStatus } from "@/lib/land/lot-lifecycle"

export type { LotDimensions } from "@/lib/land/lot-dimensions"

export interface LotDTO {
  id: string
  communityId: string
  divisionId: string | null
  phaseId: string | null
  phaseName: string | null
  lotNumber: string
  block: string | null
  status: LotStatus
  address: string | null
  dimensions: LotDimensions
  swing: "left" | "right" | "either"
  premiumCents: number
  costBasisCents: number | null
  takedownId: string | null
  takedownName: string | null
  acquiredDate: string | null
  projectId: string | null
  projectName: string | null
  notes: string | null
}

export interface ProjectLotContextDTO {
  communityId: string
  communityName: string
  lotNumber: string
  block: string | null
}

type RelationName = { name?: string | null } | Array<{ name?: string | null }> | null

type LotRow = {
  id: string
  community_id: string
  division_id: string | null
  community_phase_id: string | null
  lot_number: string
  block: string | null
  status: LotStatus
  address: string | null
  dimensions: Record<string, unknown> | null
  swing: LotDTO["swing"]
  premium_cents: number
  cost_basis_cents: number | null
  takedown_id: string | null
  acquired_date: string | null
  project_id: string | null
  notes: string | null
  phase?: RelationName
  project?: RelationName
  takedown?: RelationName
}

const LOT_SELECT = "id, community_id, division_id, community_phase_id, lot_number, block, status, address, dimensions, swing, premium_cents, cost_basis_cents, takedown_id, acquired_date, project_id, notes, phase:community_phases(name), project:projects(name), takedown:lot_takedowns(name)"

function relationName(relation: RelationName | undefined) {
  if (Array.isArray(relation)) return relation[0]?.name ?? null
  return relation?.name ?? null
}

function mapLot(row: LotRow): LotDTO {
  return {
    id: row.id,
    communityId: row.community_id,
    divisionId: row.division_id,
    phaseId: row.community_phase_id,
    phaseName: relationName(row.phase),
    lotNumber: row.lot_number,
    block: row.block,
    status: row.status,
    address: row.address,
    dimensions: readLotDimensions(row.dimensions),
    swing: row.swing,
    premiumCents: Number(row.premium_cents),
    costBasisCents: row.cost_basis_cents == null ? null : Number(row.cost_basis_cents),
    takedownId: row.takedown_id,
    takedownName: relationName(row.takedown),
    acquiredDate: row.acquired_date,
    projectId: row.project_id,
    projectName: relationName(row.project),
    notes: row.notes,
  }
}

/**
 * The column is stored snake_case and carries more than the four measurements —
 * the lot importer also files city, state, and postal code in here. Spreading
 * the stored value first keeps those alive; rebuilding the object from the DTO
 * alone would silently drop them on any dimension edit.
 */
function dimensionsPayload(
  dimensions: LotCreateInput["dimensions"] | undefined,
  existing?: Record<string, unknown> | null,
) {
  if (dimensions === undefined) return undefined
  return storeLotDimensions(existing, dimensions, "replace")
}

function lotPayload(input: Partial<LotUpdateInput>, existingDimensions?: Record<string, unknown> | null) {
  const patch: Record<string, unknown> = {}
  if (input.lotNumber !== undefined) patch.lot_number = input.lotNumber
  if (input.block !== undefined) patch.block = input.block || null
  if (input.phaseId !== undefined) patch.community_phase_id = input.phaseId
  if (input.status !== undefined) patch.status = input.status
  if (input.address !== undefined) patch.address = input.address || null
  if (input.dimensions !== undefined) patch.dimensions = dimensionsPayload(input.dimensions, existingDimensions)
  if (input.swing !== undefined) patch.swing = input.swing
  if (input.premiumCents !== undefined) patch.premium_cents = input.premiumCents
  if (input.costBasisCents !== undefined) patch.cost_basis_cents = input.costBasisCents
  if (input.takedownId !== undefined) patch.takedown_id = input.takedownId
  if (input.acquiredDate !== undefined) patch.acquired_date = input.acquiredDate
  if (input.notes !== undefined) patch.notes = input.notes || null
  return patch
}

async function logLotMutation(input: {
  orgId: string
  userId: string
  eventType: string
  entityId: string
  action: "insert" | "update" | "delete"
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  payload?: Record<string, unknown>
}) {
  await Promise.all([
    recordEvent({ orgId: input.orgId, actorId: input.userId, eventType: input.eventType, entityType: "lot", entityId: input.entityId, payload: input.payload }),
    recordAudit({ orgId: input.orgId, actorId: input.userId, action: input.action, entityType: "lot", entityId: input.entityId, before: input.before, after: input.after }),
  ])
}

/**
 * Every phase and takedown named by a batch of lots must belong to this
 * community. Validated as sets in two queries no matter how many lots are being
 * written — a 500-lot range create names one phase and one takedown, and asking
 * per lot turned that into a thousand sequential round trips.
 */
async function assertCommunityRelationSets(
  supabase: SupabaseClient,
  orgId: string,
  communityId: string,
  { phaseIds, takedownIds }: { phaseIds: string[]; takedownIds: string[] },
) {
  const expected: Array<{ table: string; ids: string[] }> = []
  if (phaseIds.length > 0) expected.push({ table: "community_phases", ids: phaseIds })
  if (takedownIds.length > 0) expected.push({ table: "lot_takedowns", ids: takedownIds })
  if (expected.length === 0) return
  const results = await Promise.all(
    expected.map((entry) =>
      supabase.from(entry.table).select("id").eq("org_id", orgId).eq("community_id", communityId).in("id", entry.ids),
    ),
  )
  results.forEach((result, index) => {
    if (result.error || (result.data ?? []).length !== expected[index].ids.length) {
      throw new Error("Phase or takedown does not belong to this community.")
    }
  })
}

function assertCommunityRelations(
  supabase: SupabaseClient,
  orgId: string,
  communityId: string,
  input: { phaseId?: string | null; takedownId?: string | null },
) {
  return assertCommunityRelationSets(supabase, orgId, communityId, {
    phaseIds: input.phaseId ? [input.phaseId] : [],
    takedownIds: input.takedownId ? [input.takedownId] : [],
  })
}

/** The attach-a-home picker is a dropdown; past this it needs a search, not a longer list. */
const ATTACHABLE_PROJECT_CAP = 500
/**
 * How far the picker will read looking for homes that are still free. Unlike the
 * cap above this bounds the *scan*, not the answer: the "no lot yet" filter runs
 * in Postgres, so this only ever stops a runaway read.
 */
const ATTACHABLE_SCAN_CAP = 5_000

/**
 * Persist a plat arrangement. Somebody drags a community's lots into the shape
 * of the recorded plat once; every later read draws it back. Positions are a
 * presentation fact, so this records an audit entry but emits no domain event.
 */
export async function setLotPlatPositions(
  communityId: string,
  positions: Array<{ lotId: string; platX: number; platY: number }>,
  orgId?: string,
): Promise<{ updated: number }> {
  const context = await requireOrgContext(orgId)
  await requirePermission("lot.write", context)
  await requireCommunityScope(communityId, context)
  const moved = new Map(positions.map((position) => [position.lotId, position]))
  if (moved.size === 0) return { updated: 0 }

  const { data: owned, error: ownedError } = await context.supabase
    .from("lots")
    .select("id, lot_number, block")
    .eq("org_id", context.orgId)
    .eq("community_id", communityId)
    .in("id", [...moved.keys()])
  if (ownedError) throw new Error(`Failed to verify lots: ${ownedError.message}`)
  const ownedRows = owned ?? []
  if (ownedRows.length !== moved.size) throw new Error("Some lots do not belong to this community")

  // One upsert, not one UPDATE per lot: arranging a 400-lot plat used to fan out
  // 400 concurrent PostgREST round trips from a single server action. `lot_number`
  // and `block` ride along because the payload has to satisfy the table's NOT NULL
  // columns; they are written back unchanged.
  const payload = ownedRows.flatMap((row) => {
    const position = moved.get(row.id as string)
    if (!position) return []
    return [{
      id: row.id as string,
      org_id: context.orgId,
      community_id: communityId,
      lot_number: row.lot_number as string,
      block: (row.block as string | null) ?? null,
      plat_x: position.platX,
      plat_y: position.platY,
    }]
  })
  const { error } = await context.supabase.from("lots").upsert(payload, { onConflict: "id" })
  if (error) throw new Error(`Failed to save the plat: ${error.message}`)

  await recordAudit({
    orgId: context.orgId,
    actorId: context.userId,
    action: "update",
    entityType: "community",
    entityId: communityId,
    after: { plat_positions: payload.length },
  })
  return { updated: payload.length }
}

/**
 * Homes that can still be attached to a lot in this community — a production
 * project that is live and not already sitting on somebody else's dirt.
 *
 * "Not already linked" is answered by paging the candidates rather than trimming
 * one page of them: the filter used to run in JS *after* a 500-row cap, so an org
 * past 500 production projects could open this picker and be told there were no
 * free homes while dozens were free.
 */
export async function listAttachableProjects(
  communityId: string,
  orgId?: string,
): Promise<{ projects: Array<{ id: string; name: string }>; truncated: boolean }> {
  const context = await requireOrgContext(orgId)
  await requirePermission("community.read", context)
  await requireCommunityScope(communityId, context)
  const decision = resolveDivisionScope(
    await getDivisionAccessForUser({ orgId: context.orgId, userId: context.userId }),
  )
  if (decision.kind === "none") return { projects: [], truncated: false }

  const candidates = await readAllRows<{ id: string; name: string; lot: Array<{ id: string }> | { id: string } | null }>(
    (from, to) => {
      let query = context.supabase
        .from("projects")
        .select("id, name, lot:lots(id)")
        .eq("org_id", context.orgId)
        .not("status", "in", "(completed,cancelled)")
        .or("property_type.is.null,property_type.eq.production")
        .order("name")
        .order("id")
        .range(from, to)
      if (decision.kind === "limited") query = query.in("division_id", decision.divisionIds)
      return query
    },
    { cap: ATTACHABLE_SCAN_CAP, label: "Failed to load homes" },
  )

  const free = candidates.rows.filter((row) => {
    const linked = row.lot
    return Array.isArray(linked) ? linked.length === 0 : linked == null
  })
  return {
    projects: free.slice(0, ATTACHABLE_PROJECT_CAP).map((row) => ({ id: row.id, name: row.name })),
    truncated: candidates.truncated || free.length > ATTACHABLE_PROJECT_CAP,
  }
}

async function getLotById(supabase: SupabaseClient, orgId: string, id: string) {
  const { data, error } = await supabase.from("lots").select(LOT_SELECT).eq("org_id", orgId).eq("id", id).maybeSingle()
  if (error || !data) throw new Error("Lot not found")
  return data as LotRow
}

export async function createLots(
  communityId: string,
  input: { lots: LotCreateInput[] },
  orgId?: string,
): Promise<{ created: number }> {
  const parsed = createLotsInputSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("lot.write", context)
  const community = await requireCommunityScope(communityId, context)
  // Distinct pairs, not per lot: a 500-lot range names one phase and one takedown.
  const phaseIds = new Set<string>()
  const takedownIds = new Set<string>()
  for (const lot of parsed.lots) {
    if (lot.status === "started") throw new Error("A new lot cannot start without an attached project.")
    if (lot.phaseId) phaseIds.add(lot.phaseId)
    if (lot.takedownId) takedownIds.add(lot.takedownId)
  }
  await assertCommunityRelationSets(context.supabase, context.orgId, communityId, {
    phaseIds: [...phaseIds],
    takedownIds: [...takedownIds],
  })
  const keys = new Set<string>()
  const repeated = new Set<string>()
  for (const lot of parsed.lots) {
    const key = `${lot.block ?? ""}::${lot.lotNumber}`
    if (keys.has(key)) repeated.add(lot.block ? `${lot.block}-${lot.lotNumber}` : lot.lotNumber)
    keys.add(key)
  }
  if (repeated.size > 0) throw new Error(`Duplicate lots in batch: ${Array.from(repeated).join(", ")}`)
  const lotNumbers = Array.from(new Set(parsed.lots.map((lot) => lot.lotNumber)))
  const { data: existing, error: existingError } = await context.supabase
    .from("lots")
    .select("lot_number, block")
    .eq("org_id", context.orgId)
    .eq("community_id", communityId)
    .in("lot_number", lotNumbers)
  if (existingError) throw new Error(`Failed to check duplicate lots: ${existingError.message}`)
  const existingKeys = new Set((existing ?? []).map((row) => `${row.block ?? ""}::${row.lot_number}`))
  const collisions = parsed.lots
    .filter((lot) => existingKeys.has(`${lot.block ?? ""}::${lot.lotNumber}`))
    .map((lot) => lot.block ? `${lot.block}-${lot.lotNumber}` : lot.lotNumber)
  if (collisions.length > 0) throw new Error(`Lots already exist: ${collisions.join(", ")}`)
  const payload = parsed.lots.map((lot) => ({
    org_id: context.orgId,
    community_id: communityId,
    division_id: community.divisionId,
    ...lotPayload(lot),
  }))
  const { data, error } = await context.supabase.from("lots").insert(payload).select("id")
  if (error) throw new Error(`Failed to create lots: ${error.message}`)
  const ids = (data ?? []).map((row) => row.id)
  const batchId = ids[0] ?? communityId
  await logLotMutation({
    orgId: context.orgId,
    userId: context.userId,
    eventType: "lot.created",
    entityId: batchId,
    action: "insert",
    after: { community_id: communityId, lot_ids: ids, count: ids.length },
    payload: { community_id: communityId, count: ids.length },
  })
  return { created: ids.length }
}

/**
 * Edit a lot's land facts. A change to what the house is judged against — its
 * dimensions, setbacks or the handing it takes — re-judges a home pinned to it;
 * one that no longer fits is recorded and returned as `fitRefusal`, never
 * silently unpinned.
 */
export async function updateLot(id: string, input: Partial<LotUpdateInput>, orgId?: string): Promise<LotDTO & { fitRefusal: string | null }> {
  const parsed = lotUpdateSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("lot.write", context)
  const before = await getLotById(context.supabase, context.orgId, id)
  await requireCommunityScope(before.community_id, context)
  await assertCommunityRelations(context.supabase, context.orgId, before.community_id, parsed)
  if (parsed.status) assertLotStatusTransition({ from: before.status, to: parsed.status, hasProject: Boolean(before.project_id) })
  const { data, error } = await context.supabase.from("lots").update(lotPayload(parsed, before.dimensions)).eq("org_id", context.orgId).eq("id", id).select(LOT_SELECT).single()
  if (error) throw new Error(`Failed to update lot: ${error.message}`)
  await logLotMutation({ orgId: context.orgId, userId: context.userId, eventType: "lot.updated", entityId: id, action: "update", before, after: data, payload: { community_id: before.community_id, lot_number: data.lot_number } })
  const fitInputsChanged = parsed.dimensions !== undefined || parsed.swing !== undefined
  const refused = fitInputsChanged ? await reevaluatePinnedLotFits(context, [id]) : new Map<string, string>()
  return { ...mapLot(data as LotRow), fitRefusal: refused.get(id) ?? null }
}

export async function bulkUpdateLots(
  communityId: string,
  input: { lotIds: string[]; patch: Partial<Pick<LotUpdateInput, "status" | "phaseId" | "takedownId" | "premiumCents" | "swing">> },
  orgId?: string,
): Promise<{ updated: number }> {
  const parsed = bulkLotPatchSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("lot.write", context)
  await requireCommunityScope(communityId, context)
  await assertCommunityRelations(context.supabase, context.orgId, communityId, parsed.patch)
  const { data: before, error: beforeError } = await context.supabase.from("lots").select("id, status, project_id").eq("org_id", context.orgId).eq("community_id", communityId).in("id", parsed.lotIds)
  if (beforeError) throw new Error(`Failed to load lots: ${beforeError.message}`)
  if ((before ?? []).length !== parsed.lotIds.length) throw new Error("One or more selected lots were not found.")
  if (parsed.patch.status) {
    for (const row of before ?? []) assertLotStatusTransition({ from: row.status as LotStatus, to: parsed.patch.status, hasProject: Boolean(row.project_id) })
  }
  const { data, error } = await context.supabase.from("lots").update(lotPayload(parsed.patch)).eq("org_id", context.orgId).eq("community_id", communityId).in("id", parsed.lotIds).select("id")
  if (error) throw new Error(`Failed to update lots: ${error.message}`)
  const updated = data?.length ?? 0
  await logLotMutation({ orgId: context.orgId, userId: context.userId, eventType: "lot.updated", entityId: parsed.lotIds[0], action: "update", before: { lots: before }, after: { lot_ids: parsed.lotIds, patch: parsed.patch }, payload: { community_id: communityId, count: updated, bulk: true } })
  return { updated }
}

export async function setLotStatus(
  id: string,
  status: LotStatus,
  { force = false }: { force?: boolean } = {},
  orgId?: string,
): Promise<LotDTO> {
  const parsed = lotStatusSchema.parse({ status, force })
  const context = await requireOrgContext(orgId)
  await requirePermission("lot.write", context)
  if (parsed.force) await requirePermission("community.write", context)
  const before = await getLotById(context.supabase, context.orgId, id)
  await requireCommunityScope(before.community_id, context)
  assertLotStatusTransition({ from: before.status, to: parsed.status, hasProject: Boolean(before.project_id), force: parsed.force })
  const { data, error } = await context.supabase.from("lots").update({ status: parsed.status }).eq("org_id", context.orgId).eq("id", id).select(LOT_SELECT).single()
  if (error) throw new Error(`Failed to set lot status: ${error.message}`)
  await logLotMutation({ orgId: context.orgId, userId: context.userId, eventType: "lot.status_changed", entityId: id, action: "update", before, after: data, payload: { community_id: before.community_id, from: before.status, to: parsed.status, force: parsed.force } })
  return mapLot(data as LotRow)
}

/**
 * Pin a released plan version and elevation to a lot nobody has bought, so a
 * spec home can be started on it. A lot with a home already took its plan from
 * instantiation, and a held or sold lot takes it from the purchase agreement,
 * so both refuse here. The plan must be on the community's price sheet today, or
 * carry a recorded offering override — the same answer the start package's plan
 * gate re-derives at release.
 */
type PinClient = { supabase: SupabaseClient; orgId: string }
type PinnedLotFacts = { id: string; community_id: string; metadata: unknown; dimensions: Record<string, unknown> | null; swing: LotSwing | null }

/**
 * The rules every plan on a lot answers to, wherever it is pinned: the
 * community offers the plan in that elevation today (or the lot carries an
 * offering override for it), and the house fits the lot.
 */
async function assertLotTakesPlan(db: PinClient, lot: PinnedLotFacts, pin: { planId: string; elevationId: string | null; swing: "left" | "right" | null }) {
  const { data: offering, error: offeringError } = await db.supabase.from("community_plan_availability")
    .select("is_available, elevation_id, effective_start, effective_end")
    .eq("org_id", db.orgId).eq("community_id", lot.community_id).eq("house_plan_id", pin.planId)
  if (offeringError) throw new Error(`Failed to check community plan offering: ${offeringError.message}`)
  const offered = isPlanOffered(offering ?? [], { elevationId: pin.elevationId, onDate: new Date().toISOString().slice(0, 10) })
  if (!offered && !offeringOverrideFor(lot.metadata, pin.planId)) {
    throw new Error(PLAN_OFFERING_REFUSAL)
  }
  const fit = (await checkLotFits(db, [{
    key: lot.id, lotId: lot.id, communityId: lot.community_id, dimensions: lot.dimensions, lotSwing: lot.swing ?? "either",
    planId: pin.planId, elevationId: pin.elevationId, swing: pin.swing,
  }])).get(lot.id)
  if (fit?.refusal) throw new Error(fit.refusal)
}

/**
 * May this lot move from the version it carries to another version of the same
 * plan, keeping its elevation? The version must be released, and the plan in
 * that elevation must still be offered and still fit, as for any pin. Asked
 * when a reviewer adopts a plan change for a home; the caller has authorized
 * the reviewer (plan.adopt) and the home.
 */
export async function assertLotCanAdoptPlanVersion(db: PinClient, input: { lotId: string; fromVersionId: string; toVersionId: string }) {
  const [lotResult, versionResult] = await Promise.all([
    db.supabase.from("lots").select("id, community_id, metadata, dimensions, swing, house_plan_id, house_plan_version_id, house_plan_elevation_id")
      .eq("org_id", db.orgId).eq("id", input.lotId).maybeSingle(),
    db.supabase.from("house_plan_versions").select("id, house_plan_id, status").eq("org_id", db.orgId).eq("id", input.toVersionId).maybeSingle(),
  ])
  if (lotResult.error || !lotResult.data) throw new Error("Lot not found")
  if (versionResult.error || !versionResult.data) throw new Error("Plan version not found")
  const lot = lotResult.data
  if (lot.house_plan_version_id !== input.fromVersionId) throw new Error("This home's plan changed since the review opened. Reopen the review.")
  if (versionResult.data.house_plan_id !== lot.house_plan_id) throw new Error("That version belongs to another plan.")
  if (versionResult.data.status !== "released") throw new Error("Only a released plan version can be pinned to a lot.")
  const swing = lot.swing === "left" || lot.swing === "right" ? lot.swing : null
  await assertLotTakesPlan(db, lot, { planId: versionResult.data.house_plan_id, elevationId: lot.house_plan_elevation_id ?? null, swing })
}

/**
 * Move a lot's pin from one version of its plan to another — the plan and
 * elevation stay. Written only while the lot still carries `fromVersionId`, so
 * a second adoption or a re-sale in between is refused rather than overwritten.
 * The rules were asked by `assertLotCanAdoptPlanVersion` when the adoption was
 * decided; an adoption that waited on a buyer's signature is applied as signed.
 */
export async function writeLotPlanVersion(db: PinClient & { actorId: string | null }, input: { lotId: string; fromVersionId: string; toVersionId: string; source: string }) {
  const { data, error } = await db.supabase.from("lots")
    .update({ house_plan_version_id: input.toVersionId })
    .eq("org_id", db.orgId).eq("id", input.lotId).eq("house_plan_version_id", input.fromVersionId)
    .select("id, community_id, house_plan_id").maybeSingle()
  if (error) throw new Error(`Failed to move the home to the new plan version: ${error.message}`)
  if (!data) throw new Error("This home's plan changed since the review opened. Reopen the review.")
  await Promise.all([
    recordEvent({ orgId: db.orgId, actorId: db.actorId, eventType: "lot.plan_assigned", entityType: "lot", entityId: input.lotId,
      payload: { community_id: data.community_id, house_plan_id: data.house_plan_id, source: input.source } }),
    recordAudit({ orgId: db.orgId, actorId: db.actorId ?? undefined, action: "update", entityType: "lot", entityId: input.lotId,
      before: { house_plan_version_id: input.fromVersionId }, after: { house_plan_version_id: input.toVersionId }, source: input.source }),
  ])
}

export async function assignPlanToLot(lotId: string, input: LotPlanAssignmentInput, orgId?: string): Promise<LotDTO> {
  const parsed = lotPlanAssignmentSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await Promise.all([requirePermission("lot.write", context), requirePermission("plan.instantiate", context)])
  const { data: lot, error: lotError } = await context.supabase.from("lots")
    .select("id, community_id, status, project_id, metadata, dimensions, swing, house_plan_version_id, house_plan_elevation_id, updated_at")
    .eq("org_id", context.orgId).eq("id", lotId).maybeSingle()
  if (lotError || !lot) throw new Error("Lot not found")
  await requireCommunityScope(lot.community_id, context)
  if (lot.project_id) throw new Error("This lot already has a home; its plan comes from that home.")
  if (lot.status === "started" || lot.status === "closed") throw new Error("A started or closed lot cannot take a new plan.")

  const [reservations, version, elevation] = await Promise.all([
    context.supabase.from("lot_reservations").select("id").eq("org_id", context.orgId).eq("lot_id", lotId)
      .in("status", LIVE_RESERVATION_STATUSES).or(liveReservationOrFilter()).limit(1),
    context.supabase.from("house_plan_versions").select("id, house_plan_id, status").eq("org_id", context.orgId).eq("id", parsed.versionId).maybeSingle(),
    context.supabase.from("house_plan_elevations").select("id, house_plan_id, is_active").eq("org_id", context.orgId).eq("id", parsed.elevationId).maybeSingle(),
  ])
  if (reservations.error) throw new Error(`Failed to check the lot's reservations: ${reservations.error.message}`)
  if (version.error || !version.data) throw new Error("Plan version not found")
  if (elevation.error || !elevation.data) throw new Error("Plan elevation not found")
  if ((reservations.data ?? []).length > 0) throw new Error("This lot is held or sold; its plan comes from the purchase agreement.")
  if (version.data.status !== "released") throw new Error("Only a released plan version can be pinned to a lot.")
  if (elevation.data.house_plan_id !== version.data.house_plan_id || elevation.data.is_active === false) {
    throw new Error("That elevation does not belong to the plan, or is no longer offered.")
  }

  await assertLotTakesPlan(context, lot, { planId: version.data.house_plan_id, elevationId: elevation.data.id, swing: parsed.swing ?? null })

  const { data, error } = await context.supabase.from("lots")
    .update({
      house_plan_id: version.data.house_plan_id,
      house_plan_version_id: version.data.id,
      house_plan_elevation_id: elevation.data.id,
      ...(parsed.swing ? { swing: parsed.swing } : {}),
    })
    .eq("org_id", context.orgId).eq("id", lotId).eq("updated_at", lot.updated_at).is("project_id", null)
    .select(LOT_SELECT).maybeSingle()
  if (error) throw new Error(`Failed to assign the plan: ${error.message}`)
  if (!data) throw new Error("The lot changed while you were assigning the plan. Review it and try again.")
  await logLotMutation({
    orgId: context.orgId, userId: context.userId, eventType: "lot.plan_assigned", entityId: lotId, action: "update",
    before: { house_plan_version_id: lot.house_plan_version_id, house_plan_elevation_id: lot.house_plan_elevation_id },
    after: { house_plan_id: version.data.house_plan_id, house_plan_version_id: version.data.id, house_plan_elevation_id: elevation.data.id },
    payload: { community_id: lot.community_id, house_plan_id: version.data.house_plan_id },
  })
  return mapLot(data as LotRow)
}

export interface PlanAssignmentOption {
  planId: string
  code: string
  name: string
  /** Released versions, newest first. */
  versions: Array<{ id: string; versionNumber: number }>
  elevations: Array<{
    id: string
    code: string
    name: string | null
    swingApplicable: boolean
    offered: boolean
    /** How this elevation fits the lot in its current handing, when a lot was named. */
    fit: LotFitVerdict | null
  }>
}

/** More plans than this and the picker would be a search problem, not a select. */
export const PLAN_ASSIGNMENT_OPTION_CAP = 200

/**
 * Every plan a lot could be pinned to, offered in its community or not. The
 * unoffered ones are listed on purpose: the refusal and its override path are
 * the point of showing them, so the answer per elevation is computed with the
 * same `isPlanOffered` the assignment itself uses. Named a lot, each elevation
 * also carries the lot fit verdict the assignment will apply.
 */
export async function listPlanAssignmentOptions(
  communityId: string,
  input: { search?: string; lotId?: string } = {},
  orgId?: string,
): Promise<{ plans: PlanAssignmentOption[]; truncated: boolean }> {
  const context = await requireOrgContext(orgId)
  await Promise.all([requirePermission("lot.write", context), requirePermission("plan.instantiate", context)])
  await requireCommunityScope(communityId, context)
  const lot = input.lotId ? await getLotById(context.supabase, context.orgId, input.lotId) : null
  if (lot && lot.community_id !== communityId) throw new Error("Lot not found")
  let planQuery = context.supabase.from("house_plans")
    .select("id, code, name")
    .eq("org_id", context.orgId).neq("status", "retired")
  const term = input.search ? orFilterTerm(input.search) : ""
  if (term) planQuery = planQuery.or(`code.ilike.%${term}%,name.ilike.%${term}%`)
  const { data: plans, error } = await planQuery.order("code").order("id").limit(PLAN_ASSIGNMENT_OPTION_CAP + 1)
  if (error) throw new Error(`Failed to load plans: ${error.message}`)
  const shown = (plans ?? []).slice(0, PLAN_ASSIGNMENT_OPTION_CAP)
  if (shown.length === 0) return { plans: [], truncated: false }
  const planIds = shown.map((plan) => plan.id)
  const [versions, elevations, offering] = await Promise.all([
    context.supabase.from("house_plan_versions").select("id, house_plan_id, version_number")
      .eq("org_id", context.orgId).eq("status", "released").in("house_plan_id", planIds).order("version_number", { ascending: false }),
    context.supabase.from("house_plan_elevations").select("id, house_plan_id, code, name, swing_applicable")
      .eq("org_id", context.orgId).eq("is_active", true).in("house_plan_id", planIds).order("sort_order"),
    context.supabase.from("community_plan_availability").select("house_plan_id, is_available, elevation_id, effective_start, effective_end")
      .eq("org_id", context.orgId).eq("community_id", communityId).in("house_plan_id", planIds),
  ])
  for (const result of [versions, elevations, offering]) {
    if (result.error) throw new Error(`Failed to load plan options: ${result.error.message}`)
  }
  const today = new Date().toISOString().slice(0, 10)
  const fits = lot
    ? await checkLotFits(context, (elevations.data ?? []).map((elevation) => ({
      key: elevation.id, lotId: lot.id, communityId, dimensions: lot.dimensions, lotSwing: lot.swing,
      planId: elevation.house_plan_id, elevationId: elevation.id, swing: null,
    })))
    : null
  const options = shown.flatMap((plan): PlanAssignmentOption[] => {
    const planVersions = (versions.data ?? []).filter((version) => version.house_plan_id === plan.id)
    const planElevations = (elevations.data ?? []).filter((elevation) => elevation.house_plan_id === plan.id)
    if (planVersions.length === 0 || planElevations.length === 0) return []
    const rows = (offering.data ?? []).filter((row) => row.house_plan_id === plan.id)
    return [{
      planId: plan.id,
      code: plan.code,
      name: plan.name,
      versions: planVersions.map((version) => ({ id: version.id, versionNumber: Number(version.version_number) })),
      elevations: planElevations.map((elevation) => ({
        id: elevation.id,
        code: elevation.code,
        name: elevation.name,
        swingApplicable: Boolean(elevation.swing_applicable),
        offered: isPlanOffered(rows, { elevationId: elevation.id, onDate: today }),
        fit: fits?.get(elevation.id) ?? null,
      })),
    }]
  })
  return { plans: options, truncated: (plans ?? []).length > PLAN_ASSIGNMENT_OPTION_CAP }
}

/**
 * Link a home to its dirt.
 *
 * Both halves of the link go through `assertLotStatusTransition` like every other
 * status change. Without it, attaching a home to a `closed` lot silently reversed
 * a settlement — the one move `setLotStatus` has always demanded `force` for.
 *
 * The two writes are ordered so the lot is the last thing to change, and a failed
 * lot write puts the project's posture back where it was. Postgres cannot give us
 * one transaction across two PostgREST calls, and the alternative — the current
 * behaviour — leaves a project converted to production posture with no lot under
 * it, which nothing in the app can see or repair.
 */
export async function attachProjectToLot(
  lotId: string,
  projectId: string,
  { force = false }: { force?: boolean } = {},
  orgId?: string,
): Promise<LotDTO> {
  const context = await requireOrgContext(orgId)
  await Promise.all([requirePermission("lot.write", context), requirePermission("project.manage", context)])
  if (force) await requirePermission("community.write", context)
  const before = await getLotById(context.supabase, context.orgId, lotId)
  await requireCommunityScope(before.community_id, context)
  if (before.project_id && before.project_id !== projectId) throw new Error("This lot already has a project attached.")
  assertLotAttachTransition({ from: before.status, force })
  const { data: project, error: projectError } = await context.supabase.from("projects").select("id, org_id, name, property_type, division_id, client_id").eq("org_id", context.orgId).eq("id", projectId).maybeSingle()
  if (projectError || !project) throw new Error("Project not found")
  const [delivery, reservations] = await Promise.all([
    context.supabase.from("lots").select(`delivered_at, ${LOT_DELIVERY_EXCEPTIONS_EMBED}`).eq("org_id", context.orgId).eq("id", lotId).maybeSingle(),
    context.supabase.from("lot_reservations").select("buyer_contact_id, co_buyer_contact_id").eq("org_id", context.orgId).eq("lot_id", lotId).in("status", LIVE_RESERVATION_STATUSES).or(liveReservationOrFilter()).limit(10),
  ])
  if (delivery.error || !delivery.data || reservations.error) throw new Error("The lot's delivery and reservation status could not be verified. No home was attached.")
  const undelivered = lotDeliveryRefusal({ deliveredAt: delivery.data.delivered_at, deliveryExceptions: delivery.data.delivery_exceptions })
  if (undelivered) throw new Error(undelivered)
  // A live hold or reservation belongs to its buyer. Only that buyer's own
  // home may be attached; anyone else's would sell the lot twice. This read
  // refuses early; the lot update below is the fence (lots_home_reservation_guard
  // serializes it with hold inserts on the lot row).
  const heldForOthers = (reservations.data ?? []).some((reservation) => !project.client_id || ![reservation.buyer_contact_id, reservation.co_buyer_contact_id].includes(project.client_id))
  if (heldForOthers) throw new Error("This lot has a live hold or reservation for another buyer. Release it before attaching a different home.")
  if (project.property_type && project.property_type !== "production") throw new Error("Only production-posture projects can be attached to lots.")
  const { data: existingLink, error: linkError } = await context.supabase.from("lots").select("id").eq("org_id", context.orgId).eq("project_id", projectId).neq("id", lotId).maybeSingle()
  if (linkError) throw new Error(`Failed to validate project link: ${linkError.message}`)
  if (existingLink) throw new Error("This project is already attached to another lot.")
  const { error: projectUpdateError } = await context.supabase.from("projects").update({ property_type: "production", division_id: before.division_id ?? project.division_id }).eq("org_id", context.orgId).eq("id", projectId)
  if (projectUpdateError) throw new Error(`Failed to prepare project: ${projectUpdateError.message}`)
  const { data, error } = await context.supabase.from("lots").update({ project_id: projectId, status: ATTACHED_LOT_STATUS }).eq("org_id", context.orgId).eq("id", lotId).select(LOT_SELECT).single()
  if (error) {
    await context.supabase
      .from("projects")
      .update({ property_type: project.property_type, division_id: project.division_id })
      .eq("org_id", context.orgId)
      .eq("id", projectId)
    throw new Error(error.code === "23514" ? error.message : `Failed to attach project: ${error.message}`)
  }
  await logLotMutation({ orgId: context.orgId, userId: context.userId, eventType: "lot.project_attached", entityId: lotId, action: "update", before, after: data, payload: { community_id: before.community_id, project_id: projectId, project_name: project.name, force } })
  return mapLot(data as LotRow)
}

/**
 * Let a house start on a lot land development has not delivered. The exception
 * is its own authority (`lot.delivery_override`), needs a reason, and is a
 * record the start gates read back — the database refuses a start package or a
 * `started` status on an undelivered lot without a live one. Recording a new
 * exception is refused while one is live; revoke it first.
 */
export async function recordLotDeliveryException(
  lotId: string,
  input: { reason: string },
  orgId?: string,
): Promise<void> {
  const parsed = lotDeliveryExceptionSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("lot.delivery_override", context)
  const before = await getLotById(context.supabase, context.orgId, lotId)
  await requireCommunityScope(before.community_id, context)
  const { data, error } = await context.supabase
    .from("lot_delivery_exceptions")
    .insert({ org_id: context.orgId, lot_id: lotId, reason: parsed.reason, approved_by: context.userId })
    .select("id, reason, approved_by, approved_at")
    .single()
  if (error?.code === "23505") throw new Error("This lot already has a delivery exception. Revoke it before recording another.")
  if (error || !data) throw new Error(`Failed to record the delivery exception: ${error?.message ?? "no row returned"}`)
  await logLotMutation({ orgId: context.orgId, userId: context.userId, eventType: "lot.delivery_exception_recorded", entityId: lotId, action: "insert", after: data, payload: { community_id: before.community_id, exception_id: data.id, reason: parsed.reason } })
}

/** Withdraw a lot's live delivery exception. A house already started on it stays started. */
export async function revokeLotDeliveryException(lotId: string, orgId?: string): Promise<void> {
  const context = await requireOrgContext(orgId)
  await requirePermission("lot.delivery_override", context)
  const before = await getLotById(context.supabase, context.orgId, lotId)
  await requireCommunityScope(before.community_id, context)
  const { data, error } = await context.supabase
    .from("lot_delivery_exceptions")
    .update({ revoked_at: new Date().toISOString(), revoked_by: context.userId })
    .eq("org_id", context.orgId)
    .eq("lot_id", lotId)
    .is("revoked_at", null)
    .select("id, reason, approved_by, approved_at, revoked_at")
    .maybeSingle()
  if (error) throw new Error(`Failed to revoke the delivery exception: ${error.message}`)
  if (!data) throw new Error("This lot has no live delivery exception.")
  await logLotMutation({ orgId: context.orgId, userId: context.userId, eventType: "lot.delivery_exception_revoked", entityId: lotId, action: "update", after: data, payload: { community_id: before.community_id, exception_id: data.id } })
}

/**
 * Unlink a home from its dirt and return the lot to inventory. The home keeps
 * its division: that belongs to the project, and clearing it would take the
 * house out of every division-scoped member's reach.
 *
 * A started lot moving back to `assigned` is exactly the backward step the
 * lifecycle asks for an explicit confirmation on, so detaching a house that is
 * building takes `force` and the `community.write` that goes with it — the same
 * bar `setLotStatus` sets — rather than reaching around the state machine.
 */
export async function detachProjectFromLot(
  lotId: string,
  { force = false }: { force?: boolean } = {},
  orgId?: string,
): Promise<LotDTO> {
  const context = await requireOrgContext(orgId)
  await Promise.all([requirePermission("lot.write", context), requirePermission("project.manage", context)])
  if (force) await requirePermission("community.write", context)
  const before = await getLotById(context.supabase, context.orgId, lotId)
  await requireCommunityScope(before.community_id, context)
  if (!before.project_id) throw new Error("This lot does not have a project attached.")
  assertLotDetachTransition({ from: before.status, force })
  const projectId = before.project_id
  const { data, error } = await context.supabase.from("lots").update({ project_id: null, status: DETACHED_LOT_STATUS }).eq("org_id", context.orgId).eq("id", lotId).select(LOT_SELECT).single()
  if (error) throw new Error(`Failed to detach project: ${error.message}`)
  await logLotMutation({ orgId: context.orgId, userId: context.userId, eventType: "lot.project_detached", entityId: lotId, action: "update", before, after: data, payload: { community_id: before.community_id, project_id: projectId, force } })
  return mapLot(data as LotRow)
}

export async function deleteLot(id: string, orgId?: string): Promise<void> {
  const context = await requireOrgContext(orgId)
  await requirePermission("lot.write", context)
  const before = await getLotById(context.supabase, context.orgId, id)
  await requireCommunityScope(before.community_id, context)
  if (before.project_id) throw new Error("Detach the project before deleting this lot.")
  if (!(["controlled", "owned", "developed"] as LotStatus[]).includes(before.status)) {
    throw new Error("Only controlled, owned, or developed lots can be deleted.")
  }
  const { error } = await context.supabase.from("lots").delete().eq("org_id", context.orgId).eq("id", id)
  if (error) throw new Error(`Failed to delete lot: ${error.message}`)
  await logLotMutation({ orgId: context.orgId, userId: context.userId, eventType: "lot.deleted", entityId: id, action: "delete", before, payload: { community_id: before.community_id, lot_number: before.lot_number } })
}

export async function getProjectLotContext(projectId: string, orgId?: string): Promise<ProjectLotContextDTO | null> {
  const context = await requireOrgContext(orgId)
  await requirePermission("community.read", context)
  const { data, error } = await context.supabase
    .from("lots")
    .select("community_id, lot_number, block, community:communities(name)")
    .eq("org_id", context.orgId)
    .eq("project_id", projectId)
    .maybeSingle()
  if (error) throw new Error(`Failed to resolve project lot: ${error.message}`)
  if (!data) return null
  const community = data.community as RelationName
  return {
    communityId: data.community_id,
    communityName: relationName(community) ?? "Community",
    lotNumber: data.lot_number,
    block: data.block,
  }
}
