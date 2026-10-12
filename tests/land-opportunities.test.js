"use strict"

/**
 * The land deal service: what it refuses before anything is written, the
 * division wall it applies on top of the database's (and in front of the
 * service-role file routes), and the diligence deadline sweep.
 */

const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")
const { freshRequire } = require("./support/modules")

const {
  assertLandFileReadable,
  getLandOpportunity,
  listLandOpportunities,
  resolveDiligenceItem,
  submitAcquisitionReview,
  sweepLandDiligenceDeadlines,
  updateLandOpportunity,
} = freshRequire("lib/services/land-opportunities.ts")

const NORTH = id(1)
const SOUTH = id(2)
const DEAL = id(10)
const SOUTH_DEAL = id(11)
const ITEM = id(20)
const APPROVER = id(30)

const deal = (overrides = {}) => ({
  id: DEAL,
  org_id: ORG,
  division_id: NORTH,
  name: "Hawthorne 80",
  code: null,
  seller_company_id: null,
  address: null,
  city: "Round Rock",
  state: "TX",
  county: null,
  acreage: "80.00",
  planned_lot_count: 120,
  purchase_price_cents: 6_000_000_00,
  deposit_cents: 250_000_00,
  contract_executed_on: "2026-09-01",
  diligence_ends_on: "2026-11-30",
  closing_target_on: null,
  lead_user_id: null,
  community_id: null,
  dropped_at: null,
  dropped_reason: null,
  notes: null,
  metadata: {},
  created_by: ACTOR,
  updated_at: "2026-10-01T00:00:00+00:00",
  ...overrides,
})

const item = (overrides = {}) => ({
  id: ITEM,
  org_id: ORG,
  land_opportunity_id: DEAL,
  title: "ALTA survey",
  category: "survey",
  owner_user_id: null,
  owner_company_id: null,
  due_on: "2026-10-14",
  status: "open",
  finding: null,
  waived_reason: null,
  resolved_at: null,
  resolved_by: null,
  sort_order: 10,
  metadata: {},
  updated_at: "2026-10-01T00:00:00+00:00",
  ...overrides,
})

test("a satisfied item needs a filed document or a written finding", async () => {
  const service = createServiceHarness({
    permissions: ["land.read", "land.write"],
    tables: { land_opportunities: [deal()], land_diligence_items: [item()], file_links: [] },
  })

  await assert.rejects(service.run(() => resolveDiligenceItem(ITEM, { status: "satisfied" })), /File the evidence or write the finding/)
  assert.deepEqual(service.writes("land_diligence_items"), [])

  await service.run(() => resolveDiligenceItem(ITEM, { status: "satisfied", finding: "No encroachments; two easements noted" }))
  const [stored] = service.db.land_diligence_items
  assert.equal(stored.status, "satisfied")
  assert.equal(stored.resolved_by, ACTOR)
  assert.deepEqual(service.events.map((event) => event.eventType), ["land_diligence_item.resolved"])
  assert.equal(service.audits.length, 1)
})

test("a waiver needs its reason before anything is written", async () => {
  const service = createServiceHarness({
    permissions: ["land.read", "land.write"],
    tables: { land_opportunities: [deal()], land_diligence_items: [item()], file_links: [] },
  })

  await assert.rejects(service.run(() => resolveDiligenceItem(ITEM, { status: "waived", waivedReason: "fine" })), /at least 10 characters/)
  assert.deepEqual(service.writes(), [])
})

test("a division-restricted member neither sees nor changes another division's deal", async () => {
  const service = createServiceHarness({
    permissions: ["land.read", "land.write"],
    divisions: [NORTH],
    tables: {
      land_opportunities: [deal(), deal({ id: SOUTH_DEAL, division_id: SOUTH, name: "Cedar Bend" })],
      land_acquisition_reviews: [],
      lot_takedowns: [],
      land_diligence_items: [],
      divisions: [{ id: NORTH, org_id: ORG, name: "North", archived_at: null }],
    },
  })

  const page = await service.run(() => listLandOpportunities({}))
  assert.deepEqual(page.rows.map((row) => row.name), ["Hawthorne 80"])
  await assert.rejects(service.run(() => getLandOpportunity(SOUTH_DEAL)), /Land deal not found/)
  await assert.rejects(service.run(() => updateLandOpportunity(SOUTH_DEAL, { purchasePriceCents: 1 })), /Land deal not found/)
  // Nor can a deal be moved into a division the member does not work in.
  await assert.rejects(service.run(() => updateLandOpportunity(DEAL, { divisionId: SOUTH })), /Division not found/)
  assert.deepEqual(service.writes(), [])
})

