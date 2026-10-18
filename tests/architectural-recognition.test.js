const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const { beforeEach, describe, test } = require("node:test")
const sharp = require("sharp")

const { createFakeSupabase } = require("./support/fake-supabase")
const { freshRequire, stubModule } = require("./support/modules")
const {
  createVisionProvider,
  scannedPdf,
  stubMupdfLoader,
  stubTileStorage,
  stubVisionProvider,
  whitePng,
} = require("./support/drawings")

// ---------------------------------------------------------------------------
// Boundaries: tile storage, the vision provider, the stored original PDF.
// The original-sheet raster itself is real (MuPDF + sharp); it is wrapped only
// to count how often its handle is disposed.
// ---------------------------------------------------------------------------

const storage = stubTileStorage()
const vision = stubVisionProvider(createVisionProvider({ elements: [{ kind: "wall", pathIds: [1] }], openings: [] }))

const tiles = { renders: 0 }
stubModule("lib/services/drawings-sheet-images.ts", {
  async renderSheetWindowImage() {
    tiles.renders += 1
    return { data: await whitePng(100, 100), mediaType: "image/png" }
  },
})

const pdf = { bytes: null, downloads: [] }
stubModule("lib/storage/drawings-pdfs-storage.ts", {
  async downloadDrawingPdfObject({ orgId, path }) {
    pdf.downloads.push({ orgId, path })
    return pdf.bytes
  },
})
stubMupdfLoader()

const realOriginal = freshRequire("lib/services/original-sheet-raster.ts")
const handles = { closes: 0 }
stubModule("lib/services/original-sheet-raster.ts", {
  async openOriginalSheetRaster(options) {
    const handle = await realOriginal.openOriginalSheetRaster(options)
    let closed = false
    return {
      ...handle,
      close() {
        if (!closed) handles.closes += 1
        closed = true
        handle.close()
      },
    }
  },
})

const { createArchitecturalRecognizer } = freshRequire("lib/services/architectural-recognition.ts")
const { runAreaEngine } = require("../lib/drawings/area-engine")
const { createAreaReplay } = require("../lib/drawings/area-replay")
const { buildingToFloorplan } = require("../lib/drawings/building-floorplan")
const { floorplanModelSchema } = require("../lib/validation/floorplan")

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex")

function strokeEntry(id, [x0, y0, x1, y1]) {
  return {
    id,
    prior: "unknown",
    kind: "stroke",
    bounds: [x0, y0, x1, y1],
    commands: [["M", x0, y0], ["L", x1, y1]],
  }
}

beforeEach(() => {
  storage.objects.clear()
  storage.reads.length = 0
  storage.listing = null
  vision.calls.length = 0
  tiles.renders = 0
  pdf.downloads.length = 0
  handles.closes = 0
})

// ---------------------------------------------------------------------------
// Display tiles: sheets without an original PDF identity
// ---------------------------------------------------------------------------

