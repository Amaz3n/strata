import "server-only"

/**
 * The service half of vision-assisted floorplan interpretation: build a
 * readable image of the sheet from its stored tile pyramid, ask the configured
 * drawings-vision model to trace walls and read room names, and fold the
 * proposal into the interpreted level via the pure reconciler in
 * `lib/drawings/floorplan-vision.ts`.
 *
 * Assist is strictly additive and strictly optional: any failure — no
 * provider, no tiles, a garbled reply — leaves the vector-only model exactly
 * as it was. Interpretation must never get WORSE because a model call failed.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import {
  applyVisionProposal,
  buildFloorplanVisionPrompt,
  parseFloorplanVisionProposal,
} from "@/lib/drawings/floorplan-vision"
import type { FloorplanModel } from "@/lib/drawings/floorplan-model"
import {
  drawingsVisionConfigured,
  runDrawingsVisionPrompt,
} from "@/lib/services/drawings-pipeline"
import { downloadTilesObject } from "@/lib/storage/drawings-tiles-storage"

/** Must match the pipeline's dzsave tile size or the stitch shears. */
const TILE_SIZE = Number.parseInt(process.env.DRAWINGS_TILE_SIZE ?? "512", 10)
/** Long-edge budget for the vision image — legible without a giant payload. */
const VISION_IMAGE_MAX_EDGE = 2048
/** Tile-count ceiling; past this something is wrong with the level math. */
const MAX_STITCH_TILES = 64

/**
 * Compose one mid-resolution image of a sheet from its DZI pyramid.
 *
 * The stored thumbnail is 256px — decorative, not readable. The pyramid
 * already holds every resolution, so the right level is picked by halving the
 * full-size dimensions (with ceil, exactly as libvips builds the levels) until
 * the long edge fits the budget, then its tiles are stitched back together.
 */
export async function stitchSheetImageDataUrl(params: {
  supabase: SupabaseClient
  tilesBasePath: string
  imageWidth: number
  imageHeight: number
}): Promise<string | null> {
  const { supabase, tilesBasePath, imageWidth, imageHeight } = params
  if (!(imageWidth > 0) || !(imageHeight > 0)) return null

  const maxLevel = Math.ceil(Math.log2(Math.max(imageWidth, imageHeight)))
  let level = maxLevel
  let width = imageWidth
  let height = imageHeight
  while (Math.max(width, height) > VISION_IMAGE_MAX_EDGE && level > 0) {
    level--
    width = Math.ceil(width / 2)
    height = Math.ceil(height / 2)
  }

  const cols = Math.ceil(width / TILE_SIZE)
  const rows = Math.ceil(height / TILE_SIZE)
  if (cols * rows > MAX_STITCH_TILES) return null

  const tiles: Array<{ input: Buffer; left: number; top: number }> = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const buffer = await downloadTilesObject({
        supabase,
        path: `${tilesBasePath}/tiles/${level}/${col}_${row}.webp`,
      })
      tiles.push({ input: buffer, left: col * TILE_SIZE, top: row * TILE_SIZE })
    }
  }

  const sharp = (await import("sharp")).default
  const composed = await sharp({
    create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite(tiles)
    .webp({ quality: 80 })
    .toBuffer()
  return `data:image/webp;base64,${composed.toString("base64")}`
}

export interface VisionAssistStats {
  assistedLevels: number
  addedWalls: number
  confirmedWalls: number
  labeledRooms: number
}

/**
 * Run vision assist over every level that could use it, in place.
 *
 * "Could use it" means: no walls at all (a scan — vision is the only source),
 * shaky wall confidence, or rooms without names. A level the vectors already
 * nailed does not spend a model call.
 */
export async function assistFloorplanModelWithVision(params: {
  supabase: SupabaseClient
  model: FloorplanModel
  tilesBasePathBySheet: Map<string, string>
}): Promise<VisionAssistStats | null> {
  const { supabase, model, tilesBasePathBySheet } = params
  if (!drawingsVisionConfigured()) return null

  const stats: VisionAssistStats = {
    assistedLevels: 0,
    addedWalls: 0,
    confirmedWalls: 0,
    labeledRooms: 0,
  }

  for (let index = 0; index < model.levels.length; index++) {
    const level = model.levels[index]
    const tilesBasePath = tilesBasePathBySheet.get(level.source.sheetVersionId)
    if (!tilesBasePath) continue

    const visionOnly = level.walls.length === 0
    const needsHelp =
      visionOnly ||
      level.confidence.walls < 0.8 ||
      level.rooms.length === 0 ||
      level.rooms.some((room) => !room.label)
    if (!needsHelp) continue

    try {
      const dataUrl = await stitchSheetImageDataUrl({
        supabase,
        tilesBasePath,
        imageWidth: level.source.imageWidth,
        imageHeight: level.source.imageHeight,
      })
      if (!dataUrl) continue
      const raw = await runDrawingsVisionPrompt({
        prompt: buildFloorplanVisionPrompt(level.name),
        images: [{ dataUrl }],
      })
      if (!raw) continue
      const proposal = parseFloorplanVisionProposal(raw)
      if (!proposal) continue

      const result = applyVisionProposal(level, proposal, { acceptAllWalls: visionOnly })
      model.levels[index] = result.level
      stats.assistedLevels++
      stats.addedWalls += result.addedWalls
      stats.confirmedWalls += result.confirmedWalls
      stats.labeledRooms += result.labeledRooms
    } catch {
      // Assist is best-effort by contract; the vector-only level stands.
      continue
    }
  }

  return stats
}
