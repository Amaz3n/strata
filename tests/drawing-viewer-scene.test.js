require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { Camera2D } = require("../lib/viewer/camera")
const { TilePyramid } = require("../lib/viewer/tile-pyramid")

// ---------------------------------------------------------------------------
// Camera2D
// ---------------------------------------------------------------------------

/** A 10000×7000 sheet in a 1280×800 viewport — the production design case. */
function makeCamera() {
  const camera = new Camera2D()
  camera.setViewportSize({ width: 1280, height: 800 })
  camera.setImageSize({ width: 10000, height: 7000 })
  return camera
}

test("camera home fits the whole image and centers it", () => {
  const camera = makeCamera()
  const fit = Math.min(1280 / 10000, 800 / 7000)
  assert.ok(Math.abs(camera.currentScale - fit) < 1e-12)

  const matrix = camera.matrix()
  // Image center maps to viewport center.
  const cx = matrix.a * 5000 + matrix.e
  const cy = matrix.d * 3500 + matrix.f
  assert.ok(Math.abs(cx - 640) < 1e-6)
  assert.ok(Math.abs(cy - 400) < 1e-6)
})

test("screenToImage and imageToScreen round-trip through the matrix", () => {
  const camera = makeCamera()
  camera.zoomBy(3, { x: 200, y: 150 })
  const image = camera.screenToImage({ x: 431, y: 287 })
  const screen = camera.imageToScreen(image)
  assert.ok(Math.abs(screen.x - 431) < 1e-9)
  assert.ok(Math.abs(screen.y - 287) < 1e-9)

  const matrix = camera.matrix()
  const viaMatrix = {
    x: matrix.a * image.x + matrix.c * image.y + matrix.e,
    y: matrix.b * image.x + matrix.d * image.y + matrix.f,
  }
  assert.ok(Math.abs(viaMatrix.x - 431) < 1e-9)
  assert.ok(Math.abs(viaMatrix.y - 287) < 1e-9)
})

test("zooming keeps the focal image point fixed on screen", () => {
  const camera = makeCamera()
  const focal = { x: 900, y: 120 }
  const before = camera.screenToImage(focal)
  camera.zoomBy(2.5, focal)
  const after = camera.screenToImage(focal)
  assert.ok(Math.abs(before.x - after.x) < 1e-6)
  assert.ok(Math.abs(before.y - after.y) < 1e-6)
})

test("zoom display figure matches the OSD convention (1 = fit width)", () => {
  const camera = makeCamera()
  camera.zoomToActualSize()
  // scale 1 → zoom = imageWidth / viewportWidth
  assert.ok(Math.abs(camera.zoom - 10000 / 1280) < 1e-9)
})

test("pan clamps at the image edges and centers when the image fits", () => {
  const camera = makeCamera()
  camera.zoomToActualSize()
  camera.panByScreen(1e9, 1e9) // fling toward the top-left corner stop
  const topLeft = camera.screenToImage({ x: 0, y: 0 })
  assert.ok(Math.abs(topLeft.x) < 1e-6)
  assert.ok(Math.abs(topLeft.y) < 1e-6)

  // Fits-in-viewport axis stays centered no matter the pan.
  camera.goHome()
  camera.panByScreen(0, 500)
  const matrix = camera.matrix()
  const cy = matrix.d * 3500 + matrix.f
  assert.ok(Math.abs(cy - 400) < 1e-6)
})

test("zoom clamps against its floor and ceiling", () => {
  const camera = makeCamera()
  const fit = camera.fitScale()
  camera.zoomBy(1e-9)
  assert.ok(camera.currentScale >= fit * 0.5 - 1e-12)
  camera.zoomBy(1e9)
  assert.ok(camera.currentScale <= 2 + 1e-12)
})

// ---------------------------------------------------------------------------
// TilePyramid
// ---------------------------------------------------------------------------

function makeManifest(width, height, levels, tileSize = 512, overlap = 1) {
  return {
    Image: {
      Format: "webp",
      Overlap: overlap,
      TileSize: tileSize,
      Size: { Width: width, Height: height },
    },
    Levels: levels,
  }
}

test("pyramid level sizes halve up the stack (ceil)", () => {
  const pyramid = new TilePyramid("https://cdn/x", makeManifest(10001, 7001, 6))
  assert.equal(pyramid.levelCount, 6)
  assert.deepEqual(pyramid.levelSize(5), { width: 10001, height: 7001 })
  assert.deepEqual(pyramid.levelSize(4), { width: 5001, height: 3501 })
  assert.deepEqual(pyramid.levelSize(0), { width: 313, height: 219 })
})

test("tile urls follow the pipeline layout", () => {
  const pyramid = new TilePyramid("https://cdn/x", makeManifest(4096, 4096, 4))
  assert.equal(pyramid.tileUrl(3, 2, 7), "https://cdn/x/tiles/3/2_7.webp")
})

