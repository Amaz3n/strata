const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { getProductionPortfolioReport } = freshRequire("lib/services/production-reporting.ts")

const COMMUNITY = id(1)
const HOME = id(2)

function portfolio({ maxRows, variance = [] } = {}) {
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
      commitment_change_orders: variance,
      home_margin_baselines: [
        { id: id(20), org_id: ORG, project_id: HOME, stage: "agreement", sale_price_cents: 500_000_00, cost_cents: null, margin_cents: null, margin_bps: null },
        { id: id(21), org_id: ORG, project_id: HOME, stage: "release", sale_price_cents: 500_000_00, cost_cents: 390_000_00, margin_cents: 110_000_00, margin_bps: 2200 },
      ],
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

test("an approved purchase-order change counts as variance even without a reason; a draft does not", async () => {
  const order = (n, status) => ({ id: id(40 + n), org_id: ORG, project_id: HOME, status, total_cents: 5_000_00, reason: null, company: null, commitment: { commitment_type: "purchase_order" } })
  const service = portfolio({ variance: [order(0, "approved"), order(1, "draft")] })

  const report = await service.run(() => getProductionPortfolioReport())

  assert.deepEqual(report.variance.map((row) => [row.reason, row.count, row.amountCents]), [["Uncoded", 1, 5_000_00]])
})

test("actual cost counts every posted entry past the API's row cap", async () => {
  const service = portfolio({ maxRows: 2 })

  const report = await service.run(() => getProductionPortfolioReport())

  assert.equal(report.totals.actualCostCents, 30_000_00)
  assert.equal(report.communities[0].lots[0].actualCostCents, 30_000_00)
})

test("original margin is read from the locked baseline beside the current projection", async () => {
  const service = portfolio()

  const report = await service.run(() => getProductionPortfolioReport())
  const [community] = report.communities

  assert.equal(community.lots[0].projectedMarginCents, 100_000_00)
  assert.equal(community.lots[0].originalMarginCents, 110_000_00)
  assert.equal(community.lots[0].originalMarginPercent, 22)
  assert.equal(community.lots[0].originalMarginStage, "release")
  assert.equal(community.originalMarginPercent, 22)
  assert.equal(community.originalMarginHomes, 1)
})
