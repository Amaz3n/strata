import type { SupabaseClient } from "@supabase/supabase-js"

import { readLotDimensions, readSetbacks, storeSetbacks, type Setbacks } from "@/lib/land/lot-dimensions"
import {
  evaluateLotFit,
  LOT_FIT_VIOLATION_CODES,
  lotFitRefusal,
  overrideCoversFit,
  type Handing,
  type LotFitEvaluation,
  type LotFitViolation,
  type LotFitViolationCode,
  type LotSwing,
} from "@/lib/land/lot-fit"
import { recordAudit } from "@/lib/services/audit"
import { requireCommunityScope } from "@/lib/services/communities"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"
import { lotAllowedElevationsSchema, lotFitOverrideSchema, setbacksSchema, type LotFitOverrideInput, type SetbacksInput } from "@/lib/validation/lots"

/**
 * Loads what `evaluateLotFit` judges, and decides whether a recorded override
 * covers what it finds. Every path that puts a plan on a lot asks here:
 * `assignPlanToLot`, plan instantiation, agreement pricing, the start
 * package's plan gate and both importers. A refusal is an Error carrying the
 * violations in words; an `unknown` answer (unmeasured lot, plan with no
 * footprint) never blocks.
 */

type FitClient = { supabase: SupabaseClient; orgId: string }

/** One plan configuration on one lot (or on a lot an import is about to create). */
export interface LotFitPin {
  key: string
  /** Null for a lot an import has not created yet: it has no allowed elevations or overrides. */
  lotId: string | null
  communityId: string
  dimensions: Record<string, unknown> | null
  lotSwing: LotSwing
  planId: string
  elevationId: string | null
  swing: Handing | null
}

export interface LotFitOverrideDTO {
  id: string
  lotId: string
  housePlanId: string
  elevationId: string | null
  swing: Handing | null
  violationCodes: LotFitViolationCode[]
  reason: string
  evidenceFileId: string
  approvedBy: string
  approvedAt: string
}

export interface LotFitVerdict {
  /** The configuration judged. */
  housePlanId: string
  elevationId: string | null
  evaluation: LotFitEvaluation
  /** The live override that covers this configuration, if one does. */
  override: LotFitOverrideDTO | null
  /** Null when the home may stand here: it fits, it is unknown, or an override covers it. */
  refusal: string | null
}

type OverrideRow = {
  id: string
  lot_id: string
  house_plan_id: string
  house_plan_elevation_id: string | null
  swing: Handing | null
  violations: unknown
  reason: string
  evidence_file_id: string
  approved_by: string
  approved_at: string
}

const OVERRIDE_SELECT = "id, lot_id, house_plan_id, house_plan_elevation_id, swing, violations, reason, evidence_file_id, approved_by, approved_at"
const IN_CHUNK = 200

function isViolationCode(value: unknown): value is LotFitViolationCode {
  return LOT_FIT_VIOLATION_CODES.some((code) => code === value)
}

function mapOverride(row: OverrideRow): LotFitOverrideDTO {
  const violations = Array.isArray(row.violations) ? row.violations : []
  return {
    id: row.id,
    lotId: row.lot_id,
    housePlanId: row.house_plan_id,
    elevationId: row.house_plan_elevation_id,
    swing: row.swing,
    violationCodes: violations.flatMap((entry) => {
      const code = typeof entry === "object" && entry !== null && "code" in entry ? entry.code : null
      return isViolationCode(code) ? [code] : []
    }),
    reason: row.reason,
    evidenceFileId: row.evidence_file_id,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
  }
}

function chunks(ids: readonly string[]) {
  const unique = [...new Set(ids)]
  const out: string[][] = []
  for (let index = 0; index < unique.length; index += IN_CHUNK) out.push(unique.slice(index, index + IN_CHUNK))
  return out
}

async function readByIds<Row>(
  ids: readonly string[],
  read: (chunk: string[]) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>,
  label: string,
): Promise<Row[]> {
  const results = await Promise.all(chunks(ids).map((chunk) => read(chunk)))
  return results.flatMap((result) => {
    if (result.error) throw new Error(`${label}: ${result.error.message}`)
    return result.data ?? []
  })
}

function handing(value: unknown): Handing | null {
  return value === "left" || value === "right" ? value : null
}

