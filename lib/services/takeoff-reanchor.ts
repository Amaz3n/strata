import "server-only"
import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import { readAllRowsById } from "@/lib/land/paging"
import { timestampMicros } from "@/lib/services/books/posting-state"
import { storedMeasurementQuantitySchema, takeoffConditionScopeSchema, conditionUomSchema } from "@/lib/validation/takeoff"

/**
 * Revision re-anchoring — the "living takeoff" (gameplan capability C3).
 *
 * Design doc: `docs/takeoff-reanchor-design.md`. Read it before changing
 * anything here; the invariants below are load-bearing and not obvious.
 *
 * The problem this exists to solve: measurements pin to `sheet_version_id`, and
 * rollups only count markups on the sheet's CURRENT revision. Publish a new
 * revision and every measured quantity on that sheet silently drops out. The
 * estimate keeps its number, the takeoff loses its evidence, and nothing tells
 * anyone.
 *
 * Two invariants:
 *
 *   1. NO MARKUP IS EVER DELETED HERE. A measurement that cannot be carried
 *      forward stays on its old version, flagged. A lost measurement is
 *      unrecoverable; a stale one is a nuisance.
 *   2. A carried-forward measurement does NOT count until a human confirms it.
 *      A number in a rollup is a claim about the current drawings, and a
 *      transferred-but-unreviewed measurement is not yet one.
 */

import { compareAreaRevision, type AreaRevisionComparison } from "@/lib/drawings/area-revision"
import { loadAreaRevisionSource } from "./area-revision"
import type { SupabaseClient } from "@supabase/supabase-js"

import { requireOrgContext } from "@/lib/services/context"
import { requireAuthorization } from "@/lib/services/authorization"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { measureMarkup, loadMeasurementContext, assertConditionAcceptsUom } from "@/lib/services/drawing-measurements"
import { markupDataSchema, drawingMarkupRevisionSchema } from "@/lib/validation/drawings"
import { MEASURING_MARKUP_TYPES, QUANTITY_EPSILON } from "@/lib/drawings/measure"
import { assertMarkupsInScope, getConditionRollup } from "@/lib/services/takeoff"
import { requireTakeoffWriteScope } from "@/lib/services/takeoff-scope"
import { createSystemChangeEvent } from "@/lib/services/change-events"

/** Page size for the keyset-paginated reads below. */
const REANCHOR_PAGE_SIZE = 1000
/** Rows per insert statement when carrying markups forward. */
const REANCHOR_INSERT_BATCH = 200
// Validation bounds are refusal limits, not accepted enterprise capacity/SLOs.
const REANCHOR_VERSION_CAP = 10_000
const REANCHOR_MARKUP_CAP = 200_000
const carryVersionSchema = z.object({ id: z.string().uuid(), org_id: z.string().uuid(), drawing_sheet_id: z.string().uuid(), drawing_revision_id: z.string().uuid(), created_at: z.string().refine(value => timestampMicros(value) !== null) })
const carrySourceSchema = z.object({
  id: z.string().uuid(), org_id: z.string().uuid(), drawing_sheet_id: z.string().uuid(), sheet_version_id: z.string().uuid(),
  data: z.record(z.unknown()), label: z.string().nullable(), condition_id: z.string().uuid().nullable(), created_by: z.string().uuid().nullable(),
  is_private: z.boolean(), share_with_clients: z.boolean(), share_with_subs: z.boolean(),
})
type CarrySource = z.infer<typeof carrySourceSchema>

export type ReanchorState = "needs_review" | "orphaned"

export interface ReanchorRecord {
  state: ReanchorState
  from_version_id: string
  to_version_id: string | null
  reason: "region_changed" | "no_successor" | "not_attempted" | "scale_changed"
  queued_at: string
  evidence_comparison?: AreaRevisionComparison
}

export interface ReanchorSummary {
  carried: number
  orphaned: number
  sheets_touched: number
}

/**
 * Carry a published revision's measurements forward.
 *
 * Runs the degraded mode from the design doc: everything transfers into
 * `needs_review`. That is deliberately the FIRST implementation — it never
 * loses data, it works on scanned sheets and vector sheets alike, and it is
 * the fallback the auto-transfer path (design doc §3b) falls back TO. Adding
 * raster-diff auto-transfer later narrows the review queue; it does not change
 * this contract.
 *
 * Idempotent: a markup already carried to this target version is skipped, so
 * an outbox retry cannot double-count.
 */
