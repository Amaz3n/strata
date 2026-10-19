import "server-only"
import { isDeepStrictEqual } from "node:util"

/**
 * Takeoff conditions — the bridge between measured geometry and money.
 *
 * A condition owns a set of measuring markups and turns them into one priced
 * line: `sum(member quantity) × (1 + waste%) × effective rate`. Nothing here
 * is stored as a total; a rollup is always recomputed from live geometry, so
 * re-measuring a wall is immediately visible everywhere the number appears.
 *
 * Posture-neutral. A condition lives on a project OR a house plan version, and
 * `syncConditions` writes to whichever money surface the caller names. The
 * ENGINE never asks what tier the org is — the caller (which already knows the
 * project's posture through the normal choke points) decides which
 * destinations to offer.
 */

import { markupDataSchema } from "@/lib/validation/drawings"
import { z } from "zod"
import { readAllRowsById } from "@/lib/land/paging"
import { timestampMicros } from "@/lib/services/books/posting-state"
import { requireAuthorization, getDivisionAccessForUser } from "@/lib/services/authorization"
import type { SupabaseClient } from "@supabase/supabase-js"

import { listSyncTargets, listPlanVersionTarget } from "@/lib/services/takeoff-destinations"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { requireTakeoffCostCodes, requireTakeoffWriteScope } from "@/lib/services/takeoff-scope"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { calculateEstimateTotals } from "@/lib/financials/estimate-totals"
import {
  conditionSourceUom,
  extendedCents,
  MEASURE_UOM_LABELS,
  QUANTITY_EPSILON,
  type ConditionFactors,
  type ConditionUom,
  type MeasureUom,
  isMeasuringMarkupType,
  MEASURING_TYPE_UOM,
} from "@/lib/drawings/measure"
import {
  buildSheetBreakdown,
  classifySyncRow,
  rollUpCondition,
  CONDITION_SHEET_BREAKDOWN_CAP,
  type ConditionSheetBreakdown,
  type ConditionTotals,
  type RollupMember,
  type RollupCostCode,
} from "@/lib/drawings/condition-rollup"
import { nextConditionColor } from "@/lib/drawings/takeoff-palette"
import {
  assignMarkupsToConditionSchema,
  conditionRollupFiltersSchema,
  createTakeoffConditionSchema,
  factorRuleViolation,
  syncConditionsSchema,
  storedConditionMeasurementSchema,
  storedMeasurementQuantitySchema,
  takeoffConditionMutationTargetSchema,
  takeoffConditionScopeSchema,
  updateTakeoffConditionSchema,
  type AssignMarkupsToConditionInput,
  type ConditionRollupFilters,
  type CreateTakeoffConditionInput,
  type SyncConditionsInput,
  type TakeoffDestination,
  type UpdateTakeoffConditionInput,
} from "@/lib/validation/takeoff"

const CONDITION_SELECT =
  "id, org_id, project_id, house_plan_version_id, name, uom, depth_in, height_ft, pitch_rise, tons_per_cy, cost_code_id, color, waste_pct, unit_cost_cents, share_with_clients, notes, sort_order, created_by, created_at, updated_at"

/** Hard cap on conditions per scope, so the panel is never unbounded. */
export const CONDITION_LIST_CAP = 200
/** Refusal limit for complete legacy discovery, separate from creation policy. */
const CONDITION_READ_CAP = 10_000

/**
 * Two estimators on one job is normal, and takeoff has no realtime layer. This
 * is not collaboration — it is the guard that stops the second save from
 * silently erasing the first. Updates always fence against the loaded revision;
 * callers that pass the `updated_at` they rendered also detect earlier changes.
 */
export const STALE_WRITE = "Changed by someone else — reload before saving."

// ============================================================================
// TYPES
// ============================================================================

export interface TakeoffCondition extends ConditionFactors {
  id: string
  org_id: string
  project_id: string | null
  house_plan_version_id: string | null
  name: string
  /** What the condition REPORTS. Members measure in `conditionSourceUom(...)`. */
  uom: ConditionUom
  depth_in: number | null
  height_ft: number | null
  pitch_rise: number | null
  tons_per_cy: number | null
  cost_code_id: string | null
  color: string
  waste_pct: number
  unit_cost_cents: number | null
  share_with_clients: boolean
  notes: string | null
  sort_order: number
  created_by: string | null
  created_at: string
  updated_at: string
}

export type { ConditionSheetBreakdown }
export { CONDITION_SHEET_BREAKDOWN_CAP }

/**
 * One condition's totals, plus where it was last pushed.
 *
 * The arithmetic and every classification rule behind these numbers lives in
 * `lib/drawings/condition-rollup.ts` — pure, and tested without a database,
 * because this is the shape money is decided in.
 */
export interface ConditionRollup extends ConditionTotals {
  condition: TakeoffCondition
  /** Set once this condition has been pushed somewhere. */
  sync: ConditionSyncState | null
  /** Server-requested retained lines; omitted from ordinary panel payloads. */
  sync_history?: ConditionSyncState[]
}

export interface ConditionSyncState {
  destination: TakeoffDestination
  target_id: string
  line_id: string
  /** Quantity written at sync time. */
  synced_quantity: number
  synced_at: string | null
  /** Live quantity now differs from what was synced — the line is out of date. */
  quantity_changed: boolean
  /** Someone edited the line's quantity by hand after the sync. */
  hand_edited: boolean
  /** The condition was deleted after syncing; the line is on its own now. */
  detached: boolean
}

export interface ConditionSyncPreviewRow {
  condition_id: string
  condition_name: string
  uom: ConditionUom
  /** Null when the destination has no matching line yet. */
  current_quantity: number | null
  next_quantity: number
  unit_cost_cents: number | null
  action: "create" | "update" | "unchanged" | "drift"
  /** Populated on `drift`: the number the last sync wrote, before the hand-edit. */
  reprice_required?: boolean
  evidence_only?: boolean
  blocked_reason?: string
  last_synced_quantity?: number
}

// ============================================================================
// MAPPERS
// ============================================================================

