"use strict"

/**
 * `lib/services/community-inventory.ts` — a community's lots, paged in Postgres,
 * never claiming a truncated list is complete.
 */

const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

// The community header has its own suite; here it only has to exist.
stubModule("@/lib/services/communities", { getCommunity: async () => ({ id: COMMUNITY }) })

const { listCommunityInventory } = freshRequire("lib/services/community-inventory.ts")

const COMMUNITY = id(1)

function harness(lotCount) {
  return createServiceHarness({
    permissions: ["community.read"],
    strictRanges: true,
    tables: {
      lots: Array.from({ length: lotCount }, (_, index) => ({
        id: id(100 + index), org_id: ORG, community_id: COMMUNITY, lot_number: String(index + 1), status: "developed",
        block: null, address: null, community_phase_id: null, takedown_id: null, dimensions: {}, swing: "either", premium_cents: 0,
        cost_basis_cents: null, asking_price_override_cents: null, acquired_date: null, notes: null, house_plan_id: null,
        house_plan_elevation_id: null, project_id: null, delivered_at: null, metadata: {}, plat_x: null, plat_y: null,
      })),
      lot_reservations: [],
      closings: [],
    },
  })
}

test("a stale page past the last lot is an empty page with the true total, not an error", async () => {
  const service = harness(30)
  const page = await service.run(() => listCommunityInventory(COMMUNITY, { page: 5, pageSize: 25 }))
  assert.deepEqual({ lots: page.lots.length, total: page.total, page: page.page, truncated: page.truncated }, { lots: 0, total: 30, page: 5, truncated: false })
})

test("the last real page says it is complete and the first says there is more", async () => {
  const service = harness(30)
  const first = await service.run(() => listCommunityInventory(COMMUNITY, { page: 1, pageSize: 25 }))
  const last = await service.run(() => listCommunityInventory(COMMUNITY, { page: 2, pageSize: 25 }))
  assert.deepEqual([first.lots.length, first.total, first.truncated], [25, 30, true])
  assert.deepEqual([last.lots.length, last.total, last.truncated], [5, 30, false])
})
