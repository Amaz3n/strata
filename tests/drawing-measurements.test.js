const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, replies, id, ORG, ACTOR } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { computeMarkupQuantity } = require("@/lib/drawings/measure")
const {
  assertConditionAcceptsUom,
  loadMeasurementContext,
  measureMarkup,
  recomputeMarkupQuantitiesForVersion,
} = freshRequire("lib/services/drawing-measurements.ts")

const FOREIGN_ORG = id(1)
const PROJECT = id(2)
const SHEET = id(3)
const VERSION = id(4)
const REVISION = id(5)
const CONDITION = id(6)
const OTHER_CONDITION = id(7)
const MISSING = id(99)

const STAMP = "2026-10-04T12:00:00.123456+00:00"
const LATER = "2026-10-04T13:00:00.654321+00:00"

const AREA = { type: "area", points: [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5], [0.1, 0.5]], color: "#FF0000", strokeWidth: 2 }
/** AREA on a 400 px sheet at 0.1 ft/px. */
const AREA_SF = computeMarkupQuantity(AREA, { width: 400, height: 400 }, 0.1).quantity

const sheetHome = { id: SHEET, org_id: ORG, project_id: PROJECT }
const revisionHome = { id: REVISION, org_id: ORG, project_id: PROJECT }

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
  drawing_sheets: sheetHome,
  drawing_revisions: revisionHome,
  ...overrides,
})

const condition = (overrides = {}) => ({
  id: CONDITION,
  org_id: ORG,
  name: "Wall",
  uom: "sf",
  depth_in: null,
  height_ft: null,
  pitch_rise: null,
  tons_per_cy: null,
  ...overrides,
})

/** A stored area on VERSION, saved at a stale quantity of 1 sf. */
const stored = (n, overrides = {}) => ({
  id: id(100 + n),
  org_id: ORG,
  sheet_version_id: VERSION,
  drawing_sheet_id: SHEET,
  created_by: ACTOR,
  condition_id: null,
  updated_at: STAMP,
  data: AREA,
  quantity: 1,
  uom: "sf",
  ...overrides,
})

function harness({ versions = [version()], markups = [], conditions = [condition()], ...options } = {}) {
  return createServiceHarness({
    ...options,
    tables: { drawing_sheet_versions: versions, drawing_markups: markups, takeoff_conditions: conditions },
  })
}

// ============================================================================
// loadMeasurementContext and measureMarkup
// ============================================================================

