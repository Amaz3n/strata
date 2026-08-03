import "server-only"

/**
 * Count by example — the server half.
 *
 * The geometric matcher (`lib/drawings/symbol-match.ts`) runs in the VIEWER,
 * against vectors the viewer already downloaded for snapping. On the sheets the
 * vector spike measured, that path handles every sheet with usable linework, and
 * it costs nothing and returns instantly. This module exists for the rest:
 *
 *   - `findSymbolMatchesByVision` — the fallback for scanned sheets and sheets
 *     whose exporter shredded the symbol into unmatched fragments.
 *   - `acceptSymbolMatches` — turning an approved proposal into a real count.
 *
 * The acceptance path is the important one. The client sends back only the
 * points a human kept, and the quantity is re-derived here from those points, so
 * a count that flows into an estimate is never a number the client supplied.
 * That invariant is the same one every other measured quantity in Arc obeys.
 */

import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { assertConditionAcceptsUom } from "@/lib/services/drawing-measurements"
import { createDrawingMarkup } from "@/lib/services/drawing-markups"
import {
  drawingsVisionConfigured,
  runDrawingsVisionPrompt,
} from "@/lib/services/drawings-pipeline"
import { stitchSheetImageDataUrl } from "@/lib/services/floorplan-vision-assist"
import {
  acceptSymbolMatchesSchema,
  assistSymbolPointsSchema,
  ASSIST_COORD_GRID,
  ASSIST_MAX_SYMBOL_MATCHES,
  findSymbolMatchesSchema,
  type AcceptSymbolMatchesInput,
  type FindSymbolMatchesInput,
} from "@/lib/validation/takeoff"

export interface VisionSymbolProposal {
  /** Normalized 0..1 sheet coordinates, one per proposed symbol. */
  points: Array<[number, number]>
  /** True when the model hit the ceiling — the caller must disclose it. */
  truncated: boolean
}

/**
 * Whether the vision fallback can run at all. The viewer asks before offering
 * it, so a sheet with no vectors on an org with no vision provider says "no
 * scale of help available here" rather than spinning and failing.
 */
export function symbolVisionAvailable(): boolean {
  return drawingsVisionConfigured()
}

function buildSymbolCountPrompt(): string {
  return [
    "You are looking at one sheet from a set of construction drawings.",
    "A red box marks ONE example symbol.",
    "",
    "Find every OTHER occurrence of that same symbol on this sheet.",
    "",
    "Rules:",
    "- Match the symbol's drawn shape, not what you think it means.",
    "- A symbol rotated or mirrored is still the same symbol.",
    "- A symbol carrying a different letter or subscript tag is NOT the same symbol.",
    "- Do not include the example itself.",
    "- Do not include anything inside a legend, schedule, or title block.",
    "- If you are not confident, return fewer points. An empty list is a valid answer.",
    "",
    `Answer with JSON only: {"points": [[x, y], ...]} where x and y are integers`,
    `from 0 to ${ASSIST_COORD_GRID}, measured from the top-left of the image,`,
    "and each point is the CENTRE of one matched symbol.",
    `Return at most ${ASSIST_MAX_SYMBOL_MATCHES} points.`,
  ].join("\n")
}

/** Tolerate a fenced block or leading prose around the JSON. */
function extractJsonObject(raw: string): unknown | null {
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
}

/**
 * Ask a vision model to find the symbol the user clicked.
 *
 * Returns null — not an empty list — when the fallback could not run at all (no
 * provider, no tiles, an unreadable reply). Null means "this sheet cannot be
 * helped"; an empty list means "looked, found nothing", and the viewer says
 * different things about those two.
 */
