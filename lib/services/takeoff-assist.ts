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
  runDrawingsVisionObject,
} from "@/lib/services/ai/drawings-vision"
import { renderSheetWindowImage } from "@/lib/services/drawings-sheet-images"
import {
  mergeWindowPoints,
  planVisionWindows,
  separationForExemplar,
  windowPointToSheet,
} from "@/lib/drawings/vision-windows"
import { verifySymbolProposals } from "@/lib/drawings/symbol-verify"
import { parseVectorsBin } from "@/lib/drawings/vector-snap"
import { downloadTilesObject } from "@/lib/storage/drawings-tiles-storage"
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
  /**
   * Proposals dropped for having no linework under them. Reported rather than
   * hidden: an estimator who sees "found 24, discarded 3" learns something
   * about the sheet that a bare 24 never tells them.
   */
  discarded: number
  /**
   * True when the sheet had too few vectors to check against (a scan). The
   * count stands, but nothing confirmed it, and the viewer says so.
   */
  unverified: boolean
}

/**
 * Whether the vision fallback can run at all. The viewer asks before offering
 * it, so a sheet with no vectors on an org with no vision provider says "no
 * scale of help available here" rather than spinning and failing.
 */
export function symbolVisionAvailable(): Promise<boolean> {
  return drawingsVisionConfigured()
}

/** A user is waiting on this; fail visibly rather than hang the action. */
const VISION_TIMEOUT_MS = 45_000
/** Source pixels each window should span, so it arrives near 1:1. */
const VISION_WINDOW_PIXELS = 2048
/** Ceiling on model calls for one assist run. */
const MAX_VISION_WINDOWS = 9
/**
 * Exemplar window when the viewer sent no snap extent — roughly a device symbol
 * at the pipeline's 150 DPI render. Only used for verification: it decides how
 * much linework counts as "under" a point, not what gets searched.
 */
const DEFAULT_EXEMPLAR_RADIUS_PX = 24

