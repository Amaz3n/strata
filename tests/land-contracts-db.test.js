"use strict"

/**
 * The database contract behind land contracts: what was signed stays signed.
 * An executed contract's terms, its deposit schedule and its takedowns' lot
 * counts and prices cannot change; a close date moves only through a recorded
 * extension; amendments are never rewritten; and only land_contract.write
 * holders write any of it.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { asRole, createDatabase, insert, rpc, seedMember } = require("./support/pglite")

async function land(t) {
  const db = await createDatabase(t)
  const { orgId, userId: ownerId } = await seedMember(db)
  const community = await insert(db, "communities", { org_id: orgId, name: "Cypress Run" })
  const seller = await insert(db, "companies", { org_id: orgId, name: "Hill Country Land Co" })
  const signed = await insert(db, "files", {
    org_id: orgId,
    file_name: "purchase-agreement.pdf",
    storage_path: `${orgId}/land/purchase-agreement.pdf`,
  })
  const contract = (patch = {}) =>
    insert(db, "land_contracts", {
      org_id: orgId,
      community_id: community.id,
      seller_company_id: seller.id,
      title: "Cypress Run phase 1 purchase",
      kind: "option",
      total_lots: 40,
      base_price_per_lot_cents: 72_000_00,
      ...patch,
    })
  const takedown = (contractId, patch = {}) =>
    insert(db, "lot_takedowns", {
      org_id: orgId,
      community_id: community.id,
      land_contract_id: contractId,
      name: "Tranche 1",
      scheduled_date: "2026-12-01",
      lot_count: 10,
      price_per_lot_cents: 72_000_00,
      ...patch,
    })
  const execute = (contractId) =>
    db.query("update land_contracts set status = 'executed', executed_on = '2026-10-01', executed_file_id = $2 where id = $1", [
      contractId,
      signed.id,
    ])
  return { db, orgId, ownerId, community, signed, contract, takedown, execute }
}

test("a contract executes only against a signed file", async (t) => {
  const { db, contract } = await land(t)
  const row = await contract()
  await assert.rejects(
    db.query("update land_contracts set status = 'executed', executed_on = '2026-10-01' where id = $1", [row.id]),
    /land_contracts_execution_check/,
  )
})

test("an executed contract's terms cannot change; it can still be completed", async (t) => {
  const { db, contract, execute } = await land(t)
  const row = await contract()
  await execute(row.id)
  for (const change of ["total_lots = 45", "base_price_per_lot_cents = 1", "penalty_terms = 'none'", "executed_on = '2026-09-01'"]) {
    await assert.rejects(db.query(`update land_contracts set ${change} where id = $1`, [row.id]), /terms cannot change/, change)
  }
  await assert.rejects(db.query("update land_contracts set status = 'draft' where id = $1", [row.id]), /executed to terminated or completed/)
  await assert.rejects(db.query("delete from land_contracts where id = $1", [row.id]), /is kept/)
  await db.query("update land_contracts set status = 'completed' where id = $1", [row.id])
})

test("the deposit schedule and the takedowns of an executed contract are signed terms", async (t) => {
  const { db, orgId, contract, takedown, execute } = await land(t)
  const row = await contract()
  const tranche = await takedown(row.id)
  const deposit = await insert(db, "land_contract_deposits", {
    org_id: orgId,
    land_contract_id: row.id,
    takedown_id: tranche.id,
    due_on: "2026-10-15",
    amount_cents: 50_000_00,
    refundability: "non_refundable",
  })
  await execute(row.id)

  await assert.rejects(db.query("update land_contract_deposits set amount_cents = 1 where id = $1", [deposit.id]), /cannot change/)
  await assert.rejects(
    insert(db, "land_contract_deposits", { org_id: orgId, land_contract_id: row.id, due_on: "2027-01-01", amount_cents: 1 }),
    /cannot change/,
  )
  await assert.rejects(db.query("update lot_takedowns set lot_count = 12 where id = $1", [tranche.id]), /signed terms/)
  await assert.rejects(db.query("update lot_takedowns set price_per_lot_cents = 1 where id = $1", [tranche.id]), /signed terms/)
  await assert.rejects(db.query("update lot_takedowns set scheduled_date = '2027-02-01' where id = $1", [tranche.id]), /is an extension/)
  await assert.rejects(takedown(row.id, { name: "Tranche 2" }), /before it is executed/)
})

test("a deposit payment needs its receipt, and moves only forward", async (t) => {
  const { db, orgId, signed, contract, execute } = await land(t)
  const row = await contract()
  const deposit = await insert(db, "land_contract_deposits", { org_id: orgId, land_contract_id: row.id, due_on: "2026-10-15", amount_cents: 50_000_00 })
  await execute(row.id)

  await assert.rejects(
    db.query("update land_contract_deposits set status = 'paid', paid_on = '2026-10-14' where id = $1", [deposit.id]),
    /land_contract_deposits_evidence_check/,
  )
  await db.query("update land_contract_deposits set status = 'paid', paid_on = '2026-10-14', evidence_file_id = $2 where id = $1", [deposit.id, signed.id])
  await assert.rejects(db.query("update land_contract_deposits set status = 'scheduled' where id = $1", [deposit.id]), /moves scheduled, then paid/)
  await assert.rejects(db.query("update land_contract_deposits set paid_on = '2026-10-01' where id = $1", [deposit.id]), /cannot be rewritten/)
  await assert.rejects(db.query("delete from land_contract_deposits where id = $1", [deposit.id]), /is kept/)
})

test("an extension writes the amendment and the new close date together", async (t) => {
  const { db, orgId, ownerId, signed, contract, takedown, execute } = await land(t)
  const row = await contract()
  const tranche = await takedown(row.id, { metadata: { reminded_at_30d: "2026-11-01T00:00:00Z" } })
  await execute(row.id)

  const amendmentId = await rpc(db, "record_land_contract_extension", {
    p_org_id: orgId,
    p_takedown_id: tranche.id,
    p_to_date: "2027-01-15",
    p_fee_cents: 25_000_00,
    p_fee_due_on: "2026-12-01",
    p_reason: "Seller's plat recording slipped six weeks",
    p_evidence_file_id: signed.id,
    p_actor_id: ownerId,
  })

  const { rows: amendments } = await db.query("select id, kind, from_date::text, to_date::text, fee_cents::int from land_contract_amendments")
  assert.deepEqual(amendments, [{ id: amendmentId, kind: "extension", from_date: "2026-12-01", to_date: "2027-01-15", fee_cents: 25_000_00 }])
  const { rows: takedowns } = await db.query("select scheduled_date::text, metadata from lot_takedowns where id = $1", [tranche.id])
  assert.deepEqual(takedowns, [{ scheduled_date: "2027-01-15", metadata: {} }])
})

test("an extension of a takedown outside an executed contract is refused", async (t) => {
  const { db, orgId, ownerId, signed, contract, takedown } = await land(t)
  const tranche = await takedown((await contract()).id)
  await assert.rejects(
    rpc(db, "record_land_contract_extension", {
      p_org_id: orgId,
      p_takedown_id: tranche.id,
      p_to_date: "2027-01-15",
      p_fee_cents: 0,
      p_fee_due_on: null,
      p_reason: "Seller's plat recording slipped",
      p_evidence_file_id: signed.id,
      p_actor_id: ownerId,
    }),
    /executed land contract/,
  )
})

test("amendments are append-only", async (t) => {
  const { db, orgId, ownerId, signed, contract, execute } = await land(t)
  const row = await contract()
  await execute(row.id)
  const penalty = await insert(db, "land_contract_amendments", {
    org_id: orgId,
    land_contract_id: row.id,
    kind: "penalty",
    fee_cents: 10_000_00,
    due_on: "2026-11-01",
    reason: "Late takedown under section 4.2",
    evidence_file_id: signed.id,
    recorded_by: ownerId,
  })
  await assert.rejects(db.query("update land_contract_amendments set fee_cents = 0 where id = $1", [penalty.id]), /kept as recorded/)
  await assert.rejects(db.query("delete from land_contract_amendments where id = $1", [penalty.id]), /kept as recorded/)
})

test("a member without land_contract.write reads contracts but cannot write them", async (t) => {
  const { db, orgId, community, contract } = await land(t)
  const row = await contract()
  const { userId: superintendent } = await seedMember(db, { orgId, role: "org_superintendent" })
  const { userId: landManager } = await seedMember(db, { orgId, role: "org_land_manager" })

  const read = await asRole(db, { role: "authenticated", userId: superintendent }, (tx) => tx.query("select id from land_contracts"))
  assert.deepEqual(read.rows, [{ id: row.id }])
  await assert.rejects(
    asRole(db, { role: "authenticated", userId: superintendent }, (tx) =>
      tx.query("insert into land_contracts (org_id, community_id, title) values ($1, $2, 'Side deal')", [orgId, community.id]),
    ),
    /row-level security/,
  )
  const updated = await asRole(db, { role: "authenticated", userId: superintendent }, (tx) =>
    tx.query("update land_contracts set total_lots = 1 where id = $1 returning id", [row.id]),
  )
  assert.equal(updated.rowCount, 0)

  const written = await asRole(db, { role: "authenticated", userId: landManager }, (tx) =>
    tx.query("insert into land_contracts (org_id, community_id, title) values ($1, $2, 'Phase 2 option') returning id", [orgId, community.id]),
  )
  assert.equal(written.rowCount, 1)
})

test("a development job serves only phases in its own community's division", async (t) => {
  const { db, orgId, community } = await land(t)
  const north = await insert(db, "divisions", { org_id: orgId, name: "North" })
  const job = await insert(db, "projects", { org_id: orgId, name: "Cypress Run site work", division_id: north.id })
  await assert.rejects(
    insert(db, "community_phases", { org_id: orgId, community_id: community.id, name: "Phase 1", phase_number: 1, development_project_id: job.id }),
    /community's division/,
  )
  const home = await insert(db, "projects", { org_id: orgId, name: "Lot 1 home" })
  await insert(db, "lots", { org_id: orgId, community_id: community.id, lot_number: "1", project_id: home.id, status: "assigned" })
  await assert.rejects(
    insert(db, "community_phases", { org_id: orgId, community_id: community.id, name: "Phase 1", phase_number: 1, development_project_id: home.id }),
    /home on a lot/,
  )
})

test("a development allocation reaches only lots in the phases its job develops", async (t) => {
  const { db, orgId, ownerId, community } = await land(t)
  const job = await insert(db, "projects", { org_id: orgId, name: "Cypress Run site work" })
  await db.query("insert into project_financial_settings (org_id, project_id) values ($1, $2) on conflict do nothing", [orgId, job.id])
  await db.query("update project_financial_settings set books_inventory_enabled = true, books_inventory_effective_on = '2026-06-01' where project_id = $1", [job.id])
  const proposal = (lotId) => ({
    p_org_id: orgId,
    p_project_id: job.id,
    p_date: "2026-10-01",
    p_reference: `Utilities ${lotId.slice(-4)}`,
    p_basis: "equal",
    p_total_cents: 30_000_00,
    p_weights: JSON.stringify([{ lot_id: lotId, weight: 1 }]),
    p_evidence_url: "https://example.test/schedule",
    p_note: "Street utilities shared by the phase",
    p_actor_id: ownerId,
  })
  const phaseOne = await insert(db, "community_phases", { org_id: orgId, community_id: community.id, name: "Phase 1", phase_number: 1 })
  const phaseTwo = await insert(db, "community_phases", { org_id: orgId, community_id: community.id, name: "Phase 2", phase_number: 2 })
  const inPhaseOne = await insert(db, "lots", { org_id: orgId, community_id: community.id, community_phase_id: phaseOne.id, lot_number: "1", status: "owned" })
  const inPhaseTwo = await insert(db, "lots", { org_id: orgId, community_id: community.id, community_phase_id: phaseTwo.id, lot_number: "2", status: "owned" })

  await assert.rejects(rpc(db, "propose_books_development_allocation", proposal(inPhaseOne.id)), /Link this development job/)
  await db.query("update community_phases set development_project_id = $1 where id = $2", [job.id, phaseOne.id])
  await assert.rejects(rpc(db, "propose_books_development_allocation", proposal(inPhaseTwo.id)), /only lots in the phases this job develops/)
  const allocationId = await rpc(db, "propose_books_development_allocation", proposal(inPhaseOne.id))

  // Posting checks again: the phase was handed to another job since.
  await db.query("update community_phases set development_project_id = null where id = $1", [phaseOne.id])
  const { userId: reviewer } = await seedMember(db, { orgId })
  await assert.rejects(
    rpc(db, "review_books_development_allocation", { p_org_id: orgId, p_allocation_id: allocationId, p_approve: true, p_note: null, p_actor_id: reviewer }),
    /Link this development job/,
  )
})

test("posting a development allocation directly is held to the same phase link", async (t) => {
  const { db, orgId, ownerId, community } = await land(t)
  const job = await insert(db, "projects", { org_id: orgId, name: "Cypress Run site work" })
  const phaseTwo = await insert(db, "community_phases", { org_id: orgId, community_id: community.id, name: "Phase 2", phase_number: 2 })
  const lot = await insert(db, "lots", { org_id: orgId, community_id: community.id, community_phase_id: phaseTwo.id, lot_number: "2", status: "owned" })
  const post = () =>
    rpc(db, "allocate_books_development_cost", {
      p_org_id: orgId,
      p_project_id: job.id,
      p_date: "2026-10-01",
      p_allocations: JSON.stringify([{ lot_id: lot.id, amount_cents: 1_000_00 }]),
      p_reference: "Direct post",
      p_evidence_url: "https://example.test/schedule",
      p_actor_id: ownerId,
    })

  await assert.rejects(post(), /Link this development job/)
  await insert(db, "community_phases", { org_id: orgId, community_id: community.id, name: "Phase 1", phase_number: 1, development_project_id: job.id })
  await assert.rejects(post(), /only lots in the phases this job develops/)
})

test("a land contract's search entry carries its community's division", async (t) => {
  const { db, orgId, community, contract } = await land(t)
  const north = await insert(db, "divisions", { org_id: orgId, name: "North" })
  const south = await insert(db, "divisions", { org_id: orgId, name: "South" })
  await db.query("update communities set division_id = $1 where id = $2", [north.id, community.id])
  const row = await contract()
  await insert(db, "search_documents", { org_id: orgId, entity_type: "land_contract", entity_id: row.id, title: row.title })
  const { userId: southManager } = await seedMember(db, { orgId, role: "org_land_manager" })
  const { rows } = await db.query("update memberships set division_scope = 'assigned' where org_id = $1 and user_id = $2 returning id", [orgId, southManager])
  await insert(db, "membership_divisions", { membership_id: rows[0].id, division_id: south.id })
  const found = () =>
    asRole(db, { role: "authenticated", userId: southManager }, async (tx) =>
      (await tx.query("select title from search_documents where entity_type = 'land_contract'")).rows.map((entry) => entry.title),
    )

  assert.deepEqual((await db.query("select division_id from search_documents where entity_id = $1", [row.id])).rows, [{ division_id: north.id }])
  assert.deepEqual(await found(), [])

  // The stamp follows the community into another division.
  await db.query("update communities set division_id = $1 where id = $2", [south.id, community.id])
  assert.deepEqual(await found(), [row.title])
})

// ---------------------------------------------------------------------------
// Takedowns, termination and fees (20261012170000_ep04_review_fixes).

/** A paid deposit's receipt and the payment itself. */
const pay = (db, depositId, fileId) =>
  db.query("update land_contract_deposits set status = 'paid', paid_on = '2026-10-10', evidence_file_id = $2 where id = $1", [depositId, fileId])

