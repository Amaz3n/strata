"use strict"

/**
 * `lib/services/lots.ts` — what may be attached to a lot: land that development
 * has delivered, and a lot no other buyer is holding.
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { assignPlanToLot, attachProjectToLot, recordLotDeliveryException } = freshRequire("lib/services/lots.ts")

const COMMUNITY = id(1)
const LOT = id(2)
const HOME = id(3)
const BUYER = id(4)
const OTHER_BUYER = id(5)
const DELIVERED = "2026-06-01T00:00:00+00:00"

function harness({ delivered = true, status = "developed", client = null, reservations = [], permissions = ["lot.write", "project.manage", "community.write", "community.read"] } = {}) {
  return createServiceHarness({
    permissions,
    tables: {
      communities: [{ id: COMMUNITY, org_id: ORG, division_id: null }],
      lots: [{
        id: LOT, org_id: ORG, community_id: COMMUNITY, division_id: null, community_phase_id: null, lot_number: "12", block: null,
        status, address: null, dimensions: {}, swing: "either", premium_cents: 0, cost_basis_cents: null, takedown_id: null,
        acquired_date: null, project_id: null, notes: null, delivered_at: delivered ? DELIVERED : null, metadata: {},
        updated_at: "2026-10-01T00:00:00+00:00",
      }],
      projects: [{ id: HOME, org_id: ORG, name: "Lot 12", property_type: "production", division_id: null, client_id: client }],
      lot_reservations: reservations,
    },
  })
}

const attach = (service) => service.run(() => attachProjectToLot(LOT, HOME))
const hold = (buyer, overrides = {}) => ({
  id: id(50), org_id: ORG, lot_id: LOT, buyer_contact_id: buyer, co_buyer_contact_id: null,
  status: "hold", expires_at: new Date(Date.now() + 86_400_000).toISOString(), ...overrides,
})

describe("attachProjectToLot", () => {
  test("a home attaches to a delivered lot nobody is holding", async () => {
    const service = harness()
    const lot = await attach(service)
    assert.equal(lot.projectId, HOME)
    assert.equal(lot.status, "started")
  })

  test("a home cannot be attached to land development has not delivered", async () => {
    const service = harness({ delivered: false, status: "owned" })
    await assert.rejects(attach(service), /not been delivered/)
    assert.deepEqual(service.writes(), [])
  })

  test("a recorded delivery exception lets the home attach, and is audited with its reason", async () => {
    const service = harness({ delivered: false, status: "owned" })
    await service.run(() => recordLotDeliveryException(LOT, { reason: "Lot finishes with the house pad" }))
    assert.equal(service.db.lots[0].metadata.delivery_exception.reason, "Lot finishes with the house pad")
    assert.deepEqual(service.events.map((event) => event.eventType), ["lot.delivery_exception_recorded"])
    assert.equal((await attach(service)).projectId, HOME)
  })

  test("a delivery exception needs a reason and community authority", async () => {
    const service = harness({ delivered: false, status: "owned" })
    await assert.rejects(service.run(() => recordLotDeliveryException(LOT, { reason: "later" })), /Say why/)
    const clerk = harness({ delivered: false, status: "owned", permissions: ["lot.write", "community.read"] })
    await assert.rejects(clerk.run(() => recordLotDeliveryException(LOT, { reason: "Lot finishes with the house pad" })), /Missing permission/)
    assert.deepEqual(service.writes().concat(clerk.writes()), [])
  })

  test("a home cannot be attached to a lot another buyer is holding", async () => {
    const service = harness({ client: OTHER_BUYER, reservations: [hold(BUYER)] })
    await assert.rejects(attach(service), /another buyer/)
    assert.deepEqual(service.writes(), [])
  })

  test("a home with no buyer cannot take a held lot", async () => {
    const service = harness({ reservations: [hold(BUYER, { status: "reserved", expires_at: null })] })
    await assert.rejects(attach(service), /another buyer/)
  })

  test("the buyer's own home attaches to the lot they are holding", async () => {
    const service = harness({ client: BUYER, reservations: [hold(BUYER)] })
    assert.equal((await attach(service)).projectId, HOME)
  })

  test("an expired hold no longer blocks the lot", async () => {
    const service = harness({ client: OTHER_BUYER, reservations: [hold(BUYER, { expires_at: "2020-01-01T00:00:00+00:00" })] })
    assert.equal((await attach(service)).projectId, HOME)
  })
})

describe("assignPlanToLot", () => {
  const PLAN = id(60)
  const VERSION = id(61)
  const ELEVATION = id(62)
  const permissions = ["lot.write", "plan.instantiate", "community.read"]

  function planHarness({ offered = true, versionStatus = "released", reservations = [], lot = {} } = {}) {
    const service = harness({ permissions, reservations })
    Object.assign(service.db.lots[0], lot)
    service.db.house_plan_versions = [{ id: VERSION, org_id: ORG, house_plan_id: PLAN, status: versionStatus }]
    service.db.house_plan_elevations = [{ id: ELEVATION, org_id: ORG, house_plan_id: PLAN, is_active: true }]
    service.db.community_plan_availability = offered
      ? [{ org_id: ORG, community_id: COMMUNITY, house_plan_id: PLAN, is_available: true, elevation_id: null, effective_start: null, effective_end: null }]
      : []
    return service
  }
  const assign = (service) => service.run(() => assignPlanToLot(LOT, { versionId: VERSION, elevationId: ELEVATION }))

  test("an unsold lot takes a released plan its community offers, and the pin is audited", async () => {
    const service = planHarness()
    await assign(service)
    assert.equal(service.db.lots[0].house_plan_version_id, VERSION)
    assert.equal(service.db.lots[0].house_plan_elevation_id, ELEVATION)
    assert.deepEqual(service.events.map((event) => event.eventType), ["lot.plan_assigned"])
  })

  test("a plan the community does not offer is refused unless an override was recorded", async () => {
    const service = planHarness({ offered: false })
    await assert.rejects(assign(service), /not offered/)
    assert.deepEqual(service.writes(), [])

    const overridden = planHarness({
      offered: false,
      lot: { metadata: { offering_override: { house_plan_id: PLAN, reason: "Builder's choice here", by: id(900002), at: "2026-10-01T00:00:00Z" } } },
    })
    await assign(overridden)
    assert.equal(overridden.db.lots[0].house_plan_version_id, VERSION)
  })

  test("a lot with a home, a live hold or a draft plan version is refused", async () => {
    await assert.rejects(assign(planHarness({ lot: { project_id: HOME } })), /already has a home/)
    await assert.rejects(assign(planHarness({ reservations: [hold(BUYER)] })), /held or sold/)
    await assert.rejects(assign(planHarness({ versionStatus: "draft" })), /released plan version/)
  })

  test("assigning a plan takes plan authority as well as lot authority", async () => {
    const clerk = harness({ permissions: ["lot.write", "community.read"] })
    await assert.rejects(assign(clerk), /Missing permission/)
  })
})
