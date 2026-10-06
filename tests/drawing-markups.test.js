const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, replies, id, ORG, ACTOR } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { createDrawingMarkup, updateDrawingMarkup } = freshRequire("lib/services/drawing-markups.ts")

const FOREIGN_ORG = id(1)
const PROJECT = id(2)
const SHEET = id(3)
const VERSION = id(4)
const REVISION = id(5)
const MARKUP = id(6)
const CONDITION = id(7)
const LINEAR_CONDITION = id(8)
const OTHER_USER = id(9)
const MISSING = id(99)

const STAMP = "2026-10-04T12:00:00.123456+00:00"
const style = { color: "#FF0000", strokeWidth: 2 }
const AREA = { type: "area", points: [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5], [0.1, 0.5]], ...style }
const LINE = { type: "polyline", points: [[0.1, 0.1], [0.5, 0.5]], ...style }
const COUNT = { type: "count", points: [[0.2, 0.2]], ...style }
const NOTE = { type: "rectangle", points: [[0.1, 0.1], [0.5, 0.5]], ...style }
/** AREA on a 400 px sheet at 0.1 ft/px. */
const AREA_SF = 256

/** VERSION of SHEET: a 400 px render calibrated at 0.1 ft/px. */
const version = (overrides = {}) => ({
  id: VERSION,
  org_id: ORG,
  drawing_sheet_id: SHEET,
  drawing_revision_id: REVISION,
  image_width: 400,
  image_height: 400,
  tile_manifest: null,
  extracted_metadata: { calibration: { feet_per_image_px: 0.1 } },
  drawing_sheets: { id: SHEET, org_id: ORG, project_id: PROJECT },
  drawing_revisions: { id: REVISION, org_id: ORG, project_id: PROJECT },
  ...overrides,
})

const condition = (conditionId, uom) => ({
  id: conditionId,
  org_id: ORG,
  name: "Wall",
  uom,
  depth_in: null,
  height_ft: null,
  pitch_rise: null,
  tons_per_cy: null,
})

/** The actor's area on VERSION, assigned to CONDITION and stored at 100 sf. */
const markup = (overrides = {}) => ({
  id: MARKUP,
  org_id: ORG,
  drawing_sheet_id: SHEET,
  sheet_version_id: VERSION,
  data: AREA,
  label: null,
  condition_id: CONDITION,
  created_by: ACTOR,
  is_private: false,
  share_with_clients: false,
  share_with_subs: false,
  quantity: 100,
  uom: "sf",
  created_at: STAMP,
  updated_at: STAMP,
  ...overrides,
})

function harness({ markups = [markup()], conditions, permissions = ["drawing.markup"], ...options } = {}) {
  return createServiceHarness({
    permissions,
    ...options,
    tables: {
      drawing_sheet_versions: [version()],
      drawing_markups: markups,
      takeoff_conditions: conditions ?? [condition(CONDITION, "sf"), condition(LINEAR_CONDITION, "lf")],
      ...options.tables,
    },
  })
}

/** Ways the version's scale can be unusable. */
const brokenSources = [
  { tables: { drawing_sheet_versions: [] } },
  { tamper: replies.error() },
  { tamper: replies.patch({ extracted_metadata: { calibration: { feet_per_image_px: Infinity } } }) },
  { tamper: replies.patch({ drawing_revisions: { id: REVISION, org_id: ORG, project_id: MISSING } }) },
]

function assertNothingWritten(service) {
  assert.deepEqual(service.writes(), [])
  assert.deepEqual(service.audits, [])
  assert.deepEqual(service.events, [])
}

// ============================================================================
// createDrawingMarkup
// ============================================================================

describe("createDrawingMarkup", () => {
  const create = (service, input = {}) =>
    service.run(() => createDrawingMarkup({ drawing_sheet_id: SHEET, sheet_version_id: VERSION, data: AREA, ...input }))

  test("a measurement takes its quantity from the server's own measure of the geometry", async () => {
    const service = harness({ markups: [] })
    const created = await create(service)
    assert.equal(created.quantity, AREA_SF)
    assert.equal(created.uom, "sf")
    assert.equal(service.audits.length, 1)
    assert.equal(service.events.length, 1)
  })

  test("a deduction area measures negative", async () => {
    const created = await create(harness({ markups: [] }), { data: { ...AREA, style: { deduction: true } } })
    assert.equal(created.quantity, -AREA_SF)
  })

  test("an unusable scale creates nothing", async () => {
    for (const { tamper, ...options } of brokenSources) {
      const service = harness({ markups: [], ...options })
      if (tamper) service.tamper("drawing_sheet_versions", tamper)
      await assert.rejects(create(service))
      assertNothingWritten(service)
    }
  })

  test("a quantity cannot be measured against another sheet's version", async () => {
    const service = harness({ markups: [] })
    await assert.rejects(create(service, { drawing_sheet_id: MISSING }), /source scope unavailable/)
    assertNothingWritten(service)
  })
})

// ============================================================================
// updateDrawingMarkup
// ============================================================================