test("a diligence document's bytes reach only land readers in the deal's division", async () => {
  const tables = { land_opportunities: [deal(), deal({ id: SOUTH_DEAL, division_id: SOUTH, name: "Cedar Bend" })] }

  await assert.rejects(createServiceHarness({ permissions: ["docs.download"], tables }).run(() => assertLandFileReadable(DEAL)), /land.read/)

  const north = createServiceHarness({ permissions: ["docs.download", "land.read"], divisions: [NORTH], tables })
  await north.run(() => assertLandFileReadable(DEAL))
  await assert.rejects(north.run(() => assertLandFileReadable(SOUTH_DEAL)), /Land deal not found/)
})

test("the desk lists a page of deals with their stage and checklist, and says how many there are", async () => {
  const deals = Array.from({ length: 3 }, (_, index) =>
    deal({ id: id(100 + index), name: `Deal ${index}`, diligence_ends_on: `2026-11-0${index + 1}` }),
  )
  const service = createServiceHarness({
    permissions: ["land.read"],
    tables: {
      land_opportunities: deals,
      land_acquisition_reviews: [{ id: id(200), org_id: ORG, land_opportunity_id: id(101), status: "in_review", decision: "acquire" }],
      lot_takedowns: [],
      land_diligence_items: [
        item({ id: id(300), land_opportunity_id: id(100), status: "satisfied", resolved_at: "2026-10-01T00:00:00Z" }),
        item({ id: id(301), land_opportunity_id: id(100), due_on: "2026-01-01" }),
      ],
    },
  })

  const page = await service.run(() => listLandOpportunities({ pageSize: 2 }))
  assert.equal(page.total, 3)
  assert.deepEqual(page.rows.map((row) => [row.name, row.stage]), [["Deal 0", "diligence"], ["Deal 1", "in_review"]])
  assert.equal(page.rows[0].diligence.overdue, 1)
  assert.equal(page.rows[0].pricePerLotCents, 5_000_000)

  const inReview = await service.run(() => listLandOpportunities({ stage: "in_review" }))
  assert.deepEqual(inReview.rows.map((row) => row.name), ["Deal 1"])
})

test("naming yourself as an approver is refused before the database is asked", async () => {
  const service = createServiceHarness({
    permissions: ["land.read", "land.write"],
    tables: { land_opportunities: [deal()] },
    rpc: { submit_land_acquisition_review: () => ({ data: id(400), error: null }) },
  })

  await assert.rejects(
    service.run(() => submitAcquisitionReview(DEAL, { decision: "acquire", approvers: [{ userId: ACTOR }, { userId: APPROVER }] })),
    /cannot approve a review you submit/,
  )
  assert.deepEqual(service.queries.filter((query) => query.action === "rpc"), [])
})

test("the deadline sweep announces an item once per threshold, and a live deal's feasibility period once", async () => {
  const now = new Date("2026-10-12T12:00:00Z")
  const service = createServiceHarness({
    tables: {
      land_diligence_items: [
        { ...item({ due_on: "2026-10-14" }), deal: { name: "Hawthorne 80", lead_user_id: APPROVER, division_id: NORTH, dropped_at: null } },
        { ...item({ id: id(21), due_on: "2026-11-30" }), deal: { name: "Hawthorne 80", lead_user_id: APPROVER, division_id: NORTH, dropped_at: null } },
      ],
      land_opportunities: [deal({ diligence_ends_on: "2026-10-19" })],
      land_acquisition_reviews: [],
    },
  })

  const first = await service.run(() => sweepLandDiligenceDeadlines(now))
  assert.deepEqual(first, { items: 1, deals: 1 })
  assert.deepEqual(
    service.events.map((event) => [event.eventType, event.payload.days_out]),
    [["land_diligence_item.due", 2], ["land_opportunity.diligence_deadline", 7]],
  )
  assert.ok(service.db.land_diligence_items[0].metadata.reminded_at_3d)

  const second = await service.run(() => sweepLandDiligenceDeadlines(now))
  assert.deepEqual(second, { items: 0, deals: 0 })
})
