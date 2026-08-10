require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  planVisionWindows,
  windowPointToSheet,
  mergeWindowPoints,
  separationForExemplar,
} = require("../lib/drawings/vision-windows")

// A 36x48" sheet at 150 DPI — the case that motivated all of this.
const SHEET = { imageWidth: 7200, imageHeight: 5400 }

test("a large sheet is split into multiple windows rather than squashed", () => {
  const plan = planVisionWindows({ ...SHEET, targetPixels: 2048 })
  assert.ok(plan.windows.length > 1, "expected the sheet to be split")
  assert.equal(plan.cols, 4)
  assert.equal(plan.rows, 3)
})

test("each window spans far fewer source pixels than the whole sheet", () => {
  const plan = planVisionWindows({ ...SHEET, targetPixels: 2048 })
  const window = plan.windows[0]
  const spanPx = (window.x1 - window.x0) * SHEET.imageWidth
  // The old path showed all 7200px in one 2048px image (3.5x downscale).
  // Each window now covers ~1/4 of that, so detail survives.
  assert.ok(spanPx < 2600, `window spans ${spanPx}px`)
})

test("windows overlap so a symbol on a seam is not missed", () => {
  const plan = planVisionWindows({ ...SHEET, targetPixels: 2048 })
  const first = plan.windows[0]
  const second = plan.windows[1]
  assert.ok(second.x0 < first.x1, "adjacent windows must overlap")
})

test("windows cover the entire sheet", () => {
  const plan = planVisionWindows({ ...SHEET, targetPixels: 2048 })
  assert.equal(Math.min(...plan.windows.map((w) => w.x0)), 0)
  assert.equal(Math.min(...plan.windows.map((w) => w.y0)), 0)
  assert.equal(Math.max(...plan.windows.map((w) => w.x1)), 1)
  assert.equal(Math.max(...plan.windows.map((w) => w.y1)), 1)
})

test("a small sheet stays a single window", () => {
  const plan = planVisionWindows({ imageWidth: 1200, imageHeight: 900, targetPixels: 2048 })
  assert.equal(plan.windows.length, 1)
})

test("a region restriction is covered at higher detail than the full sheet", () => {
  const region = { x0: 0.25, y0: 0.25, x1: 0.4, y1: 0.4 }
  const plan = planVisionWindows({ ...SHEET, targetPixels: 2048, region })
  assert.equal(plan.windows.length, 1)
  assert.ok(plan.windows[0].x0 >= region.x0 - 1e-9)
  assert.ok(plan.windows[0].x1 <= region.x1 + 1e-9)
})

test("the window ceiling coarsens rather than dropping coverage", () => {
  const plan = planVisionWindows({ imageWidth: 40000, imageHeight: 30000, targetPixels: 2048, maxWindows: 9 })
  assert.ok(plan.windows.length <= 9)
  // Still covers the whole sheet despite the cap.
  assert.equal(Math.max(...plan.windows.map((w) => w.x1)), 1)
  assert.equal(Math.max(...plan.windows.map((w) => w.y1)), 1)
})

test("window points map back to sheet coordinates", () => {
  const window = { x0: 0.5, y0: 0.5, x1: 1, y1: 1 }
  assert.deepEqual(windowPointToSheet(window, [0, 0]), [0.5, 0.5])
  assert.deepEqual(windowPointToSheet(window, [1, 1]), [1, 1])
  assert.deepEqual(windowPointToSheet(window, [0.5, 0.5]), [0.75, 0.75])
})

test("the same symbol seen in two overlapping windows counts once", () => {
  // Overlap bands would otherwise double every symbol in them — an error in
  // the direction that costs money.
  const merged = mergeWindowPoints([[0.5, 0.5], [0.5005, 0.5005], [0.8, 0.8]], 0.004)
  assert.equal(merged.length, 2)
})

test("genuinely distinct symbols survive merging", () => {
  const merged = mergeWindowPoints([[0.10, 0.10], [0.20, 0.20], [0.30, 0.30]], 0.004)
  assert.equal(merged.length, 3)
})

test("merge separation scales with the exemplar's size", () => {
  const small = separationForExemplar({ searchRadiusPx: 8, ...SHEET })
  const large = separationForExemplar({ searchRadiusPx: 120, ...SHEET })
  assert.ok(large > small, "a larger symbol needs a wider dedupe radius")
  assert.ok(small > 0 && large <= 0.05)
})

test("a missing exemplar size falls back to a sane default", () => {
  const separation = separationForExemplar({ searchRadiusPx: null, ...SHEET })
  assert.ok(separation > 0 && separation < 0.01)
})
