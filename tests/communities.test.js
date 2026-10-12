const assert = require("node:assert/strict")
const test = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { closeLotTakedown, createCommunity, createLotTakedown, getCommunityIdentity, sweepTakedownReminders, updateCommunity, updateLotTakedown } = freshRequire("lib/services/communities.ts")

const OTHER_ORG = id(202)
const NORTH = id(204)
const SOUTH = id(205)

const NORTH_COMMUNITY = id(301)
const SOUTH_COMMUNITY = id(302)
const ARCHIVED_COMMUNITY = id(303)
const FOREIGN_COMMUNITY = id(304)

function community(communityId, overrides = {}) {
  return {
    id: communityId,
    org_id: ORG,
    name: `Community ${communityId.slice(-3)}`,
    status: "active",
    planned_lot_count: 40,
    division_id: NORTH,
    archived_at: null,
    ...overrides,
  }
}

function harness({ permissions = ["community.read"], divisions, tables = {} } = {}) {
  return createServiceHarness({
    permissions,
    divisions,
    tables: {
      communities: [
        community(NORTH_COMMUNITY),
        community(SOUTH_COMMUNITY, { division_id: SOUTH }),
        community(ARCHIVED_COMMUNITY, { archived_at: "2026-01-01T00:00:00Z" }),
        community(FOREIGN_COMMUNITY, { org_id: OTHER_ORG }),
      ],
      divisions: [
        { id: NORTH, org_id: ORG, name: "North", archived_at: null },
        { id: SOUTH, org_id: ORG, name: "South", archived_at: null },
      ],
      ...tables,
    },
  })
}

test("a community's identity is its name, status and planned lot count", async () => {
  assert.deepEqual(await harness().run(() => getCommunityIdentity(NORTH_COMMUNITY)), {
    id: NORTH_COMMUNITY,
    name: "Community 301",
    status: "active",
    plannedLotCount: 40,
  })
})

test("archived communities and another organization's communities are not found", async () => {
  const service = harness()
  await assert.rejects(service.run(() => getCommunityIdentity(ARCHIVED_COMMUNITY)), /Community not found/)
  await assert.rejects(service.run(() => getCommunityIdentity(FOREIGN_COMMUNITY)), /Community not found/)
})

test("a division-scoped member cannot read a community outside their divisions", async () => {
  const service = harness({ divisions: [NORTH] })
  assert.equal((await service.run(() => getCommunityIdentity(NORTH_COMMUNITY))).id, NORTH_COMMUNITY)
  await assert.rejects(service.run(() => getCommunityIdentity(SOUTH_COMMUNITY)), /Community not found/)
})

test("a member assigned to no division sees no community at all", async () => {
  await assert.rejects(harness({ divisions: [] }).run(() => getCommunityIdentity(NORTH_COMMUNITY)), /Community not found/)
})

test("a member without community access is refused", async () => {
  await assert.rejects(harness({ permissions: [] }).run(() => getCommunityIdentity(NORTH_COMMUNITY)), /community.read/)
})

test("a division-scoped member cannot file a community under a division outside their scope", async () => {
  const service = harness({ permissions: ["community.read", "community.write"], divisions: [NORTH] })

  await assert.rejects(service.run(() => createCommunity({ name: "Ridge", divisionId: SOUTH, status: "planning" })), /Division not found/)
  await assert.rejects(service.run(() => updateCommunity(NORTH_COMMUNITY, { divisionId: SOUTH })), /Division not found/)
  assert.deepEqual(service.writes(), [])
})

// ---------------------------------------------------------------------------
// Takedowns under land contracts.
// ---------------------------------------------------------------------------

const TAKEDOWN = id(401)
const CONTRACT = id(402)
const DEAL = id(403)
const LAND_WRITER = ["community.read", "community.write", "lot.write"]

