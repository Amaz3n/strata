"use strict"

/**
 * The records behind pricing and selling off standing specs
 * (20261012130000_spec_price_approvals_and_dispositions): who may decide a move
 * or a sale-off, that the proposer never does, that a move and the price it sets
 * land together, and that a sale below Books cost waits for an approved write-down.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { asRole, createDatabase, insert, seedMember } = require("./support/pglite")

const REASON = "Standing 120 days; match the comparable"

/** An org with an owner, a sales consultant, one standing spec and a buyer. */
async function specOrg(t) {
  const db = await createDatabase(t)
  const owner = await seedMember(db)
  const consultant = await seedMember(db, { orgId: owner.orgId, role: "org_sales_agent" })
  const { orgId } = owner
  const community = await insert(db, "communities", { org_id: orgId, name: "Oak Ridge" })
  const project = await insert(db, "projects", { org_id: orgId, name: "Lot 5 spec" })
  const lot = await insert(db, "lots", { org_id: orgId, community_id: community.id, lot_number: "5", status: "started", project_id: project.id, asking_price_override_cents: 410_000_00 })
  const buyer = await insert(db, "contacts", { org_id: orgId, full_name: "Harbor Rentals LLC" })
  const as = (actor, fn) => asRole(db, { role: "authenticated", userId: actor.userId }, fn)
  const home = { org_id: orgId, lot_id: lot.id, project_id: project.id, community_id: community.id }
  return { db, owner, consultant, community, project, lot, buyer, as, home }
}

const recordMove = (org, { apply, toCents = 380_000_00, permission = "sales.price_approve", lotUpdatedAt = null }) => (tx) =>
  tx.query(
    "select public.record_spec_price_move($1, $2, $3, $4, 'price', 41000000, 41000000, $5, null, $6, $7, $8, $9) as id",
    [org.home.org_id, org.lot.id, org.project.id, org.community.id, toCents, REASON, permission, apply, lotUpdatedAt],
  )

test("owners and admins approve spec price changes and sell-offs; a sales consultant does not", async (t) => {
  const db = await createDatabase(t)
  const { rows } = await db.query(`
    select p.permission_key, array_agg(r.key order by r.key) as roles
    from role_permissions p join roles r on r.id = p.role_id
    where p.permission_key in ('sales.price_approve', 'sales.disposition_approve')
    group by p.permission_key order by 1`)
  assert.deepEqual(rows, [
    { permission_key: "sales.disposition_approve", roles: ["org_admin", "org_owner"] },
    { permission_key: "sales.price_approve", roles: ["org_admin", "org_owner"] },
  ])
})

test("a move inside the band sets the price with its history row; a refused lot write leaves neither", async (t) => {
  const org = await specOrg(t)
  const { rows: [lot] } = await org.db.query("select updated_at from lots where id = $1", [org.lot.id])

  await assert.rejects(org.as(org.consultant, recordMove(org, { apply: true, toCents: 402_000_00, permission: "sales.manage", lotUpdatedAt: "2020-01-01T00:00:00Z" })), /home changed/)
  assert.equal((await org.db.query("select count(*)::int n from spec_price_proposals")).rows[0].n, 0)

  await org.as(org.consultant, recordMove(org, { apply: true, toCents: 402_000_00, permission: "sales.manage", lotUpdatedAt: lot.updated_at }))
  const { rows: [after] } = await org.db.query("select asking_price_override_cents from lots where id = $1", [org.lot.id])
  assert.equal(Number(after.asking_price_override_cents), 402_000_00)
  const { rows: history } = await org.db.query("select status, proposed_by from spec_price_proposals")
  assert.deepEqual(history, [{ status: "applied", proposed_by: org.consultant.userId }])
})

test("a waiting move is decided by someone else holding its permission, and the price lands with the decision", async (t) => {
  const org = await specOrg(t)
  const { rows: [{ id }] } = await org.as(org.consultant, recordMove(org, { apply: false }))
  const decide = (approve) => (tx) => tx.query(
    "select public.decide_spec_price_proposal($1, $2, $3, null, (select updated_at from lots where id = $4))",
    [org.home.org_id, id, approve, org.lot.id],
  )

  // The consultant holds sales.manage, not the band's sales.price_approve.
  await assert.rejects(org.as(org.consultant, decide(true)), /needs sales.price_approve/)
  // A second open move on the same home is refused.
  await assert.rejects(org.as(org.consultant, recordMove(org, { apply: false })), /spec_price_proposals_open_key/)

  await org.as(org.owner, decide(true))
  const { rows: [lot] } = await org.db.query("select asking_price_override_cents from lots where id = $1", [org.lot.id])
  assert.equal(Number(lot.asking_price_override_cents), 380_000_00)
  await assert.rejects(org.as(org.owner, decide(false)), /already decided or withdrawn/)
})

