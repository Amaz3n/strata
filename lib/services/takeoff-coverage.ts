import "server-only"

/**
 * Which sheets have been taken off, and which have been forgotten.
 *
 * Missing an entire sheet is the most expensive error in a takeoff — a whole
 * second-floor electrical plan omitted does not show up as a wrong number, it
 * shows up as a number that looks fine. Every other honesty signal in the
 * takeoff (stale, pending, unscaled) is about measurements that exist. This one
 * is about the ones that never got made.
 *
 * Only the human's DECLARATION is stored (`takeoff_sheet_status`). Whether a
 * sheet carries measurements is derived from the markups every time, because a
 * cached copy would go stale the first time someone deleted one — and a
 * coverage report that can be wrong is worse than none.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { recordAudit } from "@/lib/services/audit"
import { MEASURING_MARKUP_TYPES } from "@/lib/drawings/measure"
import {
  setTakeoffSheetStatusSchema,
  type SetTakeoffSheetStatusInput,
  type TakeoffSheetStatusValue,
} from "@/lib/validation/takeoff"

/** Sheets scanned for coverage in one pass. A 400-sheet set is the design case. */
const SHEET_CAP = 1000

/**
 * What the panel shows per sheet.
 *
 * `not_started` is the only value that is purely derived, and it is the one that
 * matters: it means nobody has measured this sheet and nobody has said it does
 * not need measuring.
 */
export type SheetCoverageState =
  | "measured"
  | "complete"
  | "not_applicable"
  | "not_started"

export interface SheetCoverage {
  drawing_sheet_id: string
  sheet_number: string
  sheet_title: string | null
  discipline: string | null
  state: SheetCoverageState
  /** Measuring markups on this sheet's current revision, within this scope. */
  markup_count: number
  /** Set when a human declared this sheet's state. */
  declared_status: TakeoffSheetStatusValue | null
  declared_note: string | null
  /** True when the sheet has no scale, so nothing on it can be priced. */
  unscaled: boolean
}

export interface CoverageSummary {
  sheets: SheetCoverage[]
  /** Sheets nobody has measured or waived — the actionable number. */
  not_started_count: number
  measured_count: number
  waived_count: number
  /** True when the set is larger than one pass can honestly report. */
  truncated: boolean
}

type CoverageScope =
  | { project_id: string }
  | { house_plan_version_id: string; source_project_ids: string[] }

/**
 * Coverage for a takeoff scope.
 *
 * A project scope reads its own sheets. A plan-version scope reads the sheets of
 * the lot projects it is measured against — a plan has no drawings of its own,
 * so its coverage question is "have I measured this house's sheets", asked
 * against whichever house was used.
 */
export async function getTakeoffCoverage(
  scope: CoverageScope,
  orgId?: string,
): Promise<CoverageSummary> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("takeoff.read", { supabase, orgId: resolvedOrgId, userId })

  const projectIds =
    "project_id" in scope ? [scope.project_id] : scope.source_project_ids
  if (projectIds.length === 0) {
    return {
      sheets: [],
      not_started_count: 0,
      measured_count: 0,
      waived_count: 0,
      truncated: false,
    }
  }

  const { data: sheetRows, error } = await supabase
    .from("drawing_sheets")
    .select(
      "id, sheet_number, sheet_title, discipline, current_revision_id, drawing_sheet_versions!drawing_sheet_versions_drawing_sheet_id_fkey(id, drawing_revision_id, calibration:extracted_metadata->calibration)",
    )
    .eq("org_id", resolvedOrgId)
    .in("project_id", projectIds)
    .not("current_revision_id", "is", null)
    .order("sheet_number", { ascending: true })
    .limit(SHEET_CAP + 1)

  if (error) throw new Error(`Failed to load sheets for coverage: ${error.message}`)

  const truncated = (sheetRows ?? []).length > SHEET_CAP
  const sheets = (sheetRows ?? []).slice(0, SHEET_CAP)
  if (sheets.length === 0) {
    return {
      sheets: [],
      not_started_count: 0,
      measured_count: 0,
      waived_count: 0,
      truncated: false,
    }
  }

  const sheetIds = sheets.map((row: any) => row.id as string)
  const [counts, declarations] = await Promise.all([
    countMeasuringMarkups(supabase, resolvedOrgId, sheetIds),
    loadDeclarations(supabase, resolvedOrgId, scope, sheetIds),
  ])

  const result: SheetCoverage[] = sheets.map((row: any) => {
    const declared = declarations.get(row.id as string) ?? null
    const markupCount = counts.get(row.id as string) ?? 0
    // The current version is the one whose revision matches the sheet's; only
    // its calibration says whether today's measurements can be priced.
    const currentVersion = (row.drawing_sheet_versions ?? []).find(
      (version: any) => version.drawing_revision_id === row.current_revision_id,
    )
    const feetPerPx = Number(currentVersion?.calibration?.feet_per_image_px ?? 0)

    // A declaration outranks the derived state — someone looked at this sheet
    // and said so, which is strictly more information than a markup count.
    const state: SheetCoverageState = declared
      ? declared.status
      : markupCount > 0
        ? "measured"
        : "not_started"

    return {
      drawing_sheet_id: row.id as string,
      sheet_number: (row.sheet_number as string) ?? "—",
      sheet_title: (row.sheet_title as string) ?? null,
      discipline: (row.discipline as string) ?? null,
      state,
      markup_count: markupCount,
      declared_status: declared?.status ?? null,
      declared_note: declared?.note ?? null,
      unscaled: !(feetPerPx > 0),
    }
  })

  return {
    sheets: result,
    not_started_count: result.filter((sheet) => sheet.state === "not_started").length,
    measured_count: result.filter(
      (sheet) => sheet.state === "measured" || sheet.state === "complete",
    ).length,
    waived_count: result.filter((sheet) => sheet.state === "not_applicable").length,
    truncated,
  }
}

