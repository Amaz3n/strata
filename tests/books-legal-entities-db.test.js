"use strict"

/**
 * Legal entities are segments of the one Books ledger: every journal line is
 * owned by one company, an entry that crosses companies is balanced per
 * company by due-from / due-to legs, and ownership cannot move once money has
 * posted. Run against the whole migration chain through the real posting RPC.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { createDatabase, insert, rpc, seedMember } = require("./support/pglite")

async function books(t) {
  const db = await createDatabase(t)
  const { orgId, userId } = await seedMember(db)
  const primary = await rpc(db, "books_primary_entity", { p_org_id: orgId })
  const land = await insert(db, "books_legal_entities", { org_id: orgId, name: "Harbor Land LLC" })
  await insert(db, "accounting_periods", { org_id: orgId, period_start: "2026-10-01", period_end: "2026-10-31", fiscal_year: 2026, fiscal_period: 10 })
  const account = (code, name, accountType, subtype, normal) =>
    insert(db, "gl_accounts", { org_id: orgId, code, name, account_type: accountType, subtype, normal_balance: normal })
  const cash = await account("1000", "Operating cash", "asset", "cash", "debit")
  const inventory = await account("1160", "Homes under construction", "asset", "other_asset", "debit")
  const revenue = await account("4000", "Revenue", "income", "construction_revenue", "credit")
  const landBank = await insert(db, "gl_accounts", { org_id: orgId, code: "1010", name: "Land company bank", account_type: "asset", subtype: "cash", normal_balance: "debit", legal_entity_id: land.id })

  let sequence = 0
  const post = (lines, entry = {}) =>
    db.query("select post_books_journal_entry($1, $2::jsonb, $3::jsonb) as id", [
      orgId,
      JSON.stringify({ entry_date: "2026-10-15", entry_kind: "operational", memo: "test", posting_key: `entity-${++sequence}`, policy_version: 1, source_type: "manual", source_id: orgId, created_by: userId, ...entry }),
      JSON.stringify(lines.map(([account_id, debit_cents, credit_cents, extra = {}], index) => ({ account_id, debit_cents, credit_cents, line_no: index + 1, ...extra }))),
    ]).then((result) => result.rows[0].id)
  const lines = async (entryId) =>
    (await db.query("select account_id, legal_entity_id, debit_cents::int d, credit_cents::int c, dimensions from journal_lines where entry_id = $1 order by line_no", [entryId])).rows
  const balances = () => rpc(db, "books_ledger_balances", { p_org_id: orgId, p_as_of: "2026-10-31" })
  return { db, orgId, primary, land, cash, inventory, revenue, landBank, post, lines, balances }
}

const net = (rows, key) => {
  const totals = new Map()
  for (const row of rows) totals.set(row[key], (totals.get(row[key]) ?? 0) + Number(row.debit_cents) - Number(row.credit_cents))
  return totals
}

const entityNets = (posted) => {
  const nets = new Map()
  for (const line of posted) nets.set(line.legal_entity_id, (nets.get(line.legal_entity_id) ?? 0) + line.d - line.c)
  return nets
}

test("an entry that crosses companies is balanced for each company by due-from and due-to legs", async (t) => {
  const b = await books(t)
  // The primary company's cash pays an invoice that lands in the land company's bank account.
  const entry = await b.post([[b.landBank.id, 5_000, 0], [b.cash.id, 0, 5_000]])

  const posted = await b.lines(entry)
  assert.equal(posted.length, 4)
  const nets = entityNets(posted)
  assert.deepEqual([...nets.keys()].sort(), [b.land.id, b.primary].sort())
  assert.deepEqual([...nets.values()], [0, 0])
  const legs = posted.filter((line) => line.dimensions.intercompany === true)
  assert.equal(legs.length, 2)
  assert.deepEqual(legs.map((leg) => leg.dimensions.counterparty_entity_id).sort(), [b.land.id, b.primary].sort())
})

test("a later movement the other way settles what is owed before it creates a new balance", async (t) => {
  const b = await books(t)
  await b.post([[b.landBank.id, 5_000, 0], [b.cash.id, 0, 5_000]])
  const entry = await b.post([[b.landBank.id, 0, 2_000], [b.cash.id, 2_000, 0]])

  const nets = entityNets(await b.lines(entry))
  assert.deepEqual([...nets.values()], [0, 0])
  const owed = (await b.balances()).filter((row) => row.intercompany)
  const positions = new Map()
  for (const row of owed) positions.set(row.legal_entity_id, (positions.get(row.legal_entity_id) ?? 0) + Number(row.debit_cents) - Number(row.credit_cents))
  assert.equal(Math.abs(positions.get(b.land.id)), 3_000)
  assert.equal(positions.get(b.land.id), -positions.get(b.primary))
})

test("the ledger balances for each company and in total, with what companies owe each other flagged for elimination", async (t) => {
  const b = await books(t)
  await b.post([[b.landBank.id, 5_000, 0], [b.cash.id, 0, 5_000]])
  await b.post([[b.cash.id, 800, 0], [b.revenue.id, 0, 800]])

  const rows = await b.balances()
  for (const [entity, balance] of net(rows, "legal_entity_id")) assert.equal(balance, 0, entity)
  assert.equal([...net(rows, "legal_entity_id").values()].reduce((a, c) => a + c, 0), 0)
  const flagged = rows.filter((row) => row.intercompany)
  assert.equal(flagged.length, 2)
  assert.equal(flagged.reduce((sum, row) => sum + Number(row.debit_cents) - Number(row.credit_cents), 0), 0)
})

test("a reversal keeps each original line's company", async (t) => {
  const b = await books(t)
  const original = await b.post([[b.landBank.id, 5_000, 0], [b.cash.id, 0, 5_000]])
  const before = await b.lines(original)
  const reversal = await b.post(
    before.map((line) => [line.account_id, line.c, line.d, { dimensions: line.dimensions }]),
    { entry_kind: "reversal", reversal_of_entry_id: original },
  )
  const after = await b.lines(reversal)
  assert.equal(after.length, before.length)
  for (const line of after) {
    const mirrored = before.find((row) => row.account_id === line.account_id && row.d === line.c)
    assert.equal(line.legal_entity_id, mirrored.legal_entity_id)
  }
  assert.deepEqual([...entityNets(after).values()], [0, 0])
})

test("a project or account that has postings cannot change company", async (t) => {
  const b = await books(t)
  const project = await insert(b.db, "projects", { org_id: b.orgId, name: "Lot 7", legal_entity_id: b.land.id })
  await b.post([[b.inventory.id, 1_000, 0, { project_id: project.id }], [b.landBank.id, 0, 1_000]])

  await assert.rejects(b.db.query("update projects set legal_entity_id = $1 where id = $2", [b.primary, project.id]), /already has postings/)
  await assert.rejects(b.db.query("update gl_accounts set legal_entity_id = $1 where id = $2", [b.primary, b.landBank.id]), /already has postings/)
})

test("each company's position with its affiliate is the affiliate's opposite, which is what the close control reads", async (t) => {
  const b = await books(t)
  await b.post([[b.landBank.id, 5_000, 0], [b.cash.id, 0, 5_000]])
  await b.post([[b.landBank.id, 0, 1_500], [b.cash.id, 1_500, 0]])

  const positions = await rpc(b.db, "books_intercompany_positions", { p_org_id: b.orgId, p_as_of: "2026-10-31" })
  assert.equal(positions.length, 2)
  const of = (entityId) => positions.find((row) => row.entityId === entityId)
  const [land, primary] = [of(b.land.id), of(b.primary)]
  assert.equal(land.counterpartyId, b.primary)
  assert.equal(primary.counterpartyId, b.land.id)
  assert.equal(land.dueFromCents - land.dueToCents + (primary.dueFromCents - primary.dueToCents), 0)
  assert.equal(Math.abs(land.dueFromCents - land.dueToCents), 3_500)
})

test("land, completed homes and job cost are reported per company for the close's company tie-outs", async (t) => {
  const b = await books(t)
  const account = (code, name) => insert(b.db, "gl_accounts", { org_id: b.orgId, code, name, account_type: "asset", subtype: "other_asset", normal_balance: "debit" })
  const [land, completed] = await Promise.all([account("1120", "Owned land"), account("1170", "Completed homes")])
  const home = await insert(b.db, "projects", { org_id: b.orgId, name: "Lot 9", legal_entity_id: b.land.id })
  const community = await insert(b.db, "communities", { org_id: b.orgId, name: "Oak Ridge" })
  const { id: lotId } = await insert(b.db, "lots", { org_id: b.orgId, community_id: community.id, lot_number: "9" })

  // One lot's land carried 400 by the builder and 600 by the land company; a home on the land company's books.
  await b.post([[land.id, 400, 0, { legal_entity_id: b.primary, dimensions: { lot_id: lotId } }], [b.cash.id, 0, 400]])
  await b.post([[land.id, 600, 0, { legal_entity_id: b.land.id, dimensions: { lot_id: lotId } }], [b.landBank.id, 0, 600]])
  await b.post([[completed.id, 700, 0, { project_id: home.id }], [b.landBank.id, 0, 700]])
  await insert(b.db, "job_cost_entries", { org_id: b.orgId, project_id: home.id, source_type: "project_expense", source_id: lotId, incurred_on: "2026-10-10", cost_cents: 250, status: "posted" })

  const controls = await rpc(b.db, "books_home_inventory_controls", { p_org_id: b.orgId, p_as_of: "2026-10-31" })
  assert.equal(controls.land.ledgerCents, 1_000)
  const [lot] = controls.land.holdings
  assert.equal(lot.lotId, lotId)
  assert.deepEqual(
    Object.fromEntries(lot.ledger.map((held) => [held.legalEntityId, held.cents])),
    { [b.primary]: 400, [b.land.id]: 600 },
  )
  assert.deepEqual(controls.completedHomes.holdings, [{ projectId: home.id, held: false, ledger: [{ legalEntityId: b.land.id, cents: 700 }] }])
  assert.deepEqual(controls.completedHomes.exceptions, [{ projectId: home.id, cents: 700 }])

  const jobCost = await rpc(b.db, "books_job_cost_subledger_by_project", { p_org_id: b.orgId, p_as_of: "2026-10-31" })
  assert.deepEqual(jobCost.map((row) => [row.project_id, Number(row.cost_cents)]), [[home.id, 250]])
})
