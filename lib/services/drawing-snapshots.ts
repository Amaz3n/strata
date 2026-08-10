import "server-only"

/**
 * Viewport snapshots: freeze a region of a drawing sheet into a real `files`
 * row so an RFI or punch item created from the viewer carries a picture of
 * exactly what it is about, pinned to the sheet VERSION it was raised
 * against — later revisions don't rewrite the evidence.
 *
 * Snapshots are assembled from the tile pyramid already in R2 (same approach
 * as change detection in `drawings-pipeline.ts`): pick the cheapest level
 * that covers the region at output resolution, download only the tiles that
 * intersect it, composite, crop, encode. The source PDF is never re-rendered
 * — a version without tiles is an error, not a fallback path.
 *
 * All geometry is pure and unit-tested in `lib/drawings/region-snapshot.ts`.
 */

import { requireOrgContext } from "@/lib/services/context"
import { requireProjectPermission } from "@/lib/services/permissions"
import { createFileRecord } from "@/lib/services/files"
import { recordAudit } from "@/lib/services/audit"
import { uploadFilesObject } from "@/lib/storage/files-storage"
import { downloadTilesObject } from "@/lib/storage/drawings-tiles-storage"
import { getDrawingsTilesBaseUrl } from "@/lib/storage/drawings-urls"
import {
  clampRegion,
  planRegionSnapshot,
  tileLevelPlacement,
  SNAPSHOT_LONG_EDGE,
} from "@/lib/drawings/region-snapshot"
import {
  captureSheetRegionSnapshotSchema,
  type CaptureSheetRegionSnapshotInput,
} from "@/lib/validation/drawing-snapshots"

const SNAPSHOT_WEBP_QUALITY = 85
/**
 * Hard ceiling on tiles per snapshot. The level pick keeps a well-formed
 * pyramid far below this (region long edge < 2×SNAPSHOT_LONG_EDGE); the guard
 * exists so a malformed manifest (absurd tile size) fails loudly instead of
 * fanning out hundreds of downloads.
 */
const MAX_SNAPSHOT_TILES = 96
/** sharp input guard for legacy single-image "pyramids" — never unlimited. */
const SHARP_PIXEL_LIMIT = 75_000_000

interface SnapshotVersionRow {
  id: string
  drawing_sheet_id: string
  image_width: number | null
  image_height: number | null
  tile_manifest: Record<string, unknown> | null
  tiles_base_path: string | null
  tile_base_url: string | null
  drawing_sheets: {
    id: string
    project_id: string
    sheet_number: string
    sheet_title: string | null
  }
}

export interface SheetRegionSnapshotResult {
  fileId: string
  width: number
  height: number
}

async function loadSharp() {
  const sharpModule = await import("sharp")
  return sharpModule.default
}

/**
 * Storage path of a version's tiles. Modern rows store it; legacy rows only
 * carry the public `tile_base_url`, which is `${publicBase}/${path}` by
 * construction, so the path is recoverable by stripping the base. (Mirrors
 * the pipeline's resolver — it is not exported from there.)
 */
function resolveTilesBasePath(row: {
  tiles_base_path: string | null
  tile_base_url: string | null
}): string | null {
  if (row.tiles_base_path) return row.tiles_base_path
  const publicBase = getDrawingsTilesBaseUrl()
  if (publicBase && row.tile_base_url && row.tile_base_url.startsWith(`${publicBase}/`)) {
    return row.tile_base_url.slice(publicBase.length + 1)
  }
  return null
}

/**
 * Capture a frozen WebP of a normalized region of a sheet version and store
 * it as an org-scoped `files` row, ready to attach to an RFI or punch item
 * (`attachment_file_id` / `file_links`) like any other attachment.
 *
 * Gated on `drawing.read`: anyone who can see the sheet can snapshot it.
 */
