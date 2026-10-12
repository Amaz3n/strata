"use strict"

/**
 * The database contract behind land delivery (`lots.delivered_at`): a sale never
 * delivers land, only the database writes the delivery date, and a house cannot
 * start on an undelivered lot without an authorized delivery exception.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { asRole, createDatabase, insert, rpc, seedMember } = require("./support/pglite")

async function land(t) {
  const db = await createDatabase(t)
  const { orgId, userId: ownerId } = await seedMember(db)
  const community = await insert(db, "communities", { org_id: orgId, name: "Cypress Run" })
  let number = 0
  const lot = (patch = {}) => insert(db, "lots", { org_id: orgId, community_id: community.id, lot_number: String(++number), status: "owned", ...patch })
  const openPackage = (lotRow, patch = {}) => insert(db, "start_packages", { org_id: orgId, lot_id: lotRow.id, community_id: community.id, ...patch })
  const except = (lotRow, patch = {}) =>
    insert(db, "lot_delivery_exceptions", { org_id: orgId, lot_id: lotRow.id, reason: "Lot finishes with the house pad", approved_by: ownerId, ...patch })
  return { db, orgId, ownerId, community, lot, openPackage, except }
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
  const { db, orgId, lot } = await land(t)
  for (const status of ["developed", "assigned", "started", "closed"]) {
    const home = ["started", "closed"].includes(status) ? { project_id: (await insert(db, "projects", { org_id: orgId, name: "Home", property_type: "production" })).id } : {}
    assert.notEqual(await deliveredAt(db, (await lot({ status, ...home })).id), null, status)
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

test("an active delivery exception lets a package open; a revoked one does not", async (t) => {
  const { db, ownerId, lot, openPackage, except } = await land(t)
  const excepted = await lot({ status: "owned" })
  await except(excepted)
  assert.equal((await openPackage(excepted)).lot_id, excepted.id)

  const revoked = await lot({ status: "owned" })
  const exception = await except(revoked)
  await db.query("update lot_delivery_exceptions set revoked_at = now(), revoked_by = $2 where id = $1", [exception.id, ownerId])
  await assert.rejects(openPackage(revoked), /not been delivered/)
})

test("a delivery exception needs a real reason and is never rewritten", async (t) => {
  const { db, lot, except } = await land(t)
  await assert.rejects(except(await lot(), { reason: "later" }), /lot_delivery_exceptions_reason_check/)
  const exception = await except(await lot())
  await assert.rejects(db.query("update lot_delivery_exceptions set reason = 'Something else entirely' where id = $1", [exception.id]), /only revoked once/)
})

test("a lot cannot start on undelivered land without an exception, whoever writes it", async (t) => {
  const { db, orgId, lot, except } = await land(t)
  const home = async () => (await insert(db, "projects", { org_id: orgId, name: "Home", property_type: "production" })).id
  const undelivered = await lot({ status: "owned", project_id: await home() })
  await assert.rejects(db.query("update lots set status = 'started' where id = $1", [undelivered.id]), /not been delivered/)
  await except(undelivered)
  await db.query("update lots set status = 'started' where id = $1", [undelivered.id])
  const delivered = await lot({ status: "developed" })
  await db.query("update lots set status = 'started', project_id = $2 where id = $1", [delivered.id, await home()])
})

test("a signed-in member cannot forge delivery: the date is the database's, developed takes lot.write", async (t) => {
  const { db, orgId, lot } = await land(t)
  const row = await lot({ status: "owned" })
  const { userId: salesAgent } = await seedMember(db, { orgId, role: "org_sales_agent" })
  const { userId: landManager } = await seedMember(db, { orgId, role: "org_land_manager" })
  const as = (userId, sql) => asRole(db, { role: "authenticated", userId }, (tx) => tx.query(sql, [row.id]))

  await assert.rejects(as(landManager, "update lots set delivered_at = now() where id = $1"), /marking the lot developed/)
  await assert.rejects(as(salesAgent, "update lots set status = 'developed' where id = $1"), /takes lot.write/)
  await as(landManager, "update lots set status = 'developed' where id = $1")
  assert.notEqual(await deliveredAt(db, row.id), null)
})

test("only a holder of lot.delivery_override records an exception, in their own name", async (t) => {
  const { db, orgId, ownerId, lot } = await land(t)
  const row = await lot({ status: "owned" })
  const { userId: salesAgent } = await seedMember(db, { orgId, role: "org_sales_agent" })
  const { userId: landManager } = await seedMember(db, { orgId, role: "org_land_manager" })
  const record = (userId, approvedBy) =>
    asRole(db, { role: "authenticated", userId }, (tx) =>
      tx.query("insert into lot_delivery_exceptions (org_id, lot_id, reason, approved_by) values ($1, $2, 'Lot finishes with the house pad', $3) returning id", [orgId, row.id, approvedBy]),
    )

  await assert.rejects(record(salesAgent, salesAgent), /row-level security/)
  await assert.rejects(record(landManager, ownerId), /row-level security/)
  assert.equal((await record(landManager, landManager)).rowCount, 1)
})

test("a cancelled package record on an undelivered lot is history, not a start", async (t) => {
  const { lot, openPackage } = await land(t)
  assert.equal((await openPackage(await lot({ status: "owned" }), { status: "cancelled" })).status, "cancelled")
})

// ---------------------------------------------------------------------------
// Lot allocation guards (20261012120000): one lot, one home, one owner.

async function sales(t) {
  const base = await land(t)
  const { db, orgId, community } = base
  const buyer = async (name) => (await insert(db, "contacts", { org_id: orgId, full_name: name })).id
  const home = async (client = null) => (await insert(db, "projects", { org_id: orgId, name: "Home", property_type: "production", client_id: client })).id
  const hold = (lotRow, buyerId, patch = {}) =>
    insert(db, "lot_reservations", { org_id: orgId, community_id: community.id, lot_id: lotRow.id, buyer_contact_id: buyerId, status: "hold", expires_at: new Date(Date.now() + 86_400_000).toISOString(), ...patch })
  const release = (reservationId, actorId = base.ownerId) =>
    rpc(db, "release_lot_reservation", { p_org_id: orgId, p_actor_id: actorId, p_reservation_id: reservationId, p_reason: "Buyer withdrew", p_deposit_disposition: null })
  return { ...base, buyer, home, hold, release }
}

test("a lot's status agrees with its home, whoever writes it", async (t) => {
  const { db, lot, home } = await sales(t)
  await assert.rejects(lot({ status: "started" }), /must be attached before a lot can be marked started/)
  await assert.rejects(lot({ status: "closed" }), /cannot be closed without a home/)
  await assert.rejects(lot({ status: "controlled", project_id: await home() }), /cannot be set to controlled/)
  const developed = await lot({ status: "developed" })
  await assert.rejects(db.query("update lots set project_id = $2 where id = $1", [developed.id, await home()]), /cannot be set to developed/)

  // A presale of undelivered land keeps the land status, so an owned lot may carry its home.
  const owned = await lot({ status: "owned" })
  await db.query("update lots set project_id = $2, status = 'assigned' where id = $1", [owned.id, await home()])
  assert.equal((await db.query("select status from lots where id = $1", [owned.id])).rows[0].status, "owned")

  const started = await lot({ status: "started", project_id: await home() })
  await assert.rejects(db.query("update lots set project_id = null where id = $1", [started.id]), /must be attached/)
  await db.query("update lots set project_id = null, status = 'assigned' where id = $1", [started.id])
})

test("a lot that broke the rule before the guard is judged only when its status or home changes", async (t) => {
  const { db, lot } = await sales(t)
  await db.exec("alter table lots disable trigger lots_status_home_guard")
  const legacy = await lot({ status: "started" })
  await db.exec("alter table lots enable trigger lots_status_home_guard")
  await db.query("update lots set notes = 'Surveyed' where id = $1", [legacy.id])
  await assert.rejects(db.query("update lots set status = 'closed' where id = $1", [legacy.id]), /cannot be closed without a home/)
})

test("a home attaches to a held lot only when it is the holding buyer's", async (t) => {
  const { db, lot, buyer, home, hold } = await sales(t)
  const [alma, bao] = [await buyer("Alma"), await buyer("Bao")]
  const attach = async (lotRow, client) => db.query("update lots set project_id = $2, status = 'started' where id = $1", [lotRow.id, await home(client)])

  const held = await lot({ status: "developed" })
  await hold(held, alma)
  await assert.rejects(attach(held, bao), /live hold or reservation for another buyer/)
  await assert.rejects(attach(held, null), /live hold or reservation for another buyer/)
  await attach(held, alma)

  const lapsed = await lot({ status: "developed" })
  await hold(lapsed, alma, { expires_at: new Date(Date.now() - 60_000).toISOString() })
  await attach(lapsed, bao)
})

test("a hold is refused on a lot whose home belongs to another buyer", async (t) => {
  const { lot, buyer, home, hold } = await sales(t)
  const [alma, bao] = [await buyer("Alma"), await buyer("Bao")]
  const sold = await lot({ status: "assigned", project_id: await home(bao) })
  await assert.rejects(hold(sold, alma), /home belongs to another buyer/)
  assert.equal((await hold(sold, bao)).status, "hold")
  const spec = await lot({ status: "assigned", project_id: await home() })
  assert.equal((await hold(spec, alma)).status, "hold")
})

test("a lapsed hold gives way to the next hold on its lot, on the record; a live one does not", async (t) => {
  const { db, lot, buyer, hold } = await sales(t)
  const [alma, bao, cleo] = [await buyer("Alma"), await buyer("Bao"), await buyer("Cleo")]
  const row = await lot({ status: "developed" })
  const first = await hold(row, alma, { expires_at: new Date(Date.now() - 60_000).toISOString() })
  const second = await hold(row, bao)
  const expired = (await db.query("select status, release_reason from lot_reservations where id = $1", [first.id])).rows[0]
  assert.deepEqual(expired, { status: "expired", release_reason: "Hold expired" })
  assert.equal(Number((await db.query("select count(*) n from events where event_type = 'lot_hold_expired' and entity_id = $1", [first.id])).rows[0].n), 1)
  await assert.rejects(hold(row, cleo), /lot_reservations_live_lot_uniq/)
  assert.equal((await db.query("select status from lot_reservations where id = $1", [second.id])).rows[0].status, "hold")
})

test("a release is one transition: the second finds nothing, an open agreement must be voided first, and the home returns to inventory", async (t) => {
  const { db, orgId, lot, buyer, home, hold, release } = await sales(t)
  const alma = await buyer("Alma")
  const homeId = await home(alma)
  const row = await lot({ status: "assigned", project_id: homeId })
  const reservation = await hold(row, alma, { status: "reserved", expires_at: null })
  const contract = await insert(db, "contracts", { org_id: orgId, project_id: homeId, title: "Purchase agreement", contract_type: "purchase_agreement", status: "draft" })
  await db.query("update lot_reservations set contract_id = $2 where id = $1", [reservation.id, contract.id])

  await assert.rejects(release(reservation.id), /Void the agreement to release it/)
  await db.query("update contracts set status = 'void' where id = $1", [contract.id])
  const released = await release(reservation.id)
  assert.deepEqual([released.before.status, released.after.status], ["reserved", "released"])
  await assert.rejects(release(reservation.id), /Live reservation not found/)
  assert.equal((await db.query("select client_id from projects where id = $1", [homeId])).rows[0].client_id, null)
})

// ---------------------------------------------------------------------------
// Member writes (20261012170000): what the services fence, the database fences.

test("a started or closed lot moves back only for a member holding community.write, the force path's authority", async (t) => {
  const { db, orgId, ownerId, lot, home } = await sales(t)
  const { userId: field } = await seedMember(db, { orgId, role: "field" })
  const as = (userId, sql, args) => asRole(db, { role: "authenticated", userId }, (tx) => tx.query(sql, args))
  const started = await lot({ status: "started", project_id: await home() })
  const closed = await lot({ status: "closed", project_id: await home() })

  for (const row of [started, closed]) {
    await assert.rejects(as(field, "update lots set status = 'owned' where id = $1", [row.id]), /is a reversal/)
  }
  await assert.rejects(as(field, "update lots set project_id = null, status = 'assigned' where id = $1", [started.id]), /is a reversal/)
  assert.equal((await db.query("select status from lots where id = $1", [started.id])).rows[0].status, "started")

  await as(ownerId, "update lots set status = 'owned' where id = $1", [started.id])
  assert.equal((await db.query("select status from lots where id = $1", [started.id])).rows[0].status, "owned")
})

test("a reservation keeps its buyer and lot, moves only along its lifecycle, and is never moved or deleted by a direct member write", async (t) => {
  const { db, orgId, ownerId, lot, buyer, home, hold } = await sales(t)
  const { userId: field } = await seedMember(db, { orgId, role: "field" })
  const as = (userId, sql, args) => asRole(db, { role: "authenticated", userId }, (tx) => tx.query(sql, args))
  const [alma, bao] = [await buyer("Alma"), await buyer("Bao")]
  const row = await lot({ status: "developed" })
  const live = await hold(row, bao)

  // The reviewer's case: a member rewrites a live hold to another buyer and calls it sold.
  await assert.rejects(as(field, "update lot_reservations set buyer_contact_id = $2, status = 'converted' where id = $1", [live.id, alma]), /stays with its buyer and lot/)
  await assert.rejects(as(ownerId, "update lot_reservations set status = 'released' where id = $1", [live.id]), /through the sales flow/)
  await assert.rejects(as(field, "delete from lot_reservations where id = $1", [live.id]), /permission denied/)
  // A member may still annotate a hold.
  await as(field, "update lot_reservations set notes = 'Asked about the corner lot' where id = $1", [live.id])

  // Whoever writes it, a hold never jumps to a sale, and a released one stays released.
  await assert.rejects(db.query("update lot_reservations set status = 'converted' where id = $1", [live.id]), /cannot move from hold to converted/)
  // A reservation becoming a sale belongs to the buyer whose home stands on the lot.
  await db.exec("alter table lots disable trigger lots_home_reservation_guard")
  await db.query("update lots set project_id = $2, status = 'started' where id = $1", [row.id, await home(alma)])
  await db.exec("alter table lots enable trigger lots_home_reservation_guard")
  await assert.rejects(db.query("update lot_reservations set status = 'reserved' where id = $1", [live.id]), /home belongs to another buyer/)
  await db.query("update lot_reservations set status = 'released', released_at = now() where id = $1", [live.id])
  await assert.rejects(db.query("update lot_reservations set status = 'hold' where id = $1", [live.id]), /cannot move from released to hold/)
})

test("a member creates a reservation only as a hold; reserving and converting are the sales flow's", async (t) => {
  const { db, orgId, community, lot, buyer } = await sales(t)
  const { userId: field } = await seedMember(db, { orgId, role: "field" })
  const alma = await buyer("Alma")
  const insertAs = (status, row) => asRole(db, { role: "authenticated", userId: field }, (tx) =>
    tx.query("insert into lot_reservations (org_id, community_id, lot_id, buyer_contact_id, status, expires_at) values ($1, $2, $3, $4, $5, now() + interval '2 days') returning status",
      [orgId, community.id, row.id, alma, status]))

  for (const status of ["reserved", "converted"]) {
    await assert.rejects(insertAs(status, await lot({ status: "developed" })), /starts as a hold/)
  }
  assert.equal((await insertAs("hold", await lot({ status: "developed" }))).rows[0].status, "hold")
})

test("a sales member cannot attach an agreement to a reservation with their own client", async (t) => {
  const { db, orgId, lot, buyer, home, hold } = await sales(t)
  const { userId: salesAgent } = await seedMember(db, { orgId, role: "org_sales_agent" })
  const alma = await buyer("Alma")
  const homeId = await home(alma)
  const row = await lot({ status: "assigned", project_id: homeId })
  const reservation = await hold(row, alma, { status: "reserved", expires_at: null })
  const draft = await insert(db, "contracts", { org_id: orgId, project_id: homeId, title: "Purchase agreement", contract_type: "purchase_agreement", status: "draft" })

  // Agreement creation takes the reservation inside create_purchase_agreement_atomic, the only path.
  await assert.rejects(
    asRole(db, { role: "authenticated", userId: salesAgent }, (tx) => tx.query("update lot_reservations set contract_id = $2 where id = $1", [reservation.id, draft.id])),
    /through the sales flow/,
  )
})

test("a home's asking price moves only by repricing: a member changes neither its lot premium nor its plan's price", async (t) => {
  const { db, orgId, ownerId, community, lot, home } = await sales(t)
  const as = (sql, args) => asRole(db, { role: "authenticated", userId: ownerId }, (tx) => tx.query(sql, args))
  const [big, small, twin] = await Promise.all(["Big", "Small", "Twin"].map((name) => insert(db, "house_plans", { org_id: orgId, name, code: name.toUpperCase() })))
  for (const [plan, cents] of [[big, 450_000_00], [small, 380_000_00], [twin, 450_000_00]]) {
    await insert(db, "community_plan_availability", { org_id: orgId, community_id: community.id, house_plan_id: plan.id, base_price_cents: cents, is_available: true })
  }
  const spec = await lot({ status: "started", project_id: await home(), house_plan_id: big.id, premium_cents: 50_000_00 })
  const bare = await lot({ status: "developed", premium_cents: 10_000_00 })

  // The reviewer's case: drop the premium and swap in a cheaper plan on a spec home that was never repriced.
  await assert.rejects(as("update lots set premium_cents = 0 where id = $1", [spec.id]), /has a home: its premium is part of the home's asking price/)
  await assert.rejects(as("update lots set house_plan_id = $2 where id = $1", [spec.id, small.id]), /would move its home's asking price/)
  // A plan change that leaves the price where it was is not a price move.
  await as("update lots set house_plan_id = $2 where id = $1", [spec.id, twin.id])
  // Nor by moving the lot to a community whose sheet prices the plan lower.
  const cheaper = await insert(db, "communities", { org_id: orgId, name: "Cheaper Run" })
  await assert.rejects(as("update lots set community_id = $2 where id = $1", [spec.id, cheaper.id]), /has a home: it stays in its community/)
  // A lot without a home is still priced freely.
  await as("update lots set premium_cents = 0 where id = $1", [bare.id])
  const { rows } = await db.query("select id, premium_cents::int as premium, house_plan_id from lots where id in ($1, $2) order by lot_number", [spec.id, bare.id])
  assert.deepEqual(rows, [{ id: spec.id, premium: 50_000_00, house_plan_id: twin.id }, { id: bare.id, premium: 0, house_plan_id: null }])
})

test("a home goes on or comes off a lot only for a lot.write holder, so nobody reprices a spec home by detaching it", async (t) => {
  const { db, orgId, community, lot, home } = await sales(t)
  const { userId: field } = await seedMember(db, { orgId, role: "field" })
  const { userId: landManager } = await seedMember(db, { orgId, role: "org_land_manager" })
  const as = (userId, sql, args) => asRole(db, { role: "authenticated", userId }, (tx) => tx.query(sql, args))
  const specId = await home()
  const spec = await lot({ status: "assigned", project_id: specId, premium_cents: 50_000_00 })
  const bare = await lot({ status: "owned" })

  // The reviewer's sequence starts by detaching the home so its premium thaws.
  await assert.rejects(as(field, "update lots set project_id = null where id = $1", [spec.id]), /takes lot.write/)
  await assert.rejects(as(field, "update lots set project_id = $2 where id = $1", [bare.id, await home()]), /takes lot.write/)
  await assert.rejects(
    as(field, "insert into lots (org_id, community_id, lot_number, status, project_id) values ($1, $2, '99', 'owned', $3)", [orgId, community.id, await home()]),
    /takes lot.write/,
  )

  await as(landManager, "update lots set project_id = null where id = $1", [spec.id])
  await as(landManager, "update lots set project_id = $2 where id = $1", [spec.id, specId])
  const { rows } = await db.query("select project_id, premium_cents::int as premium from lots where id = $1", [spec.id])
  assert.deepEqual(rows[0], { project_id: specId, premium: 50_000_00 })
})

test("a member closes a lot only once its home's closing is recorded", async (t) => {
  const { db, orgId, lot, home } = await sales(t)
  const { userId: field } = await seedMember(db, { orgId, role: "field" })
  const homeId = await home()
  const row = await lot({ status: "started", project_id: homeId })
  const close = () => asRole(db, { role: "authenticated", userId: field }, (tx) => tx.query("update lots set status = 'closed' where id = $1", [row.id]))

  await assert.rejects(close(), /closes when its home's closing is recorded/)
  await db.query("set session_replication_role = replica")
  await insert(db, "closings", { org_id: orgId, project_id: homeId, lot_id: row.id, status: "closed", scheduled_date: "2026-10-01", actual_date: "2026-10-01" })
  await db.query("set session_replication_role = origin")
  await close()
  assert.equal((await db.query("select status from lots where id = $1", [row.id])).rows[0].status, "closed")
})
