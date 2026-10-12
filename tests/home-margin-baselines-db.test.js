"use strict"

/**
 * A home's sale price and margin are locked once they bind.
 *
 * A signed purchase agreement's price and configuration cannot be rewritten by
 * any role, and the margin baselines captured at sale and release are
 * write-once and walled by division like every other row of a home.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { asRole, createDatabase, insert, seedMember } = require("./support/pglite")

const SNAPSHOT = {
  purchase_agreement: {
    version: 1,
    configuration: { lot_id: "00000000-0000-4000-8000-000000000001", option_items: [] },
    pricing: { basePriceCents: 450_000_00, lotPremiumCents: 25_000_00, incentivesCents: 10_000_00, totalCents: 465_000_00, catalogRevision: "7" },
  },
}

async function soldHome(t) {
  const db = await createDatabase(t)
  const { orgId, userId: ownerId } = await seedMember(db)
  const north = await insert(db, "divisions", { org_id: orgId, name: "North" })
  const south = await insert(db, "divisions", { org_id: orgId, name: "South" })
  const home = await insert(db, "projects", { org_id: orgId, name: "Lot 4", division_id: north.id })
  const other = await insert(db, "projects", { org_id: orgId, name: "Lot 9", division_id: south.id })
  const agreement = await insert(db, "contracts", {
    org_id: orgId, project_id: home.id, title: "Purchase Agreement — Lot 4", contract_type: "purchase_agreement",
    status: "draft", total_cents: 465_000_00, snapshot: JSON.stringify(SNAPSHOT),
  })
  return { db, orgId, ownerId, north, south, home, other, agreement }
}

const sign = (db, contractId) =>
  db.query("update contracts set status = 'active', signed_at = now(), signature_data = '{\"envelope_id\":\"e1\"}' where id = $1", [contractId])

test("a draft agreement can still be repriced", async (t) => {
  const { db, agreement } = await soldHome(t)

  await db.query("update contracts set total_cents = 47000000 where id = $1", [agreement.id])

  assert.equal((await db.query("select total_cents from contracts where id = $1", [agreement.id])).rows[0].total_cents, 470_000_00)
})

test("a signed agreement's price and configuration cannot be changed by any role", async (t) => {
  const { db, agreement } = await soldHome(t)
  await sign(db, agreement.id)

  const repricings = [
    "update contracts set total_cents = 400000000 where id = $1",
    "update contracts set snapshot = jsonb_set(snapshot, '{purchase_agreement,pricing,totalCents}', '400000000') where id = $1",
    "update contracts set snapshot = snapshot || '{\"cancelled_at\":\"2026-10-01\"}' where id = $1",
    "update contracts set contract_type = 'fixed_price' where id = $1",
  ]
  for (const sql of repricings) {
    await assert.rejects(db.query(sql, [agreement.id]), /Amend it with a change order/)
    await assert.rejects(asRole(db, { role: "service_role" }, (tx) => tx.query(sql, [agreement.id])), /Amend it with a change order/)
  }

  const { rows } = await db.query("select total_cents, snapshot from contracts where id = $1", [agreement.id])
  assert.equal(rows[0].total_cents, 465_000_00)
  assert.deepEqual(rows[0].snapshot, SNAPSHOT)
})

test("a signed agreement still moves through signing and void", async (t) => {
  const { db, agreement } = await soldHome(t)
  await sign(db, agreement.id)

  await db.query("update contracts set signature_data = signature_data || '{\"execution_effects_completed\":true}' where id = $1", [agreement.id])
  await db.query(
    "update contracts set status = 'void', snapshot = snapshot || '{\"cancellation_reason\":\"financing\",\"cancelled_at\":\"2026-10-11\"}' where id = $1",
    [agreement.id],
  )

  const { rows } = await db.query("select status, total_cents, snapshot from contracts where id = $1", [agreement.id])
  assert.equal(rows[0].status, "void")
  assert.equal(rows[0].total_cents, 465_000_00)
  assert.deepEqual(rows[0].snapshot.purchase_agreement, SNAPSHOT.purchase_agreement)
  // The void record is as fixed as the price.
  await assert.rejects(
    db.query("update contracts set snapshot = snapshot || '{\"cancellation_reason\":\"other\"}' where id = $1", [agreement.id]),
    /Amend it with a change order/,
  )
})

async function captured(db, { orgId, home, agreement }) {
  return asRole(db, { role: "service_role" }, async (tx) => (await tx.query(
    `insert into home_margin_baselines
       (org_id, project_id, contract_id, stage, sale_price_cents, incentives_cents, lot_premium_cents, options_price_cents,
        base_cost_cents, options_cost_cents, cost_cents, margin_cents, margin_bps, catalog_revision)
     values ($1, $2, $3, 'release', 46500000, 1000000, 2500000, 0, 36000000, 0, 36000000, 10500000, 2258, 7)
     returning *`,
    [orgId, home.id, agreement.id],
  )).rows[0])
}

test("a margin baseline is written once and never changed or removed", async (t) => {
  const fixture = await soldHome(t)
  const { db, orgId, home, agreement } = fixture
  await sign(db, agreement.id)
  const baseline = await captured(db, fixture)

  await assert.rejects(captured(db, fixture), /home_margin_baselines_release_key/)
  for (const as of [null, "service_role"]) {
    const run = (sql) => as ? asRole(db, { role: as }, (tx) => tx.query(sql, [baseline.id])) : db.query(sql, [baseline.id])
    await assert.rejects(run("update home_margin_baselines set margin_cents = 0, sale_price_cents = cost_cents where id = $1"), /cannot be changed/)
    await assert.rejects(run("delete from home_margin_baselines where id = $1"), /cannot be deleted/)
  }
  await assert.rejects(
    asRole(db, { role: "service_role" }, (tx) => tx.query(
      "insert into home_margin_baselines (org_id, project_id, contract_id, stage, sale_price_cents, cost_cents, margin_cents) values ($1, $2, $3, 'agreement', 100, 60, 10)",
      [orgId, home.id, agreement.id],
    )),
    /home_margin_baselines_margin_check/,
  )

  // It leaves with its home.
  await db.query("delete from projects where id = $1", [home.id])
  assert.equal((await db.query("select count(*)::int as n from home_margin_baselines")).rows[0].n, 0)
})

test("members read only their division's baselines and cannot write them", async (t) => {
  const fixture = await soldHome(t)
  const { db, orgId, north, other } = fixture
  await sign(db, fixture.agreement.id)
  await captured(db, fixture)
  const southAgreement = await insert(db, "contracts", {
    org_id: orgId, project_id: other.id, title: "Purchase Agreement — Lot 9", contract_type: "purchase_agreement",
    status: "active", total_cents: 1_00, snapshot: "{}",
  })
  await captured(db, { orgId, home: other, agreement: southAgreement })

  const { userId } = await seedMember(db, { orgId, role: "org_project_lead" })
  const { rows: membership } = await db.query(
    "update memberships set division_scope = 'assigned' where org_id = $1 and user_id = $2 returning id", [orgId, userId],
  )
  await insert(db, "membership_divisions", { membership_id: membership[0].id, division_id: north.id })

  const as = (fn) => asRole(db, { role: "authenticated", userId }, fn)
  const seen = await as(async (tx) => (await tx.query("select project_id from home_margin_baselines")).rows.map((row) => row.project_id))
  assert.deepEqual(seen, [fixture.home.id])
  const owner = await asRole(db, { role: "authenticated", userId: fixture.ownerId }, async (tx) =>
    (await tx.query("select count(*)::int as n from home_margin_baselines")).rows[0].n)
  assert.equal(owner, 2)

  await assert.rejects(
    as((tx) => tx.query("insert into home_margin_baselines (org_id, project_id, stage) values ($1, $2, 'agreement')", [orgId, fixture.home.id])),
    /permission denied/,
  )
})

test("a baseline is cost and margin: a member without financials.margin.read reads none", async (t) => {
  const fixture = await soldHome(t)
  const { db, orgId } = fixture
  await sign(db, fixture.agreement.id)
  await captured(db, fixture)
  const { userId } = await seedMember(db, { orgId, role: "org_project_lead" })
  const visible = async () => asRole(db, { role: "authenticated", userId }, async (tx) =>
    (await tx.query("select count(*)::int as n from home_margin_baselines")).rows[0].n)

  assert.equal(await visible(), 1)
  await db.query(
    "insert into membership_permission_overrides (membership_id, permission_key, effect) select id, 'financials.margin.read', 'deny' from memberships where org_id = $1 and user_id = $2",
    [orgId, userId],
  )
  assert.equal(await visible(), 0)
})