export async function captureSheetRegionSnapshot(
  input: CaptureSheetRegionSnapshotInput,
  orgId?: string,
): Promise<SheetRegionSnapshotResult> {
  const parsed = captureSheetRegionSnapshotSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: versionRow, error: versionError } = await supabase
    .from("drawing_sheet_versions")
    .select(
      "id, drawing_sheet_id, image_width, image_height, tile_manifest, tiles_base_path, tile_base_url, drawing_sheets!inner(id, project_id, sheet_number, sheet_title)",
    )
    .eq("org_id", resolvedOrgId)
    .eq("id", parsed.sheetVersionId)
    .maybeSingle()
  if (versionError || !versionRow) {
    throw new Error("Sheet version not found")
  }
  const version = versionRow as unknown as SnapshotVersionRow
  const sheet = version.drawing_sheets

  await requireProjectPermission(userId, sheet.project_id, "drawing.read")

  const region = clampRegion(parsed.region)
  if (!region) {
    throw new Error("Snapshot region is empty after clamping to the sheet")
  }

  // Tiles are the only source — never fall back to re-rendering the PDF.
  const manifest = version.tile_manifest
  if (!manifest || typeof manifest !== "object" || manifest.Partial === true) {
    throw new Error(
      "This sheet version has no finished tile pyramid yet — snapshots read tiles and never re-render the PDF. Retry once processing completes.",
    )
  }
  const basePath = resolveTilesBasePath(version)
  if (!basePath) {
    throw new Error("This sheet version's tiles have no resolvable storage path")
  }

  const manifestImage = (manifest as { Image?: { Size?: { Width?: unknown; Height?: unknown }; Format?: unknown; TileSize?: unknown; Overlap?: unknown } }).Image
  const imageWidth = Number(manifestImage?.Size?.Width ?? version.image_width ?? 0)
  const imageHeight = Number(manifestImage?.Size?.Height ?? version.image_height ?? 0)
  if (!(imageWidth > 0) || !(imageHeight > 0)) {
    throw new Error("Sheet version has no recorded image dimensions")
  }
  const format =
    typeof manifestImage?.Format === "string" && manifestImage.Format
      ? manifestImage.Format.trim().toLowerCase()
      : "png"
  const rawLevels = (manifest as { Levels?: unknown }).Levels
  const levelCount =
    typeof rawLevels === "number" && Number.isFinite(rawLevels)
      ? Math.max(1, Math.floor(rawLevels))
      : 1
  // Legacy single-image manifests: one full-size tile at tiles/0/0_0.
  const tileSize =
    levelCount <= 1
      ? Math.max(imageWidth, imageHeight)
      : Math.max(1, Number(manifestImage?.TileSize ?? 512))
  const overlap = levelCount <= 1 ? 0 : Math.max(0, Number(manifestImage?.Overlap ?? 0))

  const plan = planRegionSnapshot({
    imageWidth,
    imageHeight,
    levelCount,
    tileSize,
    region,
    targetLongEdge: SNAPSHOT_LONG_EDGE,
  })

  const tileCount = (plan.tiles.x1 - plan.tiles.x0 + 1) * (plan.tiles.y1 - plan.tiles.y0 + 1)
  if (tileCount > MAX_SNAPSHOT_TILES) {
    throw new Error(`Snapshot region spans ${tileCount} tiles (max ${MAX_SNAPSHOT_TILES})`)
  }

  const placements: Array<{ x: number; y: number; left: number; top: number }> = []
  for (let y = plan.tiles.y0; y <= plan.tiles.y1; y++) {
    for (let x = plan.tiles.x0; x <= plan.tiles.x1; x++) {
      const placed = tileLevelPlacement(x, y, tileSize, overlap, plan.levelSize)
      placements.push({ x, y, left: placed.left, top: placed.top })
    }
  }
  const origin = tileLevelPlacement(plan.tiles.x0, plan.tiles.y0, tileSize, overlap, plan.levelSize)
  const last = tileLevelPlacement(plan.tiles.x1, plan.tiles.y1, tileSize, overlap, plan.levelSize)
  const canvasWidth = last.left + last.width - origin.left
  const canvasHeight = last.top + last.height - origin.top

  const tileBuffers = await Promise.all(
    placements.map(({ x, y }) =>
      downloadTilesObject({
        supabase,
        path: `${basePath}/tiles/${plan.level}/${x}_${y}.${format}`,
      }),
    ),
  )

  const sharp = await loadSharp()
  // One tile covers the range (incl. legacy full-sheet images): crop it
  // directly. Mosaics need two passes — sharp composites AFTER resize in a
  // single pipeline, so the canvas must be flattened to a buffer first.
  let sourceInput: Buffer
  let sourceRaw: { width: number; height: number; channels: 3 } | null = null
  if (placements.length === 1) {
    sourceInput = tileBuffers[0]
  } else {
    sourceInput = await sharp({
      create: {
        width: canvasWidth,
        height: canvasHeight,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .composite(
        placements.map(({ left, top }, index) => ({
          input: tileBuffers[index],
          left: left - origin.left,
          top: top - origin.top,
        })),
      )
      .raw()
      .toBuffer()
    sourceRaw = { width: canvasWidth, height: canvasHeight, channels: 3 }
  }

  const snapshotBuffer = await sharp(
    sourceInput,
    sourceRaw ? { raw: sourceRaw } : { limitInputPixels: SHARP_PIXEL_LIMIT },
  )
    .extract({
      left: plan.rect.x - origin.left,
      top: plan.rect.y - origin.top,
      width: plan.rect.w,
      height: plan.rect.h,
    })
    .resize(plan.output.width, plan.output.height, { fit: "fill" })
    .webp({ quality: SNAPSHOT_WEBP_QUALITY })
    .toBuffer()

  const sheetLabel = `${sheet.sheet_number} ${sheet.sheet_title ?? ""}`
    .replace(/[^\w .-]+/g, "")
    .trim()
  const fileName = `Snapshot ${sheetLabel || "sheet"}.webp`
  const storagePath = `${resolvedOrgId}/${sheet.project_id}/drawings/snapshots/${Date.now()}_${fileName.replace(/\s+/g, "-")}`

  await uploadFilesObject({
    supabase,
    orgId: resolvedOrgId,
    path: storagePath,
    bytes: snapshotBuffer,
    contentType: "image/webp",
  })

  const roundedRegion = {
    x: Math.round(region.x * 10_000) / 10_000,
    y: Math.round(region.y * 10_000) / 10_000,
    w: Math.round(region.w * 10_000) / 10_000,
    h: Math.round(region.h * 10_000) / 10_000,
  }

  // Same gate as the capture itself: someone who can see the sheet can hold
  // its snapshot, whether or not they hold general docs.upload. folder_path
  // stays "/" deliberately — any other value makes createFileRecord register
  // a project folder, and that sub-step hard-gates on project docs.upload,
  // which would silently re-tighten this drawing.read-only flow.
  const file = await createFileRecord(
    {
      project_id: sheet.project_id,
      file_name: fileName,
      storage_path: storagePath,
      mime_type: "image/webp",
      size_bytes: snapshotBuffer.length,
      visibility: "private",
      category: "plans",
      folder_path: "/",
      description: `Viewport snapshot of ${sheet.sheet_number}${sheet.sheet_title ? ` — ${sheet.sheet_title}` : ""}`,
      source: "generated",
      metadata: {
        drawing_snapshot: {
          sheet_id: sheet.id,
          sheet_version_id: version.id,
          region: roundedRegion,
          width: plan.output.width,
          height: plan.output.height,
        },
      },
    },
    resolvedOrgId,
    { authorizationPermission: "drawing.read" },
  )

  // createFileRecord audits the file insert; this ties the capture to the
  // sheet version so the drawing's history shows what was frozen and when.
  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "drawing_sheet_version",
    entityId: version.id,
    after: {
      snapshot_file_id: file.id,
      region: roundedRegion,
      width: plan.output.width,
      height: plan.output.height,
    },
    source: "viewport_snapshot",
  })

  return { fileId: file.id, width: plan.output.width, height: plan.output.height }
}