const COUNT_CHUNK = 100

async function countMeasuringMarkups(
  supabase: SupabaseClient,
  orgId: string,
  sheetIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  // One paged read per chunk rather than a count-per-sheet round trip: a
  // 400-sheet set would otherwise be 400 queries to render one panel.
  for (let i = 0; i < sheetIds.length; i += COUNT_CHUNK) {
    const slice = sheetIds.slice(i, i + COUNT_CHUNK)
    let cursor: string | null = null
    for (;;) {
      let query = supabase
        .from("drawing_markups")
        .select("id, drawing_sheet_id")
        .eq("org_id", orgId)
        .in("drawing_sheet_id", slice)
        .in("data->>type", [...MEASURING_MARKUP_TYPES])
        .order("id", { ascending: true })
        .limit(1000)
      if (cursor) query = query.gt("id", cursor)

      const { data, error } = await query
      if (error) throw new Error(`Failed to count measurements: ${error.message}`)
      if (!data || data.length === 0) break
      for (const row of data) {
        const sheetId = row.drawing_sheet_id as string
        counts.set(sheetId, (counts.get(sheetId) ?? 0) + 1)
      }
      if (data.length < 1000) break
      cursor = data[data.length - 1].id as string
    }
  }
  return counts
}

async function loadDeclarations(
  supabase: SupabaseClient,
  orgId: string,
  scope: CoverageScope,
  sheetIds: string[],
): Promise<Map<string, { status: TakeoffSheetStatusValue; note: string | null }>> {
  let query = supabase
    .from("takeoff_sheet_status")
    .select("drawing_sheet_id, status, note")
    .eq("org_id", orgId)
    .in("drawing_sheet_id", sheetIds)

  query =
    "project_id" in scope
      ? query.eq("project_id", scope.project_id)
      : query.eq("house_plan_version_id", scope.house_plan_version_id)

  const { data, error } = await query
  if (error) throw new Error(`Failed to load sheet statuses: ${error.message}`)

  const map = new Map<string, { status: TakeoffSheetStatusValue; note: string | null }>()
  for (const row of data ?? []) {
    map.set(row.drawing_sheet_id as string, {
      status: row.status as TakeoffSheetStatusValue,
      note: (row.note as string) ?? null,
    })
  }
  return map
}

/**
 * Declare (or clear) a sheet's takeoff status.
 *
 * Clearing is a delete rather than a third status value, so "not started" stays
 * the absence of a claim rather than a claim of its own.
 */
export async function setTakeoffSheetStatus(
  input: SetTakeoffSheetStatusInput,
  orgId?: string,
): Promise<void> {
  const parsed = setTakeoffSheetStatusSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("takeoff.write", { supabase, orgId: resolvedOrgId, userId })

  const scopeColumn = parsed.project_id ? "project_id" : "house_plan_version_id"
  const scopeId = parsed.project_id ?? (parsed.house_plan_version_id as string)

  if (parsed.status === null) {
    const { error } = await supabase
      .from("takeoff_sheet_status")
      .delete()
      .eq("org_id", resolvedOrgId)
      .eq(scopeColumn, scopeId)
      .eq("drawing_sheet_id", parsed.drawing_sheet_id)
    if (error) throw new Error(`Failed to clear sheet status: ${error.message}`)
  } else {
    const { error } = await supabase.from("takeoff_sheet_status").upsert(
      {
        org_id: resolvedOrgId,
        project_id: parsed.project_id ?? null,
        house_plan_version_id: parsed.house_plan_version_id ?? null,
        drawing_sheet_id: parsed.drawing_sheet_id,
        status: parsed.status,
        note: parsed.note ?? null,
        updated_by: userId,
      },
      {
        onConflict: parsed.project_id
          ? "org_id,project_id,drawing_sheet_id"
          : "org_id,house_plan_version_id,drawing_sheet_id",
      },
    )
    if (error) throw new Error(`Failed to set sheet status: ${error.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: parsed.status === null ? "delete" : "update",
    entityType: "takeoff_sheet_status",
    entityId: parsed.drawing_sheet_id,
    after: { scope: scopeId, status: parsed.status, note: parsed.note ?? null },
  })
}
