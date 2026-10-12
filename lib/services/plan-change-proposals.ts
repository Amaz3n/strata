import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import type { PlanTakeoffPricingLine } from "@/lib/financials/plan-pricing"
import { readAllRowsById } from "@/lib/land/paging"
import {
  adoptionPath,
  allowedDecisions,
  classifyAffectedHome,
  homeCostDelta,
  isFinalDecision,
  reviewIsDecided,
  type AdoptionDecision,
  type AdoptionPath,
  type AffectedHomeState,
  type AgreementStanding,
} from "@/lib/plans/plan-change-impact"
import { LIVE_RESERVATION_STATUSES, liveReservationOrFilter } from "@/lib/sales/live-reservation"
import { recordAudit } from "@/lib/services/audit"
import { requireAuthorization } from "@/lib/services/authorization"
import { createChangeOrder, deleteChangeOrder } from "@/lib/services/change-orders"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { assertLotCanAdoptPlanVersion, writeLotPlanVersion } from "@/lib/services/lots"
import { requirePermission } from "@/lib/services/permissions"
import { createVarianceOrdersForSelectionChange, type VarianceOrderSubject } from "@/lib/services/selection-change-orders"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { changeOrderInputSchema } from "@/lib/validation/change-orders"
import {
  createPlanChangeProposalSchema,
  decidePlanChangeHomeSchema,
  type CreatePlanChangeProposalInput,
  type DecidePlanChangeHomeInput,
} from "@/lib/validation/plan-change-proposals"

/**
 * Rolling a plan change out to the homes that already carry the plan.
 *
 * A review lists every home pinned to an older version of a plan when it is
 * opened — unsold lots, spec homes, contracted homes and released ones — with
 * the cost of moving each to the new version. Someone holding plan.adopt then
 * decides home by home. What an adoption does is decided by the home's state
 * (`adoptionPath`, lib/plans/plan-change-impact.ts): an unsold lot or spec home
 * re-pins under the same rules as any pin; a sold home gets a draft change order
 * and moves only when that change order executes
 * (`applyPlanAdoptionFromChangeOrder`), because its agreement is locked; a
 * released home's change order also raises draft variance orders. A signed
 * agreement is never edited here.
 *
 * Plans is the workbench: every mutation lives here and is called from the plan
 * page. Desks may read a review, never decide one.
 */

/** A review names every affected home or none: a partial list would decide for the rest by silence. */
export const PLAN_CHANGE_HOME_CAP = 1_000
const ID_CHUNK = 100

type Context = Awaited<ReturnType<typeof requireOrgContext>>

export type PlanChangeProposalStatus = "draft" | "in_review" | "decided" | "withdrawn"

export type PlanChangeHomeDto = {
  id: string
  lotId: string
  lotLabel: string
  communityName: string | null
  projectId: string | null
  projectName: string | null
  buyerName: string | null
  /** The home's state when the review opened. */
  state: AffectedHomeState
  /** Its state now, which is what an adoption acts on. */
  currentState: AffectedHomeState
  fromVersionNumber: number | null
  costDeltaCents: number
  priceDeltaCents: number
  decision: AdoptionDecision
  decidedAt: string | null
  reason: string | null
  changeOrderId: string | null
  adoptedAt: string | null
  allowedDecisions: AdoptionDecision[]
  path: AdoptionPath
}

export type PlanChangeProposalDto = {
  id: string
  planId: string
  toVersionId: string
  toVersionNumber: number
  toVersionReleased: boolean
  status: PlanChangeProposalStatus
  summary: string | null
  createdAt: string
  submittedAt: string | null
  decidedAt: string | null
  homes: PlanChangeHomeDto[]
}

/** A nullable column; an absent one reads as null. */
const nullableText = z.string().nullish().transform((value) => value ?? null)

const proposalRowSchema = z.object({
  id: z.string(),
  house_plan_id: z.string(),
  to_version_id: z.string(),
  status: z.enum(["draft", "in_review", "decided", "withdrawn"]),
  summary: nullableText,
  created_at: z.string(),
  submitted_at: nullableText,
  decided_at: nullableText,
})
const PROPOSAL_COLUMNS = "id, house_plan_id, to_version_id, status, summary, created_at, submitted_at, decided_at"

