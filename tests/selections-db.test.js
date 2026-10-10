"use strict"

/**
 * The database contract behind `lib/services/selections.ts`:
 * `apply_project_selection_writes` lands a package or a change order on a home
 * whole, or not at all.
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

const write = (selection, overrides = {}) => ({
  id: selection.id, selected_option_id: null, package_id: null, status: "selected", selected_at: "2026-10-10T12:00:00Z",
  selected_by_contact_id: null, price_cents_snapshot: 1200_00, cost_cents_snapshot: 600_00, ...overrides,
})

test("every selection in the set is written, and signing evidence on the row survives", async (t) => {
  const { db, orgId, project, kitchen, bath } = await home(t)
  const applied = await rpc(db, "apply_project_selection_writes", {
    p_org_id: orgId, p_project_id: project.id,
    p_writes: JSON.stringify([write(kitchen, { metadata: { package_allocated: true } }), write(bath, { price_cents_snapshot: 800_00 })]),
  })
  assert.equal(applied, 2)
  const { rows } = await db.query("select id, status, price_cents_snapshot, metadata from project_selections order by price_cents_snapshot")
  assert.deepEqual(rows.map((row) => [row.status, row.price_cents_snapshot]), [["selected", 800_00], ["selected", 1200_00]])
  assert.deepEqual(rows.find((row) => row.id === kitchen.id).metadata, { approved_envelope_id: "env-1", package_allocated: true })
})

test("one write that is not on this home rolls back the whole set", async (t) => {
  const { db, orgId, project, kitchen } = await home(t)
  await assert.rejects(
    rpc(db, "apply_project_selection_writes", {
      p_org_id: orgId, p_project_id: project.id,
      p_writes: JSON.stringify([write(kitchen), write({ id: uuid() })]),
    }),
    /not on this home/,
  )
  const { rows } = await db.query("select status from project_selections where id = $1", [kitchen.id])
  assert.equal(rows[0].status, "pending")
})

test("signed-in users cannot call the set write directly", async (t) => {
  const { db, orgId, project, kitchen } = await home(t)
  const member = await seedMember(db, { orgId })
  await assert.rejects(
    rpc(db, "apply_project_selection_writes", { p_org_id: orgId, p_project_id: project.id, p_writes: JSON.stringify([write(kitchen)]) }, { role: "authenticated", userId: member.userId }),
    /permission denied/,
  )
})
