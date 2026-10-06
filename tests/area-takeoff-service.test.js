const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const { beforeEach, describe, test } = require("node:test")

const { createFakeSupabase } = require("./support/fake-supabase")
const { freshRequire, stubModule } = require("./support/modules")
const {
  areaEvidence,
  createVisionProvider,
  rectanglePath,
  stubPermissions,
  stubTileStorage,
  stubVisionProvider,
  whitePng,
} = require("./support/drawings")

const { encodeTextRuns } = require("../lib/drawings/text-runs")

// ---------------------------------------------------------------------------
// Boundaries: permissions, audit/events, tile storage, the vision provider.
// Measurement context, condition scope and the sheet building record are real
// and read the fake database below.
// ---------------------------------------------------------------------------

const permissions = stubPermissions()
const storage = stubTileStorage()
const vision = stubVisionProvider(createVisionProvider(null))
const audit = { fail: false }
stubModule("lib/services/audit.ts", {
  async recordAudit() {
    if (audit.fail) throw new Error("Audit unavailable")
  },
})
const events = []
stubModule("lib/services/events.ts", { recordEvent: async (event) => events.push(event) })
stubModule("lib/services/drawings-sheet-images.ts", {
  async renderSheetWindowImage() {
    return { data: await whitePng(64, 64), mediaType: "image/png" }
  },
})

const { runWithServiceOrgContext } = freshRequire("lib/services/context.ts")
const { acceptTakeoffAreas, exportAreaDetectionReplay, proposeTakeoffAreas } = freshRequire("lib/services/area-takeoff.ts")

const orgId = randomUUID()
const userId = randomUUID()
const projectId = randomUUID()
const sheetId = randomUUID()
const versionId = randomUUID()
const revisionId = randomUUID()
const conditionId = randomUUID()
const tilesBasePath = `${orgId}/test`

/**
 * `accept_takeoff_area_snapshot` as the SQL function behaves: refuse when the
 * condition's measurements no longer match the reviewed snapshot, otherwise
 * insert every row (ids are deterministic, so a retry inserts nothing new).
 */
const transaction = { error: null, concurrentWrite: null }
function acceptSnapshot(args, store) {
  if (transaction.error) return { error: transaction.error }
  transaction.concurrentWrite?.(store)
  const current = store.drawing_markups
    .filter((row) => row.org_id === args.p_org_id && row.sheet_version_id === args.p_version_id && row.condition_id === args.p_condition_id)
    .map(({ id, data }) => ({ id, data }))
    .sort((a, b) => a.id.localeCompare(b.id))
  if (JSON.stringify(current) !== JSON.stringify(args.p_snapshot)) {
    return { error: { message: "Measurements changed during review" } }
  }
  for (const row of args.p_rows) {
    if (!store.drawing_markups.some((existing) => existing.id === row.id)) store.drawing_markups.push(structuredClone(row))
  }
  return { error: null }
}

let db
function seed({ imageWidth = 1000, imageHeight = 1000 } = {}) {
  db = createFakeSupabase(
    {
      drawing_sheet_versions: [
        {
          id: versionId,
          org_id: orgId,
          drawing_sheet_id: sheetId,
          drawing_revision_id: revisionId,
          image_width: imageWidth,
          image_height: imageHeight,
          tile_manifest: null,
          tiles_base_path: tilesBasePath,
          source_hash: "hash",
          file_id: null,
          page_index: 0,
          extracted_metadata: { calibration: { feet_per_image_px: 0.02, method: "two_point" } },
          drawing_sheets: { id: sheetId, org_id: orgId, project_id: projectId },
          drawing_revisions: { id: revisionId, org_id: orgId, project_id: projectId },
        },
      ],
      drawing_sheets: [{ id: sheetId, org_id: orgId, project_id: projectId, current_revision_id: revisionId }],
      takeoff_conditions: [
        {
          id: conditionId,
          org_id: orgId,
          name: "Floor",
          color: "#123456",
          uom: "sf",
          depth_in: null,
          height_ft: null,
          pitch_rise: null,
          tons_per_cy: null,
          project_id: projectId,
          house_plan_version_id: null,
        },
      ],
      drawing_markups: [],
      sheet_building_records: [],
    },
    { accept_takeoff_area_snapshot: acceptSnapshot },
  )
}

const asUser = (work) => runWithServiceOrgContext({ supabase: db, orgId, userId, productTier: "residential" }, work)
const accept = (payload) => asUser(() => acceptTakeoffAreas(payload))
const propose = (input) => asUser(() => proposeTakeoffAreas({ sheet_version_id: versionId, ...input }))
const markups = () => db.store.drawing_markups
const version = () => db.store.drawing_sheet_versions[0]
const condition = () => db.store.takeoff_conditions[0]

