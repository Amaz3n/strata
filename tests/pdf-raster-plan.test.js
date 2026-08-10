require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  planPdfRaster,
  rasterScaleForPage,
  DEFAULT_MAX_RASTER_PAGES,
  DEFAULT_TARGET_LONG_EDGE_PX,
} = require("../lib/ai/pdf-raster-plan")

// ---------------------------------------------------------------------------
// Page planning
// ---------------------------------------------------------------------------

test("a short document renders every page and discloses nothing", () => {
  const plan = planPdfRaster({ pageCount: 3 })
  assert.deepEqual(plan.pages, [0, 1, 2])
  assert.equal(plan.truncated, false)
  assert.equal(plan.omittedPages, 0)
  assert.equal(plan.disclosure, null)
})

test("a single-page receipt is the common case", () => {
  const plan = planPdfRaster({ pageCount: 1 })
  assert.deepEqual(plan.pages, [0])
  assert.equal(plan.truncated, false)
})

test("a long document is capped and the truncation is disclosed", () => {
  const plan = planPdfRaster({ pageCount: 40 })
  assert.equal(plan.pages.length, DEFAULT_MAX_RASTER_PAGES)
  assert.equal(plan.truncated, true)
  assert.equal(plan.omittedPages, 40 - DEFAULT_MAX_RASTER_PAGES)
  assert.ok(plan.disclosure, "a dropped page must never be silent")
  assert.match(plan.disclosure, /40 pages/)
})

test("the disclosure reads correctly when exactly one page is dropped", () => {
  const plan = planPdfRaster({ pageCount: 3, maxPages: 2 })
  assert.equal(plan.omittedPages, 1)
  assert.match(plan.disclosure, /1 page contains/)
})

test("pages are taken from the front, where the header and totals live", () => {
  const plan = planPdfRaster({ pageCount: 12, maxPages: 4 })
  assert.deepEqual(plan.pages, [0, 1, 2, 3])
})

test("a zero-page or malformed document plans nothing rather than throwing", () => {
  assert.deepEqual(planPdfRaster({ pageCount: 0 }).pages, [])
  assert.deepEqual(planPdfRaster({ pageCount: Number.NaN }).pages, [])
  assert.deepEqual(planPdfRaster({ pageCount: -5 }).pages, [])
})

test("maxPages is never allowed to drop below one", () => {
  const plan = planPdfRaster({ pageCount: 5, maxPages: 0 })
  assert.equal(plan.pages.length, 1)
  assert.equal(plan.truncated, true)
})

// ---------------------------------------------------------------------------
// Render scale
// ---------------------------------------------------------------------------

// US Letter, in PDF points.
const LETTER = { widthPt: 612, heightPt: 792 }

test("a Letter page renders near the target long edge", () => {
  const scale = rasterScaleForPage(LETTER)
  assert.ok(
    Math.abs(scale.heightPx - DEFAULT_TARGET_LONG_EDGE_PX) <= 1,
    `long edge was ${scale.heightPx}`,
  )
  assert.equal(scale.scaledDown, false)
})

test("a Letter page lands above the DPI where small print stops resolving", () => {
  const scale = rasterScaleForPage(LETTER)
  assert.ok(scale.dpi > 150, `dpi was ${scale.dpi}`)
})

test("landscape and portrait of the same size render at the same DPI", () => {
  const portrait = rasterScaleForPage(LETTER)
  const landscape = rasterScaleForPage({ widthPt: 792, heightPt: 612 })
  assert.ok(Math.abs(portrait.dpi - landscape.dpi) < 0.001)
})

test("an oversized page degrades in DPI instead of blowing the pixel budget", () => {
  // A 36x48" sheet that found its way into a payables PDF.
  const scale = rasterScaleForPage({
    widthPt: 36 * 72,
    heightPt: 48 * 72,
    maxPixels: 2_000_000,
  })
  assert.equal(scale.scaledDown, true)
  assert.ok(scale.widthPx * scale.heightPx <= 2_000_000 * 1.02, "pixel ceiling must hold")
})

test("unreadable page bounds fall back to Letter rather than producing garbage", () => {
  const fallback = rasterScaleForPage({ widthPt: 0, heightPt: Number.NaN })
  const letter = rasterScaleForPage(LETTER)
  assert.equal(fallback.widthPx, letter.widthPx)
  assert.equal(fallback.heightPx, letter.heightPx)
})

test("DPI is capped for a page too small to need the detail", () => {
  const tiny = rasterScaleForPage({ widthPt: 4, heightPt: 4 })
  assert.ok(tiny.dpi <= 400, `dpi was ${tiny.dpi}`)
})

test("the pixel ceiling outranks the legibility floor", () => {
  // The floor exists so pages stay readable, but it must never be the reason a
  // render exceeds the memory budget.
  const scale = rasterScaleForPage({ widthPt: 20_000, heightPt: 20_000, maxPixels: 1_000_000 })
  assert.ok(scale.dpi < 50, `expected the floor to yield, dpi was ${scale.dpi}`)
  assert.ok(scale.widthPx * scale.heightPx <= 1_000_000 * 1.02, "pixel ceiling must hold")
  assert.equal(scale.scaledDown, true)
})
