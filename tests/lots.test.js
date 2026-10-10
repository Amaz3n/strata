"use strict"

/**
 * `lib/services/lots.ts` — what may be attached to a lot: land that development
 * has delivered, and a lot no other buyer is holding.
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { attachProjectToLot, recordLotDeliveryException } = freshRequire("lib/services/lots.ts")

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