const homeRowSchema = z.object({
  id: z.string(),
  proposal_id: z.string(),
  lot_id: z.string(),
  project_id: nullableText,
  from_version_id: z.string(),
  home_state: z.enum(["unsold", "spec", "contracted", "released"]),
  cost_delta_cents: z.coerce.number(),
  price_delta_cents: z.coerce.number(),
  decision: z.enum(["pending", "adopt", "decline", "defer"]),
  decided_at: nullableText,
  reason: nullableText,
  change_order_id: nullableText,
  adopted_at: nullableText,
})
type HomeRow = z.infer<typeof homeRowSchema>
const HOME_COLUMNS = "id, proposal_id, lot_id, project_id, from_version_id, home_state, cost_delta_cents, price_delta_cents, decision, decided_at, reason, change_order_id, adopted_at"

type VersionRow = { id: string; house_plan_id: string; version_number: number; status: "draft" | "released" | "superseded" }
type LotRow = {
  id: string
  lot_number: string
  block: string | null
  community_id: string
  project_id: string | null
  house_plan_version_id: string | null
  house_plan_elevation_id: string | null
  status: string
}
type HomeFacts = { state: AffectedHomeState; agreement: AgreementStanding; held: boolean }

function chunks(ids: readonly string[]): string[][] {
  const unique = [...new Set(ids)]
  const out: string[][] = []
  for (let offset = 0; offset < unique.length; offset += ID_CHUNK) out.push(unique.slice(offset, offset + ID_CHUNK))
  return out
}

/** Every row for an id list, chunked so the URL stays short. */
async function readByIds<Row>(ids: readonly string[], read: (chunk: string[]) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>, label: string): Promise<Row[]> {
  const results = await Promise.all(chunks(ids).map(async (chunk) => {
    const { data, error } = await read(chunk)
    if (error) throw new Error(`${label}: ${error.message}`)
    return data ?? []
  }))
  return results.flat()
}

async function readPlanVersions(supabase: SupabaseClient, orgId: string, planId: string): Promise<VersionRow[]> {
  const { data, error } = await supabase.from("house_plan_versions").select("id, house_plan_id, version_number, status")
    .eq("org_id", orgId).eq("house_plan_id", planId).order("version_number").limit(500)
  if (error) throw new Error(`Failed to load plan versions: ${error.message}`)
  return (data ?? []).map((row) => ({ ...row, version_number: Number(row.version_number) })) as VersionRow[]
}

/** A takeoff is a money total; a cut-off read is a wrong delta, so read all of it or refuse. */
const TAKEOFF_ROW_CAP = 50_000

async function readTakeoffLines(supabase: SupabaseClient, orgId: string, versionIds: readonly string[]) {
  const rows = await readAllRowsById<PlanTakeoffPricingLine & { house_plan_version_id: string }>((afterId, limit) => {
    let query = supabase.from("house_plan_takeoff_lines")
      .select("id, house_plan_version_id, elevation_id, cost_code_id, cost_type, description, quantity, uom, unit_cost_cents, sort_order")
      .eq("org_id", orgId).in("house_plan_version_id", [...versionIds])
    if (afterId) query = query.gt("id", afterId)
    return query.order("id").limit(limit)
  }, { cap: TAKEOFF_ROW_CAP, label: "Failed to load plan takeoffs", pageSize: 1000 })
  const byVersion = new Map<string, PlanTakeoffPricingLine[]>()
  for (const row of rows) {
    const line = { ...row, quantity: Number(row.quantity), unit_cost_cents: row.unit_cost_cents == null ? null : Number(row.unit_cost_cents), sort_order: Number(row.sort_order) }
    byVersion.set(row.house_plan_version_id, [...(byVersion.get(row.house_plan_version_id) ?? []), line])
  }
  return byVersion
}

/**
 * Where each lot's home stands today: whether a start was released, whether a
 * purchase agreement binds it or is being written, whether a buyer holds the
 * lot. One read per kind for the whole set.
 */
