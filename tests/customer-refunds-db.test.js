"use strict"

/**
 * `record_manual_customer_refund_atomic`: an offline refund reopens exactly the
 * amount returned, cannot spend a deposit twice, is idempotent on its
 * reference, and can only be called by the server.
 */

const assert = require("node:assert/strict")
const test = require("node:test")

const { createDatabase, insert, rpc, seedMember, uuid } = require("./support/pglite")

// One database for the file: every fixture is its own org, so tests cannot see
// each other's rows.
let shared
test.before(async () => {
  shared = await createDatabase()
})
test.after(() => shared.close())

/** A paid $100 invoice with one manual payment against it. */
async function paidInvoice(db, { provider = "manual", applied = 0, credit = 0 } = {}) {
  const { orgId, userId } = await seedMember(db)
  const invoice = await insert(db, "invoices", {
    org_id: orgId,
    status: "paid",
    total_cents: 10000,
    balance_due_cents: 0,
    due_date: "2026-01-01",
    client_visible: true,
    sent_at: new Date(),
  })
  const payment = await insert(db, "payments", {
    org_id: orgId,
    invoice_id: invoice.id,
    amount_cents: 10000,
    provider,
    status: "succeeded",
  })
  if (applied) {
    await insert(db, "payments", {
      org_id: orgId,
      amount_cents: applied,
      status: "succeeded",
      metadata: { deposit_payment_id: payment.id, customer_deposit_application: true },
    })
  }
  if (credit) {
    await insert(db, "receivable_adjustments", {
      org_id: orgId,
      invoice_id: invoice.id,
      adjustment_type: "credit_memo",
      amount_cents: credit,
      status: "posted",
      reason: "Discount",
    })
  }
  return { db, orgId, actor: userId, invoice, payment }
}

function refund(home, amount, { key = uuid(), reason = "Returned by check", orgId = home.orgId } = {}) {
  return rpc(home.db, "record_manual_customer_refund_atomic", {
    p_org_id: orgId,
    p_payment_id: home.payment.id,
    p_amount_cents: amount,
    p_reason: reason,
    p_idempotency_key: key,
    p_actor_id: home.actor,
  })
}

const one = async (db, sql, params) => (await db.query(sql, params)).rows[0]

test("a partial refund reopens only the returned amount, keeps credits, and flags the synced invoice", async () => {
  const home = await paidInvoice(shared, { credit: 2000 })
  await insert(home.db, "accounting_sync_records", {
    org_id: home.orgId,
    entity_type: "invoice",
    entity_id: home.invoice.id,
    external_id: "external-invoice",
    status: "synced",
  })

  await refund(home, 3000)

  const invoice = await one(home.db, "select status, balance_due_cents from invoices where id = $1", [home.invoice.id])
  assert.equal(invoice.status, "partial")
  assert.equal(Number(invoice.balance_due_cents), 1000)
  const sync = await one(home.db, "select status from accounting_sync_records where entity_id = $1", [home.invoice.id])
  assert.equal(sync.status, "needs_review")
})

test("a retried refund returns the same reversal, and a reused reference with new details is refused", async () => {
  const home = await paidInvoice(shared)
  const key = uuid()

  const first = await refund(home, 4000, { key })
  const retry = await refund(home, 4000, { key })
  assert.equal(retry.id, first.id)
  assert.equal(retry.duplicate, true)

  await assert.rejects(refund(home, 5000, { key }), /different details/)
  await assert.rejects(refund(home, 4000, { key, reason: "Other reason" }), /different details/)
  const { count } = await one(home.db, "select count(*)::int from payment_reversals where payment_id = $1", [home.payment.id])
  assert.equal(count, 1)
})

test("a deposit already applied to an invoice cannot also be refunded", async () => {
  const home = await paidInvoice(shared, { applied: 7500 })
  await assert.rejects(refund(home, 2501), /still available/)
  await refund(home, 2500)
  await assert.rejects(refund(home, 1), /still available/)
})

test("a full refund marks the payment refunded and cannot be repeated", async () => {
  const home = await paidInvoice(shared)
  const key = uuid()
  await refund(home, 10000, { key })
  await refund(home, 10000, { key })

  const payment = await one(home.db, "select status from payments where id = $1", [home.payment.id])
  assert.equal(payment.status, "refunded")
  await assert.rejects(refund(home, 1), /Only received manual/)
})

test("provider payments and another org's payment are refused", async () => {
  const db = shared
  const stripe = await paidInvoice(db, { provider: "stripe" })
  await assert.rejects(refund(stripe, 100), /Only received manual/)
  const manual = await paidInvoice(db)
  await assert.rejects(refund(manual, 100, { orgId: stripe.orgId }), /not found/)
})

test("only the server can record a refund", async () => {
  const db = shared
  const signature = "public.record_manual_customer_refund_atomic(uuid,uuid,integer,text,text,uuid)"
  const grants = await one(
    db,
    `select has_function_privilege('anon', $1, 'execute') as anon,
            has_function_privilege('authenticated', $1, 'execute') as authenticated,
            has_function_privilege('service_role', $1, 'execute') as service`,
    [signature],
  )
  assert.deepEqual(grants, { anon: false, authenticated: false, service: true })
})
