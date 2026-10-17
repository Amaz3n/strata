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
    permissions: ["report.read", "financials.margin.read"],
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

// ---------------------------------------------------------------------------
// Division, plan-version and cohort rollups over the locked baselines.
// ---------------------------------------------------------------------------

const GULF = id(60)
const ATLANTIC = id(61)
const PLAN = id(62)
const V1 = id(63)
const V2 = id(64)

const home = (n, { community, version, versionNumber }) => ({
  id: id(100 + n), org_id: ORG, community_id: community, project_id: id(200 + n), lot_number: String(n), status: "under_construction",
  house_plan_id: PLAN, house_plan_version_id: version, plan: { id: PLAN, name: "Mangrove" }, version: { version_number: versionNumber },
  project: { name: `Lot ${n}`, division_id: null },
})

const baseline = (n, sale, cost) => ({
  id: id(300 + n), org_id: ORG, project_id: id(200 + n), stage: "release", captured_at: "2026-07-01T00:00:00Z",
  sale_price_cents: sale, cost_cents: cost, margin_cents: sale - cost, margin_bps: Math.round(((sale - cost) / sale) * 10_000),
})

function rollupHarness({ budget = [330_000_00, 360_000_00, 480_000_00], closing = true, variance = [], permissions = ["report.read", "financials.margin.read"] } = {}) {
  return createServiceHarness({
    tables: {
      divisions: [{ id: id(70), org_id: ORG, name: "Gulf Coast" }, { id: id(71), org_id: ORG, name: "Atlantic" }],
      communities: [
        { id: GULF, org_id: ORG, name: "Cypress", division_id: id(70), settings: {}, archived_at: null },
        { id: ATLANTIC, org_id: ORG, name: "Harbor", division_id: id(71), settings: {}, archived_at: "2026-09-01T00:00:00Z" },
      ],
      lots: [
        home(1, { community: GULF, version: V1, versionNumber: 1 }),
        home(2, { community: GULF, version: V2, versionNumber: 2 }),
        home(3, { community: ATLANTIC, version: V2, versionNumber: 2 }),
      ],
      contracts: [1, 2, 3].map((n) => ({ id: id(400 + n), org_id: ORG, project_id: id(200 + n), contract_type: "purchase_agreement", total_cents: 500_000_00, signed_at: "2026-03-01" })),
      closings: closing ? [{ id: id(500), org_id: ORG, project_id: id(201), status: "closed", settlement: {}, actual_date: "2026-09-15", scheduled_date: "2026-09-15" }] : [],
      start_packages: [
        { id: id(600), org_id: ORG, project_id: id(201), status: "released", actual_start_date: "2026-04-01" },
        { id: id(601), org_id: ORG, project_id: id(202), status: "released", actual_start_date: "2026-08-10" },
      ],
      budgets: budget.map((total, index) => ({ id: id(700 + index), org_id: ORG, project_id: id(201 + index), version: 1, status: "approved", total_cents: total })),
      job_cost_entries: [],
      commitment_change_orders: variance,
      // Homes 1 and 2 were released at 400k and 420k cost; home 3 has no baseline.
      home_margin_baselines: [baseline(1, 500_000_00, 400_000_00), baseline(2, 500_000_00, 420_000_00)],
      // Home 2 was released on v1; its lot has since been moved to v2. Home 1 has no record, so its lot's version stands.
      home_product_revisions: [
        { id: id(800), org_id: ORG, project_id: id(202), stage: "release", captured_at: "2026-07-01T00:00:00Z", house_plan_version_id: V1, plan_version_number: 1 },
      ],
    },
    permissions,
  })
}

test("division and plan-version rollups sum the same homes against their locked baselines", async () => {
  const report = await rollupHarness().run(() => getProductionPortfolioReport())

  const gulf = report.divisions.find((row) => row.divisionName === "Gulf Coast")
  // Revised margins 170k and 140k against original 100k and 80k.
  assert.equal(gulf.homes, 2)
  assert.equal(gulf.marginCents, 310_000_00)
  assert.equal(gulf.originalMarginCents, 180_000_00)
  assert.equal(gulf.driftCents, 130_000_00)
  const atlantic = report.divisions.find((row) => row.divisionName === "Atlantic")
  assert.equal(atlantic.baselinedHomes, 0)
  assert.equal(atlantic.unbaselinedHomes, 1)

  const [v1, v2] = report.planVersions
  assert.deepEqual([v1.versionNumber, v1.homes, v1.marginCents], [1, 2, 170_000_00 + 140_000_00])
  assert.deepEqual([v2.versionNumber, v2.homes, v2.marginCents], [2, 1, 20_000_00])
  assert.equal(report.plans[0].homes, 3)
  assert.equal(report.rollup.homes, 3)
  assert.equal(report.rollup.marginCents, 330_000_00)
})

test("a budget changed after the baseline moves the revised margin and never the original", async () => {
  const before = await rollupHarness().run(() => getProductionPortfolioReport())
  const after = await rollupHarness({ budget: [380_000_00, 360_000_00, 480_000_00] }).run(() => getProductionPortfolioReport())

  assert.equal(after.rollup.originalMarginCents, before.rollup.originalMarginCents)
  assert.equal(after.rollup.marginCents, before.rollup.marginCents - 50_000_00)
})

test("a cohort counts only homes closed or started in its period", async () => {
  const closed = await rollupHarness().run(() => getProductionPortfolioReport({ cohort: { kind: "closed", from: "2026-07-01", to: "2026-09-30" } }))
  assert.deepEqual([closed.rollup.homes, closed.communities.find((row) => row.communityId === GULF).lotCount, closed.communities.find((row) => row.communityId === ATLANTIC).lotCount], [1, 1, 0])

  const started = await rollupHarness().run(() => getProductionPortfolioReport({ cohort: { kind: "started", from: "2026-08-01", to: null } }))
  assert.equal(started.rollup.homes, 1)
  assert.equal(started.divisions[0].divisionName, "Gulf Coast")
})

test("a home is grouped under the plan version it was released at, not the one its lot carries now", async () => {
  const report = await rollupHarness().run(() => getProductionPortfolioReport())

  const byVersion = Object.fromEntries(report.planVersions.map((row) => [row.versionNumber, row.homes]))
  // Homes 1 (lot on v1) and 2 (released at v1, lot now v2) are v1; home 3 is v2.
  assert.deepEqual(byVersion, { 1: 2, 2: 1 })
})

test("an archived community's homes still count; a reader without margin access gets homes and variance but no money, flagged", async () => {
  const full = await rollupHarness().run(() => getProductionPortfolioReport())
  assert.equal(full.rollup.homes, 3)
  assert.equal(full.marginRestricted, false)

  const variance = [{ id: id(900), org_id: ORG, project_id: id(201), total_cents: 7_000_00, reason: { code: "x", label: "Missed scope" }, company: { name: "Framer" }, commitment: { commitment_type: "purchase_order" }, status: "approved" }]
  const restricted = await rollupHarness({ permissions: ["report.read"], variance }).run(() => getProductionPortfolioReport())
  assert.equal(restricted.marginRestricted, true)
  assert.equal(restricted.rollup.homes, 3)
  assert.equal(restricted.rollup.revenueCents, 0)
  assert.equal(restricted.rollup.baselinedHomes, 0)
  assert.equal(restricted.variance[0].amountCents, 7_000_00)
})