function takedownHarness({ contractStatus = "executed", deposits = [], lots = [], books = [], landOpportunityId = null, reviews = [], deals = [], permissions = LAND_WRITER } = {}) {
  return harness({
    permissions,
    tables: {
      land_opportunities: deals,
      land_acquisition_reviews: reviews.map((review, index) => ({ id: id(450 + index), org_id: ORG, land_opportunity_id: DEAL, ...review })),
      land_contracts: contractStatus ? [{ id: CONTRACT, org_id: ORG, community_id: NORTH_COMMUNITY, status: contractStatus }] : [],
      lot_takedowns: [{
        id: TAKEDOWN,
        org_id: ORG,
        community_id: NORTH_COMMUNITY,
        community_phase_id: null,
        land_contract_id: contractStatus ? CONTRACT : null,
        land_opportunity_id: landOpportunityId,
        name: "Tranche 1",
        scheduled_date: "2026-12-01",
        actual_date: null,
        lot_count: 2,
        price_per_lot_cents: 72_000_00,
        status: "scheduled",
        seller_company_id: null,
        notes: null,
        updated_at: "2026-10-01T00:00:00+00:00",
      }],
      land_contract_deposits: deposits.map((deposit, index) => ({
        id: id(500 + index),
        org_id: ORG,
        land_contract_id: CONTRACT,
        takedown_id: TAKEDOWN,
        amount_cents: 50_000_00,
        updated_at: "2026-10-01T00:00:00+00:00",
        ...deposit,
      })),
      lots: lots.map((lot, index) => ({
        id: id(600 + index),
        org_id: ORG,
        community_id: NORTH_COMMUNITY,
        takedown_id: TAKEDOWN,
        project_id: null,
        updated_at: "2026-10-01T00:00:00+00:00",
        ...lot,
      })),
      books_settings: books,
    },
  })
}

const close = (service) => service.run(() => closeLotTakedown(TAKEDOWN, { actualDate: "2026-12-01" }))

test("closing a takedown makes its controlled lots owned and applies the deposits paid against it", async () => {
  const service = takedownHarness({
    deposits: [{ status: "paid" }, { status: "refunded" }],
    lots: [{ status: "controlled" }, { status: "developed" }],
  })

  const closed = await close(service)

  assert.equal(closed.status, "closed")
  assert.deepEqual(service.db.lots.map((lot) => lot.status), ["owned", "developed"])
  assert.deepEqual(service.db.land_contract_deposits.map((deposit) => deposit.status), ["applied", "refunded"])
  const event = service.events.find((entry) => entry.eventType === "lot_takedown.closed")
  assert.equal(event.payload.applied_deposit_cents, 50_000_00)
})