test("a takedown under a signed contract is never deleted, and a member neither cancels it nor closes any takedown directly", async (t) => {
  const { db, orgId, ownerId, community, contract, takedown, execute } = await land(t)
  const { userId: field } = await seedMember(db, { orgId, role: "field" })
  const as = (userId, sql, args) => asRole(db, { role: "authenticated", userId }, (tx) => tx.query(sql, args))
  const row = await contract()
  const signedTranche = await takedown(row.id)
  await execute(row.id)
  const loose = await insert(db, "lot_takedowns", { org_id: orgId, community_id: community.id, name: "Unsigned tranche", scheduled_date: "2026-12-01", lot_count: 4 })

  await assert.rejects(as(field, "delete from lot_takedowns where id = $1", [signedTranche.id]), /is kept; terminate the contract/)
  await assert.rejects(db.query("delete from lot_takedowns where id = $1", [signedTranche.id]), /is kept; terminate the contract/)
  await assert.rejects(as(field, "update lot_takedowns set status = 'cancelled' where id = $1", [signedTranche.id]), /only through the land workflow/)
  for (const userId of [field, ownerId]) {
    await assert.rejects(as(userId, "update lot_takedowns set status = 'closed', actual_date = '2026-10-10' where id = $1", [loose.id]), /closed through its closing/)
  }
  // A takedown outside a contract or a deal is still the community's to cancel.
  await as(field, "update lot_takedowns set status = 'cancelled' where id = $1", [loose.id])
})

