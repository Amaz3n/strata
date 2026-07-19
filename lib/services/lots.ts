import type { SupabaseClient } from "@supabase/supabase-js"

import { assertLotStatusTransition, LOT_STATUSES, type LotStatus } from "@/lib/land/lot-lifecycle"
import { recordAudit } from "@/lib/services/audit"
import { getCommunity } from "@/lib/services/communities"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"
import {
  bulkLotPatchSchema,
  createLotsInputSchema,
  lotListFiltersSchema,
  lotStatusSchema,
  lotUpdateSchema,
  type LotCreateInput,
  type LotListFilters,
  type LotUpdateInput,
} from "@/lib/validation/lots"

export type { LotStatus } from "@/lib/land/lot-lifecycle"

export interface LotDimensions {
  widthFt?: number
  depthFt?: number
  acreage?: number
  irregular?: boolean
}

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

export interface LotListPage {
  lots: LotDTO[]
  total: number
  page: number
  pageSize: number
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

function optionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function mapDimensions(value: Record<string, unknown> | null): LotDimensions {
  return {
    widthFt: optionalNumber(value?.width_ft ?? value?.widthFt),
    depthFt: optionalNumber(value?.depth_ft ?? value?.depthFt),
    acreage: optionalNumber(value?.acreage),
    irregular: typeof value?.irregular === "boolean" ? value.irregular : undefined,
  }
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
    dimensions: mapDimensions(row.dimensions),
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

function dimensionsPayload(dimensions: LotCreateInput["dimensions"] | undefined) {
  if (dimensions === undefined) return undefined
  return {
    width_ft: dimensions.widthFt,
    depth_ft: dimensions.depthFt,
    acreage: dimensions.acreage,
    irregular: dimensions.irregular,
  }
}

function lotPayload(input: Partial<LotUpdateInput>) {
  const patch: Record<string, unknown> = {}
  if (input.lotNumber !== undefined) patch.lot_number = input.lotNumber
  if (input.block !== undefined) patch.block = input.block || null
  if (input.phaseId !== undefined) patch.community_phase_id = input.phaseId
  if (input.status !== undefined) patch.status = input.status
  if (input.address !== undefined) patch.address = input.address || null
  if (input.dimensions !== undefined) patch.dimensions = dimensionsPayload(input.dimensions)
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

async function assertCommunityRelations(
  supabase: SupabaseClient,
  orgId: string,
  communityId: string,
  input: { phaseId?: string | null; takedownId?: string | null },
) {
  const checks: PromiseLike<{ data: { id: string } | null; error: { message: string } | null }>[] = []
  if (input.phaseId) {
    checks.push(supabase.from("community_phases").select("id").eq("org_id", orgId).eq("community_id", communityId).eq("id", input.phaseId).maybeSingle())
  }
  if (input.takedownId) {
    checks.push(supabase.from("lot_takedowns").select("id").eq("org_id", orgId).eq("community_id", communityId).eq("id", input.takedownId).maybeSingle())
  }
  const results = await Promise.all(checks)
  if (results.some((result) => result.error || !result.data)) {
    throw new Error("Phase or takedown does not belong to this community.")
  }
}

export async function listLots(
  communityId: string,
  filters: Partial<LotListFilters> = {},
  orgId?: string,
): Promise<LotListPage> {
  const parsed = lotListFiltersSchema.parse(filters)
  const context = await requireOrgContext(orgId)
  await requirePermission("community.read", context)
  await getCommunity(communityId, context.orgId)
  let query = context.supabase
    .from("lots")
    .select(LOT_SELECT, { count: "exact" })
    .eq("org_id", context.orgId)
    .eq("community_id", communityId)
  if (parsed.status) query = query.eq("status", parsed.status)
  if (parsed.phaseId) query = query.eq("community_phase_id", parsed.phaseId)
  if (parsed.search) {
    const safeSearch = parsed.search.replace(/[,%()]/g, " ").trim()
    if (safeSearch) query = query.or(`lot_number.ilike.%${safeSearch}%,address.ilike.%${safeSearch}%`)
  }
  const from = (parsed.page - 1) * parsed.pageSize
  const to = from + parsed.pageSize - 1
  const { data, error, count } = await query
    .order("block", { ascending: true, nullsFirst: true })
    .order("lot_number", { ascending: true })
    .range(from, to)
  if (error) throw new Error(`Failed to list lots: ${error.message}`)
  return {
    lots: (data ?? []).map((row) => mapLot(row as LotRow)),
    total: count ?? 0,
    page: parsed.page,
    pageSize: parsed.pageSize,
  }
}

export async function getLotStatusCounts(communityId: string, orgId?: string): Promise<Record<LotStatus, number>> {
  const context = await requireOrgContext(orgId)
  await requirePermission("community.read", context)
  await getCommunity(communityId, context.orgId)
  const results = await Promise.all(LOT_STATUSES.map((status) =>
    context.supabase.from("lots").select("id", { count: "exact", head: true }).eq("org_id", context.orgId).eq("community_id", communityId).eq("status", status),
  ))
  const output = Object.fromEntries(LOT_STATUSES.map((status) => [status, 0])) as Record<LotStatus, number>
  results.forEach((result, index) => {
    if (result.error) throw new Error(`Failed to count lots: ${result.error.message}`)
    output[LOT_STATUSES[index]] = result.count ?? 0
  })
  return output
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
  const community = await getCommunity(communityId, context.orgId)
  for (const lot of parsed.lots) {
    await assertCommunityRelations(context.supabase, context.orgId, communityId, lot)
    if (lot.status === "started") throw new Error("A new lot cannot start without an attached project.")
  }
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

export async function updateLot(id: string, input: Partial<LotUpdateInput>, orgId?: string): Promise<LotDTO> {
  const parsed = lotUpdateSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("lot.write", context)
  const before = await getLotById(context.supabase, context.orgId, id)
  await getCommunity(before.community_id, context.orgId)
  await assertCommunityRelations(context.supabase, context.orgId, before.community_id, parsed)
  if (parsed.status) assertLotStatusTransition({ from: before.status, to: parsed.status, hasProject: Boolean(before.project_id) })
  const { data, error } = await context.supabase.from("lots").update(lotPayload(parsed)).eq("org_id", context.orgId).eq("id", id).select(LOT_SELECT).single()
  if (error) throw new Error(`Failed to update lot: ${error.message}`)
  await logLotMutation({ orgId: context.orgId, userId: context.userId, eventType: "lot.updated", entityId: id, action: "update", before, after: data, payload: { community_id: before.community_id, lot_number: data.lot_number } })
  return mapLot(data as LotRow)
}

export async function bulkUpdateLots(
  communityId: string,
  input: { lotIds: string[]; patch: Partial<Pick<LotUpdateInput, "status" | "phaseId" | "takedownId" | "premiumCents" | "swing">> },
  orgId?: string,
): Promise<{ updated: number }> {
  const parsed = bulkLotPatchSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("lot.write", context)
  await getCommunity(communityId, context.orgId)
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
  await getCommunity(before.community_id, context.orgId)
  assertLotStatusTransition({ from: before.status, to: parsed.status, hasProject: Boolean(before.project_id), force: parsed.force })
  const { data, error } = await context.supabase.from("lots").update({ status: parsed.status }).eq("org_id", context.orgId).eq("id", id).select(LOT_SELECT).single()
  if (error) throw new Error(`Failed to set lot status: ${error.message}`)
  await logLotMutation({ orgId: context.orgId, userId: context.userId, eventType: "lot.status_changed", entityId: id, action: "update", before, after: data, payload: { community_id: before.community_id, from: before.status, to: parsed.status, force: parsed.force } })
  return mapLot(data as LotRow)
}

export async function attachProjectToLot(lotId: string, projectId: string, orgId?: string): Promise<LotDTO> {
  const context = await requireOrgContext(orgId)
  await Promise.all([requirePermission("lot.write", context), requirePermission("project.manage", context)])
  const before = await getLotById(context.supabase, context.orgId, lotId)
  await getCommunity(before.community_id, context.orgId)
  if (before.project_id && before.project_id !== projectId) throw new Error("This lot already has a project attached.")
  const { data: project, error: projectError } = await context.supabase.from("projects").select("id, org_id, name, property_type, division_id").eq("org_id", context.orgId).eq("id", projectId).maybeSingle()
  if (projectError || !project) throw new Error("Project not found")
  if (project.property_type && project.property_type !== "production") throw new Error("Only production-posture projects can be attached to lots.")
  const { data: existingLink, error: linkError } = await context.supabase.from("lots").select("id").eq("org_id", context.orgId).eq("project_id", projectId).neq("id", lotId).maybeSingle()
  if (linkError) throw new Error(`Failed to validate project link: ${linkError.message}`)
  if (existingLink) throw new Error("This project is already attached to another lot.")
  const { error: projectUpdateError } = await context.supabase.from("projects").update({ property_type: "production", division_id: before.division_id }).eq("org_id", context.orgId).eq("id", projectId)
  if (projectUpdateError) throw new Error(`Failed to prepare project: ${projectUpdateError.message}`)
  const { data, error } = await context.supabase.from("lots").update({ project_id: projectId, status: "started" }).eq("org_id", context.orgId).eq("id", lotId).select(LOT_SELECT).single()
  if (error) throw new Error(`Failed to attach project: ${error.message}`)
  await logLotMutation({ orgId: context.orgId, userId: context.userId, eventType: "lot.project_attached", entityId: lotId, action: "update", before, after: data, payload: { community_id: before.community_id, project_id: projectId, project_name: project.name } })
  return mapLot(data as LotRow)
}

export async function detachProjectFromLot(lotId: string, orgId?: string): Promise<LotDTO> {
  const context = await requireOrgContext(orgId)
  await Promise.all([requirePermission("lot.write", context), requirePermission("project.manage", context)])
  const before = await getLotById(context.supabase, context.orgId, lotId)
  await getCommunity(before.community_id, context.orgId)
  if (!before.project_id) throw new Error("This lot does not have a project attached.")
  const { error: projectError } = await context.supabase.from("projects").update({ division_id: null }).eq("org_id", context.orgId).eq("id", before.project_id).eq("division_id", before.division_id)
  if (projectError) throw new Error(`Failed to clear project division: ${projectError.message}`)
  const { data, error } = await context.supabase.from("lots").update({ project_id: null, status: "assigned" }).eq("org_id", context.orgId).eq("id", lotId).select(LOT_SELECT).single()
  if (error) throw new Error(`Failed to detach project: ${error.message}`)
  await logLotMutation({ orgId: context.orgId, userId: context.userId, eventType: "lot.project_detached", entityId: lotId, action: "update", before, after: data, payload: { community_id: before.community_id, project_id: before.project_id } })
  return mapLot(data as LotRow)
}

export async function deleteLot(id: string, orgId?: string): Promise<void> {
  const context = await requireOrgContext(orgId)
  await requirePermission("lot.write", context)
  const before = await getLotById(context.supabase, context.orgId, id)
  await getCommunity(before.community_id, context.orgId)
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

export async function listLinkedLotProjectIds(orgId?: string): Promise<string[]> {
  const context = await requireOrgContext(orgId)
  await requirePermission("community.read", context)
  const { data, error } = await context.supabase
    .from("lots")
    .select("project_id")
    .eq("org_id", context.orgId)
    .not("project_id", "is", null)
  if (error) throw new Error(`Failed to resolve linked lot projects: ${error.message}`)
  return (data ?? []).map((row) => row.project_id as string).filter(Boolean)
}