describe("loadMeasurementContext", () => {
  const load = (service, { orgId = ORG, versionId = VERSION, sheetId } = {}) =>
    loadMeasurementContext(service.client, orgId, versionId, sheetId)
  /** The stored version, answered with `patch` — Infinity and NaN cannot be seeded. */
  const answering = (patch) => {
    const service = harness()
    service.tamper("drawing_sheet_versions", replies.patch(patch))
    return service
  }

  test("an invalid org, version or expected sheet is refused before anything is read", async () => {
    for (const args of [{ orgId: "bad" }, { versionId: "bad" }, { sheetId: "bad" }]) {
      const service = harness()
      await assert.rejects(load(service, args))
      assert.deepEqual(service.queries, [])
    }
  })

  test("a source that is missing, foreign or mismatched is an error, not 'awaiting scale'", async () => {
    const cases = [
      replies.error(),
      replies.missing(),
      replies.patch({ id: MISSING }),
      replies.patch({ org_id: FOREIGN_ORG }),
      replies.patch({ drawing_sheet_id: MISSING }),
      replies.patch({ drawing_revision_id: MISSING }),
      replies.patch({ drawing_sheets: null }),
      replies.patch({ drawing_sheets: [] }),
      replies.patch({ drawing_sheets: [sheetHome, sheetHome] }),
      replies.patch({ drawing_sheets: { ...sheetHome, org_id: FOREIGN_ORG } }),
      replies.patch({ drawing_revisions: null }),
      replies.patch({ drawing_revisions: [] }),
      replies.patch({ drawing_revisions: [revisionHome, revisionHome] }),
      replies.patch({ drawing_revisions: { ...revisionHome, org_id: FOREIGN_ORG } }),
      replies.patch({ drawing_revisions: { ...revisionHome, project_id: MISSING } }),
    ]
    for (const reply of cases) {
      const service = harness()
      service.tamper("drawing_sheet_versions", reply)
      await assert.rejects(load(service))
    }
    await assert.rejects(load(harness({ versions: [] })))
  })

  test("a malformed stored scale never becomes a usable context", async () => {
    for (const calibration of [
      {},
      { feet_per_image_px: Infinity },
      { feet_per_image_px: NaN },
      { feet_per_image_px: 0 },
      { feet_per_image_px: -0.1 },
      { feet_per_image_px: "0.1" },
      { feet_per_image_px: 0.1, method: "bad" },
      { feet_per_image_px: 0.1, carried_from_version_id: "bad" },
    ]) {
      await assert.rejects(load(answering({ extracted_metadata: { calibration } })), undefined, JSON.stringify(calibration))
    }
  })

  test("malformed dimensions or metadata are refused rather than coerced to numbers", async () => {
    for (const patch of [
      { image_width: Infinity },
      { image_width: -1 },
      { image_height: "400" },
      { image_height: undefined },
      { tile_manifest: undefined },
      { tile_manifest: { Image: { Size: { Width: false } } } },
      { tile_manifest: { Image: { Size: { Width: "bad" } } } },
      { tile_manifest: { Image: { Size: { Width: Infinity } } } },
      { extracted_metadata: undefined },
      { extracted_metadata: [] },
      { extracted_metadata: false },
    ]) {
      await assert.rejects(load(answering(patch)), undefined, JSON.stringify(patch))
    }
  })

  test("a calibrated source measures geometry in its reporting unit", async () => {
    const service = harness()
    const context = await load(service)
    assert.deepEqual(context, { imageSize: { width: 400, height: 400 }, feetPerImagePx: 0.1 })
    assert.deepEqual(measureMarkup(AREA, context), { quantity: 256, uom: "sf" })
    assert.deepEqual(service.writes(), [])
  })

  test("an uncalibrated legacy source keeps the unit but has no quantity yet", async () => {
    for (const extracted_metadata of [null, {}, { calibration: null }]) {
      const context = await load(harness({ versions: [version({ extracted_metadata })] }))
      assert.equal(context.feetPerImagePx, null)
      assert.deepEqual(measureMarkup(AREA, context), { quantity: null, uom: "sf" })
    }
  })

  test("a version that was never rendered has no image size, without hiding its scale", async () => {
    for (const patch of [
      { image_width: null, image_height: null },
      { image_width: 0 },
      { tile_manifest: { Image: { Size: { Width: "0", Height: "400" } } } },
    ]) {
      const context = await load(harness({ versions: [version(patch)] }))
      assert.equal(context.imageSize, null)
      assert.equal(context.feetPerImagePx, 0.1)
    }
  })

  test("manifest dimensions win, and one-element embedded rows are accepted", async () => {
    const context = await load(harness({
      versions: [version({
        tile_manifest: { Image: { Size: { Width: "800", Height: "600" } } },
        drawing_sheets: [sheetHome],
        drawing_revisions: [revisionHome],
      })],
    }))
    assert.deepEqual(context, { imageSize: { width: 800, height: 600 }, feetPerImagePx: 0.1 })
  })

  test("a draft revision measures without waiting to be published", async () => {
    const draft = version({
      drawing_revisions: { ...revisionHome, status: "draft" },
      drawing_sheets: { ...sheetHome, current_revision_id: id(90) },
    })
    assert.equal((await load(harness({ versions: [draft] }))).feetPerImagePx, 0.1)
  })

  test("a version from a different sheet than expected is refused", async () => {
    const service = harness()
    await assert.rejects(load(service, { sheetId: MISSING }), /source scope unavailable/)
    assert.deepEqual(service.writes(), [])
  })
})

// ============================================================================
// assertConditionAcceptsUom
// ============================================================================

