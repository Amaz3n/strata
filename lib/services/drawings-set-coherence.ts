import "server-only"

import {
  analyzeSetCoherence,
  type CoherenceCallout,
  type CoherenceSheet,
  type CoherenceSpecSection,
  type SetCoherenceReport,
} from "@/lib/drawings/set-coherence"
import { parseStoredCalloutLinks } from "@/lib/drawings/callout-links"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"

/**
 * Checking a drawing set against itself.
 *
 * Everything this needs is already in the database: the sheet register, the
 * callout graph the pipeline extracts from each sheet's text runs, and the spec
 * sections. The work here is assembling those three into the shape the pure
 * analyzer wants and scoping every read to the org — there is no model call and
 * no rendering, so this is cheap enough to run on demand from the register.
 *
 * Deliberately reads the CURRENT version of each sheet. A coherence problem is
 * about the set someone is building from today; the historical question ("was
 * A-514 missing back in Rev 2 as well?") is a different report nobody has asked
 * for, and guessing at it would mean carrying revision state through all of
 * this for no one.
 */

/** Sheets read per check. A 900-sheet commercial set is the design case. */
const MAX_SHEETS = 1000

export interface ProjectSetCoherenceReport extends SetCoherenceReport {
  /** True when the sheet cap bit and the report covers only part of the set. */
  truncated: boolean
  /** Sheets whose callouts have not been extracted yet. */
  sheetsWithoutCallouts: number
}

export async function analyzeProjectSetCoherence(input: {
  projectId: string
  orgId?: string
}): Promise<ProjectSetCoherenceReport> {
  const { supabase, orgId, userId } = await requireOrgContext(input.orgId)
  await requirePermission("drawing.read", { supabase, orgId, userId })

  const [sheetsResult, specsResult] = await Promise.all([
    supabase
      .from("drawing_sheets")
      .select("id, sheet_number, sheet_title, discipline, current_revision_id")
      .eq("org_id", orgId)
      .eq("project_id", input.projectId)
      .order("sheet_number", { ascending: true })
      .limit(MAX_SHEETS + 1),
    supabase
      .from("spec_sections")
      .select("division, section_number, title")
      .eq("org_id", orgId)
      .eq("project_id", input.projectId),
  ])

  if (sheetsResult.error) {
    throw new Error(`Failed to load sheets: ${sheetsResult.error.message}`)
  }

  const allRows = sheetsResult.data ?? []
  const rows = allRows.slice(0, MAX_SHEETS)
  const truncated = allRows.length > rows.length

  const sheets: CoherenceSheet[] = rows
    .filter((row) => typeof row.sheet_number === "string" && row.sheet_number)
    .map((row) => ({
      id: row.id as string,
      sheetNumber: row.sheet_number as string,
      discipline: (row.discipline as string | null) ?? null,
      sheetTitle: (row.sheet_title as string | null) ?? null,
    }))

  const calloutsBySheet = await loadCurrentCalloutLinks(
    supabase,
    orgId,
    sheets.map((sheet) => sheet.id),
    new Map(rows.map((row) => [row.id as string, (row.current_revision_id as string | null) ?? null])),
  )

  const callouts: CoherenceCallout[] = []
  let sheetsWithoutCallouts = 0

  for (const sheet of sheets) {
    const links = calloutsBySheet.get(sheet.id)
    if (!links) {
      sheetsWithoutCallouts += 1
      continue
    }
    for (const target of links) {
      callouts.push({ fromSheetNumber: sheet.sheetNumber, targetSheetNumber: target })
    }
  }

  const specSections: CoherenceSpecSection[] = (specsResult.data ?? []).map((row) => ({
    division: (row.division as string | null) ?? null,
    sectionNumber: (row.section_number as string | null) ?? "",
    title: (row.title as string | null) ?? null,
  }))

  // Spec coverage is only meaningful once the specs are actually loaded; with no
  // sections at all, every mapped division would read as "uncovered", which is
  // an accusation about a project that simply has not uploaded its specs.
  const report = analyzeSetCoherence({
    sheets,
    callouts,
    specSections: specSections.filter((section) => section.sectionNumber),
  })

  return { ...report, truncated, sheetsWithoutCallouts }
}

/**
 * Callout links from each sheet's current published version.
 *
 * There is no `current_version_id` on a sheet, so "current" is resolved the way
 * the register resolves it: the newest version belonging to a published
 * revision, preferring the one on the sheet's own `current_revision_id`. Draft
 * and processing revisions are excluded at the database level — a pending
 * package must not make the live set look broken, or fixed.
 *
 * Returns a map missing an entry for any sheet whose callouts have not been
 * extracted, which the caller reports rather than treating as "no references".
 */
async function loadCurrentCalloutLinks(
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"],
  orgId: string,
  sheetIds: string[],
  currentRevisionBySheetId: Map<string, string | null>,
): Promise<Map<string, string[]>> {
  const bySheet = new Map<string, string[]>()
  if (sheetIds.length === 0) return bySheet

  const { data, error } = await supabase
    .from("drawing_sheet_versions")
    .select(
      "drawing_sheet_id, drawing_revision_id, extracted_metadata, created_at, drawing_revisions!drawing_sheet_versions_drawing_revision_id_fkey!inner(status)",
    )
    .eq("org_id", orgId)
    .in("drawing_sheet_id", sheetIds)
    .not("drawing_revisions.status", "in", "(processing,draft)")
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to load sheet versions: ${error.message}`)
  }

  const chosen = new Map<string, { isCurrentRevision: boolean; meta: Record<string, unknown> }>()
  for (const row of data ?? []) {
    const sheetId = row.drawing_sheet_id as string
    const isCurrentRevision = currentRevisionBySheetId.get(sheetId) === row.drawing_revision_id
    const existing = chosen.get(sheetId)
    // Rows arrive newest-first, so the first one wins unless a later row is the
    // sheet's own current revision.
    if (existing && !(isCurrentRevision && !existing.isCurrentRevision)) continue
    chosen.set(sheetId, {
      isCurrentRevision,
      meta: (row.extracted_metadata ?? {}) as Record<string, unknown>,
    })
  }

  for (const [sheetId, entry] of chosen) {
    const stored = parseStoredCalloutLinks(entry.meta.callout_links)
    if (!stored) continue
    bySheet.set(
      sheetId,
      stored.links.map((link) => link.targetSheetNumber),
    )
  }

  return bySheet
}