export async function reanchorRevisionMeasurements(
  revisionId: string,
  orgId: string,
  client?: SupabaseClient,
): Promise<ReanchorSummary> {
  z.string().uuid().parse(revisionId)
  z.string().uuid().parse(orgId)
  const supabase = client ?? createServiceSupabaseClient()
  const summary: ReanchorSummary = { carried: 0, orphaned: 0, sheets_touched: 0 }

  // Versions published by this revision, keyset-paginated: a silent cap here
  // means sheets past the cap never carry their measurements forward.
  const newVersions = (await readAllRowsById(async (afterId, limit) => {
    let query = supabase
      .from("drawing_sheet_versions")
      .select("id,org_id,drawing_sheet_id,drawing_revision_id,created_at")
      .eq("org_id", orgId)
      .eq("drawing_revision_id", revisionId)
      .order("id", { ascending: true })
      .limit(limit)
    if (afterId) query = query.gt("id", afterId)
    const result = await query
    if (result.data?.some(row => row.org_id !== orgId || row.drawing_revision_id !== revisionId)) throw new Error("Revision source scope unavailable")
    return result
  }, { cap: REANCHOR_VERSION_CAP, pageSize: REANCHOR_PAGE_SIZE, label: "Failed to list revision versions" })).map(row => carryVersionSchema.parse(row))

  if (newVersions.length === 0) return summary

  for (const newVersion of newVersions) {
    const sheetId = newVersion.drawing_sheet_id
    const targetVersionId = newVersion.id

    // The predecessor is chosen from the sheet's own version history — newest
    // first — and is the newest version that actually carries measuring
    // markups. (Deriving it from a capped markup read could skip the real
    // predecessor entirely on a sheet with many revisions.)
    const versionRows = (await readAllRowsById(async (afterId, limit) => {
      let query = supabase
      .from("drawing_sheet_versions")
      .select("id,org_id,drawing_sheet_id,drawing_revision_id,created_at")
      .eq("org_id", orgId)
      .eq("drawing_sheet_id", sheetId)
      .neq("id", targetVersionId)
      .order("id", { ascending: true }).limit(limit)
      if (afterId) query = query.gt("id", afterId)
      const result = await query
      if (result.data?.some(row => row.org_id !== orgId || row.drawing_sheet_id !== sheetId || row.id === targetVersionId)) throw new Error("Sheet version history scope unavailable")
      return result
    }, { cap: REANCHOR_VERSION_CAP, pageSize: REANCHOR_PAGE_SIZE, label: "Failed to list sheet versions" })).map(row => ({ ...carryVersionSchema.parse(row), time: timestampMicros(row.created_at) }))
    const targetTime = timestampMicros(newVersion.created_at)
    if (targetTime === null) throw new Error("Target version timestamp unavailable")
    versionRows.sort((a, b) => a.time === b.time ? b.id.localeCompare(a.id) : a.time !== null && b.time !== null && a.time > b.time ? -1 : 1)

    let sourceVersionId: string | null = null
    let sourceMarkups: CarrySource[] = []
    for (const version of versionRows) {
      if (version.time === null || version.time > targetTime) continue
      const markups = await loadMeasuringMarkups(supabase, orgId, version.id, sheetId)
      if (markups.length > 0) {
        if (version.time === targetTime) throw new Error("Measured predecessor is ambiguous. Resolve the sheet version history before retrying.")
        sourceVersionId = version.id
        sourceMarkups = markups
        break
      }
    }
    if (!sourceVersionId) continue

    const carried = await carrySheetMarkups(supabase, {
      orgId,
      sourceVersionId,
      targetVersionId,
      markups: sourceMarkups,
    })

    if (carried > 0) {
      summary.carried += carried
      summary.sheets_touched += 1
    }
  }

  if (summary.carried > 0) {
    await recordEvent({
      orgId,
      eventType: "takeoff_measurements_reanchored",
      entityType: "drawing_revision",
      entityId: revisionId,
      payload: { ...summary },
    })
    const threshold = Math.max(1, Number(process.env.TAKEOFF_CHANGE_EVENT_MARKUP_THRESHOLD ?? 5))
    if (summary.carried >= threshold) {
      const { data: revision } = await supabase.from("drawing_revisions").select("project_id,revision_number").eq("org_id", orgId).eq("id", revisionId).maybeSingle()
      if (revision?.project_id) await createSystemChangeEvent({ orgId, projectId: revision.project_id, title: `Drawing revision ${revision.revision_number ?? ""} takeoff delta`, description: `${summary.carried} measured markups require review after re-anchoring across ${summary.sheets_touched} sheet(s).`, originType: "drawing_revision", originId: revisionId })
    }
  }

  return summary
}

