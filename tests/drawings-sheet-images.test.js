const assert = require("node:assert/strict")
const test = require("node:test")
const sharp = require("sharp")

const { freshRequire } = require("./support/modules")
const { stubTileStorage } = require("./support/drawings")

const storage = stubTileStorage()
const { renderSheetWindowImage } = freshRequire("lib/services/drawings-sheet-images.ts")

// A 101 x 99 sheet fits one 512px tile at pyramid level ceil(log2(101)) = 7.
const sheet = { supabase: {}, tilesBasePath: "test", imageWidth: 101, imageHeight: 99 }
const TILE_PATH = "test/tiles/7/0_0.webp"

/** A white tile with one 3 x 3 black dot whose top-left pixel is (30, 40). */
async function tileWithDot() {
  const pixels = Buffer.alloc(512 * 512 * 3, 255)
  for (let y = 40; y < 43; y++) {
    for (let x = 30; x < 33; x++) pixels.fill(0, (y * 512 + x) * 3, (y * 512 + x) * 3 + 3)
  }
  return sharp(pixels, { raw: { width: 512, height: 512, channels: 3 } }).png().toBuffer()
}

test.beforeEach(() => storage.objects.clear())

test("a lossless crop keeps source pixels registered across fractional window edges", async () => {
  storage.objects.set(TILE_PATH, await tileWithDot())
  const requested = { x0: 0.103, y0: 0.107, x1: 0.809, y1: 0.813 }

  const image = await renderSheetWindowImage({
    ...sheet,
    window: requested,
    maxEdge: 512,
    requireComplete: true,
    lossless: true,
  })

  assert.equal(image.mediaType, "image/png")
  const { data, info } = await sharp(image.data).raw().toBuffer({ resolveWithObject: true })
  // The dot lands at crop pixel (20, 30), and the returned region maps it back to (30, 40).
  assert.equal(data[(30 * info.width + 20) * info.channels], 0)
  const region = image.sourceRegion
  assert.ok(Math.abs((region.x0 + (20 / info.width) * (region.x1 - region.x0)) * 101 - 30) < 1e-9)
  assert.ok(Math.abs((region.y0 + (30 / info.height) * (region.y1 - region.y0)) * 99 - 40) < 1e-9)
  // Rounding to whole pixels only ever widens the requested window.
  assert.ok(region.x0 <= requested.x0 && region.y0 <= requested.y0)
  assert.ok(region.x1 >= requested.x1 && region.y1 >= requested.y1)
})

test("a crop that requires every tile returns nothing when one is missing", async () => {
  const image = await renderSheetWindowImage({
    ...sheet,
    window: { x0: 0, y0: 0, x1: 1, y1: 1 },
    requireComplete: true,
    lossless: true,
  })

  assert.equal(image, null)
})