describe("updateDrawingMarkup", () => {
  const update = (service, changes) => service.run(() => updateDrawingMarkup(MARKUP, changes))

  test("a geometry edit is re-measured against the sheet's scale and keeps its condition", async () => {
    const service = harness()
    const saved = await update(service, { data: AREA })
    assert.equal(saved.quantity, AREA_SF)
    assert.equal(saved.uom, "sf")
    assert.equal(saved.condition_id, CONDITION)
    assert.equal(service.audits[0].actorId, ACTOR)
  })

  test("a geometry edit on an uncalibrated sheet keeps its unit and waits for a scale", async () => {
    const service = harness({ tables: { drawing_sheet_versions: [version({ extracted_metadata: {} })] } })
    const saved = await update(service, { data: AREA })
    assert.equal(saved.uom, "sf")
    assert.equal(saved.quantity, null)
    assert.equal(saved.condition_id, CONDITION)
  })

  test("a geometry edit that no longer fits the measurement's condition is refused", async () => {
    for (const data of [LINE, COUNT, NOTE]) {
      const service = harness()
      await assert.rejects(update(service, { data }))
      assertNothingWritten(service)
      assert.equal(service.db.drawing_markups[0].uom, "sf")
    }
  })

  test("a new condition is checked against the new geometry", async () => {
    const service = harness()
    const saved = await update(service, { data: LINE, condition_id: LINEAR_CONDITION })
    assert.equal(saved.uom, "lf")
    assert.equal(saved.condition_id, LINEAR_CONDITION)
  })

  test("a new condition alone is checked against the existing geometry", async () => {
    const service = harness()
    await assert.rejects(update(service, { condition_id: LINEAR_CONDITION }), /measures in LF/)
    assertNothingWritten(service)
  })

  test("removing the condition lets the geometry change unit without reading any condition", async () => {
    const service = harness({ conditions: [] })
    const saved = await update(service, { data: LINE, condition_id: null })
    assert.equal(saved.uom, "lf")
    assert.equal(saved.condition_id, null)
    assert.deepEqual(service.reads("takeoff_conditions"), [])
  })

  test("a condition whose stored unit or factor is invalid takes no geometry edit", async () => {
    for (const patch of [{ uom: null }, { uom: "invalid" }, { height_ft: "bad" }]) {
      const service = harness({ conditions: [{ ...condition(CONDITION, "sf"), ...patch }] })
      await assert.rejects(update(service, { data: AREA }))
      assertNothingWritten(service)
    }
  })

  test("an unusable scale stops a geometry edit before anything is written", async () => {
    for (const { tamper, ...options } of brokenSources) {
      const service = harness(options)
      if (tamper) service.tamper("drawing_sheet_versions", tamper)
      await assert.rejects(update(service, { data: AREA }))
      assertNothingWritten(service)
    }
  })

  test("a label, sharing or unassignment repair works even when the scale is unusable", async () => {
    for (const changes of [{ label: "Reviewed original label" }, { share_with_clients: true }, { condition_id: null }]) {
      const service = harness()
      service.tamper("drawing_sheet_versions", replies.error())
      const saved = await update(service, changes)
      assert.equal(saved.quantity, 100)
      assert.equal(saved.uom, "sf")
      assert.deepEqual(service.reads("drawing_sheet_versions"), [])
      assert.deepEqual(service.reads("takeoff_conditions"), [])
      assert.equal(service.writes("drawing_markups").length, 1)
    }
  })

  test("a measurement whose stored sheet does not match its version is not re-measured", async () => {
    const service = harness({ markups: [markup({ drawing_sheet_id: MISSING })] })
    await assert.rejects(update(service, { data: AREA }), /source scope unavailable/)
    assertNothingWritten(service)
    assert.equal(service.db.drawing_markups[0].quantity, 100)
  })

  test("only the creator edits, a private markup is invisible to others, and nothing is read first", async () => {
    const cases = [
      { permissions: [] },
      { markups: [markup({ is_private: true, created_by: OTHER_USER })] },
      { markups: [markup({ created_by: OTHER_USER })] },
      { markups: [markup({ created_by: null })] },
    ]
    for (const options of cases) {
      const service = harness(options)
      await assert.rejects(update(service, { data: LINE }), undefined, JSON.stringify(options))
      assertNothingWritten(service)
      assert.deepEqual(service.reads("drawing_sheet_versions"), [])
      assert.deepEqual(service.reads("takeoff_conditions"), [])
    }
  })

  test("a markup with no recorded creator can be maintained by a drawing manager", async () => {
    const service = harness({ permissions: ["drawing.markup", "drawing.upload"], markups: [markup({ created_by: null })] })
    assert.equal((await update(service, { data: AREA })).condition_id, CONDITION)
  })

  test("a markup in another org is not found", async () => {
    const service = harness({ markups: [markup({ org_id: FOREIGN_ORG })] })
    await assert.rejects(update(service, { label: "Repair" }), /not found/)
    assertNothingWritten(service)
  })
})
