const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, replies, id, ORG, ACTOR } = require("./support/service")
const { stubModule, freshRequire } = require("./support/modules")

/**
 * The PDF boundary: storage hands back bytes, the engine opens a page, and the
 * pipeline's detector reads a scale off it. `pdf` is what each of those does in
 * the current test, and records what it was asked for.
 */
let pdf
function resetPdf() {
  pdf = {
    proposal: { feet_per_image_px: 0.2, method: "title_block", raw: "1/4 inch = 1 foot" },
    downloads: [],
    pages: [],
    dimensions: [],
    destroyed: [],
    failDownload: false,
    failEngine: false,
    failDetect: false,
    onDetect: () => {},
  }
}
resetPdf()
stubModule("@/lib/storage/drawings-pdfs-storage", {
  ...require("@/lib/storage/drawings-pdfs-storage"),
  downloadDrawingPdfObject: async ({ orgId, path }) => {
    pdf.downloads.push({ orgId, path })
    if (pdf.failDownload) throw new Error("Download unavailable")
    return new Uint8Array([1, 2])
  },
})
stubModule("@/lib/services/mupdf-loader", {
  loadMupdf: async () => {
    if (pdf.failEngine) throw new Error("Engine unavailable")
    return {
      Document: {
        openDocument: () => ({
          countPages: () => 5,
          loadPage: (index) => {
            pdf.pages.push(index)
            return { destroy: () => pdf.destroyed.push("page") }
          },
          destroy: () => pdf.destroyed.push("document"),
        }),
      },
    }
  },
})
stubModule("@/lib/services/drawings-pipeline", {
  ...require("@/lib/services/drawings-pipeline"),
  detectCalibrationProposal: (_page, dimensions) => {
    pdf.dimensions.push(dimensions)
    pdf.onDetect()
    if (pdf.failDetect) throw new Error("Engine failed")
    return pdf.proposal
  },
})

const { detectSheetVersionScale, getSheetCalibration, setSheetVersionCalibration } = freshRequire("lib/services/drawings.ts")

const FOREIGN_ORG = id(1)
const PROJECT = id(2)
const SHEET = id(3)
const VERSION = id(4)
const REVISION = id(5)
const FILE = id(6)
const MISSING = id(99)

const STAMP = "2026-10-04T12:00:00.123456+00:00"
const MARKUP_PERMISSIONS = ["drawing.read", "drawing.markup", "project.read"]

const sheetHome = { id: SHEET, org_id: ORG, project_id: PROJECT }
const projects = [{ id: PROJECT, org_id: ORG, division_id: null }]

// ============================================================================
// detectSheetVersionScale
// ============================================================================

