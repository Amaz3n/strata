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
