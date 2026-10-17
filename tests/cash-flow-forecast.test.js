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
  const contract = (communityId) => ({ community_id: communityId, status: "executed" })
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

test("a terminated contract's obligations leave the plan; a paid fee is not owed, an unpaid one past due is owed now", async () => {
  const terminated = { community_id: NORTH_COMMUNITY, status: "terminated" }
  const executed = { community_id: NORTH_COMMUNITY, status: "executed" }
  const service = landHarness({
    tables: {
      projects: [], invoices: [], vendor_bills: [], commitments: [], lots: [],
      communities: [{ id: NORTH_COMMUNITY, org_id: ORG, division_id: OWN_DIVISION }],
      lot_takedowns: [
        { id: id(52), org_id: ORG, community_id: NORTH_COMMUNITY, name: "Dead tranche", scheduled_date: "2099-03-01", lot_count: 10, price_per_lot_cents: 72_000_00, status: "scheduled", contract: { status: "terminated" } },
      ],
      land_contract_deposits: [
        { id: id(61), org_id: ORG, takedown_id: null, due_on: "2099-01-15", amount_cents: 50_000_00, status: "scheduled", contract: terminated },
      ],
      land_contract_amendments: [
        { id: id(71), org_id: ORG, due_on: "2020-02-01", fee_cents: 5_000_00, fee_paid_on: null, contract: executed },
        { id: id(72), org_id: ORG, due_on: "2020-02-01", fee_cents: 7_000_00, fee_paid_on: "2020-02-01", contract: executed },
        { id: id(73), org_id: ORG, due_on: "2099-02-01", fee_cents: 9_000_00, fee_paid_on: null, contract: terminated },
      ],
    },
  })

  const report = await service.run(() => getCashFlowForecast({}))

  assert.deepEqual(landByMonth(report), [[new Date().toISOString().slice(0, 7), 5_000_00]])
})

// ---------------------------------------------------------------------------
// Construction drivers: planned starts, scheduled closings and the what-if.
// ---------------------------------------------------------------------------

const CONSTRUCTION_PERMISSIONS = ["report.read", "project.read", "budget.read", "commitment.read", "invoice.read", "sales.read"]

function constructionHarness(options = {}) {
  const startHome = (n, divisionId) => ({ ...project(n, divisionId), phase: "precon", status: "planning" })
  return createServiceHarness({
    permissions: CONSTRUCTION_PERMISSIONS,
    tables: {
      // Homes 1 and 2 are in the reader's division; home 3 is not.
      projects: [startHome(1, OWN_DIVISION), startHome(2, OWN_DIVISION), startHome(3, OTHER_DIVISION)],
      invoices: [
        // Home 2's earnest deposit is already billed: it is a receivable, not closing proceeds.
        { ...invoice(1, id(22), 20_000_00), status: "paid", balance_due_cents: 0, due_date: "2099-01-10" },
      ],
      vendor_bills: [],
      commitments: [
        // Home 1 has 100k of its 300k budget already committed to a trade.
        { id: id(150), org_id: ORG, project_id: id(21), total_cents: 100_000_00, status: "approved", vendor_bills: [] },
      ],
      budgets: [
        { id: id(160), org_id: ORG, project_id: id(21), version: 1, status: "approved", total_cents: 300_000_00 },
        { id: id(161), org_id: ORG, project_id: id(22), version: 1, status: "approved", total_cents: 250_000_00 },
        { id: id(162), org_id: ORG, project_id: id(23), version: 1, status: "approved", total_cents: 999_000_00 },
      ],
      start_packages: [
        { id: id(170), org_id: ORG, project_id: id(21), status: "ready", target_week: "2099-03-02", scheduled_start_date: "2099-03-04" },
        { id: id(171), org_id: ORG, project_id: id(22), status: "open", target_week: "2099-04-06", scheduled_start_date: null },
        { id: id(172), org_id: ORG, project_id: id(23), status: "open", target_week: "2099-04-06", scheduled_start_date: null },
        { id: id(173), org_id: ORG, project_id: id(21), status: "released", target_week: "2099-05-04", scheduled_start_date: "2099-05-04" },
      ],
      closings: [
        { id: id(180), org_id: ORG, project_id: id(21), status: "scheduled", scheduled_date: "2099-06-26" },
        { id: id(181), org_id: ORG, project_id: id(22), status: "projected", scheduled_date: "2099-07-10" },
        { id: id(182), org_id: ORG, project_id: id(23), status: "scheduled", scheduled_date: "2099-07-10" },
        { id: id(183), org_id: ORG, project_id: id(21), status: "closed", scheduled_date: "2099-02-01" },
      ],
      contracts: [
        { id: id(190), org_id: ORG, project_id: id(21), contract_type: "purchase_agreement", status: "active", total_cents: 450_000_00, signed_at: "2099-01-01" },
        { id: id(191), org_id: ORG, project_id: id(22), contract_type: "purchase_agreement", status: "active", total_cents: 400_000_00, signed_at: "2099-01-01" },
        { id: id(192), org_id: ORG, project_id: id(23), contract_type: "purchase_agreement", status: "active", total_cents: 900_000_00, signed_at: "2099-01-01" },
      ],
    },
    ...options,
  })
}

