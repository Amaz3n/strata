import "server-only"

/**
 * Rendering a readable image of a sheet out of its stored tile pyramid.
 *
 * Every vision feature that looks at a drawing needs this and none of them
 * should own it: floorplan interpretation stitches whole levels, symbol counting
 * walks overlapping windows at near-native resolution, and revision change
 * classification crops the same region out of two different versions. It lived
 * inside the floorplan assist service until the third caller arrived, which is
 * one caller past where that stopped being defensible.
 *
 * Both functions return raw bytes. They used to return base64 data URLs, which
 * inflated every payload by a third for no reason once the gateway started
 * handing file parts to providers directly.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import type { VisionImage } from "@/lib/services/ai/drawings-vision"
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
export async function stitchSheetImage(params: {
  supabase: SupabaseClient
  tilesBasePath: string
  imageWidth: number
  imageHeight: number
}): Promise<VisionImage | null> {
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
  return { data: composed, mediaType: "image/webp" }
}

/**
 * Render one window of a sheet at the highest resolution that fits the budget.
 *
 * Unlike `stitchSheetImage`, which squashes the WHOLE sheet to fit, this
 * picks the pyramid level from the WINDOW's size. A window covering a quarter of
 * the sheet gets four times the detail of a full-sheet stitch at the same
 * payload — which is the difference between a readable device symbol and six
 * grey pixels.
 */
export async function renderSheetWindowImage(params: {
  supabase: SupabaseClient
  tilesBasePath: string
  imageWidth: number
  imageHeight: number
  window: { x0: number; y0: number; x1: number; y1: number }
  maxEdge?: number
}): Promise<VisionImage | null> {
  const { supabase, tilesBasePath, imageWidth, imageHeight, window } = params
  const maxEdge = params.maxEdge ?? VISION_IMAGE_MAX_EDGE
  if (!(imageWidth > 0) || !(imageHeight > 0)) return null

  const spanX = Math.max(0, window.x1 - window.x0)
  const spanY = Math.max(0, window.y1 - window.y0)
  if (spanX <= 0 || spanY <= 0) return null

  // Descend only until the WINDOW fits, not the whole sheet.
  const maxLevel = Math.ceil(Math.log2(Math.max(imageWidth, imageHeight)))
  let level = maxLevel
  let width = imageWidth
  let height = imageHeight
  while (Math.max(width * spanX, height * spanY) > maxEdge && level > 0) {
    level--
    width = Math.ceil(width / 2)
    height = Math.ceil(height / 2)
  }

  const left = Math.floor(window.x0 * width)
  const top = Math.floor(window.y0 * height)
  const cropWidth = Math.max(1, Math.min(width - left, Math.ceil(spanX * width)))
  const cropHeight = Math.max(1, Math.min(height - top, Math.ceil(spanY * height)))

  const firstCol = Math.floor(left / TILE_SIZE)
  const lastCol = Math.floor((left + cropWidth - 1) / TILE_SIZE)
  const firstRow = Math.floor(top / TILE_SIZE)
  const lastRow = Math.floor((top + cropHeight - 1) / TILE_SIZE)
  const tileCount = (lastCol - firstCol + 1) * (lastRow - firstRow + 1)
  if (tileCount > MAX_STITCH_TILES) return null

  const tiles: Array<{ input: Buffer; left: number; top: number }> = []
  for (let row = firstRow; row <= lastRow; row++) {
    for (let col = firstCol; col <= lastCol; col++) {
      try {
        const buffer = await downloadTilesObject({
          supabase,
          path: `${tilesBasePath}/tiles/${level}/${col}_${row}.webp`,
        })
        // Position relative to the stitched canvas, not the full sheet.
        tiles.push({
          input: buffer,
          left: col * TILE_SIZE - firstCol * TILE_SIZE,
          top: row * TILE_SIZE - firstRow * TILE_SIZE,
        })
      } catch {
        // A missing edge tile is survivable; the window renders without it.
      }
    }
  }
  if (tiles.length === 0) return null

  const canvasWidth = (lastCol - firstCol + 1) * TILE_SIZE
  const canvasHeight = (lastRow - firstRow + 1) * TILE_SIZE

  const sharp = (await import("sharp")).default
  const composed = await sharp({
    create: { width: canvasWidth, height: canvasHeight, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite(tiles)
    .extract({
      left: left - firstCol * TILE_SIZE,
      top: top - firstRow * TILE_SIZE,
      width: Math.min(cropWidth, canvasWidth - (left - firstCol * TILE_SIZE)),
      height: Math.min(cropHeight, canvasHeight - (top - firstRow * TILE_SIZE)),
    })
    .webp({ quality: 82 })
    .toBuffer()

  return { data: composed, mediaType: "image/webp" }
}