describe("classifying from display tiles", () => {
  const input = {
    supabase: {},
    orgId: "org",
    sheetVersionId: "sheet",
    tilesBasePath: "org/sheet",
    imageWidth: 100,
    imageHeight: 100,
    evidence: { version: 1, paths: [] },
  }
  const request = { region: { x0: 0, y0: 0, x1: 1, y1: 1 }, catalogue: [strokeEntry(1, [0.1, 0.1, 0.8, 0.1])] }

  const classifications = () => [...storage.objects].filter(([path]) => path.includes("/classification-"))

  test("a saved classification resumes in a fresh recognizer without another render or provider call", async () => {
    const first = createArchitecturalRecognizer(input)
    assert.equal(await first.cached(request), null)
    const answer = await first(request)
    assert.equal(vision.calls.length, 1)
    assert.equal(tiles.renders, 1)
    assert.equal(classifications().length, 1)

    const resumed = createArchitecturalRecognizer(input)

    assert.deepEqual(await resumed.cached(request), answer)
    assert.deepEqual(await resumed(request), answer)
    assert.equal(vision.calls.length, 1)
    assert.equal(tiles.renders, 1)
  })

  test("the provider is called without fallback or escalation and within a bounded timeout", async () => {
    await createArchitecturalRecognizer(input)(request)

    const [call] = vision.calls
    assert.equal(call.allowFallback, false)
    assert.equal(call.allowEscalation, false)
    assert.ok(call.timeoutMs > 0 && call.timeoutMs <= 45000)
  })

  test("a different sheet, evidence or crop cannot reuse a saved classification", async () => {
    await createArchitecturalRecognizer(input)(request)

    const otherSheet = createArchitecturalRecognizer({ ...input, sheetVersionId: "new-sheet" })
    const otherEvidence = createArchitecturalRecognizer({ ...input, evidence: { ...input.evidence, truncated: true } })
    const sameInput = createArchitecturalRecognizer(input)

    assert.equal(await otherSheet.cached(request), null)
    assert.equal(await otherEvidence.cached(request), null)
    assert.equal(await sameInput.cached({ ...request, region: { x0: 0, y0: 0, x1: 0.9, y1: 1 } }), null)
    assert.equal(vision.calls.length, 1)
  })

  test("an empty, corrupt or misfingerprinted saved answer is retried, not treated as a hit", async () => {
    await createArchitecturalRecognizer(input)(request)
    const [[path, bytes]] = classifications()
    const valid = JSON.parse(bytes)
    const damaged = [
      "{",
      JSON.stringify({ ...valid, answer: { elements: [], openings: [] } }),
      JSON.stringify({ ...valid, fingerprint: "wrong" }),
    ]

    for (const saved of damaged) {
      storage.objects.set(path, Buffer.from(saved))
      const retry = createArchitecturalRecognizer(input)
      assert.equal(await retry.cached(request), null)
      assert.ok(await retry(request))
    }
    assert.equal(vision.calls.length, 4)
  })

  test("context paths are part of a classification's identity", async () => {
    await createArchitecturalRecognizer(input)(request)
    const contextual = { ...request, contextCatalogue: [strokeEntry(2, [0.1, 0.2, 0.8, 0.2])] }

    const next = createArchitecturalRecognizer(input)
    assert.equal(await next.cached(contextual), null)
    await next(contextual)

    const [plain, withContext] = classifications().map(([, bytes]) => JSON.parse(bytes))
    assert.equal(vision.calls.length, 2)
    assert.notEqual(withContext.fingerprint, plain.fingerprint)
    assert.notEqual(withContext.sourceImage.annotatedSha256, plain.sourceImage.annotatedSha256)

    const resumed = createArchitecturalRecognizer(input)
    assert.ok(await resumed.cached(contextual))
    const moved = { ...contextual.contextCatalogue[0], commands: [["M", 0.1, 0.2], ["L", 0.7, 0.2]] }
    assert.equal(await resumed.cached({ ...contextual, contextCatalogue: [moved] }), null)
    assert.equal(vision.calls.length, 2)
  })
})

// ---------------------------------------------------------------------------
// The original PDF
// ---------------------------------------------------------------------------

