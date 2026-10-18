const assert = require("node:assert/strict")
const { beforeEach, describe, test } = require("node:test")

const { freshRequire, stubModule } = require("./support/modules")
const { stubTileStorage, whitePng } = require("./support/drawings")

const { RASTER_ARC_PROFILE } = require("../lib/drawings/raster-arcs")
const { RASTER_TEXT_PROFILE } = require("../lib/drawings/raster-text")
const realPlanEvidence = require("../lib/drawings/raster-plan-evidence")

// ---------------------------------------------------------------------------
// Boundaries: stored tiles, the original PDF, and OCR. Pixel-to-geometry
// extraction is real unless a test needs to dictate what the pixels contain.
// ---------------------------------------------------------------------------

const storage = stubTileStorage()

const tiles = { reads: [] }
stubModule("lib/services/drawings-sheet-images.ts", {
  async renderSheetWindowImage(options) {
    tiles.reads.push(options)
    return { data: await whitePng(100, 100), mediaType: "image/png", sourceRegion: options.window }
  },
})

const ocr = { calls: 0, status: "processed" }
stubModule("lib/services/local-raster-text.ts", {
  async loadLocalRasterText(options) {
    ocr.calls += 1
    return {
      profile: RASTER_TEXT_PROFILE,
      status: ocr.status,
      runs: [
        { text: "BEDROOM", x: 0.2, y: 0.2, w: 0.1, h: 0.02, ocr: { profile: RASTER_TEXT_PROFILE, confidence: 90 } },
      ],
      windows: 1,
      warnings: [],
      source: options.original
        ? { kind: "original-pdf", hash: options.original.sourceHash, sampling: options.original.sampling }
        : { kind: "stored-tiles" },
    }
  },
})

const NATIVE_300_DPI = {
  profile: "pdf-native-density-1",
  kind: "native-raster",
  minimumSourceDpi: 300,
  maximumSourceDpi: 300,
  renderScale: 300 / 72,
  warnings: [],
}

/**
 * The original PDF page as a raster source. By default every window renders
 * white at native resolution; `render` and `inspect` replace that per test.
 */
const original = {}
function resetOriginal({ width, height }) {
  Object.assign(original, {
    width,
    height,
    opens: 0,
    closes: 0,
    renders: [],
    inspections: [],
    render: null,
    inspect: () => NATIVE_300_DPI,
  })
}

async function nativeWindow(window, scale = 1) {
  const width = Math.max(1, Math.round((window.x1 - window.x0) * original.width * scale))
  const height = Math.max(1, Math.round((window.y1 - window.y0) * original.height * scale))
  return {
    data: await whitePng(width, height),
    sourceRegion: window,
    mediaType: "image/png",
    renderScale: NATIVE_300_DPI.renderScale,
  }
}

stubModule("lib/services/original-sheet-raster.ts", {
  async openOriginalSheetRaster() {
    original.opens += 1
    return {
      sampling: NATIVE_300_DPI,
      sourceHash: "a".repeat(64),
      imageWidth: original.width,
      imageHeight: original.height,
      close: () => {
        original.closes += 1
      },
      inspectSampling(window) {
        original.inspections.push(window)
        return original.inspect(window)
      },
      async renderWindow(window, maxEdge) {
        original.renders.push({ window, maxEdge })
        return original.render ? original.render(window, original.renders.length) : nativeWindow(window)
      },
    }
  },
})

/** `plan.extract` replaces pixel extraction for one test; null runs the real extractor. */
const plan = { extract: null, calls: 0 }
stubModule("lib/drawings/raster-plan-evidence.ts", {
  ...realPlanEvidence,
  extractRasterPlanEvidence(options) {
    plan.calls += 1
    return plan.extract ? plan.extract(options, plan.calls) : realPlanEvidence.extractRasterPlanEvidence(options)
  },
})

const { loadRasterArchitecturalEvidence } = freshRequire("lib/services/architectural-raster.ts")
const { reconstructBuilding } = require("../lib/drawings/building-reconstruction")
const { buildingToFloorplan } = require("../lib/drawings/building-floorplan")
const { floorplanModelSchema } = require("../lib/validation/floorplan")

const WHOLE_SHEET = { x0: 0, y0: 0, x1: 1, y1: 1 }
const SOURCE = { orgId: "org-a", fileId: "file-a", pageIndex: 0 }

