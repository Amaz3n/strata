"use strict"

/**
 * The records behind pricing and selling off standing specs
 * (20261012130000_spec_price_approvals_and_dispositions, hardened by
 * 20261012170000_ep04_review_fixes): who may decide a move or a sale-off, that
 * the proposer never does, that a move and the price it sets land together and
 * only through the service's functions, and that a sale below what Books carries
 * waits for an approved write-down.
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
  // The services call the move functions with the service client, after their own checks.
  const system = (fn) => asRole(db, { role: "service_role" }, fn)
  const home = { org_id: orgId, lot_id: lot.id, project_id: project.id, community_id: community.id }
  return { db, owner, consultant, community, project, lot, buyer, as, system, home }
}

const recordMove = (org, { apply, actor = org.consultant, toCents = 380_000_00, permission = "sales.price_approve", lotUpdatedAt = null }) => (tx) =>
  tx.query(
    "select public.record_spec_price_move($1, $2, $3, $4, 'price', 41000000, 41000000, $5, null, $6, $7, $8, $9, $10) as id",
    [org.home.org_id, org.lot.id, org.project.id, org.community.id, toCents, REASON, permission, apply, lotUpdatedAt, actor.userId],
  )

const decideMove = (org, id, { approve, actor }) => (tx) =>
  tx.query(
    "select public.decide_spec_price_proposal($1, $2, $3, null, (select updated_at from lots where id = $4), $5)",
    [org.home.org_id, id, approve, org.lot.id, actor.userId],
  )

/** What Books carries for the home: posted cost on its inventory account (1160). */
async function carryInBooks(org, cents) {
  await org.db.query("set session_replication_role = replica")
  const account = await insert(org.db, "gl_accounts", { org_id: org.home.org_id, code: "1160", name: "Homes under construction", account_type: "asset", subtype: "work_in_progress", normal_balance: "debit" })
  const entry = await insert(org.db, "journal_entries", { org_id: org.home.org_id, entry_date: "2026-09-01", entry_kind: "operational", status: "posted", posted_at: new Date().toISOString(), memo: "Construction cost", posting_key: `cost:${org.project.id}`, policy_version: 1 })
  await insert(org.db, "journal_lines", { org_id: org.home.org_id, entry_id: entry.id, line_no: 1, account_id: account.id, project_id: org.project.id, debit_cents: cents, legal_entity_id: org.home.org_id })
  await org.db.query("set session_replication_role = origin")
}

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

  await assert.rejects(org.system(recordMove(org, { apply: true, toCents: 402_000_00, permission: "sales.manage", lotUpdatedAt: "2020-01-01T00:00:00Z" })), /home changed/)
  assert.equal((await org.db.query("select count(*)::int n from spec_price_proposals")).rows[0].n, 0)

  await org.system(recordMove(org, { apply: true, toCents: 402_000_00, permission: "sales.manage", lotUpdatedAt: lot.updated_at }))
  const { rows: [after] } = await org.db.query("select asking_price_override_cents from lots where id = $1", [org.lot.id])
  assert.equal(Number(after.asking_price_override_cents), 402_000_00)
  const { rows: history } = await org.db.query("select status, proposed_by from spec_price_proposals")
  assert.deepEqual(history, [{ status: "applied", proposed_by: org.consultant.userId }])
})

test("a waiting move is decided by someone else, and the price lands with the decision", async (t) => {
  const org = await specOrg(t)
  const { rows: [{ id }] } = await org.system(recordMove(org, { apply: false }))

  // A second open move on the same home is refused.
  await assert.rejects(org.system(recordMove(org, { apply: false })), /spec_price_proposals_open_key/)

  await org.system(decideMove(org, id, { approve: true, actor: org.owner }))
  const { rows: [lot] } = await org.db.query("select asking_price_override_cents from lots where id = $1", [org.lot.id])
  assert.equal(Number(lot.asking_price_override_cents), 380_000_00)
  await assert.rejects(org.system(decideMove(org, id, { approve: false, actor: org.owner })), /already decided or withdrawn/)
})