test("a land deal's takedown closes only once its acquisition is approved, whoever writes it", async (t) => {
  const { db, orgId, ownerId, community } = await land(t)
  const deal = await insert(db, "land_opportunities", { org_id: orgId, name: "Cypress Run west", community_id: community.id, created_by: ownerId })
  const tranche = await insert(db, "lot_takedowns", { org_id: orgId, community_id: community.id, land_opportunity_id: deal.id, name: "West tranche", scheduled_date: "2026-12-01", lot_count: 6 })
  const close = () => rpc(db, "close_lot_takedown", { p_org_id: orgId, p_takedown_id: tranche.id, p_actual_date: "2026-10-10", p_actor_id: ownerId })

  await assert.rejects(db.query("update lot_takedowns set status = 'closed' where id = $1", [tranche.id]), /no approved acquisition review/)
  await assert.rejects(close(), /no approved acquisition review/)

  await db.query("set session_replication_role = replica")
  await insert(db, "land_acquisition_reviews", {
    org_id: orgId, land_opportunity_id: deal.id, revision: 1, decision: "acquire", snapshot: {}, content_hash: "a".repeat(64),
    status: "approved", submitted_by: ownerId, decided_at: new Date().toISOString(),
  })
  await db.query("set session_replication_role = origin")
  await close()
  assert.equal((await db.query("select status from lot_takedowns where id = $1", [tranche.id])).rows[0].status, "closed")
})

