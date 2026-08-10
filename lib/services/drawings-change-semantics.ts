import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import {
  boundsOfPoints,
  boxArea,
  changeSeverity,
  isQuantityBearing,
  matchItemsToRegions,
  rankClassifiedRegions,
  summarizeRevisionImpact,
  CHANGE_KINDS,
  CHANGE_SEMANTICS_ALGO,
  type Box,
  type ChangeKind,
  type ChangeSeverity,
  type RevisionImpactSummary,
} from "@/lib/drawings/change-impact"
import { runDrawingsVisionObject } from "@/lib/services/ai/drawings-vision"
import { stitchSheetImage } from "@/lib/services/drawings-sheet-images"

/**
 * What actually changed on a re-issued sheet, and what it costs.
 *
 * The pixel diff that runs before this is honest and blunt: it reports that
 * eleven rectangles on A-201 have different pixels than last time. Every
 * superintendent's next question — "do any of those matter?" — it cannot
 * answer, so in practice the diff gets glanced at once and ignored after that.
 *
 * Two things turn the boxes into an answer, and they are deliberately different
 * kinds of thing:
 *
 * 1. WHAT KIND of change each region is — moved linework versus a revision
 *    cloud versus a re-plotted title block. Only a model can read that, so a
 *    model does, and it is given both versions of the sheet so it is comparing
 *    rather than guessing.
 * 2. WHAT IT TOUCHES — which takeoff measurements, count markups, and linked
 *    RFI/CO pins sit inside each region. Arc already knows where all of those
 *    live in sheet space, so this is a geometric join in pure code. The model is
 *    never asked, because the answer is not a matter of opinion.
 *
 * Severity comes from combining them, which is the whole point: a hand-sized
 * region that moved a wall four measurements price off outranks a quarter-page
 * region that turned out to be a revision cloud. Ranking by area — all the pixel
 * diff could do — got that backwards every time.
 *
 * Results are written onto the existing `change_detection` blob rather than a
 * new table: they have exactly the same lifetime as the diff they annotate, and
 * a sheet version that gets re-diffed must not keep stale semantics.
 */

/** Regions classified in one pass. Past this, a reviewer is reading noise. */
const MAX_CLASSIFIED_REGIONS = 12

/** Region rendering is one call per sheet; a user is not waiting on it. */
const CLASSIFY_TIMEOUT_MS = 90_000

const regionClassificationSchema = z.object({
  classifications: z.array(
    z.object({
      index: z.number().int().min(0).describe("The region number given in the prompt"),
      kind: z.enum(CHANGE_KINDS),
      summary: z
        .string()
        .max(160)
        .describe("What changed here, in one short phrase a superintendent would use"),
      confidence: z.enum(["high", "medium", "low"]),
    }),
  ),
})

const CLASSIFY_SYSTEM = [
  "You compare two issues of the same construction drawing sheet and say what changed in specific regions.",
  "You are given the PREVIOUS issue first and the CURRENT issue second, plus a numbered list of regions",
  "where the pixels differ.",
  "",
  "For each region, classify it:",
  "- added: linework, equipment, fixtures or dimensions that are on the current sheet and not the previous one.",
  "- removed: the reverse.",
  "- modified: the same element, moved, resized, or re-dimensioned.",
  "- annotation: revision clouds, deltas, notes, leaders, keynotes — marks ABOUT the drawing, not the drawing.",
  "- titleblock: anything in the border, title block, revision table, stamp, or date.",
  "- noise: rendering or scanning artifacts, no real difference.",
  "",
  "Judge only what you can see. A region you cannot read is 'noise' — never invent a change to fill it in.",
  "Keep summaries concrete: 'wall moved 2ft south', not 'geometry updated'.",
].join("\n")

export interface ChangeRegionSemantics {
  region: Box
  kind: ChangeKind
  summary: string
  confidence: "high" | "medium" | "low"
  severity: ChangeSeverity
  affectedRecords: number
  /** Human-readable labels of what sits in this region, capped for display. */
  affected: Array<{ type: "measurement" | "count" | "pin"; id: string; label: string }>
}

export interface SheetChangeSemantics {
  algo: string
  computedAt: string
  regions: ChangeRegionSemantics[]
  summary: RevisionImpactSummary
  /** True when more regions were found than were classified. */
  truncated: boolean
}