async function readHomeFacts(supabase: SupabaseClient, orgId: string, lots: ReadonlyArray<Pick<LotRow, "id" | "project_id">>): Promise<Map<string, HomeFacts>> {
  const lotIds = lots.map((lot) => lot.id)
  const projectIds = lots.flatMap((lot) => (lot.project_id ? [lot.project_id] : []))
  const [releases, contracts, holds] = await Promise.all([
    readByIds<{ lot_id: string }>(lotIds, (chunk) => supabase.from("start_packages").select("lot_id")
      .eq("org_id", orgId).eq("status", "released").in("lot_id", chunk), "Failed to read start releases"),
    readByIds<{ project_id: string; status: string; signed_at: string | null }>(projectIds, (chunk) => supabase.from("contracts").select("project_id, status, signed_at")
      .eq("org_id", orgId).eq("contract_type", "purchase_agreement").in("status", ["draft", "active"]).in("project_id", chunk), "Failed to read purchase agreements"),
    readByIds<{ lot_id: string }>(lotIds, (chunk) => supabase.from("lot_reservations").select("lot_id")
      .eq("org_id", orgId).in("lot_id", chunk).in("status", LIVE_RESERVATION_STATUSES).or(liveReservationOrFilter()), "Failed to read lot holds"),
  ])
  const released = new Set(releases.map((row) => row.lot_id))
  const held = new Set(holds.map((row) => row.lot_id))
  const agreementByProject = new Map<string, AgreementStanding>()
  for (const contract of contracts) {
    const standing: AgreementStanding = contract.status === "active" || contract.signed_at ? "binding" : "draft"
    if (agreementByProject.get(contract.project_id) !== "binding") agreementByProject.set(contract.project_id, standing)
  }
  return new Map(lots.map((lot) => {
    const agreement = lot.project_id ? agreementByProject.get(lot.project_id) ?? "none" : "none"
    return [lot.id, {
      state: classifyAffectedHome({ hasHome: Boolean(lot.project_id), agreement, startReleased: released.has(lot.id) }),
      agreement,
      held: held.has(lot.id),
    }]
  }))
}

async function logProposal(context: { orgId: string; userId: string | null }, input: {
  eventType: string
  entityType: "plan_change_proposal" | "plan_change_proposal_home"
  entityId: string
  action: "insert" | "update"
  before?: Record<string, unknown> | null
  after: Record<string, unknown>
  payload: Record<string, unknown>
}) {
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: input.eventType, entityType: input.entityType, entityId: input.entityId, payload: input.payload }),
    recordAudit({ orgId: context.orgId, actorId: context.userId ?? undefined, action: input.action, entityType: input.entityType, entityId: input.entityId, before: input.before, after: input.after }),
  ])
}

async function loadProposal(context: Context, proposalId: string) {
  const { data, error } = await context.supabase.from("plan_change_proposals").select(PROPOSAL_COLUMNS)
    .eq("org_id", context.orgId).eq("id", proposalId).maybeSingle()
  if (error) throw new Error(`Failed to load the plan change review: ${error.message}`)
  if (!data) throw new Error("Plan change review not found")
  return proposalRowSchema.parse(data)
}

