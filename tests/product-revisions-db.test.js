"use strict"

/**
 * Plans, elevations and option catalogs have identifiable revisions, and a home
 * keeps the revisions it was sold and released against.
 *
 * The database owns the numbers: an edit that changes what is built or sold
 * moves the revision and records the definition; anything else leaves both
 * alone. The history is append-only, a released plan version records its
 * elevations' revisions, and a home's record is write-once.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { asRole, createDatabase, insert, rpc, seedMember } = require("./support/pglite")

async function catalog(t) {
  const db = await createDatabase(t)
  const { orgId, userId } = await seedMember(db)
  const plan = await insert(db, "house_plans", { org_id: orgId, code: "P-2410", name: "Aspen" })
  const elevation = await insert(db, "house_plan_elevations", { org_id: orgId, house_plan_id: plan.id, code: "B", name: "Craftsman" })
  const category = await insert(db, "selection_categories", { org_id: orgId, name: "Exterior" })
  const patio = await insert(db, "selection_options", { org_id: orgId, category_id: category.id, name: "Covered patio", price_cents: 12_000_00 })
  const fans = await insert(db, "selection_options", { org_id: orgId, category_id: category.id, name: "Ceiling fans", price_cents: 900_00 })
  return { db, orgId, userId, plan, elevation, category, patio, fans }
}

const history = async (db, entityId) =>
  (await db.query("select revision, snapshot from product_definition_revisions where entity_id = $1 order by revision", [entityId])).rows

const revisionOf = async (db, table, id) => (await db.query(`select revision from ${table} where id = $1`, [id])).rows[0].revision

test("a new elevation or option starts at revision 1 with its definition on record", async (t) => {
  const { db, elevation, patio } = await catalog(t)

  assert.equal(elevation.revision, 1)
  assert.equal(patio.revision, 1)
  const [first] = await history(db, elevation.id)
  assert.equal(first.revision, 1)
  assert.equal(first.snapshot.code, "B")
  assert.equal(first.snapshot.name, "Craftsman")
})

test("only a change to what is built or sold moves the revision", async (t) => {
  const { db, elevation, patio } = await catalog(t)

  await db.query("update house_plan_elevations set sort_order = 4, cover_file_id = null where id = $1", [elevation.id])
  await db.query("update selection_options set sort_order = 9, lead_time_days = 21, cost_cents = 700000 where id = $1", [patio.id])
  assert.equal(await revisionOf(db, "house_plan_elevations", elevation.id), 1)
  assert.equal(await revisionOf(db, "selection_options", patio.id), 1)

  await db.query("update house_plan_elevations set heated_sqft_delta = 120 where id = $1", [elevation.id])
  await db.query("update selection_options set price_cents = 1300000 where id = $1", [patio.id])
  assert.equal(await revisionOf(db, "house_plan_elevations", elevation.id), 2)
  assert.equal(await revisionOf(db, "selection_options", patio.id), 2)
  const elevationHistory = await history(db, elevation.id)
  assert.deepEqual(elevationHistory.map((row) => [row.revision, row.snapshot.heated_sqft_delta]), [[1, 0], [2, 120]])
})

test("a member's own edit moves the revision, not only the database owner's", async (t) => {
  const { db, userId, elevation, patio } = await catalog(t)

  const edited = await asRole(db, { role: "authenticated", userId }, async (tx) => [
    (await tx.query("update selection_options set price_cents = 1400000 where id = $1", [patio.id])).affectedRows,
    (await tx.query("update house_plan_elevations set heated_sqft_delta = 80 where id = $1", [elevation.id])).affectedRows,
  ])
  assert.deepEqual(edited, [1, 1])
  assert.equal(await revisionOf(db, "selection_options", patio.id), 2)
  assert.equal(await revisionOf(db, "house_plan_elevations", elevation.id), 2)
})

test("a client cannot set a revision number", async (t) => {
  const { db, elevation, patio } = await catalog(t)

  await db.query("update house_plan_elevations set revision = 40 where id = $1", [elevation.id])
  await db.query("update selection_options set revision = 40, name = 'Covered patio XL' where id = $1", [patio.id])

  assert.equal(await revisionOf(db, "house_plan_elevations", elevation.id), 1)
  assert.equal(await revisionOf(db, "selection_options", patio.id), 2)
})

test("a package save that reprices and swaps a member is one revision", async (t) => {
  const { db, orgId, patio, fans } = await catalog(t)
  const kitchen = await insert(db, "selection_categories", { org_id: orgId, name: "Kitchen" })
  const island = await insert(db, "selection_options", { org_id: orgId, category_id: kitchen.id, name: "Island", price_cents: 4_000_00 })
  const save = (packageId, priceCents, optionIds) => rpc(db, "save_selection_package", {
    p_org_id: orgId, p_package_id: packageId,
    p_fields: JSON.stringify({ name: "Outdoor living", price_cents: priceCents }), p_option_ids: optionIds,
  })

  const packageId = await save(null, 12_500_00, [patio.id, island.id])
  assert.equal(await revisionOf(db, "selection_packages", packageId), 1)

  await save(packageId, 13_000_00, [fans.id, island.id])
  assert.equal(await revisionOf(db, "selection_packages", packageId), 2)
  const recorded = await history(db, packageId)
  assert.deepEqual(recorded.map((row) => row.revision), [1, 2])
  assert.deepEqual(recorded[1].snapshot.option_ids, [fans.id, island.id].sort())
  assert.equal(recorded[1].snapshot.price_cents, 13_000_00)

  await save(packageId, 13_000_00, [island.id, fans.id])
  assert.equal(await revisionOf(db, "selection_packages", packageId), 2)
})

test("revision history cannot be rewritten or deleted, by anyone", async (t) => {
  const { db, userId, patio } = await catalog(t)

  await assert.rejects(db.query("update product_definition_revisions set snapshot = '{}' where entity_id = $1", [patio.id]), /append-only/)
  await assert.rejects(db.query("delete from product_definition_revisions where entity_id = $1", [patio.id]), /append-only/)
  await assert.rejects(
    asRole(db, { role: "authenticated", userId }, (tx) => tx.query("insert into product_definition_revisions (org_id, entity_type, entity_id, revision, snapshot) select org_id, entity_type, entity_id, 9, snapshot from product_definition_revisions limit 1")),
    /permission denied/,
  )
  const { rows } = await asRole(db, { role: "authenticated", userId }, (tx) => tx.query("select revision from product_definition_revisions where entity_id = $1", [patio.id]))
  assert.deepEqual(rows.map((row) => row.revision), [1])
})

test("a released plan version records its elevations at the revisions they had", async (t) => {
  const { db, orgId, userId, plan, elevation } = await catalog(t)
  await db.query("update house_plan_elevations set name = 'Craftsman II' where id = $1", [elevation.id])
  const version = await insert(db, "house_plan_versions", { org_id: orgId, house_plan_id: plan.id, version_number: 1, status: "draft" })

  await rpc(db, "release_house_plan_version", {
    p_org_id: orgId, p_version_id: version.id, p_actor_id: userId, p_bundle_snapshot: JSON.stringify({ captured_at: "2026-10-11" }),
  })
  await db.query("update house_plan_elevations set name = 'Craftsman III' where id = $1", [elevation.id])

  const { rows } = await db.query("select bundle_snapshot from house_plan_versions where id = $1", [version.id])
  assert.equal(rows[0].bundle_snapshot.captured_at, "2026-10-11")
  assert.deepEqual(rows[0].bundle_snapshot.elevations.map((row) => [row.code, row.revision, row.name]), [["B", 2, "Craftsman II"]])
})

test("a home's recorded revisions survive later edits and cannot be rewritten", async (t) => {
  const { db, orgId, userId, elevation, patio } = await catalog(t)
  const home = await insert(db, "projects", { org_id: orgId, name: "Lot 4" })
  const recorded = { planVersion: null, elevation: { id: elevation.id, code: "B", revision: 1 }, options: [{ id: patio.id, revision: 1 }], packages: [] }
  const record = await insert(db, "home_product_revisions", {
    org_id: orgId, project_id: home.id, stage: "release", elevation_id: elevation.id, elevation_revision: 1,
    revisions: JSON.stringify(recorded), as_of: "2026-10-11T00:00:00Z",
  })

  await db.query("update selection_options set price_cents = 1500000 where id = $1", [patio.id])
  await db.query("update house_plan_elevations set is_active = false where id = $1", [elevation.id])

  const { rows } = await db.query("select revisions, elevation_revision from home_product_revisions where id = $1", [record.id])
  assert.deepEqual(rows[0].revisions, recorded)
  assert.equal(rows[0].elevation_revision, 1)
  await assert.rejects(db.query("update home_product_revisions set elevation_revision = 2 where id = $1", [record.id]), /cannot be changed/)
  await assert.rejects(db.query("delete from home_product_revisions where id = $1", [record.id]), /cannot be deleted/)
  await assert.rejects(
    insert(db, "home_product_revisions", { org_id: orgId, project_id: home.id, stage: "release", revisions: JSON.stringify(recorded), as_of: "2026-10-12T00:00:00Z" }),
    /home_product_revisions_release_key/,
  )
  await assert.rejects(
    asRole(db, { role: "authenticated", userId }, (tx) => tx.query("insert into home_product_revisions (org_id, project_id, stage, revisions, as_of) values ($1, $2, 'agreement', '{}', now())", [orgId, home.id])),
    /permission denied/,
  )

  await db.query("delete from projects where id = $1", [home.id])
  assert.equal((await db.query("select count(*)::int as n from home_product_revisions")).rows[0].n, 0)
})
