"use strict"

/**
 * The entitlements service: a condition takes its approval's phase and
 * milestone unless it names its own, an approval cannot lose its date, a
 * division-restricted member records nothing in another division's community,
 * and the portfolio counts what is holding each community.
 */

const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const {
  countEntitlementBlockersByCommunity,
  createCondition,
  createEntitlement,
  updateEntitlement,
} = freshRequire("lib/services/land-entitlements.ts")

const NORTH = id(1)
const SOUTH = id(2)
const HAWTHORNE = id(10)
const CEDAR = id(11)
const PHASE = id(20)
const PLAT = id(30)

const communities = [
  { id: HAWTHORNE, org_id: ORG, name: "Hawthorne", division_id: NORTH, archived_at: null },
  { id: CEDAR, org_id: ORG, name: "Cedar", division_id: SOUTH, archived_at: null },
]
const plat = {
  id: PLAT, org_id: ORG, community_id: HAWTHORNE, community_phase_id: PHASE, kind: "final_plat", name: "Final plat",
  status: "submitted", required_before: "lot_delivery", approved_on: null, expires_on: null, target_on: null,
  agency_company_id: null, jurisdiction: null, reference_number: null, submitted_on: null, owner_user_id: null, notes: null,
  updated_at: "2026-10-01T00:00:00+00:00",
}

test("a condition takes its approval's phase and milestone unless it names its own", async () => {
  const service = createServiceHarness({
    permissions: ["community.read", "community.write"],
    tables: { communities, land_entitlements: [plat], land_entitlement_conditions: [] },
  })

  await service.run(() => createCondition(PLAT, { title: "Dedicate right-of-way" }))
  await service.run(() => createCondition(PLAT, { title: "Signal before the 50th CO", requiredBefore: "closing" }))

  assert.deepEqual(
    service.db.land_entitlement_conditions.map((row) => [row.title, row.community_id, row.community_phase_id, row.required_before]),
    [
      ["Dedicate right-of-way", HAWTHORNE, PHASE, "lot_delivery"],
      ["Signal before the 50th CO", HAWTHORNE, PHASE, "closing"],
    ],
  )
  assert.deepEqual(service.events.map((event) => event.eventType), ["land_entitlement_condition.created", "land_entitlement_condition.created"])
})

test("an approved entitlement cannot be recorded without its approval date", async () => {
  const service = createServiceHarness({
    permissions: ["community.read", "community.write"],
    tables: { communities, land_entitlements: [plat] },
  })

  await assert.rejects(service.run(() => updateEntitlement(PLAT, { status: "approved" })), /needs its approval date/)
  assert.deepEqual(service.writes(), [])
  await service.run(() => updateEntitlement(PLAT, { status: "approved", approvedOn: "2026-10-10" }))
  assert.equal(service.db.land_entitlements[0].status, "approved")
  assert.equal(service.events[0].eventType, "land_entitlement.status_changed")
})

test("a division-restricted member records nothing in another division's community", async () => {
  const service = createServiceHarness({
    permissions: ["community.read", "community.write"],
    divisions: [NORTH],
    tables: { communities, land_entitlements: [] },
  })

  await assert.rejects(service.run(() => createEntitlement(CEDAR, { kind: "zoning", name: "Cedar zoning" })), /Community not found/)
  assert.deepEqual(service.writes(), [])
})

test("the portfolio counts each community's unmet items and how many are overdue", async () => {
  const service = createServiceHarness({
    tables: {
      land_entitlements: [plat, { ...plat, id: id(31), community_id: CEDAR, status: "approved", approved_on: "2026-01-01" }],
      land_entitlement_conditions: [
        { id: id(40), org_id: ORG, community_id: HAWTHORNE, entitlement_id: PLAT, community_phase_id: PHASE, title: "Signal", status: "open", required_before: "vertical_start", due_on: "2026-01-01" },
      ],
    },
  })

  const counts = await service.run(() => countEntitlementBlockersByCommunity(service.client, ORG, [HAWTHORNE, CEDAR]))
  assert.deepEqual(Object.fromEntries(counts), { [HAWTHORNE]: { open: 2, overdue: 1 } })
})
