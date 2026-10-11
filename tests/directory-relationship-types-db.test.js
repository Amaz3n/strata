"use strict"

/**
 * An organisation's directory vocabulary: every org, new or old, has the whole
 * default set of party roles, buyer roles included, because registering a buyer
 * promotes an inquiry into `prospect` and fails on an org that lacks it.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { createDatabase, seedMember } = require("./support/pglite")

const DEFAULT_KEYS = [
  "agent", "architect", "buyer", "client", "consultant", "engineer", "homeowner",
  "internal", "other", "prospect", "subcontractor", "supplier", "vendor",
]

const keysOf = async (db, orgId) =>
  (await db.query("select key from directory_relationship_types where org_id = $1 order by key", [orgId])).rows.map((row) => row.key)

test("a new organisation starts with every default party role, buyer roles included", async (t) => {
  const db = await createDatabase(t)
  const { orgId } = await seedMember(db)
  assert.deepEqual(await keysOf(db, orgId), DEFAULT_KEYS)
})

test("completing an organisation's vocabulary restores what is missing and keeps what it renamed", async (t) => {
  const db = await createDatabase(t)
  const { orgId } = await seedMember(db)
  await db.query("delete from directory_relationship_types where org_id = $1 and key in ('prospect', 'buyer')", [orgId])
  await db.query("update directory_relationship_types set label = 'Client account' where org_id = $1 and key = 'client'", [orgId])

  await db.query("select seed_org_directory_relationship_types($1)", [orgId])

  assert.deepEqual(await keysOf(db, orgId), DEFAULT_KEYS)
  const { rows } = await db.query("select label from directory_relationship_types where org_id = $1 and key = 'client'", [orgId])
  assert.equal(rows[0].label, "Client account")
})
