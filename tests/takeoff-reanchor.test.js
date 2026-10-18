const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, replies, id, ORG, ACTOR } = require("./support/service")
const { stubModule, freshRequire } = require("./support/modules")

// Area evidence is read out of tile storage; this is what storage holds.
let areaEvidence = new Map()
stubModule("@/lib/services/area-revision", {
  loadAreaRevisionSource: async (_supabase, _orgId, versionId) => structuredClone(areaEvidence.get(versionId) ?? null),
})
// A deal's pricing worksheet lives in the precon services; no deal has one here.
stubModule("@/lib/services/precon-workspace", {
  getPreconWorkspace: async () => ({ available: true, pricing: null }),
})

const {
  confirmReanchoredMarkups,
  listReanchorReviewQueue,
  listStaleEstimateAlerts,
  reanchorRevisionMeasurements,
} = freshRequire("lib/services/takeoff-reanchor.ts")

const FOREIGN_ORG = id(1)
const PROJECT = id(2)
const SHEET = id(3)
const REVISION = id(4)
const OLD_REVISION = id(5)
const TARGET = id(6)
const SOURCE = id(7)
const CONDITION = id(8)
const CREATOR = id(9)
const PROSPECT = id(10)
const ESTIMATE = id(11)
const MISSING = id(99)

const STAMP = "2026-10-04T12:00:00.123456Z"
const SQUARE = [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5], [0.1, 0.5]]
/** SQUARE on a 400 px sheet at 0.1 ft/px. */
const SQUARE_SF = 256

const READER = ["takeoff.read", "project.read"]
const WRITER = [...READER, "takeoff.write"]

/** A version of SHEET, calibrated at 0.1 ft/px on a 400 px render. */
function sheetVersion(versionId, createdAt, revision = OLD_REVISION, overrides = {}) {
  return {
    id: versionId,
    org_id: ORG,
    drawing_sheet_id: SHEET,
    drawing_revision_id: revision,
    created_at: createdAt,
    image_width: 400,
    image_height: 400,
    tile_manifest: null,
    extracted_metadata: { calibration: { feet_per_image_px: 0.1 } },
    drawing_sheets: { id: SHEET, org_id: ORG, project_id: PROJECT },
    drawing_revisions: { id: revision, org_id: ORG, project_id: PROJECT },
    ...overrides,
  }
}

function takeoffCondition(overrides = {}) {
  return {
    id: CONDITION,
    org_id: ORG,
    project_id: PROJECT,
    house_plan_version_id: null,
    name: "Floor",
    uom: "sf",
    depth_in: null,
    height_ft: null,
    pitch_rise: null,
    tons_per_cy: null,
    ...overrides,
  }
}

/** The review record a carried measurement holds until someone confirms it. */
const review = (overrides = {}) => ({
  state: "needs_review",
  from_version_id: SOURCE,
  to_version_id: TARGET,
  queued_at: STAMP,
  reason: "not_attempted",
  ...overrides,
})

function assertNoSuccess(service) {
  assert.deepEqual(service.audits, [])
  assert.deepEqual(service.events, [])
}

// ============================================================================
// reanchorRevisionMeasurements
// ============================================================================

