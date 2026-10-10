"use strict"

/**
 * `lib/services/community-sales.ts` — the sales manager's moves on a community:
 * repricing the sheet and voiding a signed sale.
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, replies, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { bulkRepriceCommunityPlans, voidPurchaseAgreement } = freshRequire("lib/services/community-sales.ts")

const COMMUNITY = id(1)
const HOME = id(2)
const CONTRACT = id(3)
const RESERVATION = id(4)
const LEAD = id(5)
const TOKEN = id(6)

describe("bulkRepriceCommunityPlans", () => {
  const offers = [
    { id: id(11), org_id: ORG, community_id: COMMUNITY, house_plan_id: id(21), elevation_id: null, base_price_cents: 400_000_00, metadata: {} },
    { id: id(12), org_id: ORG, community_id: COMMUNITY, house_plan_id: id(22), elevation_id: null, base_price_cents: 500_000_00, metadata: {} },
  ]
  const harness = () =>
    createServiceHarness({
      tables: { community_plan_availability: offers, communities: [{ id: COMMUNITY, org_id: ORG }] },
      permissions: ["sales.manage"],
    })
  const basis = { [id(11)]: 400_000_00, [id(12)]: 500_000_00 }
  const reprice = (service) =>
    service.run(() =>
      bulkRepriceCommunityPlans({ communityId: COMMUNITY, availabilityIds: [id(11), id(12)], mode: "percent", value: 2, basisCents: basis }),
    )
  const prices = (service) => service.db.community_plan_availability.map((row) => row.base_price_cents)

  test("a percentage move reprices every selected plan from its current price", async () => {
    const service = harness()
    assert.deepEqual(await reprice(service), { repriced: 2, conflicts: [] })
    assert.deepEqual(prices(service), [408_000_00, 510_000_00])
    assert.equal(service.db.community_plan_availability[0].metadata.previous_base_price_cents, 400_000_00)
  })

  test("a replayed request leaves prices unchanged", async () => {
    const service = harness()
    await reprice(service)
    assert.deepEqual(await reprice(service), { repriced: 0, conflicts: [] })
    assert.deepEqual(prices(service), [408_000_00, 510_000_00])
  })

  test("two submits racing each other apply the move once", async () => {
    const service = harness()
    const outcomes = await Promise.all([reprice(service), reprice(service)])
    assert.deepEqual(prices(service), [408_000_00, 510_000_00])
    assert.equal(outcomes.reduce((sum, outcome) => sum + outcome.repriced, 0), 2)
  })

  test("a price changed underneath is reported as a conflict and left alone", async () => {
    const service = harness()
    service.db.community_plan_availability[1].base_price_cents = 505_000_00
    assert.deepEqual(await reprice(service), { repriced: 1, conflicts: [id(12)] })
    assert.deepEqual(prices(service), [408_000_00, 505_000_00])
  })
})

describe("voidPurchaseAgreement", () => {
  function harness({ permissions = ["sales.manage", "project.manage"] } = {}) {
    return createServiceHarness({
      permissions,
      tables: {
        contracts: [
          { id: CONTRACT, org_id: ORG, project_id: HOME, contract_type: "purchase_agreement", status: "active", snapshot: {} },
        ],
        lot_reservations: [
          { id: RESERVATION, org_id: ORG, contract_id: CONTRACT, prospect_id: LEAD, status: "converted", deposit_invoice_id: null, metadata: {} },
        ],
        prospects: [{ id: LEAD, org_id: ORG, status: "won", won_at: "2026-09-01T00:00:00Z" }],
        closings: [{ id: id(7), org_id: ORG, project_id: HOME, status: "projected" }],
        project_selections: [{ id: id(8), org_id: ORG, project_id: HOME, locked_at: "2026-09-01T00:00:00Z" }],
        projects: [{ id: HOME, org_id: ORG, client_id: id(9) }],
        portal_access_tokens: [
          { id: TOKEN, org_id: ORG, project_id: HOME, portal_type: "client", purpose: null, revoked_at: null },
        ],
        external_identity_grants: [
          { id: id(10), org_id: ORG, portal_access_token_id: TOKEN, status: "active", revoked_at: null },
        ],
      },
    })
  }
  const voidIt = (service) =>
    service.run(() =>
      voidPurchaseAgreement({ contractId: CONTRACT, reason: "Buyer financing fell through", depositDisposition: "refund" }),
    )

  test("voiding unwinds the sale and ends the buyer's account access, not just the link", async () => {
    const service = harness()
    await voidIt(service)

    assert.equal(service.db.contracts[0].status, "void")
    assert.equal(service.db.lot_reservations[0].status, "released")
    assert.equal(service.db.prospects[0].status, "qualified")
    assert.equal(service.db.closings[0].status, "cancelled")
    assert.equal(service.db.project_selections[0].locked_at, null)
    assert.equal(service.db.projects[0].client_id, null)
    assert.notEqual(service.db.portal_access_tokens[0].revoked_at, null)
    assert.equal(service.db.external_identity_grants[0].status, "revoked")
    assert.deepEqual(
      service.audits.map((entry) => [entry.entityType, entry.after.status]),
      [["contract", "void"]],
    )
    assert.ok(service.events.some((event) => event.eventType === "purchase_agreement_voided"))
  })

  test("a voider who cannot revoke the buyer's access changes nothing", async () => {
    const service = harness({ permissions: ["sales.manage"] })
    await assert.rejects(voidIt(service))
    assert.deepEqual(service.writes(), [])
  })

  test("a second void racing the first finds nothing left to void", async () => {
    const service = harness()
    const outcomes = await Promise.allSettled([voidIt(service), voidIt(service)])
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1)
    assert.equal(service.events.filter((event) => event.eventType === "lot_reservation_released").length, 1)
  })

  test("a failed unwind step is reported, not swallowed", async () => {
    const service = harness()
    service.tamper("closings", replies.error("closings unavailable"), { on: "update" })
    await assert.rejects(voidIt(service), /cancelling the closing failed/)
    assert.equal(service.events.some((event) => event.eventType === "purchase_agreement_voided"), false)
  })
})
