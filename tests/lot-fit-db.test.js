"use strict"

/**
 * The records behind "does the house fit the lot" (20261012040000_lot_fit):
 * who may record a fit override, that an override is never edited, and that
 * both tables stand behind the division wall like the lots they belong to.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { asRole, createDatabase, insert, seedMember } = require("./support/pglite")

async function member(db, orgId, { role, divisions = null }) {
  const { userId } = await seedMember(db, { orgId, role })
  if (divisions) {
    const { rows } = await db.query(
      "update memberships set division_scope = 'assigned' where org_id = $1 and user_id = $2 returning id",
      [orgId, userId],
    )
    for (const divisionId of divisions) await insert(db, "membership_divisions", { membership_id: rows[0].id, division_id: divisionId })
  }
  return userId
}

/** An org with a lot in each of two divisions, a plan with an elevation, and an evidence file. */
async function fitOrg(t) {
  const db = await createDatabase(t)
  const { orgId, userId: ownerId } = await seedMember(db)
  const north = await insert(db, "divisions", { org_id: orgId, name: "North" })
  const south = await insert(db, "divisions", { org_id: orgId, name: "South" })
  const oak = await insert(db, "communities", { org_id: orgId, name: "Oak", division_id: north.id })
  const pine = await insert(db, "communities", { org_id: orgId, name: "Pine", division_id: south.id })
  const oakLot = await insert(db, "lots", { org_id: orgId, community_id: oak.id, lot_number: "Oak 1" })
  const pineLot = await insert(db, "lots", { org_id: orgId, community_id: pine.id, lot_number: "Pine 1" })
  const plan = await insert(db, "house_plans", { org_id: orgId, code: "A100", name: "Aspen", footprint_width_ft: 40, footprint_depth_ft: 60 })
  const elevation = await insert(db, "house_plan_elevations", { org_id: orgId, house_plan_id: plan.id, code: "A" })
  const evidence = await insert(db, "files", { org_id: orgId, file_name: "plot.pdf", storage_path: `${orgId}/lots/plot.pdf` })
  return { db, orgId, ownerId, north, south, oak, pine, oakLot, pineLot, plan, elevation, evidence }
}

function overrideRow(org, lot, approvedBy, extra = {}) {
  return {
    org_id: org.orgId,
    lot_id: lot.id,
    house_plan_id: org.plan.id,
    house_plan_elevation_id: org.elevation.id,
    swing: "left",
    violations: JSON.stringify([{ code: "footprint_too_wide", message: "Too wide", expected: "≤ 38 ft", actual: "40 ft" }]),
    reason: "Variance granted by the county",
    evidence_file_id: org.evidence.id,
    approved_by: approvedBy,
    ...extra,
  }
}

const INSERT_OVERRIDE = `
  insert into lot_fit_overrides (org_id, lot_id, house_plan_id, house_plan_elevation_id, swing, violations, reason, evidence_file_id, approved_by)
  values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9) returning id`

function insertOverride(tx, row) {
  return tx.query(INSERT_OVERRIDE, [
    row.org_id, row.lot_id, row.house_plan_id, row.house_plan_elevation_id, row.swing, row.violations, row.reason, row.evidence_file_id, row.approved_by,
  ])
}

test("every role that may release a plan may override a lot's fit, and no other role gains it", async (t) => {
  const db = await createDatabase(t)
  const { rows } = await db.query(`
    select
      array(select r.key from roles r join role_permissions rp on rp.role_id = r.id and rp.permission_key = 'plan.release' order by 1) as releasers,
      array(select r.key from roles r join role_permissions rp on rp.role_id = r.id and rp.permission_key = 'lot.fit_override' order by 1) as overriders`)
  assert.ok(rows[0].releasers.length > 0)
  assert.deepEqual(rows[0].overriders, rows[0].releasers)
})

test("only a holder of lot.fit_override records an override, and only in their own name", async (t) => {
  const org = await fitOrg(t)
  const seller = await member(org.db, org.orgId, { role: "org_sales_agent" })
  const as = (userId, fn) => asRole(org.db, { role: "authenticated", userId }, fn)

  await assert.rejects(as(seller, (tx) => insertOverride(tx, overrideRow(org, org.oakLot, seller))), /row-level security/)
  await assert.rejects(as(org.ownerId, (tx) => insertOverride(tx, overrideRow(org, org.oakLot, seller))), /row-level security/)
  const { rows } = await as(org.ownerId, (tx) => insertOverride(tx, overrideRow(org, org.oakLot, org.ownerId)))
  assert.equal(rows.length, 1)
})