beforeEach(() => {
  storage.objects.clear()
  storage.uploads.length = 0
  tiles.reads = []
  ocr.calls = 0
  ocr.status = "processed"
  plan.extract = null
  plan.calls = 0
  resetOriginal({ width: 200, height: 200 })
})

/** Rewrites the one cached derivative. */
function editCachedDerivative(edit) {
  const [path, bytes] = [...storage.objects].find(([name]) => name.includes("/architecture/raster-"))
  storage.objects.set(path, Buffer.from(JSON.stringify(edit(JSON.parse(bytes.toString("utf8"))))))
}

/** Projects scan evidence into a floorplan level and round-trips it through the model schema. */
function floorplanFrom(input, evidence) {
  const source = {
    ...input,
    evidence,
    textRuns: [],
    segments: [],
    sheetVersionId: "00000000-0000-4000-8000-000000000001",
    sheetNumber: null,
    sheetTitle: null,
    name: "Test floor",
    order: 0,
    scaleConfirmed: false,
  }
  const architecture = {
    version: 1,
    elements: [],
    spaces: [],
    openings: [],
    finishZones: [],
    conflicts: [],
    spacePolicy: "include-fixtures",
    qualification: "unqualified",
  }
  const building = reconstructBuilding(source, architecture)
  const level = buildingToFloorplan(source, { ...architecture, building })
  const model = floorplanModelSchema.parse(
    JSON.parse(JSON.stringify({ version: 1, units: "feet", levels: [level], correctionCount: 0 })),
  )
  return { model, rebuild: (changed) => reconstructBuilding({ ...source, evidence: changed }, architecture) }
}

// ---------------------------------------------------------------------------
// Stored display tiles
// ---------------------------------------------------------------------------

describe("stored display tiles", () => {
  const input = {
    supabase: {},
    tilesBasePath: "00000000-0000-4000-8000-000000000001/sheet",
    imageWidth: 100,
    imageHeight: 100,
    feetPerImagePx: 0.1,
    region: WHOLE_SHEET,
  }

  test("a complete scan derivative is cached beside the sheet and reused without re-reading", async () => {
    const first = await loadRasterArchitecturalEvidence(input)

    assert.equal(first.evidence.rasterText.runs[0].text, "BEDROOM")
    assert.deepEqual(JSON.parse(first.bytes).rasterText, first.evidence.rasterText)
    assert.equal(storage.uploads.length, 1)
    assert.ok(storage.uploads[0].path.startsWith(`${input.tilesBasePath}/architecture/`))
    assert.ok(tiles.reads.every((read) => read.requireComplete && read.lossless), "scans never read lossy or partial tiles")

    const second = await loadRasterArchitecturalEvidence(input)

    assert.deepEqual(second.evidence, first.evidence)
    assert.equal(tiles.reads.length, 1)
    assert.equal(ocr.calls, 1)
  })

  test("a cached derivative without OCR text is rebuilt", async () => {
    await loadRasterArchitecturalEvidence(input)
    editCachedDerivative(({ rasterText, ...older }) => older)

    const refreshed = await loadRasterArchitecturalEvidence(input)

    assert.equal(refreshed.evidence.rasterText.runs[0].text, "BEDROOM")
    assert.equal(tiles.reads.length, 2)
    assert.equal(ocr.calls, 2)
  })

  test("partial OCR is returned but not cached, so the next load retries", async () => {
    ocr.status = "partial"

    const first = await loadRasterArchitecturalEvidence(input)
    await loadRasterArchitecturalEvidence(input)

    assert.equal(first.evidence.rasterText.status, "partial")
    assert.equal(storage.uploads.length, 0)
    assert.equal(tiles.reads.length, 2)
    assert.equal(ocr.calls, 2)
  })

  test("a cached derivative with malformed text runs is rebuilt", async () => {
    await loadRasterArchitecturalEvidence(input)
    editCachedDerivative((cached) => ({
      ...cached,
      rasterText: { ...cached.rasterText, runs: [{ text: "FAKE", x: Infinity, y: 0, w: 0.1, h: 0.1 }] },
    }))

    const refreshed = await loadRasterArchitecturalEvidence(input)

    assert.equal(refreshed.evidence.rasterText.runs[0].text, "BEDROOM")
    assert.equal(tiles.reads.length, 2)
  })

  test("a cached derivative that omitted geometry is rebuilt even though its OCR succeeded", async () => {
    await loadRasterArchitecturalEvidence(input)
    editCachedDerivative((cached) => ({ ...cached, truncated: true }))

    await loadRasterArchitecturalEvidence(input)

    assert.equal(tiles.reads.length, 2)
    assert.equal(ocr.calls, 2)
    assert.equal(storage.uploads.length, 2)
  })
})