const column = (report, key) => report.rows.filter((row) => row[key]).map((row) => [row.month, row[key]])

test("planned starts cost their uncommitted budget in the start month, and closings bring the price less what is billed", async () => {
  const report = await constructionHarness({ divisions: [OWN_DIVISION] }).run(() => getCashFlowForecast({}))

  // Home 1: 300k budget - 100k committed in March; home 2: 250k in April (its target week). Released and other-division starts are not in it.
  assert.deepEqual(column(report, "starts_cost_cents"), [["2099-03", 200_000_00], ["2099-04", 250_000_00]])
  // Home 1 closes June for 450k; home 2 closes July for 400k less its 20k paid deposit.
  assert.deepEqual(column(report, "closing_proceeds_cents"), [["2099-06", 450_000_00], ["2099-07", 380_000_00]])
  // Home 1's 100k PO is committed cost too, counted once beside its start.
  assert.equal(report.totals.net_cents, (450_000_00 + 380_000_00) - 200_000_00 - 250_000_00 - 100_000_00)
  assert.deepEqual(report.drivers.starts, { count: 2, costCents: 450_000_00, undatedCount: 0, unbudgetedCount: 0, restricted: false })
  assert.deepEqual(report.drivers.closings, { count: 2, proceedsCents: 830_000_00, undatedCount: 0, unsignedCount: 0, restricted: false })
})

test("a reader without the other division sees none of its starts or closings; an unlimited reader sees them all", async () => {
  const all = await constructionHarness().run(() => getCashFlowForecast({}))

  assert.equal(all.drivers.starts.costCents, 200_000_00 + 250_000_00 + 999_000_00)
  assert.equal(all.drivers.closings.proceedsCents, 450_000_00 + 380_000_00 + 900_000_00)
  assert.equal(all.totals.starts_cost_cents, all.drivers.starts.costCents)
  assert.equal(all.totals.closing_proceeds_cents, all.drivers.closings.proceedsCents)
})

test("a scenario slips closings by whole weeks and scales starts, leaving everything already billed alone", async () => {
  const base = await constructionHarness({ divisions: [OWN_DIVISION] }).run(() => getCashFlowForecast({}))
  const slipped = await constructionHarness({ divisions: [OWN_DIVISION] }).run(() => getCashFlowForecast({ scenario: { closingShiftWeeks: 8, startPacePercent: 50 } }))

  // 2099-06-26 + 8 weeks is 2099-08-21; 2099-07-10 + 8 weeks is 2099-09-04.
  assert.deepEqual(column(slipped, "closing_proceeds_cents"), [["2099-08", 450_000_00], ["2099-09", 380_000_00]])
  assert.deepEqual(column(slipped, "starts_cost_cents"), [["2099-03", 100_000_00], ["2099-04", 125_000_00]])
  assert.equal(slipped.totals.inflow_cents, base.totals.inflow_cents)
  assert.equal(slipped.totals.closing_proceeds_cents, base.totals.closing_proceeds_cents)
  await assert.rejects(constructionHarness().run(() => getCashFlowForecast({ scenario: { closingShiftWeeks: 500 } })))
})

test("a reader who cannot open budgets or invoices gets no starts or closings rather than overstated ones", async () => {
  const report = await constructionHarness({ permissions: ["report.read", "project.read"] }).run(() => getCashFlowForecast({}))

  assert.deepEqual(report.rows.filter((row) => row.starts_cost_cents || row.closing_proceeds_cents), [])
  assert.equal(report.drivers.starts.restricted, true)
  assert.equal(report.drivers.closings.restricted, true)
})

test("a home still to start counts its purchase orders and billed deposit once, and a closing invoice is not counted twice", async () => {
  const report = await constructionHarness({
    divisions: [OWN_DIVISION],
  }).run(() => getCashFlowForecast({}))

  // Home 1 (precon, 100k committed against a 300k budget, ends 2099-12-31): the 100k is committed-unbilled once,
  // and the start costs only the other 200k.
  assert.equal(report.totals.committed_unbilled_cents, 100_000_00)
  assert.equal(report.totals.starts_cost_cents, 450_000_00)
})
