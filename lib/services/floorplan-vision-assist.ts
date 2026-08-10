import "server-only"

/**
 * The service half of vision-assisted floorplan interpretation: ask the
 * configured drawings-vision model to trace walls and read room names off a
 * rendered sheet, and fold the proposal into the interpreted level via the pure
 * reconciler in `lib/drawings/floorplan-vision.ts`.
 *
 * Assist is strictly additive and strictly optional: any failure — no
 * provider, no tiles, a garbled reply — leaves the vector-only model exactly
 * as it was. Interpretation must never get WORSE because a model call failed.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import {
  applyVisionProposal,
  buildFloorplanVisionPrompt,
  sanitizeFloorplanVisionProposal,
} from "@/lib/drawings/floorplan-vision"
import type { FloorplanModel } from "@/lib/drawings/floorplan-model"
import {
  drawingsVisionConfigured,
  runDrawingsVisionObject,
} from "@/lib/services/ai/drawings-vision"
import { stitchSheetImage } from "@/lib/services/drawings-sheet-images"

/**
 * What the model is asked to return. Walls and rooms in normalized image space
 * — the same space `vectors.bin` uses — so a proposal drops straight into
 * `normalizedToModel` with no bespoke mapping.
 */
const floorplanProposalSchema = z.object({
  walls: z.array(
    z.object({
      x0: z.number(),
      y0: z.number(),
      x1: z.number(),
      y1: z.number(),
    }),
  ),
  rooms: z.array(
    z.object({
      x: z.number(),
      y: z.number(),
      label: z.string(),
    }),
  ),
})

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
  /** Attributes the spend to the org whose sheet is being interpreted. */
  orgId: string
}): Promise<VisionAssistStats | null> {
  const { supabase, model, tilesBasePathBySheet } = params
  if (!(await drawingsVisionConfigured())) return null

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
      const image = await stitchSheetImage({
        supabase,
        tilesBasePath,
        imageWidth: level.source.imageWidth,
        imageHeight: level.source.imageHeight,
      })
      if (!image) continue
      const raw = await runDrawingsVisionObject({
        schema: floorplanProposalSchema,
        prompt: buildFloorplanVisionPrompt(level.name),
        images: [image],
        orgId: params.orgId,
        entityType: "drawing_sheet_version",
        entityId: level.source.sheetVersionId,
      })
      if (!raw) continue
      const proposal = sanitizeFloorplanVisionProposal(raw)
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