// ---------------------------------------------------------------------------
// The original PDF
// ---------------------------------------------------------------------------

describe("the original PDF", () => {
  const input = {
    supabase: {},
    tilesBasePath: "00000000-0000-4000-8000-000000000001/sheet",
    imageWidth: 100,
    imageHeight: 100,
    feetPerImagePx: 0.1,
    region: WHOLE_SHEET,
    source: SOURCE,
  }
  // A 200px source rendered into a 100px view budget: 100 DPI contours from a 300 DPI scan.
  const reducedView = async (window) => ({
    data: await whitePng(100, 100),
    sourceRegion: window,
    mediaType: "image/png",
    renderScale: 100 / 72,
  })

  test("contours and OCR share one original handle and report render DPI apart from source density", async () => {
    original.render = reducedView

    const { evidence } = await loadRasterArchitecturalEvidence(input)

    assert.equal(original.opens, 1)
    assert.equal(original.renders.length, 1)
    assert.equal(original.closes, 1)
    assert.equal(tiles.reads.length, 0, "display tiles are never a fallback for the original")
    assert.equal(evidence.raster.sourceSampling.minimumSourceDpi, 300)
    assert.equal(evidence.raster.renderDpi, 100)
    assert.equal(evidence.raster.sourceHash, "a".repeat(64))
    assert.ok(evidence.rasterText.warnings.some((warning) => /reduced to 100/.test(warning)))
  })

  test("a cached original derivative is reused until its text source disagrees with its geometry", async () => {
    original.render = reducedView
    await loadRasterArchitecturalEvidence(input)
    await loadRasterArchitecturalEvidence(input)
    assert.equal(original.opens, 1)

    editCachedDerivative((cached) => ({
      ...cached,
      rasterText: { ...cached.rasterText, source: { ...cached.rasterText.source, hash: "b".repeat(64) } },
    }))
    await loadRasterArchitecturalEvidence(input)

    assert.equal(original.opens, 2)
    assert.equal(original.closes, 2)
  })

  test("a render failure closes the original and caches nothing", async () => {
    original.render = async () => {
      throw new Error("Original render failed")
    }

    await assert.rejects(loadRasterArchitecturalEvidence(input), /render failed/)

    assert.equal(original.closes, 1)
    assert.equal(storage.uploads.length, 0)
    assert.equal(tiles.reads.length, 0)
  })
})

// ---------------------------------------------------------------------------
// Views larger than one native render
// ---------------------------------------------------------------------------

describe("views wider than one native render", () => {
  const input = {
    supabase: {},
    tilesBasePath: "org-a/sheet",
    imageWidth: 5000,
    imageHeight: 200,
    feetPerImagePx: 0.02,
    region: WHOLE_SHEET,
    source: SOURCE,
  }

  test("a wide view is read in complete native-resolution windows and cached", async () => {
    resetOriginal({ width: 5000, height: 200 })

    const { evidence } = await loadRasterArchitecturalEvidence(input)

    const tiling = evidence.raster.tiling
    assert.equal(tiling.status, "complete")
    assert.equal(tiling.processedWindows, 3)
    assert.ok(tiling.windows.every((window) => window.width <= 4096 && window.renderDpi === 300))
    assert.ok(original.renders.every((render) => render.maxEdge === 4096))
    assert.equal(evidence.raster.renderDpi, 300)
    assert.equal(evidence.raster.width, 5000)
    assert.equal(evidence.truncated, false)
    assert.equal(original.closes, 1)
    assert.equal(storage.uploads.length, 1)

    await loadRasterArchitecturalEvidence(input)
    assert.equal(original.renders.length, 3, "the cached derivative is reused")
  })

  test("a cached tiling whose windows do not cover the view is acquired again", async () => {
    resetOriginal({ width: 5000, height: 200 })
    await loadRasterArchitecturalEvidence(input)
    editCachedDerivative((cached) => {
      cached.raster.tiling.windows[1].core = { ...cached.raster.tiling.windows[0].core }
      return cached
    })

    await loadRasterArchitecturalEvidence(input)

    assert.equal(original.renders.length, 6)
    assert.equal(original.closes, 2)
  })

  test("a window that cannot be read leaves geometry partial, never substituted or cached", async () => {
    resetOriginal({ width: 5000, height: 200 })
    original.render = async (window, call) => {
      if (call === 2) throw new Error("missing source pixels")
      return nativeWindow(window)
    }

    const { evidence } = await loadRasterArchitecturalEvidence(input)

    assert.equal(evidence.truncated, true)
    assert.equal(evidence.raster.renderDpi, 300, "no low-resolution substitute")
    assert.deepEqual(
      {
        status: evidence.raster.tiling.status,
        reason: evidence.raster.tiling.reason,
        processed: evidence.raster.tiling.processedWindows,
        planned: evidence.raster.tiling.plannedWindows,
      },
      { status: "partial", reason: "read-failed", processed: 1, planned: 3 },
    )
    assert.equal(original.renders.length, 2, "acquisition stops at the first failed window")
    assert.equal(storage.uploads.length, 0)
    assert.equal(original.closes, 1)
  })

  test("tiling provenance survives the floorplan model schema and tampered coverage is rejected", async () => {
    resetOriginal({ width: 5000, height: 200 })
    const { evidence } = await loadRasterArchitecturalEvidence(input)

    const { model, rebuild } = floorplanFrom(input, evidence)

    assert.deepEqual(model.levels[0].reconstruction.source.rasterTiling, evidence.raster.tiling)
    model.levels[0].reconstruction.source.rasterTiling.sampledPixels = 1
    assert.equal(floorplanModelSchema.safeParse(model).success, false)
    evidence.raster.tiling.sampledPixels = 1
    assert.ok(rebuild(evidence).issues.some((issue) => issue.code === "raster-tiling-invalid"))
  })
})

