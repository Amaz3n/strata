const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { getProductionHouseOverview } = freshRequire("lib/services/production-house-overview.ts")

const HOME = id(2)

test("a home's margin reads the approved budget and every posted cost", async () => {
  const service = createServiceHarness({
    tables: {
      projects: [{ id: HOME, org_id: ORG, name: "Maple Lot 4", location: {}, start_date: null, end_date: null, superintendent: null, client: null }],
      lots: [],
      schedule_items: [],
      start_packages: [],
      contracts: [{ id: id(4), org_id: ORG, project_id: HOME, contract_type: "purchase_agreement", total_cents: 500_000_00, status: "signed", snapshot: {}, signed_at: "2026-03-01" }],
      budgets: [
        { id: id(5), org_id: ORG, project_id: HOME, version: 1, status: "approved", total_cents: 400_000_00 },
        { id: id(6), org_id: ORG, project_id: HOME, version: 2, status: "draft", total_cents: 1_00 },
      ],
      job_cost_entries: [1, 2, 3].map((n) => ({ id: id(10 + n), org_id: ORG, project_id: HOME, status: "posted", cost_cents: 10_000_00 })),
      commitment_change_orders: [
        { id: id(40), org_id: ORG, project_id: HOME, status: "approved", total_cents: 5_000_00, reason: null, commitment: { commitment_type: "purchase_order" } },
        { id: id(41), org_id: ORG, project_id: HOME, status: "draft", total_cents: 9_000_00, reason: null, commitment: { commitment_type: "purchase_order" } },
      ],
      project_selection_groups: [],
      project_selections: [],
      closings: [],
      punch_items: [],
      photos: [],
      daily_logs: [],
      warranty_requests: [],
      change_orders: [],
    },
    permissions: ["project.read"],
    maxRows: 2,
  })

  const overview = await service.run(() => getProductionHouseOverview(HOME))

  assert.equal(overview.money.budgetCents, 400_000_00)
  assert.equal(overview.money.actualCostCents, 30_000_00)
  // An approved purchase-order change counts as a variance order even with no reason on it; a draft does not.
  assert.equal(overview.money.vpoCents, 5_000_00)
  assert.equal(overview.money.vpoCount, 1)
  assert.equal(overview.money.topVpoReason, "Uncoded")
})

test("a released home reads the revisions it was built against and what has changed since", async () => {
  const VERSION = id(30)
  const ELEVATION = id(31)
  const PATIO = id(32)
  const recorded = {
    planVersion: { id: VERSION, number: 3 },
    elevation: { id: ELEVATION, code: "B", revision: 2 },
    options: [{ id: PATIO, revision: 1 }],
    packages: [],
  }
  const service = createServiceHarness({
    tables: {
      projects: [{ id: HOME, org_id: ORG, name: "Maple Lot 4", location: {}, start_date: null, end_date: null, superintendent: null, client: null }],
      lots: [{ id: id(33), org_id: ORG, project_id: HOME, house_plan_version_id: VERSION, house_plan_elevation_id: ELEVATION, version: { version_number: 3 } }],
      house_plan_elevations: [{ id: ELEVATION, org_id: ORG, code: "B", revision: 3 }],
      selection_options: [{ id: PATIO, org_id: ORG, revision: 1 }],
      selection_packages: [],
      home_product_revisions: [{
        id: id(34), org_id: ORG, project_id: HOME, contract_id: null, stage: "release", revisions: recorded,
        as_of: "2026-09-01T00:00:00Z", captured_at: "2026-09-01T00:00:00Z",
      }],
    },
    permissions: ["project.read"],
  })

  const overview = await service.run(() => getProductionHouseOverview(HOME))

  assert.deepEqual(overview.productRevisions, {
    stage: "release",
    summary: "plan v3 · elevation B r2 · 1 option",
    changes: ["Elevation r2 → r3"],
  })
})