test("the person who proposed a move never approves it, even as owner", async (t) => {
  const org = await specOrg(t)
  const { rows: [{ id }] } = await org.system(recordMove(org, { apply: false, actor: org.owner }))
  await assert.rejects(org.system(decideMove(org, id, { approve: true, actor: org.owner })), /spec_price_proposals_independent_check/)
})

test("a member never picks a move's band: the move functions are the service's, and moves and prices are not written directly", async (t) => {
  const org = await specOrg(t)
  const { rows: [lot] } = await org.db.query("select updated_at from lots where id = $1", [org.lot.id])

  // A sales consultant applying a half-price cut "inside the band" they name.
  await assert.rejects(
    org.as(org.consultant, recordMove(org, { apply: true, toCents: 205_000_00, permission: "sales.manage", lotUpdatedAt: lot.updated_at })),
    /permission denied/,
  )
  // Or writing an applied incentive (or any move) straight into the history.
  for (const status of ["applied", "proposed"]) {
    await assert.rejects(
      org.as(org.consultant, (tx) => tx.query(
        "insert into spec_price_proposals (org_id, lot_id, project_id, community_id, kind, asking_price_cents, from_cents, to_cents, reason, required_permission, status, proposed_by) values ($1, $2, $3, $4, 'incentive', 41000000, 0, 10000000, $5, 'sales.manage', $6, $7)",
        [org.home.org_id, org.lot.id, org.project.id, org.community.id, REASON, status, org.consultant.userId],
      )),
      /permission denied/,
    )
  }
  // Or the lot's asking price itself, whoever the member is. A consultant holds no lot key,
  // so the member write fence leaves them no row to update; the owner reaches the row and
  // the price-move guard refuses.
  const writePrice = (actor) => org.as(actor, (tx) => tx.query("update lots set asking_price_override_cents = 100 where id = $1", [org.lot.id]))
  assert.equal((await writePrice(org.consultant)).affectedRows, 0)
  await assert.rejects(writePrice(org.owner), /set by a price move/)
  const { rows: [after] } = await org.db.query("select asking_price_override_cents from lots where id = $1", [org.lot.id])
  assert.equal(Number(after.asking_price_override_cents), 410_000_00)

  // A waiting move is decided through the function, never by a direct update; the proposer may withdraw it.
  const { rows: [{ id }] } = await org.system(recordMove(org, { apply: false }))
  const approveDirectly = (actor) => org.as(actor, (tx) => tx.query("update spec_price_proposals set status = 'approved', decided_by = $2, decided_at = now() where id = $1", [id, actor.userId]))
  assert.equal((await approveDirectly(org.owner)).affectedRows, 0)
  await assert.rejects(approveDirectly(org.consultant), /row-level security|decided through its approval/)
  await org.as(org.consultant, (tx) => tx.query("update spec_price_proposals set status = 'withdrawn', decided_at = now() where id = $1", [id]))
  const { rows: [withdrawn] } = await org.db.query("select status from spec_price_proposals where id = $1", [id])
  assert.equal(withdrawn.status, "withdrawn")
})

/** A disposition proposed by the consultant at a price below what Books carries. */
async function belowCost(org, patch = {}) {
  await carryInBooks(org, 320_000_00)
  return insert(org.db, "spec_dispositions", {
    ...org.home, kind: "investor_sale", counterparty_contact_id: org.buyer.id, price_cents: 300_000_00,
    reason: "Standing 240 days after two price cuts", proposed_by: org.consultant.userId, ...patch,
  })
}

test("a disposition carries what Books carries for the home, whatever its proposer writes", async (t) => {
  const org = await specOrg(t)
  await carryInBooks(org, 320_000_00)
  const { rows: [row] } = await org.as(org.consultant, (tx) => tx.query(
    "insert into spec_dispositions (org_id, lot_id, project_id, community_id, kind, counterparty_contact_id, price_cents, carrying_cents, reason, proposed_by) values ($1, $2, $3, $4, 'investor_sale', $5, 30000000, 0, 'Standing 240 days after two price cuts', $6) returning carrying_cents",
    [org.home.org_id, org.lot.id, org.project.id, org.community.id, org.buyer.id, org.consultant.userId],
  ))
  assert.equal(Number(row.carrying_cents), 320_000_00)
})

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
