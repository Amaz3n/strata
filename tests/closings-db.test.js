"use strict"

/**
 * The database contract behind `lib/services/closings.ts`: a closing bills the
 * home once.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { createDatabase, insert, rpc, seedMember, uuid } = require("./support/pglite")

test("a closing has at most one closing invoice", async (t) => {
  const db = await createDatabase(t)
  const { orgId } = await seedMember(db)
  const project = await insert(db, "projects", { org_id: orgId, name: "Lot 12" })
  const closingId = uuid()
  const invoice = (number, metadata) =>
    insert(db, "invoices", { org_id: orgId, project_id: project.id, invoice_number: number, title: "Closing", metadata: JSON.stringify(metadata) })

  await invoice("CLOSE-1", { invoice_kind: "closing", source_closing_id: closingId })
  await assert.rejects(invoice("CLOSE-2", { invoice_kind: "closing", source_closing_id: closingId }), /invoices_closing_source_unique/)
  // Another closing, and other kinds of invoice on the same home, are unaffected.
  await invoice("CLOSE-3", { invoice_kind: "closing", source_closing_id: uuid() })
  await invoice("DEP-1", { invoice_kind: "earnest_deposit", source_closing_id: closingId })
})

/** A buyer's $10,000 earnest deposit, received, and the closing invoice it will be applied to. */
async function depositAndClosingInvoice(db, { closingCustomer } = {}) {
  const { orgId, userId } = await seedMember(db)
  const project = await insert(db, "projects", { org_id: orgId, name: "Lot 12" })
  const buyer = uuid()
  const invoice = (number, metadata, extra = {}) =>
    insert(db, "invoices", {
      org_id: orgId,
      project_id: project.id,
      invoice_number: number,
      title: number,
      total_cents: 40_000_000,
      balance_due_cents: 40_000_000,
      due_date: "2026-10-09",
      client_visible: true,
      sent_at: new Date(),
      metadata: JSON.stringify(metadata),
      ...extra,
    })
  const depositInvoice = await invoice("DEP-1", { invoice_kind: "earnest_deposit", customer_id: buyer }, { status: "paid", total_cents: 1_000_000, balance_due_cents: 0 })
  const payment = await insert(db, "payments", { org_id: orgId, invoice_id: depositInvoice.id, amount_cents: 1_000_000, provider: "manual", status: "succeeded" })
  const closing = await invoice("CLOSE-1", { invoice_kind: "closing", source_closing_id: uuid(), customer_id: closingCustomer ?? buyer }, { status: "sent" })
  let opened = 0
  const otherInvoice = () => invoice(`OPEN-${(opened += 1)}`, { customer_id: buyer }, { status: "sent" })
  const apply = (amountCents, target = closing) =>
    rpc(db, "apply_customer_deposit_atomic", {
      p_org_id: orgId,
      p_deposit_payment_id: payment.id,
      p_target_invoice_id: target.id,
      p_amount_cents: amountCents,
      p_actor_id: userId,
    })
  const refund = (amountCents) =>
    rpc(db, "record_manual_customer_refund_atomic", {
      p_org_id: orgId,
      p_payment_id: payment.id,
      p_amount_cents: amountCents,
      p_reason: "Buyer returned deposit",
      p_idempotency_key: uuid(),
      p_actor_id: userId,
    })
  const applied = async () =>
    (await db.query("select coalesce(sum(amount_cents), 0)::int as cents from payments where metadata->>'deposit_payment_id' = $1", [payment.id])).rows[0].cents
  return { apply, applied, refund, otherInvoice }
}

test("a buyer's deposit can only be applied to that buyer's closing invoice", async (t) => {
  const db = await createDatabase(t)
  const mismatched = await depositAndClosingInvoice(db, { closingCustomer: uuid() })
  await assert.rejects(mismatched.apply(1_000_000), /only be applied to that customer/)
  assert.equal(await mismatched.applied(), 0)

  const matched = await depositAndClosingInvoice(db)
  await matched.apply(1_000_000)
  assert.equal(await matched.applied(), 1_000_000)
})

