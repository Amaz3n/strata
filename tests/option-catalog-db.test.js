"use strict"

/**
 * The database contract behind the legacy package save in
 * `lib/services/option-catalog.ts`: `save_selection_package` writes the package
 * row and replaces its members in one transaction.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { createDatabase, insert, rpc, seedMember, uuid } = require("./support/pglite")

async function catalog(t) {
  const db = await createDatabase(t)
  const { orgId } = await seedMember(db)
  const options = []
  for (const name of ["Cabinets", "Counters", "Flooring"]) {
    const category = await insert(db, "selection_categories", { org_id: orgId, name })
    options.push(await insert(db, "selection_options", { org_id: orgId, category_id: category.id, name: `${name} A` }))
  }
  return { db, orgId, options }
}

const fields = (patch = {}) => ({ name: "Kitchen bundle", price_cents: 1_200_000, is_available: true, sort_order: 0, ...patch })

const members = async (db, packageId) =>
  (await db.query("select option_id from selection_package_items where package_id = $1 order by option_id", [packageId])).rows.map((row) => row.option_id)

test("a new package and its members are created together", async (t) => {
  const { db, orgId, options } = await catalog(t)
  const ids = options.slice(0, 2).map((option) => option.id)
  const packageId = await rpc(db, "save_selection_package", { p_org_id: orgId, p_package_id: null, p_fields: fields(), p_option_ids: ids })
  assert.deepEqual(await members(db, packageId), [...ids].sort())
})

test("replacing a package's members swaps the whole set", async (t) => {
  const { db, orgId, options } = await catalog(t)
  const packageId = await rpc(db, "save_selection_package", { p_org_id: orgId, p_package_id: null, p_fields: fields(), p_option_ids: [options[0].id, options[1].id] })
  await rpc(db, "save_selection_package", { p_org_id: orgId, p_package_id: packageId, p_fields: fields({ name: "Renamed" }), p_option_ids: [options[2].id] })
  assert.deepEqual(await members(db, packageId), [options[2].id])
  assert.equal((await db.query("select name from selection_packages where id = $1", [packageId])).rows[0].name, "Renamed")
})

test("a rejected edit leaves the package and every member exactly as they were", async (t) => {
  const { db, orgId, options } = await catalog(t)
  const original = [options[0].id, options[1].id]
  const packageId = await rpc(db, "save_selection_package", { p_org_id: orgId, p_package_id: null, p_fields: fields(), p_option_ids: original })

  const sameCategory = await insert(db, "selection_options", { org_id: orgId, category_id: options[0].category_id, name: "Cabinets B" })
  for (const bad of [[options[0].id, sameCategory.id], [uuid()], [options[0].id, options[0].id], []]) {
    await assert.rejects(rpc(db, "save_selection_package", { p_org_id: orgId, p_package_id: packageId, p_fields: fields({ name: "Should not land" }), p_option_ids: bad }))
  }
  assert.deepEqual(await members(db, packageId), [...original].sort())
  assert.equal((await db.query("select name from selection_packages where id = $1", [packageId])).rows[0].name, "Kitchen bundle")
})

test("a rejected first save leaves no package behind", async (t) => {
  const { db, orgId } = await catalog(t)
  await assert.rejects(rpc(db, "save_selection_package", { p_org_id: orgId, p_package_id: null, p_fields: fields(), p_option_ids: [uuid()] }))
  assert.equal((await db.query("select count(*)::int as n from selection_packages")).rows[0].n, 0)
})

test("another org's options and packages are out of reach", async (t) => {
  const { db, orgId, options } = await catalog(t)
  const stranger = await seedMember(db)
  await assert.rejects(rpc(db, "save_selection_package", { p_org_id: stranger.orgId, p_package_id: null, p_fields: fields(), p_option_ids: [options[0].id] }), /not found/)
  const packageId = await rpc(db, "save_selection_package", { p_org_id: orgId, p_package_id: null, p_fields: fields(), p_option_ids: [options[0].id] })
  await assert.rejects(rpc(db, "save_selection_package", { p_org_id: stranger.orgId, p_package_id: packageId, p_fields: fields(), p_option_ids: [options[0].id] }))
})

test("an edit that does not name a cost keeps the stored cost", async (t) => {
  const { db, orgId, options } = await catalog(t)
  const packageId = await rpc(db, "save_selection_package", { p_org_id: orgId, p_package_id: null, p_fields: fields({ cost_cents: 900_000 }), p_option_ids: [options[0].id] })
  await rpc(db, "save_selection_package", { p_org_id: orgId, p_package_id: packageId, p_fields: fields({ price_cents: 1_300_000 }), p_option_ids: [options[0].id] })
  const row = (await db.query("select price_cents, cost_cents from selection_packages where id = $1", [packageId])).rows[0]
  assert.deepEqual(row, { price_cents: 1_300_000, cost_cents: 900_000 })
  await rpc(db, "save_selection_package", { p_org_id: orgId, p_package_id: packageId, p_fields: fields({ cost_cents: null }), p_option_ids: [options[0].id] })
  assert.equal((await db.query("select cost_cents from selection_packages where id = $1", [packageId])).rows[0].cost_cents, null)
})
