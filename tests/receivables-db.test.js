"use strict"

/**
 * The receivables ledger's database guards. Invoices and payments are written
 * only by service-role commands that the application calls after its own
 * permission checks, so a member with a session cannot bypass those checks with
 * a direct write, and the guards that protect money hold for every writer.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { asRole, createDatabase, insert, rpc, seedMember } = require("./support/pglite")

async function receivables(t) {
  const db = await createDatabase(t)
  const owner = await seedMember(db)
  const project = await insert(db, "projects", { org_id: owner.orgId, name: "Lot 12" })
  return { db, ...owner, project }
}

function invoice({ db, orgId, project }, overrides = {}) {
  return insert(db, "invoices", {
    org_id: orgId,
    project_id: project.id,
    status: "draft",
    total_cents: 10000,
    balance_due_cents: 10000,
    ...overrides,
  })
}

test("members read invoices and payments but cannot write them directly", async (t) => {
  const home = await receivables(t)
  const sent = await invoice(home, { status: "sent" })
  const member = { role: "authenticated", userId: home.userId }

  const { rows } = await asRole(home.db, member, (tx) => tx.query("select id from invoices"))
  assert.deepEqual(rows, [{ id: sent.id }])

  const writes = [
    ["insert invoice", "insert into invoices (org_id, project_id) values ($1, $2)", [home.orgId, home.project.id]],
    ["mark paid", "update invoices set status = 'paid', balance_due_cents = 0 where id = $1", [sent.id]],
    ["delete invoice", "delete from invoices where id = $1", [sent.id]],
    ["insert line", "insert into invoice_lines (org_id, invoice_id) values ($1, $2)", [home.orgId, sent.id]],
    ["insert payment", "insert into payments (org_id, invoice_id, amount_cents) values ($1, $2, 10000)", [home.orgId, sent.id]],
    ["insert intent", "insert into payment_intents (org_id, invoice_id) values ($1, $2)", [home.orgId, sent.id]],
  ]
  for (const [name, sql, params] of writes) {
    await assert.rejects(asRole(home.db, member, (tx) => tx.query(sql, params)), /permission denied/, name)
  }
  const { rows: stored } = await home.db.query("select status, balance_due_cents from invoices where id = $1", [sent.id])
  assert.deepEqual(stored, [{ status: "sent", balance_due_cents: 10000 }])
})

test("receivables commands are executable by the service role only", async (t) => {
  const { db } = await receivables(t)
  const commands = [
    "create_invoice_atomic",
    "update_invoice_atomic",
    "void_invoice_atomic",
    "revise_invoice_atomic",
    "request_invoice_approval",
    "decide_invoice_approval",
    "apply_invoice_payment_atomic",
    "apply_multi_invoice_payment_atomic",
    "record_payment_reversal_atomic",
    "apply_invoice_late_fee_atomic",
    "release_project_retainage_atomic",
    "create_invoice_from_billable_costs_atomic",
    "void_approved_change_order_atomic",
  ]
  const { rows } = await db.query(
    `select proname as name,
            has_function_privilege('authenticated', oid, 'execute') as authenticated,
            has_function_privilege('anon', oid, 'execute') as anon,
            has_function_privilege('service_role', oid, 'execute') as service
     from pg_proc where pronamespace = 'public'::regnamespace and proname = any($1) order by proname`,
    [commands],
  )
  assert.deepEqual(rows.map((row) => row.name).sort(), [...commands].sort())
  for (const row of rows) {
    assert.deepEqual(
      { authenticated: row.authenticated, anon: row.anon, service: row.service },
      { authenticated: false, anon: false, service: true },
      row.name,
    )
  }
})

test("a payment only applies to an invoice that was issued in the same org", async (t) => {
  const home = await receivables(t)
  const stranger = await seedMember(home.db)
  const pay = (invoiceId, orgId = home.orgId) =>
    home.db.query("insert into payments (org_id, invoice_id, amount_cents) values ($1, $2, 10000)", [orgId, invoiceId])

  const draft = await invoice(home)
  const voided = await invoice(home, { status: "void" })
  await assert.rejects(pay(draft.id), /has not been issued/)
  await assert.rejects(pay(voided.id), /void invoice/)
  await assert.rejects(pay(draft.id, stranger.orgId), /does not exist in this organization/)

  for (const status of ["sent", "partial", "overdue"]) {
    await pay((await invoice(home, { status })).id)
  }
  const { rows } = await home.db.query("select count(*)::int as n from payments")
  assert.equal(rows[0].n, 3)
})

test("an invoice edit refuses to move the invoice or change an issued one", async (t) => {
  const home = await receivables(t)
  const other = await insert(home.db, "projects", { org_id: home.orgId, name: "Lot 13" })
  const lines = JSON.stringify([{ description: "Framing", quantity: 1, unit_price_cents: 10000 }])
  const edit = (target, changes) =>
    rpc(home.db, "update_invoice_atomic", {
      p_org_id: home.orgId,
      p_invoice_id: target.id,
      p_invoice: JSON.stringify({ project_id: target.project_id, title: "Edited", ...changes }),
      p_lines: lines,
    })

  const draft = await invoice(home)
  await assert.rejects(edit(draft, { project_id: other.id }), /cannot change its project/)

  const sent = await invoice(home, { status: "sent", sent_at: "2026-10-01T00:00:00Z", client_visible: true })
  await assert.rejects(edit(sent, {}), /Issued invoices are immutable/)
})