describe("reanchorRevisionMeasurements", () => {
  const target = sheetVersion(TARGET, "2026-10-04T12:00:00.123456Z", REVISION)
  const source = sheetVersion(SOURCE, "2026-10-04T12:00:00.123455Z")

  /** A linear run on the source version, private to its creator and shared with subs. */
  const run = (n, versionId = SOURCE, overrides = {}) => ({
    id: id(100 + n),
    org_id: ORG,
    drawing_sheet_id: SHEET,
    sheet_version_id: versionId,
    data: { type: "polyline", points: [[0.1, 0.1], [0.5, 0.5]], style: { custom: "preserve" }, custom: { retained: true } },
    label: "Original",
    is_private: true,
    share_with_clients: false,
    share_with_subs: true,
    created_by: CREATOR,
    condition_id: CONDITION,
    ...overrides,
  })

  function carrying({
    versions = [target, source],
    markups = [run(0)],
    conditions = [takeoffCondition({ uom: "lf" })],
    ...options
  } = {}) {
    areaEvidence = new Map()
    return createServiceHarness({
      maxRows: 37,
      ...options,
      tables: {
        drawing_sheet_versions: versions,
        drawing_markups: markups,
        takeoff_conditions: conditions,
        drawing_revisions: [],
      },
    })
  }
  const carry = (service, revisionId = REVISION, orgId = ORG) =>
    service.run(() => reanchorRevisionMeasurements(revisionId, orgId, service.client))
  const carriedRows = (service) => service.db.drawing_markups.filter((row) => row.sheet_version_id === TARGET)

  test("a measurement is carried for review with its creator, privacy and stored data intact, exactly once", async () => {
    const service = carrying()
    assert.equal((await carry(service)).carried, 1)
    const [saved] = carriedRows(service)
    assert.equal(saved.created_by, CREATOR)
    assert.equal(saved.is_private, true)
    assert.equal(saved.share_with_subs, true)
    assert.equal(saved.condition_id, CONDITION)
    assert.equal(saved.uom, "lf")
    assert.deepEqual(saved.data.custom, { retained: true })
    assert.equal(saved.data.style.custom, "preserve")
    assert.equal(saved.carried_from_markup_id, id(100))
    assert.equal(saved.data.style.reanchor.state, "needs_review")
    assert.equal(service.events[0].eventType, "takeoff_measurements_reanchored")

    // Confirming clears the review record; the provenance column still stops a re-carry.
    delete saved.data.style.reanchor
    assert.equal((await carry(service)).carried, 0)
    assert.equal(carriedRows(service).length, 1)
  })

  test("every measurement on the source is carried, however short the database's pages are", async () => {
    const service = carrying({ markups: Array.from({ length: 1500 }, (_, n) => run(n)) })
    assert.equal((await carry(service)).carried, 1500)
    assert.equal(carriedRows(service).length, 1500)
  })

  test("the measured predecessor is found however many unmeasured versions came after it", async () => {
    const unmeasured = Array.from({ length: 30 }, (_, n) =>
      sheetVersion(id(1000 + n), `2026-10-04T12:00:00.1234${String(n).padStart(2, "0")}Z`),
    )
    const service = carrying({ versions: [target, sheetVersion(SOURCE, "2026-10-04T11:00:00Z"), ...unmeasured] })
    assert.equal((await carry(service)).carried, 1)
  })

  test("a later version is never a predecessor, and time zones compare as instants", async () => {
    const future = sheetVersion(id(20), "2026-10-04T12:00:00.123457Z")
    const prior = sheetVersion(SOURCE, "2026-10-04T08:00:00.123455-04:00")
    const service = carrying({ versions: [target, future, prior], markups: [run(0), run(1, future.id)] })
    assert.equal((await carry(service)).carried, 1)
    assert.equal(carriedRows(service)[0].carried_from_markup_id, id(100))
  })

  test("a measured predecessor at the same instant as the target is ambiguous and carries nothing", async () => {
    const service = carrying({ versions: [target, sheetVersion(SOURCE, target.created_at)] })
    await assert.rejects(carry(service), /ambiguous/)
    assert.deepEqual(service.writes(), [])
  })

  test("an invalid revision or org is refused before anything is read", async () => {
    for (const [revisionId, orgId] of [["bad", ORG], [REVISION, "bad"]]) {
      const service = carrying()
      await assert.rejects(carry(service, revisionId, orgId))
      assert.deepEqual(service.queries, [])
    }
  })

  test("a source measurement that is malformed or out of scope carries nothing", async () => {
    for (const patch of [
      { org_id: FOREIGN_ORG },
      { drawing_sheet_id: MISSING },
      { sheet_version_id: MISSING },
      { created_by: "bad" },
      { is_private: null },
      { data: { type: "polyline", points: [[0, 0], [1, 1]], style: [] } },
    ]) {
      const service = carrying()
      service.tamper("drawing_markups", (result, query) =>
        query.where.sheet_version_id === SOURCE ? replies.patch(patch)(result) : result,
      )
      await assert.rejects(carry(service), undefined, JSON.stringify(patch))
      assert.deepEqual(service.writes(), [])
    }
  })

  test("a carry whose saved rows cannot be confirmed reports no success", async () => {
    for (const reply of [
      replies.missing(),
      replies.error("failed"),
      replies.rows([]),
      (result) => ({ ...result, data: [result.data[0], result.data[0]] }),
      replies.patch({ org_id: FOREIGN_ORG }),
      replies.patch({ quantity: "bad" }),
      replies.patch({ label: "changed" }),
    ]) {
      const service = carrying()
      service.tamper("drawing_markups", reply, { on: "insert" })
      await assert.rejects(carry(service))
      assert.deepEqual(service.events, [])
    }
  })

  test.todo("a carry refused after its insert leaves no carried rows") // owner: takeoff — insert and confirm are not one transaction

  test("a saved quantity written back as a decimal string is still confirmed", async () => {
    const service = carrying()
    service.tamper("drawing_markups", (result) => ({
      ...result,
      data: result.data.map((row) => ({ ...row, quantity: `${row.quantity}0` })),
    }), { on: "insert" })
    assert.equal((await carry(service)).carried, 1)
  })

  test("a condition that cannot take the carried unit stops the carry before anything is written", async () => {
    const service = carrying({ conditions: [takeoffCondition({ uom: "sf" })] })
    await assert.rejects(carry(service), /measures in SF/)
    assert.deepEqual(service.writes(), [])
  })

  test("a revision version read that is unreadable, stalled or foreign carries nothing", async () => {
    const foreignTarget = { ...target, org_id: FOREIGN_ORG }
    for (const reply of [replies.missing(), replies.error(), replies.rows([target]), replies.rows([foreignTarget])]) {
      const service = carrying()
      service.tamper("drawing_sheet_versions", (result, query) =>
        query.where.drawing_revision_id === REVISION ? reply(result) : result,
      )
      await assert.rejects(carry(service))
      assert.deepEqual(service.writes(), [])
    }
  })

  test("a failed read of the history, the source or the already-carried rows carries nothing", async () => {
    const stages = {
      history: ["drawing_sheet_versions", (query) => query.where.drawing_sheet_id === SHEET],
      source: ["drawing_markups", (query) => query.where.sheet_version_id === SOURCE],
      existing: ["drawing_markups", (query) => query.where.sheet_version_id === TARGET],
    }
    const foreign = (result) => ({ ...result, data: [{ ...(result.data?.[0] ?? run(50, TARGET)), org_id: FOREIGN_ORG }] })
    for (const [stage, [table, aimed]] of Object.entries(stages)) {
      for (const reply of [replies.missing(), replies.error(), foreign]) {
        const service = carrying()
        service.tamper(table, (result, query) => (query.action === "select" && aimed(query) ? reply(result) : result))
        await assert.rejects(carry(service), undefined, stage)
        assert.deepEqual(service.writes(), [])
      }
    }
  })

  test("a carried row with conflicting or duplicated provenance carries nothing", async () => {
    for (const kind of ["conflict", "duplicate"]) {
      const existing = run(200, TARGET, {
        carried_from_markup_id: id(100),
        data: {
          type: "polyline",
          points: [[0, 0], [1, 1]],
          style: { reanchor: { source_markup_id: kind === "conflict" ? MISSING : id(100) } },
        },
      })
      const markups = [run(0), existing, ...(kind === "duplicate" ? [{ ...existing, id: id(201) }] : [])]
      const service = carrying({ markups })
      await assert.rejects(carry(service), /provenance/)
      assert.deepEqual(service.writes(), [])
    }
  })

  test("a failed later insert batch is reported as a failure, with no success event", async () => {
    const service = carrying({ markups: Array.from({ length: 201 }, (_, n) => run(n)) })
    service.tamper("drawing_markups", (result, query) =>
      query.payload.length === 1 ? replies.error("later batch")(result) : result,
    { on: "insert" })
    await assert.rejects(carry(service), /later batch/)
    assert.deepEqual(service.events, [])
  })

  test("a fully carried sheet is recognised as done, however short the database's pages are", async () => {
    const sources = Array.from({ length: 1500 }, (_, n) => run(n))
    const carried = sources.map((row, n) => ({
      ...row,
      id: id(5000 + n),
      sheet_version_id: TARGET,
      carried_from_markup_id: row.id,
      data: { ...row.data, style: {} },
    }))
    const service = carrying({ markups: [...sources, ...carried] })
    assert.equal((await carry(service)).carried, 0)
    assert.deepEqual(service.writes(), [])
  })

  describe("areas and their deductions", () => {
    const PARENT = id(30)
    const HOLE = id(31)
    const wallPath = {
      id: 1,
      commands: [["M", 0.1, 0.1], ["L", 0.9, 0.1]],
      kind: "stroke",
      color: [0],
      colorSpace: "DeviceGray",
      opacity: 1,
      width: 1,
      dashes: [],
      layer: ["A_WALL"],
      groups: [],
      clips: [],
      evenOdd: false,
    }
    const evidence = () => ({
      evidence: { version: 1, truncated: false, unrepresentedPaint: false, paths: [structuredClone(wallPath)] },
      textRuns: [],
      width: 1000,
      height: 1000,
      scale: 0.02,
    })
    const area = (markupId, points, style = {}) => ({
      ...run(0),
      id: markupId,
      data: { type: "area", points, style },
      label: null,
      is_private: false,
      share_with_subs: false,
    })
    const room = area(PARENT, [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]])
    const hole = area(HOLE, [[0.4, 0.4], [0.5, 0.4], [0.5, 0.5], [0.4, 0.5]], { parent_area_id: PARENT, deduction: true })

    function withEvidence(markups, targetEvidence = evidence()) {
      const service = carrying({ markups, conditions: [takeoffCondition()] })
      areaEvidence = new Map([[SOURCE, evidence()], [TARGET, targetEvidence]])
      return service
    }
    /** `[state, evidence comparison]` of each carried row. */
    const reviewOf = (service) =>
      carriedRows(service).map(({ data }) => [data.style.reanchor.state, data.style.reanchor.evidence_comparison])

    test("a room and its deduction travel together, the hole follows the new room, and neither confirms itself", async () => {
      const service = withEvidence([room, hole])
      assert.equal((await carry(service)).carried, 2)
      const [newRoom, newHole] = carriedRows(service)
      assert.notEqual(newRoom.id, PARENT)
      assert.equal(newHole.data.style.parent_area_id, newRoom.id)
      assert.equal(service.db.drawing_markups.find((row) => row.id === HOLE).data.style.parent_area_id, PARENT)
      // The hole has no evidence of its own, so the family cannot be called unchanged.
      assert.deepEqual(reviewOf(service), [["needs_review", "unavailable"], ["needs_review", "unavailable"]])

      assert.equal((await carry(service)).carried, 0)
      for (const row of carriedRows(service)) delete row.data.style.reanchor
      assert.equal((await carry(service)).carried, 0)
      assert.equal(carriedRows(service).length, 2)
    })

    test("changed or missing drawing evidence keeps the room pending review", async () => {
      const moved = evidence()
      moved.evidence.paths[0].commands[1][1] = 0.85
      const changed = withEvidence([room], moved)
      await carry(changed)
      assert.deepEqual(reviewOf(changed), [["needs_review", "changed"]])
      assert.equal(carriedRows(changed)[0].data.style.reanchor.reason, "region_changed")

      const missing = withEvidence([room], null)
      await carry(missing)
      assert.deepEqual(reviewOf(missing), [["needs_review", "unavailable"]])
    })

    test("unchanged evidence is advice only; the room still waits for a person", async () => {
      const service = withEvidence([room])
      await carry(service)
      assert.deepEqual(reviewOf(service), [["needs_review", "unchanged"]])
    })

    test("a deduction whose room is not on the source carries nothing", async () => {
      const service = withEvidence([hole])
      await assert.rejects(carry(service), /without its parent/)
      assert.deepEqual(service.writes(), [])
    })
  })
})