test("a retried application does not apply a deposit twice, and no application can pass the deposit's balance", async (t) => {
  const db = await createDatabase(t)
  const home = await depositAndClosingInvoice(db)

  const first = await home.apply(400_000)
  assert.equal((await home.apply(400_000)).id, first.id, "the retry returns the application it already made")
  assert.equal(await home.applied(), 400_000)

  const later = await home.otherInvoice()
  await assert.rejects(home.apply(600_001, later), /exceeds the unapplied deposit balance/)
  await home.apply(600_000, later)
  assert.equal(await home.applied(), 1_000_000)
  await assert.rejects(home.apply(1, await home.otherInvoice()), /exceeds the unapplied deposit balance/)
})

test("a deposit refunded to the buyer cannot also be applied, and an applied deposit cannot also be refunded", async (t) => {
  const db = await createDatabase(t)
  const home = await depositAndClosingInvoice(db)
  await home.refund(250_000)

  await assert.rejects(home.apply(750_001), /exceeds the unapplied deposit balance/)
  await home.apply(750_000)
  assert.equal(await home.applied(), 750_000)
  await assert.rejects(home.refund(1), /still available/)
})

test("replaying a deposit application with a different amount is refused", async (t) => {
  const db = await createDatabase(t)
  const home = await depositAndClosingInvoice(db)

  await home.apply(400_000)

  await assert.rejects(home.apply(300_000), /already applied to the invoice for a different amount/)
  assert.equal(await home.applied(), 400_000)
})

test("reversing a closing voids the home's warranty coverage, so the next closing enrolls it once again", async (t) => {
  const db = await createDatabase(t)
  const { orgId } = await seedMember(db)
  const project = await insert(db, "projects", { org_id: orgId, name: "Lot 12" })
  const program = await insert(db, "warranty_programs", { org_id: orgId, name: "Standard", is_default: true })
  const closing = await insert(db, "closings", { org_id: orgId, project_id: project.id, status: "scheduled", scheduled_date: "2026-09-01" })
  // The recorded settlement is fixture state; the reversal under test is the status change.
  await db.exec("set session_replication_role = replica")
  await db.query("update closings set status = 'closed', actual_date = '2026-09-01' where id = $1", [closing.id])
  await db.exec("set session_replication_role = origin")
  const enroll = (date) => insert(db, "project_warranty_coverage", {
    org_id: orgId, project_id: project.id, program_id: program.id, effective_date: date, effective_source: "closing",
    terms_snapshot: JSON.stringify([{ key: "workmanship", expires_on: "2027-09-01" }]),
  })
  const first = await enroll("2026-09-01")
  await assert.rejects(enroll("2026-09-01"), /project_warranty_coverage_live_project_idx/)

  // As reverse_books_home_closing does it: the one change a recorded closing allows.
  await db.exec("begin")
  await db.query("select set_config('arc.closing_reversal', $1, true)", [closing.id])
  await db.query("update closings set status = 'cancelled', cancel_reason = 'Buyer financing fell through after funding' where id = $1", [closing.id])
  await db.exec("commit")
  const { rows: [voided] } = await db.query("select voided_at, void_reason, voided_closing_id from project_warranty_coverage where id = $1", [first.id])
  assert.ok(voided.voided_at)
  assert.equal(voided.voided_closing_id, closing.id)
  await assert.rejects(db.query("update project_warranty_coverage set voided_at = null, void_reason = null where id = $1", [first.id]), /stays voided/)

  await enroll("2026-10-15")
  const { rows } = await db.query("select effective_date::text from project_warranty_coverage where project_id = $1 and voided_at is null", [project.id])
  assert.deepEqual(rows, [{ effective_date: "2026-10-15" }])
})
