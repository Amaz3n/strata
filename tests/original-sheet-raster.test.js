const assert = require("node:assert/strict")
const { beforeEach, test } = require("node:test")
const sharp = require("sharp")

const { createFakeSupabase } = require("./support/fake-supabase")
const { freshRequire, stubModule } = require("./support/modules")
const { scannedPdf, stubMupdfLoader } = require("./support/drawings")

// Boundary: the stored original PDF. MuPDF and sharp are real.
const pdf = { bytes: null, downloads: [] }
stubModule("lib/storage/drawings-pdfs-storage.ts", {
  async downloadDrawingPdfObject({ orgId, path }) {
    pdf.downloads.push({ orgId, path })
    return pdf.bytes
  },
})
stubMupdfLoader()

const { openOriginalSheetRaster } = freshRequire("lib/services/original-sheet-raster.ts")
const { loadLocalRasterText } = freshRequire("lib/services/local-raster-text.ts")

// The same file id exists in another org: an unscoped lookup would find two rows.
const supabase = createFakeSupabase({
  files: [
    { id: "file-a", org_id: "org-a", storage_path: "org-a/original.pdf" },
    { id: "file-a", org_id: "org-b", storage_path: "org-b/original.pdf" },
    { id: "file-b", org_id: "org-b", storage_path: "org-b/other.pdf" },
  ],
})

// A 2in x 1in scan at 300 DPI (600 x 300 native pixels) shown as a 300 x 150 sheet.
const input = {
  supabase,
  orgId: "org-a",
  fileId: "file-a",
  pageIndex: 0,
  imageWidth: 300,
  imageHeight: 150,
  region: { x0: 0.2, y0: 0.2, x1: 0.8, y1: 0.8 },
}

/** A 2in x 1in page whose left `coverInches` are a 300 DPI scan of `svg`. */
async function scanOf(svg, coverInches = 2) {
  const { PDFDocument } = require("pdf-lib")
  const document = await PDFDocument.create()
  const page = document.addPage([144, 72])
  const image = await document.embedPng(await sharp(Buffer.from(svg)).png().toBuffer())
  page.drawImage(image, { x: 0, y: 0, width: 72 * coverInches, height: 72 })
  return Buffer.from(await document.save())
}

beforeEach(async () => {
  pdf.bytes = await scannedPdf({ dpi: 300 })
  pdf.downloads.length = 0
})

test("the org's own original renders a region at native density over its real frame", async () => {
  const source = await openOriginalSheetRaster(input)

  assert.deepEqual(pdf.downloads, [{ orgId: "org-a", path: "org-a/original.pdf" }])
  assert.deepEqual([source.imageWidth, source.imageHeight], [600, 300])
  assert.equal(source.sampling.minimumSourceDpi, 300)
  assert.match(source.sourceHash, /^[a-f0-9]{64}$/)

  const crop = await source.renderWindow(input.region, 2050)
  const { width } = await sharp(crop.data).metadata()
  assert.ok(width < source.imageWidth, "only the region is rendered")
  assert.ok(crop.sourceRegion.x0 <= input.region.x0 && crop.sourceRegion.x1 >= input.region.x1)
  assert.equal(crop.renderScale, 300 / 72)

  source.close()
  source.close()
  await assert.rejects(source.renderWindow(input.region, 2050), /closed/)
})

test("another org's original, or a missing one, is unavailable before any download", async () => {
  for (const fileId of ["file-b", "file-missing"]) {
    await assert.rejects(openOriginalSheetRaster({ ...input, fileId }), /unavailable/)
  }
  await assert.rejects(openOriginalSheetRaster({ ...input, orgId: "" }), /identity/)
  assert.deepEqual(pdf.downloads, [])
})

test("a stale page index or a mismatched frame is refused rather than mis-registered", async () => {
  await assert.rejects(openOriginalSheetRaster({ ...input, pageIndex: 1 }), /no longer exists/)
  await assert.rejects(openOriginalSheetRaster({ ...input, imageHeight: 300 }), /frames disagree/)
})

test("the advertised window budget renders at off-grid positions without losing density", async () => {
  const wholeSheet = { x0: 0, y0: 0, x1: 1, y1: 1 }
  const source = await openOriginalSheetRaster({ ...input, imageWidth: 600, imageHeight: 300, region: wholeSheet })
  try {
    const capacity = source.recognitionWindowBudget(wholeSheet, 32)
    const y0 = 0.27257102457077476
    for (const x0 of [0.18, 0.26560186393319307, 0.3409259259259259, 0.675]) {
      const crop = await source.renderSourceWindow({ x0, y0, x1: x0 + capacity.x, y1: y0 + capacity.y }, 32)
      const { width, height } = await sharp(crop.data).metadata()
      assert.ok(width <= 32 && height <= 32, `${width}x${height} at ${x0}`)
      assert.equal(crop.renderDpi, 300)
      assert.equal(crop.sampling.kind, "native-raster")
    }
  } finally {
    source.close()
  }
})

test("a region reaching past the covering scan is not claimed as native density", async () => {
  // The scan covers only the left inch of the page.
  pdf.bytes = await scanOf('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="white"/></svg>', 1)
  const region = { x0: 0.1, y0: 0.2, x1: 0.4, y1: 0.8 }
  const source = await openOriginalSheetRaster({ ...input, region })

  assert.equal(source.sampling.kind, "native-raster")
  assert.equal(source.inspectSampling(region).minimumSourceDpi, 300)
  assert.equal(source.inspectSampling({ ...region, x1: 0.7 }).kind, "unverified")
  assert.equal(source.sampling.kind, "native-raster", "inspecting a wider region does not change the handle")
  assert.equal(pdf.downloads.length, 1)

  source.close()
  assert.throws(() => source.inspectSampling(region), /closed/)
})

test("OCR over an open original reads its pixels, not the display frame", async () => {
  pdf.bytes = await scanOf(
    '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300"><rect width="600" height="300" fill="white"/><text x="160" y="150" font-family="Arial" font-size="30" fill="black">BEDROOM</text></svg>',
  )
  const source = await openOriginalSheetRaster(input)
  try {
    const text = await loadLocalRasterText({
      supabase,
      tilesBasePath: "org-a/sheet",
      imageWidth: 300,
      imageHeight: 150,
      region: input.region,
      original: source,
    })

    assert.equal(text.status, "processed")
    assert.equal(text.source.kind, "original-pdf")
    assert.equal(text.source.hash, source.sourceHash)
    assert.equal(text.source.sampling.minimumSourceDpi, 300)
    assert.ok(text.runs.some((run) => run.text === "BEDROOM" && run.ocr.confidence >= 70))
    assert.equal(pdf.downloads.length, 1, "the handle's bytes are reused")
  } finally {
    source.close()
  }
})