interface SheetImageRow {
  tile_manifest: Record<string, unknown> | null
  tiles_base_path: string | null
}

function manifestSize(manifest: Record<string, unknown> | null) {
  const image = (manifest as { Image?: { Size?: { Width?: unknown; Height?: unknown } } } | null)?.Image
  const width = Number(image?.Size?.Width ?? 0)
  const height = Number(image?.Size?.Height ?? 0)
  return width > 0 && height > 0 ? { width, height } : null
}

/**
 * Everything on this sheet that has a position and a cost attached.
 *
 * Markups carry their geometry as normalized points, and pins carry a single
 * coordinate; both reduce to a bounding box the region matcher can test. A
 * markup with a `condition_id` is a priced quantity and is called a
 * measurement; the rest are still worth reporting, because a count of fixtures
 * inside a region that changed is exactly as re-countable.
 */
async function loadPositionedRecords(
  supabase: SupabaseClient,
  orgId: string,
  sheetId: string,
  sheetVersionId: string,
) {
  const [markupsResult, pinsResult] = await Promise.all([
    supabase
      .from("drawing_markups")
      .select("id, data, label, condition_id, quantity, uom")
      .eq("org_id", orgId)
      .eq("drawing_sheet_id", sheetId)
      .eq("sheet_version_id", sheetVersionId),
    supabase
      .from("drawing_pins")
      .select("id, x_position, y_position, entity_type, label")
      .eq("org_id", orgId)
      .eq("drawing_sheet_id", sheetId)
      .eq("sheet_version_id", sheetVersionId),
  ])

  const records: Array<{
    item: { type: "measurement" | "count" | "pin"; id: string; label: string }
    box: Box | null
  }> = []

  for (const row of markupsResult.data ?? []) {
    const data = row.data as { type?: string; points?: Array<[number, number]> } | null
    const points = Array.isArray(data?.points) ? data.points : []
    const box = boundsOfPoints(points)
    if (!box) continue

    const type = data?.type === "count" ? "count" : "measurement"
    const quantity = row.quantity as number | null
    const uom = row.uom as string | null
    const measured = quantity != null && uom ? ` — ${quantity} ${uom}` : ""
    records.push({
      item: {
        type,
        id: row.id as string,
        label: `${(row.label as string | null) ?? (type === "count" ? "Count" : "Measurement")}${measured}`,
      },
      box,
    })
  }

  for (const row of pinsResult.data ?? []) {
    const x = Number(row.x_position)
    const y = Number(row.y_position)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    records.push({
      item: {
        type: "pin",
        id: row.id as string,
        label: (row.label as string | null) ?? `${row.entity_type as string}`,
      },
      box: { x, y, w: 0, h: 0 },
    })
  }

  return records
}

/**
 * Classify the changed regions on one sheet version and join them to what they
 * touch.
 *
 * One model call per sheet, not one per region: the classification asked for is
 * coarse ("is this linework or a note?"), a whole-sheet pair gives the model the
 * context to tell a title block from a plan area, and twelve calls per sheet
 * across a four-hundred-sheet re-issue is a bill nobody agreed to. Regions are
 * numbered in the prompt and the model answers by index.
 *
 * Returns null when it could not run — no provider, no tiles, an unusable
 * answer. The caller keeps the pixel diff either way; semantics are strictly
 * additive to a result that already stands on its own.
 */
