const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { getProductionPortfolioReport } = freshRequire("lib/services/production-reporting.ts")

const COMMUNITY = id(1)
const HOME = id(2)

function portfolio({ maxRows } = {}) {
  return createServiceHarness({
    tables: {
      communities: [{ id: COMMUNITY, org_id: ORG, name: "Maple Ridge", division_id: null, settings: {}, archived_at: null }],
      lots: [
        {
          id: id(3), org_id: ORG, community_id: COMMUNITY, project_id: HOME, lot_number: "4", status: "under_construction",
          house_plan_id: null, plan: null, project: { name: "Maple Lot 4", division_id: null },
        },
      ],
      contracts: [{ id: id(4), org_id: ORG, project_id: HOME, contract_type: "purchase_agreement", total_cents: 500_000_00, signed_at: "2026-03-01" }],
      closings: [],
      budgets: [
        { id: id(5), org_id: ORG, project_id: HOME, version: 1, status: "approved", total_cents: 400_000_00 },
        { id: id(6), org_id: ORG, project_id: HOME, version: 2, status: "draft", total_cents: 1_00 },
      ],
      job_cost_entries: [1, 2, 3].map((n) => ({ id: id(10 + n), org_id: ORG, project_id: HOME, status: "posted", cost_cents: 10_000_00 })),
      commitment_change_orders: [],
    },
    permissions: ["report.read"],
    maxRows,
  })
}

test("a draft budget never replaces the approved baseline in the margin", async () => {
  const service = portfolio()

  const report = await service.run(() => getProductionPortfolioReport())

  assert.equal(report.totals.budgetCents, 400_000_00)
})

test("actual cost counts every posted entry past the API's row cap", async () => {
  const service = portfolio({ maxRows: 2 })

  const report = await service.run(() => getProductionPortfolioReport())

  assert.equal(report.totals.actualCostCents, 30_000_00)
  assert.equal(report.communities[0].lots[0].actualCostCents, 30_000_00)
})