async function carrySheetMarkups(
  supabase: SupabaseClient,
  input: {
    orgId: string
    sourceVersionId: string
    targetVersionId: string
    markups: CarrySource[]
  },
): Promise<number> {
  const { orgId, sourceVersionId, targetVersionId } = input
  const markups = input.markups.map(row => carrySourceSchema.parse(row))
  if (markups.length === 0) return 0
  if (new Set(markups.map(row => row.id)).size !== markups.length || markups.some(row => row.org_id !== orgId || row.sheet_version_id !== sourceVersionId || row.drawing_sheet_id !== markups[0].drawing_sheet_id)) throw new Error("Carry source membership unavailable")
  for (const row of markups) {
    const data = markupDataSchema.parse(row.data)
    if (!MEASURING_MARKUP_TYPES.some(type => type === data.type)) throw new Error("Carry source is not a measuring markup")
    if (data.points.some(point => point.some(value => !Number.isFinite(value)))) throw new Error("Carry geometry unavailable")
    z.record(z.unknown()).parse(row.data.style ?? {})
  }

  // Idempotency: anything already carried to this target is done. Paginated —
  // an incomplete read here makes a RETRY duplicate measurements, which
  // double-counts quantities.
  const alreadyCarried = new Set<string>()
  const carriedIds = new Map<string, string>()
  const existingRows = await readAllRowsById(async (afterId, limit) => {
    let query = supabase
      .from("drawing_markups")
      .select("id,org_id,drawing_sheet_id,sheet_version_id,data,carried_from_markup_id")
      .eq("org_id", orgId)
      .eq("sheet_version_id", targetVersionId)
      .order("id", { ascending: true })
      .limit(limit)
    if (afterId) query = query.gt("id", afterId)
    const result = await query
    if (result.data?.some(row => row.org_id !== orgId || row.sheet_version_id !== targetVersionId || row.drawing_sheet_id !== markups[0].drawing_sheet_id)) throw new Error("Carried measurement scope unavailable")
    return result
  }, { cap: REANCHOR_MARKUP_CAP, pageSize: REANCHOR_PAGE_SIZE, label: "Failed to load carried measurements" })
  for (const raw of existingRows) {
    const row = z.object({ id: z.string().uuid(), data: z.record(z.unknown()), carried_from_markup_id: z.string().uuid().nullable() }).parse(raw)
    const style = z.record(z.unknown()).parse(row.data.style ?? {})
    const reanchor = z.record(z.unknown()).nullish().parse(style.reanchor)
    const origins = [row.carried_from_markup_id, style.carried_from_markup_id, reanchor?.source_markup_id].filter(value => value != null).map(value => z.string().uuid().parse(value))
    if (new Set(origins).size > 1) throw new Error("Carry provenance differs")
    const source = origins[0]
    if (source) {
      if (alreadyCarried.has(source)) throw new Error("Carry provenance is duplicated")
      alreadyCarried.add(source)
      carriedIds.set(source, row.id)
    }
  }

  const pending = markups.filter((markup) => !alreadyCarried.has(markup.id))
  if (pending.length === 0) return 0
  for (const markup of pending) carriedIds.set(markup.id, randomUUID())

  // Geometry is copied verbatim: the coordinates are normalized, so a redrawn
  // sheet of the same size puts them in the same place. Whether that place is
  // still the right place is exactly what the human review decides.
  const context = await loadMeasurementContext(supabase, orgId, targetVersionId, markups[0].drawing_sheet_id)
  const queuedAt = new Date().toISOString()
  const hasAreas = pending.some((m) => m.data?.type === "area")
  const [oldEvidence, newEvidence] = hasAreas ? await Promise.all([
    loadAreaRevisionSource(supabase, orgId, sourceVersionId), loadAreaRevisionSource(supabase, orgId, targetVersionId),
  ]) : [null, null]

  const rows = pending.map((markup) => {
    const data = markup.data
    const parsedData = markupDataSchema.parse(data)
    const reanchor: ReanchorRecord & { source_markup_id: string } = {
      state: "needs_review",
      from_version_id: sourceVersionId,
      to_version_id: targetVersionId,
      reason: "not_attempted",
      queued_at: queuedAt,
      source_markup_id: markup.id,
    }
    if (parsedData.type === "area") {
      reanchor.evidence_comparison = compareAreaRevision(oldEvidence, newEvidence, parsedData.points)
      if (reanchor.evidence_comparison === "changed") reanchor.reason = "region_changed"
    }
    const style: Record<string, unknown> & { reanchor: typeof reanchor } = {
      ...z.record(z.unknown()).parse(data.style ?? {}), reanchor,
    }
    const nextData = { ...data, style }
    const parentAreaId = nextData.style.parent_area_id
    if (parentAreaId != null) {
      z.string().uuid().parse(parentAreaId)
      if (typeof parentAreaId !== "string") throw new Error("Area parent unavailable")
      const carriedParent = carriedIds.get(parentAreaId)
      if (!carriedParent) throw new Error("Cannot carry an area deduction without its parent measurement.")
      nextData.style.parent_area_id = carriedParent
    }
    const measured = measureMarkup(markupDataSchema.parse(nextData), context)
    const carriedId = carriedIds.get(markup.id)
    if (!carriedId) throw new Error("Carry identity unavailable")

    return {
      id: carriedId,
      carried_from_markup_id: markup.id,
      carried_from_revision_id: sourceVersionId,
      org_id: orgId,
      drawing_sheet_id: markup.drawing_sheet_id,
      sheet_version_id: targetVersionId,
      data: nextData,
      label: markup.label ?? null,
      is_private: markup.is_private ?? false,
      share_with_clients: markup.share_with_clients ?? false,
      share_with_subs: markup.share_with_subs ?? false,
      quantity: measured.quantity,
      uom: measured.uom,
      // Membership carries over so the panel can group the review by condition;
      // the rollup excludes it while `reanchor.state` is set.
      condition_id: markup.condition_id ?? null,
      created_by: markup.created_by ?? null,
    }
  })

  // A room and its deductions must share a review classification. Otherwise
  // confirming only unchanged evidence could count the room without its holes.
  const byId = new Map(rows.map((row) => [row.id, row]))
  const families = new Map<string, typeof rows>()
  for (const row of rows) {
    const parentId = row.data.style.parent_area_id
    if (typeof parentId !== "string") continue
    const parent = byId.get(parentId)
    if (!parent) { row.data.style.reanchor.evidence_comparison = "unavailable"; continue }
    const family = families.get(parentId) ?? [parent]
    family.push(row); families.set(parentId, family)
  }
  for (const family of families.values()) {
    const comparisons = family.map((row) => row.data.style.reanchor.evidence_comparison)
    const comparison = comparisons.includes("changed") ? "changed" : comparisons.every((c) => c === "unchanged") ? "unchanged" : "unavailable"
    for (const row of family) {
      row.data.style.reanchor.evidence_comparison = comparison
      if (comparison === "changed") row.data.style.reanchor.reason = "region_changed"
    }
  }

  const checkedUnits = new Set<string>()
  for (const row of rows) {
    if (!row.condition_id || !row.uom) continue
    const key = `${row.condition_id}:${row.uom}`
    if (checkedUnits.has(key)) continue
    await assertConditionAcceptsUom(supabase, orgId, row.condition_id, row.uom)
    checkedUnits.add(key)
  }

  for (let i = 0; i < rows.length; i += REANCHOR_INSERT_BATCH) {
    const batch = rows.slice(i, i + REANCHOR_INSERT_BATCH)
    const { data: saved, error } = await supabase
      .from("drawing_markups")
      .insert(batch)
      .select("id,org_id,drawing_sheet_id,sheet_version_id,data,label,is_private,share_with_clients,share_with_subs,quantity,uom,condition_id,created_by,carried_from_markup_id,carried_from_revision_id")
    if (error) {
      throw new Error(`Failed to carry measurements forward: ${error.message}`)
    }
    const expected = new Map(batch.map(row => [row.id, row]))
    if (!Array.isArray(saved) || saved.length !== batch.length || new Set(saved.map(row => row.id)).size !== batch.length) throw new Error("Carried measurements could not be confirmed. Reload before retrying.")
    for (const row of saved) {
      const wanted = expected.get(row.id)
      if (!wanted || Object.entries(wanted).some(([field, value]) => !isDeepStrictEqual(field === "quantity" ? storedMeasurementQuantitySchema.parse(row[field]) : row[field as keyof typeof row], value))) throw new Error("Saved carry body could not be confirmed. Reload before retrying.")
    }
  }

  return rows.length
}

