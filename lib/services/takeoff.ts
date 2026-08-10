import "server-only"

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

import type { SupabaseClient } from "@supabase/supabase-js"

import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
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
} from "@/lib/drawings/measure"
import {
  classifySyncRow,
  rollUpCondition,
  CONDITION_SHEET_BREAKDOWN_CAP,
  type ConditionSheetBreakdown,
  type ConditionTotals,
  type RollupMember,
} from "@/lib/drawings/condition-rollup"
import { nextConditionColor } from "@/lib/drawings/takeoff-palette"
import {
  assignMarkupsToConditionSchema,
  conditionRollupFiltersSchema,
  createTakeoffConditionSchema,
  factorRuleViolation,
  syncConditionsSchema,
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

/**
 * Two estimators on one job is normal, and takeoff has no realtime layer. This
 * is not collaboration — it is the guard that stops the second save from
 * silently erasing the first. Callers that pass the `updated_at` they rendered
 * get this back instead of a lost edit.
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
  await requirePermission("takeoff.read", {
    supabase: context.supabase,
    orgId: context.orgId,
    userId: context.userId,
  })
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
  const scope = resolveScope(filters)
  const query = scopeFilter<any>(
    context.supabase
      .from("takeoff_conditions")
      .select(CONDITION_SELECT)
      .eq("org_id", context.orgId),
    scope,
  )

  const { data, error } = await query
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(CONDITION_LIST_CAP)

  if (error) {
    throw new Error(`Failed to list takeoff conditions: ${error.message}`)
  }
  return (data ?? []).map(mapCondition)
}

export async function createTakeoffCondition(
  input: CreateTakeoffConditionInput,
  orgId?: string,
): Promise<TakeoffCondition> {
  const parsed = createTakeoffConditionSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("takeoff.write", { supabase, orgId: resolvedOrgId, userId })

  const scope: Scope = parsed.project_id
    ? { project_id: parsed.project_id }
    : { house_plan_version_id: parsed.house_plan_version_id as string }

  // Color and position both derive from what is already in this scope, so a
  // new condition never collides with an existing one on the sheet.
  const siblings = await listSiblingsForPlacement(supabase, resolvedOrgId, scope)
  const color = parsed.color ?? nextConditionColor(siblings.map((s) => s.color))
  const sortOrder = siblings.length

  if (siblings.length >= CONDITION_LIST_CAP) {
    throw new Error(`A takeoff can hold at most ${CONDITION_LIST_CAP} conditions`)
  }

  const { data, error } = await supabase
    .from("takeoff_conditions")
    .insert({
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
    })
    .select(CONDITION_SELECT)
    .single()

  if (error || !data) {
    throw new Error(`Failed to create takeoff condition: ${error?.message}`)
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

  return mapCondition(data)
}

async function listSiblingsForPlacement(
  supabase: SupabaseClient,
  orgId: string,
  scope: Scope,
): Promise<Array<{ color: string }>> {
  const query = scopeFilter<any>(
    supabase.from("takeoff_conditions").select("color").eq("org_id", orgId),
    scope,
  )
  const { data } = await query.limit(CONDITION_LIST_CAP + 1)
  return (data ?? []) as Array<{ color: string }>
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
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("takeoff.write", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing } = await supabase
    .from("takeoff_conditions")
    .select(CONDITION_SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("id", conditionId)
    .maybeSingle()

  if (!existing) {
    throw new Error("Takeoff condition not found")
  }

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
    const { count } = await supabase
      .from("drawing_markups")
      .select("id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId)
      .eq("condition_id", conditionId)
    if ((count ?? 0) > 0) {
      throw new Error(
        `Setting a wall height changes what "${existing.name}" measures, from ` +
          `${MEASURE_UOM_LABELS[beforeSource]} to ${MEASURE_UOM_LABELS[afterSource]}. ` +
          `Release its ${count} measurement${count === 1 ? "" : "s"} first.`,
      )
    }
  }

  let updateQuery = supabase
    .from("takeoff_conditions")
    .update(payload)
    .eq("org_id", resolvedOrgId)
    .eq("id", conditionId)
  if (seenUpdatedAt) updateQuery = updateQuery.eq("updated_at", seenUpdatedAt)

  const { data, error } = await updateQuery.select(CONDITION_SELECT).maybeSingle()

  if (!error && !data && seenUpdatedAt) {
    throw new Error(STALE_WRITE)
  }
  if (error || !data) {
    throw new Error(`Failed to update takeoff condition: ${error?.message}`)
  }

  // The color IS the condition's identity on the sheet. Changing it here and
  // leaving the geometry painted in the old hex would break that link, so the
  // members are repainted in the same breath.
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

  return mapCondition(data)
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
): Promise<{ released_markups: number; detached_lines: number }> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("takeoff.write", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing } = await supabase
    .from("takeoff_conditions")
    .select(CONDITION_SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("id", conditionId)
    .maybeSingle()

  if (!existing) {
    throw new Error("Takeoff condition not found")
  }

  const detachedLines = await markSyncedLinesDetached(supabase, resolvedOrgId, conditionId)

  const { data: released, error: releaseError } = await supabase
    .from("drawing_markups")
    .update({ condition_id: null })
    .eq("org_id", resolvedOrgId)
    .eq("condition_id", conditionId)
    .select("id")

  if (releaseError) {
    throw new Error(`Failed to release measurements: ${releaseError.message}`)
  }

  const { error } = await supabase
    .from("takeoff_conditions")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("id", conditionId)

  if (error) {
    throw new Error(`Failed to delete takeoff condition: ${error.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "delete",
    entityType: "takeoff_condition",
    entityId: conditionId,
    before: existing,
  })

  return { released_markups: released?.length ?? 0, detached_lines: detachedLines }
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
  return Number(data ?? 0)
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
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("takeoff.write", { supabase, orgId: resolvedOrgId, userId })

  if (parsed.condition_id) {
    const { data: condition } = await supabase
      .from("takeoff_conditions")
      .select(CONDITION_SELECT)
      .eq("org_id", resolvedOrgId)
      .eq("id", parsed.condition_id)
      .maybeSingle()

    if (!condition) throw new Error("Takeoff condition not found")
    const mapped = mapCondition(condition)
    const sourceUom = conditionSourceUom(mapped.uom, mapped)

    const { data: markups } = await supabase
      .from("drawing_markups")
      .select("id, uom, drawing_sheet_id, drawing_sheets!inner(project_id)")
      .eq("org_id", resolvedOrgId)
      .in("id", parsed.markup_ids)

    const mismatched = (markups ?? []).filter((m) => m.uom !== sourceUom)
    if (mismatched.length > 0) {
      throw new Error(
        `${mismatched.length} of these measurements do not measure in ${MEASURE_UOM_LABELS[sourceUom]}` +
          (sourceUom !== mapped.uom
            ? ` — "${mapped.name}" reports ${MEASURE_UOM_LABELS[mapped.uom]}, measured as ${MEASURE_UOM_LABELS[sourceUom]}`
            : ""),
      )
    }

    // A condition may only claim geometry from its own scope. Without this a
    // caller could hand it markup ids from any project in the org and the org
    // filter alone would let them through — the quantities would be real, and
    // measured off somebody else's house.
    await assertMarkupsInScope(supabase, resolvedOrgId, mapped, markups ?? [])
  }

  const { data, error } = await supabase
    .from("drawing_markups")
    .update({ condition_id: parsed.condition_id })
    .eq("org_id", resolvedOrgId)
    .in("id", parsed.markup_ids)
    .select("id")

  if (error) {
    throw new Error(`Failed to assign measurements: ${error.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "takeoff_condition",
    entityId: parsed.condition_id ?? "unassigned",
    after: { markup_ids: parsed.markup_ids, condition_id: parsed.condition_id },
  })

  return data?.length ?? 0
}

/**
 * A condition may only claim geometry from its own scope.
 *
 * For a project condition that means the markup's sheet belongs to the same
 * project. For a plan-version condition it means the sheet belongs to a project
 * built from that plan — the plan has no drawings of its own, so it borrows a
 * lot's, exactly as `listPlanDrawingSources` describes.
 */
async function assertMarkupsInScope(
  supabase: SupabaseClient,
  orgId: string,
  condition: TakeoffCondition,
  // PostgREST types an embedded row as an array even when the FK makes it
  // one-to-one, so both shapes are read rather than cast away.
  markups: Array<{ drawing_sheets?: unknown }>,
): Promise<void> {
  const sheetProjectIds = new Set(
    markups
      .flatMap((markup) => {
        const embedded = markup.drawing_sheets
        const rows = Array.isArray(embedded) ? embedded : embedded ? [embedded] : []
        return rows.map((row) => (row as { project_id?: unknown }).project_id)
      })
      .filter((id): id is string => typeof id === "string"),
  )
  if (sheetProjectIds.size === 0) return

  if (condition.project_id) {
    const foreign = Array.from(sheetProjectIds).filter((id) => id !== condition.project_id)
    if (foreign.length > 0) {
      throw new Error(`"${condition.name}" cannot measure sheets from another project`)
    }
    return
  }

  const { data: version } = await supabase
    .from("house_plan_versions")
    .select("house_plan_id")
    .eq("org_id", orgId)
    .eq("id", condition.house_plan_version_id as string)
    .maybeSingle()

  if (!version) throw new Error("Takeoff condition's plan version not found")

  const { data: lots } = await supabase
    .from("lots")
    .select("project_id")
    .eq("org_id", orgId)
    .eq("house_plan_id", version.house_plan_id as string)
    .in("project_id", Array.from(sheetProjectIds))

  const allowed = new Set((lots ?? []).map((lot: any) => lot.project_id as string))
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
 * The panel's entire data set, in four queries regardless of how many
 * conditions or sheets are involved.
 */
export async function getConditionRollup(
  filters: ConditionRollupFilters,
  orgId?: string,
): Promise<ConditionRollup[]> {
  const parsed = conditionRollupFiltersSchema.parse(filters)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("takeoff.read", { supabase, orgId: resolvedOrgId, userId })
  return getConditionRollupWithContext(
    { supabase, orgId: resolvedOrgId, userId },
    parsed,
  )
}

async function getConditionRollupWithContext(
  context: TakeoffReadContext,
  parsed: ConditionRollupFilters,
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

  const [members, costCodes, syncStates] = await Promise.all([
    loadConditionMembers(supabase, resolvedOrgId, conditionIds),
    costCodeIds.length > 0
      ? supabase
          .from("cost_codes")
          .select("id, code, name, unit, default_unit_cost_cents")
          .eq("org_id", resolvedOrgId)
          .in("id", costCodeIds)
          .then(({ data }) => data ?? [])
      : Promise.resolve([]),
    loadSyncStates(supabase, resolvedOrgId, conditionIds),
  ])

  const costCodeById = new Map(costCodes.map((c: any) => [c.id as string, c]))
  const membersByCondition = new Map<string, MemberRow[]>()
  for (const member of members) {
    const list = membersByCondition.get(member.condition_id)
    if (list) list.push(member)
    else membersByCondition.set(member.condition_id, [member])
  }

  return conditions.map((condition) => {
    const memberRows = membersByCondition.get(condition.id) ?? []
    const costCode = condition.cost_code_id ? costCodeById.get(condition.cost_code_id) : null
    const totals = rollUpCondition(condition, memberRows, costCode ?? null)
    const sync = syncStates.get(condition.id) ?? null

    return {
      condition,
      ...totals,
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

/**
 * Members plus enough sheet context to say which revision they were taken on.
 * A markup pinned to a superseded version is deliberately not counted — see
 * ConditionRollup.stale_markup_count.
 */
const MEMBER_PAGE_SIZE = 1000
/** `.in(...)` id lists are chunked so no single query carries thousands of ids. */
const ID_CHUNK_SIZE = 200

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

async function loadConditionMembers(
  supabase: SupabaseClient,
  orgId: string,
  conditionIds: string[],
): Promise<MemberRow[]> {
  // Keyset pagination: the rollup is a money number, so it must see EVERY
  // member. A capped read that silently drops rows reports a lower total that
  // flows straight into an estimate.
  const data: any[] = []
  let cursor: string | null = null
  for (;;) {
    let query = supabase
      .from("drawing_markups")
      .select(
        "id, condition_id, quantity, data, sheet_version_id, drawing_sheet_id, drawing_sheets!inner(id, sheet_number, sheet_title, current_revision_id), drawing_sheet_versions!drawing_markups_sheet_version_id_fkey(drawing_revision_id)",
      )
      .eq("org_id", orgId)
      .in("condition_id", conditionIds)
      .order("id", { ascending: true })
      .limit(MEMBER_PAGE_SIZE)
    if (cursor) query = query.gt("id", cursor)

    const { data: page, error } = await query
    if (error) {
      throw new Error(`Failed to load condition measurements: ${error.message}`)
    }
    if (!page || page.length === 0) break
    data.push(...page)
    if (page.length < MEMBER_PAGE_SIZE) break
    cursor = page[page.length - 1].id as string
  }

  if (data.length === 0) return []

  return data.map((row: any) => ({
    id: row.id,
    condition_id: row.condition_id,
    quantity: row.quantity === null || row.quantity === undefined ? null : Number(row.quantity),
    sheet_version_id: row.sheet_version_id ?? null,
    drawing_sheet_id: row.drawing_sheet_id,
    sheet_number: row.drawing_sheets?.sheet_number ?? "—",
    sheet_title: row.drawing_sheets?.sheet_title ?? null,
    // Legacy markups predate version pinning; they count against the sheet.
    is_current_version:
      !row.sheet_version_id ||
      row.drawing_sheet_versions?.drawing_revision_id ===
        row.drawing_sheets?.current_revision_id,
    pending_review: row.data?.style?.reanchor?.state === "needs_review",
    is_deduction: row.data?.style?.deduction === true,
  }))
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
): Promise<Map<string, Omit<ConditionSyncState, "quantity_changed">>> {
  const states = new Map<string, Omit<ConditionSyncState, "quantity_changed">>()
  const syncedAtByCondition = new Map<string, string>()

  const pages = await Promise.all(
    SYNC_STATE_SOURCES.flatMap((source) =>
      chunk(conditionIds, ID_CHUNK_SIZE).map(async (conditionIdChunk) => {
        const { data, error } = await supabase
          .from(source.table)
          .select(`id, ${source.targetColumn}, quantity, metadata`)
          .eq("org_id", orgId)
          .in("metadata->takeoff->>condition_id", conditionIdChunk)
          .limit(1000)
        if (error) throw new Error(`Failed to load takeoff sync state: ${error.message}`)
        return (data ?? []).map((row: any) => ({ row, source }))
      }),
    ),
  )

  for (const page of pages) {
    for (const { row, source } of page) {
      const takeoff = ((row.metadata ?? {}) as any).takeoff ?? {}
      const conditionId = takeoff.condition_id as string | undefined
      if (!conditionId) continue
      // A condition synced to two places: the panel shows the most recent sync,
      // deterministically — not whichever row the database returned last.
      const syncedAt = (takeoff.synced_at as string) ?? ""
      const bestSoFar = syncedAtByCondition.get(conditionId)
      if (bestSoFar !== undefined && bestSoFar >= syncedAt) continue
      syncedAtByCondition.set(conditionId, syncedAt)

      const syncedQuantity = Number(takeoff.measured_quantity ?? 0)
      const liveQuantity = Number(row.quantity ?? 0)
      states.set(conditionId, {
        destination: source.destination,
        target_id: row[source.targetColumn] as string,
        line_id: row.id as string,
        synced_quantity: syncedQuantity,
        synced_at: syncedAt || null,
        hand_edited: Math.abs(liveQuantity - syncedQuantity) > QUANTITY_EPSILON,
        detached: takeoff.detached === true,
      })
    }
  }

  return states
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
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("takeoff.read", { supabase, orgId: resolvedOrgId, userId })

  // Paginated, not capped. A dense condition whose first thousand markups
  // happen to sit on a detail sheet would otherwise deep-link an estimator to
  // the wrong page and look like a bug in the link, not in the read.
  const totals = new Map<string, number>()
  let cursor: string | null = null
  for (;;) {
    let query = supabase
      .from("drawing_markups")
      .select("id, drawing_sheet_id, quantity")
      .eq("org_id", resolvedOrgId)
      .eq("condition_id", conditionId)
      .order("id", { ascending: true })
      .limit(MEMBER_PAGE_SIZE)
    if (cursor) query = query.gt("id", cursor)

    const { data: page, error } = await query
    if (error) {
      throw new Error(`Failed to find the condition's sheets: ${error.message}`)
    }
    if (!page || page.length === 0) break
    for (const row of page) {
      const sheetId = row.drawing_sheet_id as string
      totals.set(sheetId, (totals.get(sheetId) ?? 0) + Math.abs(Number(row.quantity ?? 0)))
    }
    if (page.length < MEMBER_PAGE_SIZE) break
    cursor = page[page.length - 1].id as string
  }

  if (totals.size === 0) return null
  const best = Array.from(totals.entries()).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0]
  return best ? { drawing_sheet_id: best[0] } : null
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
    const live = existing ? Number(existing.quantity ?? 0) : null
    const lastSynced = existing ? Number(existing.lastSyncedQuantity ?? 0) : null

    const action = classifySyncRow({
      nextQuantity: next,
      liveQuantity: live,
      lastSyncedQuantity: lastSynced,
    })

    return {
      condition_id: rollup.condition.id,
      condition_name: rollup.condition.name,
      uom: rollup.condition.uom,
      current_quantity: live,
      next_quantity: next,
      unit_cost_cents: rollup.effective_unit_cost_cents,
      action,
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
  const syncedAt = new Date().toISOString()
  const result: SyncResult = { created: 0, updated: 0, skipped: 0, unchanged: 0 }

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
