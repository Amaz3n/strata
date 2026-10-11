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

const { bulkRepriceCommunityPlans, convertHoldToReservation, createLotHoldFromProspect, executePurchaseAgreementFromEnvelopeExecution, searchOfferablePlans, listSellableLots, listSpecInventoryPage, setSpecAskingPrice, voidPurchaseAgreement } =
  freshRequire("lib/services/community-sales.ts")

const COMMUNITY = id(1)
const HOME = id(2)
const CONTRACT = id(3)
const RESERVATION = id(4)
const LEAD = id(5)
const TOKEN = id(6)
const HOME_ID = id(90)

/**
 * The rows `sellable_lot_inventory` would hold for these lots. The view derives price and
 * age in SQL, so a test states the two facts it cares about per lot instead of re-deriving them.
 */
function inventoryView(lots, facts = {}) {
  return lots.map((lot) => ({
    lot_id: lot.id, org_id: lot.org_id, community_id: lot.community_id, division_id: lot.division_id ?? null, project_id: lot.project_id,
    status: lot.status, lot_number: lot.lot_number, block: lot.block ?? null, house_plan_id: lot.house_plan_id, created_at: lot.created_at ?? "2026-10-01T00:00:00Z",
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

describe("listSpecInventoryPage standing-spec age", () => {
  const today = new Date()
  const daysAgo = (days) => new Date(today.getTime() - days * 86_400_000).toISOString().slice(0, 10)
  const daysAhead = (days) => daysAgo(-days)
  const spec = (n, status, endDate) => ({
    id: id(2000 + n), org_id: ORG, community_id: COMMUNITY, lot_number: String(n), status: "started", premium_cents: 0, asking_price_override_cents: null,
    project_id: id(3000 + n), house_plan_id: null, house_plan_elevation_id: null,
    project: { id: id(3000 + n), name: `Home ${n}`, start_date: daysAgo(200), end_date: endDate, status }, plan: null, community: { name: "Oak Ridge" },
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

describe("spec asking price from the community sheet", () => {
  const PLAN = id(70)
  const ELEVATION = id(71)
  const today = new Date().toISOString().slice(0, 10)
  const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
  const lot = { id: id(72), org_id: ORG, community_id: COMMUNITY, lot_number: "7", status: "started", premium_cents: 10_000_00, asking_price_override_cents: null, project_id: id(73), house_plan_id: PLAN, house_plan_elevation_id: ELEVATION, project: { id: id(73), name: "Home", start_date: day(-30), status: "active" }, plan: null, community: { name: "Oak Ridge" } }
  const offer = (n, patch) => ({ id: id(80 + n), org_id: ORG, community_id: COMMUNITY, house_plan_id: PLAN, elevation_id: null, is_available: true, base_price_cents: 400_000_00, effective_start: null, effective_end: null, ...patch })
  const priced = async (sheet) => {
    const service = createServiceHarness({
      permissions: ["sales.read"],
      tables: { lots: [lot], sellable_lot_inventory: inventoryView([lot]), lot_reservations: [], contracts: [], communities: [{ id: COMMUNITY, org_id: ORG }], community_plan_availability: sheet, project_selections: [], project_financial_settings: [] },
    })
    const { lots } = await service.run(() => listSpecInventoryPage({ communityId: COMMUNITY }))
    return lots[0].askingPriceCents
  }

  test("an elevation's own price outranks the plan-wide price and the premium is added", async () => {
    assert.equal(await priced([offer(1, {}), offer(2, { elevation_id: ELEVATION, base_price_cents: 420_000_00 })]), 430_000_00)
  })

  test("a price outside its effective dates does not price the home", async () => {
    assert.equal(await priced([offer(1, { effective_end: day(-1) })]), null)
    assert.equal(await priced([offer(1, { effective_start: day(1) })]), null)
    assert.equal(await priced([offer(1, { effective_start: today, effective_end: today })]), 410_000_00)
  })

  test("a home with no sheet price is unpriced rather than zero", async () => {
    assert.equal(await priced([]), null)
  })

  test("two prices for the same plan and elevation refuse to guess", async () => {
    await assert.rejects(priced([offer(1, {}), offer(2, {})]), /Multiple community prices/)
  })

  test("an unreadable price sheet is an error, not a free home", async () => {
    const service = createServiceHarness({
      permissions: ["sales.manage"],
      tables: { lots: [{ ...lot, updated_at: "2026-10-01T00:00:00+00:00", metadata: {} }], community_plan_availability: [offer(1, {})], project_selections: [], lot_reservations: [], contracts: [], communities: [{ id: COMMUNITY, org_id: ORG }] },
    })
    service.tamper("community_plan_availability", replies.error("db down"))
    await assert.rejects(service.run(() => setSpecAskingPrice({ lotId: lot.id, askingPriceCents: 395_000_00, expectedAskingPriceCents: 410_000_00, reason: "Standing 110 days; match the comparable" })), /db down/)
    assert.deepEqual(service.writes(), [])
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
      permissions: ["sales.read"],
      tables: {
        communities: [{ id: COMMUNITY, org_id: ORG, division_id: null }],
        community_plan_availability: [{ org_id: ORG, community_id: COMMUNITY, house_plan_id: id(44), is_available: true }],
        house_plans: plans,
        ...extra,
      },
    })
  const names = (page) => page.plans.map((row) => row.name)

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
})

describe("convertHoldToReservation (live path)", () => {
  const LOT = id(31)
  const BUYER = id(32)
  const DIVISION = id(33)
  const STAMP = "2026-10-01T00:00:00+00:00"

  function harness({ lotStatus = "developed", lotProject = null, reservation = {} } = {}) {
    created.homes.length = 0
    created.invoices.length = 0
    const lot = { id: LOT, org_id: ORG, community_id: COMMUNITY, division_id: DIVISION, lot_number: "47", status: lotStatus, project_id: lotProject, updated_at: STAMP }
    return createServiceHarness({
      permissions: ["sales.manage"],
      tables: {
        lot_reservations: [
          { id: RESERVATION, org_id: ORG, lot_id: LOT, community_id: COMMUNITY, buyer_contact_id: BUYER, co_buyer_contact_id: null, prospect_id: null, status: "hold", expires_at: new Date(Date.now() + 86_400_000).toISOString(), updated_at: STAMP, deposit_invoice_id: null, contract_id: null, lot, ...reservation },
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

  test("the deposit invoice is addressed to the buyer it bills", async () => {
    const service = harness()
    await convert(service)
    assert.deepEqual(created.invoices[0].input.sent_to_emails, ["pat@example.com"])
    assert.equal(created.invoices[0].input.customer_name, "Pat Buyer")
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

  test("an expired hold cannot become a reservation", async () => {
    const service = harness({ reservation: { expires_at: new Date(Date.now() - 1000).toISOString() } })
    await assert.rejects(convert(service), /hold has expired/)
    assert.deepEqual(service.writes(), [])
    assert.equal(created.homes.length + created.invoices.length, 0)
    assert.equal(service.db.lot_reservations[0].status, "hold")
  })

  test("a hold that is released, or already carries a deposit or an agreement, cannot be reserved", async () => {
    for (const reservation of [{ status: "released" }, { status: "expired" }, { deposit_invoice_id: id(80) }, { contract_id: id(81) }]) {
      const service = harness({ reservation })
      await assert.rejects(convert(service), /"hold"|already has a deposit or agreement/, JSON.stringify(reservation))
      assert.deepEqual(service.writes(), [], JSON.stringify(reservation))
      assert.equal(created.homes.length + created.invoices.length, 0, JSON.stringify(reservation))
    }
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
