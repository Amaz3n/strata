"use strict"

/**
 * A prospect's scope in the database: `prospects.notes` is the one canonical
 * Scope field. Editing it re-prices the precon brief (a new version and
 * pricing revision), and no other brief editor can overwrite it.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { createDatabase, insert, seedMember } = require("./support/pglite")

let db
test.before(async () => {
  db = await createDatabase()
})
test.after(() => db.close())

/** A prospect with notes and the precon workspace its scope seeded. */
async function deal() {
  const { orgId } = await seedMember(db)
  const prospect = await insert(db, "prospects", { org_id: orgId, name: "Lakeside", notes: "Original scope" })
  const workspace = async () => (await db.query("select * from precon_workspaces where prospect_id = $1", [prospect.id])).rows[0]
  const setNotes = (notes) => db.query("update prospects set notes = $1 where id = $2", [notes, prospect.id])
  return { orgId, prospect, workspace, setNotes }
}

test("a new prospect's notes seed its brief scope", async () => {
  const d = await deal()
  const workspace = await d.workspace()

  assert.equal(workspace.brief.scope, "Original scope")
  assert.equal(workspace.brief.pricing_revision, workspace.version)
})

test("editing the notes moves the scope to a new pricing revision and keeps the worksheet", async () => {
  const d = await deal()
  await db.query("update precon_workspaces set brief = brief || $1 where prospect_id = $2", [
    { pricing_worksheet: { saved: true } },
    d.prospect.id,
  ])
  const before = await d.workspace()

  await d.setNotes("Updated scope")

  const after = await d.workspace()
  assert.equal(after.brief.scope, "Updated scope")
  assert.deepEqual(after.brief.pricing_worksheet, { saved: true })
  assert.equal(after.version, before.version + 1)
  assert.equal(after.brief.pricing_revision, after.version)
  const stale = await db.query("update precon_workspaces set version = version + 1 where prospect_id = $1 and version = $2", [
    d.prospect.id,
    before.version,
  ])
  assert.equal(stale.affectedRows, 0, "a writer holding the old version loses")
})

test("clearing the notes clears the scope, and a brief editor cannot put stale scope back", async () => {
  const d = await deal()

  await d.setNotes(null)
  assert.equal((await d.workspace()).brief.scope, "")

  await db.query("update precon_workspaces set brief = jsonb_set(brief, '{scope}', to_jsonb('Stale scope'::text)) where prospect_id = $1", [
    d.prospect.id,
  ])
  assert.equal((await d.workspace()).brief.scope, "")
})