async function hydrateProposal(context: Context, proposal: z.infer<typeof proposalRowSchema>): Promise<PlanChangeProposalDto> {
  const [versions, homeResult] = await Promise.all([
    readPlanVersions(context.supabase, context.orgId, proposal.house_plan_id),
    context.supabase.from("plan_change_proposal_homes").select(HOME_COLUMNS)
      .eq("org_id", context.orgId).eq("proposal_id", proposal.id).order("id").limit(PLAN_CHANGE_HOME_CAP),
  ])
  if (homeResult.error) throw new Error(`Failed to load the homes under review: ${homeResult.error.message}`)
  const homes = z.array(homeRowSchema).parse(homeResult.data ?? [])
  const toVersion = versions.find((version) => version.id === proposal.to_version_id)
  if (!toVersion) throw new Error("The version under review no longer exists")

  const lots = await readByIds<LotRow>(homes.map((home) => home.lot_id), (chunk) => context.supabase.from("lots")
    .select("id, lot_number, block, community_id, project_id, house_plan_version_id, house_plan_elevation_id, status")
    .eq("org_id", context.orgId).in("id", chunk), "Failed to load the lots under review")
  const lotById = new Map(lots.map((lot) => [lot.id, lot]))
  const projectIds = homes.flatMap((home) => (home.project_id ? [home.project_id] : []))
  const [communities, projects, facts] = await Promise.all([
    readByIds<{ id: string; name: string }>(lots.map((lot) => lot.community_id), (chunk) => context.supabase.from("communities").select("id, name")
      .eq("org_id", context.orgId).in("id", chunk), "Failed to load communities"),
    readByIds<{ id: string; name: string; client_id: string | null }>(projectIds, (chunk) => context.supabase.from("projects").select("id, name, client_id")
      .eq("org_id", context.orgId).in("id", chunk), "Failed to load homes"),
    readHomeFacts(context.supabase, context.orgId, lots),
  ])
  const buyers = await readByIds<{ id: string; full_name: string | null }>(projects.flatMap((project) => (project.client_id ? [project.client_id] : [])),
    (chunk) => context.supabase.from("contacts").select("id, full_name").eq("org_id", context.orgId).in("id", chunk), "Failed to load buyers")
  const communityName = new Map(communities.map((row) => [row.id, row.name]))
  const projectById = new Map(projects.map((row) => [row.id, row]))
  const buyerName = new Map(buyers.map((row) => [row.id, row.full_name]))
  const versionNumber = new Map(versions.map((version) => [version.id, version.version_number]))

  return {
    id: proposal.id,
    planId: proposal.house_plan_id,
    toVersionId: proposal.to_version_id,
    toVersionNumber: toVersion.version_number,
    toVersionReleased: toVersion.status === "released",
    status: proposal.status,
    summary: proposal.summary,
    createdAt: proposal.created_at,
    submittedAt: proposal.submitted_at,
    decidedAt: proposal.decided_at,
    homes: homes.map((home): PlanChangeHomeDto => {
      const lot = lotById.get(home.lot_id)
      const fact = facts.get(home.lot_id)
      if (!lot || !fact) throw new Error("A lot under review could not be read")
      const project = home.project_id ? projectById.get(home.project_id) : undefined
      return {
        id: home.id,
        lotId: home.lot_id,
        lotLabel: lot.block ? `${lot.block}-${lot.lot_number}` : lot.lot_number,
        communityName: communityName.get(lot.community_id) ?? null,
        projectId: home.project_id,
        projectName: project?.name ?? null,
        buyerName: project?.client_id ? buyerName.get(project.client_id) ?? null : null,
        state: home.home_state,
        currentState: fact.state,
        fromVersionNumber: versionNumber.get(home.from_version_id) ?? null,
        costDeltaCents: home.cost_delta_cents,
        priceDeltaCents: home.price_delta_cents,
        decision: home.decision,
        decidedAt: home.decided_at,
        reason: home.reason,
        changeOrderId: home.change_order_id,
        adoptedAt: home.adopted_at,
        allowedDecisions: allowedDecisions(fact.state),
        path: adoptionPath({ state: fact.state, agreement: fact.agreement, held: fact.held, toVersionNumber: toVersion.version_number, toVersionReleased: toVersion.status === "released" }),
      }
    }).sort((a, b) => (a.communityName ?? "").localeCompare(b.communityName ?? "") || a.lotLabel.localeCompare(b.lotLabel, undefined, { numeric: true })),
  }
}

/** The plan's open review, else its most recent one; null when the plan has never been reviewed. */
export async function getPlanChangeReview(planId: string, orgId?: string): Promise<PlanChangeProposalDto | null> {
  const context = await requireOrgContext(orgId)
  await requirePermission("plan.read", context)
  const { data, error } = await context.supabase.from("plan_change_proposals").select(PROPOSAL_COLUMNS)
    .eq("org_id", context.orgId).eq("house_plan_id", z.string().uuid().parse(planId)).neq("status", "withdrawn")
    .order("created_at", { ascending: false }).limit(5)
  if (error) throw new Error(`Failed to load plan change reviews: ${error.message}`)
  const proposals = z.array(proposalRowSchema).parse(data ?? [])
  const proposal = proposals.find((row) => row.status === "draft" || row.status === "in_review") ?? proposals[0]
  return proposal ? hydrateProposal(context, proposal) : null
}

/**
 * Open a review of moving the plan's homes onto `toVersionId` — the released
 * version, or a draft whose impact you want to see before releasing it. Lists
 * every home whose lot is pinned to an older version, with its state and the
 * takeoff cost of moving it.
 */
