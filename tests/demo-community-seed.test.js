const assert = require("node:assert/strict")
const { beforeEach, test } = require("node:test")

const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")
const { ids, sampleTables, supportIlike } = require("./support/sample-community")

const { COMMUNITY, BATCH, OTHER, UNRELATED_HOME } = ids

// Boundaries: the platform session, and the CSV importers (their own suites).
// The importer stand-in commits what each sample file would create; the house
// batch commits as the original import in tests/support/sample-community.js.
stubModule("lib/services/platform-access.ts", { requireAnyPlatformPermission: async () => ({ id: ACTOR }) })
const importer = { staged: new Map(), commits: 0, world: null, serial: 0 }
stubModule("lib/services/imports.ts", {
  async stageImportBatch(input) {
    const batchId = input.sourceFilename === "sample-wip-houses.csv" ? BATCH : id(200 + importer.serial++)
    importer.staged.set(batchId, input)
    return { id: batchId, error_count: 0 }
  },
  async commitImportBatch(batchId) {
    importer.commits += 1
    const { sourceFilename } = importer.staged.get(batchId)
    const db = importer.world.db
    if (sourceFilename === "sample-plans.csv") {
      ;["CL1650", "CL1900", "CL2400"].forEach((code, i) => {
        const version = { id: id(140 + i), org_id: ORG, status: "draft", metadata: { plan_source: "Keep version evidence" } }
        db.house_plan_versions.push(version)
        db.house_plans.push({
          id: id(120 + i),
          org_id: ORG,
          code,
          series: "Cypress Landing Sample",
          metadata: { imported: true },
          versions: [structuredClone(version)],
        })
      })
    }
    if (sourceFilename === "sample-lots.csv") {
      db.communities.push({ id: COMMUNITY, org_id: ORG, name: "Cypress Landing", metadata: { original: "Keep community evidence" } })
    }
    return { id: batchId, status: "committed" }
  },
})

const { deleteSampleCommunity, seedSampleCommunity } = freshRequire("lib/services/demo-community-seed.ts")

/** An org ready to seed: cost codes, a real plan in the same series, and the importer's house batch. */
function harness({ seeded = false } = {}) {
  const tables = sampleTables()
  const service = createServiceHarness({
    tables: {
      ...tables,
      communities: seeded ? tables.communities : [],
      cost_codes: Array.from({ length: 5 }, (_, i) => ({ id: id(80 + i), org_id: ORG, code: String(1000 + i), is_active: true })),
      house_plans: [
        { id: OTHER, org_id: ORG, code: "REAL", series: "Cypress Landing Sample", metadata: { real: "Preserve this plan" }, versions: [] },
      ],
      house_plan_versions: [],
      schedule_templates: [],
    },
    rpc: { release_house_plan_version: () => ({ data: null, error: null }) },
  })
  importer.world = supportIlike(service)
  return service
}

beforeEach(() => {
  importer.staged.clear()
  importer.commits = 0
  importer.serial = 0
})

test("seeding builds the community from the original house batch and preserves everything it did not make", async () => {
  const service = harness()
  const realPlan = structuredClone(service.db.house_plans[0])
  const unrelated = structuredClone(service.db.projects.find((home) => home.id === UNRELATED_HOME))

  assert.deepEqual(await service.run(() => seedSampleCommunity(ORG, ACTOR)), { communityId: COMMUNITY })

  const [community] = service.db.communities
  assert.equal(community.metadata.sample_seed_status, "seeded")
  assert.equal(community.metadata.sample_home_batch_id, BATCH)
  assert.equal(community.metadata.original, "Keep community evidence")
  assert.equal(service.db.projects.filter((home) => home.metadata.sample_import_batch_id === BATCH).length, 6)
  assert.deepEqual(service.db.projects.find((home) => home.id === UNRELATED_HOME), unrelated)
  assert.deepEqual(service.db.house_plans[0], realPlan, "a real plan sharing the series is untouched")
  assert.ok(service.db.house_plan_versions.every((version) => version.metadata.plan_source === "Keep version evidence"))

  const companions = Object.fromEntries(
    [...importer.staged]
      .filter(([, input]) => ["sample-wip-budgets.csv", "sample-wip-pos.csv"].includes(input.sourceFilename))
      .map(([batchId, input]) => [input.context.file_kind, batchId]),
  )
  assert.deepEqual(importer.staged.get(BATCH).context.companion_batch_ids, companions)
  assert.equal(service.events[0].eventType, "sample_community_seeded")
})

test("anything already in the sample namespace stops the seed before any import", async () => {
  const collisions = [
    ["house_plans", "code", "cl1650"],
    ["selection_options", "sku", "CYP-OPT-01"],
    ["selection_categories", "name", "Cypress Sample — Kitchen"],
    ["companies", "name", "Cypress Sample Trade 1"],
    ["communities", "name", "Cypress Landing"],
    ["communities", "code", "cyp"],
    ["schedule_templates", "name", "Cypress Landing 120-day build"],
    ["contacts", "email", "sample-buyer-1@example.invalid"],
  ]
  for (const [table, column, value] of collisions) {
    const service = harness()
    service.db[table] = [{ id: OTHER, org_id: ORG, [column]: value }]

    await assert.rejects(service.run(() => seedSampleCommunity(ORG, ACTOR)), /namespace already exists/, `${table}.${column}`)
    assert.equal(importer.staged.size, 0)
    assert.deepEqual(service.writes(), [])
  }
})

test("a failed house tagging leaves the community building, and a retry refuses instead of restarting", async () => {
  const service = harness()
  service.db.projects[0].metadata.wip_cutover.row_id = OTHER

  await assert.rejects(service.run(() => seedSampleCommunity(ORG, ACTOR)), /source evidence/)
  assert.equal(service.db.communities[0].metadata.sample_seed_status, "building")

  const before = structuredClone(service.db)
  const commits = importer.commits
  await assert.rejects(service.run(() => seedSampleCommunity(ORG, ACTOR)), /completion is unproven/)
  assert.deepEqual(service.db, before)
  assert.equal(importer.commits, commits)
})

test("a sample community without a completion marker cannot pass as seeded", async () => {
  const service = harness({ seeded: true })

  await assert.rejects(service.run(() => seedSampleCommunity(ORG, ACTOR)), /completion is unproven/)
  assert.equal(importer.staged.size, 0)
  assert.deepEqual(service.writes(), [])
})

test("reset refuses before touching data: names and markers cannot prove ownership", async () => {
  const service = harness({ seeded: true })

  await assert.rejects(
    service.run(() => deleteSampleCommunity(ORG, COMMUNITY, ACTOR)),
    /reset is unavailable.*ownership.*preserved/,
  )
  assert.deepEqual(service.queries.filter((query) => query.table !== "permissions"), [])
})
