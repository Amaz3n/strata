"use strict"

/**
 * The database contract behind land delivery (`lots.delivered_at`): a sale never
 * delivers land, and a start package cannot be opened on an undelivered lot
 * without a recorded exception.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { createDatabase, insert, seedMember } = require("./support/pglite")

async function land(t) {
  const db = await createDatabase(t)
  const { orgId } = await seedMember(db)
  const community = await insert(db, "communities", { org_id: orgId, name: "Cypress Run" })
  let number = 0
  const lot = (patch = {}) => insert(db, "lots", { org_id: orgId, community_id: community.id, lot_number: String(++number), status: "owned", ...patch })
  const openPackage = (lotRow, patch = {}) => insert(db, "start_packages", { org_id: orgId, lot_id: lotRow.id, community_id: community.id, ...patch })
  return { db, orgId, community, lot, openPackage }
}

const deliveredAt = async (db, lotId) => (await db.query("select delivered_at from lots where id = $1", [lotId])).rows[0].delivered_at

test("a lot becomes delivered the moment land development marks it developed", async (t) => {
  const { db, lot } = await land(t)
  const row = await lot()
  assert.equal(await deliveredAt(db, row.id), null)
  await db.query("update lots set status = 'developed' where id = $1", [row.id])
  assert.notEqual(await deliveredAt(db, row.id), null)
})

test("a lot loaded already developed or sold counts as delivered", async (t) => {
  const { db, lot } = await land(t)
  for (const status of ["developed", "assigned", "started", "closed"]) {
    assert.notEqual(await deliveredAt(db, (await lot({ status })).id), null, status)
  }
  assert.equal(await deliveredAt(db, (await lot({ status: "owned" })).id), null)
})

test("a sale does not deliver land: reserving an owned lot leaves it owned and undelivered", async (t) => {
  const { db, lot } = await land(t)
  const row = await lot({ status: "owned" })
  await db.query("update lots set status = 'assigned' where id = $1", [row.id])
  const stored = (await db.query("select status, delivered_at from lots where id = $1", [row.id])).rows[0]
  assert.deepEqual(stored, { status: "owned", delivered_at: null })
})

test("a developed lot that is then sold keeps its delivery date", async (t) => {
  const { db, lot } = await land(t)
  const row = await lot({ status: "owned" })
  await db.query("update lots set status = 'developed' where id = $1", [row.id])
  const delivered = await deliveredAt(db, row.id)
  await db.query("update lots set status = 'assigned' where id = $1", [row.id])
  const stored = (await db.query("select status, delivered_at from lots where id = $1", [row.id])).rows[0]
  assert.equal(stored.status, "assigned")
  assert.deepEqual(stored.delivered_at, delivered)
})

test("a start package cannot be opened on an undelivered lot", async (t) => {
  const { lot, openPackage } = await land(t)
  await assert.rejects(openPackage(await lot({ status: "owned" })), /not been delivered/)
})

test("a start package opens on a delivered lot", async (t) => {
  const { lot, openPackage } = await land(t)
  assert.equal((await openPackage(await lot({ status: "developed" }))).status, "open")
})

test("a recorded delivery exception with a real reason lets a package open; a thin one does not", async (t) => {
  const { lot, openPackage } = await land(t)
  const thin = await lot({ status: "owned", metadata: { delivery_exception: { reason: "later", by: "x", at: "y" } } })
  await assert.rejects(openPackage(thin), /not been delivered/)
  const excepted = await lot({ status: "owned", metadata: { delivery_exception: { reason: "Lot finishes with the house pad", by: "x", at: "y" } } })
  assert.equal((await openPackage(excepted)).lot_id, excepted.id)
})

test("a cancelled package record on an undelivered lot is history, not a start", async (t) => {
  const { lot, openPackage } = await land(t)
  assert.equal((await openPackage(await lot({ status: "owned" }), { status: "cancelled" })).status, "cancelled")
})