// ============================================================================
// listReanchorReviewQueue
// ============================================================================

describe("listReanchorReviewQueue", () => {
  const VERSION = TARGET
  const pending = (n, overrides = {}) => ({
    id: id(100 + n),
    org_id: ORG,
    drawing_sheet_id: SHEET,
    sheet_version_id: VERSION,
    condition_id: CONDITION,
    created_by: ACTOR,
    is_private: false,
    quantity: "12.500",
    uom: "sf",
    data: { type: "area", style: { reanchor: review({ to_version_id: VERSION }) } },
    drawing_sheets: { id: SHEET, org_id: ORG, project_id: PROJECT, sheet_number: "A-101" },
    takeoff_conditions: { id: CONDITION, org_id: ORG, name: "Floor", color: "#fff" },
    ...overrides,
  })
  const reviewing = ({ rows = [pending(0)], ...options } = {}) =>
    createServiceHarness({
      permissions: READER,
      ...options,
      tables: { projects: [{ id: PROJECT, org_id: ORG, division_id: null }], drawing_markups: rows },
    })
  const queue = (service, projectId = PROJECT) => service.run(() => listReanchorReviewQueue(projectId))

  test("an invalid project is refused before anything is read", async () => {
    const service = reviewing()
    await assert.rejects(queue(service, "bad"))
    assert.deepEqual(service.queries, [])
  })

  test("an actor without the project reads no measurements", async () => {
    const service = reviewing({ projects: [] })
    await assert.rejects(queue(service), /Missing permission: takeoff.read/)
    assert.deepEqual(service.reads("drawing_markups"), [])
  })

  test("access revoked while the queue was read returns nothing", async () => {
    const service = reviewing()
    service.tamper("drawing_markups", (result) => {
      service.grant([])
      return result
    })
    await assert.rejects(queue(service), /Missing permission/)
  })

  test("every pending measurement is listed, however short the database's pages are", async () => {
    const service = reviewing({ maxRows: 37, rows: Array.from({ length: 1500 }, (_, n) => pending(n)) })
    const items = await queue(service)
    assert.equal(items.length, 1500)
    assert.ok(items.every((item) => item.quantity === 12.5 && item.evidence_comparison === "unavailable"))
  })

  test("an empty queue is a successful empty list", async () => {
    assert.deepEqual(await queue(reviewing({ rows: [] })), [])
  })

  test("another creator's private measurement is not listed; the actor's own is", async () => {
    const service = reviewing({
      rows: [pending(0, { is_private: true, created_by: MISSING }), pending(1, { is_private: true })],
    })
    assert.deepEqual((await queue(service)).map((item) => item.markup_id), [id(101)])
  })

  test("a page that is unreadable, stalled or foreign is an error, not an empty queue", async () => {
    const foreign = pending(0, { org_id: FOREIGN_ORG })
    for (const reply of [replies.missing(), replies.error(), replies.rows([pending(0)]), replies.rows([foreign])]) {
      const service = reviewing()
      service.tamper("drawing_markups", reply)
      await assert.rejects(queue(service))
    }
  })

  test("a listed measurement that is malformed or out of scope is refused", async () => {
    const base = pending(0)
    const withReview = (patch) => ({ data: { style: { reanchor: { ...base.data.style.reanchor, ...patch } } } })
    for (const patch of [
      { org_id: FOREIGN_ORG },
      { drawing_sheet_id: MISSING },
      { sheet_version_id: MISSING },
      { is_private: true, created_by: MISSING },
      { quantity: "bad" },
      { quantity: Infinity },
      { quantity: undefined },
      { uom: "ton" },
      { created_by: "bad" },
      { drawing_sheets: null },
      { drawing_sheets: [] },
      { drawing_sheets: [base.drawing_sheets, base.drawing_sheets] },
      { drawing_sheets: { ...base.drawing_sheets, org_id: FOREIGN_ORG } },
      { drawing_sheets: { ...base.drawing_sheets, project_id: MISSING } },
      { takeoff_conditions: null },
      { takeoff_conditions: [base.takeoff_conditions, base.takeoff_conditions] },
      { takeoff_conditions: { ...base.takeoff_conditions, id: MISSING } },
      { takeoff_conditions: { ...base.takeoff_conditions, org_id: FOREIGN_ORG } },
      { condition_id: null },
      withReview({ state: "orphaned" }),
      withReview({ to_version_id: MISSING }),
      withReview({ evidence_comparison: "invalid" }),
      withReview({ queued_at: "bad" }),
    ]) {
      const service = reviewing()
      service.tamper("drawing_markups", replies.patch(patch), { times: 1 })
      await assert.rejects(queue(service), undefined, JSON.stringify(patch))
    }
  })

  test("legacy rows without a condition, quantity, unit or sheet number are listed", async () => {
    const legacy = pending(0, {
      condition_id: null,
      takeoff_conditions: null,
      quantity: null,
      uom: null,
      drawing_sheets: [{ id: SHEET, org_id: ORG, project_id: PROJECT, sheet_number: null }],
    })
    const [item] = await queue(reviewing({ rows: [legacy] }))
    assert.equal(item.condition_name, null)
    assert.equal(item.quantity, null)
    assert.equal(item.sheet_number, "—")
  })

  test("the stored evidence comparison is reported as stored", async () => {
    for (const comparison of ["unchanged", "changed", "unavailable"]) {
      const row = pending(0)
      row.data.style.reanchor.evidence_comparison = comparison
      assert.equal((await queue(reviewing({ rows: [row] })))[0].evidence_comparison, comparison)
    }
  })
})