test("an override is never edited; it is revoked once and stays on the record", async (t) => {
  const org = await fitOrg(t)
  const as = (fn) => asRole(org.db, { role: "authenticated", userId: org.ownerId }, fn)
  const { rows: [{ id }] } = await as((tx) => insertOverride(tx, overrideRow(org, org.oakLot, org.ownerId)))

  await assert.rejects(as((tx) => tx.query("update lot_fit_overrides set reason = 'Something else entirely' where id = $1", [id])), /only revoked once/)
  await as((tx) => tx.query("update lot_fit_overrides set revoked_at = now(), revoked_by = $2 where id = $1", [id, org.ownerId]))
  await assert.rejects(as((tx) => tx.query("update lot_fit_overrides set revoked_at = now(), revoked_by = $2 where id = $1", [id, org.ownerId])), /only revoked once/)
  await assert.rejects(as((tx) => tx.query("delete from lot_fit_overrides where id = $1", [id])), /permission denied/)
  const { rows } = await org.db.query("select revoked_at is not null as revoked, reason from lot_fit_overrides where id = $1", [id])
  assert.deepEqual(rows, [{ revoked: true, reason: "Variance granted by the county" }])
})

test("an override needs evidence and a reason, and cannot name another org's records", async (t) => {
  const org = await fitOrg(t)
  const stranger = await seedMember(org.db)
  const foreignPlan = await insert(org.db, "house_plans", { org_id: stranger.orgId, code: "Z9", name: "Elsewhere" })
  const foreignElevation = await insert(org.db, "house_plan_elevations", { org_id: stranger.orgId, house_plan_id: foreignPlan.id, code: "Z" })
  const as = (fn) => asRole(org.db, { role: "authenticated", userId: org.ownerId }, fn)

  await assert.rejects(as((tx) => insertOverride(tx, overrideRow(org, org.oakLot, org.ownerId, { reason: "short" }))), /lot_fit_overrides_reason_check/)
  await assert.rejects(as((tx) => insertOverride(tx, overrideRow(org, org.oakLot, org.ownerId, { evidence_file_id: null }))), /evidence file/)
  await assert.rejects(
    as((tx) => insertOverride(tx, overrideRow(org, org.oakLot, org.ownerId, { house_plan_elevation_id: foreignElevation.id }))),
    /elevation does not belong to this organization/,
  )
  await assert.rejects(
    as((tx) => tx.query("insert into lot_allowed_elevations (org_id, lot_id, house_plan_elevation_id) values ($1, $2, $3)", [org.orgId, org.oakLot.id, foreignElevation.id])),
    /elevation does not belong to this organization/,
  )
})

test("a division-limited member reads and writes fit records only on their division's lots", async (t) => {
  const org = await fitOrg(t)
  const northLead = await member(org.db, org.orgId, { role: "org_project_lead", divisions: [org.north.id] })
  for (const lot of [org.oakLot, org.pineLot]) {
    await insertOverride(org.db, overrideRow(org, lot, org.ownerId))
    await insert(org.db, "lot_allowed_elevations", { org_id: org.orgId, lot_id: lot.id, house_plan_elevation_id: org.elevation.id })
  }
  const as = (userId, fn) => asRole(org.db, { role: "authenticated", userId }, fn)
  const visible = (userId) =>
    as(userId, async (tx) => ({
      overrides: (await tx.query("select lot_id from lot_fit_overrides order by 1")).rows.map((row) => row.lot_id),
      allowed: (await tx.query("select lot_id from lot_allowed_elevations order by 1")).rows.map((row) => row.lot_id),
    }))

  assert.deepEqual(await visible(northLead), { overrides: [org.oakLot.id], allowed: [org.oakLot.id] })
  const everything = [org.oakLot.id, org.pineLot.id].sort()
  assert.deepEqual(await visible(org.ownerId), { overrides: everything, allowed: everything })

  await assert.rejects(
    as(northLead, (tx) => tx.query("insert into lot_allowed_elevations (org_id, lot_id, house_plan_elevation_id) values ($1, $2, $3)", [org.orgId, org.pineLot.id, org.elevation.id])),
    /row-level security/,
  )
  const { rowCount } = await as(northLead, (tx) => tx.query("delete from lot_allowed_elevations where lot_id = $1", [org.pineLot.id]))
  assert.equal(rowCount, 0)
})
