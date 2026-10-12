"use strict"

/**
 * What a product definition edit reaches: the homes an elevation or option edit
 * touches, listed before it saves (`lib/services/product-change-impact.ts`),
 * and the lots a plan's footprint edit re-judges (`updateHousePlan`).
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { getProductChangeImpact } = freshRequire("lib/services/product-change-impact.ts")
const { updateHousePlan } = freshRequire("lib/services/house-plans.ts")

const PLAN = id(1)
const VERSION = id(2)
const ELEVATION = id(3)
const OPTION = id(4)
const COMMUNITY = id(5)
const BUYER = id(6)

const LOT = { unsold: id(11), spec: id(12), contracted: id(13), released: id(14) }
const HOME = { spec: id(22), contracted: id(23), released: id(24) }
const CONTRACT = { contracted: id(33), released: id(34) }

function lot(key, projectId, extra = {}) {
  return {
    id: LOT[key], org_id: ORG, community_id: COMMUNITY, lot_number: String(LOT[key].slice(-2)), block: "A", division_id: null,
    project_id: projectId, house_plan_id: PLAN, house_plan_version_id: VERSION, house_plan_elevation_id: ELEVATION, ...extra,
  }
}

function record(projectId, contractId, stage, revisions) {
  return {
    id: `${projectId}-${stage}`, org_id: ORG, project_id: projectId, contract_id: contractId, stage,
    elevation_id: revisions.elevation?.id ?? null,
    revisions: { planVersion: { id: VERSION, number: 1 }, elevation: null, options: [], packages: [], ...revisions },
  }
}

/** One community: an unsold lot, a spec home, a contracted home and a released one, all on elevation A. */
function community() {
  return {
    house_plans: [{ id: PLAN, org_id: ORG, code: "2400", name: "Aspen", status: "active", division_id: null, footprint_width_ft: 40, footprint_depth_ft: 70, drawn_swing: "left" }],
    house_plan_elevations: [{ id: ELEVATION, org_id: ORG, house_plan_id: PLAN, code: "A", name: "Craftsman", revision: 4, is_active: true, swing_applicable: true }],
    selection_options: [{ id: OPTION, org_id: ORG, name: "Quartz counters", revision: 3, is_available: true }],
    communities: [{ id: COMMUNITY, org_id: ORG, name: "Cypress Run", setbacks: {} }],
    lots: [
      lot("unsold", null),
      lot("spec", HOME.spec),
      lot("contracted", HOME.contracted),
      lot("released", HOME.released),
    ],
    projects: [
      { id: HOME.spec, org_id: ORG, name: "Lot A-12", client_id: null, division_id: null },
      { id: HOME.contracted, org_id: ORG, name: "Lot A-13", client_id: BUYER, division_id: null },
      { id: HOME.released, org_id: ORG, name: "Lot A-14", client_id: null, division_id: null },
    ],
    contacts: [{ id: BUYER, org_id: ORG, full_name: "Dana Buyer" }],
    contracts: [
      { id: CONTRACT.contracted, org_id: ORG, project_id: HOME.contracted, contract_type: "purchase_agreement", status: "active", signed_at: "2026-09-01T00:00:00.000Z" },
      { id: CONTRACT.released, org_id: ORG, project_id: HOME.released, contract_type: "purchase_agreement", status: "active", signed_at: "2026-08-01T00:00:00.000Z" },
    ],
    start_packages: [{ id: id(40), org_id: ORG, project_id: HOME.released, lot_id: LOT.released, status: "released" }],
    project_selections: [
      { id: id(50), org_id: ORG, project_id: HOME.spec, selected_option_id: OPTION, status: "selected" },
    ],
    home_product_revisions: [
      record(HOME.contracted, CONTRACT.contracted, "agreement", { elevation: { id: ELEVATION, code: "A", revision: 3 }, options: [{ id: OPTION, revision: 2 }] }),
      record(HOME.released, CONTRACT.released, "agreement", { elevation: { id: ELEVATION, code: "A", revision: 2 }, options: [{ id: id(99), revision: 1 }] }),
      record(HOME.released, CONTRACT.released, "release", { elevation: { id: ELEVATION, code: "A", revision: 3 }, options: [{ id: OPTION, revision: 3 }] }),
    ],
  }
}

