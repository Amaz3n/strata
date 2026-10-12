const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { captureHomeProductRevisions } = freshRequire("lib/services/home-product-revisions.ts")

const HOME = id(1)
const AGREEMENT = id(2)
const VERSION = id(3)
const ELEVATION = id(4)
const PATIO = id(5)
const FANS = id(6)
const OUTDOOR = id(7)

function home() {
  return createServiceHarness({
    tables: {
      lots: [{ id: id(20), org_id: ORG, project_id: HOME, house_plan_version_id: VERSION, house_plan_elevation_id: ELEVATION }],
      house_plan_versions: [{ id: VERSION, org_id: ORG, version_number: 3 }],
      house_plan_elevations: [{ id: ELEVATION, org_id: ORG, code: "B", revision: 2 }],
      selection_options: [{ id: PATIO, org_id: ORG, revision: 4 }, { id: FANS, org_id: ORG, revision: 1 }],
      selection_packages: [{ id: OUTDOOR, org_id: ORG, revision: 2 }],
      contracts: [{
        id: AGREEMENT, org_id: ORG, project_id: HOME, contract_type: "purchase_agreement", status: "active",
        created_at: "2026-06-15T00:00:00Z", signed_at: "2026-06-20T00:00:00Z",
        snapshot: { purchase_agreement: { configuration: { house_plan_version_id: VERSION, elevation_id: ELEVATION, option_items: [{ optionId: PATIO }, { packageId: OUTDOOR }] } } },
      }],
      project_selections: [
        { id: id(10), org_id: ORG, project_id: HOME, status: "confirmed", selected_option_id: PATIO, package_id: null },
        { id: id(11), org_id: ORG, project_id: HOME, status: "confirmed", selected_option_id: FANS, package_id: OUTDOOR },
        { id: id(12), org_id: ORG, project_id: HOME, status: "removed", selected_option_id: id(8), package_id: null },
      ],
      product_definition_revisions: [
        { id: id(30), org_id: ORG, entity_id: ELEVATION, revision: 1, created_at: "2026-01-01T00:00:00Z" },
        { id: id(31), org_id: ORG, entity_id: ELEVATION, revision: 2, created_at: "2026-09-01T00:00:00Z" },
        { id: id(32), org_id: ORG, entity_id: PATIO, revision: 3, created_at: "2026-05-01T00:00:00Z" },
        { id: id(33), org_id: ORG, entity_id: PATIO, revision: 4, created_at: "2026-08-01T00:00:00Z" },
        { id: id(34), org_id: ORG, entity_id: OUTDOOR, revision: 2, created_at: "2026-02-01T00:00:00Z" },
      ],
      home_product_revisions: [],
    },
  })
}

test("release records the home as built: pinned plan, elevation and live selections at today's revisions, once", async () => {
  const service = home()

  const first = await service.run(() => captureHomeProductRevisions({ orgId: ORG, projectId: HOME, stage: "release", actorId: ACTOR }))
  service.db.selection_options[0].revision = 5
  const again = await service.run(() => captureHomeProductRevisions({ orgId: ORG, projectId: HOME, stage: "release", actorId: ACTOR }))

  assert.deepEqual(first.revisions, {
    planVersion: { id: VERSION, number: 3 },
    elevation: { id: ELEVATION, code: "B", revision: 2 },
    options: [{ id: PATIO, revision: 4 }, { id: FANS, revision: 1 }],
    packages: [{ id: OUTDOOR, revision: 2 }],
  })
  assert.equal(again.id, first.id)
  assert.deepEqual(again.revisions, first.revisions)
  assert.equal(service.writes("home_product_revisions").length, 1)
})

test("a sale records the configuration it priced at the revisions current when the agreement was written", async () => {
  const service = home()

  const record = await service.run(() => captureHomeProductRevisions({ orgId: ORG, projectId: HOME, stage: "agreement" }))

  assert.equal(record.contractId, AGREEMENT)
  assert.deepEqual(record.revisions, {
    planVersion: { id: VERSION, number: 3 },
    elevation: { id: ELEVATION, code: "B", revision: 1 },
    options: [{ id: PATIO, revision: 3 }],
    packages: [{ id: OUTDOOR, revision: 2 }],
  })
})

test("a home with no executed agreement records no sale", async () => {
  const service = home()
  service.db.contracts = []

  await assert.rejects(
    service.run(() => captureHomeProductRevisions({ orgId: ORG, projectId: HOME, stage: "agreement" })),
    /no executed purchase agreement/,
  )
  assert.deepEqual(service.writes("home_product_revisions"), [])
})
