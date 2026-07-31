import "server-only"

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

import type { SupabaseClient } from "@supabase/supabase-js"

import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { measureMarkup, loadMeasurementContext } from "@/lib/services/drawing-measurements"
import type { MarkupData } from "@/lib/validation/drawings"
import { MEASURING_MARKUP_TYPES } from "@/lib/drawings/measure"
import { createSystemChangeEvent } from "@/lib/services/change-events"

/** Page size for the keyset-paginated reads below. */
const REANCHOR_PAGE_SIZE = 1000
/** Rows per insert statement when carrying markups forward. */
const REANCHOR_INSERT_BATCH = 200
/** Recent versions of one sheet examined when looking for the predecessor. */
const PREDECESSOR_VERSION_LOOKBACK = 25

export type ReanchorState = "needs_review" | "orphaned"

export interface ReanchorRecord {
  state: ReanchorState
  from_version_id: string
  to_version_id: string | null
  reason: "region_changed" | "no_successor" | "not_attempted" | "scale_changed"
  queued_at: string
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
  const supabase = client ?? createServiceSupabaseClient()
  const summary: ReanchorSummary = { carried: 0, orphaned: 0, sheets_touched: 0 }

  // Versions published by this revision, keyset-paginated: a silent cap here
  // means sheets past the cap never carry their measurements forward.
  const newVersions: Array<{ id: string; drawing_sheet_id: string }> = []
  let versionCursor: string | null = null
  for (;;) {
    let query = supabase
      .from("drawing_sheet_versions")
      .select("id, drawing_sheet_id")
      .eq("org_id", orgId)
      .eq("drawing_revision_id", revisionId)
      .order("id", { ascending: true })
      .limit(REANCHOR_PAGE_SIZE)
    if (versionCursor) query = query.gt("id", versionCursor)
    const { data: page, error } = await query
    if (error) throw new Error(`Failed to list revision versions: ${error.message}`)
    if (!page || page.length === 0) break
    newVersions.push(...page)
    if (page.length < REANCHOR_PAGE_SIZE) break
    versionCursor = page[page.length - 1].id as string
  }

  if (newVersions.length === 0) return summary