describe("assertConditionAcceptsUom", () => {
  const check = (service, uom) => assertConditionAcceptsUom(service.client, ORG, CONDITION, uom)

  test("the condition must be read, and be this org's", async () => {
    const cases = [
      { conditions: [] },
      { tamper: replies.error() },
      { tamper: replies.missing() },
      { tamper: replies.patch({ id: OTHER_CONDITION }) },
      { tamper: replies.patch({ org_id: FOREIGN_ORG }) },
    ]
    for (const { tamper, ...options } of cases) {
      const service = harness(options)
      if (tamper) service.tamper("takeoff_conditions", tamper)
      await assert.rejects(check(service, "sf"))
    }
  })

  test("a stored unit or factor that is invalid never passes as compatible", async () => {
    for (const patch of [
      { uom: null },
      { uom: "invalid" },
      { height_ft: "bad" },
      { height_ft: "" },
      { height_ft: true },
      { height_ft: 0 },
      { height_ft: -9 },
      { height_ft: Infinity },
      { height_ft: NaN },
      { height_ft: "0x10" },
      { height_ft: undefined },
      { height_ft: "1e400" },
      { depth_in: 6 },
      { pitch_rise: 4, height_ft: 9 },
      { uom: "cy", depth_in: null },
      { uom: "ton", depth_in: 6, tons_per_cy: null },
    ]) {
      const service = harness()
      service.tamper("takeoff_conditions", replies.patch(patch))
      await assert.rejects(check(service, "sf"), undefined, JSON.stringify(patch))
    }
  })

  test("decimal and scientific stored factors convert the source unit as they should", async () => {
    await check(harness({ conditions: [condition({ height_ft: " 9.5 " })] }), "lf")
    await check(harness({ conditions: [condition({ uom: "cy", depth_in: "6e0" })] }), "sf")
    await check(harness({ conditions: [condition({ uom: "ton", depth_in: 6, tons_per_cy: "1.25" })] }), "sf")
    await check(harness({ conditions: [condition({ height_ft: 300 })] }), "lf")
  })

  test("an annotation cannot belong to a condition", async () => {
    await assert.rejects(check(harness(), null), /Only measurements/)
  })
})

// ============================================================================
// recomputeMarkupQuantitiesForVersion
// ============================================================================

