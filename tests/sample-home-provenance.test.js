const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, ORG, ACTOR } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")
const { ids, sampleTables } = require("./support/sample-community")

// Boundary: the platform session (the actor is a platform support writer).
stubModule("lib/services/platform-access.ts", { requireAnyPlatformPermission: async () => ({ id: ACTOR }) })

const { tagSampleImportedHomes } = freshRequire("lib/services/sample-home-provenance.ts")

const { COMMUNITY, BATCH, OTHER, UNRELATED_HOME } = ids
const input = { orgId: ORG, communityId: COMMUNITY, batchId: BATCH, actorUserId: ACTOR }

const harness = () => createServiceHarness({ tables: sampleTables() })
const tag = (service, overrides = {}) => service.run(() => tagSampleImportedHomes({ ...input, ...overrides }))

test("the six homes of the original sample batch are tagged, keeping their source metadata", async () => {
  const service = harness()
  const before = structuredClone(service.db.projects)

  assert.deepEqual(await tag(service), { tagged: 6, batchId: BATCH })

  for (const [index, home] of service.db.projects.entries()) {
    if (home.id === UNRELATED_HOME) {
      assert.deepEqual(home, before[index], "a WIP home from another import is untouched")
      continue
    }
    assert.deepEqual(home.metadata, {
      ...before[index].metadata,
      is_sample: true,
      sample_community_id: COMMUNITY,
      sample_import_batch_id: BATCH,
    })
  }
})

test("any break in the evidence chain refuses the whole set before one home is written", async () => {
  const corruptions = {
    "foreign batch": (db) => (db.import_batches[0].org_id = OTHER),
    "different creator": (db) => (db.import_batches[0].created_by = OTHER),
    "uncommitted batch": (db) => (db.import_batches[0].status = "committing"),
    "non-sample source": (db) => (db.import_batches[0].context.is_sample = false),
    "missing receipt": (db) => db.import_rows.pop(),
    "reused existing receipt": (db) => (db.import_rows[0].action = "skipped_existing"),
    "duplicate target": (db) => (db.import_rows[1].target_entity_id = db.import_rows[0].target_entity_id),
    "foreign parent": (db) => (db.import_rows[0].parsed.community_id = OTHER),
    "wrong lot": (db) => (db.lots[0].lot_number = "99"),
    "moved lot": (db) => (db.lots[0].community_id = OTHER),
    "wrong source row": (db) => (db.projects[0].metadata.wip_cutover.row_id = OTHER),
    "missing home": (db) => db.projects.shift(),
    "foreign home": (db) => (db.projects[0].org_id = OTHER),
  }
  for (const [name, corrupt] of Object.entries(corruptions)) {
    const service = harness()
    corrupt(service.db)

    await assert.rejects(tag(service), /evidence|receipts/, name)
    assert.deepEqual(service.writes(), [], name)
  }
})

test("a home whose metadata changed after it was read keeps the change and nothing is tagged", async () => {
  const service = harness()
  // Someone edits the first home between the read and the write.
  service.tamper(
    "projects",
    (result) => {
      service.db.projects[0].metadata.concurrent = "Keep this change"
      return result
    },
    { on: "select", times: 1 },
  )

  await assert.rejects(tag(service), /metadata changed/)

  assert.equal(service.db.projects[0].metadata.concurrent, "Keep this change")
  assert.ok(service.db.projects.every((home) => home.metadata.is_sample === undefined))
})

test("only the platform actor who is calling may tag", async () => {
  const service = harness()
  await assert.rejects(tag(service, { actorUserId: OTHER }), /actor mismatch/)
  assert.deepEqual(service.writes(), [])
})