export async function classifyChangedRegions(input: {
  supabase: SupabaseClient
  orgId: string
  sheetId: string
  sheetVersionId: string
  priorVersion: SheetImageRow
  currentVersion: SheetImageRow
  regions: Box[]
}): Promise<SheetChangeSemantics | null> {
  const { supabase, orgId, sheetId, sheetVersionId, priorVersion, currentVersion } = input
  if (input.regions.length === 0) return null

  const currentSize = manifestSize(currentVersion.tile_manifest)
  const priorSize = manifestSize(priorVersion.tile_manifest)
  if (!currentSize || !priorSize) return null
  if (!currentVersion.tiles_base_path || !priorVersion.tiles_base_path) return null

  // Biggest first, so the cap drops the least consequential regions. Their
  // ORIGINAL index is not preserved on purpose — the model is renumbered 0..n
  // over exactly what it is shown, which is the only numbering it can be right
  // about.
  const ordered = [...input.regions].sort((a, b) => boxArea(b) - boxArea(a))
  const regions = ordered.slice(0, MAX_CLASSIFIED_REGIONS)
  const truncated = ordered.length > regions.length

  const [beforeImage, afterImage] = await Promise.all([
    stitchSheetImage({
      supabase,
      tilesBasePath: priorVersion.tiles_base_path,
      imageWidth: priorSize.width,
      imageHeight: priorSize.height,
    }).catch(() => null),
    stitchSheetImage({
      supabase,
      tilesBasePath: currentVersion.tiles_base_path,
      imageWidth: currentSize.width,
      imageHeight: currentSize.height,
    }).catch(() => null),
  ])
  if (!beforeImage || !afterImage) return null

  const regionLines = regions.map(
    (region, index) =>
      `Region ${index}: x ${pct(region.x)}–${pct(region.x + region.w)}, ` +
      `y ${pct(region.y)}–${pct(region.y + region.h)} (from the top-left)`,
  )

  const answer = await runDrawingsVisionObject({
    schema: regionClassificationSchema,
    system: CLASSIFY_SYSTEM,
    prompt: [
      "Image 1 is the PREVIOUS issue of this sheet. Image 2 is the CURRENT issue.",
      "These regions differ between them:",
      regionLines.join("\n"),
      truncated
        ? `Only the ${regions.length} largest of ${ordered.length} changed regions are listed; ` +
          "classify the listed ones and do not speculate about the rest."
        : "",
      `Return one classification per region, using the region numbers above (0 to ${regions.length - 1}).`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    images: [beforeImage, afterImage],
    orgId,
    entityType: "drawing_sheet_version",
    entityId: sheetVersionId,
    timeoutMs: CLASSIFY_TIMEOUT_MS,
    // The model may only answer about regions it was shown; anything else is
    // discarded rather than escalated, exactly as with every other closed set.
    verify: (value) => {
      const known = value.classifications.filter((entry) => entry.index < regions.length)
      return known.length > 0
        ? { ok: true }
        : { ok: false, message: "No classification referred to a listed region." }
    },
  })
  if (!answer) return null

  const records = await loadPositionedRecords(supabase, orgId, sheetId, sheetVersionId)
  const matches = matchItemsToRegions(regions, records)

  // Invert the match: the report reads region-first.
  const byRegion = new Map<number, Array<{ type: "measurement" | "count" | "pin"; id: string; label: string }>>()
  for (const match of matches) {
    for (const index of match.regionIndexes) {
      const list = byRegion.get(index) ?? []
      list.push(match.item)
      byRegion.set(index, list)
    }
  }

  const byIndex = new Map(
    answer.classifications
      .filter((entry) => entry.index >= 0 && entry.index < regions.length)
      .map((entry) => [entry.index, entry] as const),
  )

  const classified: ChangeRegionSemantics[] = regions.map((region, index) => {
    const entry = byIndex.get(index)
    const affected = byRegion.get(index) ?? []
    // A region the model skipped is still a region the pixels say changed.
    // "modified" is the honest default: something differs and we do not know
    // what, which is exactly what the pixel diff already established.
    const kind: ChangeKind = entry?.kind ?? "modified"
    return {
      region,
      kind,
      summary: entry?.summary.trim() || "Changed area — not classified.",
      confidence: entry?.confidence ?? "low",
      severity: changeSeverity({
        kind,
        affectedRecords: affected.length,
        areaShare: boxArea(region),
      }),
      affectedRecords: affected.length,
      affected: affected.slice(0, 8),
    }
  })

  const distinctAffected = new Set(
    matches
      .filter((match) =>
        match.regionIndexes.some((index) => isQuantityBearing(classified[index].kind)),
      )
      .map((match) => match.item.id),
  )

  return {
    algo: CHANGE_SEMANTICS_ALGO,
    computedAt: new Date().toISOString(),
    regions: rankClassifiedRegions(classified),
    summary: summarizeRevisionImpact(classified, distinctAffected.size),
    truncated,
  }
}

function pct(value: number) {
  return `${Math.round(value * 100)}%`
}

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

export interface SheetChangeReport {
  sheetId: string
  sheetVersionId: string
  sheetNumber: string
  sheetTitle: string | null
  /** Changed pixels / total, from the diff. Null when the sheet is new. */
  changedRatio: number | null
  /** True when the sheet's source bytes were identical to the prior issue. */
  identicalSource: boolean
  semantics: SheetChangeSemantics | null
  /** Regions the diff found, before classification capped them. */
  regionCount: number
}

export interface RevisionChangeReport {
  revisionId: string
  /** Sheets that changed at all, most consequential first. */
  sheets: SheetChangeReport[]
  /** Sheets in the revision whose bytes were identical to the prior issue. */
  unchangedSheets: number
  /** Sheets whose diff has run but whose classification has not (or could not). */
  unclassifiedSheets: number
  totalHighSeverityRegions: number
  totalAffectedRecords: number
}

function parseSemantics(value: unknown): SheetChangeSemantics | null {
  if (!value || typeof value !== "object") return null
  const record = value as Partial<SheetChangeSemantics>
  if (record.algo !== CHANGE_SEMANTICS_ALGO) return null
  if (!Array.isArray(record.regions) || !record.summary) return null
  return record as SheetChangeSemantics
}

/**
 * The "what changed" report for one published revision.
 *
 * Reads what the pipeline already stored — no model call, no rendering — so it
 * is cheap enough to load with the page. A sheet with no `change_detection` at
 * all is omitted rather than reported as unchanged: the diff may simply not have
 * reached it yet, and claiming a sheet is clean when nothing has looked at it is
 * the one failure mode that would make this feature dangerous.
 */
export async function buildRevisionChangeReport(input: {
  supabase: SupabaseClient
  orgId: string
  revisionId: string
}): Promise<RevisionChangeReport> {
  const { supabase, orgId, revisionId } = input

  const { data, error } = await supabase
    .from("drawing_sheet_versions")
    .select(
      "id, drawing_sheet_id, extracted_metadata, drawing_sheets!inner(sheet_number, sheet_title)",
    )
    .eq("org_id", orgId)
    .eq("drawing_revision_id", revisionId)

  if (error) {
    throw new Error(`Failed to load change report: ${error.message}`)
  }

  const sheets: SheetChangeReport[] = []
  let unchangedSheets = 0
  let unclassifiedSheets = 0

  for (const row of data ?? []) {
    const meta = (row.extracted_metadata ?? {}) as Record<string, unknown>
    const detection = meta.change_detection as Record<string, unknown> | undefined
    if (!detection) continue

    if (detection.identical_source === true) {
      unchangedSheets += 1
      continue
    }

    const changedRatio = typeof detection.changed_ratio === "number" ? detection.changed_ratio : null
    if (changedRatio === 0) {
      unchangedSheets += 1
      continue
    }

    const semantics = parseSemantics(detection.semantics)
    if (!semantics) unclassifiedSheets += 1

    const sheet = row.drawing_sheets as unknown as {
      sheet_number: string
      sheet_title: string | null
    }

    sheets.push({
      sheetId: row.drawing_sheet_id as string,
      sheetVersionId: row.id as string,
      sheetNumber: sheet?.sheet_number ?? "—",
      sheetTitle: sheet?.sheet_title ?? null,
      changedRatio,
      identicalSource: false,
      semantics,
      regionCount: typeof detection.region_count === "number" ? detection.region_count : 0,
    })
  }

  // Sheets a person must look at first: most high-severity regions, then most
  // affected records, then most changed. An unclassified sheet sorts on ratio
  // alone, which is where every sheet used to sort.
  sheets.sort((a, b) => {
    const high = (b.semantics?.summary.highSeverity ?? 0) - (a.semantics?.summary.highSeverity ?? 0)
    if (high !== 0) return high
    const affected =
      (b.semantics?.summary.affectedRecords ?? 0) - (a.semantics?.summary.affectedRecords ?? 0)
    if (affected !== 0) return affected
    return (b.changedRatio ?? 0) - (a.changedRatio ?? 0)
  })

  return {
    revisionId,
    sheets,
    unchangedSheets,
    unclassifiedSheets,
    totalHighSeverityRegions: sheets.reduce(
      (total, sheet) => total + (sheet.semantics?.summary.highSeverity ?? 0),
      0,
    ),
    totalAffectedRecords: sheets.reduce(
      (total, sheet) => total + (sheet.semantics?.summary.affectedRecords ?? 0),
      0,
    ),
  }
}