function feetOrNull(value: unknown) {
  return value == null ? null : Number(value)
}

/** Judge many pins with one read per table, however many rows an import stages. */
export async function checkLotFits({ supabase, orgId }: FitClient, pins: readonly LotFitPin[]): Promise<Map<string, LotFitVerdict>> {
  const verdicts = new Map<string, LotFitVerdict>()
  if (pins.length === 0) return verdicts
  const lotIds = pins.flatMap((pin) => (pin.lotId ? [pin.lotId] : []))
  const elevationIds = pins.flatMap((pin) => (pin.elevationId ? [pin.elevationId] : []))
  const [plans, elevations, communities, allowed, overrides] = await Promise.all([
    readByIds<{ id: string; footprint_width_ft: number | string | null; footprint_depth_ft: number | string | null; drawn_swing: string | null }>(
      pins.map((pin) => pin.planId),
      (chunk) => supabase.from("house_plans").select("id, footprint_width_ft, footprint_depth_ft, drawn_swing").eq("org_id", orgId).in("id", chunk),
      "Failed to load plan footprints",
    ),
    readByIds<{ id: string; swing_applicable: boolean | null }>(
      elevationIds,
      (chunk) => supabase.from("house_plan_elevations").select("id, swing_applicable").eq("org_id", orgId).in("id", chunk),
      "Failed to load elevations",
    ),
    readByIds<{ id: string; setbacks: Record<string, unknown> | null }>(
      pins.map((pin) => pin.communityId),
      (chunk) => supabase.from("communities").select("id, setbacks").eq("org_id", orgId).in("id", chunk),
      "Failed to load community setbacks",
    ),
    readByIds<{ lot_id: string; house_plan_elevation_id: string }>(
      lotIds,
      (chunk) => supabase.from("lot_allowed_elevations").select("lot_id, house_plan_elevation_id").eq("org_id", orgId).in("lot_id", chunk),
      "Failed to load allowed elevations",
    ),
    readByIds<OverrideRow>(
      lotIds,
      (chunk) => supabase.from("lot_fit_overrides").select(OVERRIDE_SELECT).eq("org_id", orgId).in("lot_id", chunk).is("revoked_at", null),
      "Failed to load lot fit overrides",
    ),
  ])
  const planById = new Map(plans.map((plan) => [plan.id, plan]))
  const elevationById = new Map(elevations.map((elevation) => [elevation.id, elevation]))
  const setbacksByCommunity = new Map(communities.map((community) => [community.id, readSetbacks(community.setbacks)]))

  for (const pin of pins) {
    const plan = planById.get(pin.planId)
    const elevation = pin.elevationId ? elevationById.get(pin.elevationId) : undefined
    const evaluation = evaluateLotFit({
      lot: {
        dimensions: readLotDimensions(pin.dimensions),
        swing: pin.lotSwing,
        allowedElevationIds: allowed.filter((row) => row.lot_id === pin.lotId).map((row) => row.house_plan_elevation_id),
      },
      communitySetbacks: setbacksByCommunity.get(pin.communityId) ?? {},
      plan: {
        footprintWidthFt: feetOrNull(plan?.footprint_width_ft),
        footprintDepthFt: feetOrNull(plan?.footprint_depth_ft),
        drawnSwing: handing(plan?.drawn_swing),
      },
      elevation: pin.elevationId ? { id: pin.elevationId, swingApplicable: elevation?.swing_applicable !== false } : null,
      swing: pin.swing,
    })
    const current = { housePlanId: pin.planId, elevationId: pin.elevationId, swing: evaluation.swing, violations: evaluation.violations }
    const override = evaluation.violations.length === 0
      ? null
      : overrides
          .filter((row) => row.lot_id === pin.lotId)
          .map(mapOverride)
          .find((candidate) => overrideCoversFit(candidate, current)) ?? null
    verdicts.set(pin.key, {
      housePlanId: pin.planId,
      elevationId: pin.elevationId,
      evaluation,
      override,
      refusal: evaluation.violations.length > 0 && !override ? lotFitRefusal(evaluation.violations) : null,
    })
  }
  return verdicts
}

type LotFitRow = { id: string; community_id: string; dimensions: Record<string, unknown> | null; swing: LotSwing | null }