const homeFacts = (impact) => impact.homes.map((home) => ({
  lot: home.lotId, state: home.state, buyer: home.buyerName, sold: home.soldRevision, released: home.releasedRevision,
}))

describe("getProductChangeImpact", () => {
  test("an elevation edit lists every home on it by state, sold first, with the revision each was sold and released at", async () => {
    const service = createServiceHarness({ permissions: ["plan.read"], tables: community() })
    const impact = await service.run(() => getProductChangeImpact({ entity: "elevation", id: ELEVATION }))

    assert.equal(impact.label, "Elevation A · Craftsman")
    assert.equal(impact.revision, 4)
    assert.equal(impact.soldCount, 2)
    assert.deepEqual(impact.counts, { unsold: 1, spec: 1, contracted: 1, released: 1 })
    assert.deepEqual(homeFacts(impact), [
      { lot: LOT.released, state: "released", buyer: null, sold: 2, released: 3 },
      { lot: LOT.contracted, state: "contracted", buyer: "Dana Buyer", sold: 3, released: null },
      { lot: LOT.spec, state: "spec", buyer: null, sold: null, released: null },
      { lot: LOT.unsold, state: "unsold", buyer: null, sold: null, released: null },
    ])
    assert.equal(impact.truncated, false)
    assert.deepEqual(service.writes(), [])
  })

  test("an option edit lists the homes that chose it, were sold it, or were released with it — and no other", async () => {
    const service = createServiceHarness({ permissions: ["selections.read"], tables: community() })
    const impact = await service.run(() => getProductChangeImpact({ entity: "option", id: OPTION }))

    assert.equal(impact.soldCount, 2)
    assert.deepEqual(homeFacts(impact), [
      // Sold without it (its agreement recorded another option), released with it.
      { lot: LOT.released, state: "released", buyer: null, sold: null, released: 3 },
      { lot: LOT.contracted, state: "contracted", buyer: "Dana Buyer", sold: 2, released: null },
      { lot: LOT.spec, state: "spec", buyer: null, sold: null, released: null },
    ])
  })

  test("a reader assigned to other divisions does not see these homes", async () => {
    const tables = community()
    for (const row of tables.lots) row.division_id = id(70)
    const service = createServiceHarness({ permissions: ["plan.read"], divisions: [id(71)], tables })
    const impact = await service.run(() => getProductChangeImpact({ entity: "elevation", id: ELEVATION }))
    assert.deepEqual(impact.homes, [])
    assert.equal(impact.soldCount, 0)
  })
})

describe("a plan footprint edit", () => {
  function pinnedPlan() {
    const tables = community()
    // 50 x 120 with 5/25/20 setbacks builds 40 x 75: the 40 x 70 plan fits until it widens.
    for (const row of tables.lots) row.dimensions = { width_ft: 50, depth_ft: 120, side_setback_ft: 5, front_setback_ft: 25, rear_setback_ft: 20 }
    tables.lots = tables.lots.slice(0, 2)
    tables.house_plan_versions = [{ id: VERSION, org_id: ORG, house_plan_id: PLAN, version_number: 1, status: "released" }]
    return tables
  }

  test("re-judges every lot pinned to the plan and records each that no longer fits", async () => {
    const service = createServiceHarness({ permissions: ["plan.read", "plan.write"], tables: pinnedPlan() })
    const plan = await service.run(() => updateHousePlan(PLAN, { footprintWidthFt: 42 }))

    assert.equal(plan.lotsNoLongerFitting, 2)
    const violated = service.events.filter((event) => event.eventType === "lot.fit_violated")
    assert.deepEqual(violated.map((event) => event.entityId).sort(), [LOT.unsold, LOT.spec].sort())
    assert.deepEqual(violated[0].payload.violations, ["footprint_too_wide"])
    // The homes stay pinned; the start gate is what refuses them.
    assert.ok(service.db.lots.every((row) => row.house_plan_id === PLAN))
  })

  test("an edit that leaves the footprint alone re-judges nothing", async () => {
    const service = createServiceHarness({ permissions: ["plan.read", "plan.write"], tables: pinnedPlan() })
    const plan = await service.run(() => updateHousePlan(PLAN, { beds: 4 }))
    assert.equal(plan.lotsNoLongerFitting, 0)
    assert.equal(service.events.filter((event) => event.eventType === "lot.fit_violated").length, 0)
  })
})