test("closing a takedown applies its paid deposits and acquires its lots in one transaction", async (t) => {
  const { db, orgId, ownerId, community, signed, contract, takedown, execute } = await land(t)
  const row = await contract()
  const tranche = await takedown(row.id)
  const deposit = await insert(db, "land_contract_deposits", { org_id: orgId, land_contract_id: row.id, takedown_id: tranche.id, due_on: "2026-10-15", amount_cents: 50_000_00 })
  const lot = await insert(db, "lots", { org_id: orgId, community_id: community.id, lot_number: "1", status: "controlled", takedown_id: tranche.id })
  await execute(row.id)
  const close = () => rpc(db, "close_lot_takedown", { p_org_id: orgId, p_takedown_id: tranche.id, p_actual_date: "2026-11-30", p_actor_id: ownerId })

  await assert.rejects(close(), /Record the payment of every deposit/)
  assert.equal((await db.query("select status from lot_takedowns where id = $1", [tranche.id])).rows[0].status, "scheduled")

  await pay(db, deposit.id, signed.id)
  const result = await close()
  assert.deepEqual(result, { lot_ids: [lot.id], applied_deposit_cents: 50_000_00 })
  const { rows: [after] } = await db.query(`
    select t.status as takedown, t.actual_date::text as actual_date, d.status as deposit, l.status as lot, l.acquired_date::text as acquired
      from lot_takedowns t, land_contract_deposits d, lots l
     where t.id = $1 and d.id = $2 and l.id = $3`, [tranche.id, deposit.id, lot.id])
  assert.deepEqual(after, { takedown: "closed", actual_date: "2026-11-30", deposit: "applied", lot: "owned", acquired: "2026-11-30" })
  await assert.rejects(close(), /Only a scheduled takedown is closed/)
})

