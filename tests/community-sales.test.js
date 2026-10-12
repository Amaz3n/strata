"use strict"

/**
 * `lib/services/community-sales.ts` — the sales manager's moves on a community:
 * repricing the sheet, converting a hold into a reservation, repricing one
 * standing spec, and voiding a signed sale.
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, replies, id, ORG, ACTOR } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")
const { withIlike } = require("./support/postgrest-extras")
const { specPricingRpc } = require("./support/spec-pricing")

// Building a home, issuing an invoice and reversing a payment have their own suites;
// here a refund is recorded so a test can prove how many a release made.
const refunds = []
stubModule("@/lib/services/projects", {})
stubModule("@/lib/services/invoices", { createInvoice: async () => ({ id: id(77) }) })
stubModule("@/lib/services/payments", {
  recordPaymentReversal: async (request) => {
    refunds.push(request)
  },
})

/**
 * `release_lot_reservation`'s contract as the service sees it: one guarded
 * transition, and a second caller finds nothing live to release.
 */
function releaseLotReservation({ p_reservation_id, p_reason, p_deposit_disposition }, store) {
  const row = store.lot_reservations.find((reservation) => reservation.id === p_reservation_id)
  if (!row || !["hold", "reserved", "converted"].includes(row.status)) return { data: null, error: { message: "Live reservation not found" } }
  const before = { ...row }
  Object.assign(row, { status: "released", release_reason: p_reason, metadata: { ...row.metadata, deposit_disposition: p_deposit_disposition } })
  return { data: { before, after: { ...row } }, error: null }
}

const { bulkRepriceCommunityPlans, createLotHold, createLotHoldFromProspect, priceAgreementDraft, registerReservationConversion, releaseReservation, executePurchaseAgreementFromEnvelopeExecution, searchOfferablePlans, listSellableLots, listSpecInventoryPage, proposeSpecPriceChange, decideSpecPriceChange, voidPurchaseAgreement } =
  freshRequire("lib/services/community-sales.ts")

const COMMUNITY = id(1)
const HOME = id(2)
const CONTRACT = id(3)
const RESERVATION = id(4)
const LEAD = id(5)
const TOKEN = id(6)

/**
 * The rows `sellable_lot_inventory` would hold for these lots. The view derives price and
 * age in SQL, so a test states the two facts it cares about per lot instead of re-deriving them.
 */
function inventoryView(lots, facts = {}) {
  return lots.map((lot) => ({
    lot_id: lot.id, org_id: lot.org_id, community_id: lot.community_id, division_id: lot.division_id ?? null, project_id: lot.project_id,
    status: lot.status, lot_number: lot.lot_number, block: lot.block ?? null, lot_label: lot.block ? `${lot.block}-${lot.lot_number}` : lot.lot_number, house_plan_id: lot.house_plan_id, created_at: lot.created_at ?? "2026-10-01T00:00:00Z",
    community_name: lot.community?.name ?? null, plan_code: null, plan_name: lot.plan?.name ?? null, plan_beds: lot.plan?.beds ?? null,
    asking_price_cents: null, aging_days: 0, ...facts[lot.id],
  }))
}

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

describe("a reprice run that stops part-way", () => {
  const { startRepriceRun, nextRepriceSlice, completeRepriceSlice, repriceRunRemaining } = freshRequire("lib/sales/reprice-run.ts")
  const targets = Array.from({ length: 5 }, (_, index) => ({ availabilityId: id(index + 1), basisCents: 400_000_00 + index }))

  test("resumes with only the slices that did not complete, at the original prices", () => {
    let run = startRepriceRun({ mode: "percent", value: 2 }, targets)
    const first = nextRepriceSlice(run, 2)
    assert.deepEqual(first.map((target) => target.availabilityId), [id(1), id(2)])
    run = completeRepriceSlice(run, first)

    // The next slice fails; a retry asks again and gets the same one, unchanged.
    const retry = nextRepriceSlice(run, 2)
    assert.deepEqual(retry, targets.slice(2, 4))
    assert.equal(repriceRunRemaining(run), 3)

    run = completeRepriceSlice(run, retry)
    assert.deepEqual(nextRepriceSlice(run, 2), targets.slice(4))
    run = completeRepriceSlice(run, targets.slice(4))
    assert.deepEqual(nextRepriceSlice(run, 2), [])
    assert.equal(repriceRunRemaining(run), 0)
  })
})