test("a takedown under an unsigned contract, or with a credited deposit still unpaid, does not close", async () => {
  const draft = takedownHarness({ contractStatus: "draft", lots: [{ status: "controlled" }] })
  await assert.rejects(close(draft), /Execute this takedown's land contract/)
  assert.deepEqual(draft.writes(), [])

  const unpaid = takedownHarness({ deposits: [{ status: "scheduled" }], lots: [{ status: "controlled" }] })
  await assert.rejects(close(unpaid), /payment of every deposit/)
  assert.deepEqual(unpaid.writes(), [])
})

test("a takedown from a land deal closes only once that deal's acquisition is approved", async () => {
  const lots = [{ status: "controlled" }]
  const pending = takedownHarness({
    landOpportunityId: DEAL,
    lots,
    reviews: [{ status: "in_review", decision: "acquire" }, { status: "approved", decision: "terminate" }],
  })
  await assert.rejects(close(pending), /no approved acquisition review/)
  assert.deepEqual(pending.writes(), [])

  const approved = takedownHarness({ landOpportunityId: DEAL, lots, reviews: [{ status: "approved", decision: "acquire" }] })
  assert.equal((await close(approved)).status, "closed")

  // An unlinked tranche (legacy, imported) is not held by any review.
  assert.equal((await close(takedownHarness({ lots }))).status, "closed")
})

test("naming a takedown's land deal takes land.read and a deal acquired into this community", async () => {
  const deals = [{ id: DEAL, org_id: ORG, community_id: NORTH_COMMUNITY, name: "Hawthorne 80" }]
  const input = { name: "Tranche 2", landOpportunityId: DEAL }

  const blind = takedownHarness({ deals })
  await assert.rejects(blind.run(() => createLotTakedown(NORTH_COMMUNITY, input)), /land.read/)
  await assert.rejects(blind.run(() => updateLotTakedown(TAKEDOWN, { landOpportunityId: DEAL })), /land.read/)
  assert.deepEqual(blind.writes(), [])

  const elsewhere = takedownHarness({ deals: [{ ...deals[0], community_id: SOUTH_COMMUNITY }], permissions: [...LAND_WRITER, "land.read"] })
  await assert.rejects(elsewhere.run(() => createLotTakedown(NORTH_COMMUNITY, input)), /Land deal not found/)
  assert.deepEqual(elsewhere.writes(), [])

  const reader = takedownHarness({ deals, permissions: [...LAND_WRITER, "land.read"] })
  assert.equal((await reader.run(() => createLotTakedown(NORTH_COMMUNITY, input))).landOpportunityId, DEAL)
})

test("with Books on, a takedown closes only through the recorded land acquisition", async () => {
  const service = takedownHarness({
    contractStatus: null,
    lots: [{ status: "controlled" }],
    books: [{ org_id: ORG, workspace_enabled: true, arc_ledger_mode: "official" }],
  })
  await assert.rejects(close(service), /Record the actual land acquisition/)
  assert.deepEqual(service.writes(), [])
})

test("a takedown under an executed contract keeps its signed date, lots and price", async () => {
  const service = takedownHarness()
  for (const change of [{ scheduledDate: "2027-01-15" }, { lotCount: 3 }, { pricePerLotCents: 1 }]) {
    await assert.rejects(service.run(() => updateLotTakedown(TAKEDOWN, change)), /extension|signed terms/)
  }
  assert.deepEqual(service.writes(), [])

  const renamed = await service.run(() => updateLotTakedown(TAKEDOWN, { name: "Tranche 1A", scheduledDate: "2026-12-01" }))
  assert.equal(renamed.name, "Tranche 1A")
})

test("a takedown with no contract, or a draft one, is edited freely", async () => {
  const service = takedownHarness({ contractStatus: "draft" })
  const moved = await service.run(() => updateLotTakedown(TAKEDOWN, { scheduledDate: "2027-01-15", lotCount: 3 }))
  assert.deepEqual([moved.scheduledDate, moved.lotCount], ["2027-01-15", 3])
})

test("land money coming due is announced once per threshold: the takedown net of its deposits, the deposit, the fee", async () => {
  const inDays = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
  const contract = { community_id: NORTH_COMMUNITY, title: "Phase 1 purchase", metadata: {} }
  const service = takedownHarness({ deposits: [{ status: "scheduled", due_on: inDays(20), label: "Second deposit", refundability: "non_refundable", metadata: {}, contract }] })
  service.db.lot_takedowns[0].scheduled_date = inDays(20)
  service.db.lot_takedowns[0].metadata = {}
  service.db.land_contracts[0].metadata = {}
  service.db.land_contract_amendments = [{ id: id(700), org_id: ORG, land_contract_id: CONTRACT, kind: "extension", fee_cents: 10_000_00, due_on: inDays(20), contract }]

  assert.deepEqual(await service.run(() => sweepTakedownReminders()), { announced: 3 })
  const due = service.events.filter((event) => event.eventType === "lot_takedown.due")
  assert.deepEqual(due.map((event) => [event.payload.kind, event.payload.cash_cents ?? event.payload.amount_cents]), [
    ["takedown", 144_000_00 - 50_000_00],
    ["deposit", 50_000_00],
    ["fee", 10_000_00],
  ])

  // Re-read the markers the sweep wrote, as the next run would.
  service.db.land_contract_deposits[0].contract = { ...contract, metadata: service.db.land_contracts[0].metadata }
  service.db.land_contract_amendments[0].contract = { ...contract, metadata: service.db.land_contracts[0].metadata }
  assert.deepEqual(await service.run(() => sweepTakedownReminders()), { announced: 0 })
})