describe("detectSheetVersionScale", () => {
  const original = {
    id: VERSION,
    org_id: ORG,
    drawing_sheet_id: SHEET,
    file_id: FILE,
    page_index: 2,
    image_width: 400,
    image_height: 600,
    tile_manifest: { Image: { Size: { Width: 400, Height: 600 } } },
    extracted_metadata: { room: 'BEDROOM, "original"', other: { reviewed: true } },
    drawing_sheets: sheetHome,
  }
  const file = { id: FILE, org_id: ORG, storage_path: `${ORG}/original.pdf` }

  function scanning({ version = {}, files = [file], ...options } = {}) {
    resetPdf()
    return createServiceHarness({
      permissions: MARKUP_PERMISSIONS,
      ...options,
      tables: { projects, drawing_sheet_versions: [{ ...original, ...version }], files },
    })
  }
  const detect = (service, versionId = VERSION) => service.run(() => detectSheetVersionScale(versionId))
  const stored = (service) => service.db.drawing_sheet_versions[0]?.extracted_metadata
  const untouchedPdf = () => {
    assert.deepEqual(pdf.downloads, [])
    assert.deepEqual(pdf.pages, [])
  }

  test("an invalid version id is refused before anything is read", async () => {
    const service = scanning()
    await assert.rejects(detect(service, "bad"))
    assert.deepEqual(service.queries, [])
  })

  test("a version that is out of scope, unverifiable or out of the actor's reach never opens the PDF", async () => {
    const cases = [
      { tamper: replies.error() },
      { tamper: replies.missing() },
      { tamper: replies.patch({ id: MISSING }) },
      { version: { org_id: FOREIGN_ORG } },
      { version: { drawing_sheets: null } },
      { version: { drawing_sheets: [] } },
      { version: { drawing_sheets: [sheetHome, sheetHome] } },
      { version: { drawing_sheets: { ...sheetHome, id: MISSING } } },
      { version: { drawing_sheets: { ...sheetHome, org_id: FOREIGN_ORG } } },
      { version: { drawing_sheets: { ...sheetHome, project_id: "bad" } } },
      { permissions: ["drawing.read", "project.read"] },
    ]
    for (const { tamper, ...options } of cases) {
      const service = scanning(options)
      if (tamper) service.tamper("drawing_sheet_versions", tamper, { on: "select" })
      await assert.rejects(detect(service), undefined, JSON.stringify(options))
      assert.deepEqual(service.writes(), [])
      untouchedPdf()
    }
  })

  test("malformed metadata is not mistaken for an empty record", async () => {
    for (const extracted_metadata of [undefined, [], 42, "invalid"]) {
      const service = scanning({ version: { extracted_metadata } })
      await assert.rejects(detect(service))
      assert.deepEqual(service.writes(), [])
    }
  })

  test("a source file that is missing, foreign or pathless is not recorded as scanned", async () => {
    const cases = [
      { files: [] },
      { tamper: replies.error() },
      { tamper: replies.missing() },
      { files: [{ ...file, org_id: FOREIGN_ORG }] },
      { tamper: replies.rows({ id: MISSING, org_id: ORG, storage_path: "other.pdf" }) },
      { files: [{ ...file, storage_path: "" }] },
      { files: [{ ...file, storage_path: "   " }] },
    ]
    for (const { tamper, ...options } of cases) {
      const service = scanning(options)
      if (tamper) service.tamper("files", tamper)
      await assert.rejects(detect(service), /source file unavailable/)
      assert.deepEqual(service.writes(), [])
      untouchedPdf()
    }
  })

  test("a PDF that cannot be read is an infrastructure failure, not a negative scan", async () => {
    for (const failure of ["failEngine", "failDetect", "failDownload"]) {
      const service = scanning()
      pdf[failure] = true
      await assert.rejects(detect(service))
      assert.deepEqual(service.writes(), [])
      assert.equal(stored(service).calibration_scan, undefined)
      if (failure === "failDetect") assert.deepEqual(pdf.destroyed, ["page", "document"])
    }
  })

  test("a version changed by someone else while the PDF was read keeps their change", async () => {
    const humanScale = { extracted_metadata: { calibration: { feet_per_image_px: 0.9, method: "two_point" } } }
    for (const race of [
      humanScale,
      { drawing_sheet_id: MISSING },
      { file_id: MISSING },
      { page_index: 3 },
      { image_width: 500 },
      { image_height: 700 },
      { tile_manifest: { Image: { Size: { Width: 500, Height: 700 } } } },
      "removed",
    ]) {
      const service = scanning()
      pdf.onDetect = () => {
        if (race === "removed") service.db.drawing_sheet_versions.splice(0)
        else Object.assign(service.db.drawing_sheet_versions[0], race)
      }
      await assert.rejects(detect(service), /changed during scale detection/)
      if (race === humanScale) assert.deepEqual(stored(service), humanScale.extracted_metadata)
    }
  })

  test("a saved scan that is missing or does not match what was written returns no proposal", async () => {
    const changedScan = (result) => ({
      ...result,
      data: {
        ...result.data,
        extracted_metadata: {
          ...result.data.extracted_metadata,
          calibration_scan: { ...result.data.extracted_metadata.calibration_scan, found: false },
        },
      },
    })
    for (const reply of [
      replies.error(),
      replies.missing(),
      replies.patch({ id: MISSING }),
      replies.patch({ org_id: FOREIGN_ORG }),
      replies.patch({ drawing_sheet_id: MISSING }),
      replies.patch({ file_id: MISSING }),
      replies.patch({ page_index: 3 }),
      replies.patch({ image_width: 500 }),
      replies.patch({ tile_manifest: null }),
      replies.patch({ drawing_sheets: { ...sheetHome, project_id: MISSING } }),
      changedScan,
    ]) {
      const service = scanning()
      service.tamper("drawing_sheet_versions", reply, { on: "update" })
      await assert.rejects(detect(service))
    }
  })

  test("access revoked while the PDF was read stops the save", async () => {
    const service = scanning()
    pdf.onDetect = () => service.grant([])
    await assert.rejects(detect(service), /Missing permission: drawing.markup/)
    assert.deepEqual(service.writes(), [])
    assert.deepEqual(pdf.destroyed, ["page", "document"])
  })

  test("the scale is read from the version's own page at its stored raster size, and the scan is saved", async () => {
    const service = scanning()
    assert.deepEqual(await detect(service), pdf.proposal)
    assert.deepEqual(pdf.downloads, [{ orgId: ORG, path: `${ORG}/original.pdf` }])
    assert.deepEqual(pdf.pages, [2])
    assert.deepEqual(pdf.dimensions, [{ widthPx: 400, heightPx: 600 }])
    assert.deepEqual(pdf.destroyed, ["page", "document"])
    assert.equal(stored(service).calibration_scan.found, true)
    assert.deepEqual(stored(service).calibration_proposal, pdf.proposal)
    assert.deepEqual(stored(service).other, original.extracted_metadata.other)
  })

  test("a page without a readable scale is recorded as scanned, so it is not reopened", async () => {
    const service = scanning()
    pdf.proposal = null
    assert.equal(await detect(service), null)
    assert.equal(stored(service).calibration_scan.found, false)
  })

  test("a human scale, or a proposal already found, is returned without opening the PDF", async () => {
    const proposal = { feet_per_image_px: 0.2, method: "title_block", raw: "1/4 inch = 1 foot" }
    for (const extracted_metadata of [{ calibration: { feet_per_image_px: 0.3 } }, { calibration_proposal: proposal }]) {
      const service = scanning({ version: { extracted_metadata } })
      assert.deepEqual(await detect(service), extracted_metadata.calibration ? null : proposal)
      assert.deepEqual(service.writes(), [])
      untouchedPdf()
    }
  })

  test("a legacy version without metadata or a file is recorded as a negative scan", async () => {
    const service = scanning({ version: { file_id: null, extracted_metadata: null } })
    assert.equal(await detect(service), null)
    assert.equal(stored(service).calibration_scan.found, false)
    untouchedPdf()
  })

  test("a one-element embedded sheet and a reordered saved body are still confirmed", async () => {
    const service = scanning({ version: { drawing_sheets: [sheetHome] } })
    service.tamper("drawing_sheet_versions", (result) => {
      const { calibration_proposal, calibration_scan, other, room } = result.data.extracted_metadata
      return { ...result, data: { ...result.data, extracted_metadata: { calibration_scan, other, room, calibration_proposal } } }
    }, { on: "update" })
    assert.deepEqual(await detect(service), pdf.proposal)
  })
})