/** Every measuring markup pinned to one sheet version, keyset-paginated. */
async function loadMeasuringMarkups(
  supabase: SupabaseClient,
  orgId: string,
  sheetVersionId: string,
  expectedSheetId: string,
): Promise<CarrySource[]> {
  const markups = await readAllRowsById(async (afterId, limit) => {
    let query = supabase
      .from("drawing_markups")
      .select(
        "id,org_id,data,label,condition_id,drawing_sheet_id,sheet_version_id,is_private,share_with_clients,share_with_subs,created_by",
      )
      .eq("org_id", orgId)
      .eq("sheet_version_id", sheetVersionId)
      .in("data->>type", [...MEASURING_MARKUP_TYPES])
      .order("id", { ascending: true })
      .limit(limit)
    if (afterId) query = query.gt("id", afterId)
    const result = await query
    if (result.data?.some(row => row.org_id !== orgId || row.sheet_version_id !== sheetVersionId || row.drawing_sheet_id !== expectedSheetId)) throw new Error("Measuring source scope unavailable")
    return result
  }, { cap: REANCHOR_MARKUP_CAP, pageSize: REANCHOR_PAGE_SIZE, label: "Failed to load measuring markups" })
  return markups.map(row => carrySourceSchema.parse(row))
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export interface ReanchorReviewItem {
  markup_id: string
  drawing_sheet_id: string
  sheet_number: string
  condition_id: string | null
  condition_name: string | null
  condition_color: string | null
  quantity: number | null
  uom: string | null
  reason: ReanchorRecord["reason"]
  evidence_comparison?: AreaRevisionComparison
}

/** Everything waiting on a human after a revision, for the takeoff panel band. */
export async function listReanchorReviewQueue(
  projectId: string,
  orgId?: string,
): Promise<ReanchorReviewItem[]> {
  z.string().uuid().parse(projectId)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  z.string().uuid().parse(resolvedOrgId)
  z.string().uuid().parse(userId)
  const authorize = () => requireAuthorization({ permission: "takeoff.read", supabase, orgId: resolvedOrgId, userId, projectId, logDecision: true })
  await authorize()

  const rows = await readAllRowsById(async (afterId, limit) => {
    let query = supabase.from("drawing_markups")
      .select("id,org_id,data,quantity,uom,condition_id,drawing_sheet_id,sheet_version_id,is_private,created_by,drawing_sheets!inner(id,org_id,sheet_number,project_id),takeoff_conditions(id,org_id,name,color)")
      .eq("org_id", resolvedOrgId).eq("drawing_sheets.org_id", resolvedOrgId)
      .eq("drawing_sheets.project_id", projectId)
      .eq("data->style->reanchor->>state", "needs_review")
      .or(`is_private.eq.false,created_by.eq.${userId}`)
      .order("id", { ascending: true }).limit(limit)
    if (afterId) query = query.gt("id", afterId)
    return query
  }, { cap: REANCHOR_MARKUP_CAP, pageSize: REANCHOR_PAGE_SIZE, label: "Failed to load measurements awaiting review" })

  const items = rows.map(raw => {
    const row = z.object({ id: z.string().uuid(), org_id: z.string().uuid(), data: z.record(z.unknown()), quantity: storedMeasurementQuantitySchema, uom: z.enum(["lf", "sf", "ea"]).nullable(), condition_id: z.string().uuid().nullable(), drawing_sheet_id: z.string().uuid(), sheet_version_id: z.string().uuid(), is_private: z.boolean(), created_by: z.string().uuid().nullable() }).parse(raw)
    const sheets = Array.isArray(raw.drawing_sheets) ? raw.drawing_sheets : [raw.drawing_sheets]
    if (sheets.length !== 1) throw new Error("Review sheet ancestry unavailable")
    const sheet = z.object({ id: z.string().uuid(), org_id: z.string().uuid(), project_id: z.string().uuid(), sheet_number: z.string().nullable() }).parse(sheets[0])
    if (row.org_id !== resolvedOrgId || sheet.org_id !== resolvedOrgId || sheet.project_id !== projectId || sheet.id !== row.drawing_sheet_id || row.is_private && row.created_by !== userId) throw new Error("Review measurement scope unavailable")
    const style = z.record(z.unknown()).parse(row.data.style)
    const review = z.object({ state: z.literal("needs_review"), from_version_id: z.string().uuid().nullable(), to_version_id: z.string().uuid(), reason: z.enum(["region_changed", "no_successor", "not_attempted", "scale_changed"]), queued_at: z.string().datetime({ offset: true }), source_markup_id: z.string().uuid().optional(), evidence_comparison: z.enum(["unchanged", "changed", "unavailable"]).optional() }).parse(style.reanchor)
    if (review.to_version_id !== row.sheet_version_id) throw new Error("Review target version differs")
    let condition: { id: string; org_id: string; name: string; color: string | null } | null = null
    const conditions = Array.isArray(raw.takeoff_conditions) ? raw.takeoff_conditions : raw.takeoff_conditions == null ? [] : [raw.takeoff_conditions]
    if (row.condition_id) {
      if (conditions.length !== 1) throw new Error("Review condition unavailable")
      condition = z.object({ id: z.string().uuid(), org_id: z.string().uuid(), name: z.string(), color: z.string().nullable() }).parse(conditions[0])
      if (condition.org_id !== resolvedOrgId || condition.id !== row.condition_id) throw new Error("Review condition scope unavailable")
    } else if (conditions.length) throw new Error("Review condition membership differs")
    return { markup_id: row.id, drawing_sheet_id: row.drawing_sheet_id, sheet_number: sheet.sheet_number ?? "—", condition_id: row.condition_id, condition_name: condition?.name ?? null, condition_color: condition?.color ?? null, quantity: row.quantity, uom: row.uom, reason: review.reason, evidence_comparison: review.evidence_comparison ?? "unavailable" }
  })
  // Re-evaluate through the canonical owner; request-cached ACLs are not a
  // committing snapshot and still require real revocation/concurrency proof.
  await authorize()
  return items
}

/**
 * Confirm carried-forward measurements: clear the flag so they start counting.
 * Rejecting is an ordinary delete through the existing markup path — there is
 * no separate "reject" verb, because a measurement you do not want is a
 * measurement you delete.
 */
export async function confirmReanchoredMarkups(
  markupIds: string[],
  orgId?: string,
): Promise<number> {
  const ids = z.array(z.string().uuid()).max(REANCHOR_MARKUP_CAP).parse(markupIds)
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate review measurements")
  if (!ids.length) return 0
  const context = await requireOrgContext(orgId)
  const { supabase, orgId: resolvedOrgId, userId } = context
  z.string().uuid().parse(resolvedOrgId)
  z.string().uuid().parse(userId)
  const columns = "id,org_id,data,quantity,uom,condition_id,drawing_sheet_id,sheet_version_id,is_private,created_by,updated_at,drawing_sheets!inner(id,org_id,project_id,current_revision_id),drawing_sheet_versions!drawing_markups_sheet_version_id_fkey(id,org_id,drawing_sheet_id,drawing_revision_id)"
  const rows: Array<Record<string, unknown>> = []
  for (let offset = 0; offset < ids.length; offset += 200) {
    const chunk = ids.slice(offset, offset + 200)
    const requested = new Set(chunk)
    const loaded = await readAllRowsById(async (afterId, limit) => {
      let query = supabase.from("drawing_markups").select(columns).eq("org_id", resolvedOrgId)
        .in("id", chunk).order("id", { ascending: true }).limit(limit)
      if (afterId) query = query.gt("id", afterId)
      const result = await query
      if (result.data?.some(row => !requested.has(row.id) || row.org_id !== resolvedOrgId)) throw new Error("Selected review membership differs")
      return result
    }, { cap: chunk.length, pageSize: 200, label: "Failed to load all selected measurements" })
    if (loaded.length !== chunk.length) throw new Error("Selected review measurements unavailable. Reload before retrying.")
    rows.push(...loaded)
  }

  const projectIds = new Set<string>()
  const conditions = new Map<string, typeof rows>()
  const pending = []
  const measurementContexts = new Map<string, Awaited<ReturnType<typeof loadMeasurementContext>>>()
  for (const raw of rows) {
    const row = z.object({ id: z.string().uuid(), org_id: z.string().uuid(), data: z.record(z.unknown()), quantity: storedMeasurementQuantitySchema, uom: z.enum(["lf", "sf", "ea"]).nullable(), condition_id: z.string().uuid().nullable(), drawing_sheet_id: z.string().uuid(), sheet_version_id: z.string().uuid(), is_private: z.boolean(), created_by: z.string().uuid().nullable(), updated_at: z.string().refine(value => timestampMicros(value) !== null) }).parse(raw)
    drawingMarkupRevisionSchema.parse(row)
    const sheets = Array.isArray(raw.drawing_sheets) ? raw.drawing_sheets : [raw.drawing_sheets]
    const versions = Array.isArray(raw.drawing_sheet_versions) ? raw.drawing_sheet_versions : [raw.drawing_sheet_versions]
    if (sheets.length !== 1 || versions.length !== 1) throw new Error("Selected review ancestry unavailable")
    const sheet = z.object({ id: z.string().uuid(), org_id: z.string().uuid(), project_id: z.string().uuid(), current_revision_id: z.string().uuid().nullable() }).parse(sheets[0])
    const version = z.object({ id: z.string().uuid(), org_id: z.string().uuid(), drawing_sheet_id: z.string().uuid(), drawing_revision_id: z.string().uuid() }).parse(versions[0])
    if (row.org_id !== resolvedOrgId || sheet.org_id !== resolvedOrgId || sheet.id !== row.drawing_sheet_id || version.org_id !== resolvedOrgId || version.id !== row.sheet_version_id || version.drawing_sheet_id !== row.drawing_sheet_id || row.is_private && row.created_by !== userId) throw new Error("Selected review scope unavailable")
    if (!projectIds.has(sheet.project_id)) {
      await requireAuthorization({ permission: "takeoff.write", supabase, orgId: resolvedOrgId, userId, projectId: sheet.project_id, logDecision: true })
      projectIds.add(sheet.project_id)
    }
    if (row.condition_id) {
      const members = conditions.get(row.condition_id) ?? []
      members.push(raw); conditions.set(row.condition_id, members)
    }
    const style = z.record(z.unknown()).parse(row.data.style ?? {})
    if (style.reanchor == null) continue // Already confirmed; retain exact-set and authority checks.
    const review = z.object({ state: z.literal("needs_review"), to_version_id: z.string().uuid(), from_version_id: z.string().uuid().nullable(), reason: z.enum(["region_changed", "no_successor", "not_attempted", "scale_changed"]), queued_at: z.string().datetime({ offset: true }) }).parse(style.reanchor)
    if (review.to_version_id !== row.sheet_version_id || sheet.current_revision_id !== version.drawing_revision_id) throw new Error("Review drawing revision changed. Reload before confirming.")
    const geometry = markupDataSchema.parse(row.data)
    if (!MEASURING_MARKUP_TYPES.some(type => type === geometry.type) || geometry.points.some(point => point.some(value => !Number.isFinite(value)))) throw new Error("Review measurement geometry unavailable")
    let measurementContext = measurementContexts.get(row.sheet_version_id)
    if (!measurementContext) {
      measurementContext = await loadMeasurementContext(supabase, resolvedOrgId, row.sheet_version_id, row.drawing_sheet_id)
      measurementContexts.set(row.sheet_version_id, measurementContext)
    }
    const measured = measureMarkup(geometry, measurementContext)
    if (measured.uom !== row.uom || (measured.quantity === null ? row.quantity !== null : row.quantity === null || Math.abs(measured.quantity - row.quantity) >= 1e-9)) throw new Error("Review measurement scale or quantity changed. Remeasure before confirming.")
    const nextStyle = { ...style }
    delete nextStyle.reanchor
    pending.push({ source: row, data: { ...row.data, style: nextStyle } })
  }
  for (const projectId of projectIds) await requireAuthorization({ permission: "takeoff.write", supabase, orgId: resolvedOrgId, userId, projectId, logDecision: true })
  for (const [conditionId, members] of conditions) {
    const { data: condition, error } = await supabase.from("takeoff_conditions").select("id,org_id,project_id,house_plan_version_id,name").eq("org_id", resolvedOrgId).eq("id", conditionId).maybeSingle()
    if (error || !condition || condition.id !== conditionId || condition.org_id !== resolvedOrgId) throw new Error("Review condition unavailable")
    const scope = takeoffConditionScopeSchema.parse(condition)
    await requireTakeoffWriteScope(context, scope)
    await assertMarkupsInScope(supabase, resolvedOrgId, { ...scope, project_id: scope.project_id ?? null, house_plan_version_id: scope.house_plan_version_id ?? null, name: condition.name }, members)
    const units = new Set(members.map(member => z.enum(["lf", "sf", "ea"]).parse(member.uom)))
    for (const unit of units) await assertConditionAcceptsUom(supabase, resolvedOrgId, conditionId, unit)
  }

  // Keep the original bounded writes; loaded-row stamps fence competing markup
  // writers. Whole-family/actor/context atomicity still needs database recovery.
  let confirmed = 0
  for (let offset = 0; offset < pending.length; offset += 20) {
    const batch = pending.slice(offset, offset + 20)
    const results = await Promise.allSettled(batch.map(async item => {
      const { data: saved, error } = await supabase.from("drawing_markups").update({ data: item.data })
        .eq("org_id", resolvedOrgId).eq("id", item.source.id).eq("updated_at", item.source.updated_at)
        .eq("drawing_sheet_id", item.source.drawing_sheet_id).eq("sheet_version_id", item.source.sheet_version_id)
        .select("id,org_id,data,quantity,uom,condition_id,drawing_sheet_id,sheet_version_id,is_private,created_by,updated_at").maybeSingle()
      if (error) throw new Error(`Failed to confirm measurement: ${error.message}`)
      if (!saved) throw new Error("Review measurement changed. Reload before retrying.")
      const expected = { ...item.source, data: item.data }
      if (Object.entries(expected).some(([field, value]) => field !== "updated_at" && !isDeepStrictEqual(field === "quantity" ? storedMeasurementQuantitySchema.parse(saved.quantity) : saved[field as keyof typeof saved], value)) || !drawingMarkupRevisionSchema.safeParse(saved).success) throw new Error("Confirmed measurement body could not be verified. Reload before retrying.")
    }))
    const failure = results.find(result => result.status === "rejected")
    if (failure?.status === "rejected") throw failure.reason instanceof Error ? failure.reason : new Error("Unable to confirm reviewed measurements")
    confirmed += batch.length
  }

  if (confirmed > 0) {
    await recordAudit({
      orgId: resolvedOrgId,
      actorId: userId,
      action: "update",
      entityType: "drawing_markup",
      entityId: markupIds[0],
      after: { reanchor_confirmed: confirmed, markup_ids: markupIds },
    })
  }

  return confirmed
}

// ---------------------------------------------------------------------------
// Stale-estimate money alert
// ---------------------------------------------------------------------------

export interface StaleEstimateAlert {
  condition_id: string
  condition_name: string
  uom: string
  estimate_id: string
  estimate_line_id: string
  estimate_title: string
  /** Quantity the estimate line still carries. */
  synced_quantity: number
  /** Quantity the drawings now say. */
  current_quantity: number
  delta_quantity: number
  /** Approximate money impact at the condition's current rate. */
  delta_cents: number | null
  /** Prefilled deep link into the existing change-order flow. */
  change_order_href: string
}

/**
 * Conditions whose quantity moved after a revision AND that are synced to an
 * EXECUTED estimate.
 *
 * The executed filter is the whole point. A drifted draft estimate is a
 * re-sync — the estimator just pushes the new number. A drifted executed
 * estimate is a contract that no longer matches the drawings, which is a change
 * order conversation with the owner.
 *
 * This NEVER creates the change order. It deep-links into the existing flow
 * with a prefilled description, because whether a revision is owner-driven
 * scope or the architect correcting their own sheet is a judgement no service
 * can make.
 */
export async function listStaleEstimateAlerts(
  projectId: string,
  orgId?: string,
): Promise<StaleEstimateAlert[]> {
  z.string().uuid().parse(projectId)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const authorize = () => requireAuthorization({ permission: "takeoff.read", supabase, orgId: resolvedOrgId, userId, projectId, logDecision: true })
  await authorize()
  const loadProject = async () => {
    const { data, error } = await supabase.from("projects").select("id,org_id,prospect_id").eq("org_id", resolvedOrgId).eq("id", projectId).maybeSingle()
    if (error || !data) throw new Error("Estimate alert project unavailable. Reload before retrying.")
    const project = z.object({ id: z.string().uuid(), org_id: z.string().uuid(), prospect_id: z.string().uuid().nullable() }).parse(data)
    if (project.id !== projectId || project.org_id !== resolvedOrgId) throw new Error("Estimate alert project scope unavailable")
    return project
  }
  const project = await loadProject()
  const source = await getConditionRollup({ project_id: projectId }, resolvedOrgId, true)
  const syncSchema = z.object({ destination: z.enum(["estimate", "change_order", "bid_scope", "plan_takeoff", "pricing_worksheet"]), target_id: z.string().uuid(), line_id: z.string().uuid(), synced_quantity: z.number().finite().nonnegative(), synced_at: z.string().refine(value => timestampMicros(value) !== null).nullable(), quantity_changed: z.boolean(), hand_edited: z.boolean(), detached: z.boolean() })
  const rollups = z.array(z.object({
    condition: z.object({ id: z.string().uuid(), org_id: z.string().uuid(), name: z.string(), uom: conditionUomSchema, project_id: z.string().uuid().nullable(), house_plan_version_id: z.string().uuid().nullable() }),
    effective_quantity: z.number().finite().nonnegative(),
    effective_unit_cost_cents: z.number().int().nonnegative().safe().nullable(),
    sync: syncSchema.nullable(),
    sync_history: z.array(syncSchema).max(REANCHOR_MARKUP_CAP),
  })).max(REANCHOR_MARKUP_CAP).parse(source)
  if (new Set(rollups.map(row => row.condition.id)).size !== rollups.length || rollups.some(row => row.condition.org_id !== resolvedOrgId)) throw new Error("Estimate alert condition membership differs")
  const lineIds = new Set<string>()
  const drifted = []
  for (const row of rollups) {
    if ((row.sync === null) !== (row.sync_history.length === 0)
      || (row.sync !== null && !row.sync_history.some(state => isDeepStrictEqual(state, row.sync)))) {
      throw new Error("Estimate alert sync history unavailable or inconsistent")
    }
    for (const sync of row.sync_history) {
      const key = `${sync.destination}:${sync.line_id}`
      if (lineIds.has(key) || lineIds.size >= REANCHOR_MARKUP_CAP) throw new Error("Estimate alert sync history duplicated or exceeds validation limit")
      lineIds.add(key)
      if (sync.quantity_changed !== (Math.abs(sync.synced_quantity - row.effective_quantity) > QUANTITY_EPSILON)) {
        throw new Error("Estimate alert sync quantity evidence differs")
      }
      if (sync.destination === "estimate" && !sync.detached && sync.quantity_changed) drifted.push({ ...row, sync })
    }
  }
  // Home scope is per condition, even when several signed estimates carry it.
  const scopedConditions = new Set<string>()
  for (const row of drifted) {
    if (!scopedConditions.has(row.condition.id)) {
      await assertMarkupsInScope(supabase, resolvedOrgId, row.condition, [{ drawing_sheets: { project_id: projectId } }])
      scopedConditions.add(row.condition.id)
    }
  }

  const estimateIds = [...new Set(drifted.map(row => row.sync!.target_id))]
  const estimates = new Map<string, { id: string; org_id: string; project_id: string | null; prospect_id: string | null; title: string; status: string }>()
  for (let offset = 0; offset < estimateIds.length; offset += 200) {
    const ids = estimateIds.slice(offset, offset + 200), requested = new Set(ids)
    const loaded = await readAllRowsById(async (afterId, limit) => {
      let query = supabase.from("estimates").select("id,org_id,project_id,prospect_id,title,status").eq("org_id", resolvedOrgId)
        .in("id", ids).order("id", { ascending: true }).limit(limit)
      if (afterId) query = query.gt("id", afterId)
      const result = await query
      if (result.data?.some(row => row.org_id !== resolvedOrgId || !requested.has(row.id))) throw new Error("Estimate alert target membership differs")
      return result
    }, { cap: ids.length, pageSize: 200, label: "Failed to load all estimate alert targets" })
    if (loaded.length !== ids.length) throw new Error("Estimate alert targets unavailable. Reload before retrying.")
    for (const raw of loaded) {
      const estimate = z.object({ id: z.string().uuid(), org_id: z.string().uuid(), project_id: z.string().uuid().nullable(), prospect_id: z.string().uuid().nullable(), title: z.string(), status: z.string().min(1) }).parse(raw)
      if (estimate.project_id !== projectId && !(estimate.project_id === null && project.prospect_id !== null && estimate.prospect_id === project.prospect_id)) throw new Error("Estimate alert target belongs to another project")
      estimates.set(estimate.id, estimate)
    }
  }
  const alerts = drifted.flatMap(row => {
    const estimate = estimates.get(row.sync!.target_id)
    if (!estimate) throw new Error("Estimate alert target could not be verified")
    if (!["client_signed", "executed", "converted_to_project"].includes(estimate.status)) return []
    const difference = row.effective_quantity - row.sync!.synced_quantity
    const roundedDelta = Math.round(difference * 100) / 100
    const delta = roundedDelta === 0 ? 0 : roundedDelta
    if (!Number.isFinite(difference) || !Number.isFinite(delta) || !Number.isSafeInteger(Math.round(difference * 100))) throw new Error("Estimate quantity delta exceeds supported precision")
    const roundedCents = row.effective_unit_cost_cents === null ? null : Math.round(delta * row.effective_unit_cost_cents)
    const cents = roundedCents === 0 ? 0 : roundedCents
    if (cents !== null && !Number.isSafeInteger(cents)) throw new Error("Estimate alert money exceeds supported precision")
    const description = `${row.condition.name}: drawings now measure ${row.effective_quantity} ${row.condition.uom.toUpperCase()} (was ${row.sync!.synced_quantity})`
    return [{ condition_id: row.condition.id, condition_name: row.condition.name, uom: row.condition.uom, estimate_id: estimate.id, estimate_line_id: row.sync!.line_id, estimate_title: estimate.title, synced_quantity: row.sync!.synced_quantity, current_quantity: row.effective_quantity, delta_quantity: delta, delta_cents: cents, change_order_href: `/projects/${projectId}/change-orders?new=1&description=${encodeURIComponent(description)}` }]
  })
  if (!isDeepStrictEqual(project, await loadProject())) throw new Error("Estimate alert project changed. Reload before retrying.")
  await authorize()
  return alerts
}