test("the person who proposed a move never approves it, even as owner", async (t) => {
  const org = await specOrg(t)
  const { rows: [{ id }] } = await org.as(org.owner, recordMove(org, { apply: false }))
  await assert.rejects(
    org.as(org.owner, (tx) => tx.query("select public.decide_spec_price_proposal($1, $2, true, null, (select updated_at from lots where id = $3))", [org.home.org_id, id, org.lot.id])),
    /spec_price_proposals_independent_check/,
  )
})

/** A disposition proposed by the consultant at a price below what Books carries. */
async function belowCost(org, patch = {}) {
  return insert(org.db, "spec_dispositions", {
    ...org.home, kind: "investor_sale", counterparty_contact_id: org.buyer.id, price_cents: 300_000_00, carrying_cents: 320_000_00,
    reason: "Standing 240 days after two price cuts", proposed_by: org.consultant.userId, ...patch,
  })
}

test("a sell-off is decided by a holder of sales.disposition_approve other than its proposer, and its terms never change", async (t) => {
  const org = await specOrg(t)
  const disposition = await belowCost(org)
  const approve = (actor) => org.as(actor, (tx) => tx.query(
    "update spec_dispositions set status = 'approved', decided_by = $2, decided_at = now() where id = $1",
    [disposition.id, actor.userId],
  ))
  await assert.rejects(approve(org.consultant), /sales.disposition_approve|independent_check/)
  await approve(org.owner)
  await assert.rejects(
    org.as(org.owner, (tx) => tx.query("update spec_dispositions set price_cents = 250000000 where id = $1", [disposition.id])),
    /terms cannot be edited/,
  )
})

test("a sale below Books cost is not carried out until its write-down is approved, and only by the buyer's agreement at the price", async (t) => {
  const org = await specOrg(t)
  const disposition = await belowCost(org, { status: "approved", decided_by: org.owner.userId, decided_at: new Date().toISOString() })
  const agreement = await insert(org.db, "contracts", {
    org_id: org.home.org_id, project_id: org.project.id, title: "Purchase Agreement — Lot 5", status: "draft",
    contract_type: "purchase_agreement", total_cents: 300_000_00, buyer_contact_id: org.buyer.id,
  })
  const execute = () => org.as(org.consultant, (tx) => tx.query(
    "update spec_dispositions set status = 'executed', contract_id = $2, executed_by = $3, executed_at = now() where id = $1",
    [disposition.id, agreement.id, org.consultant.userId],
  ))

  await assert.rejects(execute(), /write-down must be approved first/)

  const review = await insert(org.db, "books_inventory_impairments", {
    org_id: org.home.org_id, project_id: org.project.id, as_of: "2026-10-01", carrying_cents: 320_000_00, selling_price_cents: 300_000_00,
    cost_to_complete_cents: 0, cost_to_sell_cents: 9_000_00, net_realizable_cents: 291_000_00, write_down_cents: 29_000_00,
    evidence_url: "https://example.com/bpo.pdf", assumptions: "Investor offer and broker opinion", prepared_by: org.owner.userId,
  })
  await org.as(org.consultant, (tx) => tx.query("update spec_dispositions set impairment_id = $2 where id = $1", [disposition.id, review.id]))
  await assert.rejects(execute(), /write-down must be approved first/)

  // Approval posts a journal entry in Books; here the review is marked approved directly.
  await org.db.query("set session_replication_role = replica")
  await org.db.query("update books_inventory_impairments set status = 'approved', reviewed_by = $2, reviewed_at = now(), journal_entry_id = gen_random_uuid() where id = $1", [review.id, org.consultant.userId])
  await org.db.query("set session_replication_role = origin")

  await org.db.query("update contracts set total_cents = 31000000 where id = $1", [agreement.id])
  await assert.rejects(execute(), /not the approved disposition price/)
  await org.db.query("update contracts set total_cents = 30000000 where id = $1", [agreement.id])
  await execute()
  const { rows: [after] } = await org.db.query("select status, contract_id from spec_dispositions where id = $1", [disposition.id])
  assert.deepEqual(after, { status: "executed", contract_id: agreement.id })
})

test("while an approved sell-off names the buyer, nobody else may hold the lot", async (t) => {
  const org = await specOrg(t)
  await belowCost(org, { status: "approved", decided_by: org.owner.userId, decided_at: new Date().toISOString() })
  const walkIn = await insert(org.db, "contacts", { org_id: org.home.org_id, full_name: "Retail walk-in" })
  const hold = (buyerId) => insert(org.db, "lot_reservations", {
    org_id: org.home.org_id, community_id: org.community.id, lot_id: org.lot.id, buyer_contact_id: buyerId,
    status: "hold", expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  })

  await assert.rejects(hold(walkIn.id), /approved investor sale to another buyer/)
  await hold(org.buyer.id)
})
