const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { getCashFlowForecast } = freshRequire("lib/services/reports/cash-flow-forecast.ts")

const OWN_DIVISION = id(10)
const OTHER_DIVISION = id(11)

const project = (n, divisionId) => ({
  id: id(20 + n),
  org_id: ORG,
  name: `Lot ${n}`,
  division_id: divisionId,
  community_id: null,
  phase: "delivery",
  status: "active",
  start_date: "2026-01-01",
  end_date: "2026-12-31",
})

const invoice = (n, projectId, cents) => ({
  id: id(100 + n),
  org_id: ORG,
  project_id: projectId,
  due_date: "2026-11-15",
  balance_due_cents: cents,
  total_cents: cents,
  status: "sent",
})

function forecastHarness(options) {
  return createServiceHarness({
    tables: {
      projects: [project(1, OWN_DIVISION), project(2, OTHER_DIVISION)],
      invoices: [
        invoice(1, id(21), 1_000_00),
        invoice(2, id(21), 2_000_00),
        invoice(3, id(21), 3_000_00),
        invoice(4, id(22), 50_000_00),
      ],
      vendor_bills: [],
      commitments: [],
    },
    permissions: ["report.read", "project.read"],
    ...options,
  })
}

test("a division-limited reader forecasts only their division's money", async () => {
  const service = forecastHarness({ divisions: [OWN_DIVISION] })

  const report = await service.run(() => getCashFlowForecast({}))

  assert.deepEqual(report.rows.map((row) => [row.month, row.inflow_cents]), [["2026-11", 6_000_00]])
})

test("the forecast reads every receivable past the API's row cap", async () => {
  const service = forecastHarness({ maxRows: 2 })

  const report = await service.run(() => getCashFlowForecast({}))

  assert.equal(report.rows[0].inflow_cents, 56_000_00)
})

// ---------------------------------------------------------------------------
// Land obligations: takedowns net of their deposits, deposits, contract fees.
// ---------------------------------------------------------------------------

const NORTH_COMMUNITY = id(30)
const SOUTH_COMMUNITY = id(31)

function landHarness(options = {}) {
  const contract = (communityId) => ({ community_id: communityId })
  return createServiceHarness({
    permissions: ["report.read", "project.read", "community.read"],
    tables: {
      projects: [project(1, OWN_DIVISION), project(2, OWN_DIVISION)],
      invoices: [invoice(1, id(21), 1_000_00), invoice(2, id(22), 2_000_00)],
      vendor_bills: [],
      commitments: [],
      communities: [
        { id: NORTH_COMMUNITY, org_id: ORG, division_id: OWN_DIVISION },
        { id: SOUTH_COMMUNITY, org_id: ORG, division_id: OTHER_DIVISION },
      ],
      // Only the first home stands on a North lot.
      lots: [{ id: id(40), org_id: ORG, community_id: NORTH_COMMUNITY, project_id: id(21) }],
      lot_takedowns: [
        { id: id(50), org_id: ORG, community_id: NORTH_COMMUNITY, name: "North 1", scheduled_date: "2099-03-01", lot_count: 10, price_per_lot_cents: 72_000_00, status: "scheduled" },
        { id: id(51), org_id: ORG, community_id: SOUTH_COMMUNITY, name: "South 1", scheduled_date: "2099-03-01", lot_count: 1, price_per_lot_cents: 9_000_00, status: "scheduled" },
      ],
      land_contract_deposits: [
        { id: id(60), org_id: ORG, takedown_id: id(50), due_on: "2099-01-15", amount_cents: 50_000_00, status: "scheduled", contract: contract(NORTH_COMMUNITY) },
      ],
      land_contract_amendments: [
        { id: id(70), org_id: ORG, due_on: "2099-02-01", fee_cents: 5_000_00, contract: contract(NORTH_COMMUNITY) },
      ],
    },
    ...options,
  })
}

const landByMonth = (report) => report.rows.filter((row) => row.land_obligations_cents).map((row) => [row.month, row.land_obligations_cents])

test("the org forecast carries land: deposits when due, fees when due, and each takedown net of its deposits", async () => {
  const report = await landHarness().run(() => getCashFlowForecast({}))

  assert.deepEqual(landByMonth(report), [["2099-01", 50_000_00], ["2099-02", 5_000_00], ["2099-03", 670_000_00 + 9_000_00]])
  const march = report.rows.find((row) => row.month === "2099-03")
  assert.equal(march.net_cents, -679_000_00)
})

test("a community lens reaches homes through their lots, not a column projects do not have", async () => {
  const service = landHarness()

  const report = await service.run(() => getCashFlowForecast({ communityId: NORTH_COMMUNITY }))

  assert.deepEqual(report.rows.filter((row) => row.inflow_cents).map((row) => row.inflow_cents), [1_000_00])
  assert.equal(landByMonth(report).find(([month]) => month === "2099-03")[1], 670_000_00)
})

test("a project forecast carries no land, and neither does a reader without community access", async () => {
  const projectScope = landHarness()
  await projectScope.run(() => getCashFlowForecast({ projectId: id(21) }))
  assert.deepEqual(projectScope.reads("lot_takedowns"), [])

  const noCommunity = landHarness({ permissions: ["report.read", "project.read"] })
  const report = await noCommunity.run(() => getCashFlowForecast({}))
  assert.deepEqual(landByMonth(report), [])
})

test("a division-limited reader's forecast carries only their division's land", async () => {
  const report = await landHarness({ divisions: [OWN_DIVISION] }).run(() => getCashFlowForecast({}))
  assert.deepEqual(landByMonth(report), [["2099-01", 50_000_00], ["2099-02", 5_000_00], ["2099-03", 670_000_00]])
})
