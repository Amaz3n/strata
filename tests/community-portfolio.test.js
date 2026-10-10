"use strict"

/** `lib/services/community-portfolio.ts` — the runway board's facts must be complete or say they are not. */

const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

const COMMUNITY = id(1)
const LOT_STATUSES = ["owned", "developed", "assigned", "started", "closed", "planned", "reserved", "sold"]

stubModule("server-only", {})
stubModule("@/lib/services/production-reporting", { getProductionPortfolioReport: async () => null })
stubModule("@/lib/services/communities", {
  listCommunities: async () => [
    {
      id: COMMUNITY,
      name: "Oak Ridge",
      code: null,
      status: "active",
      divisionName: null,
      city: null,
      state: null,
      plannedLotCount: null,
      targetAbsorptionPerMonth: null,
      lotCounts: Object.fromEntries(LOT_STATUSES.map((status) => [status, 0])),
    },
  ],
})
const { getCommunityPortfolio } = freshRequire("lib/services/community-portfolio.ts")

const recent = new Date(Date.now() - 5 * 86_400_000).toISOString()

function harness(reservations, maxRows) {
  return createServiceHarness({
    permissions: ["community.read"],
    maxRows,
    tables: {
      lot_reservations: reservations,
      start_packages: [],
      closings: [],
      lot_takedowns: [],
      lots: [],
      project_selections: [],
    },
  })
}

test("sales pace counts every conversion even when each response is capped", async () => {
  const converted = Array.from({ length: 2500 }, (_, index) => ({
    id: id(1000 + index),
    org_id: ORG,
    community_id: COMMUNITY,
    lot_id: id(50000 + index),
    status: "converted",
    converted_at: recent,
  }))
  const service = harness(converted, 1000)

  const portfolio = await service.run(() => getCommunityPortfolio())

  assert.equal(portfolio.lanes[0].salesLast90, 2500)
  assert.equal(portfolio.truncated, false)
})
