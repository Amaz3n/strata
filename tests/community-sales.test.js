"use strict"

/**
 * `lib/services/community-sales.ts` — the sales manager's moves on a community:
 * repricing the sheet, converting a hold into a reservation, repricing one
 * standing spec, and voiding a signed sale.
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, replies, id, ORG } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")
const { withIlike } = require("./support/postgrest-extras")

// Building a home and issuing an invoice have their own suites; here they are
// recorded so a test can prove whether a conversion created one.
const created = { homes: [], invoices: [] }
stubModule("@/lib/services/projects", {
  createProject: async (request) => {
    created.homes.push(request)
    return { id: HOME_ID }
  },
})
stubModule("@/lib/services/invoices", {
  createInvoice: async (request) => {
    created.invoices.push(request)
    return { id: id(77) }
  },
})

const { bulkRepriceCommunityPlans, convertHoldToReservation, listSellableLots, setSpecAskingPrice, voidPurchaseAgreement } =
  freshRequire("lib/services/community-sales.ts")

const COMMUNITY = id(1)
const HOME = id(2)
const CONTRACT = id(3)
const RESERVATION = id(4)
const LEAD = id(5)
const TOKEN = id(6)
const HOME_ID = id(90)

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

describe("listSellableLots", () => {
  const lots = (count) =>
    Array.from({ length: count }, (_, index) => ({
      id: id(1000 + index),
      org_id: ORG,
      community_id: COMMUNITY,
      lot_number: String(index + 1).padStart(4, "0"),
      status: "developed",
      premium_cents: 0,
      project_id: null,
    }))
  const harness = (rows) => {
    const service = createServiceHarness({
      tables: { lots: rows, lot_reservations: [], contracts: [], communities: [{ id: COMMUNITY, org_id: ORG }] },
      permissions: ["sales.read"],
    })
    withIlike(service)
    return service
  }

  test("a community with more lots than the picker shows says so instead of dropping the tail silently", async () => {
    const service = harness(lots(620))

    const result = await service.run(() => listSellableLots(COMMUNITY))

    assert.equal(result.lots.length, 500)
    assert.equal(result.truncated, true)
  })

  test("searching by lot number reaches lots past the cap", async () => {
    const service = harness(lots(620))

    const result = await service.run(() => listSellableLots(COMMUNITY, "0610"))

    assert.deepEqual(result.lots.map((lot) => lot.lotNumber), ["0610"])
    assert.equal(result.truncated, false)
  })
})

describe("convertHoldToReservation (live path)", () => {
  const LOT = id(31)
  const BUYER = id(32)
  const DIVISION = id(33)
  const STAMP = "2026-10-01T00:00:00+00:00"

  function harness({ lotStatus = "developed", lotProject = null } = {}) {
    created.homes.length = 0
    created.invoices.length = 0
    const lot = { id: LOT, org_id: ORG, community_id: COMMUNITY, division_id: DIVISION, lot_number: "47", status: lotStatus, project_id: lotProject, updated_at: STAMP }
    return createServiceHarness({
      permissions: ["sales.manage"],
      tables: {
        lot_reservations: [
          { id: RESERVATION, org_id: ORG, lot_id: LOT, community_id: COMMUNITY, buyer_contact_id: BUYER, co_buyer_contact_id: null, prospect_id: null, status: "hold", expires_at: new Date(Date.now() + 86_400_000).toISOString(), updated_at: STAMP, deposit_invoice_id: null, contract_id: null, lot },
        ],
        lots: [lot],
        communities: [{ id: COMMUNITY, org_id: ORG, division_id: DIVISION, updated_at: STAMP }],
        contacts: [{ id: BUYER, org_id: ORG, full_name: "Pat Buyer", email: "pat@example.com", updated_at: STAMP }],
        invoices: [],
        contracts: [],
        projects: [],
      },
    })
  }
  const convert = (service, depositCents = 500_001) => service.run(() => convertHoldToReservation({ reservationId: RESERVATION, depositCents }))

  test("a hold converts to a reservation with one home and the exact deposit", async () => {
    const service = harness()
    const reservation = await convert(service)
    assert.equal(reservation.status, "reserved")
    assert.equal(created.homes.length, 1)
    assert.equal(created.invoices.length, 1)
    assert.equal(created.invoices[0].input.lines[0].unit_cost, 5000.01)
    assert.equal(service.db.lot_reservations[0].deposit_required_cents, 500_001)
    assert.equal(service.db.lots[0].project_id, HOME_ID)
  })

  test("two conversions racing on one hold build one home and issue one deposit", async () => {
    const service = harness()
    const outcomes = await Promise.allSettled([convert(service), convert(service)])
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1)
    assert.equal(created.homes.length, 1)
    assert.equal(created.invoices.length, 1)
  })

  test("a hold that changed after it was read stops before anything is created", async () => {
    const service = harness()
    service.tamper("lot_reservations", (result) => ({ ...result, data: null }), { on: "update" })
    await assert.rejects(convert(service), /already converted, released or changed/)
    assert.equal(created.homes.length, 0)
    assert.equal(created.invoices.length, 0)
  })

  test("reserving an undeveloped lot does not mark its land assigned", async () => {
    for (const [lotStatus, expected] of [["owned", "owned"], ["developed", "assigned"]]) {
      const service = harness({ lotStatus })
      await convert(service)
      assert.equal(service.db.lots[0].status, expected)
    }
  })

  test("a zero deposit issues no invoice", async () => {
    const service = harness()
    await convert(service, 0)
    assert.equal(created.invoices.length, 0)
  })

  test("a deposit past the supported amount is refused before any write", async () => {
    const service = harness()
    await assert.rejects(convert(service, Number.MAX_SAFE_INTEGER + 1))
    assert.deepEqual(service.writes(), [])
  })
})

describe("setSpecAskingPrice", () => {
  const LOT = id(41)
  const PLAN = id(42)
  const REPRICED = id(43)

  function harness({ permissions = ["sales.manage"], override = null, reservations = [], contracts = [], projectId = HOME } = {}) {
    return createServiceHarness({
      permissions,
      tables: {
        lots: [{ id: LOT, org_id: ORG, community_id: COMMUNITY, status: "started", premium_cents: 10_000_00, asking_price_override_cents: override, project_id: projectId, house_plan_id: PLAN, house_plan_elevation_id: null, metadata: {}, updated_at: "2026-10-01T00:00:00+00:00" }],
        community_plan_availability: [{ id: REPRICED, org_id: ORG, community_id: COMMUNITY, house_plan_id: PLAN, elevation_id: null, is_available: true, base_price_cents: 400_000_00 }],
        project_selections: [],
        lot_reservations: reservations,
        contracts,
        communities: [{ id: COMMUNITY, org_id: ORG }],
      },
    })
  }
  const reprice = (service, patch = {}) =>
    service.run(() => setSpecAskingPrice({ lotId: LOT, askingPriceCents: 395_000_00, expectedAskingPriceCents: 410_000_00, reason: "Standing 110 days; match the comparable", ...patch }))

  test("a manager moves a standing spec's asking price and the move is on the record", async () => {
    const service = harness()
    assert.deepEqual(await reprice(service), { lotId: LOT, askingPriceCents: 395_000_00 })
    assert.equal(service.db.lots[0].asking_price_override_cents, 395_000_00)
    assert.equal(service.db.lots[0].metadata.last_price_change.previous_asking_price_cents, 410_000_00)
    assert.equal(service.db.lots[0].metadata.last_price_change.reason, "Standing 110 days; match the comparable")
    assert.deepEqual(service.audits.map((entry) => [entry.before.asking_price_cents, entry.after.asking_price_cents]), [[410_000_00, 395_000_00]])
    assert.deepEqual(service.events.map((event) => event.eventType), ["spec_home.repriced"])
  })

  test("clearing the override returns the home to its plan-sheet price", async () => {
    const service = harness({ override: 395_000_00 })
    const result = await reprice(service, { askingPriceCents: null, expectedAskingPriceCents: 395_000_00 })
    assert.equal(result.askingPriceCents, 410_000_00)
    assert.equal(service.db.lots[0].asking_price_override_cents, null)
  })

  test("a price the manager did not see is not overwritten", async () => {
    const service = harness({ override: 405_000_00 })
    await assert.rejects(reprice(service), /asking price changed/)
    assert.deepEqual(service.writes(), [])
  })

  test("a home that is reserved or under agreement keeps the agreement's price", async () => {
    const held = harness({ reservations: [{ id: RESERVATION, org_id: ORG, lot_id: LOT, status: "reserved", expires_at: null }] })
    await assert.rejects(reprice(held), /reserved or under agreement/)
    const sold = harness({ contracts: [{ id: CONTRACT, org_id: ORG, project_id: HOME, contract_type: "purchase_agreement", status: "active" }] })
    await assert.rejects(reprice(sold), /reserved or under agreement/)
    assert.deepEqual(held.writes().concat(sold.writes()), [])
  })

  test("a reason is required and a reader cannot reprice", async () => {
    await assert.rejects(reprice(harness(), { reason: "cheaper" }), /at least 10 characters/)
    await assert.rejects(reprice(harness({ permissions: ["sales.read"] })), /Missing permission/)
  })
})