async function loadLotForFit({ supabase, orgId }: FitClient, lotId: string): Promise<LotFitRow> {
  const { data, error } = await supabase.from("lots").select("id, community_id, dimensions, swing").eq("org_id", orgId).eq("id", lotId).maybeSingle()
  if (error) throw new Error(`Failed to load the lot for its fit check: ${error.message}`)
  if (!data) throw new Error("Lot not found")
  return data
}

function pinFor(lot: LotFitRow, input: { planId: string; elevationId: string | null; swing: Handing | null }): LotFitPin {
  return {
    key: lot.id,
    lotId: lot.id,
    communityId: lot.community_id,
    dimensions: lot.dimensions,
    lotSwing: lot.swing ?? "either",
    planId: input.planId,
    elevationId: input.elevationId,
    swing: input.swing,
  }
}

/** The verdict for one configuration on an existing lot. */
export async function lotFitVerdict(
  client: FitClient,
  input: { lotId: string; planId: string; elevationId: string | null; swing: Handing | null },
): Promise<LotFitVerdict> {
  const lot = await loadLotForFit(client, input.lotId)
  const verdicts = await checkLotFits(client, [pinFor(lot, input)])
  const verdict = verdicts.get(lot.id)
  if (!verdict) throw new Error("The lot fit check returned no answer")
  return verdict
}

/** Refuse a configuration that does not fit unless a recorded override covers it. */
export async function assertLotFit(
  client: FitClient,
  input: { lotId: string; planId: string; elevationId: string | null; swing: Handing | null },
): Promise<LotFitVerdict> {
  const verdict = await lotFitVerdict(client, input)
  if (verdict.refusal) throw new Error(verdict.refusal)
  return verdict
}

type PinnedLotRow = LotFitRow & { house_plan_id: string | null; house_plan_elevation_id: string | null }

/**
 * Re-judge the homes pinned to these lots after their land changed. A home
 * that no longer fits is NOT unpinned — that would silently undo a sale or a
 * start — it is recorded (`lot.fit_violated`) and returned so the editor can
 * say so; the start gate and agreement pricing refuse it from here on.
 */
export async function reevaluatePinnedLotFits(
  context: FitClient & { userId: string },
  lotIds: readonly string[],
): Promise<Map<string, string>> {
  const lots = await readByIds<PinnedLotRow>(
    lotIds,
    (chunk) => context.supabase.from("lots").select("id, community_id, dimensions, swing, house_plan_id, house_plan_elevation_id")
      .eq("org_id", context.orgId).in("id", chunk).not("house_plan_id", "is", null),
    "Failed to load pinned homes",
  )
  const pins = lots.flatMap((lot) => lot.house_plan_id
    ? [pinFor(lot, { planId: lot.house_plan_id, elevationId: lot.house_plan_elevation_id, swing: null })]
    : [])
  const verdicts = await checkLotFits(context, pins)
  const refused = new Map<string, string>()
  await Promise.all(pins.map((pin) => {
    const verdict = verdicts.get(pin.key)
    if (!verdict?.refusal || !pin.lotId) return null
    refused.set(pin.lotId, verdict.refusal)
    return recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: "lot.fit_violated",
      entityType: "lot",
      entityId: pin.lotId,
      payload: {
        community_id: pin.communityId,
        house_plan_id: pin.planId,
        house_plan_elevation_id: pin.elevationId,
        violations: verdict.evaluation.violations.map((violation) => violation.code),
      },
    })
  }))
  return refused
}

// ---------------------------------------------------------------------------
// The lot workbench's fit surface.
// ---------------------------------------------------------------------------

async function scopedLot(context: Awaited<ReturnType<typeof requireOrgContext>>, lotId: string) {
  const { data, error } = await context.supabase.from("lots")
    .select("id, community_id, dimensions, swing, house_plan_id, house_plan_elevation_id")
    .eq("org_id", context.orgId).eq("id", lotId).maybeSingle()
  if (error || !data) throw new Error("Lot not found")
  const lot: PinnedLotRow = data
  await requireCommunityScope(lot.community_id, context)
  return lot
}

/**
 * The fit of the plan pinned to a lot, or of a configuration being considered
 * for it. Null when nothing is pinned and nothing was asked about.
 */