// ============================================================================
// getSheetCalibration
// ============================================================================

describe("getSheetCalibration", () => {
  const sheet = { id: SHEET, org_id: ORG, project_id: PROJECT, current_revision_id: REVISION }
  const revision = { id: REVISION, org_id: ORG, project_id: PROJECT }
  const version = {
    id: VERSION,
    org_id: ORG,
    drawing_sheet_id: SHEET,
    drawing_revision_id: REVISION,
    image_width: 400,
    image_height: 600,
    tile_manifest: null,
    extracted_metadata: {},
    drawing_revisions: revision,
    created_at: STAMP,
  }
  const proposal = { feet_per_image_px: 0.2, method: "title_block", raw: "Original printed scale" }

  const reading = ({ sheets = [sheet], versions = [version], ...options } = {}) =>
    createServiceHarness({
      permissions: ["drawing.read", "project.read"],
      ...options,
      tables: { projects, drawing_sheets: sheets, drawing_sheet_versions: versions },
    })
  const read = (service, sheetId = SHEET) => service.run(() => getSheetCalibration(sheetId))
  const withMetadata = (extracted_metadata) => reading({ versions: [{ ...version, extracted_metadata }] })
  /** Rewrite only the re-read of the sheet that confirms nothing moved. */
  const onSecondSheetRead = (reply) => {
    let reads = 0
    return (result) => (++reads === 2 ? reply(result) : result)
  }

  test("an invalid sheet id is refused before anything is read", async () => {
    const service = reading()
    await assert.rejects(read(service, "bad"))
    assert.deepEqual(service.queries, [])
  })

  test("a sheet that is unreadable, malformed or out of reach is refused before its versions are read", async () => {
    const cases = [
      { tamper: replies.error() },
      { tamper: replies.patch({ id: MISSING }) },
      { tamper: replies.patch({ org_id: FOREIGN_ORG }) },
      { tamper: replies.patch({ project_id: "bad" }) },
      { tamper: replies.patch({ current_revision_id: "bad" }) },
      { tamper: replies.patch({ current_revision_id: undefined }) },
      { permissions: ["project.read"] },
    ]
    for (const { tamper, ...options } of cases) {
      const service = reading(options)
      if (tamper) service.tamper("drawing_sheets", tamper)
      await assert.rejects(read(service), undefined, JSON.stringify(options))
      assert.deepEqual(service.reads("drawing_sheet_versions"), [])
    }
  })

  test("a current version that is missing, foreign or mismatched is an error, never 'no scale'", async () => {
    for (const reply of [
      replies.error(),
      replies.missing(),
      replies.patch({ id: "bad" }),
      replies.patch({ org_id: FOREIGN_ORG }),
      replies.patch({ drawing_sheet_id: MISSING }),
      replies.patch({ drawing_revision_id: MISSING }),
      replies.patch({ drawing_revisions: null }),
      replies.patch({ drawing_revisions: [] }),
      replies.patch({ drawing_revisions: [revision, revision] }),
      replies.patch({ drawing_revisions: { ...revision, id: MISSING } }),
      replies.patch({ drawing_revisions: { ...revision, org_id: FOREIGN_ORG } }),
      replies.patch({ drawing_revisions: { ...revision, project_id: MISSING } }),
    ]) {
      const service = reading()
      service.tamper("drawing_sheet_versions", reply)
      await assert.rejects(read(service))
    }
  })

  test("stored metadata that cannot be read is refused rather than defaulted", async () => {
    const invalid = [
      undefined,
      [],
      false,
      "bad",
      ...[
        false,
        {},
        [],
        { feet_per_image_px: Infinity },
        { feet_per_image_px: NaN },
        { feet_per_image_px: 0 },
        { feet_per_image_px: -1 },
        { feet_per_image_px: "0.2" },
        { feet_per_image_px: 0.2, method: "bogus" },
        { feet_per_image_px: 0.2, source_label: 5 },
        { feet_per_image_px: 0.2, carried_from_version_id: "bad" },
      ].map((calibration) => ({ calibration })),
      ...[
        false,
        {},
        [],
        { ...proposal, feet_per_image_px: Infinity },
        { ...proposal, feet_per_image_px: 0 },
        { ...proposal, method: "two_point" },
        { ...proposal, raw: false },
        { ...proposal, sample_count: 0.5 },
        { ...proposal, sample_count: Infinity },
        { ...proposal, spread_pct: NaN },
        { ...proposal, spread_pct: -1 },
      ].map((calibration_proposal) => ({ calibration_proposal })),
      ...[
        true,
        {},
        [],
        { at: "bad", found: false },
        { at: "2026-10-04T12:00:00Z", found: "false" },
        { at: "2026-10-04T12:00:00Z", found: false, method: "bad" },
      ].map((calibration_scan) => ({ calibration_scan })),
      ...[
        { inferred_feet_per_image_px: Infinity },
        { inferred_feet_per_image_px: 0 },
        { inferred_feet_per_image_px: "0.2" },
        { inferred_feet_per_image_px: 0.2, verified_count: -1 },
        { inferred_feet_per_image_px: 0.2, verified_count: Infinity },
      ].map((spaces) => ({ spaces })),
    ]
    for (const metadata of invalid) {
      // Answered rather than seeded: a seeded row is JSON, and JSON has no Infinity or NaN.
      const service = reading()
      service.tamper("drawing_sheet_versions", replies.patch({ extracted_metadata: metadata }))
      await assert.rejects(read(service), undefined, JSON.stringify(metadata))
    }
  })

  test("image dimensions that are not safe integers are refused", async () => {
    for (const patch of [
      { image_width: Infinity },
      { image_width: -1 },
      { image_height: "600" },
      { tile_manifest: undefined },
      { tile_manifest: { Image: { Size: { Width: Infinity } } } },
      { tile_manifest: { Image: { Size: { Width: false } } } },
      { tile_manifest: { Image: { Size: { Height: "bad" } } } },
    ]) {
      const service = reading()
      service.tamper("drawing_sheet_versions", replies.patch(patch))
      await assert.rejects(read(service), undefined, JSON.stringify(patch))
    }
  })

  test("a sheet that moves, or access that is revoked, while the scale is read returns nothing", async () => {
    const cases = [
      ["drawing_sheets", onSecondSheetRead(replies.error())],
      ["drawing_sheets", onSecondSheetRead(replies.missing())],
      ["drawing_sheets", onSecondSheetRead(replies.patch({ org_id: FOREIGN_ORG }))],
      ["drawing_sheets", onSecondSheetRead(replies.patch({ project_id: MISSING }))],
      ["drawing_sheets", onSecondSheetRead(replies.patch({ current_revision_id: MISSING }))],
    ]
    for (const tamper of cases) {
      const service = reading()
      service.tamper(...tamper)
      await assert.rejects(read(service))
    }
    const revoked = reading()
    revoked.tamper("drawing_sheet_versions", (result) => {
      revoked.grant([])
      return result
    })
    await assert.rejects(read(revoked), /Missing permission: drawing.read/)
  })

  test("a sheet that does not exist, or has never been published, has no calibration", async () => {
    assert.equal(await read(reading({ sheets: [] })), null)
    const unpublished = reading({ sheets: [{ ...sheet, current_revision_id: null }] })
    assert.equal(await read(unpublished), null)
    assert.deepEqual(unpublished.reads("drawing_sheet_versions"), [])
  })

  test("an uncalibrated current version reports its dimensions and is not yet scanned", async () => {
    const service = reading()
    assert.deepEqual(await read(service), {
      sheet_version_id: VERSION,
      feet_per_image_px: null,
      method: null,
      source_label: null,
      carried_from_version_id: null,
      image_width: 400,
      image_height: 600,
      proposal: null,
      scanned: false,
    })
    assert.deepEqual(service.writes(), [])
  })

  test("a legacy human scale reads as dragged, with its full label and carry", async () => {
    const label = "Original label ".repeat(20)
    const calibration = { feet_per_image_px: 0.2, source_label: label, carried_from_version_id: id(90) }
    const value = await read(withMetadata({ calibration }))
    assert.equal(value.method, "two_point")
    assert.equal(value.feet_per_image_px, 0.2)
    assert.equal(value.source_label, label)
    assert.equal(value.carried_from_version_id, id(90))
  })

  test("a stored proposal outranks an inferred one, and either counts as scanned", async () => {
    const negative = await read(withMetadata({ calibration_scan: { at: "2026-10-04T12:00:00Z", found: false } }))
    assert.equal(negative.scanned, true)
    assert.equal(negative.proposal, null)

    const stored = await read(withMetadata({
      calibration_proposal: { ...proposal, raw: undefined, sample_count: 4, spread_pct: 0 },
      spaces: { inferred_feet_per_image_px: 0.9, verified_count: 7 },
    }))
    assert.deepEqual(stored.proposal, { ...proposal, raw: null, sample_count: 4, spread_pct: 0 })
    assert.equal(stored.scanned, true)

    const inferred = await read(withMetadata({ spaces: { inferred_feet_per_image_px: 0.3, verified_count: 7 } }))
    assert.deepEqual(inferred.proposal, { feet_per_image_px: 0.3, method: "space_area", raw: null, sample_count: 7 })
  })

  test("legacy metadata shapes read as unscanned", async () => {
    for (const extracted_metadata of [null, { spaces: [] }, { spaces: { inferred_feet_per_image_px: null } }]) {
      const service = reading({ versions: [{ ...version, extracted_metadata, drawing_revisions: [revision] }] })
      assert.equal((await read(service)).scanned, false)
    }
  })

  test("a legacy proposal with null optional evidence reads without it", async () => {
    const value = await read(withMetadata({ calibration_proposal: { ...proposal, sample_count: null, spread_pct: null } }))
    assert.deepEqual(value.proposal, proposal)
  })

  test("manifest dimensions win over the stored size, and a zero dimension is unknown", async () => {
    const tile_manifest = { Image: { Size: { Width: "800", Height: "0" } } }
    const value = await read(reading({ versions: [{ ...version, tile_manifest }] }))
    assert.equal(value.image_width, 800)
    assert.equal(value.image_height, null)
  })

  test("two versions created at the same instant resolve to the same one every time", async () => {
    const value = await read(reading({ versions: [{ ...version, id: id(7) }, version] }))
    assert.equal(value.sheet_version_id, id(7))
  })
})