beforeEach(() => {
  seed()
  permissions.reset()
  storage.objects.clear()
  vision.calls.length = 0
  vision.answer = null
  audit.fail = false
  events.length = 0
  transaction.error = null
  transaction.concurrentWrite = null
})

// ---------------------------------------------------------------------------
// Accepting reviewed areas
// ---------------------------------------------------------------------------

describe("accepting areas", () => {
  // On a 1000px sheet at 0.02 ft/px: a 16 ft x 16 ft room with a 1 ft x 1 ft column.
  const ring = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]
  const column = [[0.4, 0.4], [0.45, 0.4], [0.45, 0.45], [0.4, 0.45]]
  const payload = (area = {}) => ({
    sheet_version_id: versionId,
    condition_id: conditionId,
    expected_scale: 0.02,
    reviewed: true,
    elapsed_ms: 1000,
    areas: [
      {
        id: "room",
        label: "Kitchen",
        points: ring,
        originalPoints: ring,
        holes: [column],
        boundary: [],
        source: "vector",
        edited: false,
        // A client-supplied quantity is ignored; the server measures.
        areaSqft: 999999,
        ...area,
      },
    ],
  })

  test("the server measures the outer area and its deduction and stamps the review evidence", async () => {
    await accept(payload())

    assert.deepEqual(markups().map((row) => row.quantity), [256, -1])
    assert.ok(markups().every((row) => row.sheet_version_id === versionId && row.created_by === userId))
    assert.ok(markups().every((row) => row.data.style.reviewed && row.data.style.original_points))
    assert.equal(events.length, 1)
    assert.equal(events[0].eventType, "takeoff_areas_accepted")
  })

  test("accepting the same areas again, in either winding, adds nothing", async () => {
    await accept(payload())
    await accept(payload({ points: [...ring].reverse() }))

    assert.equal(markups().length, 2)
  })

  test("a retry after the audit write failed does not repeat quantities", async () => {
    audit.fail = true
    await assert.rejects(accept(payload()), /Audit/)
    assert.equal(markups().length, 2, "the rows committed before the audit failed")

    audit.fail = false
    await accept(payload())

    assert.equal(markups().length, 2)
  })

  test("a scale or revision change since detection refuses the write", async () => {
    version().extracted_metadata.calibration.feet_per_image_px = 0.03
    await assert.rejects(accept(payload()), /scale changed/)

    version().extracted_metadata.calibration.feet_per_image_px = 0.02
    db.store.drawing_sheets[0].current_revision_id = randomUUID()
    await assert.rejects(accept(payload()), /current revision/)

    assert.equal(markups().length, 0)
  })

  test("a condition from another project or with the wrong unit is refused", async () => {
    condition().project_id = randomUUID()
    await assert.rejects(accept(payload()), /project/)

    condition().project_id = projectId
    condition().uom = "lf"
    await assert.rejects(accept(payload()), /SF or SY/)

    assert.equal(markups().length, 0)
  })

  test("a user without takeoff write or markup permission cannot accept areas", async () => {
    for (const key of ["takeoff.write", "drawing.markup"]) {
      permissions.reset()
      permissions.deny(key)
      await assert.rejects(accept(payload()), new RegExp(key.replace(".", "\\.")))
    }
    assert.equal(markups().length, 0)
  })

  test("a failed transaction leaves no outer area without its deduction", async () => {
    transaction.error = { message: "Unavailable" }

    await assert.rejects(accept(payload()), /Unavailable/)

    assert.equal(markups().length, 0)
  })

  test("a missing transaction function fails clearly instead of writing row by row", async () => {
    transaction.error = { code: "PGRST202", message: "Function not found" }

    await assert.rejects(accept(payload()), /transaction database update/)

    assert.equal(markups().length, 0)
  })

  test("a measurement added while the areas were under review rejects the whole batch", async () => {
    transaction.concurrentWrite = (store) =>
      store.drawing_markups.push({
        id: randomUUID(),
        org_id: orgId,
        sheet_version_id: versionId,
        condition_id: conditionId,
        data: { type: "area", points: column },
      })

    await assert.rejects(accept(payload()), /Measurements changed/)

    assert.equal(markups().length, 1, "only the concurrent measurement exists")
  })

  test("an area overlapping an existing measurement, or re-measured with other deductions, is refused", async () => {
    await accept(payload())

    await assert.rejects(accept(payload({ points: [[0.11, 0.1], [0.91, 0.1], [0.91, 0.9], [0.11, 0.9]] })), /overlaps an existing/)
    await assert.rejects(accept(payload({ holes: [] })), /different deductions/)
    assert.equal(markups().length, 2)
  })

  test("an area already traced by hand in the same condition is not counted again", async () => {
    markups().push({
      id: "manual",
      org_id: orgId,
      sheet_version_id: versionId,
      condition_id: conditionId,
      data: { type: "area", points: ring },
    })

    await assert.rejects(accept(payload()), /overlaps an existing/)

    assert.equal(markups().length, 1)
  })

  test("a finish scope note is kept on the area and its deductions, within its length limit", async () => {
    const note = "Same tile through shared living/dining; exclude fixed island."

    await accept(payload({ finishScopeNote: note }))

    assert.ok(markups().every((row) => row.data.style.finish_scope_note === note))
    await assert.rejects(accept(payload({ finishScopeNote: "x".repeat(501) })))
  })
})

