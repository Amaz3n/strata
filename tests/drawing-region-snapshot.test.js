require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  clampRegion,
  pickSnapshotLevel,
  planRegionSnapshot,
  regionRectAtLevel,
  snapshotOutputSize,
  tileLevelPlacement,
  tileRangeForRect,
  SNAPSHOT_LONG_EDGE,
} = require("../lib/drawings/region-snapshot")
const { dziLevelSize } = require("../lib/drawings/change-detection")
const { TilePyramid } = require("../lib/viewer/tile-pyramid")

/** A 10000×7000 sheet — the production design case. DZI level count. */
const SHEET_W = 10000
const SHEET_H = 7000
const LEVELS = Math.ceil(Math.log2(Math.max(SHEET_W, SHEET_H))) + 1 // 15

// ---------------------------------------------------------------------------
// clampRegion
// ---------------------------------------------------------------------------

function assertRegionClose(actual, expected) {
  assert.ok(actual, "expected a region, got null")
  for (const key of ["x", "y", "w", "h"]) {
    assert.ok(
      Math.abs(actual[key] - expected[key]) < 1e-12,
      `${key}: ${actual[key]} != ${expected[key]}`,
    )
  }
}

test("clampRegion passes a well-formed region through (within float noise)", () => {
  const region = { x: 0.25, y: 0.1, w: 0.3, h: 0.4 }
  assertRegionClose(clampRegion(region), region)
})

test("clampRegion clamps overshoot to the unit square", () => {
  assertRegionClose(clampRegion({ x: -0.25, y: -0.5, w: 1.5, h: 2 }), { x: 0, y: 0, w: 1, h: 1 })
  assertRegionClose(clampRegion({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }), {
    x: 0.9,
    y: 0.9,
    w: 0.1,
    h: 0.1,
  })
})

test("clampRegion rejects inverted, zero-area, off-sheet, and non-finite regions", () => {
  assert.equal(clampRegion({ x: 0.5, y: 0.5, w: -0.2, h: 0.2 }), null)
  assert.equal(clampRegion({ x: 0.5, y: 0.5, w: 0.2, h: 0 }), null)
  assert.equal(clampRegion({ x: 1.2, y: 0, w: 0.5, h: 0.5 }), null) // entirely off-sheet
  assert.equal(clampRegion({ x: NaN, y: 0, w: 0.5, h: 0.5 }), null)
  assert.equal(clampRegion({ x: 0, y: 0, w: Infinity, h: 0.5 }), null)
})

// ---------------------------------------------------------------------------
// pickSnapshotLevel
// ---------------------------------------------------------------------------

test("full-sheet region picks the cheapest level covering the target edge", () => {
  const level = pickSnapshotLevel(SHEET_W, SHEET_H, LEVELS, { x: 0, y: 0, w: 1, h: 1 }, 1600)
  // Level 12 is 2500×1750 (≥1600); level 11 is 1250×875 (<1600).
  assert.equal(level, 12)
  const size = dziLevelSize(SHEET_W, SHEET_H, LEVELS, level)
  assert.ok(Math.max(size.width, size.height) >= 1600)
  const below = dziLevelSize(SHEET_W, SHEET_H, LEVELS, level - 1)
  assert.ok(Math.max(below.width, below.height) < 1600)
})

test("a small region needs a sharper level than the full sheet", () => {
  // A quarter-width crop needs 2 more levels to reach the same output edge.
  const level = pickSnapshotLevel(SHEET_W, SHEET_H, LEVELS, { x: 0, y: 0, w: 0.25, h: 0.25 }, 1600)
  assert.equal(level, 14)
})

test("a tiny region falls back to full resolution instead of upscaling", () => {
  // 0.05 × 10000 = 500 px at full res — below target at every level.
  const region = { x: 0.4, y: 0.4, w: 0.05, h: 0.05 }
  assert.equal(pickSnapshotLevel(SHEET_W, SHEET_H, LEVELS, region, 1600), LEVELS - 1)
})

// ---------------------------------------------------------------------------
// regionRectAtLevel / snapshotOutputSize
// ---------------------------------------------------------------------------

test("regionRectAtLevel covers the region and clamps to the level", () => {
  const levelSize = { width: 2500, height: 1750 }
  assert.deepEqual(regionRectAtLevel({ x: 0, y: 0, w: 1, h: 1 }, levelSize), {
    x: 0,
    y: 0,
    w: 2500,
    h: 1750,
  })
  // floor/ceil expands to whole pixels so the crop never undershoots.
  const rect = regionRectAtLevel({ x: 0.1001, y: 0.2001, w: 0.1, h: 0.1 }, levelSize)
  assert.equal(rect.x, Math.floor(0.1001 * 2500))
  assert.equal(rect.x + rect.w, Math.ceil(0.2001 * 2500))
  assert.ok(rect.w >= Math.floor(0.1 * 2500))
})

test("regionRectAtLevel never returns an empty rect", () => {
  const rect = regionRectAtLevel({ x: 0.9999, y: 0.9999, w: 0.001, h: 0.001 }, { width: 100, height: 100 })
  assert.ok(rect.w >= 1 && rect.h >= 1)
  assert.ok(rect.x + rect.w <= 100 && rect.y + rect.h <= 100)
})

test("snapshotOutputSize caps the long edge and keeps aspect", () => {
  assert.deepEqual(snapshotOutputSize({ x: 0, y: 0, w: 2500, h: 1750 }, 1600), {
    width: 1600,
    height: 1120,
  })
  // Never upscales.
  assert.deepEqual(snapshotOutputSize({ x: 0, y: 0, w: 500, h: 300 }, 1600), {
    width: 500,
    height: 300,
  })
})