export async function createPlanChangeProposal(input: CreatePlanChangeProposalInput, orgId?: string): Promise<PlanChangeProposalDto> {
  const parsed = createPlanChangeProposalSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("plan.write", context)

  const versions = await readPlanVersions(context.supabase, context.orgId, parsed.planId)
  const toVersion = versions.find((version) => version.id === parsed.toVersionId)
  if (!toVersion) throw new Error("Plan version not found")
  if (toVersion.status === "superseded") throw new Error("A superseded version cannot be adopted. Review against the current release.")
  const olderVersionIds = versions.filter((version) => version.version_number < toVersion.version_number && version.status !== "draft").map((version) => version.id)
  if (olderVersionIds.length === 0) throw new Error("No earlier released version of this plan exists.")

  const lots = (await readAllRowsById<LotRow>((afterId, limit) => {
    let query = context.supabase.from("lots")
      .select("id, lot_number, block, community_id, project_id, house_plan_version_id, house_plan_elevation_id, status")
      .eq("org_id", context.orgId).eq("house_plan_id", parsed.planId).in("house_plan_version_id", olderVersionIds).neq("status", "closed")
    if (afterId) query = query.gt("id", afterId)
    return query.order("id").limit(limit)
  }, { cap: PLAN_CHANGE_HOME_CAP, label: "Too many homes are pinned to earlier versions of this plan to review at once", pageSize: 500 }))
  if (lots.length === 0) throw new Error("No home is pinned to an earlier version of this plan.")

  const [facts, takeoffs] = await Promise.all([
    readHomeFacts(context.supabase, context.orgId, lots),
    readTakeoffLines(context.supabase, context.orgId, [...olderVersionIds, toVersion.id]),
  ])
  const toLines = takeoffs.get(toVersion.id) ?? []

  const { data: created, error } = await context.supabase.from("plan_change_proposals").insert({
    org_id: context.orgId,
    house_plan_id: parsed.planId,
    to_version_id: toVersion.id,
    status: "draft",
    summary: parsed.summary || null,
    created_by: context.userId,
    created_at: new Date().toISOString(),
  }).select(PROPOSAL_COLUMNS).single()
  if (error?.code === "23505") throw new Error("A plan change review is already open for this plan. Finish or withdraw it first.")
  if (error || !created) throw new Error(`Failed to open the plan change review: ${error?.message ?? "no row returned"}`)
  const proposal = proposalRowSchema.parse(created)

  const homes = lots.map((lot) => {
    const fromVersionId = lot.house_plan_version_id ?? ""
    return {
      org_id: context.orgId,
      proposal_id: proposal.id,
      lot_id: lot.id,
      project_id: lot.project_id,
      from_version_id: fromVersionId,
      home_state: facts.get(lot.id)?.state ?? "unsold",
      cost_delta_cents: homeCostDelta(takeoffs.get(fromVersionId) ?? [], toLines, lot.house_plan_elevation_id).costDeltaCents,
      price_delta_cents: 0,
      decision: "pending",
    }
  })
  const { error: homesError } = await context.supabase.from("plan_change_proposal_homes").insert(homes)
  if (homesError) {
    // The review is useless without its homes; leave no empty review blocking the next one.
    await context.supabase.from("plan_change_proposals").update({ status: "withdrawn" }).eq("org_id", context.orgId).eq("id", proposal.id)
    throw new Error(`Failed to list the homes under review: ${homesError.message}`)
  }

  const counts = Object.fromEntries((["unsold", "spec", "contracted", "released"] as const).map((state) => [state, homes.filter((home) => home.home_state === state).length]))
  await logProposal(context, {
    eventType: "plan_change_proposal.created", entityType: "plan_change_proposal", entityId: proposal.id, action: "insert",
    after: { ...proposal, home_count: homes.length },
    payload: { house_plan_id: parsed.planId, to_version_id: toVersion.id, to_version_number: toVersion.version_number, home_count: homes.length, by_state: counts },
  })
  return hydrateProposal(context, proposal)
}

async function transitionProposal(context: Context, proposalId: string, from: PlanChangeProposalStatus[], patch: Record<string, unknown>, eventType: string) {
  const before = await loadProposal(context, proposalId)
  if (!from.includes(before.status)) throw new Error(`This review is ${before.status.replace("_", " ")}.`)
  const { data, error } = await context.supabase.from("plan_change_proposals").update(patch)
    .eq("org_id", context.orgId).eq("id", proposalId).eq("status", before.status).select(PROPOSAL_COLUMNS).maybeSingle()
  if (error) throw new Error(`Failed to update the plan change review: ${error.message}`)
  if (!data) throw new Error("The review changed while you were updating it. Reload and try again.")
  const after = proposalRowSchema.parse(data)
  await logProposal(context, {
    eventType, entityType: "plan_change_proposal", entityId: proposalId, action: "update", before, after,
    payload: { house_plan_id: after.house_plan_id, from_status: before.status, status: after.status },
  })
  return after
}

/** Hand a drafted review to the people who decide it. */
export async function submitPlanChangeProposal(proposalId: string, orgId?: string): Promise<PlanChangeProposalDto> {
  const context = await requireOrgContext(orgId)
  await requirePermission("plan.write", context)
  const after = await transitionProposal(context, z.string().uuid().parse(proposalId), ["draft"], { status: "in_review", submitted_at: new Date().toISOString() }, "plan_change_proposal.submitted")
  return hydrateProposal(context, after)
}

