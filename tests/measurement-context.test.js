const assert = require("node:assert/strict")
const { beforeEach, describe, test } = require("node:test")

const { createServiceHarness, replies, id, ORG } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

const PROSPECT = id(1)
const PROJECT = id(2)
const ROW = id(3)
const ESTIMATE = id(4)

// The deal's pricing worksheet lives in the precon services (their own suites);
// this is that store. Takeoff conditions are the real service against the fake.
const deal = { worksheet: null, version: 1, saves: [] }
stubModule("lib/services/precon-workspace.ts", {
  authorizePreconWorkspaceWrite: async () => ({}),
  getPreconWorkspace: async () => ({ pricing: structuredClone(deal.worksheet), version: deal.version }),
})
stubModule("lib/services/precon-pricing.ts", {
  async savePricingWorksheet(prospectId, worksheet, expectedVersion) {
    if (expectedVersion !== deal.version) throw new Error("The worksheet changed")
    deal.saves.push(prospectId)
    deal.worksheet = structuredClone(worksheet)
    deal.version += 1
  },
})
stubModule("lib/services/conversions.ts", { startProspectPricing: async () => ({ projectId: PROJECT }) })
stubModule("lib/services/takeoff-destinations.ts", {
  listSyncTargets: async () => [
    { destination: "pricing_worksheet", id: PROSPECT, label: "Working estimate", writable: true },
    { destination: "estimate", id: ESTIMATE, label: "Estimate", writable: true },
  ],
})

const { beginWorksheetMeasurement, resolveMeasurementContext } = freshRequire("lib/services/measurement-context.ts")
const { measurementUnit } = require("../lib/drawings/measurement-context")

function harness(permissions = ["project.read", "takeoff.read", "takeoff.write"]) {
  const service = createServiceHarness({
    permissions,
    tables: { projects: [{ id: PROJECT, org_id: ORG }], takeoff_conditions: [] },
  })
  // The column defaults Postgres fills on insert.
  const NOW = "2026-10-06T12:00:00+00:00"
  service.tamper(
    "takeoff_conditions",
    (result) => {
      for (const row of service.db.takeoff_conditions) Object.assign(row, { created_at: NOW, updated_at: NOW, ...row })
      return replies.patch({ created_at: NOW, updated_at: NOW })(result)
    },
    { on: "insert" },
  )
  return service
}

beforeEach(() => {
  deal.worksheet = {
    rows: [{ id: ROW, description: "Flooring", unit: "sf", quantity: 200, unit_cost_cents: 450, metadata: {}, cost_code_id: null }],
    requests: [],
  }
  deal.version = 1
  deal.saves = []
})

describe("measuring a worksheet row", () => {
  test("the first measurement links one takeoff item to the row; a retry reuses it", async () => {
    const service = harness()

    const first = await service.run(() => beginWorksheetMeasurement(PROSPECT, ROW, "SF"))
    const second = await service.run(() => beginWorksheetMeasurement(PROSPECT, ROW, "SF"))

    const [condition] = service.db.takeoff_conditions
    assert.equal(service.db.takeoff_conditions.length, 1)
    assert.equal(condition.name, "Flooring")
    assert.equal(condition.uom, "sf")
    assert.deepEqual(first, { projectId: PROJECT, conditionId: condition.id, sheetId: null, saved: true }, "nothing measured yet, so no sheet to land on")
    assert.deepEqual(second, { ...first, saved: false }, "a linked line opens without saving again")
    const [row] = deal.worksheet.rows
    assert.deepEqual(row.metadata.takeoff_source, { condition_id: condition.id, uom: "sf" })
    assert.equal(row.quantity, 200, "linking never changes the quantity")
    assert.equal(row.unit_cost_cents, 450, "or the money")
    assert.equal(deal.saves.length, 1)
  })

  test("without takeoff.write, or for a removed row, nothing is created", async () => {
    const denied = harness(["project.read", "takeoff.read"])
    await assert.rejects(denied.run(() => beginWorksheetMeasurement(PROSPECT, ROW, "sf")))
    assert.deepEqual(denied.db.takeoff_conditions, [])

    const removed = harness()
    await assert.rejects(removed.run(() => beginWorksheetMeasurement(PROSPECT, id(404), "sf")), /Save this line/)
    assert.deepEqual(removed.db.takeoff_conditions, [])
    assert.deepEqual(deal.saves, [])
  })

  test("a lump-sum row cannot be measured", async () => {
    deal.worksheet.rows[0].unit = "ls"
    const service = harness()
    await assert.rejects(service.run(() => beginWorksheetMeasurement(PROSPECT, ROW, "LS")), /Choose an area/)
    assert.deepEqual(service.db.takeoff_conditions, [])
  })
})

describe("resolving where a measurement returns", () => {
  test("a target that is not one of these plans' destinations is refused", async () => {
    await assert.rejects(resolveMeasurementContext(PROJECT, { destination: "pricing_worksheet", target: id(404) }), /does not belong/)
  })

  test("a deal's worksheet returns to the deal, an estimate to the estimate", async () => {
    const deal = await resolveMeasurementContext(PROJECT, { destination: "pricing_worksheet", target: PROSPECT })
    assert.equal(deal.returnHref, `/pipeline/${PROSPECT}`)
    const estimate = await resolveMeasurementContext(PROJECT, { destination: "estimate", target: ESTIMATE })
    assert.equal(estimate.returnHref, `/estimates?estimate=${ESTIMATE}`)
  })
})

test("unit aliases normalize, and a lump sum is not a measurable unit", () => {
  for (const [unit, expected] of [["Sq. Ft.", "sf"], ["LF", "lf"], ["ea", "ea"], ["LS", null]]) {
    assert.equal(measurementUnit(unit), expected, unit)
  }
})