// ---------------------------------------------------------------------------
// Proposing areas from stored sheet evidence
// ---------------------------------------------------------------------------

describe("proposing areas", () => {
  function storeSheetEvidence(paths, labels) {
    storage.objects.set(`${tilesBasePath}/area-evidence.json`, Buffer.from(JSON.stringify(areaEvidence(paths))))
    storage.objects.set(`${tilesBasePath}/text-runs.json`, Buffer.from(encodeTextRuns(labels)))
  }
  const bedroom = () => storeSheetEvidence([rectanglePath(1, [0.1, 0.1, 0.9, 0.9])], [{ text: "BEDROOM", x: 0.3, y: 0.3, w: 0.2, h: 0.02 }])

  test("a whole-sheet proposal is measured from the stored evidence at the sheet's scale", async () => {
    bedroom()

    const result = await propose({})

    assert.equal(result.proposals.length, 1)
    assert.equal(result.proposals[0].areaSqft, 256)
    assert.equal(result.scale, 0.02)
  })

  test("a user without takeoff read permission gets no proposal", async () => {
    bedroom()
    permissions.deny("takeoff.read")

    await assert.rejects(propose({}), /takeoff\.read/)
  })

  test("an image proposal needs a region", async () => {
    bedroom()

    await assert.rejects(propose({ vision: true }), /Choose a region/)
    assert.equal(vision.calls.length, 0)
  })

  test("hybrid recognition is recorded, and only the current drawing's replay can be exported", async () => {
    bedroom()
    vision.answer = { elements: [{ pathIds: [1], kind: "wall" }], openings: [] }

    const result = await propose({})

    assert.equal(vision.calls.length, 1)
    assert.equal(result.diagnostic.recognition, "completed")
    assert.equal(result.proposals.length, 1)
    assert.equal(result.proposals[0].areaSqft, 256)
    assert.equal(result.architecture.spaces[0].boundary.status, "needs-review")

    const replay = JSON.parse(await asUser(() => exportAreaDetectionReplay(versionId, result.diagnostic.inputHash)))
    assert.equal(replay.source.sheetVersionId, versionId)
    assert.equal(replay.input.visualObservations.length, 1)

    await assert.rejects(asUser(() => exportAreaDetectionReplay(versionId, "../other-org")), /Invalid/)
    const replayPath = `${tilesBasePath}/auto-areas/replay-${result.diagnostic.inputHash}.json`
    storage.objects.set(replayPath, Buffer.from(JSON.stringify({ ...replay, source: { sheetVersionId: randomUUID() } })))
    await assert.rejects(
      asUser(() => exportAreaDetectionReplay(versionId, result.diagnostic.inputHash)),
      /different drawing/,
    )
  })

  test("an empty recognition saves its replay but stays unavailable, so the next run retries", async () => {
    seed({ imageWidth: 10000, imageHeight: 1000 })
    const rooms = Array.from({ length: 5 }, (_, i) => rectanglePath(i + 1, [0.04 + i * 0.2, 0.1, 0.14 + i * 0.2, 0.9]))
    const labels = rooms.map((_, i) => ({ text: `BEDROOM ${i + 1}`, x: 0.07 + i * 0.2, y: 0.3, w: 0.01, h: 0.02 }))
    storeSheetEvidence(rooms, labels)
    vision.answer = { elements: [], openings: [] }

    const first = await propose({})

    assert.equal(first.diagnostic.recognition, "unavailable")
    assert.equal(vision.calls.length, 4)
    assert.ok(storage.objects.has(`${tilesBasePath}/auto-areas/replay-${first.diagnostic.inputHash}.json`))

    await propose({})
    assert.equal(vision.calls.length, 8, "a partial result is never cached as final")
  })
})