// ---------------------------------------------------------------------------
// Swing ink clipped at the edge of the selection
// ---------------------------------------------------------------------------

describe("swing ink clipped at the selection edge", () => {
  const region = { x0: 0.2, y0: 0.2, x1: 0.4, y1: 0.4 }
  const input = {
    supabase: {},
    tilesBasePath: "org-a/sheet",
    imageWidth: 2000,
    imageHeight: 2000,
    feetPerImagePx: 0.05,
    region,
    source: SOURCE,
  }

  /** Extraction output: a quarter-circle door swing cut off by the left edge of the read, or nothing. */
  function swingEvidence(options, { clipped, truncated = false }) {
    const swing = {
      id: 7,
      kind: "stroke",
      commands: Array.from({ length: 8 }, (_, i) => [
        i ? "L" : "M",
        options.region.x0 + 0.0001 + i * 0.004,
        options.region.y0 + 0.04 + i * 0.004,
      ]),
      width: 0.0002,
      opacity: 1,
      color: [0],
      colorSpace: "DeviceGray",
      dashes: [],
      layer: [],
      groups: [],
      clips: [],
      evenOdd: false,
      rasterFeature: "circular-arc",
      rasterArc: {
        profile: RASTER_ARC_PROFILE,
        sampleCount: 80,
        maximumDeviationPixels: 1,
        sweepRadians: Math.PI / 2,
        continuousInk: true,
        clipped: true,
      },
    }
    return {
      version: 1,
      extractionProfile: realPlanEvidence.RASTER_PLAN_PROFILE,
      truncated,
      paths: clipped ? [swing] : [],
      raster: {
        width: options.width,
        height: options.height,
        feetPerPixel: options.feetPerPixel,
        threshold: 120,
        maximumDeviationPixels: 2.5,
        region: options.region,
      },
    }
  }

  /** The first read clips the swing; the context read resolves it unless told otherwise. */
  function swingClippedOnce({ stillClipped = false, truncated = false } = {}) {
    plan.extract = (options, call) =>
      call === 1
        ? swingEvidence(options, { clipped: true })
        : swingEvidence(options, { clipped: stillClipped, truncated })
  }

  beforeEach(() => resetOriginal({ width: 2000, height: 2000 }))

  test("a clipped swing triggers one context read that keeps the selection and is cached", async () => {
    swingClippedOnce()

    const { evidence } = await loadRasterArchitecturalEvidence(input)

    const context = evidence.raster.context
    assert.equal(context.status, "expanded")
    assert.equal(context.attempts, 1)
    assert.deepEqual(context.requestedRegion, region)
    assert.deepEqual(context.edges, ["left"])
    assert.deepEqual(context.triggerPathIds, [7])
    assert.deepEqual(original.inspections, [context.effectiveRegion], "the added context is density-checked")
    assert.equal(original.renders.length, 2)
    assert.equal(original.closes, 1)
    assert.equal(storage.uploads.length, 1)

    const cached = await loadRasterArchitecturalEvidence(input)
    assert.deepEqual(cached.evidence, evidence)
    assert.equal(original.opens, 1)
  })

  test("a cached context whose requested region was altered is read again", async () => {
    swingClippedOnce()
    await loadRasterArchitecturalEvidence(input)
    editCachedDerivative((cached) => {
      cached.raster.context.requestedRegion = { ...region, x0: 0.25 }
      return cached
    })

    await loadRasterArchitecturalEvidence(input)

    assert.equal(original.opens, 2)
  })

  test("unverifiable context density keeps the original observations and caches nothing", async () => {
    const cases = [
      {
        reason: "source-unverified",
        inspect: () => ({ ...NATIVE_300_DPI, kind: "unverified", minimumSourceDpi: null, maximumSourceDpi: null }),
      },
      {
        reason: "read-failed",
        inspect: () => {
          throw new Error("source sampling failed")
        },
      },
    ]
    for (const { reason, inspect } of cases) {
      resetOriginal({ width: 2000, height: 2000 })
      plan.calls = 0
      swingClippedOnce()
      original.inspect = inspect

      const { evidence } = await loadRasterArchitecturalEvidence(input)

      assert.equal(evidence.raster.context.status, "unresolved", reason)
      assert.equal(evidence.raster.context.reason, reason)
      assert.equal(evidence.raster.context.attempts, 0)
      assert.deepEqual(evidence.raster.region, region)
      assert.equal(original.closes, original.opens)
    }
    assert.equal(storage.uploads.length, 0)
  })

  test("a failed, truncated or coarser context read never replaces the initial observations", async () => {
    const cases = [
      {
        reason: "read-failed",
        arrange: () => {
          swingClippedOnce()
          original.render = async (window, call) => {
            if (call === 2) throw new Error("retry pixels missing")
            return nativeWindow(window)
          }
        },
      },
      { reason: "geometry-budget", arrange: () => swingClippedOnce({ truncated: true }) },
      {
        reason: "geometry-budget",
        arrange: () => {
          swingClippedOnce()
          original.render = (window, call) => nativeWindow(window, call === 2 ? 0.5 : 1)
        },
      },
    ]
    for (const { reason, arrange } of cases) {
      resetOriginal({ width: 2000, height: 2000 })
      plan.calls = 0
      arrange()

      const { evidence } = await loadRasterArchitecturalEvidence(input)

      assert.equal(evidence.raster.context.status, "unresolved")
      assert.equal(evidence.raster.context.reason, reason)
      assert.equal(evidence.raster.context.attempts, 1)
      assert.deepEqual(evidence.raster.region, region)
      assert.equal(evidence.paths[0].id, 7)
      assert.equal(evidence.truncated, false)
      assert.equal(original.closes, original.opens)
    }
    assert.equal(storage.uploads.length, 0)
  })

  test("clipping that remains after the one context read stays explicit and uncached", async () => {
    swingClippedOnce({ stillClipped: true })

    const { evidence } = await loadRasterArchitecturalEvidence(input)

    assert.equal(evidence.raster.context.status, "unresolved")
    assert.equal(evidence.raster.context.reason, "remaining-clipping")
    assert.equal(original.renders.length, 2)
    assert.equal(storage.uploads.length, 0)
    assert.equal(original.closes, 1)
  })

  test("context provenance survives the floorplan model schema and malformed context is rejected", async () => {
    swingClippedOnce()
    const { evidence } = await loadRasterArchitecturalEvidence(input)

    const { model, rebuild } = floorplanFrom(input, evidence)

    const reconstruction = model.levels[0].reconstruction
    assert.deepEqual(reconstruction.source.rasterContext, evidence.raster.context)
    assert.ok(reconstruction.issues.some((issue) => issue.code === "raster-context"))
    reconstruction.source.rasterContext.attempts = 2
    assert.equal(floorplanModelSchema.safeParse(model).success, false)

    const invalid = structuredClone(evidence)
    invalid.raster.context.effectiveRegion.x0 = 0.3
    const rebuilt = rebuild(invalid)
    assert.equal(rebuilt.status, "incomplete")
    assert.ok(rebuilt.issues.some((issue) => issue.code === "raster-context-invalid"))
    assert.equal(rebuilt.source.rasterContext, undefined)
  })
})