describe("voidPurchaseAgreement", () => {
  function harness({ permissions = ["sales.manage", "project.manage"] } = {}) {
    return createServiceHarness({
      permissions,
      rpc: { release_lot_reservation: releaseLotReservation },
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
    assert.equal(service.db.prospects[0].won_at, null)
    assert.equal(service.db.closings[0].status, "cancelled")
    assert.equal(service.db.project_selections[0].locked_at, null)
    assert.equal(service.db.projects[0].client_id, null)
    assert.notEqual(service.db.portal_access_tokens[0].revoked_at, null)
    assert.equal(service.db.external_identity_grants[0].status, "revoked")
    assert.deepEqual(
      service.audits.map((entry) => [entry.entityType, entry.after.status]),
      [["lot_reservation", "released"], ["contract", "void"]],
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

describe("listSpecInventoryPage standing-spec age", () => {
  const today = new Date()
  const daysAgo = (days) => new Date(today.getTime() - days * 86_400_000).toISOString().slice(0, 10)
  const daysAhead = (days) => daysAgo(-days)
  const spec = (n, status, endDate, completedOn = null) => ({
    id: id(2000 + n), org_id: ORG, community_id: COMMUNITY, lot_number: String(n), status: "started", premium_cents: 0, asking_price_override_cents: null,
    project_id: id(3000 + n), house_plan_id: null, house_plan_elevation_id: null,
    project: { id: id(3000 + n), name: `Home ${n}`, start_date: daysAgo(200), end_date: endDate, status, completed_on: completedOn }, plan: null, community: { name: "Oak Ridge" },
  })
  const completion = (n, completedOn) => ({ org_id: ORG, project_id: id(3000 + n), books_inventory_completed_on: completedOn })
  const ages = async (lots, completions) => {
    const service = createServiceHarness({
      permissions: ["sales.read"],
      tables: { lots, sellable_lot_inventory: inventoryView(lots), lot_reservations: [], contracts: [], communities: [{ id: COMMUNITY, org_id: ORG }], community_plan_availability: [], project_selections: [], project_financial_settings: completions },
    })
    const { lots: rows } = await service.run(() => listSpecInventoryPage({ communityId: COMMUNITY }))
    return Object.fromEntries(rows.map((row) => [row.lotLabel, [row.agingDays, row.completedAt, row.underConstruction]]))
  }

  test("a home ages from the day it was recorded complete and never from its scheduled end", async () => {
    const result = await ages(
      [
        spec(1, "completed", daysAgo(150)),
        spec(2, "completed", daysAgo(150)),
        spec(3, "active", daysAgo(150)),
        spec(4, "active", daysAhead(30)),
        spec(5, "active", daysAgo(150)),
      ],
      [completion(1, daysAgo(45)), completion(4, daysAhead(10)), completion(5, daysAgo(10))],
    )
    assert.deepEqual(result, {
      1: [45, daysAgo(45), false], // recorded completion starts the clock, not the end date 150 days ago
      2: [0, null, false], // completed on paper with no recorded date: no age, however old its end date
      3: [0, null, true], // still building past its projected end: not stale stock
      4: [0, null, true], // completion recorded for a day that has not arrived does not start the clock
      5: [10, daysAgo(10), false],
    })
  })

  test("a finished home Books does not carry ages from the completion sales recorded, and Books' date wins", async () => {
    const result = await ages(
      [spec(6, "completed", daysAgo(150), daysAgo(30)), spec(7, "completed", daysAgo(150), daysAgo(30)), spec(8, "active", daysAgo(150), daysAhead(5))],
      [completion(7, daysAgo(60))],
    )
    assert.deepEqual(result, {
      6: [30, daysAgo(30), false],
      7: [60, daysAgo(60), false],
      8: [0, null, true], // a recorded completion that has not arrived does not start the clock
    })
  })
})

describe("listSpecInventoryPage as the Find a home search", () => {
  const OAK = id(61)
  const MAPLE = id(62)
  const OAK_DIVISION = id(63)
  const MAPLE_DIVISION = id(64)
  const ASPEN = id(65)
  const BIRCH = id(66)
  const plans = [
    { id: ASPEN, org_id: ORG, code: "A100", name: "Aspen" },
    { id: BIRCH, org_id: ORG, code: "B200", name: "Birch" },
  ]
  const communities = [
    { id: OAK, org_id: ORG, name: "Oak Ridge", division_id: OAK_DIVISION },
    { id: MAPLE, org_id: ORG, name: "Maple Glen", division_id: MAPLE_DIVISION },
  ]
  const lot = (n, community, planId, patch = {}) => ({
    id: id(4000 + n), org_id: ORG, community_id: community.id, division_id: community.division_id, lot_number: String(n).padStart(3, "0"), block: null,
    status: "developed", premium_cents: 0, asking_price_override_cents: null, project_id: null, house_plan_id: planId, house_plan_elevation_id: null,
    project: null, plan: { name: plans.find((entry) => entry.id === planId)?.name ?? null, beds: planId === ASPEN ? 3 : 5 }, community: { name: community.name }, created_at: "2026-10-01T00:00:00Z", ...patch,
  })
  const harness = (lots, options = {}) =>
    createServiceHarness({
      permissions: ["sales.read"],
      tables: { lots, sellable_lot_inventory: inventoryView(lots, options.facts), lot_reservations: options.reservations ?? [], contracts: [], communities, house_plans: plans, community_plan_availability: [], project_selections: [], project_financial_settings: [] },
      ...options.access,
    })
  const find = (service, opts) => service.run(() => listSpecInventoryPage({ includeToBeBuilt: true, order: "lot", ...opts }))
  const labels = (page) => page.lots.map((entry) => entry.lotLabel)

  test("a typed search reaches a lot by its number, its plan or its community and nothing else", async () => {
    const service = harness([lot(101, communities[0], ASPEN), lot(102, communities[0], BIRCH), lot(7, communities[1], ASPEN)])
    assert.deepEqual(labels(await find(service, { search: "102" })), ["102"])
    assert.deepEqual(labels(await find(service, { search: "birch" })), ["102"])
    assert.deepEqual(labels(await find(service, { search: "maple" })), ["007"])
    assert.deepEqual(labels(await find(service, { search: "aspen" })).sort(), ["007", "101"])
    assert.deepEqual(labels(await find(service, { search: "zzz" })), [])
  })

  test("a lot is found by the label the screen shows, block and number together", async () => {
    const service = harness([lot(12, communities[0], ASPEN, { block: "A", lot_number: "12" }), lot(13, communities[0], ASPEN, { block: "B" }), lot(14, communities[1], ASPEN, { lot_number: "12" })])
    assert.deepEqual(labels(await find(service, { search: "A-12" })), ["A-12"])
    assert.deepEqual(labels(await find(service, { search: "B-013" })), ["B-013"])
  })

  test("quotes and wildcards in a search are matched as text, never as filter syntax", async () => {
    const service = harness([lot(1, communities[0], ASPEN)])
    assert.deepEqual(labels(await find(service, { search: 'oak"),lot_number.ilike.(*' })), [])
    assert.deepEqual(labels(await find(service, { search: "*" })), ["001"])
  })

  test("a page never comes back empty while lots remain behind a long run of held ones", async () => {
    const lots = Array.from({ length: 30 }, (_, index) => lot(index + 1, communities[0], ASPEN))
    const held = lots.slice(0, 29).map((entry) => ({ lot_id: entry.id, org_id: ORG, status: "hold", expires_at: null }))
    const service = harness(lots, { reservations: held })
    const page = await find(service, { limit: 2 })
    assert.deepEqual(labels(page), ["030"])
    assert.deepEqual([page.truncated, page.nextOffset], [false, null])
  })

  test("availability and bedroom filters narrow on the server", async () => {
    const service = harness([lot(1, communities[0], ASPEN), lot(2, communities[0], BIRCH, { project_id: id(9001), project: { id: id(9001), name: "Spec", start_date: "2026-08-01", status: "active" } })])
    assert.deepEqual(labels(await find(service, { availability: "spec" })), ["002"])
    assert.deepEqual(labels(await find(service, { availability: "tbb" })), ["001"])
    assert.deepEqual(labels(await find(service, { minBeds: 4 })), ["002"])
  })

  test("a page says how much it left out and the next page starts where it stopped", async () => {
    const service = harness(Array.from({ length: 120 }, (_, index) => lot(index + 1, communities[0], ASPEN)))

    const first = await find(service, { limit: 50 })
    assert.deepEqual([first.lots.length, first.truncated, first.total, first.nextOffset], [50, true, 120, 50])
    const second = await find(service, { limit: 50, offset: first.nextOffset })
    assert.deepEqual([second.lots.length, second.truncated, second.nextOffset], [50, true, 100])
    const third = await find(service, { limit: 50, offset: second.nextOffset })
    assert.deepEqual([third.lots.length, third.truncated, third.nextOffset], [20, false, null])
    assert.equal(new Set([...first.lots, ...second.lots, ...third.lots].map((entry) => entry.lotId)).size, 120)
  })

  test("held lots come off the page without cutting it short or being skipped on the next one", async () => {
    const lots = Array.from({ length: 10 }, (_, index) => lot(index + 1, communities[0], ASPEN))
    const held = [1, 2, 3, 4].map((n) => ({ lot_id: id(4000 + n), org_id: ORG, status: "hold", expires_at: null }))
    const service = harness(lots, { reservations: held })

    const first = await find(service, { limit: 5 })
    assert.deepEqual(labels(first), ["005", "006", "007", "008", "009"])
    assert.deepEqual([first.truncated, first.nextOffset], [true, 9])
    const second = await find(service, { limit: 5, offset: first.nextOffset })
    assert.deepEqual(labels(second), ["010"])
    assert.deepEqual([second.truncated, second.nextOffset], [false, null])
  })

  test("a price band keeps only homes the sheet prices inside it, and pages stay honest under it", async () => {
    const lots = Array.from({ length: 8 }, (_, index) => lot(index + 1, communities[0], ASPEN))
    const facts = Object.fromEntries(lots.map((entry, index) => [entry.id, { asking_price_cents: index === 7 ? null : (300 + index * 25) * 100_000 }]))
    const service = harness(lots, { facts })

    const band = await find(service, { minPriceCents: 400_00000, maxPriceCents: 460_00000, limit: 2 })
    assert.deepEqual(labels(band), ["005", "006"])
    assert.deepEqual([band.total, band.truncated], [3, true])
    const rest = await find(service, { minPriceCents: 400_00000, maxPriceCents: 460_00000, limit: 2, offset: band.nextOffset })
    assert.deepEqual([labels(rest), rest.truncated], [["007"], false])
    assert.equal(labels(await find(service, { minPriceCents: 0 })).includes("008"), false) // unpriced is in no band
  })

  test("homes sort by price either way, and the longest-standing finished homes come first", async () => {
    const lots = [lot(1, communities[0], ASPEN), lot(2, communities[0], ASPEN), lot(3, communities[0], ASPEN)]
    const facts = {
      [lots[0].id]: { asking_price_cents: 450_000_00, aging_days: 12 },
      [lots[1].id]: { asking_price_cents: 350_000_00, aging_days: 95 },
      [lots[2].id]: { asking_price_cents: 400_000_00, aging_days: 0 },
    }
    const service = harness(lots, { facts })
    assert.deepEqual(labels(await find(service, { order: "price_asc" })), ["002", "003", "001"])
    assert.deepEqual(labels(await find(service, { order: "price_desc" })), ["001", "003", "002"])
    assert.deepEqual(labels(await find(service, { order: "aging" })), ["002", "001", "003"])
  })

  test("a division-limited seller never sees another division's lots, however they search", async () => {
    const lots = [lot(1, communities[0], ASPEN), lot(2, communities[1], ASPEN)]
    const service = harness(lots, { access: { divisions: [OAK_DIVISION] } })
    assert.deepEqual(labels(await find(service, {})), ["001"])
    assert.deepEqual(labels(await find(service, { search: "aspen" })), ["001"])
    assert.deepEqual(labels(await find(service, { search: "maple" })), [])
    assert.deepEqual(await find(service, { divisionId: MAPLE_DIVISION }), { lots: [], truncated: false, total: 0, nextOffset: null })
  })

  test("another organization's lots are never searched", async () => {
    const service = harness([lot(1, communities[0], ASPEN), lot(2, communities[0], ASPEN, { org_id: id(999) })])
    assert.deepEqual(labels(await find(service, { search: "aspen" })), ["001"])
  })
})

describe("a spec home's asking price", () => {
  const lot = { id: id(72), org_id: ORG, community_id: COMMUNITY, lot_number: "7", status: "started", premium_cents: 10_000_00, asking_price_override_cents: null, project_id: id(73), house_plan_id: id(70), house_plan_elevation_id: null, project: { id: id(73), name: "Home", start_date: "2026-09-01", status: "active" }, plan: null, community: { name: "Oak Ridge" } }
  const harness = (facts) =>
    createServiceHarness({
      permissions: ["sales.read"],
      tables: { lots: [lot], sellable_lot_inventory: inventoryView([lot], { [lot.id]: facts }), lot_reservations: [], contracts: [], communities: [{ id: COMMUNITY, org_id: ORG }], project_financial_settings: [] },
    })

  test("Find a home shows the price the database derives, so it is the price the band and sort used", async () => {
    const { lots } = await harness({ asking_price_cents: 430_000_00 }).run(() => listSpecInventoryPage({ communityId: COMMUNITY }))
    assert.equal(lots[0].askingPriceCents, 430_000_00)
  })

  test("a home the sheet does not price is unpriced rather than zero", async () => {
    const { lots } = await harness({ asking_price_cents: null }).run(() => listSpecInventoryPage({ communityId: COMMUNITY }))
    assert.equal(lots[0].askingPriceCents, null)
  })

  test("an unreadable inventory is an error, not a free home", async () => {
    const service = harness({ asking_price_cents: 430_000_00 })
    service.tamper("sellable_lot_inventory", replies.error("db down"))
    await assert.rejects(service.run(() => listSpecInventoryPage({ communityId: COMMUNITY })), /db down/)
  })
})

describe("executePurchaseAgreementFromEnvelopeExecution", () => {
  const LOT = id(61)
  const GARAGE = id(62)
  const STRUCTURE = id(63)
  const KITCHEN = id(64)
  const ELECTRICAL = id(65)
  const PLAN_VERSION = id(66)

  function harness() {
    const pricing = {
      basePriceCents: 389_000_00, lotPremiumCents: 0, incentives: [], incentivesCents: 0,
      structuralOptions: [{ optionId: GARAGE, label: "Extended garage bay", category: "Structure", priceCents: 18_500_00, source: "option_base", scope: "structural" }],
      designSelections: [], structuralOptionsCents: 18_500_00, designSelectionsCents: 0, totalCents: 407_500_00,
    }
    return createServiceHarness({
      tables: {
        contracts: [{ id: CONTRACT, org_id: ORG, project_id: HOME, contract_type: "purchase_agreement", status: "draft", signed_at: null, signature_data: {}, buyer_contact_id: null, snapshot: { purchase_agreement: { pricing } }, project: { end_date: null } }],
        lots: [{ id: LOT, org_id: ORG, project_id: HOME, community_id: COMMUNITY, house_plan_version_id: PLAN_VERSION, status: "assigned" }],
        lot_reservations: [], prospects: [], closings: [], selection_groups: [], selection_catalog_prices: [],
        selection_categories: [{ id: STRUCTURE, org_id: ORG, parent_category_id: null, community_id: null, is_archived: false }],
        selection_options: [{ id: GARAGE, org_id: ORG, category_id: STRUCTURE, parent_option_id: null, community_id: null, is_archived: false, is_available: true, price_cents: 18_500_00, cost_cents: 11_000_00, cost_code_id: null, vendor: null, sku: "ST-GAR", lead_time_days: null }],
        project_selections: [
          { id: id(67), org_id: ORG, project_id: HOME, category_id: KITCHEN, status: "pending", selected_option_id: null, locked_at: null },
          { id: id(68), org_id: ORG, project_id: HOME, category_id: ELECTRICAL, status: "confirmed", selected_option_id: id(69), locked_at: null },
        ],
      },
    })
  }
  const execute = (service) => service.run(() => executePurchaseAgreementFromEnvelopeExecution({ orgId: ORG, contractId: CONTRACT, envelopeId: id(70) }))
  const selection = (service, categoryId) => service.db.project_selections.find((row) => row.category_id === categoryId)

  test("signing makes each structural option a confirmed, locked selection purchasing will buy", async () => {
    const service = harness()
    await execute(service)
    const garage = selection(service, STRUCTURE)
    assert.equal(garage.selected_option_id, GARAGE)
    assert.equal(garage.status, "confirmed")
    assert.ok(garage.locked_at)
    assert.equal(garage.price_cents_snapshot, 18_500_00)
    assert.equal(garage.cost_cents_snapshot, 11_000_00)
  })

  test("signing leaves design choices open until their cutoff and locks only what is already decided", async () => {
    const service = harness()
    await execute(service)
    assert.equal(selection(service, KITCHEN).locked_at, null)
    assert.ok(selection(service, ELECTRICAL).locked_at)
  })
})

describe("searchOfferablePlans", () => {
  const released = [{ status: "released" }]
  const plan = (n, status, versions = released) => ({ id: id(n), org_id: ORG, code: `P${n}`, name: `Plan ${n}`, status, versions })
  const harness = (plans, extra = {}) =>
    createServiceHarness({
      strictRanges: true,
      permissions: ["sales.read"],
      tables: {
        communities: [{ id: COMMUNITY, org_id: ORG, division_id: null }],
        community_plan_availability: [{ org_id: ORG, community_id: COMMUNITY, house_plan_id: id(44), is_available: true }],
        house_plans: plans,
        ...extra,
      },
    })
  const names = (page) => page.plans.map((row) => row.name)

  test("a page past the last plan is empty, not an error, and the total stays true", async () => {
    const service = harness([plan(41, "active"), plan(42, "active")])
    const page = await service.run(() => searchOfferablePlans(COMMUNITY, { pageSize: 25, page: 2 }))
    assert.deepEqual([page.plans, page.total], [[], 2])
  })

  test("a community is offered every released plan it does not sell yet, never a retired one", async () => {
    const service = harness([plan(41, "active"), plan(42, "retired"), plan(43, "draft", [{ status: "draft" }]), plan(44, "active")])
    assert.deepEqual(names(await service.run(() => searchOfferablePlans(COMMUNITY))), ["Plan 41"])
  })

  test("a search finds a plan past the first page and a page says when there is more", async () => {
    const service = harness(Array.from({ length: 60 }, (_, index) => plan(100 + index, "active")))

    const first = await service.run(() => searchOfferablePlans(COMMUNITY, { pageSize: 25 }))
    const third = await service.run(() => searchOfferablePlans(COMMUNITY, { pageSize: 25, page: 3 }))
    assert.deepEqual([first.plans.length, first.total, third.plans.length], [25, 60, 10])
    assert.deepEqual(names(await service.run(() => searchOfferablePlans(COMMUNITY, { search: "plan 159" }))), ["Plan 159"])
  })
})

describe("createLotHoldFromProspect", () => {
  const LOT = id(31)
  const PROSPECT = id(35)
  const PROMOTED = id(36)
  const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString()

  function harness({ prospect = {}, lotStatus = "developed", promoted = PROMOTED, contacts = [{ id: PROMOTED, org_id: ORG, full_name: "Pat Buyer", email: "pat@example.com" }] } = {}) {
    return createServiceHarness({
      permissions: ["sales.manage"],
      tables: {
        prospects: [{ id: PROSPECT, org_id: ORG, name: "Pat Buyer", status: "active", community_id: COMMUNITY, ...prospect }],
        prospect_contacts: [{ id: id(37), org_id: ORG, prospect_id: PROSPECT, full_name: "Pat Buyer", email: "pat@example.com", phone: null, role: null, is_primary: true, promoted_contact_id: promoted, created_at: "2026-10-01T00:00:00Z" }],
        lots: [{ id: LOT, org_id: ORG, community_id: COMMUNITY, status: lotStatus, premium_cents: 5_000_00, asking_price_override_cents: null, project_id: null, house_plan_id: null, house_plan_elevation_id: null, lot_number: "47" }],
        lot_reservations: [],
        contacts,
      },
    })
  }
  const hold = (service) => service.run(() => createLotHoldFromProspect({ prospectId: PROSPECT, lotId: LOT, expiresAt }))

  test("a prospect's hold names the buyer and the prospect it came from, and is on the record", async () => {
    const service = harness()
    const reservation = await hold(service)

    const [row] = service.db.lot_reservations
    assert.deepEqual([row.status, row.buyer_contact_id, row.prospect_id, row.lot_id, row.expires_at], ["hold", PROMOTED, PROSPECT, LOT, expiresAt])
    assert.equal(row.asking_price_cents, null) // a lot with no priced plan holds unpriced, not at its premium alone
    assert.equal(reservation.id, row.id)
    assert.deepEqual(service.events.map((event) => event.eventType), ["lot_hold_created"])
    assert.deepEqual(service.audits.map((audit) => [audit.entityType, audit.entityId]), [["lot_reservation", row.id]])
  })

  test("a buyer already in the directory under another spelling of their email is held for, not created again", async () => {
    const service = harness({
      promoted: null,
      contacts: [
        { id: id(38), org_id: ORG, full_name: "Pat Buyer", email: "PAT@Example.com", created_at: "2026-09-01T00:00:00Z" },
        { id: id(39), org_id: ORG, full_name: "Pat B.", email: "pat@example.com", created_at: "2026-09-15T00:00:00Z" },
      ],
    })

    await hold(service)

    assert.equal(service.db.lot_reservations[0].buyer_contact_id, id(38))
    assert.equal(service.db.contacts.length, 2)
  })

  test("a closed prospect, a prospect without a contact, or a lot that is not for sale gets no hold", async () => {
    const cases = [
      [{ prospect: { status: "won" } }, /already closed/],
      [{ prospect: { status: "lost" } }, /already closed/],
      [{ lotStatus: "closed" }, /not sellable/],
    ]
    for (const [setup, message] of cases) {
      const service = harness(setup)
      await assert.rejects(hold(service), message)
      assert.deepEqual(service.writes("lot_reservations"), [])
    }
    const service = harness()
    service.db.prospect_contacts.length = 0
    await assert.rejects(hold(service), /Add a contact/)
    assert.deepEqual(service.writes("lot_reservations"), [])
  })

  test("a lot whose home already belongs to another buyer is refused in the database's words", async () => {
    const service = harness()
    const fence = "This lot's home belongs to another buyer. Release that sale before holding the lot."
    service.tamper("lot_reservations", (result) => ({ ...result, data: null, error: { code: "23514", message: fence } }), { on: "insert" })
    await assert.rejects(hold(service), (error) => error.message === fence)
    assert.deepEqual(service.events, [])
  })
})

describe("registerReservationConversion", () => {
  const LOT = id(31)
  const BUYER = id(32)
  const DIVISION = id(33)
  const STAMP = "2026-10-01T00:00:00+00:00"
  const scope = { orgId: ORG, actorId: ACTOR, reservationId: RESERVATION }

  function harness(reservation = {}) {
    const lot = { id: LOT, org_id: ORG, community_id: COMMUNITY, division_id: DIVISION, lot_number: "47", status: "developed", project_id: null, updated_at: STAMP }
    return createServiceHarness({
      permissions: ["sales.manage"],
      rpc: { reservation_conversion: () => ({ data: { scope, latest: null }, error: null }) },
      tables: {
        lot_reservations: [
          { id: RESERVATION, org_id: ORG, lot_id: LOT, community_id: COMMUNITY, buyer_contact_id: BUYER, co_buyer_contact_id: null, prospect_id: null, status: "hold", expires_at: new Date(Date.now() + 86_400_000).toISOString(), updated_at: STAMP, deposit_invoice_id: null, contract_id: null, lot, ...reservation },
        ],
        lots: [lot],
        communities: [{ id: COMMUNITY, org_id: ORG, division_id: DIVISION, updated_at: STAMP }],
        contacts: [{ id: BUYER, org_id: ORG, full_name: "Pat Buyer", email: "pat@example.com", updated_at: STAMP }],
        invoices: [],
      },
    })
  }
  const register = (service) => service.run(() => registerReservationConversion({ scope, requestKey: id(60), input: { reservationId: RESERVATION, depositCents: 500_001 } }))
  // The saved-review probe is the only call that may run: nothing is registered or written.
  const onlyProbed = (service) => service.writes().map((write) => write.payload?.p_action ?? write.action)

  test("an expired hold cannot be reviewed for a reservation", async () => {
    const service = harness({ expires_at: new Date(Date.now() - 1000).toISOString() })
    await assert.rejects(register(service), /hold has expired/)
    assert.deepEqual(onlyProbed(service), ["inspect"])
  })

  test("a hold that is released, or already carries a deposit or an agreement, cannot be reviewed", async () => {
    for (const reservation of [{ status: "released" }, { status: "expired" }, { deposit_invoice_id: id(80) }, { contract_id: id(81) }]) {
      const service = harness(reservation)
      await assert.rejects(register(service), /"hold"|already has a deposit or agreement/, JSON.stringify(reservation))
      assert.deepEqual(onlyProbed(service), ["inspect"], JSON.stringify(reservation))
    }
  })
})

describe("releaseReservation", () => {
  const DEPOSIT = id(51)
  function harness({ permissions = ["sales.manage", "payment.release"] } = {}) {
    refunds.length = 0
    return createServiceHarness({
      permissions,
      rpc: { release_lot_reservation: releaseLotReservation },
      tables: {
        lot_reservations: [{ id: RESERVATION, org_id: ORG, lot_id: id(52), status: "reserved", deposit_invoice_id: DEPOSIT, buyer_contact_id: id(53), contract_id: null, metadata: {}, lot: { project_id: HOME, lot_number: "47" }, buyer: { full_name: "Pat Buyer" } }],
        payments: [{ id: id(54), org_id: ORG, invoice_id: DEPOSIT, amount_cents: 500_000, status: "succeeded" }],
      },
    })
  }
  const release = (service) => service.run(() => releaseReservation({ reservationId: RESERVATION, reason: "Buyer withdrew", depositDisposition: "refund" }))

  test("two releases racing on one reservation refund its deposit once", async () => {
    const service = harness()
    const outcomes = await Promise.allSettled([release(service), release(service)])
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1)
    assert.match(outcomes.find((outcome) => outcome.status === "rejected").reason.message, /Live reservation not found/)
    assert.deepEqual(refunds.map((refund) => [refund.paymentId, refund.amountCents]), [[id(54), 500_000]])
    assert.equal(service.events.filter((event) => event.eventType === "lot_reservation_released").length, 1)
    assert.deepEqual(service.audits.map((audit) => [audit.entityType, audit.before.status, audit.after.status]), [["lot_reservation", "reserved", "released"]])
  })

  test("a release that would move the deposit needs payment authority before the reservation is touched", async () => {
    const service = harness({ permissions: ["sales.manage"] })
    await assert.rejects(release(service), /Missing permission/)
    assert.equal(service.queries.some((query) => query.table === "rpc:release_lot_reservation"), false)
    assert.equal(service.db.lot_reservations[0].status, "reserved")
    assert.deepEqual(refunds, [])
  })
})

describe("a standing spec's price and incentive moves", () => {
  const LOT = id(41)
  const PLAN = id(42)
  const MANAGER = id(43)
  const STAMP = "2026-10-01T00:00:00+00:00"
  const REASON = "Standing 110 days; match the comparable"

  function harness({ permissions = ["sales.manage"], userId, reservations = [], contracts = [], proposals = [], dispositions = [], bands } = {}) {
    const actor = userId ?? ACTOR
    return createServiceHarness({
      permissions,
      userId: actor,
      rpc: specPricingRpc(actor),
      tables: {
        lots: [{ id: LOT, org_id: ORG, community_id: COMMUNITY, status: "started", premium_cents: 10_000_00, asking_price_override_cents: null, project_id: HOME, house_plan_id: PLAN, house_plan_elevation_id: null, metadata: {}, updated_at: STAMP }],
        sellable_lot_inventory: [{ lot_id: LOT, org_id: ORG, asking_price_cents: 410_000_00 }],
        lot_reservations: reservations,
        contracts,
        communities: [{ id: COMMUNITY, org_id: ORG }],
        spec_price_proposals: proposals,
        spec_dispositions: dispositions,
        org_settings: bands ? [{ org_id: ORG, settings: { spec_price_approval_bands: bands } }] : [],
        home_margin_baselines: [{ id: id(44), org_id: ORG, project_id: HOME, sale_price_cents: 405_000_00 }],
      },
    })
  }
  const move = (service, patch = {}) =>
    service.run(() => proposeSpecPriceChange({ kind: "price", lotId: LOT, toCents: 402_000_00, expectedAskingPriceCents: 410_000_00, reason: REASON, ...patch }))
  const waiting = (patch = {}) => ({
    id: id(45), org_id: ORG, lot_id: LOT, project_id: HOME, community_id: COMMUNITY, kind: "price", status: "proposed",
    asking_price_cents: 410_000_00, from_cents: 410_000_00, to_cents: 380_000_00, incentive_expires_on: null,
    required_permission: "sales.price_approve", proposed_by: ACTOR, proposed_at: "2026-10-02T00:00:00Z", decided_at: null, reason: REASON, ...patch,
  })
  const decide = (service, approve = true) => service.run(() => decideSpecPriceChange({ proposalId: id(45), approve }))

  test("a move inside the band applies at once and is kept as the home's price history", async () => {
    const service = harness()
    const result = await move(service)
    assert.equal(result.status, "applied")
    assert.equal(service.db.lots[0].asking_price_override_cents, 402_000_00)
    assert.deepEqual(service.db.spec_price_proposals.map((row) => [row.status, row.from_cents, row.to_cents, row.reason]), [["applied", 410_000_00, 402_000_00, REASON]])
    assert.deepEqual(service.events.map((event) => event.eventType), ["spec_home.repriced"])
  })

  test("a move past 5% or past $10,000 waits for approval and leaves the price alone", async () => {
    for (const toCents of [389_000_00, 399_000_00]) {
      const service = harness()
      const result = await move(service, { toCents })
      assert.equal(result.status, "proposed", String(toCents))
      assert.equal(result.requiredPermission, "sales.price_approve")
      assert.equal(service.db.lots[0].asking_price_override_cents, null)
      assert.deepEqual(service.events.map((event) => event.eventType), ["spec_home.price_change_proposed"])
    }
  })

  test("an organization's own band decides what needs approval", async () => {
    const service = harness({ bands: [{ up_to_percent: 1, up_to_cents: 500_000, permission: "sales.manage" }, { up_to_percent: null, up_to_cents: null, permission: "sales.price_approve" }] })
    assert.equal((await move(service)).status, "proposed")
  })

  test("a home's incentive moves through the same band", async () => {
    const service = harness()
    const result = await move(service, { kind: "incentive", toCents: 5_000_00, expectedIncentiveCents: 0, expiresOn: null })
    assert.equal(result.status, "applied")
    assert.equal(result.incentiveCents, 5_000_00)
    assert.equal(service.db.lots[0].asking_price_override_cents, null)
    const large = harness()
    assert.equal((await move(large, { kind: "incentive", toCents: 25_000_00, expectedIncentiveCents: 0, expiresOn: null })).status, "proposed")
  })

  test("a price the manager did not see is not moved", async () => {
    const service = harness()
    await assert.rejects(move(service, { expectedAskingPriceCents: 415_000_00 }), /asking price changed/)
    assert.deepEqual(service.writes(), [])
  })

  test("a home that is reserved or under agreement keeps the agreement's price", async () => {
    const held = harness({ reservations: [{ id: RESERVATION, org_id: ORG, lot_id: LOT, status: "reserved", expires_at: null }] })
    await assert.rejects(move(held), /reserved or under agreement/)
    const sold = harness({ contracts: [{ id: CONTRACT, org_id: ORG, project_id: HOME, contract_type: "purchase_agreement", status: "active" }] })
    await assert.rejects(move(sold), /reserved or under agreement/)
    assert.deepEqual(held.writes().concat(sold.writes()), [])
  })

  test("a home takes no other move while one waits for approval", async () => {
    const service = harness({ proposals: [waiting()] })
    await assert.rejects(move(service), /waiting for approval/)
    assert.deepEqual(service.writes(), [])
  })

  test("a reason is required and a reader cannot move a price", async () => {
    await assert.rejects(move(harness(), { reason: "cheaper" }), /at least 10 characters/)
    await assert.rejects(move(harness({ permissions: ["sales.read"] })), /Missing permission/)
  })

  test("a second person with the band's permission approves the move and the price changes", async () => {
    const service = harness({ userId: MANAGER, permissions: ["sales.read", "sales.price_approve"], proposals: [waiting()] })
    assert.deepEqual(await decide(service), { proposalId: id(45), status: "approved" })
    assert.equal(service.db.lots[0].asking_price_override_cents, 380_000_00)
    assert.equal(service.db.spec_price_proposals[0].decided_by, MANAGER)
    assert.deepEqual(service.events.map((event) => event.eventType), ["spec_home.price_change_approved"])
  })

  test("the person who proposed a move cannot approve it", async () => {
    const service = harness({ permissions: ["sales.read", "sales.price_approve"], proposals: [waiting()] })
    await assert.rejects(decide(service), /someone other than the person who proposed it/)
    assert.deepEqual(service.writes(), [])
  })

  test("approval needs the permission the band named", async () => {
    const service = harness({ userId: MANAGER, permissions: ["sales.read", "sales.manage"], proposals: [waiting()] })
    await assert.rejects(decide(service), /Missing permission/)
    assert.deepEqual(service.writes(), [])
  })

  test("a move proposed against a price that has since changed is not approved", async () => {
    const service = harness({ userId: MANAGER, permissions: ["sales.read", "sales.price_approve"], proposals: [waiting({ asking_price_cents: 420_000_00, from_cents: 420_000_00 })] })
    await assert.rejects(decide(service), /asking price changed after this was proposed/)
    assert.deepEqual(service.writes(), [])
  })

  test("a move on a home that was reserved meanwhile is not approved, but can be rejected", async () => {
    const reservations = [{ id: RESERVATION, org_id: ORG, lot_id: LOT, status: "reserved", expires_at: null }]
    const approving = harness({ userId: MANAGER, permissions: ["sales.read", "sales.price_approve"], proposals: [waiting()], reservations })
    await assert.rejects(decide(approving), /reserved or under agreement/)
    assert.equal(approving.db.lots[0].asking_price_override_cents, null)
    const rejecting = harness({ userId: MANAGER, permissions: ["sales.read", "sales.price_approve"], proposals: [waiting()], reservations })
    assert.equal((await decide(rejecting, false)).status, "rejected")
    assert.equal(rejecting.db.lots[0].asking_price_override_cents, null)
  })

  test("no move touches a margin baseline, a reservation or an agreement", async () => {
    const service = harness()
    await move(service)
    const approving = harness({ userId: MANAGER, permissions: ["sales.read", "sales.price_approve"], proposals: [waiting()] })
    await decide(approving)
    const touched = [...service.writes(), ...approving.writes()].map((write) => write.table)
    assert.deepEqual([...new Set(touched)], ["rpc:record_spec_price_move", "rpc:decide_spec_price_proposal"])
    assert.equal(approving.db.home_margin_baselines[0].sale_price_cents, 405_000_00)
  })
})

describe("a home under an approved sell-off belongs to the disposition's buyer", () => {
  const LOT = id(61)
  const PLAN = id(62)
  const VERSION = id(63)
  const INVESTOR = id(64)
  const WALK_IN = id(65)
  const DISPOSITION = id(66)
  const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString()

  function harness({ reservations = [], disposition = {}, dispositions, proposals = [] } = {}) {
    return createServiceHarness({
      permissions: ["sales.manage", "sales.read"],
      projects: [HOME],
      tables: {
        lots: [{ id: LOT, org_id: ORG, community_id: COMMUNITY, status: "started", premium_cents: 0, asking_price_override_cents: null, project_id: HOME, house_plan_id: PLAN, house_plan_version_id: VERSION, house_plan_elevation_id: null, swing: "left", lot_number: "61" }],
        communities: [{ id: COMMUNITY, org_id: ORG, division_id: null }],
        projects: [{ id: HOME, org_id: ORG, division_id: null }],
        house_plan_versions: [{ id: VERSION, org_id: ORG, house_plan_id: PLAN, status: "released", label: "v1", plan: { name: "Oak", org_id: ORG } }],
        community_plan_availability: [{ org_id: ORG, community_id: COMMUNITY, house_plan_id: PLAN, elevation_id: null, is_available: true, effective_start: null, effective_end: null, base_price_cents: 320_000_00 }],
        lot_reservations: reservations,
        contracts: [],
        spec_price_proposals: proposals,
        spec_dispositions: dispositions ?? [{ id: DISPOSITION, org_id: ORG, lot_id: LOT, project_id: HOME, community_id: COMMUNITY, kind: "investor_sale", status: "approved", counterparty_contact_id: INVESTOR, price_cents: 300_000_00, carrying_cents: 0, impairment_id: null, ...disposition }],
      },
    })
  }
  const hold = (service, buyerContactId) => service.run(() => createLotHold({ lotId: LOT, buyerContactId, expiresAt }))
  const live = (buyerContactId) => ({ id: id(67), org_id: ORG, lot_id: LOT, status: "reserved", buyer_contact_id: buyerContactId, co_buyer_contact_id: null, expires_at: null, created_at: "2026-10-01T00:00:00Z" })
  const quote = (service) => service.run(() => priceAgreementDraft({ lotId: LOT, optionItems: [], incentiveIds: [] }))

  test("nobody but the named buyer may hold the lot", async () => {
    const service = harness()
    await assert.rejects(hold(service, WALK_IN), /approved investor sale to another buyer/)
    assert.deepEqual(service.writes(), [])
    await hold(service, INVESTOR)
    assert.equal(service.db.lot_reservations[0].buyer_contact_id, INVESTOR)
  })

  test("a proposed sell-off reserves nothing", async () => {
    await hold(harness({ disposition: { status: "proposed" } }), WALK_IN)
  })

  test("the disposition's price is the named buyer's alone, and the agreement carries the disposition", async () => {
    await assert.rejects(quote(harness({ reservations: [live(WALK_IN)] })), /approved investor sale to another buyer/)
    await assert.rejects(quote(harness()), /approved investor sale to another buyer/)

    const priced = await quote(harness({ reservations: [live(INVESTOR)] }))
    assert.equal(priced.totalCents, 300_000_00)
    assert.deepEqual(priced.disposition, { id: DISPOSITION, kind: "investor_sale" })
    // The sale-off is the home's own line; the database counts every `incentives` id against community capacity.
    assert.deepEqual(priced.incentives, [])
    assert.deepEqual(priced.homeAdjustments, [{ kind: "disposition", sourceId: DISPOSITION, label: "Investor sale price (approved disposition)", amountCents: -20_000_00 }])
    assert.equal(priced.homeAdjustmentsCents, -20_000_00)
  })

  test("a spec home's own incentive comes off the price without posing as a community incentive", async () => {
    const PROPOSAL = id(68)
    const priced = await quote(harness({ dispositions: [], proposals: [{
      id: PROPOSAL, org_id: ORG, lot_id: LOT, project_id: HOME, community_id: COMMUNITY, kind: "incentive", status: "applied", asking_price_cents: 320_000_00,
      from_cents: 0, to_cents: 7_500_00, incentive_expires_on: null, required_permission: "sales.manage", proposed_by: ACTOR, proposed_at: "2026-10-01T00:00:00Z", decided_at: null,
    }] }))
    assert.deepEqual(priced.incentives, [])
    assert.equal(priced.incentivesCents, 0)
    assert.deepEqual(priced.homeAdjustments, [{ kind: "home_incentive", sourceId: PROPOSAL, label: "Home incentive", amountCents: -7_500_00 }])
    assert.equal(priced.totalCents, 312_500_00)
    assert.equal(priced.disposition, null)
  })
})