test("interior tiles carry overlap on shared edges only", () => {
  const pyramid = new TilePyramid("https://cdn/x", makeManifest(2048, 1024, 3, 512, 1))
  // Full-res level 2 is 2048×1024: 4×2 tiles.
  const first = pyramid.placement(2, 0, 0)
  assert.deepEqual(first.rect, { x: 0, y: 0, width: 513, height: 513 })
  const interior = pyramid.placement(2, 1, 1)
  // Starts one overlap px early on both axes; bottom row has no lower overlap.
  assert.deepEqual(interior.rect, { x: 511, y: 511, width: 514, height: 513 })
  const last = pyramid.placement(2, 3, 1)
  assert.deepEqual(last.rect, { x: 1535, y: 511, width: 513, height: 513 })
})

test("every level tiles the image exactly, with no overhang past its edges", () => {
  // 3456×2304 at 13 levels is the common sheet render. Level sizes are
  // ceil-rounded (level 0 is 1×1), so mapping level px back to image px by
  // 2^(max - level) used to stretch the coarse backing quads out to 4096×4096
  // — a blank band down the right and bottom of every sheet when zoomed out.
  const pyramid = new TilePyramid("https://cdn/x", makeManifest(3456, 2304, 13))
  for (let level = 0; level < pyramid.levelCount; level++) {
    const first = pyramid.placement(level, 0, 0)
    assert.equal(first.rect.x, 0)
    assert.equal(first.rect.y, 0)
    const last = pyramid.placement(
      level,
      pyramid.columns(level) - 1,
      pyramid.rows(level) - 1,
    )
    assert.equal(last.rect.x + last.rect.width, 3456, `level ${level} right edge`)
    assert.equal(last.rect.y + last.rect.height, 2304, `level ${level} bottom edge`)
  }
})

test("placement reports the tile bitmap's own pixel size", () => {
  // The pipeline tiles with no overlap, so a tile is exactly its level slice.
  const pyramid = new TilePyramid("https://cdn/x", makeManifest(3456, 2304, 13, 512, 0))
  // Level 0 of this pyramid is a single 1×1 px tile standing in for the sheet.
  assert.deepEqual(pyramid.placement(0, 0, 0).size, { width: 1, height: 1 })
  // Full res: 7×5 tiles of 512, last column/row are the remainders.
  assert.deepEqual(pyramid.placement(12, 0, 0).size, { width: 512, height: 512 })
  assert.deepEqual(pyramid.placement(12, 6, 4).size, { width: 384, height: 256 })
})

test("legacy manifests resolve to a single full-size tile", () => {
  const pyramid = new TilePyramid("https://cdn/x", {
    Image: {
      Format: "png",
      Overlap: 0,
      TileSize: 512,
      Size: { Width: 3000, Height: 2000 },
    },
  })
  assert.equal(pyramid.levelCount, 1)
  const only = pyramid.tilesInRect(0, { x: 0, y: 0, width: 3000, height: 2000 })
  assert.equal(only.length, 1)
  assert.equal(only[0].url, "https://cdn/x/tiles/0/0_0.png")
  assert.deepEqual(only[0].rect, { x: 0, y: 0, width: 3000, height: 2000 })
})

test("level selection meets on-screen resolution without overshooting", () => {
  const pyramid = new TilePyramid("https://cdn/x", makeManifest(10000, 7000, 6))
  // At or past 1:1 → full resolution.
  assert.equal(pyramid.levelForScale(1), 5)
  assert.equal(pyramid.levelForScale(2), 5)
  // Exactly half resolution on screen → one level down suffices.
  assert.equal(pyramid.levelForScale(0.5), 4)
  // Just above a half step needs the sharper level.
  assert.equal(pyramid.levelForScale(0.51), 5)
  // Tiny scales clamp at the coarsest level.
  assert.equal(pyramid.levelForScale(1e-6), 0)
})

test("tilesInRect returns exactly the intersecting tiles, clamped in-bounds", () => {
  const pyramid = new TilePyramid("https://cdn/x", makeManifest(2048, 1024, 3, 512, 0))
  const tiles = pyramid.tilesInRect(2, { x: 500, y: 500, width: 600, height: 600 })
  // x spans tiles 0..2, y spans tile 0..1 → but y=500..1100 clamps to row 1 max.
  const keys = tiles.map((t) => `${t.x},${t.y}`)
  assert.deepEqual(keys, ["0,0", "1,0", "2,0", "0,1", "1,1", "2,1"])

  // A rect fully outside the image yields nothing.
  assert.deepEqual(pyramid.tilesInRect(2, { x: 5000, y: 0, width: 100, height: 100 }), [])
})