/** Postgres `numeric` arrives as a string; an absent factor must stay null. */
function numericOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function mapCondition(row: any): TakeoffCondition {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id ?? null,
    house_plan_version_id: row.house_plan_version_id ?? null,
    name: row.name,
    uom: row.uom as ConditionUom,
    depth_in: numericOrNull(row.depth_in),
    height_ft: numericOrNull(row.height_ft),
    pitch_rise: numericOrNull(row.pitch_rise),
    tons_per_cy: numericOrNull(row.tons_per_cy),
    cost_code_id: row.cost_code_id ?? null,
    color: row.color,
    waste_pct: Number(row.waste_pct ?? 0),
    unit_cost_cents: row.unit_cost_cents ?? null,
    share_with_clients: row.share_with_clients ?? false,
    notes: row.notes ?? null,
    sort_order: row.sort_order ?? 0,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

// ============================================================================
// SCOPE
// ============================================================================

type Scope = { project_id: string } | { house_plan_version_id: string }

function scopeFilter<T>(query: any, scope: Scope): T {
  return "project_id" in scope
    ? query.eq("project_id", scope.project_id)
    : query.eq("house_plan_version_id", scope.house_plan_version_id)
}

function resolveScope(filters: ConditionRollupFilters): Scope {
  if (filters.project_id) return { project_id: filters.project_id }
  if (filters.house_plan_version_id) {
    return { house_plan_version_id: filters.house_plan_version_id }
  }
  throw new Error("A takeoff scope needs a project or a house plan version")
}

// ============================================================================
// CONDITIONS — CRUD
// ============================================================================

export async function listTakeoffConditions(
  filters: ConditionRollupFilters,
  orgId?: string,
): Promise<TakeoffCondition[]> {
  const parsed = conditionRollupFiltersSchema.parse(filters)
  const context = await requireOrgContext(orgId)
  return listTakeoffConditionsWithContext(context, parsed)
}

type TakeoffReadContext = Pick<
  Awaited<ReturnType<typeof requireOrgContext>>,
  "supabase" | "orgId" | "userId"
>

async function listTakeoffConditionsWithContext(
  context: TakeoffReadContext,
  filters: ConditionRollupFilters,
): Promise<TakeoffCondition[]> {
  takeoffConditionScopeSchema.parse(filters)
  z.string().uuid().parse(context.orgId)
  z.string().uuid().parse(context.userId)
  const scope = resolveScope(filters)
  await authorizeTakeoffReadScope(context, scope)
  const rows = await readAllRowsById(async (afterId, limit) => {
    let query = scopeFilter<any>(context.supabase.from("takeoff_conditions").select(CONDITION_SELECT).eq("org_id", context.orgId), scope)
      .order("id", { ascending: true }).limit(limit)
    if (afterId) query = query.gt("id", afterId)
    const result = await query
    if (result.data?.some((row: Record<string, unknown>) => row.org_id !== context.orgId || ("project_id" in scope ? row.project_id !== scope.project_id || row.house_plan_version_id !== null : row.house_plan_version_id !== scope.house_plan_version_id || row.project_id !== null))) throw new Error("Takeoff discovery condition scope differs")
    return result
  }, { cap: CONDITION_READ_CAP, pageSize: 1000, label: "Failed to load all takeoff conditions" })
  const conditions = rows.map(readStoredTakeoffCondition)
  conditions.sort((a, b) => a.sort_order - b.sort_order || (timestampMicros(a.created_at)! < timestampMicros(b.created_at)! ? -1 : timestampMicros(a.created_at)! > timestampMicros(b.created_at)! ? 1 : a.id.localeCompare(b.id)))
  return conditions
}

/** Shared original read policy for both scope discovery and a single deep link. */
async function authorizeTakeoffReadScope(context: TakeoffReadContext, scope: Scope): Promise<void> {
  takeoffConditionScopeSchema.parse(scope)
  z.string().uuid().parse(context.orgId)
  z.string().uuid().parse(context.userId)
  if ("project_id" in scope) {
    await requireAuthorization({ permission: "takeoff.read", orgId: context.orgId, userId: context.userId, supabase: context.supabase, projectId: scope.project_id, logDecision: true })
  } else {
    await requirePermission("takeoff.read", context)
    const { data: version, error } = await context.supabase.from("house_plan_versions").select("id,org_id,house_plan_id")
      .eq("org_id", context.orgId).eq("id", scope.house_plan_version_id).maybeSingle()
    if (error || !version) throw new Error("Takeoff discovery plan version unavailable")
    const source = z.object({ id: z.string().uuid(), org_id: z.string().uuid(), house_plan_id: z.string().uuid() }).parse(version)
    if (source.id !== scope.house_plan_version_id || source.org_id !== context.orgId) throw new Error("Takeoff discovery plan version scope differs")
    const [{ data: plan, error: planError }, access] = await Promise.all([
      context.supabase.from("house_plans").select("id,org_id,division_id").eq("org_id", context.orgId).eq("id", source.house_plan_id).maybeSingle(),
      getDivisionAccessForUser({ orgId: context.orgId, userId: context.userId }),
    ])
    if (planError || !plan) throw new Error("Takeoff discovery plan unavailable")
    const parent = z.object({ id: z.string().uuid(), org_id: z.string().uuid(), division_id: z.string().uuid().nullable() }).parse(plan)
    if (parent.id !== source.house_plan_id || parent.org_id !== context.orgId || access.assignedOnly && parent.division_id && !access.divisionIds.includes(parent.division_id)) throw new Error("Takeoff discovery plan scope unavailable")
  }
}

/** Read stored legacy evidence with the same validator used by discovery. */
function readStoredTakeoffCondition(raw: Record<string, unknown>): TakeoffCondition {
  const row = z.object({ id: z.string().uuid(), org_id: z.string().uuid(), project_id: z.string().uuid().nullable(), house_plan_version_id: z.string().uuid().nullable(), name: z.string().refine(value => value.trim().length > 0), color: z.string().regex(/^#[0-9a-f]{6}$/i), cost_code_id: z.string().uuid().nullable(), notes: z.string().nullable(), sort_order: z.number().int().safe(), share_with_clients: z.boolean(), created_by: z.string().uuid().nullable(), created_at: z.string().refine(value => timestampMicros(value) !== null), updated_at: z.string().datetime({ offset: true }) }).parse(raw)
  takeoffConditionScopeSchema.parse(row)
  const measurement = storedConditionMeasurementSchema.parse(raw)
  const waste = storedMeasurementQuantitySchema.parse((raw as Record<string, unknown>).waste_pct)
  const rate = storedMeasurementQuantitySchema.parse((raw as Record<string, unknown>).unit_cost_cents)
  if (waste === null || waste < 0 || waste > 100 || rate !== null && (!Number.isSafeInteger(rate) || rate < 0)) throw new Error("Takeoff discovery rate or waste evidence invalid")
  return mapCondition({ ...row, ...measurement, waste_pct: waste, unit_cost_cents: rate })
}

export async function createTakeoffCondition(
  input: CreateTakeoffConditionInput,
  orgId?: string,
): Promise<TakeoffCondition> {
  const parsed = createTakeoffConditionSchema.parse(input)
  const context = await requireOrgContext(orgId)
  const { supabase, orgId: resolvedOrgId, userId } = context
  await requirePermission("takeoff.write", { supabase, orgId: resolvedOrgId, userId })
  await requireTakeoffWriteScope(context, parsed)

  const scope: Scope = parsed.project_id
    ? { project_id: parsed.project_id }
    : { house_plan_version_id: parsed.house_plan_version_id as string }

  // Color and position both derive from what is already in this scope, so a
  // new condition never collides with an existing one on the sheet.
  const [siblings] = await Promise.all([
    listSiblingsForPlacement(supabase, resolvedOrgId, scope),
    requireTakeoffCostCodes(context, [{ cost_code_id: parsed.cost_code_id ?? null }]),
  ])
  const color = parsed.color ?? nextConditionColor(siblings.map((s) => s.color))
  const sortOrder = siblings.length

  if (siblings.length >= CONDITION_LIST_CAP) {
    throw new Error(`A takeoff can hold at most ${CONDITION_LIST_CAP} conditions`)
  }

  const payload = {
      org_id: resolvedOrgId,
      project_id: parsed.project_id ?? null,
      house_plan_version_id: parsed.house_plan_version_id ?? null,
      name: parsed.name,
      uom: parsed.uom,
      depth_in: parsed.depth_in ?? null,
      height_ft: parsed.height_ft ?? null,
      pitch_rise: parsed.pitch_rise ?? null,
      tons_per_cy: parsed.tons_per_cy ?? null,
      cost_code_id: parsed.cost_code_id ?? null,
      color,
      waste_pct: parsed.waste_pct ?? 0,
      unit_cost_cents: parsed.unit_cost_cents ?? null,
      share_with_clients: parsed.share_with_clients ?? false,
      notes: parsed.notes ?? null,
      sort_order: sortOrder,
      created_by: userId,
  }
  const { data, error } = await supabase
    .from("takeoff_conditions")
    .insert(payload)
    .select(CONDITION_SELECT)
    .single()

  if (error || !data) {
    throw new Error(`Failed to create takeoff condition: ${error?.message}`)
  }
  const saved = mapCondition(data)
  const copiedKeys = [
    "org_id", "project_id", "house_plan_version_id", "name", "uom", "depth_in", "height_ft",
    "pitch_rise", "tons_per_cy", "cost_code_id", "color", "waste_pct", "unit_cost_cents",
    "share_with_clients", "notes", "sort_order", "created_by",
  ] as const
  if (typeof saved.id !== "string" || !saved.id || copiedKeys.some((key) => saved[key] !== payload[key])) {
    throw new Error("Created takeoff condition could not be confirmed. Reload before retrying.")
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "takeoff_condition",
    entityId: data.id as string,
    after: data,
  })
  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "takeoff_condition_created",
    entityType: "takeoff_condition",
    entityId: data.id as string,
    payload: {
      name: parsed.name,
      uom: parsed.uom,
      project_id: parsed.project_id ?? null,
      house_plan_version_id: parsed.house_plan_version_id ?? null,
    },
  })

  return saved
}

async function listSiblingsForPlacement(
  supabase: SupabaseClient,
  orgId: string,
  scope: Scope,
): Promise<Array<{ color: string }>> {
  const query = scopeFilter<any>(
    supabase.from("takeoff_conditions")
      .select("id,org_id,project_id,house_plan_version_id,color", { count: "exact" }).eq("org_id", orgId),
    scope,
  )
  const { data, error, count }: {
    data: Array<{ id: string; org_id: string; project_id: string | null; house_plan_version_id: string | null; color: string }> | null
    error: { message: string } | null
    count: number | null
  } = await query.limit(CONDITION_LIST_CAP + 1)
  const scopeColumn = "project_id" in scope ? "project_id" : "house_plan_version_id"
  const scopeId = "project_id" in scope ? scope.project_id : scope.house_plan_version_id
  if (
    error || !data || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 ||
    data.length !== Math.min(count, CONDITION_LIST_CAP + 1) ||
    new Set(data.map((row) => row.id)).size !== data.length ||
    data.some((row) => typeof row.id !== "string" || !row.id || row.org_id !== orgId || row[scopeColumn] !== scopeId ||
      typeof row.color !== "string" || !/^#[0-9a-f]{6}$/i.test(row.color))
  ) {
    throw new Error("Unable to verify takeoff placement. Reload before retrying.")
  }
  return data.map((row) => ({ color: row.color }))
}

export async function updateTakeoffCondition(
  conditionId: string,
  updates: UpdateTakeoffConditionInput,
  orgId?: string,
  /**
   * The `updated_at` the caller last saw. When supplied, the write is refused if
   * the row moved underneath them — see `STALE_WRITE`.
   */
  seenUpdatedAt?: string | null,
): Promise<TakeoffCondition> {
  const parsed = updateTakeoffConditionSchema.parse(updates)
  const target = takeoffConditionMutationTargetSchema.parse({ conditionId, seenUpdatedAt })
  const context = await requireOrgContext(orgId)
  const { supabase, orgId: resolvedOrgId, userId } = context
  await requirePermission("takeoff.write", { supabase, orgId: resolvedOrgId, userId })

  let existingQuery = supabase
    .from("takeoff_conditions")
    .select(CONDITION_SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("id", conditionId)
  if (target.seenUpdatedAt) existingQuery = existingQuery.eq("updated_at", target.seenUpdatedAt)
  const { data: existing, error: existingError } = await existingQuery.maybeSingle()

  if (existingError) throw new Error(`Failed to load takeoff condition: ${existingError.message}`)
  if (!existing && target.seenUpdatedAt) throw new Error(STALE_WRITE)
  if (!existing || existing.id !== target.conditionId || existing.org_id !== resolvedOrgId) {
    throw new Error("Takeoff condition not found")
  }
  if (typeof existing.updated_at !== "string") throw new Error("Takeoff condition revision unavailable")
  takeoffConditionMutationTargetSchema.parse({ conditionId: existing.id, seenUpdatedAt: existing.updated_at })
  await requireTakeoffWriteScope(context, takeoffConditionScopeSchema.parse(existing))

  const payload: Record<string, unknown> = {}
  for (const key of [
    "name",
    "depth_in",
    "height_ft",
    "pitch_rise",
    "tons_per_cy",
    "cost_code_id",
    "color",
    "waste_pct",
    "unit_cost_cents",
    "share_with_clients",
    "notes",
    "sort_order",
  ] as const) {
    if (parsed[key] !== undefined) payload[key] = parsed[key]
  }

  await requireTakeoffCostCodes(context, [{ cost_code_id: parsed.cost_code_id === undefined ? existing.cost_code_id : parsed.cost_code_id }])
  if (Object.keys(payload).length === 0) return mapCondition(existing)

  // The factors are validated against the condition's stored uom, which the
  // update never carries. Merge before checking, or a CY condition could have
  // its depth cleared through a shape Zod considers complete.
  const merged = { ...mapCondition(existing), ...payload } as {
    uom: ConditionUom
  } & ConditionFactors
  const violation = factorRuleViolation(merged)
  if (violation) throw new Error(violation)

  // Setting or clearing a wall height flips which unit members must measure in.
  // Doing that under a populated condition would leave every member illegal, so
  // it is refused the same way changing `uom` is.
  const beforeSource = conditionSourceUom(existing.uom as ConditionUom, mapCondition(existing))
  const afterSource = conditionSourceUom(merged.uom, merged)
  if (beforeSource !== afterSource) {
    const { count, error: countError } = await supabase
      .from("drawing_markups")
      .select("id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId)
      .eq("condition_id", conditionId)
    if (countError || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new Error("Unable to verify condition measurements. Reload before retrying.")
    }
    if (count > 0) {
      throw new Error(
        `Setting a wall height changes what "${existing.name}" measures, from ` +
          `${MEASURE_UOM_LABELS[beforeSource]} to ${MEASURE_UOM_LABELS[afterSource]}. ` +
          `Release its ${count} measurement${count === 1 ? "" : "s"} first.`,
      )
    }
  }

  const updateQuery = supabase
    .from("takeoff_conditions")
    .update(payload)
    .eq("org_id", resolvedOrgId)
    .eq("id", conditionId)
    .eq("updated_at", target.seenUpdatedAt ?? existing.updated_at)

  const { data, error } = await updateQuery.select(CONDITION_SELECT).maybeSingle()

  if (!error && !data) {
    throw new Error(STALE_WRITE)
  }
  if (error || !data) {
    throw new Error(`Failed to update takeoff condition: ${error?.message}`)
  }
  const saved = mapCondition(data)
  const expected = { ...mapCondition(existing), ...payload }
  const copiedKeys = [
    "id", "org_id", "project_id", "house_plan_version_id", "name", "uom", "depth_in", "height_ft",
    "pitch_rise", "tons_per_cy", "cost_code_id", "color", "waste_pct", "unit_cost_cents",
    "share_with_clients", "notes", "sort_order", "created_by", "created_at",
  ] as const
  if (copiedKeys.some((key) => saved[key] !== expected[key]) || typeof saved.updated_at !== "string" ||
    !takeoffConditionMutationTargetSchema.safeParse({ conditionId: saved.id, seenUpdatedAt: saved.updated_at }).success) {
    throw new Error("Updated takeoff condition could not be confirmed. Reload before retrying.")
  }

  // The color IS the condition's identity on the sheet. Changing it here and
  // leaving the geometry painted in the old hex would break that link, so the
  // members are repainted with the original set-based RPC. This is a separate
  // operation from the condition update; a failure still needs recovery.
  if (parsed.color && parsed.color !== existing.color) {
    await repaintConditionMarkups(supabase, resolvedOrgId, conditionId, parsed.color)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "takeoff_condition",
    entityId: conditionId,
    before: existing,
    after: data,
  })

  return saved
}

async function repaintConditionMarkups(
  supabase: SupabaseClient,
  orgId: string,
  conditionId: string,
  color: string,
): Promise<void> {
  // One set-based UPDATE server-side; a large condition repainted row-by-row
  // from here was thousands of round trips inside one request.
  const { error } = await supabase.rpc("repaint_condition_markups", {
    p_org_id: orgId,
    p_condition_id: conditionId,
    p_color: color,
  })
  if (error) {
    throw new Error(`Failed to repaint condition measurements: ${error.message}`)
  }
}

/**
 * Deleting a condition releases its measurements (they stay on the sheet as
 * unassigned geometry) and stamps any line it was synced to as detached, so
 * the estimate stops claiming a live link to a takeoff that no longer exists.
 */
export async function deleteTakeoffCondition(
  conditionId: string,
  orgId?: string,
  seenUpdatedAt?: string | null,
): Promise<{ released_markups: number; detached_lines: number }> {
  const target = takeoffConditionMutationTargetSchema.parse({ conditionId, seenUpdatedAt })
  const context = await requireOrgContext(orgId)
  const { supabase, orgId: resolvedOrgId, userId } = context
  await requirePermission("takeoff.write", { supabase, orgId: resolvedOrgId, userId })

  let existingQuery = supabase
    .from("takeoff_conditions")
    .select(CONDITION_SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("id", conditionId)
  if (target.seenUpdatedAt) existingQuery = existingQuery.eq("updated_at", target.seenUpdatedAt)
  const { data: existing, error: existingError } = await existingQuery.maybeSingle()

  if (existingError) throw new Error(`Failed to load takeoff condition: ${existingError.message}`)
  if (!existing && target.seenUpdatedAt) throw new Error(STALE_WRITE)
  if (!existing || existing.id !== target.conditionId || existing.org_id !== resolvedOrgId) {
    throw new Error("Takeoff condition not found")
  }
  if (typeof existing.updated_at !== "string") throw new Error("Takeoff condition revision unavailable")
  takeoffConditionMutationTargetSchema.parse({ conditionId: existing.id, seenUpdatedAt: existing.updated_at })
  await requireTakeoffWriteScope(context, takeoffConditionScopeSchema.parse(existing))

  const detachedLines = await markSyncedLinesDetached(supabase, resolvedOrgId, conditionId)

  const { data: released, error: releaseError, count: releaseCount } = await supabase
    .from("drawing_markups")
    .update({ condition_id: null }, { count: "exact" })
    .eq("org_id", resolvedOrgId)
    .eq("condition_id", conditionId)
    .select("id,org_id,condition_id")

  if (releaseError) {
    throw new Error(`Failed to release measurements: ${releaseError.message}`)
  }
  if (!released || typeof releaseCount !== "number" || !Number.isSafeInteger(releaseCount) || releaseCount < 0 ||
    released.length !== releaseCount || new Set(released.map((row) => row.id)).size !== released.length ||
    released.some((row) => typeof row.id !== "string" || !row.id || row.org_id !== resolvedOrgId || row.condition_id !== null)) {
    throw new Error("Released condition measurements could not be confirmed. Reload before retrying.")
  }

  const { data: removed, error } = await supabase
    .from("takeoff_conditions")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("id", conditionId)
    .eq("updated_at", target.seenUpdatedAt ?? existing.updated_at)
    .select("id,org_id,updated_at")
    .maybeSingle()

  if (!error && !removed) throw new Error(STALE_WRITE)
  if (error) {
    throw new Error(`Failed to delete takeoff condition: ${error.message}`)
  }
  if (!removed || removed.id !== target.conditionId || removed.org_id !== resolvedOrgId ||
    removed.updated_at !== existing.updated_at) {
    throw new Error("Deleted takeoff condition could not be confirmed. Reload before retrying.")
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "delete",
    entityType: "takeoff_condition",
    entityId: conditionId,
    before: existing,
  })

  return { released_markups: released.length, detached_lines: detachedLines }
}

async function markSyncedLinesDetached(
  supabase: SupabaseClient,
  orgId: string,
  conditionId: string,
): Promise<number> {
  // Set-based server-side, and it detaches EVERY destination this condition
  // ever synced to — estimate lines, plan takeoff lines, and bid scope lines —
  // so no surface keeps claiming a live link to a deleted condition.
  const { data, error } = await supabase.rpc("detach_takeoff_condition_lines", {
    p_org_id: orgId,
    p_condition_id: conditionId,
  })
  if (error) {
    throw new Error(`Failed to detach synced lines: ${error.message}`)
  }
  if (typeof data !== "number" || !Number.isSafeInteger(data) || data < 0) {
    throw new Error("Detached condition lines could not be confirmed. Reload before retrying.")
  }
  return data
}

// ============================================================================
// MEMBERSHIP
// ============================================================================

/**
 * Move measurements into (or out of, with a null condition) a condition. Runs
 * the same unit check the single-markup path does, on every markup, before it
 * writes anything.
 */
export async function assignMarkupsToCondition(
  input: AssignMarkupsToConditionInput,
  orgId?: string,
): Promise<number> {
  const parsed = assignMarkupsToConditionSchema.parse(input)
  const requestedIds = new Set(parsed.markup_ids)
  if (requestedIds.size !== parsed.markup_ids.length) throw new Error("Select each measurement only once")
  const context = await requireOrgContext(orgId)
  const { supabase, orgId: resolvedOrgId, userId } = context
  await requirePermission("takeoff.write", { supabase, orgId: resolvedOrgId, userId })

  const { data: markups, error: markupError } = await supabase
    .from("drawing_markups")
    .select("id,org_id,uom,drawing_sheet_id,condition_id,drawing_sheets!inner(id,org_id,project_id)")
    .eq("org_id", resolvedOrgId)
    .in("id", parsed.markup_ids)
  if (markupError || !markups || markups.length !== requestedIds.size ||
    new Set(markups.map((markup) => markup.id)).size !== requestedIds.size ||
    markups.some((markup) => !requestedIds.has(markup.id) || markup.org_id !== resolvedOrgId)) {
    throw new Error("Selected condition measurements unavailable. Reload before retrying.")
  }

  const projectIds = new Set<string>()
  for (const markup of markups) {
    const embedded = markup.drawing_sheets
    const sheets = Array.isArray(embedded) ? embedded : embedded ? [embedded] : []
    if (sheets.length !== 1) throw new Error("Selected measurement sheet unavailable")
    const sheet = sheets[0]
    if (sheet.id !== markup.drawing_sheet_id || sheet.org_id !== resolvedOrgId || typeof sheet.project_id !== "string") {
      throw new Error("Selected measurement project unavailable")
    }
    takeoffConditionScopeSchema.parse({ project_id: sheet.project_id })
    projectIds.add(sheet.project_id)
  }

  if (parsed.condition_id) {
    const { data: condition, error: conditionError } = await supabase
      .from("takeoff_conditions")
      .select(CONDITION_SELECT)
      .eq("org_id", resolvedOrgId)
      .eq("id", parsed.condition_id)
      .maybeSingle()

    if (conditionError || !condition || condition.id !== parsed.condition_id || condition.org_id !== resolvedOrgId) {
      throw new Error("Takeoff condition not found")
    }
    await requireTakeoffWriteScope(context, takeoffConditionScopeSchema.parse(condition))
    if (condition.project_id) projectIds.delete(condition.project_id)
    const mapped = mapCondition(condition)
    const violation = factorRuleViolation(mapped)
    if (violation) throw new Error(violation)
    const measured = storedConditionMeasurementSchema.parse(condition)
    const sourceUom = conditionSourceUom(measured.uom, measured)
    const mismatched = markups.filter((markup) => markup.uom !== sourceUom)
    if (mismatched.length > 0) {
      throw new Error(
        `${mismatched.length} of these measurements do not measure in ${MEASURE_UOM_LABELS[sourceUom]}` +
          (sourceUom !== mapped.uom
            ? ` — "${mapped.name}" reports ${MEASURE_UOM_LABELS[mapped.uom]}, measured as ${MEASURE_UOM_LABELS[sourceUom]}`
            : ""),
      )
    }
    await assertMarkupsInScope(supabase, resolvedOrgId, mapped, markups)
  }

  // Unassignment still changes geometry on a project. Every source project
  // needs the same canonical write decision, even when there is no destination.
  const sources = [...projectIds]
  for (let offset = 0; offset < sources.length; offset += 10) {
    await Promise.all(sources.slice(offset, offset + 10).map((project_id) => requireTakeoffWriteScope(context, { project_id })))
  }

  const { data, error } = await supabase
    .from("drawing_markups")
    .update({ condition_id: parsed.condition_id })
    .eq("org_id", resolvedOrgId)
    .in("id", parsed.markup_ids)
    .select("id,org_id,condition_id,drawing_sheet_id,uom")

  if (error) throw new Error(`Failed to assign measurements: ${error.message}`)
  const originalById = new Map(markups.map((markup) => [markup.id, markup]))
  if (!data || data.length !== requestedIds.size || new Set(data.map((markup) => markup.id)).size !== requestedIds.size ||
    data.some((markup) => {
      const original = originalById.get(markup.id)
      return !original || markup.org_id !== resolvedOrgId || markup.condition_id !== parsed.condition_id ||
        markup.drawing_sheet_id !== original.drawing_sheet_id || markup.uom !== original.uom
    })) {
    throw new Error("Saved condition measurements could not be confirmed. Reload before retrying.")
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "takeoff_condition",
    entityId: parsed.condition_id ?? "unassigned",
    after: { markup_ids: parsed.markup_ids, condition_id: parsed.condition_id },
  })
  return data.length
}

/**
 * A condition may only claim geometry from its own scope.
 *
 * For a project condition that means the markup's sheet belongs to the same
 * project. For a plan-version condition it means the sheet belongs to a project
 * built from that plan — the plan has no drawings of its own, so it borrows a
 * lot's, exactly as `listPlanDrawingSources` describes.
 */
export async function assertMarkupsInScope(
  supabase: SupabaseClient,
  orgId: string,
  condition: Pick<TakeoffCondition, "project_id" | "house_plan_version_id" | "name">,
  // PostgREST types an embedded row as an array even when the FK makes it
  // one-to-one, so both shapes are read rather than cast away.
  markups: Array<{ drawing_sheets?: unknown }>,
): Promise<void> {
  takeoffConditionScopeSchema.parse(condition)
  if (!markups.length) throw new Error("No condition measurement scopes could be verified")
  const sheetProjectIds = new Set<string>()
  for (const markup of markups) {
    const embedded = markup.drawing_sheets
    const rows = Array.isArray(embedded) ? embedded : embedded ? [embedded] : []
    if (rows.length !== 1) throw new Error("Condition measurement sheet unavailable. Reload before retrying.")
    const row: unknown = rows[0]
    if (typeof row !== "object" || row === null || !("project_id" in row) || typeof row.project_id !== "string") {
      throw new Error("Condition measurement project unavailable. Reload before retrying.")
    }
    takeoffConditionScopeSchema.parse({ project_id: row.project_id })
    sheetProjectIds.add(row.project_id)
  }

  if (condition.project_id) {
    const foreign = Array.from(sheetProjectIds).filter((id) => id !== condition.project_id)
    if (foreign.length > 0) {
      throw new Error(`"${condition.name}" cannot measure sheets from another project`)
    }
    return
  }

  const { data: version, error: versionError } = await supabase
    .from("house_plan_versions")
    .select("id,house_plan_id")
    .eq("org_id", orgId)
    .eq("id", condition.house_plan_version_id)
    .maybeSingle()

  if (versionError || !version || version.id !== condition.house_plan_version_id || typeof version.house_plan_id !== "string") {
    throw new Error("Takeoff condition's plan version not found")
  }

  const { data: lots, error: lotsError } = await supabase
    .from("lots")
    .select("id,org_id,house_plan_id,project_id")
    .eq("org_id", orgId)
    .eq("house_plan_id", version.house_plan_id)
    .in("project_id", Array.from(sheetProjectIds))

  if (lotsError || !lots || new Set(lots.map((lot) => lot.id)).size !== lots.length ||
    lots.some((lot) => typeof lot.id !== "string" || !lot.id || lot.org_id !== orgId ||
      lot.house_plan_id !== version.house_plan_id || typeof lot.project_id !== "string" || !sheetProjectIds.has(lot.project_id))) {
    throw new Error("Condition measurement lots unavailable. Reload before retrying.")
  }
  const allowed = new Set(lots.map((lot) => lot.project_id))
  const foreign = Array.from(sheetProjectIds).filter((id) => !allowed.has(id))
  if (foreign.length > 0) {
    throw new Error(
      `"${condition.name}" can only measure sheets from a house built on its plan`,
    )
  }
}

// ============================================================================
// ROLLUP
// ============================================================================

type MemberRow = RollupMember & { sheet_version_id: string | null }

/**
 * The panel's data set. Complete owned source sets are paged; full destination
 * evidence is requested only by server workflows that need every retained line.
 */
export async function getConditionRollup(
  filters: ConditionRollupFilters,
  orgId?: string,
  includeSyncHistory = false,
): Promise<ConditionRollup[]> {
  const parsed = conditionRollupFiltersSchema.parse(filters)
  z.boolean().parse(includeSyncHistory)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  return getConditionRollupWithContext(
    { supabase, orgId: resolvedOrgId, userId },
    parsed,
    includeSyncHistory,
  )
}

async function getConditionRollupWithContext(
  context: TakeoffReadContext,
  parsed: ConditionRollupFilters,
  includeSyncHistory = false,
): Promise<ConditionRollup[]> {
  const { supabase, orgId: resolvedOrgId, userId } = context
  const conditions = await listTakeoffConditionsWithContext(
    { supabase, orgId: resolvedOrgId, userId },
    parsed,
  )
  if (conditions.length === 0) return []

  const conditionIds = conditions.map((c) => c.id)
  const costCodeIds = Array.from(
    new Set(conditions.map((c) => c.cost_code_id).filter((id): id is string => !!id)),
  )

  const syncHistory = includeSyncHistory ? new Map<string, Array<Omit<ConditionSyncState, "quantity_changed">>>() : undefined
  const [members, costCodes, syncStates] = await Promise.all([
    loadConditionMembers(context, conditions),
    loadRollupCostCodes(supabase, resolvedOrgId, costCodeIds),
    loadSyncStates(supabase, resolvedOrgId, conditionIds, parsed.project_id, syncHistory),
  ])

  const costCodeById = new Map(costCodes.map(code => [code.id, code]))
  const membersByCondition = new Map<string, MemberRow[]>()
  for (const member of members) {
    const list = membersByCondition.get(member.condition_id)
    if (list) list.push(member)
    else membersByCondition.set(member.condition_id, [member])
  }

  return conditions.map((condition) => {
    const memberRows = (membersByCondition.get(condition.id) ?? []).map(member => ({ ...member, quantity: storedMeasurementQuantitySchema.parse(member.quantity) }))
    const costCode = condition.cost_code_id ? costCodeById.get(condition.cost_code_id) : null
    const totals = rollUpCondition(condition, memberRows, costCode ?? null)
    z.object({ effective_quantity: z.number().finite().nonnegative(), effective_unit_cost_cents: z.number().int().nonnegative().safe().nullable(), extended_cents: z.number().int().nonnegative().safe().nullable() }).parse(totals)
    const sync = syncStates.get(condition.id) ?? null

    return {
      condition,
      ...totals,
      ...(syncHistory ? { sync_history: (syncHistory.get(condition.id) ?? []).map(state => ({
        ...state, quantity_changed: Math.abs(state.synced_quantity - totals.effective_quantity) > QUANTITY_EPSILON,
      })) } : {}),
      sync: sync
        ? {
            ...sync,
            quantity_changed:
              Math.abs(sync.synced_quantity - totals.effective_quantity) > QUANTITY_EPSILON,
          }
        : null,
    }
  })
}

/** Whole referenced rate evidence; inactive historical codes remain readable. */
async function loadRollupCostCodes(
  supabase: SupabaseClient,
  orgId: string,
  codeIds: string[],
): Promise<RollupCostCode[]> {
  z.string().uuid().parse(orgId)
  const ids = z.array(z.string().uuid()).max(CONDITION_READ_CAP).parse(codeIds)
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate rollup cost-code references")
  const codes: RollupCostCode[] = []
  for (let offset = 0; offset < ids.length; offset += ID_CHUNK_SIZE) {
    const batch = ids.slice(offset, offset + ID_CHUNK_SIZE), requested = new Set(batch)
    const rows = await readAllRowsById(async (afterId, limit) => {
      let query = supabase.from("cost_codes").select("id,org_id,code,name,unit,default_unit_cost_cents")
        .eq("org_id", orgId).in("id", batch).order("id", { ascending: true }).limit(limit)
      if (afterId) query = query.gt("id", afterId)
      const result = await query
      if (result.data?.some(row => row.org_id !== orgId || !requested.has(row.id))) throw new Error("Rollup cost-code scope unavailable")
      return result
    }, { cap: batch.length, pageSize: ID_CHUNK_SIZE, label: "Failed to load all rollup cost-code rates" })
    if (rows.length !== batch.length) throw new Error("Rollup cost-code references changed. Reload before retrying.")
    for (const raw of rows) {
      const source = z.object({ id: z.string().uuid(), org_id: z.string().uuid(), code: z.string(), name: z.string(), unit: z.string().nullable() }).parse(raw)
      const rate = storedMeasurementQuantitySchema.parse(raw.default_unit_cost_cents)
      if (rate !== null && (!Number.isSafeInteger(rate) || rate < 0)) throw new Error("Rollup cost-code rate evidence invalid")
      codes.push({ id: source.id, code: source.code, name: source.name, unit: source.unit, default_unit_cost_cents: rate })
    }
  }
  return codes
}

/**
 * Members plus enough sheet context to say which revision they were taken on.
 * A markup pinned to a superseded version is deliberately not counted — see
 * ConditionRollup.stale_markup_count.
 */
const MEMBER_PAGE_SIZE = 1000
const MEMBER_READ_CAP = 200_000
/** `.in(...)` id lists are chunked so no single query carries thousands of ids. */
const ID_CHUNK_SIZE = 200

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

async function loadConditionMembers(
  context: TakeoffReadContext,
  conditions: TakeoffCondition[],
): Promise<MemberRow[]> {
  const { supabase, orgId, userId } = context
  z.string().uuid().parse(orgId)
  z.string().uuid().parse(userId)
  const conditionIds = z.array(z.string().uuid()).max(CONDITION_READ_CAP).parse(conditions.map(condition => condition.id))
  if (new Set(conditionIds).size !== conditionIds.length || conditions.some(condition => condition.org_id !== orgId)) throw new Error("Condition member references differ")
  const byId = new Map(conditions.map(condition => [condition.id, condition]))
  const rawRows: Array<Record<string, unknown>> = []
  for (const batch of chunk(conditionIds, ID_CHUNK_SIZE)) {
    const requested = new Set(batch)
    const loaded = await readAllRowsById(async (afterId, limit) => {
      let query = supabase.from("drawing_markups")
        .select("id,org_id,condition_id,quantity,uom,data,sheet_version_id,drawing_sheet_id,is_private,created_by,drawing_sheets(id,org_id,project_id,sheet_number,sheet_title,current_revision_id),drawing_sheet_versions!drawing_markups_sheet_version_id_fkey(id,org_id,drawing_sheet_id,drawing_revision_id,drawing_revisions(id,org_id,project_id))")
        .eq("org_id", orgId).in("condition_id", batch).order("id", { ascending: true }).limit(limit)
      if (afterId) query = query.gt("id", afterId)
      const result = await query
      if (result.data?.some(row => row.org_id !== orgId || !requested.has(row.condition_id))) throw new Error("Condition member source scope differs")
      return result
    }, { cap: Math.max(1, MEMBER_READ_CAP - rawRows.length), pageSize: MEMBER_PAGE_SIZE, label: "Failed to load all condition measurements" })
    rawRows.push(...loaded)
    if (rawRows.length > MEMBER_READ_CAP) throw new Error("Condition measurement validation limit exceeded")
  }
  if (new Set(rawRows.map(row => row.id)).size !== rawRows.length) throw new Error("Condition measurement sources are duplicated")
  const projects = new Set<string>()
  const scopeMembers = new Map<string, typeof rawRows>()
  const members: MemberRow[] = []
  for (const raw of rawRows) {
    const row = z.object({ id: z.string().uuid(), org_id: z.string().uuid(), condition_id: z.string().uuid(), quantity: storedMeasurementQuantitySchema, uom: z.enum(["lf", "sf", "ea"]).nullable(), data: z.record(z.unknown()), drawing_sheet_id: z.string().uuid(), sheet_version_id: z.string().uuid().nullable(), is_private: z.boolean(), created_by: z.string().uuid().nullable() }).parse(raw)
    if (row.is_private && row.created_by !== userId) throw new Error("A condition includes private measurements you cannot review. Publish or reassign them before pricing.")
    const sheetRows = Array.isArray(raw.drawing_sheets) ? raw.drawing_sheets : [raw.drawing_sheets]
    if (sheetRows.length !== 1) throw new Error("Condition measurement sheet unavailable")
    const sheet = z.object({ id: z.string().uuid(), org_id: z.string().uuid(), project_id: z.string().uuid(), sheet_number: z.string().nullable(), sheet_title: z.string().nullable(), current_revision_id: z.string().uuid().nullable() }).parse(sheetRows[0])
    if (sheet.id !== row.drawing_sheet_id || sheet.org_id !== orgId) throw new Error("Condition measurement sheet scope differs")
    if (!projects.has(sheet.project_id)) {
      await requireAuthorization({ permission: "takeoff.read", supabase, orgId, userId, projectId: sheet.project_id, logDecision: true })
      projects.add(sheet.project_id)
    }
    let isCurrent = row.sheet_version_id === null
    const versions = Array.isArray(raw.drawing_sheet_versions) ? raw.drawing_sheet_versions : raw.drawing_sheet_versions == null ? [] : [raw.drawing_sheet_versions]
    if (row.sheet_version_id) {
      if (versions.length !== 1) throw new Error("Condition measurement version unavailable")
      const version = z.object({ id: z.string().uuid(), org_id: z.string().uuid(), drawing_sheet_id: z.string().uuid(), drawing_revision_id: z.string().uuid() }).parse(versions[0])
      const source = versions[0] as Record<string, unknown>
      const revisions = Array.isArray(source.drawing_revisions) ? source.drawing_revisions : [source.drawing_revisions]
      if (revisions.length !== 1) throw new Error("Condition measurement revision unavailable")
      const revision = z.object({ id: z.string().uuid(), org_id: z.string().uuid(), project_id: z.string().uuid() }).parse(revisions[0])
      if (version.id !== row.sheet_version_id || version.org_id !== orgId || version.drawing_sheet_id !== row.drawing_sheet_id || revision.id !== version.drawing_revision_id || revision.org_id !== orgId || revision.project_id !== sheet.project_id) throw new Error("Condition measurement version ancestry differs")
      isCurrent = version.drawing_revision_id === sheet.current_revision_id
    } else if (versions.length) throw new Error("Legacy condition measurement has unexpected version evidence")
    const geometry = markupDataSchema.parse(row.data)
    if (!isMeasuringMarkupType(geometry.type) || geometry.points.some(point => point.some(value => !Number.isFinite(value)))) throw new Error("Condition measurement geometry unavailable")
    const condition = byId.get(row.condition_id)
    if (!condition) throw new Error("Condition measurement membership unavailable")
    const measurement = storedConditionMeasurementSchema.parse(condition)
    const unit = MEASURING_TYPE_UOM[geometry.type]
    if (unit !== conditionSourceUom(measurement.uom, measurement) || row.uom !== unit && !(row.uom === null && row.quantity === null)) throw new Error("Condition measurement unit differs")
    const style = z.record(z.unknown()).parse(row.data.style ?? {})
    const deduction = z.boolean().optional().parse(style.deduction) ?? false
    const parent = z.string().uuid().nullish().parse(style.parent_area_id)
    if (parent && geometry.type !== "area") throw new Error("Only an area measurement can have a deduction parent")
    let pending = false
    if (style.reanchor != null) {
      const review = z.object({ state: z.enum(["needs_review", "orphaned"]), from_version_id: z.string().uuid().nullable(), to_version_id: z.string().uuid().nullable(), reason: z.enum(["region_changed", "no_successor", "not_attempted", "scale_changed"]), queued_at: z.string().datetime({ offset: true }) }).parse(style.reanchor)
      if (review.to_version_id !== null && review.to_version_id !== row.sheet_version_id) throw new Error("Condition measurement review target differs")
      if (review.state === "orphaned" && isCurrent) throw new Error("Orphaned measurements must be resolved before current pricing")
      pending = review.state === "needs_review"
    }
    const scope = scopeMembers.get(row.condition_id) ?? []
    scope.push(raw); scopeMembers.set(row.condition_id, scope)
    members.push({ id: row.id, condition_id: row.condition_id, quantity: row.quantity, sheet_version_id: row.sheet_version_id, drawing_sheet_id: row.drawing_sheet_id, sheet_number: sheet.sheet_number ?? "—", sheet_title: sheet.sheet_title, is_current_version: isCurrent, pending_review: pending, is_deduction: deduction })
  }
  for (const [conditionId, rows] of scopeMembers) {
    const condition = byId.get(conditionId)
    if (!condition) throw new Error("Condition measurement scope disappeared")
    await assertMarkupsInScope(supabase, orgId, condition, rows)
  }
  return members
}

/**
 * Every destination a condition can be pushed to, and the column naming its
 * target. The panel's badge reads all three: a condition synced only to a bid
 * package used to show as never-synced, which meant its drift was invisible
 * until someone opened the sync dialog.
 */
const SYNC_STATE_SOURCES: ReadonlyArray<{
  destination: TakeoffDestination
  table: string
  targetColumn: string
}> = [
  { destination: "change_order", table: "change_order_lines", targetColumn: "change_order_id" },
  { destination: "estimate", table: "estimate_items", targetColumn: "estimate_id" },
  { destination: "bid_scope", table: "bid_scope_items", targetColumn: "bid_package_id" },
  {
    destination: "plan_takeoff",
    table: "house_plan_takeoff_lines",
    targetColumn: "house_plan_version_id",
  },
]

/**
 * Where each condition was last pushed. Read from the destination line's own
 * metadata rather than a join table — the provenance belongs with the money,
 * so deleting the takeoff never silently rewrites an estimate.
 */
async function loadSyncStates(
  supabase: SupabaseClient,
  orgId: string,
  conditionIds: string[],
  projectId?: string,
  history?: Map<string, Array<Omit<ConditionSyncState, "quantity_changed">>>,
): Promise<Map<string, Omit<ConditionSyncState, "quantity_changed">>> {
  z.string().uuid().parse(orgId)
  const ids = z.array(z.string().uuid()).max(CONDITION_READ_CAP).parse(conditionIds)
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate sync condition references")
  if (projectId !== undefined) z.string().uuid().parse(projectId)
  const states = new Map<string, Omit<ConditionSyncState, "quantity_changed">>()
  if (!ids.length) return states
  const requested = new Set(ids)
  let lineCount = 0
  const seen = new Set<string>()

  // Validate every matching line, including older lines that do not win the badge.
  // A short provider page is not evidence that the destination is exhausted.
  for (const source of SYNC_STATE_SOURCES) {
    for (const conditionIdChunk of chunk(ids, ID_CHUNK_SIZE)) {
      const batch = new Set(conditionIdChunk)
      const rows = await readAllRowsById(async (afterId, limit) => {
        let query = supabase.from(source.table)
          .select(`id, org_id, ${source.targetColumn}, quantity, metadata`)
          .eq("org_id", orgId)
          .in("metadata->takeoff->>condition_id", conditionIdChunk)
          .order("id", { ascending: true }).limit(limit)
        if (afterId) query = query.gt("id", afterId)
        const result = await query.returns<Array<{ id: string; org_id: string; metadata: { takeoff?: { condition_id?: string } }; [key: string]: unknown }>>()
        if (result.data?.some(row => row.org_id !== orgId || !batch.has(row.metadata?.takeoff?.condition_id ?? ""))) {
          throw new Error("Takeoff sync line scope unavailable")
        }
        return result
      }, { cap: 200_000, pageSize: 1000, label: "Takeoff sync lines" })
      for (const row of rows) {
        const key = `${source.destination}:${row.id}`
        if (seen.has(key) || ++lineCount > 200_000) throw new Error("Takeoff sync line validation limit or duplicate evidence")
        seen.add(key)
        const candidate = parseSyncState(row, source.destination, row[source.targetColumn])
        selectLatestSyncState(states, candidate.conditionId, candidate.state)
        if (history) {
          const entries = history.get(candidate.conditionId) ?? []
          entries.push(candidate.state)
          history.set(candidate.conditionId, entries)
        }
      }
    }
  }

  if (projectId) {
    const { data: rawProject, error } = await supabase.from("projects").select("id,org_id,prospect_id")
      .eq("org_id", orgId).eq("id", projectId).maybeSingle()
    if (error) throw new Error("Unable to load estimate measurement status.")
    const project = z.object({ id: z.literal(projectId), org_id: z.literal(orgId), prospect_id: z.string().uuid().nullable() }).parse(rawProject)
    if (project.prospect_id) {
      const { getPreconWorkspace } = await import("./precon-workspace")
      const workspace = await getPreconWorkspace(project.prospect_id)
      if (workspace.available === false) throw new Error("Pricing worksheet status unavailable")
      const worksheet = workspace.pricing
      if (worksheet) {
        if (!Array.isArray(worksheet.rows)) throw new Error("Pricing worksheet rows unavailable")
        for (const row of worksheet.rows) {
          const takeoff = row.metadata?.takeoff as Record<string, unknown> | undefined
          if (!takeoff || !requested.has(takeoff.condition_id as string)) continue
          if (++lineCount > 200_000) throw new Error("Takeoff sync line validation limit exceeded")
          const key = `pricing_worksheet:${row.id}`
          if (seen.has(key)) throw new Error("Duplicate pricing worksheet sync evidence")
          seen.add(key)
          const candidate = parseSyncState(row, "pricing_worksheet", project.prospect_id)
          selectLatestSyncState(states, candidate.conditionId, candidate.state)
          if (history) {
            const entries = history.get(candidate.conditionId) ?? []
            entries.push(candidate.state)
            history.set(candidate.conditionId, entries)
          }
        }
      }
    }
  }
  return states
}

/** Parse raw quantities before coercion; absent amounts cannot mean zero. */
function parseSyncState(raw: unknown, destination: TakeoffDestination, targetId: unknown): {
  conditionId: string; state: Omit<ConditionSyncState, "quantity_changed">
} {
  const row = z.object({ id: z.string().uuid(), quantity: storedMeasurementQuantitySchema,
    metadata: z.object({ takeoff: z.object({ condition_id: z.string().uuid(), measured_quantity: storedMeasurementQuantitySchema,
      synced_at: z.string().refine(value => timestampMicros(value) !== null).nullable().optional(),
      detached: z.boolean().optional(), evidence_only: z.boolean().optional() }) }) }).parse(raw)
  const live = row.quantity, synced = row.metadata.takeoff.measured_quantity
  if (live === null || synced === null || synced < 0) throw new Error("Takeoff sync quantities unavailable")
  return { conditionId: row.metadata.takeoff.condition_id, state: {
    destination, target_id: z.string().uuid().parse(targetId), line_id: row.id,
    synced_quantity: synced, synced_at: row.metadata.takeoff.synced_at ?? null,
    hand_edited: !(destination === "pricing_worksheet" && row.metadata.takeoff.evidence_only === true)
      && Math.abs(live - synced) > QUANTITY_EPSILON,
    detached: row.metadata.takeoff.detached ?? false,
  } }
}

/** Actual instants, including offsets and microseconds; stable tie across destinations. */
function selectLatestSyncState(
  states: Map<string, Omit<ConditionSyncState, "quantity_changed">>, conditionId: string,
  candidate: Omit<ConditionSyncState, "quantity_changed">,
): void {
  const current = states.get(conditionId)
  const candidateTime = candidate.synced_at === null ? null : timestampMicros(candidate.synced_at)
  const currentTime = current?.synced_at == null ? null : timestampMicros(current.synced_at)
  if (!current || (candidateTime !== null && (currentTime === null || candidateTime > currentTime))
    || (candidateTime === currentTime && `${candidate.destination}:${candidate.line_id}` < `${current.destination}:${current.line_id}`)) {
    states.set(conditionId, candidate)
  }
}

/**
 * The sheet to land on when someone deep-links to a condition from an estimate
 * line: whichever one carries the most of it. Null when the condition has no
 * measurements yet, in which case the viewer opens normally.
 */
export async function getConditionLandingSheet(
  conditionId: string,
  orgId?: string,
): Promise<{ drawing_sheet_id: string } | null> {
  z.string().uuid().parse(conditionId)
  const context = await requireOrgContext(orgId)
  z.string().uuid().parse(context.orgId)
  z.string().uuid().parse(context.userId)
  const loadCondition = async () => {
    const { data, error } = await context.supabase.from("takeoff_conditions").select(CONDITION_SELECT)
      .eq("org_id", context.orgId).eq("id", conditionId).maybeSingle()
    if (error || !data) throw new Error("Condition unavailable. Reload before retrying.")
    const condition = readStoredTakeoffCondition(data)
    if (condition.id !== conditionId || condition.org_id !== context.orgId) throw new Error("Condition landing scope unavailable")
    return condition
  }
  const condition = await loadCondition()
  const scope: Scope = condition.project_id ? { project_id: condition.project_id }
    : { house_plan_version_id: condition.house_plan_version_id! }
  await authorizeTakeoffReadScope(context, scope)
  const members = await loadConditionMembers(context, [condition])
  const current = members.filter(member => member.is_current_version)
  const confirmed = current.filter(member => !member.pending_review)
  // Prefer current accepted evidence; when all current marks need review, land
  // on that review evidence. Genuine unscaled marks still provide a sheet.
  const sheets = buildSheetBreakdown(confirmed.length ? confirmed : current, condition)
  if (sheets.some(sheet => !Number.isFinite(sheet.quantity))) throw new Error("Condition landing quantities exceed supported precision")
  sheets.sort((a, b) => b.quantity - a.quantity || a.drawing_sheet_id.localeCompare(b.drawing_sheet_id))
  if (!isDeepStrictEqual(condition, await loadCondition())) throw new Error("Condition changed. Reload before retrying.")
  await authorizeTakeoffReadScope(context, scope)
  return sheets.length ? { drawing_sheet_id: sheets[0].drawing_sheet_id } : null
}

// ============================================================================
// SYNC
// ============================================================================

/**
 * What `syncConditions` would do, without doing it. The dialog shows this and
 * makes the user resolve every `drift` row before the write is allowed.
 */
export async function previewConditionSync(
  input: SyncConditionsInput,
  orgId?: string,
): Promise<ConditionSyncPreviewRow[]> {
  const parsed = syncConditionsSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("takeoff.read", { supabase, orgId: resolvedOrgId, userId })

  const { rollups, existingLines } = await loadSyncInputs(
    { supabase, orgId: resolvedOrgId, userId },
    parsed,
  )

  return rollups.map((rollup) => {
    const existing = existingLines.get(rollup.condition.id)
    const next = rollup.effective_quantity
    const live = existing ? Number(existing.evidenceOnly ? existing.metadata.takeoff?.measured_quantity ?? 0 : existing.quantity ?? 0) : null
    const lastSynced = existing ? Number(existing.lastSyncedQuantity ?? 0) : null

    const action = existing && !existing.metadata.takeoff ? "update" : classifySyncRow({
      nextQuantity: next, liveQuantity: live, lastSyncedQuantity: lastSynced,
    })

    return {
      condition_id: rollup.condition.id,
      condition_name: rollup.condition.name,
      uom: rollup.condition.uom,
      current_quantity: live,
      next_quantity: next,
      unit_cost_cents: rollup.effective_unit_cost_cents,
      action,
      evidence_only: existing?.evidenceOnly,
      reprice_required: existing?.metadata.__reprice_required === true,
      blocked_reason: parsed.destination === "change_order" && existing?.evidenceOnly ? "Review linked trade costs in change-order pricing before changing this quantity." : rollup.pending_review_count || rollup.unscaled_markup_count ? "Review revised measurements and calibrate sheets before applying quantities." : undefined,
      // Only meaningful on drift: the number the last sync wrote, which is what
      // makes "someone typed over this" visible rather than just asserted.
      ...(action === "drift" ? { last_synced_quantity: lastSynced ?? 0 } : {}),
    }
  })
}

interface ExistingLine {
  id: string
  quantity: number
  lastSyncedQuantity: number | null
  metadata: Record<string, any>
  evidenceOnly?: boolean
}

async function loadSyncInputs(
  context: TakeoffReadContext,
  parsed: SyncConditionsInput,
): Promise<{ rollups: ConditionRollup[]; existingLines: Map<string, ExistingLine> }> {
  const { supabase, orgId } = context
  const { data: conditionRows } = await supabase
    .from("takeoff_conditions")
    .select("id, project_id, house_plan_version_id")
    .eq("org_id", orgId)
    .in("id", parsed.condition_ids)

  if (!conditionRows || conditionRows.length === 0) {
    throw new Error("No takeoff conditions to sync")
  }

  const projectIds = new Set(conditionRows.map((c) => c.project_id).filter(Boolean))
  const versionIds = new Set(conditionRows.map((c) => c.house_plan_version_id).filter(Boolean))
  if (projectIds.size + versionIds.size !== 1) {
    throw new Error("All conditions in one sync must share a scope")
  }

  if (conditionRows.length !== new Set(parsed.condition_ids).size) {
    throw new Error("Some takeoff conditions are unavailable")
  }
  const targets = projectIds.size === 1
    ? await listSyncTargets(Array.from(projectIds)[0] as string, orgId)
    : await listPlanVersionTarget(Array.from(versionIds)[0] as string, orgId)
  const target = targets.find((candidate) => candidate.id === parsed.target_id && candidate.destination === parsed.destination)
  if (!target) throw new Error("The destination does not belong to this takeoff workspace")
  if (!target.writable) throw new Error(target.blocked_reason ?? "The destination is read-only")

  const rollups = (
    await getConditionRollupWithContext(
      context,
      projectIds.size === 1
        ? { project_id: Array.from(projectIds)[0] as string }
        : { house_plan_version_id: Array.from(versionIds)[0] as string },
    )
  ).filter((r) => parsed.condition_ids.includes(r.condition.id))

  const existingLines = await loadExistingDestinationLines(
    supabase,
    orgId,
    parsed.destination,
    parsed.target_id,
    parsed.condition_ids,
  )

  if (parsed.line_mappings && Object.keys(parsed.line_mappings).length) {
    if (parsed.destination !== "pricing_worksheet") throw new Error("Row mapping is only supported for the working estimate.")
    const { getPreconWorkspace } = await import("./precon-workspace")
    const worksheet = (await getPreconWorkspace(parsed.target_id)).pricing
    const mappedRows = Object.values(parsed.line_mappings)
    if (new Set(mappedRows).size !== mappedRows.length) throw new Error("Choose a different scope item for each measured quantity.")
    for (const [conditionId, rowId] of Object.entries(parsed.line_mappings)) {
      const rollup = rollups.find(item => item.condition.id === conditionId)
      const row = worksheet?.rows.find(item => item.id === rowId)
      if (!row || !rollup) throw new Error("The selected scope item is no longer available.")
      const linked = (row.metadata.takeoff_source ?? row.metadata.takeoff) as { condition_id?: string } | undefined
      if (linked?.condition_id && linked.condition_id !== conditionId) throw new Error("That scope item already has another measurement source.")
      if ([...existingLines].some(([id, line]) => id !== conditionId && line.id === rowId)) throw new Error("A scope item can only receive one measured quantity.")
      const evidenceOnly = !!worksheet?.requests.some(request => request.quote && request.row_ids.includes(row.id))
      const { measurementUnit } = await import("@/lib/drawings/measurement-context")
      if (!evidenceOnly && measurementUnit(row.unit) && measurementUnit(row.unit) !== rollup.condition.uom) throw new Error("The measurement unit does not match the scope item. Review the unit in the estimate first.")
      existingLines.set(conditionId, { id: row.id, quantity: row.quantity, lastSyncedQuantity: (row.metadata.takeoff as any)?.measured_quantity ?? null, metadata: { ...row.metadata, __reprice_required: !evidenceOnly && !measurementUnit(row.unit) && row.unit_cost_cents !== null }, evidenceOnly })
    }
  }
  return { rollups, existingLines }
}

async function loadExistingDestinationLines(
  supabase: SupabaseClient,
  orgId: string,
  destination: TakeoffDestination,
  targetId: string,
  conditionIds: string[],
): Promise<Map<string, ExistingLine>> {
  const map = new Map<string, ExistingLine>()

  if (destination === "pricing_worksheet") {
    const { getPreconWorkspace } = await import("./precon-workspace")
    const workspace = await getPreconWorkspace(targetId)
    for (const row of workspace.pricing?.rows ?? []) {
      const takeoff = (row.metadata.takeoff_source ?? row.metadata.takeoff) as { condition_id?: string; measured_quantity?: number } | undefined
      if (!takeoff?.condition_id || !conditionIds.includes(takeoff.condition_id)) continue
      map.set(takeoff.condition_id, { id: row.id, quantity: row.quantity, lastSyncedQuantity: (row.metadata.takeoff as any)?.measured_quantity ?? null, metadata: row.metadata, evidenceOnly: !!workspace.pricing?.requests.some(request => request.quote && request.row_ids.includes(row.id)) })
    }
    return map
  }

  if (destination === "change_order") {
    const { data, error } = await supabase.from("change_order_lines").select("id,quantity,metadata,commitment_change_order_id").eq("org_id", orgId).eq("change_order_id", targetId).in("metadata->takeoff->>condition_id", conditionIds)
    if (error) throw new Error("Unable to load measured change-order lines.")
    for (const row of data ?? []) {
      const metadata = row.metadata ?? {}
      map.set(metadata.takeoff.condition_id, { id: row.id, quantity: Number(row.quantity), lastSyncedQuantity: metadata.takeoff.measured_quantity ?? null, metadata, evidenceOnly: !!row.commitment_change_order_id })
    }
    return map
  }

  if (destination === "estimate") {
    const { data } = await supabase
      .from("estimate_items")
      .select("id, quantity, metadata")
      .eq("org_id", orgId)
      .eq("estimate_id", targetId)
      .in("metadata->takeoff->>condition_id", conditionIds)
    for (const row of data ?? []) {
      const metadata = (row.metadata ?? {}) as Record<string, any>
      const conditionId = metadata.takeoff?.condition_id as string | undefined
      if (!conditionId) continue
      map.set(conditionId, {
        id: row.id as string,
        quantity: Number(row.quantity ?? 0),
        lastSyncedQuantity:
          metadata.takeoff?.measured_quantity === undefined
            ? null
            : Number(metadata.takeoff.measured_quantity),
        metadata,
      })
    }
    return map
  }

  if (destination === "bid_scope") {
    const { data } = await supabase
      .from("bid_scope_items")
      .select("id, quantity, details, metadata, bid_package_id")
      .eq("org_id", orgId)
      .eq("bid_package_id", targetId)
    for (const row of data ?? []) {
      const metadata = (row.metadata ?? {}) as Record<string, any>
      const fromMetadata = metadata.takeoff?.condition_id as string | undefined
      // Legacy rows synced before bid_scope_items had metadata carried
      // provenance as a marker line inside `details`; still honored on read.
      const legacy = fromMetadata ? null : parseScopeProvenance(row.details as string | null)
      const conditionId = fromMetadata ?? legacy?.condition_id
      if (!conditionId || !conditionIds.includes(conditionId)) continue
      map.set(conditionId, {
        id: row.id as string,
        quantity: Number(row.quantity ?? 0),
        lastSyncedQuantity: fromMetadata
          ? metadata.takeoff?.measured_quantity === undefined
            ? null
            : Number(metadata.takeoff.measured_quantity)
          : (legacy?.measured_quantity ?? null),
        metadata,
      })
    }
    return map
  }

  const { data } = await supabase
    .from("house_plan_takeoff_lines")
    .select("id, quantity, metadata")
    .eq("org_id", orgId)
    .eq("house_plan_version_id", targetId)
    .in("metadata->takeoff->>condition_id", conditionIds)
  for (const row of data ?? []) {
    const metadata = (row.metadata ?? {}) as Record<string, any>
    const conditionId = metadata.takeoff?.condition_id as string | undefined
    if (!conditionId) continue
    map.set(conditionId, {
      id: row.id as string,
      quantity: Number(row.quantity ?? 0),
      lastSyncedQuantity:
        metadata.takeoff?.measured_quantity === undefined
          ? null
          : Number(metadata.takeoff.measured_quantity),
      metadata,
    })
  }
  return map
}

const SCOPE_PROVENANCE_PREFIX = "arc-takeoff:"

/** Read-only legacy support: rows synced before bid_scope_items.metadata existed. */
function parseScopeProvenance(
  details: string | null,
): { condition_id: string; measured_quantity: number } | null {
  if (!details) return null
  const line = details
    .split("\n")
    .find((entry) => entry.trim().startsWith(SCOPE_PROVENANCE_PREFIX))
  if (!line) return null
  const [, conditionId, quantity] = line.trim().split(":")
  if (!conditionId) return null
  return { condition_id: conditionId, measured_quantity: Number(quantity ?? 0) }
}

export interface SyncResult {
  created: number
  updated: number
  skipped: number
  unchanged: number
}

/**
 * Push conditions onto a money surface. Every write carries provenance
 * (`metadata.takeoff`) so a later sync can tell "this line came from that
 * condition and nobody has touched it since" from "someone typed over it".
 */
export async function syncConditions(
  input: SyncConditionsInput,
  orgId?: string,
): Promise<SyncResult> {
  const parsed = syncConditionsSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("takeoff.write", { supabase, orgId: resolvedOrgId, userId })

  const { rollups, existingLines } = await loadSyncInputs(
    { supabase, orgId: resolvedOrgId, userId },
    parsed,
  )
  if (parsed.reviewed_line_quantities) {
    for (const row of rollups) {
      const existing = existingLines.get(row.condition.id)
      const live = existing ? existing.evidenceOnly ? Number(existing.metadata.takeoff?.measured_quantity ?? 0) : Number(existing.quantity) : null
      const reviewed = parsed.reviewed_line_quantities[row.condition.id]
      if (reviewed === undefined || (reviewed === null) !== (live === null) || reviewed !== null && live !== null && Math.abs(reviewed - live) > QUANTITY_EPSILON) throw new Error("The estimate or change-order quantity changed after review. Review the latest value before applying measurements.")
    }
  }
  if (parsed.reviewed_quantities && rollups.some(row => parsed.reviewed_quantities?.[row.condition.id] === undefined || Math.abs(parsed.reviewed_quantities[row.condition.id] - row.effective_quantity) > QUANTITY_EPSILON)) throw new Error("Measurements changed after review. Reopen the quantity review before applying them.")
  if (rollups.some(row => row.pending_review_count || row.unscaled_markup_count)) throw new Error("Review revised measurements and calibrate sheets before applying quantities.")
  const syncedAt = new Date().toISOString()
  const result: SyncResult = { created: 0, updated: 0, skipped: 0, unchanged: 0 }

  if (parsed.destination === "change_order") {
    const { syncChangeOrderMeasurements } = await import("./takeoff-change-order")
    return syncChangeOrderMeasurements(parsed, rollups)
  }

  if (parsed.destination === "pricing_worksheet") {
    const [{ getPreconWorkspace }, { savePricingWorksheet }, { EMPTY_PRICING_WORKSHEET, pricingRowSchema }] = await Promise.all([
      import("./precon-workspace"), import("./precon-pricing"), import("@/lib/precon/pricing-worksheet"),
    ])
    const workspace = await getPreconWorkspace(parsed.target_id)
    const worksheet = workspace.pricing ?? { ...EMPTY_PRICING_WORKSHEET, rows: [], requests: [] }
    for (const rollup of rollups) {
      const linked = existingLines.get(rollup.condition.id)
      const existing = linked ? worksheet.rows.find(row => row.id === linked.id) : undefined
      if (linked && !existing) throw new Error("The scope item changed. Review the estimate and try again.")
      const currentLink = (existing?.metadata.takeoff_source ?? existing?.metadata.takeoff) as { condition_id?: string } | undefined
      if (currentLink?.condition_id && currentLink.condition_id !== rollup.condition.id) throw new Error("The scope item was linked to another measurement. Review it again.")
      const evidenceOnly = !!existing && worksheet.requests.some(request => request.quote && request.row_ids.includes(existing.id))
      const prior = existing?.metadata.takeoff as { measured_quantity?: number } | undefined
      if (parsed.reviewed_line_quantities) {
        const reviewed = parsed.reviewed_line_quantities[rollup.condition.id]
        const live = existing ? evidenceOnly ? prior?.measured_quantity ?? 0 : existing.quantity : null
        if (reviewed === undefined || (reviewed === null) !== (live === null) || reviewed !== null && live !== null && Math.abs(reviewed - live) > QUANTITY_EPSILON) throw new Error("The scope quantity changed after review. Review the latest value before applying measurements.")
      }
      const action = existing && !prior ? "update" : classifySyncRow({ nextQuantity: rollup.effective_quantity, liveQuantity: evidenceOnly ? prior?.measured_quantity ?? null : existing?.quantity ?? null, lastSyncedQuantity: prior?.measured_quantity ?? null })
      if (action === "drift" && parsed.drift_resolution?.[rollup.condition.id] !== "overwrite") { result.skipped++; continue }
      if (action === "unchanged") { result.unchanged++; continue }
      const metadata = { ...existing?.metadata, takeoff_source: { condition_id: rollup.condition.id, uom: rollup.condition.uom }, takeoff: { ...buildTakeoffProvenance({ condition: rollup.condition, quantity: rollup.effective_quantity, rate: rollup.effective_unit_cost_cents ?? 0, syncedAt }), evidence_only: evidenceOnly, net_quantity: rollup.measured_quantity, deduction_count: rollup.deduction_count, measurement_count: rollup.markup_count, sheets: rollup.sheets } }
      if (existing) {
        if (!evidenceOnly) {
          const { measurementUnit } = await import("@/lib/drawings/measurement-context")
          const previousUnit = measurementUnit(existing.unit)
          if (previousUnit && previousUnit !== rollup.condition.uom) throw new Error("The scope unit changed. Review it in the estimate before applying quantities.")
          if (!previousUnit) existing.unit_cost_cents = null
          existing.quantity = rollup.effective_quantity
          existing.unit = rollup.condition.uom
        }
        existing.metadata = metadata
        result.updated++
      } else {
        worksheet.rows.push(pricingRowSchema.parse({ id: crypto.randomUUID(), description: rollup.condition.name, quantity: rollup.effective_quantity, unit: rollup.condition.uom, unit_cost_cents: rollup.effective_unit_cost_cents, cost_code_id: rollup.condition.cost_code_id ?? null, metadata }))
        result.created++
      }
    }
    if (result.created + result.updated > 0) await savePricingWorksheet(parsed.target_id, worksheet, workspace.version)
    return result
  }

  // One COUNT for the whole batch, not one per inserted line.
  let nextSortOrder = await countDestinationLines(
    supabase,
    resolvedOrgId,
    parsed.destination,
    parsed.target_id,
  )

  for (const rollup of rollups) {
    const condition = rollup.condition
    let existing = existingLines.get(condition.id)
    const next = rollup.effective_quantity
    const rate = rollup.effective_unit_cost_cents ?? 0

    if (!existing) {
      const inserted = await insertDestinationLine(
        supabase,
        resolvedOrgId,
        parsed.destination,
        parsed.target_id,
        { condition, quantity: next, rate, syncedAt, userId, sortOrder: nextSortOrder },
      )
      if (inserted === "created") {
        nextSortOrder += 1
        result.created += 1
      } else {
        // Unique-index conflict: a concurrent sync already created this line.
        // Recover by reloading it and falling through to the update path.
        const reloaded = await loadExistingDestinationLines(
          supabase,
          resolvedOrgId,
          parsed.destination,
          parsed.target_id,
          [condition.id],
        )
        existing = reloaded.get(condition.id)
        if (!existing) {
          throw new Error(`Sync conflict on "${condition.name}" could not be resolved`)
        }
      }
    }

    if (existing) {
      const lastSynced = existing.lastSyncedQuantity ?? 0
      const handEdited = Math.abs(existing.quantity - lastSynced) > QUANTITY_EPSILON
      // A hand-edited line is only overwritten on an explicit instruction.
      if (handEdited && parsed.drift_resolution?.[condition.id] !== "overwrite") {
        result.skipped += 1
        continue
      }
      if (!handEdited && Math.abs(existing.quantity - next) <= QUANTITY_EPSILON) {
        result.unchanged += 1
        continue
      }
      await updateDestinationLine(supabase, resolvedOrgId, parsed.destination, existing, {
        condition,
        quantity: next,
        rate,
        syncedAt,
      })
      result.updated += 1
    }

    await recordEvent({
      orgId: resolvedOrgId,
      eventType: "takeoff_condition_synced",
      entityType: "takeoff_condition",
      entityId: condition.id,
      payload: {
        destination: parsed.destination,
        target_id: parsed.target_id,
        quantity: next,
        uom: condition.uom,
        unit_cost_cents: rate,
      },
    })
  }

  if (parsed.destination === "estimate" && result.created + result.updated > 0) {
    await recalculateEstimateTotals(supabase, resolvedOrgId, parsed.target_id)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: parsed.destination === "estimate" ? "estimate" : "takeoff_condition",
    entityId: parsed.target_id,
    after: { takeoff_sync: result, condition_ids: parsed.condition_ids },
  })

  return result
}

interface LineWritePayload {
  condition: TakeoffCondition
  quantity: number
  rate: number
  syncedAt: string
}

function buildTakeoffProvenance(payload: LineWritePayload) {
  return {
    condition_id: payload.condition.id,
    condition_name: payload.condition.name,
    // Despite the name (kept for data compatibility), this is the WASTE-ADJUSTED
    // quantity — the same number written to the line — because hand-edit
    // detection compares it against the line's live quantity.
    measured_quantity: payload.quantity,
    waste_pct: payload.condition.waste_pct,
    uom: payload.condition.uom,
    synced_at: payload.syncedAt,
  }
}

async function countDestinationLines(
  supabase: SupabaseClient,
  orgId: string,
  destination: TakeoffDestination,
  targetId: string,
): Promise<number> {
  const table =
    destination === "estimate"
      ? "estimate_items"
      : destination === "bid_scope"
        ? "bid_scope_items"
        : "house_plan_takeoff_lines"
  const targetColumn =
    destination === "estimate"
      ? "estimate_id"
      : destination === "bid_scope"
        ? "bid_package_id"
        : "house_plan_version_id"

  const { count } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq(targetColumn, targetId)
  return count ?? 0
}

/** 23505 = unique_violation: a concurrent sync already created this line. */
const UNIQUE_VIOLATION = "23505"

async function insertDestinationLine(
  supabase: SupabaseClient,
  orgId: string,
  destination: TakeoffDestination,
  targetId: string,
  payload: LineWritePayload & { userId: string; sortOrder: number },
): Promise<"created" | "conflict"> {
  const { condition, quantity, rate, sortOrder } = payload
  const provenance = buildTakeoffProvenance(payload)

  if (destination === "estimate") {
    // The condition's rate is a COST; the estimate's default markup turns it
    // into the client price, same as a hand-typed line left on the default.
    const { data: target } = await supabase
      .from("estimates")
      .select("metadata")
      .eq("org_id", orgId)
      .eq("id", targetId)
      .maybeSingle()
    const defaultMarkupPct = Number((target?.metadata as any)?.markup_percent ?? 0) || 0

    const { error } = await supabase.from("estimate_items").insert({
      org_id: orgId,
      estimate_id: targetId,
      cost_code_id: condition.cost_code_id,
      item_type: "line",
      description: condition.name,
      quantity,
      unit: condition.uom,
      unit_cost_cents: rate,
      markup_pct: defaultMarkupPct,
      sort_order: sortOrder,
      metadata: { takeoff: provenance },
    })
    if (error?.code === UNIQUE_VIOLATION) return "conflict"
    if (error) throw new Error(`Failed to add estimate line: ${error.message}`)
    return "created"
  }

  if (destination === "bid_scope") {
    const { error } = await supabase.from("bid_scope_items").insert({
      org_id: orgId,
      bid_package_id: targetId,
      position: sortOrder,
      // A measured quantity is exactly what a unit-price line is for: the sub
      // prices per unit and the quantity stays the builder's number.
      item_type: "unit_price",
      description: condition.name,
      quantity,
      unit: condition.uom,
      budget_cents: rate ? extendedCents(quantity, rate) : null,
      cost_code_id: condition.cost_code_id,
      created_by: payload.userId,
      metadata: { takeoff: provenance },
    })
    if (error?.code === UNIQUE_VIOLATION) return "conflict"
    if (error) throw new Error(`Failed to add bid scope line: ${error.message}`)
    return "created"
  }

  const { error } = await supabase.from("house_plan_takeoff_lines").insert({
    org_id: orgId,
    house_plan_version_id: targetId,
    // Per-elevation conditions are deliberately out of scope for v1; every
    // measured line lands on the base plan.
    elevation_id: null,
    cost_code_id: condition.cost_code_id,
    description: condition.name,
    quantity,
    uom: condition.uom,
    unit_cost_cents: rate || null,
    sort_order: sortOrder,
    metadata: { takeoff: provenance },
  })
  if (error?.code === UNIQUE_VIOLATION) return "conflict"
  if (error) throw new Error(`Failed to add plan takeoff line: ${error.message}`)
  return "created"
}

async function updateDestinationLine(
  supabase: SupabaseClient,
  orgId: string,
  destination: TakeoffDestination,
  existing: ExistingLine,
  payload: LineWritePayload,
): Promise<void> {
  const { condition, quantity, rate } = payload
  const provenance = buildTakeoffProvenance(payload)

  if (destination === "estimate") {
    const { error } = await supabase
      .from("estimate_items")
      .update({
        quantity,
        unit: condition.uom,
        unit_cost_cents: rate,
        cost_code_id: condition.cost_code_id,
        metadata: { ...existing.metadata, takeoff: provenance },
      })
      .eq("org_id", orgId)
      .eq("id", existing.id)
    if (error) throw new Error(`Failed to update estimate line: ${error.message}`)
    return
  }

  if (destination === "bid_scope") {
    // `details` is the sub-facing scope text — never touched by a sync.
    const { error } = await supabase
      .from("bid_scope_items")
      .update({
        quantity,
        unit: condition.uom,
        budget_cents: rate ? extendedCents(quantity, rate) : null,
        cost_code_id: condition.cost_code_id,
        metadata: { ...existing.metadata, takeoff: provenance },
      })
      .eq("org_id", orgId)
      .eq("id", existing.id)
    if (error) throw new Error(`Failed to update bid scope line: ${error.message}`)
    return
  }

  const { error } = await supabase
    .from("house_plan_takeoff_lines")
    .update({
      quantity,
      uom: condition.uom,
      unit_cost_cents: rate || null,
      cost_code_id: condition.cost_code_id,
      metadata: { ...existing.metadata, takeoff: provenance },
    })
    .eq("org_id", orgId)
    .eq("id", existing.id)
  if (error) throw new Error(`Failed to update plan takeoff line: ${error.message}`)
}

/**
 * Estimate header totals are denormalized, so writing lines behind the
 * estimate service's back means recomputing them here — through the same
 * single-source math the rest of the app uses.
 */
async function recalculateEstimateTotals(
  supabase: SupabaseClient,
  orgId: string,
  estimateId: string,
): Promise<void> {
  const [{ data: estimate }, { data: lines }] = await Promise.all([
    supabase
      .from("estimates")
      .select("id, metadata")
      .eq("org_id", orgId)
      .eq("id", estimateId)
      .maybeSingle(),
    supabase
      .from("estimate_items")
      .select("item_type, quantity, unit_cost_cents, markup_pct, metadata")
      .eq("org_id", orgId)
      .eq("estimate_id", estimateId),
  ])

  if (!estimate) return

  const taxRate = Number((estimate.metadata as any)?.tax_rate ?? 0)
  const contingencyPct = Number((estimate.metadata as any)?.contingency_percent ?? 0)
  const totals = calculateEstimateTotals(
    (lines ?? []).map((line: any) => ({
      item_type: line.item_type,
      quantity: Number(line.quantity ?? 0),
      unit_cost_cents: line.unit_cost_cents ?? 0,
      markup_pct: Number(line.markup_pct ?? 0),
      is_optional: (line.metadata ?? {}).is_optional === true,
    })),
    taxRate,
    contingencyPct,
  )

  await supabase
    .from("estimates")
    .update({
      subtotal_cents: totals.subtotal,
      tax_cents: totals.tax,
      total_cents: totals.total,
    })
    .eq("org_id", orgId)
    .eq("id", estimateId)
}