test("terminating a contract cancels its unpaid deposits and its scheduled takedowns; nothing else cancels a deposit", async (t) => {
  const { db, orgId, ownerId, signed, contract, takedown, execute } = await land(t)
  const row = await contract()
  const tranche = await takedown(row.id)
  const unpaid = await insert(db, "land_contract_deposits", { org_id: orgId, land_contract_id: row.id, due_on: "2026-11-15", amount_cents: 25_000_00 })
  const paid = await insert(db, "land_contract_deposits", { org_id: orgId, land_contract_id: row.id, due_on: "2026-10-05", amount_cents: 50_000_00 })
  await execute(row.id)
  await pay(db, paid.id, signed.id)

  await assert.rejects(db.query("update land_contract_deposits set status = 'cancelled' where id = $1", [unpaid.id]), /only by terminating its land contract/)

  const ended = await rpc(db, "close_out_land_contract", { p_org_id: orgId, p_contract_id: row.id, p_status: "terminated", p_actor_id: ownerId })
  assert.deepEqual(ended, { cancelled_deposit_ids: [unpaid.id], cancelled_takedown_ids: [tranche.id] })
  const { rows } = await db.query("select id, status from land_contract_deposits order by due_on")
  assert.deepEqual(rows, [{ id: paid.id, status: "paid" }, { id: unpaid.id, status: "cancelled" }])
  assert.equal((await db.query("select status from lot_takedowns where id = $1", [tranche.id])).rows[0].status, "cancelled")
  // The paid deposit is still refunded or forfeited on its own record.
  await db.query("update land_contract_deposits set status = 'forfeited' where id = $1", [paid.id])
  await assert.rejects(rpc(db, "close_out_land_contract", { p_org_id: orgId, p_contract_id: row.id, p_status: "completed", p_actor_id: ownerId }), /Only an executed land contract/)
})

