"use strict"

/**
 * `lib/services/plan-change-proposals.ts` — rolling a plan change out to homes
 * that already carry the plan: who is listed, who may decide, and what each
 * decision does to the lot's pin, the buyer's agreement and the books.
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const {
  applyPlanAdoptionFromChangeOrder,
  createPlanChangeProposal,
  decidePlanChangeHome,
  submitPlanChangeProposal,
} = freshRequire("lib/services/plan-change-proposals.ts")

const COMMUNITY = id(1)
const PLAN = id(2)
const V3 = id(3)
const V4 = id(4)
const ELEVATION = id(5)
const FRAMING = id(6)
const LOT = { unsold: id(11), spec: id(12), contracted: id(13), released: id(14), current: id(15), closed: id(16) }
const HOME = { spec: id(22), contracted: id(23), released: id(24), closed: id(26) }

const PERMISSIONS = ["plan.read", "plan.write", "plan.adopt", "change_order.write", "project.read"]

function lot(lotId, overrides = {}) {
  return {
    id: lotId, org_id: ORG, community_id: COMMUNITY, lot_number: lotId.slice(-2), block: null, status: "developed",
    project_id: null, house_plan_id: PLAN, house_plan_version_id: V3, house_plan_elevation_id: ELEVATION,
    swing: "left", dimensions: {}, metadata: {}, updated_at: "2026-10-01T00:00:00+00:00", ...overrides,
  }
}

function takeoff(lineId, versionId, unitCostCents) {
  return {
    id: lineId, org_id: ORG, house_plan_version_id: versionId, elevation_id: null, cost_code_id: FRAMING, cost_type: null,
    description: "Framing", quantity: 1, uom: "ls", unit_cost_cents: unitCostCents, sort_order: 0,
  }
}

function harness({ permissions = PERMISSIONS, offered = true } = {}) {
  return createServiceHarness({
    permissions,
    tables: {
      communities: [{ id: COMMUNITY, org_id: ORG, name: "Oak Ridge", division_id: null, setbacks: {} }],
      house_plans: [{ id: PLAN, org_id: ORG, code: "A100", name: "Aspen", footprint_width_ft: null, footprint_depth_ft: null, drawn_swing: null }],
      house_plan_versions: [
        { id: V3, org_id: ORG, house_plan_id: PLAN, version_number: 3, status: "superseded" },
        { id: V4, org_id: ORG, house_plan_id: PLAN, version_number: 4, status: "released" },
      ],
      house_plan_elevations: [{ id: ELEVATION, org_id: ORG, house_plan_id: PLAN, code: "A", is_active: true, swing_applicable: true }],
      house_plan_takeoff_lines: [takeoff(id(31), V3, 1_000_000), takeoff(id(32), V4, 1_150_000)],
      community_plan_availability: offered
        ? [{ org_id: ORG, community_id: COMMUNITY, house_plan_id: PLAN, is_available: true, elevation_id: null, effective_start: null, effective_end: null }]
        : [],
      lots: [
        lot(LOT.unsold),
        lot(LOT.spec, { project_id: HOME.spec, status: "started" }),
        lot(LOT.contracted, { project_id: HOME.contracted, status: "started" }),
        lot(LOT.released, { project_id: HOME.released, status: "started" }),
        lot(LOT.current, { house_plan_version_id: V4 }),
        lot(LOT.closed, { project_id: HOME.closed, status: "closed" }),
      ],
      projects: Object.entries(HOME).map(([name, projectId]) => ({ id: projectId, org_id: ORG, name: `Home ${name}`, client_id: null, division_id: null })),
      contracts: [HOME.contracted, HOME.released].map((projectId, index) => ({
        id: id(40 + index), org_id: ORG, project_id: projectId, contract_type: "purchase_agreement", status: "active",
        signed_at: "2026-08-01T00:00:00Z", total_cents: 45_000_000, snapshot: { purchase_agreement: { configuration: { house_plan_version_id: V3 } } },
      })),
      start_packages: [{ id: id(50), org_id: ORG, lot_id: LOT.released, project_id: HOME.released, status: "released" }],
      lot_reservations: [],
      change_orders: [],
      change_order_lines: [],
      plan_change_proposals: [],
      plan_change_proposal_homes: [],
    },
  })
}

async function openReview(service) {
  const review = await service.run(() => createPlanChangeProposal({ planId: PLAN, toVersionId: V4 }))
  await service.run(() => submitPlanChangeProposal(review.id))
  return review
}

const homeFor = (service, lotId) => service.db.plan_change_proposal_homes.find((row) => row.lot_id === lotId)
const pinOf = (service, lotId) => service.db.lots.find((row) => row.id === lotId).house_plan_version_id

describe("createPlanChangeProposal", () => {
  test("lists every home on an earlier edition — contracted and released included — with its state and the cost of moving it", async () => {
    const service = harness()
    const review = await service.run(() => createPlanChangeProposal({ planId: PLAN, toVersionId: V4 }))

    const byLot = Object.fromEntries(review.homes.map((home) => [home.lotId, home]))
    assert.deepEqual(Object.keys(byLot).sort(), [LOT.unsold, LOT.spec, LOT.contracted, LOT.released].sort())
    assert.equal(byLot[LOT.unsold].state, "unsold")
    assert.equal(byLot[LOT.spec].state, "spec")
    assert.equal(byLot[LOT.contracted].state, "contracted")
    assert.equal(byLot[LOT.released].state, "released")
    for (const home of review.homes) {
      assert.equal(home.costDeltaCents, 150_000)
      assert.equal(home.fromVersionNumber, 3)
      assert.equal(home.decision, "pending")
    }
    assert.equal(review.status, "draft")
    assert.deepEqual(service.events.map((event) => event.eventType), ["plan_change_proposal.created"])
  })

  test("nothing about any home changes by opening a review", async () => {
    const service = harness()
    await service.run(() => createPlanChangeProposal({ planId: PLAN, toVersionId: V4 }))
    assert.deepEqual(service.writes().map((write) => write.table).sort(), ["plan_change_proposal_homes", "plan_change_proposals"])
  })
})

describe("decidePlanChangeHome", () => {
  test("deciding needs plan.adopt", async () => {
    const service = harness()
    await openReview(service)
    service.grant(["plan.read", "plan.write", "change_order.write"])
    const before = service.writes().length
    await assert.rejects(
      service.run(() => decidePlanChangeHome({ proposalHomeId: homeFor(service, LOT.unsold).id, decision: "adopt" })),
      /Missing permission/,
    )
    assert.equal(service.writes().length, before)
  })

  test("adopting an unsold lot re-pins it to the new version", async () => {
    const service = harness()
    await openReview(service)
    await service.run(() => decidePlanChangeHome({ proposalHomeId: homeFor(service, LOT.unsold).id, decision: "adopt" }))
    assert.equal(pinOf(service, LOT.unsold), V4)
    assert.equal(homeFor(service, LOT.unsold).decision, "adopt")
    assert.ok(homeFor(service, LOT.unsold).adopted_at)
  })

  test("a re-pin answers to the community's offering like any other pin", async () => {
    const service = harness({ offered: false })
    await openReview(service)
    await assert.rejects(
      service.run(() => decidePlanChangeHome({ proposalHomeId: homeFor(service, LOT.unsold).id, decision: "adopt" })),
      /not offered in the lot's community/,
    )
    assert.equal(pinOf(service, LOT.unsold), V3)
    assert.equal(homeFor(service, LOT.unsold).decision, "pending")
  })

  test("adopting a contracted home drafts a change order for the buyer and leaves the agreement and the pin alone", async () => {
    const service = harness()
    await openReview(service)
    const contractsBefore = structuredClone(service.db.contracts)
    await service.run(() => decidePlanChangeHome({ proposalHomeId: homeFor(service, LOT.contracted).id, decision: "adopt", priceDeltaCents: 200_000 }))

    const [changeOrder] = service.db.change_orders
    assert.equal(changeOrder.project_id, HOME.contracted)
    assert.equal(changeOrder.status, "draft")
    assert.equal(changeOrder.requires_signature, true)
    assert.equal(changeOrder.total_cents, 200_000)
    assert.equal(changeOrder.cost_total_cents, 150_000)
    assert.equal(changeOrder.metadata.plan_adoption.to_version_id, V4)
    assert.equal(homeFor(service, LOT.contracted).change_order_id, changeOrder.id)
    assert.equal(homeFor(service, LOT.contracted).adopted_at, undefined)
    assert.equal(pinOf(service, LOT.contracted), V3)
    assert.deepEqual(service.db.contracts, contractsBefore)
    assert.deepEqual(service.writes("contracts"), [])
  })

  test("the home moves to the new version when its change order executes, once", async () => {
    const service = harness()
    await openReview(service)
    await service.run(() => decidePlanChangeHome({ proposalHomeId: homeFor(service, LOT.contracted).id, decision: "adopt", priceDeltaCents: 0 }))
    const changeOrderId = service.db.change_orders[0].id

    assert.deepEqual(await service.run(() => applyPlanAdoptionFromChangeOrder(changeOrderId, ORG)), { adopted: true })
    assert.equal(pinOf(service, LOT.contracted), V4)
    assert.ok(homeFor(service, LOT.contracted).adopted_at)
    assert.deepEqual(await service.run(() => applyPlanAdoptionFromChangeOrder(changeOrderId, ORG)), { adopted: false })
  })

  test("a released home's executed change order also drafts the variance order on the purchase order carrying the cost", async () => {
    const service = harness()
    service.db.commitments = [{ id: id(60), org_id: ORG, project_id: HOME.released, company_id: id(61), commitment_type: "purchase_order", status: "approved", created_at: "2026-08-02T00:00:00Z" }]
    service.db.commitment_lines = [{ id: id(62), org_id: ORG, commitment_id: id(60), cost_code_id: FRAMING }]
    await openReview(service)
    await service.run(() => decidePlanChangeHome({ proposalHomeId: homeFor(service, LOT.released).id, decision: "adopt", priceDeltaCents: 180_000 }))
    const changeOrderId = service.db.change_orders[0].id
    await service.run(() => applyPlanAdoptionFromChangeOrder(changeOrderId, ORG))

    const [variance] = service.db.commitment_change_orders
    assert.equal(variance.commitment_id, id(60))
    assert.equal(variance.status, "draft")
    assert.equal(variance.total_cents, 150_000)
    assert.equal(variance.prime_change_order_id, changeOrderId)
    assert.equal(variance.title, "Plan revision adopted")
    assert.equal(pinOf(service, LOT.released), V4)
  })

  test("a declined home stays on the version it was sold at, and an unsold one cannot decline", async () => {
    const service = harness()
    await openReview(service)
    await service.run(() => decidePlanChangeHome({ proposalHomeId: homeFor(service, LOT.contracted).id, decision: "decline", reason: "Buyer signed off on the v3 kitchen layout" }))
    assert.equal(pinOf(service, LOT.contracted), V3)
    assert.equal(homeFor(service, LOT.contracted).decision, "decline")
    assert.deepEqual(service.db.change_orders, [])

    await assert.rejects(
      service.run(() => decidePlanChangeHome({ proposalHomeId: homeFor(service, LOT.unsold).id, decision: "decline", reason: "Keep the old one around" })),
      /not sold yet/,
    )
    await assert.rejects(
      service.run(() => decidePlanChangeHome({ proposalHomeId: homeFor(service, LOT.contracted).id, decision: "adopt" })),
      /final/,
    )
  })

  test("the review closes when its last home is decided", async () => {
    const service = harness()
    await openReview(service)
    for (const lotId of [LOT.unsold, LOT.spec, LOT.contracted, LOT.released]) {
      await service.run(() => decidePlanChangeHome({ proposalHomeId: homeFor(service, lotId).id, decision: "defer" }))
    }
    assert.equal(service.db.plan_change_proposals[0].status, "decided")
  })
})
