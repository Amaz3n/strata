"use strict"

/**
 * The records behind a plan change review (20261012050000_plan_change_proposals):
 * who may decide, that a decision once made stays made, and that the homes
 * under review stand behind the division wall like the lots they name.
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

function releasedVersion(orgId, planId, releasedBy, versionNumber, status) {
  return { org_id: orgId, house_plan_id: planId, version_number: versionNumber, status, released_at: "2026-09-01T00:00:00Z", released_by: releasedBy, bundle_snapshot: JSON.stringify({}) }
}

/** An org with a plan at v1 (superseded) and v2 (released), a lot pinned to v1 in each of two divisions, and an open review. */
async function reviewOrg(t) {
  const db = await createDatabase(t)
  const { orgId, userId: ownerId } = await seedMember(db)
  const north = await insert(db, "divisions", { org_id: orgId, name: "North" })
  const south = await insert(db, "divisions", { org_id: orgId, name: "South" })
  const oak = await insert(db, "communities", { org_id: orgId, name: "Oak", division_id: north.id })
  const pine = await insert(db, "communities", { org_id: orgId, name: "Pine", division_id: south.id })
  const plan = await insert(db, "house_plans", { org_id: orgId, code: "A100", name: "Aspen" })
  const v1 = await insert(db, "house_plan_versions", releasedVersion(orgId, plan.id, ownerId, 1, "superseded"))
  const v2 = await insert(db, "house_plan_versions", releasedVersion(orgId, plan.id, ownerId, 2, "released"))
  const oakLot = await insert(db, "lots", { org_id: orgId, community_id: oak.id, lot_number: "Oak 1", house_plan_id: plan.id, house_plan_version_id: v1.id })
  const pineLot = await insert(db, "lots", { org_id: orgId, community_id: pine.id, lot_number: "Pine 1", house_plan_id: plan.id, house_plan_version_id: v1.id })
  const review = await insert(db, "plan_change_proposals", { org_id: orgId, house_plan_id: plan.id, to_version_id: v2.id, status: "in_review", created_by: ownerId })
  const home = (lot) => insert(db, "plan_change_proposal_homes", {
    org_id: orgId, proposal_id: review.id, lot_id: lot.id, from_version_id: v1.id, home_state: "contracted", cost_delta_cents: 150000,
  })
  const oakHome = await home(oakLot)
  const pineHome = await home(pineLot)
  return { db, orgId, ownerId, north, south, plan, v1, v2, oakLot, pineLot, review, oakHome, pineHome }
}

test("every role that may release a plan may decide who adopts it, and no other role gains it", async (t) => {
  const db = await createDatabase(t)
  const { rows } = await db.query(`
    select
      array(select r.key from roles r join role_permissions rp on rp.role_id = r.id and rp.permission_key = 'plan.release' order by 1) as releasers,
      array(select r.key from roles r join role_permissions rp on rp.role_id = r.id and rp.permission_key = 'plan.adopt' order by 1) as adopters`)
  assert.ok(rows[0].releasers.length > 0)
  assert.deepEqual(rows[0].adopters, rows[0].releasers)
})

test("only a holder of plan.adopt records a decision, and only in their own name", async (t) => {
  const org = await reviewOrg(t)
  const seller = await member(org.db, org.orgId, { role: "org_sales_agent" })
  const as = (userId, fn) => asRole(org.db, { role: "authenticated", userId }, fn)
  const decide = (decidedBy) => (tx) => tx.query(
    "update plan_change_proposal_homes set decision = 'defer', decided_by = $2, decided_at = now() where id = $1",
    [org.oakHome.id, decidedBy],
  )

  const { rowCount: sellerCount } = await as(seller, decide(seller))
  assert.equal(sellerCount, 0)
  await assert.rejects(as(org.ownerId, decide(seller)), /row-level security/)
  const { rowCount } = await as(org.ownerId, decide(org.ownerId))
  assert.equal(rowCount, 1)
})