function buildSymbolCountPrompt(exemplar: { x: number; y: number }): string {
  const exemplarX = Math.round(exemplar.x * ASSIST_COORD_GRID)
  const exemplarY = Math.round(exemplar.y * ASSIST_COORD_GRID)
  return [
    "You are looking at one sheet from a set of construction drawings.",
    `ONE example symbol sits at approximately [${exemplarX}, ${exemplarY}] on the`,
    "coordinate grid described below. Look there first and identify that symbol.",
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
    `Coordinates run from 0 to ${ASSIST_COORD_GRID}, measured from the top-left of`,
    "the image, and each point is the CENTRE of one matched symbol.",
    `Return at most ${ASSIST_MAX_SYMBOL_MATCHES} points.`,
  ].join("\n")
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

  if (!(await drawingsVisionConfigured())) return null

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

  // Cover the search area with overlapping windows rendered near native
  // resolution, instead of one whole-sheet image squashed to 2048px. A symbol
  // that was six pixels across in the old path is now legible.
  const plan = planVisionWindows({
    imageWidth,
    imageHeight,
    targetPixels: VISION_WINDOW_PIXELS,
    maxWindows: MAX_VISION_WINDOWS,
    region: parsed.region ?? undefined,
  })
  if (plan.windows.length === 0) return null

  // The exemplar has to appear in every window's prompt, so each one is asked
  // the same question about the same symbol.
  const exemplarWindow = plan.windows.find(
    (window) =>
      parsed.x >= window.x0 && parsed.x <= window.x1 && parsed.y >= window.y0 && parsed.y <= window.y1,
  ) ?? plan.windows[0]
  const exemplarImage = await renderSheetWindowImage({
    supabase,
    tilesBasePath: version.tiles_base_path as string,
    imageWidth,
    imageHeight,
    window: exemplarWindow,
  }).catch(() => null)
  if (!exemplarImage) return null

  const exemplarInWindow: [number, number] = [
    (parsed.x - exemplarWindow.x0) / Math.max(1e-6, exemplarWindow.x1 - exemplarWindow.x0),
    (parsed.y - exemplarWindow.y0) / Math.max(1e-6, exemplarWindow.y1 - exemplarWindow.y0),
  ]

  const collected: Array<[number, number]> = []
  let truncated = false
  let anyAnswered = false

  for (const window of plan.windows) {
    const image = await renderSheetWindowImage({
      supabase,
      tilesBasePath: version.tiles_base_path as string,
      imageWidth,
      imageHeight,
      window,
    }).catch(() => null)
    if (!image) continue

    const answer = await runDrawingsVisionObject({
      schema: assistSymbolPointsSchema,
      prompt: buildSymbolCountPrompt({ x: exemplarInWindow[0], y: exemplarInWindow[1] }),
      // Exemplar first so the model sees the reference before the search area.
      images: window === exemplarWindow ? [image] : [exemplarImage, image],
      orgId: resolvedOrgId,
      entityType: "drawing_sheet",
      entityId: parsed.drawing_sheet_id,
      timeoutMs: VISION_TIMEOUT_MS,
    }).catch(() => null)
    if (!answer) continue
    anyAnswered = true

    if (answer.points.length > ASSIST_MAX_SYMBOL_MATCHES) truncated = true
    for (const point of answer.points.slice(0, ASSIST_MAX_SYMBOL_MATCHES)) {
      collected.push(
        windowPointToSheet(window, [point.x / ASSIST_COORD_GRID, point.y / ASSIST_COORD_GRID]),
      )
    }
  }

  // Every window failing is "cannot help", which the viewer words differently
  // from "looked and found nothing".
  if (!anyAnswered) return null

  const separation = separationForExemplar({
    searchRadiusPx: parsed.search_radius_px,
    imageWidth,
    imageHeight,
  })
  const merged = mergeWindowPoints(collected, separation)
    // A region restriction is the user's instruction and outranks any hit
    // an overlapping window contributed from outside it.
    .filter(([x, y]) => {
      if (!parsed.region) return true
      const { x0, y0, x1, y1 } = parsed.region
      return (
        x >= Math.min(x0, x1) && x <= Math.max(x0, x1) && y >= Math.min(y0, y1) && y <= Math.max(y0, y1)
      )
    })
    .slice(0, ASSIST_MAX_SYMBOL_MATCHES)

  if (collected.length > ASSIST_MAX_SYMBOL_MATCHES) truncated = true

  // The sheet's own linework gets the last word. On a vector sheet a proposal
  // with nothing drawn under it is discarded before it can become a count; on a
  // scan there is nothing to check against and the count ships unverified.
  const segments = await loadSheetSegments(supabase, version.tiles_base_path as string)
  const verdict = verifySymbolProposals({
    proposals: merged.map(([x, y]) => ({ x, y })),
    segments,
    imageSize: { width: imageWidth, height: imageHeight },
    exemplar: { x: parsed.x, y: parsed.y },
    radiusPx: parsed.search_radius_px ?? DEFAULT_EXEMPLAR_RADIUS_PX,
  })
  const points: Array<[number, number]> = verdict.supported.map((point) => [point.x, point.y])

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "takeoff_symbol_vision_proposed",
    entityType: "drawing_sheet",
    entityId: parsed.drawing_sheet_id,
    payload: {
      proposed: points.length,
      discarded: verdict.rejected.length,
      unverified: verdict.skipped,
      truncated,
    },
  })

  return {
    points,
    truncated,
    discarded: verdict.rejected.length,
    unverified: verdict.skipped,
  }
}

/**
 * The sheet's extracted linework, or an empty set.
 *
 * A missing or unreadable `vectors.bin` is the normal case for a scan, which is
 * exactly the sheet the vision fallback exists to serve — so it degrades to
 * "nothing to verify against" rather than to an error.
 */
async function loadSheetSegments(
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"],
  tilesBasePath: string,
): Promise<Float32Array> {
  try {
    const buffer = await downloadTilesObject({ supabase, path: `${tilesBasePath}/vectors.bin` })
    const parsed = parseVectorsBin(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
    )
    return parsed?.segments ?? new Float32Array(0)
  } catch {
    return new Float32Array(0)
  }
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