export async function getLotFit(
  lotId: string,
  input: { planId?: string; elevationId?: string | null; swing?: Handing | null } = {},
  orgId?: string,
): Promise<LotFitVerdict | null> {
  const context = await requireOrgContext(orgId)
  await requirePermission("community.read", context)
  const lot = await scopedLot(context, lotId)
  const planId = input.planId ?? lot.house_plan_id
  if (!planId) return null
  const elevationId = input.elevationId === undefined ? lot.house_plan_elevation_id : input.elevationId
  const verdicts = await checkLotFits(context, [pinFor(lot, { planId, elevationId, swing: input.swing ?? null })])
  return verdicts.get(lot.id) ?? null
}

/**
 * Let one configuration stand on a lot it does not fit. It takes
 * lot.fit_override, a reason and an evidence file (the plot plan, the
 * variance, the architectural approval), and speaks only for the plan,
 * elevation, handing and violations found now. A live override for the same
 * configuration is revoked by the new one rather than left beside it.
 */
export async function recordLotFitOverride(input: LotFitOverrideInput, orgId?: string): Promise<LotFitOverrideDTO> {
  const parsed = lotFitOverrideSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("lot.fit_override", context)
  const lot = await scopedLot(context, parsed.lotId)
  const [evidence, verdicts] = await Promise.all([
    context.supabase.from("files").select("id").eq("org_id", context.orgId).eq("id", parsed.evidenceFileId).maybeSingle(),
    checkLotFits(context, [pinFor(lot, { planId: parsed.housePlanId, elevationId: parsed.elevationId, swing: parsed.swing })]),
  ])
  if (evidence.error || !evidence.data) throw new Error("The evidence file was not found")
  const verdict = verdicts.get(lot.id)
  if (!verdict || verdict.evaluation.violations.length === 0) throw new Error("This configuration fits the lot; there is nothing to override.")
  const swing = verdict.evaluation.swing
  const violations: LotFitViolation[] = verdict.evaluation.violations

  let replaced = context.supabase.from("lot_fit_overrides")
    .update({ revoked_at: new Date().toISOString(), revoked_by: context.userId })
    .eq("org_id", context.orgId).eq("lot_id", lot.id).eq("house_plan_id", parsed.housePlanId).is("revoked_at", null)
  replaced = parsed.elevationId ? replaced.eq("house_plan_elevation_id", parsed.elevationId) : replaced.is("house_plan_elevation_id", null)
  replaced = swing ? replaced.eq("swing", swing) : replaced.is("swing", null)
  const { data: revoked, error: revokeError } = await replaced.select("id")
  if (revokeError) throw new Error(`Failed to replace the earlier override: ${revokeError.message}`)

  const { data, error } = await context.supabase.from("lot_fit_overrides").insert({
    org_id: context.orgId,
    lot_id: lot.id,
    house_plan_id: parsed.housePlanId,
    house_plan_elevation_id: parsed.elevationId,
    swing,
    violations,
    reason: parsed.reason,
    evidence_file_id: parsed.evidenceFileId,
    approved_by: context.userId,
  }).select(OVERRIDE_SELECT).single()
  if (error || !data) throw new Error(`Failed to record the fit override: ${error?.message ?? "no row returned"}`)
  const override = mapOverride(data)
  await Promise.all([
    recordEvent({
      orgId: context.orgId, actorId: context.userId, eventType: "lot.fit_overridden", entityType: "lot", entityId: lot.id,
      payload: { override_id: override.id, house_plan_id: override.housePlanId, house_plan_elevation_id: override.elevationId, swing, violations: override.violationCodes, evidence_file_id: override.evidenceFileId, replaced: (revoked ?? []).map((row) => row.id) },
    }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "lot_fit_override", entityId: override.id, after: data }),
  ])
  return override
}