test("adopt and decline are final, a decline says why, and a home's place in the review never changes", async (t) => {
  const org = await reviewOrg(t)
  const as = (fn) => asRole(org.db, { role: "authenticated", userId: org.ownerId }, fn)
  const set = (sql, params = []) => as((tx) => tx.query(sql, [org.oakHome.id, ...params]))

  await assert.rejects(
    set("update plan_change_proposal_homes set decision = 'decline', decided_by = $2, decided_at = now(), reason = 'no' where id = $1", [org.ownerId]),
    /decline_reason_check/,
  )
  await set("update plan_change_proposal_homes set decision = 'decline', decided_by = $2, decided_at = now(), reason = 'Buyer signed the v1 layout' where id = $1", [org.ownerId])
  await assert.rejects(
    set("update plan_change_proposal_homes set decision = 'adopt' where id = $1"),
    /decision is final/,
  )
  await assert.rejects(
    set("update plan_change_proposal_homes set cost_delta_cents = 0 where id = $1"),
    /cannot be changed/,
  )
  await assert.rejects(as((tx) => tx.query("delete from plan_change_proposal_homes where id = $1", [org.oakHome.id])), /permission denied/)
})

test("a review names only its own organization's lots and versions of the plan under review", async (t) => {
  const org = await reviewOrg(t)
  const stranger = await seedMember(org.db)
  const strangerCommunity = await insert(org.db, "communities", { org_id: stranger.orgId, name: "Elsewhere" })
  const foreignLot = await insert(org.db, "lots", { org_id: stranger.orgId, community_id: strangerCommunity.id, lot_number: "Z1" })
  const otherPlan = await insert(org.db, "house_plans", { org_id: org.orgId, code: "B200", name: "Birch" })
  const otherVersion = await insert(org.db, "house_plan_versions", releasedVersion(org.orgId, otherPlan.id, org.ownerId, 1, "released"))
  const as = (fn) => asRole(org.db, { role: "authenticated", userId: org.ownerId }, fn)
  const insertHome = (lotId, versionId) => as((tx) => tx.query(
    "insert into plan_change_proposal_homes (org_id, proposal_id, lot_id, from_version_id, home_state) values ($1, $2, $3, $4, 'unsold')",
    [org.orgId, org.review.id, lotId, versionId],
  ))

  await assert.rejects(insertHome(foreignLot.id, org.v1.id), /lot does not belong to this organization/)
  await assert.rejects(insertHome(org.oakLot.id, otherVersion.id), /does not belong to the plan under review/)
  await assert.rejects(
    as((tx) => tx.query(
      "insert into plan_change_proposals (org_id, house_plan_id, to_version_id, created_by) values ($1, $2, $3, $4)",
      [org.orgId, org.plan.id, otherVersion.id, org.ownerId],
    )),
    /does not belong to this plan/,
  )
})

test("one open review per plan", async (t) => {
  const org = await reviewOrg(t)
  await assert.rejects(
    insert(org.db, "plan_change_proposals", { org_id: org.orgId, house_plan_id: org.plan.id, to_version_id: org.v2.id, created_by: org.ownerId }),
    /plan_change_proposals_open_key/,
  )
})

test("a division-limited member reads and decides only the homes on their division's lots", async (t) => {
  const org = await reviewOrg(t)
  // An org admin reaches every division; a purchasing manager holds plan.adopt without being one.
  const northLead = await member(org.db, org.orgId, { role: "org_purchasing_manager", divisions: [org.north.id] })
  const as = (fn) => asRole(org.db, { role: "authenticated", userId: northLead }, fn)

  const { rows } = await as((tx) => tx.query("select lot_id from plan_change_proposal_homes order by 1"))
  assert.deepEqual(rows.map((row) => row.lot_id), [org.oakLot.id])
  const { rowCount } = await as((tx) => tx.query(
    "update plan_change_proposal_homes set decision = 'defer', decided_by = $2, decided_at = now() where id = $1",
    [org.pineHome.id, northLead],
  ))
  assert.equal(rowCount, 0)
})
