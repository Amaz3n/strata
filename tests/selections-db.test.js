"use strict"

/**
 * The database contract behind `lib/services/selections.ts`:
 * `apply_project_selection_writes` lands a package, a group confirmation or a
 * change order on a home whole, or not at all — and only against the catalog
 * revision and home state (`read_project_selection_fence`) it was validated on.
 *
 * Two sessions writing the same home serialize on a transaction lock; PGlite
 * has one connection, so that interleaving is proven in the acceptance
 * scenario. Here the second writer is the one that read a stale fence.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { createDatabase, insert, rpc, seedMember, uuid } = require("./support/pglite")

async function home(t) {
  const db = await createDatabase(t)
  const { orgId } = await seedMember(db)
  const project = await insert(db, "projects", { org_id: orgId, name: "Lot 12" })
  const selection = async (name) => {
    const category = await insert(db, "selection_categories", { org_id: orgId, name })
    return insert(db, "project_selections", { org_id: orgId, project_id: project.id, category_id: category.id, status: "pending", metadata: JSON.stringify({ approved_envelope_id: "env-1" }) })
  }
  return { db, orgId, project, kitchen: await selection("Kitchen"), bath: await selection("Bath") }
}

const fence = (db, orgId, project) => rpc(db, "read_project_selection_fence", { p_org_id: orgId, p_project_id: project.id })

async function apply(db, orgId, project, writes, validatedOn) {
  const { catalogRevision, homeState } = validatedOn ?? await fence(db, orgId, project)
  return rpc(db, "apply_project_selection_writes", {
    p_org_id: orgId, p_project_id: project.id, p_writes: JSON.stringify(writes),
    p_expected_catalog_revision: catalogRevision, p_expected_home_state: homeState,
  })
}

const statuses = async (db) => (await db.query("select status from project_selections order by id")).rows.map((row) => row.status)

const write = (selection, overrides = {}) => ({
  id: selection.id, selected_option_id: null, package_id: null, status: "selected", selected_at: "2026-10-10T12:00:00Z",
  selected_by_contact_id: null, price_cents_snapshot: 1200_00, cost_cents_snapshot: 600_00, ...overrides,
})

test("every selection in the set is written, and signing evidence on the row survives", async (t) => {
  const { db, orgId, project, kitchen, bath } = await home(t)
  const applied = await apply(db, orgId, project, [write(kitchen, { metadata: { package_allocated: true } }), write(bath, { price_cents_snapshot: 800_00 })])
  assert.equal(applied, 2)
  const { rows } = await db.query("select id, status, price_cents_snapshot, metadata from project_selections order by price_cents_snapshot")
  assert.deepEqual(rows.map((row) => [row.status, row.price_cents_snapshot]), [["selected", 800_00], ["selected", 1200_00]])
  assert.deepEqual(rows.find((row) => row.id === kitchen.id).metadata, { approved_envelope_id: "env-1", package_allocated: true })
})

test("one write that is not on this home rolls back the whole set", async (t) => {
  const { db, orgId, project, kitchen } = await home(t)
  await assert.rejects(apply(db, orgId, project, [write(kitchen), write({ id: uuid() })]), /not on this home/)
  const { rows } = await db.query("select status from project_selections where id = $1", [kitchen.id])
  assert.equal(rows[0].status, "pending")
})

test("a confirmation keeps the choice it confirms; only the columns a write carries change", async (t) => {
  const { db, orgId, project, kitchen } = await home(t)
  await apply(db, orgId, project, [write(kitchen, { package_id: null, metadata: { package_allocated: true } })])
  await apply(db, orgId, project, [{ id: kitchen.id, status: "confirmed", confirmed_at: "2026-10-11T09:00:00Z", price_cents_snapshot: 1200_00, cost_cents_snapshot: 600_00 }])
  const { rows } = await db.query("select status, selected_at, confirmed_at, metadata from project_selections where id = $1", [kitchen.id])
  assert.equal(rows[0].status, "confirmed")
  assert.ok(rows[0].selected_at && rows[0].confirmed_at)
  assert.deepEqual(rows[0].metadata, { approved_envelope_id: "env-1", package_allocated: true })
})

test("a catalog edit published after the fence was read refuses the write and writes nothing", async (t) => {
  const { db, orgId, project, kitchen, bath } = await home(t)
  const validatedOn = await fence(db, orgId, project)
  await insert(db, "selection_categories", { org_id: orgId, name: "Exterior" })
  await assert.rejects(
    apply(db, orgId, project, [write(kitchen), write(bath)], validatedOn),
    (error) => /catalog changed while you were choosing/.test(error.message) && error.detail === "SELECTION_CATALOG_CHANGED",
  )
  assert.deepEqual(await statuses(db), ["pending", "pending"])
})

test("a write that landed on the same home after the fence was read refuses the second write", async (t) => {
  const { db, orgId, project, kitchen, bath } = await home(t)
  const first = await fence(db, orgId, project)
  const second = await fence(db, orgId, project)
  await apply(db, orgId, project, [write(kitchen)], first)
  await assert.rejects(
    apply(db, orgId, project, [write(bath)], second),
    (error) => /selections changed while you were choosing/.test(error.message) && error.detail === "SELECTION_HOME_CHANGED",
  )
  const { rows } = await db.query("select status from project_selections where id = $1", [bath.id])
  assert.equal(rows[0].status, "pending")
})

test("a selection records the revision of the option it chose, and keeps it when the option is edited", async (t) => {
  const { db, orgId, project, kitchen } = await home(t)
  const category = (await db.query("select category_id from project_selections where id = $1", [kitchen.id])).rows[0].category_id
  const option = await insert(db, "selection_options", { org_id: orgId, category_id: category, name: "Quartz", price_cents: 3_000_00 })
  await db.query("update selection_options set price_cents = 3500000, description = 'Calacatta' where id = $1", [option.id])

  await apply(db, orgId, project, [write(kitchen, { selected_option_id: option.id })])
  await db.query("update selection_options set price_cents = 3600000 where id = $1", [option.id])
  await apply(db, orgId, project, [{ id: kitchen.id, status: "confirmed", confirmed_at: "2026-10-11T09:00:00Z" }])

  const revision = async () => (await db.query("select selected_option_revision from project_selections where id = $1", [kitchen.id])).rows[0].selected_option_revision
  assert.equal(await revision(), 2)
  await db.query("update project_selections set selected_option_revision = 7 where id = $1", [kitchen.id])
  assert.equal(await revision(), 2)
  await apply(db, orgId, project, [{ id: kitchen.id, selected_option_id: null }])
  assert.equal(await revision(), null)
})

test("a selection records the revision of the package it chose, and keeps it when the package is revised", async (t) => {
  const { db, orgId, project, kitchen } = await home(t)
  const pkg = await insert(db, "selection_packages", { org_id: orgId, name: "Chef's kitchen", price_cents: 12_000_00 })
  await db.query("update selection_packages set price_cents = 1300000 where id = $1", [pkg.id])

  await apply(db, orgId, project, [write(kitchen, { package_id: pkg.id })])
  await db.query("update selection_packages set price_cents = 1400000 where id = $1", [pkg.id])
  assert.equal((await db.query("select revision from selection_packages where id = $1", [pkg.id])).rows[0].revision, 3)
  await apply(db, orgId, project, [{ id: kitchen.id, status: "confirmed", confirmed_at: "2026-10-11T09:00:00Z" }])

  const revision = async () => (await db.query("select selected_package_revision from project_selections where id = $1", [kitchen.id])).rows[0].selected_package_revision
  assert.equal(await revision(), 2)
  await db.query("update project_selections set selected_package_revision = 7 where id = $1", [kitchen.id])
  assert.equal(await revision(), 2)
  await apply(db, orgId, project, [{ id: kitchen.id, package_id: null }])
  assert.equal(await revision(), null)
})

test("a write without the fence it was validated on is refused", async (t) => {
  const { db, orgId, project, kitchen } = await home(t)
  const { catalogRevision } = await fence(db, orgId, project)
  for (const validatedOn of [{ catalogRevision: null, homeState: "0".repeat(32) }, { catalogRevision, homeState: "stale" }]) {
    await assert.rejects(apply(db, orgId, project, [write(kitchen)], validatedOn), /validated on/)
  }
  assert.deepEqual(await statuses(db), ["pending", "pending"])
})

test("signed-in users cannot read the fence or call the set write directly", async (t) => {
  const { db, orgId, project, kitchen } = await home(t)
  const member = await seedMember(db, { orgId })
  const caller = { role: "authenticated", userId: member.userId }
  await assert.rejects(rpc(db, "read_project_selection_fence", { p_org_id: orgId, p_project_id: project.id }, caller), /permission denied/)
  await assert.rejects(
    rpc(db, "apply_project_selection_writes", {
      p_org_id: orgId, p_project_id: project.id, p_writes: JSON.stringify([write(kitchen)]),
      p_expected_catalog_revision: "1", p_expected_home_state: "0".repeat(32),
    }, caller),
    /permission denied/,
  )
})