describe("recomputeMarkupQuantitiesForVersion", () => {
  const recompute = (service) => recomputeMarkupQuantitiesForVersion(service.client, ORG, VERSION)
  const recomputing = (markups = [stored(0)], options = {}) => harness({ markups, ...options })

  test("a measurement read that is unreadable, foreign or stalled re-measures nothing", async () => {
    for (const reply of [
      replies.missing(),
      replies.error(),
      replies.rows([stored(0, { org_id: FOREIGN_ORG })]),
      replies.rows([stored(0, { sheet_version_id: MISSING })]),
      replies.rows([stored(0), stored(0)]),
    ]) {
      const service = recomputing()
      service.tamper("drawing_markups", reply, { on: "select" })
      await assert.rejects(recompute(service))
      assert.deepEqual(service.writes(), [])
    }
  })

  test("a version with no measurements re-measures nothing", async () => {
    const service = recomputing([])
    assert.equal(await recompute(service), 0)
    assert.deepEqual(service.writes(), [])
  })

  test("every measurement is re-measured, however short the database's pages are", async () => {
    const service = recomputing(Array.from({ length: 1500 }, (_, n) => stored(n)), { maxRows: 37 })
    assert.equal(await recompute(service), 1500)
    assert.ok(service.db.drawing_markups.every((row) => row.quantity === AREA_SF))
  })

  test("one invalid measurement anywhere in the set stops every write", async () => {
    const lastIsBroken = Array.from({ length: 1500 }, (_, n) => stored(n, n === 1499 ? { uom: "bad" } : {}))
    const late = recomputing(lastIsBroken, { maxRows: 37 })
    await assert.rejects(recompute(late))
    assert.deepEqual(late.writes(), [])

    for (const patch of [
      { updated_at: null },
      { updated_at: "bad" },
      { data: { type: "area", points: "bad" } },
      { quantity: "bad" },
      { quantity: true },
      { quantity: "" },
      { quantity: "0x10" },
      { uom: "bad" },
      { condition_id: undefined },
    ]) {
      const service = recomputing([stored(0), stored(1)])
      const breakSecond = (result) => ({
        ...result,
        data: result.data.map((row, n) => (n === 1 ? { ...row, ...patch } : row)),
      })
      service.tamper("drawing_markups", breakSecond, { on: "select", times: 1 })
      await assert.rejects(recompute(service), undefined, JSON.stringify(patch))
      assert.deepEqual(service.writes(), [])
    }
  })

  test("a measurement already at the right quantity, even as a decimal string, is not rewritten", async () => {
    const service = recomputing([stored(0, { quantity: String(AREA_SF) })])
    assert.equal(await recompute(service), 0)
    assert.deepEqual(service.writes(), [])
  })

  test("a deduction stays negative, and an uncalibrated measurement keeps its unit with no quantity", async () => {
    const deduction = recomputing([stored(0, { data: { ...AREA, style: { deduction: true } }, quantity: "-1" })])
    assert.equal(await recompute(deduction), 1)
    assert.equal(deduction.db.drawing_markups[0].quantity, -AREA_SF)

    const uncalibrated = recomputing([stored(0)], { versions: [version({ extracted_metadata: {} })] })
    assert.equal(await recompute(uncalibrated), 1)
    assert.equal(uncalibrated.db.drawing_markups[0].quantity, null)
    assert.equal(uncalibrated.db.drawing_markups[0].uom, "sf")
  })

  test("a member whose condition cannot take its unit stops every write, even if its own quantity is right", async () => {
    for (const patch of [{ height_ft: 9 }, { uom: "invalid" }, { uom: "cy", depth_in: null }]) {
      const service = recomputing([stored(0), stored(1, { condition_id: CONDITION })], { conditions: [condition(patch)] })
      await assert.rejects(recompute(service))
      assert.deepEqual(service.writes(), [])
    }
    const current = recomputing(
      [stored(0, { condition_id: CONDITION, quantity: AREA_SF })],
      { conditions: [condition({ height_ft: 9 })] },
    )
    await assert.rejects(recompute(current))
    assert.deepEqual(current.writes(), [])
  })

  test("members sharing a condition are all re-measured", async () => {
    const service = recomputing(Array.from({ length: 40 }, (_, n) => stored(n, { condition_id: CONDITION })))
    assert.equal(await recompute(service), 40)
  })

  test("a measurement changed by someone else after it was read keeps their quantity", async () => {
    for (const race of ["change", "remove"]) {
      const service = recomputing()
      service.tamper("drawing_markups", (result) => {
        if (race === "remove") service.db.drawing_markups.splice(0)
        else service.db.drawing_markups[0].updated_at = LATER
        return result
      }, { on: "select" })
      await assert.rejects(recompute(service), /changed during recalibration/)
      if (race === "change") assert.equal(service.db.drawing_markups[0].quantity, 1)
    }
  })

  test("a saved measurement that is not what was written is not counted", async () => {
    for (const patch of [
      { id: MISSING },
      { org_id: FOREIGN_ORG },
      { sheet_version_id: MISSING },
      { drawing_sheet_id: MISSING },
      { created_by: MISSING },
      { condition_id: CONDITION },
      { quantity: 1 },
      { uom: "lf" },
      { updated_at: "bad" },
      { data: { ...AREA, points: [[0, 0], [1, 1]] } },
    ]) {
      const service = recomputing()
      service.tamper("drawing_markups", replies.patch(patch), { on: "update" })
      await assert.rejects(recompute(service), undefined, JSON.stringify(patch))
    }
    for (const reply of [replies.missing(), replies.error("Update unavailable")]) {
      const service = recomputing()
      service.tamper("drawing_markups", reply, { on: "update" })
      await assert.rejects(recompute(service))
    }
  })

  test("geometry saved back with its keys in another order is the same geometry", async () => {
    const service = recomputing()
    const reordered = { strokeWidth: 2, color: "#FF0000", points: AREA.points, type: "area" }
    service.tamper("drawing_markups", replies.patch({ data: reordered }), { on: "update" })
    assert.equal(await recompute(service), 1)
  })

  test("a failed write batch stops before the next batch starts", async () => {
    const service = recomputing(Array.from({ length: 45 }, (_, n) => stored(n)))
    service.tamper("drawing_markups", replies.error("Update unavailable"), { on: "update" })
    await assert.rejects(recompute(service), /Update unavailable/)
    assert.equal(service.writes("drawing_markups").length, 20)
  })

  test("an invalid source version re-measures nothing and reads no measurements", async () => {
    const cases = [
      { versions: [] },
      { tamper: replies.error() },
      { tamper: replies.patch({ extracted_metadata: { calibration: { feet_per_image_px: Infinity } } }) },
      { tamper: replies.patch({ drawing_revisions: { ...revisionHome, project_id: MISSING } }) },
    ]
    for (const { tamper, ...options } of cases) {
      const service = recomputing([stored(0)], options)
      if (tamper) service.tamper("drawing_sheet_versions", tamper)
      await assert.rejects(recompute(service))
      assert.deepEqual(service.reads("drawing_markups"), [])
      assert.deepEqual(service.writes(), [])
    }
  })
})