// ============================================================================
// confirmReanchoredMarkups
// ============================================================================

describe("confirmReanchoredMarkups", () => {
  const VERSION = TARGET

  /** A carried area awaiting review, measured at SQUARE_SF on VERSION. */
  const carried = (n, overrides = {}) => ({
    id: id(100 + n),
    org_id: ORG,
    drawing_sheet_id: SHEET,
    sheet_version_id: VERSION,
    condition_id: CONDITION,
    created_by: ACTOR,
    is_private: false,
    updated_at: STAMP,
    quantity: SQUARE_SF,
    uom: "sf",
    data: { type: "area", points: SQUARE, custom: { retained: true }, style: { custom: "original", reanchor: review() } },
    drawing_sheets: { id: SHEET, org_id: ORG, project_id: PROJECT, current_revision_id: REVISION },
    drawing_sheet_versions: { id: VERSION, org_id: ORG, drawing_sheet_id: SHEET, drawing_revision_id: REVISION },
    ...overrides,
  })

  function confirming({ rows = [carried(0)], conditions = [takeoffCondition()], version = {}, ...options } = {}) {
    return createServiceHarness({
      permissions: WRITER,
      ...options,
      tables: {
        projects: [{ id: PROJECT, org_id: ORG, division_id: null }],
        drawing_sheet_versions: [sheetVersion(VERSION, STAMP, REVISION, version)],
        drawing_markups: rows,
        takeoff_conditions: conditions,
        ...options.tables,
      },
    })
  }
  const confirm = (service, ids = [id(100)]) => service.run(() => confirmReanchoredMarkups(ids))

  test("an invalid or repeated selection is refused before anything is read", async () => {
    for (const ids of [["bad"], [id(100), id(100)]]) {
      const service = confirming()
      await assert.rejects(confirm(service, ids))
      assert.deepEqual(service.queries, [])
    }
  })

  test("an empty selection confirms nothing and reads nothing", async () => {
    const service = confirming()
    assert.equal(await confirm(service, []), 0)
    assert.deepEqual(service.queries, [])
  })

  test("confirming clears only the review record and keeps geometry, data and quantity; a retry is a no-op", async () => {
    const service = confirming()
    assert.equal(await confirm(service), 1)
    const [saved] = service.db.drawing_markups
    assert.equal(saved.data.style.reanchor, undefined)
    assert.equal(saved.data.style.custom, "original")
    assert.deepEqual(saved.data.custom, { retained: true })
    assert.deepEqual(saved.data.points, SQUARE)
    assert.equal(saved.quantity, SQUARE_SF)
    assert.equal(saved.created_by, ACTOR)
    assert.equal(service.audits.length, 1)

    assert.equal(await confirm(service), 0)
    assert.equal(service.writes("drawing_markups").length, 1)
  })

  test("a large selection is confirmed whole, however short the database's pages are", async () => {
    const rows = Array.from({ length: 500 }, (_, n) => carried(n))
    const service = confirming({ rows, maxRows: 37 })
    assert.equal(await confirm(service, rows.map((row) => row.id)), 500)
    assert.equal(service.audits.length, 1)
  })

  test("nothing is confirmed when the selection, access, scale or condition cannot be verified", async () => {
    const revokeDuringRead = (service) =>
      service.tamper("drawing_markups", (result) => {
        service.grant([])
        return result
      }, { on: "select" })
    const cases = [
      { rows: [] },
      { projects: [] },
      { prepare: revokeDuringRead },
      { tables: { drawing_sheet_versions: [] } },
      { version: { extracted_metadata: { calibration: { feet_per_image_px: 0.2 } } } },
      { conditions: [] },
      { conditions: [takeoffCondition({ project_id: MISSING })] },
      { conditions: [takeoffCondition({ uom: "lf" })] },
      { conditions: [takeoffCondition({ height_ft: "bad" })] },
    ]
    for (const { prepare, ...options } of cases) {
      const service = confirming(options)
      prepare?.(service)
      await assert.rejects(confirm(service), undefined, JSON.stringify(options))
      assert.deepEqual(service.writes(), [])
      assert.deepEqual(service.audits, [])
    }
  })

  test("a loaded measurement that is foreign, stale or malformed is not confirmed", async () => {
    const base = carried(0)
    const withReview = (patch) => ({ data: { ...base.data, style: { reanchor: { ...base.data.style.reanchor, ...patch } } } })
    for (const patch of [
      { org_id: FOREIGN_ORG },
      { created_by: MISSING, is_private: true },
      { updated_at: "bad" },
      { quantity: "bad" },
      { quantity: Infinity },
      { uom: "ea" },
      { drawing_sheets: null },
      { drawing_sheets: [base.drawing_sheets, base.drawing_sheets] },
      { drawing_sheets: { ...base.drawing_sheets, org_id: FOREIGN_ORG } },
      { drawing_sheets: { ...base.drawing_sheets, current_revision_id: MISSING } },
      { drawing_sheet_versions: null },
      { drawing_sheet_versions: { ...base.drawing_sheet_versions, id: MISSING } },
      { drawing_sheet_versions: { ...base.drawing_sheet_versions, org_id: FOREIGN_ORG } },
      withReview({ state: "orphaned" }),
      withReview({ to_version_id: MISSING }),
      { data: { ...base.data, type: "text" } },
      { data: { ...base.data, points: [[Infinity, 0], [1, 1]] } },
    ]) {
      const service = confirming()
      service.tamper("drawing_markups", replies.patch(patch), { on: "select", times: 1 })
      await assert.rejects(confirm(service), undefined, JSON.stringify(patch))
      assert.deepEqual(service.writes(), [])
    }
  })

  test("a selection read that is unreadable or stalled confirms nothing", async () => {
    for (const reply of [replies.missing(), replies.error(), replies.rows([carried(0)])]) {
      const service = confirming()
      service.tamper("drawing_markups", reply, { on: "select" })
      await assert.rejects(confirm(service))
      assert.deepEqual(service.writes(), [])
    }
  })

  test("a measurement changed by someone else after it was read keeps its review record", async () => {
    const service = confirming()
    service.tamper("drawing_markups", (result) => {
      service.db.drawing_markups[0].updated_at = "2026-10-04T12:00:01Z"
      return result
    }, { on: "select" })
    await assert.rejects(confirm(service), /changed/)
    assert.ok(service.db.drawing_markups[0].data.style.reanchor)
    assert.deepEqual(service.audits, [])
  })

  test("a saved body that is not what was confirmed is not reported", async () => {
    for (const reply of [
      replies.missing(),
      replies.error("failed"),
      replies.patch({ org_id: FOREIGN_ORG }),
      replies.patch({ quantity: "bad" }),
      replies.patch({ is_private: true }),
      (result) => ({ ...result, data: { ...result.data, data: { ...result.data.data, custom: "changed" } } }),
    ]) {
      const service = confirming()
      service.tamper("drawing_markups", reply, { on: "update" })
      await assert.rejects(confirm(service))
      assert.deepEqual(service.audits, [])
    }
  })

  test("decimal-string quantities and one-element embedded arrays are confirmed", async () => {
    const row = carried(0)
    row.drawing_sheets = [row.drawing_sheets]
    row.drawing_sheet_versions = [row.drawing_sheet_versions]
    const service = confirming({ rows: [row] })
    service.tamper("drawing_markups", replies.patch({ quantity: `${SQUARE_SF}.0000` }), { on: "update" })
    assert.equal(await confirm(service), 1)
  })

  test("geometry on an uncalibrated sheet is confirmed without inventing a quantity", async () => {
    const service = confirming({
      rows: [carried(0, { quantity: null, condition_id: null })],
      version: { image_width: null, image_height: null, extracted_metadata: {} },
    })
    assert.equal(await confirm(service), 1)
    assert.equal(service.db.drawing_markups[0].quantity, null)
  })

  test("a failed write stops before the next batch and nothing is audited", async () => {
    const rows = Array.from({ length: 21 }, (_, n) => carried(n))
    const service = confirming({ rows })
    service.tamper("drawing_markups", (result) =>
      result.data?.id === id(100) ? replies.error("failed first")(result) : result,
    { on: "update" })
    await assert.rejects(confirm(service, rows.map((row) => row.id)), /failed first/)
    assert.equal(service.writes("drawing_markups").length, 20)
    assert.deepEqual(service.audits, [])
  })

  test.todo("a failed confirmation batch leaves all of its rows pending") // owner: takeoff — each batch is 20 separate writes
})