export async function findSymbolMatchesByVision(
  input: FindSymbolMatchesInput,
  orgId?: string,
): Promise<VisionSymbolProposal | null> {
  const parsed = findSymbolMatchesSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("takeoff.read", { supabase, orgId: resolvedOrgId, userId })

  if (!drawingsVisionConfigured()) return null

  const { data: version } = await supabase
    .from("drawing_sheet_versions")
    .select("id, drawing_sheet_id, image_width, image_height, tiles_base_path, tile_manifest")
    .eq("org_id", resolvedOrgId)
    .eq("id", parsed.sheet_version_id)
    .maybeSingle()

  if (!version?.tiles_base_path) return null
  if (version.drawing_sheet_id !== parsed.drawing_sheet_id) {
    throw new Error("That sheet version does not belong to this sheet")
  }

  const manifestSize = (version.tile_manifest as any)?.Image?.Size
  const imageWidth = Number(manifestSize?.Width ?? version.image_width ?? 0)
  const imageHeight = Number(manifestSize?.Height ?? version.image_height ?? 0)
  if (!(imageWidth > 0) || !(imageHeight > 0)) return null

  let dataUrl: string | null = null
  try {
    dataUrl = await stitchSheetImageDataUrl({
      supabase,
      tilesBasePath: version.tiles_base_path as string,
      imageWidth,
      imageHeight,
    })
  } catch {
    return null
  }
  if (!dataUrl) return null

  const raw = await runDrawingsVisionPrompt({
    prompt: buildSymbolCountPrompt(),
    images: [{ dataUrl }],
  })
  if (!raw) return null

  const json = extractJsonObject(raw)
  if (!json) return null
  const result = assistSymbolPointsSchema.safeParse(json)
  if (!result.success) return null

  const truncated = result.data.points.length > ASSIST_MAX_SYMBOL_MATCHES
  const points = result.data.points
    .slice(0, ASSIST_MAX_SYMBOL_MATCHES)
    .map(([x, y]) => [x / ASSIST_COORD_GRID, y / ASSIST_COORD_GRID] as [number, number])
    // The model was pointed at the whole sheet; a region restriction is the
    // user's instruction and outranks anything it returned outside it.
    .filter(([x, y]) => {
      if (!parsed.region) return true
      const { x0, y0, x1, y1 } = parsed.region
      return (
        x >= Math.min(x0, x1) &&
        x <= Math.max(x0, x1) &&
        y >= Math.min(y0, y1) &&
        y <= Math.max(y0, y1)
      )
    })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "takeoff_symbol_vision_proposed",
    entityType: "drawing_sheet",
    entityId: parsed.drawing_sheet_id,
    payload: { proposed: points.length, truncated },
  })

  return { points, truncated }
}

export interface AcceptSymbolMatchesResult {
  markup_id: string
  /** The count the server derived. Always equal to the accepted point count. */
  quantity: number
}

/**
 * Turn an approved proposal into one real count markup.
 *
 * All accepted points land in a SINGLE markup, which is how the count tool
 * already works: one markup holds a batch of clicks and its quantity is their
 * number. That keeps a proposal reviewable and reversible as one object — an
 * estimator who changes their mind deletes one thing, not two hundred.
 */
export async function acceptSymbolMatches(
  input: AcceptSymbolMatchesInput,
  orgId?: string,
): Promise<AcceptSymbolMatchesResult> {
  const parsed = acceptSymbolMatchesSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("takeoff.write", { supabase, orgId: resolvedOrgId, userId })

  const { data: version } = await supabase
    .from("drawing_sheet_versions")
    .select("id, drawing_sheet_id")
    .eq("org_id", resolvedOrgId)
    .eq("id", parsed.sheet_version_id)
    .maybeSingle()

  if (!version || version.drawing_sheet_id !== parsed.drawing_sheet_id) {
    throw new Error("That sheet version does not belong to this sheet")
  }

  // A count measures in EA whatever the condition reports, so the guard runs
  // before the write rather than after — an assignment that would be refused
  // must not leave an orphaned markup behind.
  if (parsed.condition_id) {
    await assertConditionAcceptsUom(supabase, resolvedOrgId, parsed.condition_id, "ea")
  }

  const { data: condition } = parsed.condition_id
    ? await supabase
        .from("takeoff_conditions")
        .select("color, name")
        .eq("org_id", resolvedOrgId)
        .eq("id", parsed.condition_id)
        .maybeSingle()
    : { data: null }

  const markup = await createDrawingMarkup(
    {
      drawing_sheet_id: parsed.drawing_sheet_id,
      sheet_version_id: parsed.sheet_version_id,
      data: {
        type: "count",
        points: parsed.points,
        color: (condition?.color as string) ?? "#FF0000",
        strokeWidth: 2,
        // Stamped so the panel, the audit trail, and anyone reading this later
        // can tell a proposed-then-approved count from a hand-clicked one. It
        // changes nothing about how the quantity is treated — a human accepted
        // it, so it counts — but pretending it was hand-clicked would be a lie.
        style: { generated: "symbol_match" },
      },
      label: parsed.label ?? (condition?.name as string) ?? null,
      condition_id: parsed.condition_id,
    },
    resolvedOrgId,
  )

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "drawing_markup",
    entityId: markup.id,
    after: {
      source: "symbol_match",
      accepted_points: parsed.points.length,
      condition_id: parsed.condition_id,
    },
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "takeoff_symbol_matches_accepted",
    entityType: "drawing_markup",
    entityId: markup.id,
    payload: {
      drawing_sheet_id: parsed.drawing_sheet_id,
      condition_id: parsed.condition_id,
      quantity: parsed.points.length,
    },
  })

  return { markup_id: markup.id, quantity: markup.quantity ?? parsed.points.length }
}