  for (const newVersion of newVersions) {
    const sheetId = newVersion.drawing_sheet_id
    const targetVersionId = newVersion.id

    // The predecessor is chosen from the sheet's own version history — newest
    // first — and is the newest version that actually carries measuring
    // markups. (Deriving it from a capped markup read could skip the real
    // predecessor entirely on a sheet with many revisions.)
    const { data: versionRows, error: versionError } = await supabase
      .from("drawing_sheet_versions")
      .select("id, created_at")
      .eq("org_id", orgId)
      .eq("drawing_sheet_id", sheetId)
      .neq("id", targetVersionId)
      .order("created_at", { ascending: false })
      .limit(PREDECESSOR_VERSION_LOOKBACK)
    if (versionError) {
      throw new Error(`Failed to list sheet versions: ${versionError.message}`)
    }

    let sourceVersionId: string | null = null
    let sourceMarkups: Array<Record<string, any>> = []
    for (const version of versionRows ?? []) {
      const markups = await loadMeasuringMarkups(supabase, orgId, version.id as string)
      if (markups.length > 0) {
        sourceVersionId = version.id as string
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
    markups: Array<Record<string, any>>
  },
): Promise<number> {
  const { orgId, sourceVersionId, targetVersionId, markups } = input
  if (markups.length === 0) return 0

  // Idempotency: anything already carried to this target is done. Paginated —
  // an incomplete read here makes a RETRY duplicate measurements, which
  // double-counts quantities.
  const alreadyCarried = new Set<string>()
  let existingCursor: string | null = null
  for (;;) {
    let query = supabase
      .from("drawing_markups")
      .select("id, data")
      .eq("org_id", orgId)
      .eq("sheet_version_id", targetVersionId)
      .order("id", { ascending: true })
      .limit(REANCHOR_PAGE_SIZE)
    if (existingCursor) query = query.gt("id", existingCursor)
    const { data: page, error } = await query
    if (error) throw new Error(`Failed to load carried measurements: ${error.message}`)
    if (!page || page.length === 0) break
    for (const row of page) {
      const source = (row.data as any)?.style?.reanchor?.source_markup_id
      if (typeof source === "string") alreadyCarried.add(source)
    }
    if (page.length < REANCHOR_PAGE_SIZE) break
    existingCursor = page[page.length - 1].id as string
  }

  const pending = markups.filter((markup) => !alreadyCarried.has(markup.id as string))
  if (pending.length === 0) return 0

  // Geometry is copied verbatim: the coordinates are normalized, so a redrawn
  // sheet of the same size puts them in the same place. Whether that place is
  // still the right place is exactly what the human review decides.
  const context = await loadMeasurementContext(supabase, orgId, targetVersionId)
  const queuedAt = new Date().toISOString()

  const rows = pending.map((markup) => {
    const data = (markup.data ?? {}) as MarkupData
    const reanchor: ReanchorRecord & { source_markup_id: string } = {
      state: "needs_review",
      from_version_id: sourceVersionId,
      to_version_id: targetVersionId,
      reason: "not_attempted",
      queued_at: queuedAt,
      source_markup_id: markup.id as string,
    }
    const nextData = {
      ...data,
      style: { ...(data.style ?? {}), reanchor },
    }
    const measured = measureMarkup(nextData as MarkupData, context)

    return {
      org_id: orgId,
      drawing_sheet_id: markup.drawing_sheet_id ?? null,
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

  // `drawing_sheet_id` is NOT NULL; a row without it is unusable.
  const insertable = rows.filter((row) => !!row.drawing_sheet_id)
  if (insertable.length === 0) return 0

  for (let i = 0; i < insertable.length; i += REANCHOR_INSERT_BATCH) {
    const { error } = await supabase
      .from("drawing_markups")
      .insert(insertable.slice(i, i + REANCHOR_INSERT_BATCH))
    if (error) {
      throw new Error(`Failed to carry measurements forward: ${error.message}`)
    }
  }

  return insertable.length
}

/** Every measuring markup pinned to one sheet version, keyset-paginated. */
async function loadMeasuringMarkups(
  supabase: SupabaseClient,
  orgId: string,
  sheetVersionId: string,
): Promise<Array<Record<string, any>>> {
  const markups: Array<Record<string, any>> = []
  let cursor: string | null = null
  for (;;) {
    let query = supabase
      .from("drawing_markups")
      .select(
        "id, data, label, condition_id, drawing_sheet_id, sheet_version_id, is_private, share_with_clients, share_with_subs, created_by",
      )
      .eq("org_id", orgId)
      .eq("sheet_version_id", sheetVersionId)
      .in("data->>type", [...MEASURING_MARKUP_TYPES])
      .order("id", { ascending: true })
      .limit(REANCHOR_PAGE_SIZE)
    if (cursor) query = query.gt("id", cursor)
    const { data: page, error } = await query
    if (error) throw new Error(`Failed to load measuring markups: ${error.message}`)
    if (!page || page.length === 0) break
    markups.push(...page)
    if (page.length < REANCHOR_PAGE_SIZE) break
    cursor = page[page.length - 1].id as string
  }
  return markups
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
}

/** Everything waiting on a human after a revision, for the takeoff panel band. */
export async function listReanchorReviewQueue(
  projectId: string,
  orgId?: string,
): Promise<ReanchorReviewItem[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("takeoff.read", { supabase, orgId: resolvedOrgId, userId })

  const { data } = await supabase
    .from("drawing_markups")
    .select(
      "id, data, quantity, uom, condition_id, drawing_sheet_id, drawing_sheets!inner(id, sheet_number, project_id), takeoff_conditions(id, name, color)",
    )
    .eq("org_id", resolvedOrgId)
    .eq("drawing_sheets.project_id", projectId)
    // Filter in the QUERY: filtering after the limit could return an empty
    // page while real needs_review rows sit past the cap.
    .eq("data->style->reanchor->>state", "needs_review")
    .limit(500)

  return (data ?? [])
    .map((row: any) => ({
      markup_id: row.id,
      drawing_sheet_id: row.drawing_sheet_id,
      sheet_number: row.drawing_sheets?.sheet_number ?? "—",
      condition_id: row.condition_id ?? null,
      condition_name: row.takeoff_conditions?.name ?? null,
      condition_color: row.takeoff_conditions?.color ?? null,
      quantity: row.quantity === null || row.quantity === undefined ? null : Number(row.quantity),
      uom: row.uom ?? null,
      reason: row.data?.style?.reanchor?.reason ?? "not_attempted",
    }))
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
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("takeoff.write", { supabase, orgId: resolvedOrgId, userId })

  if (markupIds.length === 0) return 0

  const rows: Array<{ id: string; data: unknown }> = []
  for (let i = 0; i < markupIds.length; i += 200) {
    const { data: page, error } = await supabase
      .from("drawing_markups")
      .select("id, data")
      .eq("org_id", resolvedOrgId)
      .in("id", markupIds.slice(i, i + 200))
    if (error) throw new Error(`Failed to load measurements to confirm: ${error.message}`)
    rows.push(...(page ?? []))
  }

  const pending = rows.flatMap((row) => {
    const data = (row.data ?? {}) as Record<string, any>
    const style = { ...(data.style ?? {}) }
    if (!style.reanchor) return []
    delete style.reanchor
    return [{ id: row.id, data: { ...data, style } }]
  })

  // Per-row jsonb surgery, but in bounded parallel batches.
  let confirmed = 0
  for (let i = 0; i < pending.length; i += 20) {
    const batch = pending.slice(i, i + 20)
    const results = await Promise.all(
      batch.map((item) =>
        supabase
          .from("drawing_markups")
          .update({ data: item.data })
          .eq("org_id", resolvedOrgId)
          .eq("id", item.id),
      ),
    )
    const failure = results.find((result) => result.error)
    if (failure?.error) {
      throw new Error(`Failed to confirm measurement: ${failure.error.message}`)
    }
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
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("takeoff.read", { supabase, orgId: resolvedOrgId, userId })

  const { getConditionRollup } = await import("@/lib/services/takeoff")
  const rollups = await getConditionRollup({ project_id: projectId }, resolvedOrgId)

  const drifted = rollups.filter(
    (rollup) => rollup.sync && !rollup.sync.detached && rollup.sync.quantity_changed,
  )
  if (drifted.length === 0) return []

  const estimateIds = Array.from(new Set(drifted.map((r) => r.sync!.target_id)))
  const { data: estimates } = await supabase
    .from("estimates")
    .select("id, title, status")
    .eq("org_id", resolvedOrgId)
    .in("id", estimateIds)

  const executed = new Map(
    (estimates ?? [])
      .filter((estimate) =>
        ["client_signed", "executed", "converted_to_project"].includes(String(estimate.status)),
      )
      .map((estimate) => [estimate.id as string, estimate]),
  )

  return drifted
    .filter((rollup) => executed.has(rollup.sync!.target_id))
    .map((rollup) => {
      const estimate = executed.get(rollup.sync!.target_id)!
      const delta = Math.round((rollup.effective_quantity - rollup.sync!.synced_quantity) * 100) / 100
      const rate = rollup.effective_unit_cost_cents
      const description = `${rollup.condition.name}: drawings now measure ${rollup.effective_quantity} ${rollup.condition.uom.toUpperCase()} (was ${rollup.sync!.synced_quantity})`

      return {
        condition_id: rollup.condition.id,
        condition_name: rollup.condition.name,
        uom: rollup.condition.uom,
        estimate_id: estimate.id as string,
        estimate_title: estimate.title as string,
        synced_quantity: rollup.sync!.synced_quantity,
        current_quantity: rollup.effective_quantity,
        delta_quantity: delta,
        delta_cents: rate === null ? null : Math.round(delta * rate),
        change_order_href: `/projects/${projectId}/change-orders?new=1&description=${encodeURIComponent(description)}`,
      }
    })
}