/** Abandon a review nobody has ruled on yet. A decided home stays decided, so a review with one cannot be withdrawn. */
export async function withdrawPlanChangeProposal(proposalId: string, orgId?: string): Promise<void> {
  const context = await requireOrgContext(orgId)
  await requirePermission("plan.write", context)
  const id = z.string().uuid().parse(proposalId)
  const { data, error } = await context.supabase.from("plan_change_proposal_homes").select("id")
    .eq("org_id", context.orgId).eq("proposal_id", id).in("decision", ["adopt", "decline"]).limit(1)
  if (error) throw new Error(`Failed to check the review's decisions: ${error.message}`)
  if ((data ?? []).length > 0) throw new Error("Homes in this review have been decided. Defer the rest instead of withdrawing it.")
  await transitionProposal(context, id, ["draft", "in_review"], { status: "withdrawn" }, "plan_change_proposal.withdrawn")
}

/** The note a buyer reads on the amendment. */
function amendmentLines(input: { planCode: string; fromNumber: number | null; toNumber: number; priceDeltaCents: number; costDeltaCents: number }) {
  return [{
    description: `Plan ${input.planCode} revised from v${input.fromNumber ?? "—"} to v${input.toNumber}`,
    quantity: 1,
    unit: "ls",
    unit_cost: input.priceDeltaCents / 100,
    internal_cost_cents: input.costDeltaCents,
    allowance: 0,
    taxable: true,
    gmp_classification: "inside_gmp" as const,
    gmp_impact: "none" as const,
  }]
}

const planAdoptionSchema = z.object({
  proposal_home_id: z.string(),
  lot_id: z.string(),
  from_version_id: z.string(),
  to_version_id: z.string(),
  label: z.string(),
  variance_orders: z.boolean(),
  cost_by_code: z.array(z.object({ cost_code_id: z.string(), cost_delta_cents: z.number().int() })),
})

/**
 * Record one home's decision. Adopting executes the home's path at once: an
 * unsold or spec home re-pins; a sold or released home gets a draft change
 * order carrying the price amendment and moves when it executes. Declining a
 * sold home keeps it on the version it was sold at, and lets it start there.
 */