export async function revokeLotFitOverride(overrideId: string, orgId?: string): Promise<void> {
  const context = await requireOrgContext(orgId)
  await requirePermission("lot.fit_override", context)
  const { data: before, error: readError } = await context.supabase.from("lot_fit_overrides").select(`${OVERRIDE_SELECT}, revoked_at`)
    .eq("org_id", context.orgId).eq("id", overrideId).maybeSingle()
  if (readError || !before) throw new Error("Fit override not found")
  const lot = await scopedLot(context, before.lot_id)
  if (before.revoked_at) throw new Error("This override was already revoked")
  const { data, error } = await context.supabase.from("lot_fit_overrides")
    .update({ revoked_at: new Date().toISOString(), revoked_by: context.userId })
    .eq("org_id", context.orgId).eq("id", overrideId).is("revoked_at", null).select("id, revoked_at, revoked_by").maybeSingle()
  if (error) throw new Error(`Failed to revoke the fit override: ${error.message}`)
  if (!data) throw new Error("This override was already revoked")
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "lot.fit_override_revoked", entityType: "lot", entityId: lot.id, payload: { override_id: overrideId, house_plan_id: before.house_plan_id } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "lot_fit_override", entityId: overrideId, before, after: { ...before, ...data } }),
  ])
}

export interface LotElevationChoice {
  id: string
  planCode: string
  planName: string
  code: string
  name: string | null
}

/** More elevations than this and the picker needs a search; said out loud when it truncates. */
export const LOT_ELEVATION_CHOICE_CAP = 300

/**
 * The elevations a lot's architectural control can name: those of the plans its
 * community offers, plus any already on the list (an elevation withdrawn from
 * the price sheet stays visible so it can be taken off).
 */
export async function listLotElevationRules(
  lotId: string,
  orgId?: string,
): Promise<{ allowedIds: string[]; choices: LotElevationChoice[]; truncated: boolean }> {
  const context = await requireOrgContext(orgId)
  await requirePermission("community.read", context)
  const lot = await scopedLot(context, lotId)
  const [allowed, offering] = await Promise.all([
    context.supabase.from("lot_allowed_elevations").select("house_plan_elevation_id").eq("org_id", context.orgId).eq("lot_id", lot.id),
    context.supabase.from("community_plan_availability").select("house_plan_id").eq("org_id", context.orgId).eq("community_id", lot.community_id).eq("is_available", true),
  ])
  if (allowed.error) throw new Error(`Failed to load allowed elevations: ${allowed.error.message}`)
  if (offering.error) throw new Error(`Failed to load the community's plans: ${offering.error.message}`)
  const allowedIds = (allowed.data ?? []).map((row) => row.house_plan_elevation_id)
  const planIds = [...new Set((offering.data ?? []).map((row) => row.house_plan_id))]
  const [offered, listed] = await Promise.all([
    planIds.length === 0 ? Promise.resolve([]) : readByIds<ElevationChoiceRow>(planIds,
      (chunk) => context.supabase.from("house_plan_elevations").select(ELEVATION_CHOICE_SELECT).eq("org_id", context.orgId).eq("is_active", true).in("house_plan_id", chunk),
      "Failed to load elevations"),
    readByIds<ElevationChoiceRow>(allowedIds,
      (chunk) => context.supabase.from("house_plan_elevations").select(ELEVATION_CHOICE_SELECT).eq("org_id", context.orgId).in("id", chunk),
      "Failed to load allowed elevations"),
  ])
  const byId = new Map([...offered, ...listed].map((row) => [row.id, row]))
  const choices = [...byId.values()].map((row) => {
    const plan = Array.isArray(row.plan) ? row.plan[0] : row.plan
    return { id: row.id, planCode: plan?.code ?? "", planName: plan?.name ?? "", code: row.code, name: row.name }
  }).sort((a, b) => a.planCode.localeCompare(b.planCode) || a.code.localeCompare(b.code))
  return { allowedIds, choices: choices.slice(0, LOT_ELEVATION_CHOICE_CAP), truncated: choices.length > LOT_ELEVATION_CHOICE_CAP }
}

type ElevationChoiceRow = { id: string; code: string; name: string | null; plan: { code: string; name: string } | Array<{ code: string; name: string }> | null }
const ELEVATION_CHOICE_SELECT = "id, code, name, plan:house_plans(code, name)"

/**
 * Set the elevations a lot takes. An empty list lifts the restriction. A home
 * already pinned to the lot is re-judged, and recorded if it no longer fits.
 */