test("a fee's payment is recorded once, with its receipt; the rest of the amendment never changes", async (t) => {
  const { db, orgId, ownerId, signed, contract, execute } = await land(t)
  const row = await contract()
  await execute(row.id)
  const penalty = await insert(db, "land_contract_amendments", {
    org_id: orgId, land_contract_id: row.id, kind: "penalty", fee_cents: 10_000_00, due_on: "2026-10-01",
    reason: "Late takedown under section 4.2", evidence_file_id: signed.id, recorded_by: ownerId,
  })
  const { userId: landManager } = await seedMember(db, { orgId, role: "org_land_manager" })
  const record = (patch) => asRole(db, { role: "authenticated", userId: landManager }, (tx) =>
    tx.query("update land_contract_amendments set fee_paid_on = $2, fee_evidence_file_id = $3 where id = $1", [penalty.id, patch.paidOn, patch.fileId]))

  await assert.rejects(record({ paidOn: "2026-10-03", fileId: null }), /land_contract_amendments_fee_paid_check/)
  await record({ paidOn: "2026-10-03", fileId: signed.id })
  assert.equal((await db.query("select fee_paid_on::text from land_contract_amendments where id = $1", [penalty.id])).rows[0].fee_paid_on, "2026-10-03")
  await assert.rejects(record({ paidOn: "2026-10-04", fileId: signed.id }), /kept as recorded/)
  await assert.rejects(db.query("update land_contract_amendments set fee_cents = 1 where id = $1", [penalty.id]), /kept as recorded/)
})

test("a land contract ends only through its close-out, and completes only once nothing is still scheduled", async (t) => {
  const { db, orgId, ownerId, signed, contract, takedown, execute } = await land(t)
  const { userId: landManager } = await seedMember(db, { orgId, role: "org_land_manager" })
  const row = await contract()
  const tranche = await takedown(row.id)
  const deposit = await insert(db, "land_contract_deposits", { org_id: orgId, land_contract_id: row.id, takedown_id: tranche.id, due_on: "2026-11-15", amount_cents: 25_000_00 })
  await execute(row.id)
  const closeOut = (status) => rpc(db, "close_out_land_contract", { p_org_id: orgId, p_contract_id: row.id, p_status: status, p_actor_id: ownerId })

  // The reviewer's case: terminating by status alone left the deposit and takedown owed, and the close-out refused afterwards.
  for (const status of ["terminated", "completed"]) {
    await assert.rejects(
      asRole(db, { role: "authenticated", userId: landManager }, (tx) => tx.query("update land_contracts set status = $2 where id = $1", [row.id, status])),
      /through its close-out/,
    )
  }
  await assert.rejects(closeOut("completed"), /still has scheduled takedowns or unpaid deposits/)

  await pay(db, deposit.id, signed.id)
  await rpc(db, "close_lot_takedown", { p_org_id: orgId, p_takedown_id: tranche.id, p_actual_date: "2026-11-30", p_actor_id: ownerId })
  await closeOut("completed")
  assert.equal((await db.query("select status from land_contracts where id = $1", [row.id])).rows[0].status, "completed")
})

test("a member never unlinks or deletes a land deal's takedown", async (t) => {
  const { db, orgId, ownerId, community } = await land(t)
  const { userId: field } = await seedMember(db, { orgId, role: "field" })
  const deal = await insert(db, "land_opportunities", { org_id: orgId, name: "Cypress Run west", community_id: community.id, created_by: ownerId })
  const tranche = await insert(db, "lot_takedowns", { org_id: orgId, community_id: community.id, land_opportunity_id: deal.id, name: "West tranche", scheduled_date: "2026-12-01", lot_count: 6 })
  const as = (sql) => asRole(db, { role: "authenticated", userId: field }, (tx) => tx.query(sql, [tranche.id]))

  await assert.rejects(as("update lot_takedowns set land_opportunity_id = null where id = $1"), /stays with its land deal/)
  await assert.rejects(as("delete from lot_takedowns where id = $1"), /from a land deal is kept/)
  await as("update lot_takedowns set notes = 'Seller asked to move the walk-through' where id = $1")
  assert.equal((await db.query("select land_opportunity_id from lot_takedowns where id = $1", [tranche.id])).rows[0].land_opportunity_id, deal.id)
})