// ============================================================================
// listStaleEstimateAlerts
// ============================================================================

describe("listStaleEstimateAlerts", () => {
  const VERSION = TARGET
  const SYNCED = "2026-10-04T12:00:00Z"

  /** A condition measuring 340 sf on the current revision, priced at a pinned 430 cents. */
  const floor = (n = 0, overrides = {}) => ({
    ...takeoffCondition({ id: id(200 + n), name: "Floor / & walls" }),
    cost_code_id: null,
    color: "#FF0000",
    waste_pct: 0,
    unit_cost_cents: 430,
    share_with_clients: false,
    notes: null,
    sort_order: n,
    created_by: ACTOR,
    created_at: STAMP,
    updated_at: STAMP,
    ...overrides,
  })
  const measured = (conditionId, quantity = 340, n = 0) => ({
    id: id(1000 + n),
    org_id: ORG,
    condition_id: conditionId,
    quantity,
    uom: "sf",
    data: { type: "area", points: SQUARE, style: {} },
    sheet_version_id: VERSION,
    drawing_sheet_id: SHEET,
    is_private: false,
    created_by: ACTOR,
    drawing_sheets: {
      id: SHEET,
      org_id: ORG,
      project_id: PROJECT,
      sheet_number: "A-101",
      sheet_title: null,
      current_revision_id: REVISION,
    },
    drawing_sheet_versions: {
      id: VERSION,
      org_id: ORG,
      drawing_sheet_id: SHEET,
      drawing_revision_id: REVISION,
      drawing_revisions: { id: REVISION, org_id: ORG, project_id: PROJECT },
    },
  })
  const estimate = (estimateId = ESTIMATE, overrides = {}) => ({
    id: estimateId,
    org_id: ORG,
    project_id: PROJECT,
    prospect_id: PROSPECT,
    title: "Original signed estimate",
    status: "executed",
    ...overrides,
  })
  /** A line that last synced `synced` from the condition into `table`. */
  const line = (n, conditionId, { table = "estimate_items", target = ESTIMATE, synced = 100, takeoff = {} } = {}) => {
    const targetColumn = {
      estimate_items: "estimate_id",
      bid_scope_items: "bid_package_id",
      change_order_lines: "change_order_id",
      house_plan_takeoff_lines: "house_plan_version_id",
    }[table]
    return {
      table,
      row: {
        id: id(3000 + n),
        org_id: ORG,
        [targetColumn]: target,
        quantity: synced,
        metadata: { takeoff: { condition_id: conditionId, measured_quantity: synced, synced_at: SYNCED, ...takeoff } },
      },
    }
  }

  function alerting({ conditions = [floor()], members, lines, estimates = [estimate()], project = {}, ...options } = {}) {
    const lineRows = lines ?? [line(0, conditions[0]?.id)]
    const lineTables = {}
    for (const { table, row } of lineRows) (lineTables[table] ??= []).push(row)
    return createServiceHarness({
      permissions: READER,
      ...options,
      tables: {
        projects: [{ id: PROJECT, org_id: ORG, division_id: null, prospect_id: PROSPECT, ...project }],
        takeoff_conditions: conditions,
        drawing_markups: members ?? conditions.map((row, n) => measured(row.id, 340, n)),
        estimates,
        estimate_items: [],
        ...lineTables,
        ...options.tables,
      },
    })
  }
  const alerts = (service, projectId = PROJECT) => service.run(() => listStaleEstimateAlerts(projectId))

  test("an invalid project is refused before anything is read", async () => {
    const service = alerting()
    await assert.rejects(alerts(service, "bad"))
    assert.deepEqual(service.queries, [])
  })

  test("an actor without the project reads no evidence", async () => {
    const service = alerting({ projects: [] })
    await assert.rejects(alerts(service), /Missing permission: takeoff.read/)
    assert.deepEqual(service.reads("projects").length, 1)
    assert.deepEqual(service.reads("takeoff_conditions"), [])
  })

  test("a signed estimate behind the drawings is reported with its money delta and a change-order link", async () => {
    const service = alerting()
    const [alert] = await alerts(service)
    assert.equal(alert.delta_quantity, 240)
    assert.equal(alert.delta_cents, 103200)
    const link = new URL(alert.change_order_href, "https://arc.invalid")
    assert.equal(link.pathname, `/projects/${PROJECT}/change-orders`)
    assert.equal(link.searchParams.get("new"), "1")
    assert.equal(link.searchParams.get("description"), "Floor / & walls: drawings now measure 340 SF (was 100)")
    assert.deepEqual(service.writes(), [])
  })

  test("only a signed estimate raises an alert", async () => {
    for (const status of ["client_signed", "executed", "converted_to_project", "draft", "sent", "approved", "rejected"]) {
      const rows = await alerts(alerting({ estimates: [estimate(ESTIMATE, { status })] }))
      assert.equal(rows.length, ["client_signed", "executed", "converted_to_project"].includes(status) ? 1 : 0, status)
    }
  })

  test("a line in another destination is never mistaken for an estimate line", async () => {
    for (const table of ["bid_scope_items", "change_order_lines", "house_plan_takeoff_lines"]) {
      const service = alerting({ lines: [line(0, id(200), { table })] })
      assert.deepEqual(await alerts(service), [])
      assert.deepEqual(service.reads("estimates"), [])
    }
  })

  test("a detached line, or one the drawings still agree with, raises nothing", async () => {
    assert.deepEqual(await alerts(alerting({ lines: [line(0, id(200), { takeoff: { detached: true } })] })), [])
    assert.deepEqual(await alerts(alerting({ lines: [line(0, id(200), { synced: 340 })] })), [])
  })

  test("a project with no synced conditions, or no conditions, has no alerts", async () => {
    for (const options of [{ lines: [] }, { conditions: [], lines: [] }]) {
      assert.deepEqual(await alerts(alerting(options)), [])
    }
  })

  test("estimates past one read batch are all checked", async () => {
    const conditions = Array.from({ length: 250 }, (_, n) => floor(n))
    const estimates = conditions.map((_, n) => estimate(id(4000 + n)))
    const lines = conditions.map((row, n) => line(n, row.id, { target: estimates[n].id }))
    assert.equal((await alerts(alerting({ conditions, estimates, lines }))).length, 250)
  })

  test("two conditions on one estimate raise two alerts", async () => {
    const conditions = [floor(0), floor(1)]
    const lines = [line(0, conditions[0].id), line(1, conditions[1].id)]
    assert.equal((await alerts(alerting({ conditions, lines }))).length, 2)
  })

  test("an estimate that cannot be read whole, in this org, is an error, not silence", async () => {
    const cases = [
      { estimates: [] },
      { tamper: replies.missing() },
      { tamper: replies.error() },
      { tamper: replies.rows([estimate(ESTIMATE, { org_id: FOREIGN_ORG })]) },
      { tamper: replies.rows([estimate()]) },
    ]
    for (const { tamper, ...options } of cases) {
      const service = alerting(options)
      if (tamper) service.tamper("estimates", tamper)
      await assert.rejects(alerts(service))
    }
  })

  test("an estimate that belongs elsewhere or is malformed is refused", async () => {
    for (const patch of [
      { id: MISSING },
      { project_id: MISSING },
      { project_id: null, prospect_id: MISSING },
      { title: null },
      { status: null },
      { status: "" },
      { prospect_id: "bad" },
    ]) {
      const service = alerting()
      service.tamper("estimates", replies.patch(patch), { times: 1 })
      await assert.rejects(alerts(service), undefined, JSON.stringify(patch))
    }
  })

  test("a deal's estimate without a project still raises its alert", async () => {
    assert.equal((await alerts(alerting({ estimates: [estimate(ESTIMATE, { project_id: null })] }))).length, 1)
  })

  test("a project that cannot be verified, or changes while alerts are built, is refused", async () => {
    const aimedAtProject = (reply) => (result, query) => (query.where.id === PROJECT ? reply(result) : result)
    const cases = [
      ["projects", aimedAtProject(replies.patch({ org_id: FOREIGN_ORG }))],
      ["projects", aimedAtProject(replies.patch({ id: MISSING }))],
      ["projects", aimedAtProject(replies.patch({ prospect_id: "bad" }))],
      ["takeoff_conditions", replies.error("Rollup unavailable")],
    ]
    for (const tamper of cases) {
      const service = alerting()
      service.tamper(...tamper)
      await assert.rejects(alerts(service))
    }

    const moved = alerting()
    moved.tamper("estimates", (result) => {
      moved.db.projects[0].prospect_id = MISSING
      return result
    })
    await assert.rejects(alerts(moved), /project changed/)
  })

  test("access revoked while alerts are built returns nothing", async () => {
    const service = alerting()
    service.tamper("estimates", (result) => {
      service.grant([])
      return result
    })
    await assert.rejects(alerts(service), /Missing permission/)
  })

  test("a smaller measurement is a negative delta, and an unpriced condition has no money delta", async () => {
    for (const rate of [null, 0, 430]) {
      const conditions = [floor(0, { unit_cost_cents: rate })]
      const [alert] = await alerts(alerting({ conditions, members: [measured(id(200), 90)] }))
      assert.equal(alert.delta_quantity, -10)
      assert.equal(alert.delta_cents, rate === null ? null : rate === 0 ? 0 : -4300)
    }
  })

  test("a newer sync to another destination does not hide an older signed estimate", async () => {
    for (const table of ["bid_scope_items", "change_order_lines", "house_plan_takeoff_lines"]) {
      const lines = [
        line(0, id(200)),
        line(1, id(200), { table, target: id(20), synced: 340, takeoff: { synced_at: "2026-10-04T13:00:00Z" } }),
      ]
      const [alert, ...rest] = await alerts(alerting({ lines }))
      assert.deepEqual(rest, [])
      assert.equal(alert.estimate_id, ESTIMATE)
      assert.equal(alert.estimate_line_id, id(3000))
      assert.equal(alert.delta_quantity, 240)
    }
  })

  test("each signed estimate carrying a condition keeps its own delta, even under a newer draft", async () => {
    const lines = [
      line(0, id(200)),
      line(1, id(200), { target: id(30), synced: 200, takeoff: { synced_at: "2026-10-04T13:00:00Z" } }),
      line(2, id(200), { target: id(32), synced: 340, takeoff: { synced_at: "2026-10-04T14:00:00Z" } }),
    ]
    const estimates = [estimate(), estimate(id(30)), estimate(id(32), { status: "draft" })]
    const rows = await alerts(alerting({ lines, estimates }))
    assert.deepEqual(
      rows.map((row) => [row.estimate_id, row.estimate_line_id, row.delta_quantity]),
      [[ESTIMATE, id(3000), 240], [id(30), id(3001), 140]],
    )
  })

  test("a detached older line stays silent while another signed estimate is still warned", async () => {
    const lines = [line(0, id(200), { takeoff: { detached: true } }), line(1, id(200), { target: id(30) })]
    const rows = await alerts(alerting({ lines, estimates: [estimate(), estimate(id(30))] }))
    assert.deepEqual(rows.map((row) => row.estimate_id), [id(30)])
  })

  test("an undated legacy signed line is still warned", async () => {
    const rows = await alerts(alerting({ lines: [line(0, id(200), { takeoff: { synced_at: null } })] }))
    assert.deepEqual(rows.map((row) => row.estimate_line_id), [id(3000)])
  })

  test("an older signed estimate that cannot be found is an error, even under a newer bid", async () => {
    const lines = [
      line(0, id(200)),
      line(1, id(200), { table: "bid_scope_items", target: id(20), takeoff: { synced_at: "2026-10-04T13:00:00Z" } }),
    ]
    await assert.rejects(alerts(alerting({ lines, estimates: [] })), /targets unavailable/)
  })
})