// ---------------------------------------------------------------------------
// tileRangeForRect / tileLevelPlacement
// ---------------------------------------------------------------------------

test("tileRangeForRect selects only intersecting tiles", () => {
  const levelSize = { width: 2500, height: 1750 }
  assert.deepEqual(tileRangeForRect({ x: 0, y: 0, w: 2500, h: 1750 }, 512, levelSize), {
    x0: 0,
    y0: 0,
    x1: 4,
    y1: 3,
  })
  // A rect inside one tile stays one tile.
  assert.deepEqual(tileRangeForRect({ x: 10, y: 10, w: 100, h: 100 }, 512, levelSize), {
    x0: 0,
    y0: 0,
    x1: 0,
    y1: 0,
  })
})

test("a rect ending exactly on a tile boundary does not pull the next tile", () => {
  const range = tileRangeForRect({ x: 0, y: 0, w: 512, h: 512 }, 512, {
    width: 2500,
    height: 1750,
  })
  assert.deepEqual(range, { x0: 0, y0: 0, x1: 0, y1: 0 })
})

test("tileLevelPlacement matches TilePyramid tile sizes and tiles the level exactly", () => {
  const manifest = {
    Image: { Size: { Width: SHEET_W, Height: SHEET_H }, TileSize: 512, Overlap: 1, Format: "webp" },
    Levels: LEVELS,
  }
  const pyramid = new TilePyramid("https://tiles.example", manifest)
  const level = 12
  const levelSize = dziLevelSize(SHEET_W, SHEET_H, LEVELS, level) // 2500×1750
  const cols = Math.ceil(levelSize.width / 512)
  const rows = Math.ceil(levelSize.height / 512)

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const ours = tileLevelPlacement(x, y, 512, 1, levelSize)
      const theirs = pyramid.placement(level, x, y)
      assert.equal(ours.width, theirs.size.width, `tile ${x},${y} width`)
      assert.equal(ours.height, theirs.size.height, `tile ${x},${y} height`)
    }
  }

  // The last column/row ends exactly at the level edge.
  const lastCol = tileLevelPlacement(cols - 1, 0, 512, 1, levelSize)
  assert.equal(lastCol.left + lastCol.width, levelSize.width)
  const lastRow = tileLevelPlacement(0, rows - 1, 512, 1, levelSize)
  assert.equal(lastRow.top + lastRow.height, levelSize.height)
})

// ---------------------------------------------------------------------------
// planRegionSnapshot
// ---------------------------------------------------------------------------

test("planRegionSnapshot: full sheet stays a small, bounded assembly", () => {
  const plan = planRegionSnapshot({
    imageWidth: SHEET_W,
    imageHeight: SHEET_H,
    levelCount: LEVELS,
    tileSize: 512,
    region: { x: 0, y: 0, w: 1, h: 1 },
  })
  assert.equal(plan.level, 12)
  assert.deepEqual(plan.levelSize, { width: 2500, height: 1750 })
  assert.deepEqual(plan.rect, { x: 0, y: 0, w: 2500, h: 1750 })
  assert.deepEqual(plan.output, { width: 1600, height: 1120 })
  const tiles = (plan.tiles.x1 - plan.tiles.x0 + 1) * (plan.tiles.y1 - plan.tiles.y0 + 1)
  assert.equal(tiles, 20)
})

test("planRegionSnapshot: assembled region long edge is always under 2× target", () => {
  for (const w of [0.08, 0.2, 0.33, 0.5, 0.75, 1]) {
    const plan = planRegionSnapshot({
      imageWidth: SHEET_W,
      imageHeight: SHEET_H,
      levelCount: LEVELS,
      tileSize: 512,
      region: { x: 0, y: 0, w, h: w * 0.7 },
    })
    assert.ok(
      Math.max(plan.rect.w, plan.rect.h) < 2 * SNAPSHOT_LONG_EDGE + 2,
      `region w=${w} assembles ${plan.rect.w}×${plan.rect.h}`,
    )
    assert.ok(Math.max(plan.output.width, plan.output.height) <= SNAPSHOT_LONG_EDGE)
  }
})

test("planRegionSnapshot: tiny region outputs native resolution, top level", () => {
  const plan = planRegionSnapshot({
    imageWidth: SHEET_W,
    imageHeight: SHEET_H,
    levelCount: LEVELS,
    tileSize: 512,
    region: { x: 0.4, y: 0.4, w: 0.05, h: 0.04 },
  })
  assert.equal(plan.level, LEVELS - 1)
  assert.deepEqual(plan.output, { width: plan.rect.w, height: plan.rect.h })
  assert.ok(plan.rect.w <= 501 && plan.rect.h <= 281)
})

test("planRegionSnapshot: legacy single-image manifest is one full-size tile", () => {
  const plan = planRegionSnapshot({
    imageWidth: 3000,
    imageHeight: 2000,
    levelCount: 1,
    tileSize: 3000, // legacy: tileSize = max(imageW, imageH)
    region: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
  })
  assert.equal(plan.level, 0)
  assert.deepEqual(plan.tiles, { x0: 0, y0: 0, x1: 0, y1: 0 })
  assert.deepEqual(plan.rect, { x: 750, y: 500, w: 1500, h: 1000 })
  assert.deepEqual(plan.output, { width: 1500, height: 1000 })
})