export async function decidePlanChangeHome(input: DecidePlanChangeHomeInput, orgId?: string): Promise<PlanChangeProposalDto> {
  const parsed = decidePlanChangeHomeSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("plan.adopt", context)

  const { data: homeData, error: homeError } = await context.supabase.from("plan_change_proposal_homes").select(HOME_COLUMNS)
    .eq("org_id", context.orgId).eq("id", parsed.proposalHomeId).maybeSingle()
  if (homeError) throw new Error(`Failed to load the home under review: ${homeError.message}`)
  if (!homeData) throw new Error("Home not found in this review")
  const home = homeRowSchema.parse(homeData)
  if (home.project_id) {
    await requireAuthorization({ permission: "plan.adopt", userId: context.userId, orgId: context.orgId, projectId: home.project_id, supabase: context.supabase })
  }
  const proposal = await loadProposal(context, home.proposal_id)
  if (proposal.status !== "in_review") throw new Error(proposal.status === "draft" ? "Submit the review before deciding homes." : `This review is ${proposal.status}.`)
  if (isFinalDecision(home.decision)) throw new Error("This home's decision is final.")

  const [versions, lotResult] = await Promise.all([
    readPlanVersions(context.supabase, context.orgId, proposal.house_plan_id),
    context.supabase.from("lots").select("id, project_id, house_plan_version_id, house_plan_elevation_id")
      .eq("org_id", context.orgId).eq("id", home.lot_id).maybeSingle(),
  ])
  if (lotResult.error || !lotResult.data) throw new Error("Lot not found")
  const lot = lotResult.data
  if (lot.house_plan_version_id !== home.from_version_id) throw new Error("This home's plan changed since the review opened. Reopen the review.")
  const facts = (await readHomeFacts(context.supabase, context.orgId, [{ id: lot.id, project_id: lot.project_id }])).get(lot.id)
  if (!facts) throw new Error("Lot not found")
  if (!allowedDecisions(facts.state).includes(parsed.decision)) {
    throw new Error("A home that is not sold yet is sold on the current edition. Adopt it or defer it.")
  }
  const toVersion = versions.find((version) => version.id === proposal.to_version_id)
  const fromVersion = versions.find((version) => version.id === home.from_version_id)
  if (!toVersion) throw new Error("The version under review no longer exists")

  const now = new Date().toISOString()
  const patch: Record<string, unknown> = { decision: parsed.decision, decided_by: context.userId, decided_at: now, reason: parsed.reason || null }

  if (parsed.decision === "adopt") {
    const path = adoptionPath({ state: facts.state, agreement: facts.agreement, held: facts.held, toVersionNumber: toVersion.version_number, toVersionReleased: toVersion.status === "released" })
    if (path.kind === "blocked") throw new Error(path.reason)
    await assertLotCanAdoptPlanVersion(context, { lotId: lot.id, fromVersionId: home.from_version_id, toVersionId: toVersion.id })
    if (path.kind === "repin") {
      await writeLotPlanVersion({ ...context, actorId: context.userId }, { lotId: lot.id, fromVersionId: home.from_version_id, toVersionId: toVersion.id, source: "plan_change_proposal" })
      patch.adopted_at = now
    } else {
      if (!lot.project_id) throw new Error("This home has no project to amend.")
      const [planResult, takeoffs] = await Promise.all([
        context.supabase.from("house_plans").select("code").eq("org_id", context.orgId).eq("id", proposal.house_plan_id).maybeSingle(),
        readTakeoffLines(context.supabase, context.orgId, [home.from_version_id, toVersion.id]),
      ])
      if (planResult.error || !planResult.data) throw new Error("House plan not found")
      const planCode = String(planResult.data.code)
      const delta = homeCostDelta(takeoffs.get(home.from_version_id) ?? [], takeoffs.get(toVersion.id) ?? [], lot.house_plan_elevation_id ?? null)
      const priceDeltaCents = parsed.priceDeltaCents ?? home.price_delta_cents
      const label = `Plan ${planCode} v${fromVersion?.version_number ?? "—"} → v${toVersion.version_number}`
      const changeOrder = await createChangeOrder({
        orgId: context.orgId,
        input: changeOrderInputSchema.parse({
          project_id: lot.project_id,
          title: `Plan revision: ${label}`,
          summary: path.buyerSignature
            ? `Amends the purchase agreement to build to ${label}.`
            : `Builds this home to ${label}.`,
          description: parsed.reason || undefined,
          requires_signature: path.buyerSignature,
          zero_dollar: priceDeltaCents === 0,
          client_visible: false,
          lines: amendmentLines({ planCode, fromNumber: fromVersion?.version_number ?? null, toNumber: toVersion.version_number, priceDeltaCents, costDeltaCents: delta.costDeltaCents }),
        }),
      })
      const planAdoption: z.infer<typeof planAdoptionSchema> = {
        proposal_home_id: home.id,
        lot_id: lot.id,
        from_version_id: home.from_version_id,
        to_version_id: toVersion.id,
        label,
        variance_orders: path.varianceOrders,
        cost_by_code: delta.byCostCode.map((entry) => ({ cost_code_id: entry.costCodeId, cost_delta_cents: entry.costDeltaCents })),
      }
      const { error: linkError } = await context.supabase.from("change_orders")
        .update({ metadata: { ...(changeOrder.metadata ?? {}), plan_adoption: planAdoption } })
        .eq("org_id", context.orgId).eq("id", changeOrder.id)
      if (linkError) {
        await deleteChangeOrder({ changeOrderId: changeOrder.id, orgId: context.orgId })
        throw new Error(`Failed to attach the plan change to the change order: ${linkError.message}`)
      }
      patch.change_order_id = changeOrder.id
      patch.price_delta_cents = priceDeltaCents
    }
  }

  const { data: updated, error: updateError } = await context.supabase.from("plan_change_proposal_homes").update(patch)
    .eq("org_id", context.orgId).eq("id", home.id).eq("decision", home.decision).select(HOME_COLUMNS).maybeSingle()
  if (updateError || !updated) {
    if (typeof patch.change_order_id === "string") await deleteChangeOrder({ changeOrderId: patch.change_order_id, orgId: context.orgId })
    throw new Error(updateError ? `Failed to record the decision: ${updateError.message}` : "This home was decided while you were reviewing it. Reload and try again.")
  }
  const after = homeRowSchema.parse(updated)
  await logProposal(context, {
    eventType: `plan_change_proposal.home_${parsed.decision === "adopt" ? "adopted" : parsed.decision === "decline" ? "declined" : "deferred"}`,
    entityType: "plan_change_proposal_home", entityId: home.id, action: "update", before: home, after,
    payload: {
      proposal_id: proposal.id, house_plan_id: proposal.house_plan_id, lot_id: home.lot_id, project_id: home.project_id,
      home_state: facts.state, decision: parsed.decision, change_order_id: after.change_order_id, adopted: Boolean(after.adopted_at),
    },
  })

  const { data: remaining, error: remainingError } = await context.supabase.from("plan_change_proposal_homes").select("decision")
    .eq("org_id", context.orgId).eq("proposal_id", proposal.id).eq("decision", "pending").limit(1)
  if (remainingError) throw new Error(`Failed to check the review's remaining homes: ${remainingError.message}`)
  if (reviewIsDecided((remaining ?? []).map((row) => z.enum(["pending", "adopt", "decline", "defer"]).parse(row.decision)))) {
    await transitionProposal(context, proposal.id, ["in_review"], { status: "decided", decided_at: now, reviewed_by: context.userId }, "plan_change_proposal.decided")
  }
  return hydrateProposal(context, await loadProposal(context, proposal.id))
}