export async function setLotAllowedElevations(
  lotId: string,
  input: { elevationIds: string[] },
  orgId?: string,
): Promise<{ allowedIds: string[]; fitRefusal: string | null }> {
  const parsed = lotAllowedElevationsSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("lot.write", context)
  const lot = await scopedLot(context, lotId)
  const next = [...new Set(parsed.elevationIds)]
  const [current, known] = await Promise.all([
    context.supabase.from("lot_allowed_elevations").select("house_plan_elevation_id").eq("org_id", context.orgId).eq("lot_id", lot.id),
    readByIds<{ id: string }>(next, (chunk) => context.supabase.from("house_plan_elevations").select("id").eq("org_id", context.orgId).in("id", chunk), "Failed to verify elevations"),
  ])
  if (current.error) throw new Error(`Failed to load allowed elevations: ${current.error.message}`)
  if (known.length !== next.length) throw new Error("One or more elevations were not found.")
  const before = (current.data ?? []).map((row) => row.house_plan_elevation_id)
  const removed = before.filter((elevationId) => !next.includes(elevationId))
  const added = next.filter((elevationId) => !before.includes(elevationId))
  if (removed.length > 0) {
    const { error } = await context.supabase.from("lot_allowed_elevations").delete()
      .eq("org_id", context.orgId).eq("lot_id", lot.id).in("house_plan_elevation_id", removed)
    if (error) throw new Error(`Failed to update allowed elevations: ${error.message}`)
  }
  if (added.length > 0) {
    const { error } = await context.supabase.from("lot_allowed_elevations").insert(
      added.map((elevationId) => ({ org_id: context.orgId, lot_id: lot.id, house_plan_elevation_id: elevationId, created_by: context.userId })),
    )
    if (error) throw new Error(`Failed to update allowed elevations: ${error.message}`)
  }
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "lot.allowed_elevations_changed", entityType: "lot", entityId: lot.id, payload: { community_id: lot.community_id, added, removed } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "lot", entityId: lot.id, before: { allowed_elevation_ids: before }, after: { allowed_elevation_ids: next } }),
  ])
  const refused = await reevaluatePinnedLotFits(context, [lot.id])
  return { allowedIds: next, fitRefusal: refused.get(lot.id) ?? null }
}

/** Past this, the re-judgement after a setback change stops and says how far it got. */
const COMMUNITY_REEVALUATION_CAP = 2_000

/**
 * Set a community's default setbacks. Every home pinned in the community is
 * re-judged against the new envelope; the ones that no longer fit are
 * recorded and counted, never unpinned.
 */
export async function setCommunitySetbacks(
  communityId: string,
  input: SetbacksInput,
  orgId?: string,
): Promise<{ setbacks: Setbacks; homesNoLongerFitting: number; truncated: boolean }> {
  const parsed = setbacksSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("community.write", context)
  await requireCommunityScope(communityId, context)
  const { data: before, error: readError } = await context.supabase.from("communities").select("id, setbacks")
    .eq("org_id", context.orgId).eq("id", communityId).maybeSingle()
  if (readError || !before) throw new Error("Community not found")
  const stored = storeSetbacks(parsed)
  const { error } = await context.supabase.from("communities").update({ setbacks: stored }).eq("org_id", context.orgId).eq("id", communityId)
  if (error) throw new Error(`Failed to save the setbacks: ${error.message}`)
  const { data: pinned, error: pinnedError } = await context.supabase.from("lots").select("id")
    .eq("org_id", context.orgId).eq("community_id", communityId).not("house_plan_id", "is", null)
    .order("id").limit(COMMUNITY_REEVALUATION_CAP + 1)
  if (pinnedError) throw new Error(`Failed to load the community's pinned homes: ${pinnedError.message}`)
  const lotIds = (pinned ?? []).map((row) => row.id)
  const refused = await reevaluatePinnedLotFits(context, lotIds.slice(0, COMMUNITY_REEVALUATION_CAP))
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "community.setbacks_changed", entityType: "community", entityId: communityId, payload: { setbacks: stored, homes_no_longer_fitting: refused.size } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "community", entityId: communityId, before: { setbacks: before.setbacks }, after: { setbacks: stored } }),
  ])
  return { setbacks: readSetbacks(stored), homesNoLongerFitting: refused.size, truncated: lotIds.length > COMMUNITY_REEVALUATION_CAP }
}