describe("classifying from the original PDF", () => {
  // The same file id exists in another org: an unscoped lookup would find two rows.
  const supabase = createFakeSupabase({
    files: [
      { id: "file-a", org_id: "org-a", storage_path: "org-a/original.pdf" },
      { id: "file-a", org_id: "org-b", storage_path: "org-b/original.pdf" },
    ],
  })
  const evidence = {
    version: 1,
    paths: [
      {
        id: 1,
        kind: "stroke",
        layer: [],
        tag: {},
        colorSpace: "DeviceGray",
        color: [0],
        width: 1,
        opacity: 1,
        dashes: [],
        clips: [],
        commands: [["M", 0.3, 0.4], ["L", 0.7, 0.4]],
      },
    ],
  }
  // A 2in x 1in scan: 600 x 300 native pixels at 300 DPI, shown as a 300 x 150 sheet.
  const input = {
    supabase,
    orgId: "org-a",
    sheetVersionId: "sheet-a",
    tilesBasePath: "org-a/sheet-a",
    imageWidth: 300,
    imageHeight: 150,
    evidence,
    source: { fileId: "file-a", pageIndex: 0 },
  }
  const request = { region: { x0: 0.201, y0: 0.21, x1: 0.799, y1: 0.81 }, catalogue: [strokeEntry(1, [0.25, 0.3, 0.75, 0.3])] }
  const wholeSheet = { x0: 0, y0: 0, x1: 1, y1: 1 }
  const engineInput = {
    imageWidth: 300,
    imageHeight: 150,
    feetPerImagePx: 0.1,
    evidence,
    textRuns: [],
    segments: [],
    region: wholeSheet,
    finishPolicy: "include-fixtures",
  }
  // Source facts are kept only when the sheet has a calibrated scale.
  const calibrated = { ...input, feetPerImagePx: 0.02 }
  const sourceFacts = () => [...storage.objects].filter(([path]) => path.includes("/source-facts-"))

  beforeEach(async () => {
    pdf.bytes = await scannedPdf({ dpi: 300 })
  })

  test("a crop keeps native detail, pixel-rounded registration and source hashes", async () => {
    const recognizer = createArchitecturalRecognizer(input)
    assert.deepEqual(await recognizer.windowBudget(request.region), {
      x: (4094 - 1e-6) / 600,
      y: (4094 - 1e-6) / 300,
    })

    assert.ok(await recognizer(request))

    const source = recognizer.sourceImage(request)
    const [call] = vision.calls
    assert.equal(source.kind, "original-pdf")
    assert.equal(source.renderDpi, 300)
    assert.equal(source.nativeDensityPreserved, true)
    assert.deepEqual([source.width, source.height], [360, 181])
    assert.ok(source.width > input.imageWidth * (request.region.x1 - request.region.x0), "finer than the display sheet")
    assert.ok(Math.abs(source.sourceRegion.x0 - 0.2) < 1e-10)
    assert.ok(Math.abs(source.sourceRegion.y0 - 0.21) < 1e-10)
    assert.ok(Math.abs(source.sourceRegion.y1 - 244 / 300) < 1e-10)
    assert.equal(source.sourceHash, sha256(pdf.bytes))
    assert.equal(source.imageSha256, sha256(call.images[0].data))
    assert.equal(source.annotatedSha256, sha256(call.images[1].data))
    assert.deepEqual(pdf.downloads, [{ orgId: "org-a", path: "org-a/original.pdf" }])
    assert.equal(tiles.renders, 0, "display tiles are never a fallback")
    await recognizer.close()
    assert.equal(handles.closes, 1)
  })

  test("a fresh recognizer reuses a saved answer after re-hashing the original", async () => {
    const first = createArchitecturalRecognizer(input)
    const answer = await first(request)
    const source = first.sourceImage(request)
    await first.close()

    const resumed = createArchitecturalRecognizer(input)

    assert.deepEqual(await resumed.cached(request), answer)
    assert.deepEqual(resumed.sourceImage(request), source)
    assert.equal(pdf.downloads.length, 2, "the original is re-read to prove its hash")
    assert.equal(vision.calls.length, 1)
    await resumed.close()
    assert.equal(handles.closes, 2)
  })

  test("a replaced original cannot reuse answers attached to geometry measured from the old one", async () => {
    const bound = { ...input, evidence: { ...evidence, raster: { sourceHash: sha256(pdf.bytes) } } }
    const first = createArchitecturalRecognizer(bound)
    assert.ok(await first(request))
    await first.close()
    pdf.bytes = await scannedPdf({ dpi: 200 })

    const changed = createArchitecturalRecognizer(bound)

    assert.equal(await changed.cached(request), null)
    assert.equal(await changed(request), null)
    assert.ok(changed.warnings().some((warning) => warning.includes("differs from measured geometry")))
    assert.equal(vision.calls.length, 1)
    assert.equal(tiles.renders, 0)
    await changed.close()
  })

  test("a saved answer with corrupt registration is not a valid hit", async () => {
    const first = createArchitecturalRecognizer(input)
    await first(request)
    await first.close()
    const [path, bytes] = [...storage.objects].find(([name]) => name.includes("/classification-"))
    const record = JSON.parse(bytes)
    record.sourceImage.sourceRegion.x0 = 0.3
    storage.objects.set(path, Buffer.from(JSON.stringify(record)))

    const retry = createArchitecturalRecognizer(input)

    assert.equal(await retry.cached(request), null)
    assert.ok(await retry(request))
    assert.equal(vision.calls.length, 2)
    await retry.close()
  })

  test("low-density, oversized or over-dense originals are refused without reduction or fallback", async () => {
    const cases = [
      { bytes: await scannedPdf({ dpi: 100 }), region: wholeSheet, warning: /200 DPI/ },
      { bytes: await scannedPdf({ large: true }), region: wholeSheet, warning: /native image budget/ },
      { bytes: await scannedPdf({ dpi: 700 }), region: request.region, warning: /600 DPI recognition limit/ },
    ]
    for (const { bytes, region, warning } of cases) {
      pdf.bytes = bytes
      const recognizer = createArchitecturalRecognizer(input)

      assert.equal(await recognizer({ ...request, region }), null)
      assert.ok(recognizer.warnings().some((text) => warning.test(text)), String(warning))
      await recognizer.close()
    }
    assert.equal(vision.calls.length, 0)
    assert.equal(tiles.renders, 0)
    assert.equal(storage.objects.size, 0)
    assert.equal(handles.closes, 3)
  })

  test("the area engine closes the original and carries image evidence into the replay and the model", async () => {
    const recognizer = createArchitecturalRecognizer(input)

    const run = await runAreaEngine(engineInput, { wholeSheet: true, recognize: recognizer, maxRecognitionWindows: 1 })

    assert.equal(handles.closes, 1)
    assert.equal(run.observations.length, 1)
    const image = run.observations[0].sourceImage
    assert.equal(image.kind, "original-pdf")
    const replay = JSON.parse(
      JSON.stringify(createAreaReplay({ ...engineInput, visualObservations: run.observations }, true, {}, run.recognition)),
    )
    assert.deepEqual(replay.input.visualObservations[0].sourceImage, image)
    const level = buildingToFloorplan(
      {
        ...engineInput,
        sheetVersionId: "00000000-0000-4000-8000-000000000001",
        sheetNumber: "A1",
        sheetTitle: "Floor",
        name: "Floor",
        order: 0,
      },
      run.detection.architecture,
    )
    const model = floorplanModelSchema.parse(
      JSON.parse(JSON.stringify({ version: 1, units: "feet", levels: [level], correctionCount: 0 })),
    )
    assert.equal(model.levels[0].reconstruction.source.recognitionImages[0].image.sourceHash, image.sourceHash)
  })

  test("an engine failure still closes an opened original", async () => {
    const recognizer = createArchitecturalRecognizer(input)
    await recognizer.cached(request)
    const broken = {}
    Object.defineProperty(broken, "textRuns", {
      enumerable: true,
      get() {
        throw new Error("broken engine input")
      },
    })

    await assert.rejects(runAreaEngine(broken, { wholeSheet: true, recognize: recognizer }), /broken engine input/)

    assert.equal(handles.closes, 1)
    assert.equal(await recognizer(request), null, "a closed recognizer answers nothing")
    assert.equal(vision.calls.length, 0)
    assert.equal(pdf.downloads.length, 1)
  })

  test("a long path fits whole in a registered supplemental crop at native density", async () => {
    const recognizer = createArchitecturalRecognizer(input)

    const run = await runAreaEngine(
      { ...engineInput, feetPerImagePx: 2 / 3 },
      { wholeSheet: true, recognize: recognizer, maxRecognitionWindows: 1 },
    )

    assert.equal(run.observations.length, 1)
    const [observation] = run.observations
    assert.deepEqual(observation.suppliedPathIds, [1])
    const crop = observation.sourceImage.requestedRegion
    assert.ok(crop.x0 <= 0.3 && crop.x1 >= 0.7, "the whole 0.3..0.7 path is inside the crop")
    assert.equal(observation.sourceImage.renderDpi, 300)
    assert.equal(observation.sourceImage.nativeDensityPreserved, true)
    assert.equal(run.recognitionCoverage.unseenPaths, 0)
    assert.equal(vision.calls.length, 1)
    assert.equal(pdf.downloads.length, 1)
    assert.equal(handles.closes, 1)
    assert.equal(tiles.renders, 0)
  })

  // Exercises lib/services/original-sheet-raster directly; it belongs in tests/original-sheet-raster.test.js.
  test("the advertised window budget renders at off-grid positions without rejection or density loss", async () => {
    const handle = await realOriginal.openOriginalSheetRaster({
      supabase,
      orgId: "org-a",
      fileId: "file-a",
      pageIndex: 0,
      imageWidth: 600,
      imageHeight: 300,
      region: wholeSheet,
    })
    try {
      const capacity = handle.recognitionWindowBudget(wholeSheet, 32)
      const y0 = 0.27257102457077476
      for (const x0 of [0.18, 0.26560186393319307, 0.3409259259259259, 0.675]) {
        const crop = await handle.renderSourceWindow({ x0, y0, x1: x0 + capacity.x, y1: y0 + capacity.y }, 32)
        const { width, height } = await sharp(crop.data).metadata()
        assert.ok(width <= 32 && height <= 32)
        assert.equal(crop.renderDpi, 300)
        assert.equal(crop.sampling.kind, "native-raster")
      }
    } finally {
      handle.close()
    }
  })

  test("source facts keep original image provenance across a fresh extraction", async () => {
    const first = createArchitecturalRecognizer(calibrated)
    await first(request)
    const image = first.sourceImage(request)
    await first.close()
    assert.equal(sourceFacts().length, 1)
    const reextracted = structuredClone(evidence)
    reextracted.extractionProfile = "new-source-extraction"
    reextracted.paths[0].id = 91

    const resumed = createArchitecturalRecognizer({ ...calibrated, evidence: reextracted })
    const prior = await resumed.prior(request.region)

    assert.equal(prior.length, 1)
    assert.deepEqual(prior[0].suppliedPathIds, [91], "the fact is re-bound to the new path id")
    assert.deepEqual(prior[0].sourceImage, image)
    assert.notEqual(prior[0].sourceReuse.currentEvidenceHash, prior[0].sourceReuse.priorEvidenceHash)
    assert.equal(vision.calls.length, 1)
    await resumed.close()
    assert.equal(handles.closes, 2)
  })

  test("a different sheet, calibration, frame or original cannot read another source's facts", async () => {
    const first = createArchitecturalRecognizer(calibrated)
    await first(request)
    await first.close()

    for (const change of [{ sheetVersionId: "sheet-b" }, { feetPerImagePx: 0.03 }, { imageWidth: 600, imageHeight: 300 }]) {
      const other = createArchitecturalRecognizer({ ...calibrated, ...change })
      assert.deepEqual(await other.prior(request.region), [], JSON.stringify(change))
      await other.close()
    }
    pdf.bytes = await scannedPdf({ dpi: 301 })
    const replaced = createArchitecturalRecognizer(calibrated)
    assert.deepEqual(await replaced.prior(request.region), [])
    await replaced.close()
    assert.equal(vision.calls.length, 1)
  })

  test("corrupt or unreadable fact history yields no prior decisions rather than a partial vote", async () => {
    const first = createArchitecturalRecognizer(calibrated)
    await first(request)
    await first.close()
    const [path, bytes] = sourceFacts()[0]
    const record = JSON.parse(bytes)

    storage.objects.set(path, Buffer.from(JSON.stringify({ ...record, paths: [{ ...record.paths[0], kind: "door" }] })))
    const corrupt = createArchitecturalRecognizer(calibrated)
    assert.deepEqual(await corrupt.prior(request.region), [])
    assert.ok(corrupt.warnings().some((warning) => warning.includes("provenance")))
    await corrupt.close()

    storage.objects.set(path, bytes)
    const unreadable = path.replace(/fact-[a-f0-9]+/, `fact-${"e".repeat(64)}`)
    storage.listing = { objects: [{ name: path, size: bytes.length }, { name: unreadable, size: 100 }], complete: true }
    const incomplete = createArchitecturalRecognizer(calibrated)
    assert.deepEqual(await incomplete.prior(request.region), [])
    await incomplete.close()
    assert.equal(vision.calls.length, 1)
  })

  test("fact history over its listing or byte budget is not reused", async () => {
    const first = createArchitecturalRecognizer(calibrated)
    await first(request)
    await first.close()
    const [path, bytes] = sourceFacts()[0]

    storage.listing = { objects: Array.from({ length: 129 }, () => ({ name: path, size: bytes.length })), complete: true }
    const overflow = createArchitecturalRecognizer(calibrated)
    assert.deepEqual(await overflow.prior(request.region), [])
    assert.ok(overflow.warnings().some((warning) => warning.includes("budget")))
    await overflow.close()

    // The listing understates a fact that is actually larger than the read budget.
    storage.listing = { objects: [{ name: path, size: 1 }], complete: true }
    storage.objects.set(path, Buffer.alloc(256 * 1024 + 1))
    const huge = createArchitecturalRecognizer(calibrated)
    assert.deepEqual(await huge.prior(request.region), [])
    assert.ok(huge.warnings().some((warning) => warning.includes("budget")))
    await huge.close()
    assert.equal(vision.calls.length, 1)
  })

  test("a truncated listing certifies neither complete history nor a missing exact answer", async () => {
    const first = createArchitecturalRecognizer(calibrated)
    const answer = await first(request)
    await first.close()
    storage.listing = { objects: [], complete: false }
    storage.reads.length = 0

    const resumed = createArchitecturalRecognizer(calibrated)

    assert.deepEqual(await resumed.prior(request.region), [])
    assert.ok(resumed.warnings().some((warning) => warning.includes("complete-read")))
    assert.deepEqual(await resumed.cached(request), answer, "the exact answer is still read directly")
    assert.ok(storage.reads.some((path) => path.includes("/classification-")))
    await resumed.close()
    assert.equal(vision.calls.length, 1)
  })

  test("a complete empty listing answers cache misses without reading storage or the provider", async () => {
    const recognizer = createArchitecturalRecognizer(input)

    for (let id = 1; id <= 4; id++) {
      assert.equal(await recognizer.cached({ ...request, catalogue: [{ ...request.catalogue[0], id }] }), null)
    }

    assert.equal(storage.reads.length, 0)
    assert.equal(vision.calls.length, 0)
    await recognizer.close()
  })
})