const PLAN_VARIANCE_SUBJECT: VarianceOrderSubject = {
  title: "Plan revision adopted",
  reasonCode: "plan_revision",
  reasonLabel: "Plan revision",
  source: "plan_change_proposal",
}

/**
 * The moment a sold home's adoption takes effect: its change order executed.
 * Runs from every change order approval path, as the service role (a buyer's
 * portal signature has no member session), and does nothing for a change
 * order that carries no plan adoption. Moves the lot's pin, raises the draft
 * variance orders a released home's purchase orders need, and marks the home
 * adopted. Idempotent: a re-delivered execution finds the home adopted.
 */
export async function applyPlanAdoptionFromChangeOrder(changeOrderId: string, orgId: string): Promise<{ adopted: boolean }> {
  const supabase = createServiceSupabaseClient()
  const { data: changeOrder, error } = await supabase.from("change_orders").select("id, org_id, project_id, metadata")
    .eq("org_id", orgId).eq("id", changeOrderId).maybeSingle()
  if (error || !changeOrder) throw new Error("Change order not found")
  const parsed = z.object({ plan_adoption: planAdoptionSchema }).safeParse(changeOrder.metadata)
  if (!parsed.success) return { adopted: false }
  const adoption = parsed.data.plan_adoption

  const { data: homeData, error: homeError } = await supabase.from("plan_change_proposal_homes").select(HOME_COLUMNS)
    .eq("org_id", orgId).eq("id", adoption.proposal_home_id).maybeSingle()
  if (homeError || !homeData) throw new Error("The plan change this change order adopts was not found")
  const home = homeRowSchema.parse(homeData)
  if (home.adopted_at) return { adopted: false }
  if (home.decision !== "adopt" || home.change_order_id !== changeOrder.id || home.lot_id !== adoption.lot_id) {
    throw new Error("This change order no longer matches the plan change it was raised for")
  }

  await writeLotPlanVersion({ supabase, orgId, actorId: null }, {
    lotId: adoption.lot_id, fromVersionId: adoption.from_version_id, toVersionId: adoption.to_version_id, source: "plan_change_change_order",
  })
  const variance = adoption.variance_orders
    ? await createVarianceOrdersForSelectionChange({
      orgId,
      projectId: changeOrder.project_id,
      changeOrderId: changeOrder.id,
      subject: PLAN_VARIANCE_SUBJECT,
      changes: adoption.cost_by_code.map((entry) => ({
        selection_id: home.id,
        cost_code_id: entry.cost_code_id,
        cost_delta_cents: entry.cost_delta_cents,
        category_name: adoption.label,
        option_name: "plan revision",
      })),
    })
    : null

  const adoptedAt = new Date().toISOString()
  const { error: adoptError } = await supabase.from("plan_change_proposal_homes").update({ adopted_at: adoptedAt })
    .eq("org_id", orgId).eq("id", home.id).is("adopted_at", null)
  if (adoptError) throw new Error(`Failed to record the adoption: ${adoptError.message}`)
  await logProposal({ orgId, userId: null }, {
    eventType: "plan_change_proposal.home_adoption_executed", entityType: "plan_change_proposal_home", entityId: home.id, action: "update",
    before: home, after: { ...home, adopted_at: adoptedAt },
    payload: { proposal_id: home.proposal_id, lot_id: home.lot_id, project_id: home.project_id, change_order_id: changeOrder.id, variance_orders: variance?.created ?? 0, unrouted_deltas: variance?.unrouted ?? 0 },
  })
  return { adopted: true }
}