// ============================================================================
// setSheetVersionCalibration
// ============================================================================

describe("setSheetVersionCalibration", () => {
  const original = {
    id: VERSION,
    org_id: ORG,
    drawing_sheet_id: SHEET,
    drawing_revision_id: REVISION,
    extracted_metadata: {
      room: 'BEDROOM (1), "quoted"',
      calibration: { feet_per_image_px: 0.1, method: "two_point", verify: true },
      other: { identity_reviewed: true },
    },
    image_width: 400,
    image_height: 400,
    tile_manifest: { Image: { Size: { Width: 400, Height: 400 } } },
    drawing_sheets: sheetHome,
    drawing_revisions: { id: REVISION, org_id: ORG, project_id: PROJECT },
  }
  const input = { sheet_version_id: VERSION, feet_per_image_px: 0.2, method: "two_point", source_label: "Reviewed dimension" }
  /** An area measured at the old 0.1 ft/px scale. */
  const measuredArea = (n, overrides = {}) => ({
    id: id(100 + n),
    org_id: ORG,
    sheet_version_id: VERSION,
    drawing_sheet_id: SHEET,
    created_by: ACTOR,
    condition_id: null,
    updated_at: STAMP,
    data: { type: "area", points: [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5], [0.1, 0.5]] },
    quantity: 256,
    uom: "sf",
    ...overrides,
  })

  const calibrating = ({ version = {}, versions, markups = [measuredArea(0), measuredArea(1)], ...options } = {}) =>
    createServiceHarness({
      permissions: MARKUP_PERMISSIONS,
      ...options,
      tables: {
        projects,
        drawing_sheet_versions: versions ?? [{ ...original, ...version }],
        drawing_markups: markups,
        takeoff_conditions: [],
      },
    })
  const save = (service, value = input) => service.run(() => setSheetVersionCalibration(value))
  const stored = (service) => service.db.drawing_sheet_versions[0]?.extracted_metadata

  function assertNoSuccess(service) {
    assert.deepEqual(service.writes("drawing_markups"), [])
    assert.deepEqual(service.audits, [])
    assert.deepEqual(service.events, [])
  }

  test("an invalid scale is refused before anything is read", async () => {
    for (const patch of [
      { sheet_version_id: "bad" },
      { feet_per_image_px: 0 },
      { feet_per_image_px: Infinity },
      { method: "bad" },
    ]) {
      const service = calibrating()
      await assert.rejects(save(service, { ...input, ...patch }))
      assert.deepEqual(service.queries, [])
    }
  })

  test("a version that is out of scope or out of reach keeps its scale", async () => {
    const cases = [
      { versions: [] },
      { tamper: replies.error() },
      { tamper: replies.missing() },
      { tamper: replies.patch({ id: MISSING }) },
      { tamper: replies.patch({ org_id: FOREIGN_ORG }) },
      { version: { drawing_sheets: null } },
      { version: { drawing_sheets: [] } },
      { version: { drawing_sheets: [sheetHome, sheetHome] } },
      { version: { drawing_sheets: { ...sheetHome, id: MISSING } } },
      { version: { drawing_sheets: { ...sheetHome, org_id: FOREIGN_ORG } } },
      { version: { drawing_sheets: { ...sheetHome, project_id: "invalid" } } },
      { permissions: ["drawing.read", "project.read"] },
    ]
    for (const { tamper, ...options } of cases) {
      const service = calibrating(options)
      if (tamper) service.tamper("drawing_sheet_versions", tamper, { on: "select", times: 1 })
      await assert.rejects(save(service), undefined, JSON.stringify(options))
      assert.deepEqual(service.writes(), [])
      assertNoSuccess(service)
    }
  })

  test("metadata that cannot be read is not overwritten as if it were empty", async () => {
    for (const extracted_metadata of [undefined, [], 42, "bad"]) {
      const service = calibrating({ version: { extracted_metadata } })
      await assert.rejects(save(service))
      assert.deepEqual(service.writes(), [])
    }
  })

  test("a version changed by someone else after it was read keeps their change", async () => {
    for (const race of ["metadata", "sheet", "removed"]) {
      const service = calibrating()
      service.tamper("drawing_sheet_versions", (result) => {
        if (race === "removed") service.db.drawing_sheet_versions.splice(0)
        else if (race === "sheet") service.db.drawing_sheet_versions[0].drawing_sheet_id = MISSING
        else service.db.drawing_sheet_versions[0].extracted_metadata = { concurrent: true }
        return result
      }, { on: "select", times: 1 })
      await assert.rejects(save(service), /metadata changed during calibration/)
      assertNoSuccess(service)
      if (race === "metadata") assert.deepEqual(stored(service), { concurrent: true })
    }
  })

  test("a saved scale that cannot be confirmed does not re-measure anything", async () => {
    const changedCalibration = (patch) => (result) => ({
      ...result,
      data: {
        ...result.data,
        extracted_metadata: { ...result.data.extracted_metadata, ...patch(result.data.extracted_metadata) },
      },
    })
    for (const reply of [
      replies.error(),
      replies.missing(),
      replies.patch({ id: MISSING }),
      replies.patch({ org_id: FOREIGN_ORG }),
      replies.patch({ drawing_sheet_id: MISSING }),
      replies.patch({ image_width: 500 }),
      replies.patch({ image_height: 500 }),
      replies.patch({ tile_manifest: { Image: { Size: { Width: 999, Height: 999 } } } }),
      replies.patch({ drawing_sheets: { ...sheetHome, project_id: MISSING } }),
      changedCalibration((metadata) => ({ calibration: { ...metadata.calibration, feet_per_image_px: 0.3 } })),
      changedCalibration((metadata) => ({ calibration: { ...metadata.calibration, set_by: MISSING } })),
      changedCalibration((metadata) => ({ calibration: { ...metadata.calibration, source_label: "Different" } })),
      changedCalibration(() => ({ other: { identity_reviewed: false } })),
    ]) {
      const service = calibrating()
      service.tamper("drawing_sheet_versions", reply, { on: "update" })
      await assert.rejects(save(service))
      assertNoSuccess(service)
    }
  })

  test("a confirmed scale keeps the other metadata, credits the actor, clears the verify flag and re-measures", async () => {
    const service = calibrating()
    const saved = await save(service)
    assert.equal(saved.feet_per_image_px, 0.2)
    assert.equal(saved.source_label, input.source_label)
    assert.equal(saved.recomputed_markups, 2)
    assert.ok(service.db.drawing_markups.every((row) => row.quantity === 1024))

    const metadata = stored(service)
    assert.equal(metadata.room, original.extracted_metadata.room)
    assert.deepEqual(metadata.other, original.extracted_metadata.other)
    assert.equal(metadata.calibration.set_by, ACTOR)
    assert.equal(metadata.calibration.verify, undefined)

    assert.equal(service.audits[0].actorId, ACTOR)
    assert.equal(service.events[0].payload.project_id, PROJECT)
  })

  test("a version without metadata, or with empty metadata, can be calibrated", async () => {
    for (const extracted_metadata of [null, {}]) {
      const saved = await save(calibrating({ version: { extracted_metadata }, markups: [] }))
      assert.equal(saved.recomputed_markups, 0)
      assert.equal(saved.feet_per_image_px, 0.2)
    }
  })

  test("an empty source label is stored as no label", async () => {
    const service = calibrating()
    assert.equal((await save(service, { ...input, source_label: "" })).source_label, null)
    assert.equal(stored(service).calibration.source_label, undefined)
  })

  test("a one-element embedded sheet and a reordered saved body are still confirmed", async () => {
    const service = calibrating({ version: { drawing_sheets: [sheetHome] } })
    service.tamper("drawing_sheet_versions", (result) => {
      const { calibration, other, room } = result.data.extracted_metadata
      return { ...result, data: { ...result.data, extracted_metadata: { calibration, other, room } } }
    }, { on: "update" })
    assert.equal((await save(service)).feet_per_image_px, 0.2)
  })

  test("a re-measure that fails is reported and nothing is audited", async () => {
    const service = calibrating({ markups: [measuredArea(0, { quantity: "bad" })] })
    await assert.rejects(save(service))
    assert.deepEqual(service.audits, [])
    assert.deepEqual(service.events, [])
  })

  test.todo("a failed re-measure leaves the old scale in place") // owner: drawings — scale save and re-measure are not one transaction
})
