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
      commitment_change_orders: [],
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
})
