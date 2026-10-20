"use strict"

// Connected receivables (lib/services/connected-receivables and
// lib/receivables/connected): a bill a sub submits in a builder's portal is the
// same receivable on the sub's books, and the builder's side drives it.

require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

const BUILDER = id(100)
const BUILDER_PROJECT = id(101)
const TRADE_COMPANY = id(102)
const TRADE_JOB = id(103)
const CONNECTION = id(104)
const CUSTOMER = id(105)
const BILL = id(106)
const TOKEN = id(107)

// Invoices, payments and numbering have their own suites; here they are stood in
// by what this service needs from them: a draft comes back, a payment settles it.
const created = []
const payments = []
let harness = null

stubModule("@/lib/services/invoices", {
  createInvoice: async ({ input }) => {
    const row = {
      id: id(7000 + created.length),
      org_id: ORG,
      project_id: input.project_id,
      invoice_number: input.invoice_number,
      status: "draft",
      total_cents: Math.round(input.lines[0].unit_cost * 100),
      balance_due_cents: Math.round(input.lines[0].unit_cost * 100),
      metadata: input.metadata,
    }
    created.push({ input, row })
    harness.db.invoices.push(row)
    return { ...row, metadata: { ...row.metadata, lines: [] }, subtotal_cents: row.total_cents, tax_cents: 0 }
  },
})
stubModule("@/lib/services/payments", {
  recordPayment: async (input, orgId) => {
    payments.push({ input, orgId })
    const invoice = harness.db.invoices.find((row) => row.id === input.invoice_id)
    invoice.balance_due_cents -= input.amount_cents
    invoice.status = invoice.balance_due_cents <= 0 ? "paid" : "partial"
    return { id: id(8000 + payments.length) }
  },
})
stubModule("@/lib/services/invoice-numbers", { getNextInvoiceNumber: async () => ({ number: "INV-NEXT" }) })
stubModule("@/lib/services/accounting-sync", { enqueueInvoiceSync: async () => undefined })

const { syncConnectedReceivable, CONNECTED_RECEIVABLE_JOB_TYPE } = freshRequire("lib/services/connected-receivables.ts")
const {
  assertNotConnectedReceivable,
  connectedReceivableOf,
  connectedStatusLabel,
  planConnectedSync,
} = require("@/lib/receivables/connected")

const bill = (overrides) => ({
  id: BILL,
  org_id: BUILDER,
  project_id: BUILDER_PROJECT,
  company_id: TRADE_COMPANY,
  bill_number: "1042",
  bill_date: "2026-10-01",
  due_date: "2026-10-31",
  total_cents: 10_000,
  paid_cents: 0,
  status: "pending",
  metadata: { submitted_via_portal: true, description: "Framing, level 1" },
  updated_at: "2026-10-01T00:00:00Z",
  ...overrides,
})

const start = ({ bills = [bill()], connection = {}, invoices = [], token = {} } = {}) => {
  created.length = 0
  payments.length = 0
  harness = createServiceHarness({
    tables: {
      orgs: [{ id: ORG, product_tier: "residential" }],
      contacts: [{ id: CUSTOMER, org_id: ORG, full_name: "Acme Builders" }],
      project_connections: [
        {
          id: CONNECTION,
          org_id: ORG,
          project_id: TRADE_JOB,
          source_org_id: BUILDER,
          source_project_id: BUILDER_PROJECT,
          source_company_id: TRADE_COMPANY,
          source_org_name: "Acme Builders",
          customer_contact_id: CUSTOMER,
          portal_access_token_id: TOKEN,
          status: "active",
          linked_by: ACTOR,
          last_synced_at: null,
          ...connection,
        },
      ],
      portal_access_tokens: [{ id: TOKEN, org_id: BUILDER, revoked_at: null, paused_at: null, expires_at: null, ...token }],
      vendor_bills: bills,
      invoices,
    },
    rpc: {
      void_invoice_atomic: ({ p_invoice_id }) => {
        const invoice = harness.db.invoices.find((row) => row.id === p_invoice_id)
        invoice.status = "void"
        return { data: invoice, error: null }
      },
    },
  })
  return harness
}

const sync = (billId = BILL) =>
  harness.run(() => syncConnectedReceivable(ORG, { connection_id: CONNECTION, source_bill_id: billId }))

const mirrors = () => harness.db.invoices.filter((row) => row.status !== "void")
const setBill = (patch) => Object.assign(harness.db.vendor_bills.find((row) => row.id === BILL), patch)

test("the job type matches the one the database trigger enqueues", () => {
  assert.equal(CONNECTED_RECEIVABLE_JOB_TYPE, "sync_connected_receivable")
})

test("a portal bill becomes one sent invoice carrying the builder's status, and nobody is emailed", async () => {
  start()
  await sync()

  assert.equal(created.length, 1)
  assert.equal(created[0].input.issue, false, "created without the issue path that queues the customer email")
  assert.equal(created[0].input.invoice_number, "1042")
  assert.equal(created[0].input.customer_id, CUSTOMER)
  assert.equal(created[0].input.project_id, TRADE_JOB)

  const [invoice] = mirrors()
  assert.equal(invoice.status, "sent")
  assert.equal(invoice.total_cents, 10_000)
  assert.equal(invoice.client_visible, false)
  assert.equal(invoice.delivery_status, "not_sent")
  assert.equal(invoice.sent_to_emails, undefined)

  const source = connectedReceivableOf(invoice.metadata)
  assert.equal(source.sourceBillId, BILL)
  assert.equal(source.sourceStatus, "pending")
  assert.equal(connectedStatusLabel(source.sourceStatus), "Submitted to builder")
  assert.ok(harness.db.project_connections[0].last_synced_at, "the connection records when it last heard")
  assert.equal(harness.audits.length, 1)
  assert.equal(harness.audits[0].entityType, "invoice")
})

test("running the same sync again changes nothing", async () => {
  start()
  await sync()
  await sync()
  await sync()

  assert.equal(created.length, 1)
  assert.equal(mirrors().length, 1)
  assert.equal(payments.length, 0)
  assert.equal(harness.audits.length, 1)
})

test("an invoice number already in use on the sub's books gets the next number", async () => {
  start({ invoices: [{ id: id(9000), org_id: ORG, invoice_number: "1042", status: "sent", metadata: {} }] })
  await sync()

  assert.equal(created[0].input.invoice_number, "INV-NEXT")
})

test("a void-then-reissue takes a fresh number, never the voided invoice's", async () => {
  start()
  await sync()
  setBill({ total_cents: 12_500 })
  await sync()

  assert.deepEqual(created.map((entry) => entry.input.invoice_number), ["1042", "INV-NEXT"])
  assert.equal(harness.db.invoices[0].status, "void")
})

test("a mirror is issued without any retainage line, so it equals the builder's bill", async () => {
  start({ bills: [bill({ total_cents: 50_000 })] })
  await sync()

  assert.equal(created[0].input.lines.length, 1)
  assert.equal(created[0].input.lines[0].unit_cost, 500)
  assert.equal(mirrors()[0].total_cents, 50_000)
})

test("the builder's approval updates the same invoice instead of creating a second", async () => {
  start()
  await sync()
  setBill({ status: "approved" })
  await sync()

  assert.equal(created.length, 1)
  assert.equal(connectedReceivableOf(mirrors()[0].metadata).sourceStatus, "approved")
  assert.equal(harness.audits.length, 2)
})

test("the builder's payment is recorded once, for exactly what was paid since", async () => {
  start()
  await sync()

  setBill({ status: "partial", paid_cents: 4_000 })
  await sync()
  await sync()
  assert.equal(payments.length, 1)
  assert.equal(payments[0].input.amount_cents, 4_000)
  assert.equal(payments[0].input.provider_payment_id, `connected:${BILL}:4000`)
  assert.equal(payments[0].orgId, ORG)
  assert.equal(payments[0].input.method, "other")

  setBill({ status: "paid", paid_cents: 10_000 })
  await sync()
  await sync()
  assert.equal(payments.length, 2)
  assert.equal(payments[1].input.amount_cents, 6_000)
  assert.equal(mirrors().length, 1)
  assert.equal(mirrors()[0].status, "paid")
  assert.equal(connectedReceivableOf(mirrors()[0].metadata).sourcePaidCents, 10_000)
})

test("a payment carries the method the builder's bill names", async () => {
  start({ bills: [bill({ status: "paid", paid_cents: 10_000, payment_method: "check" })] })
  await sync()

  assert.equal(payments[0].input.method, "check")
})

test("a bill that arrives already paid is billed and paid in one sync", async () => {
  start({ bills: [bill({ status: "paid", paid_cents: 10_000 })] })
  await sync()

  assert.equal(created.length, 1)
  assert.equal(payments.length, 1)
  assert.equal(payments[0].input.amount_cents, 10_000)
})

test("a paid amount that goes down is flagged for review, not reversed", async () => {
  start()
  await sync()
  setBill({ status: "partial", paid_cents: 4_000 })
  await sync()
  setBill({ paid_cents: 1_000 })
  await sync()

  assert.equal(payments.length, 1)
  assert.equal(connectedReceivableOf(mirrors()[0].metadata).needsReview, true)
  assert.ok(harness.events.some((event) => event.eventType === "connected_receivable_needs_review"))
})

test("a bill the builder rejects voids the mirror", async () => {
  start()
  await sync()
  setBill({ status: "rejected" })
  await sync()

  assert.equal(mirrors().length, 0)
  assert.equal(harness.db.invoices[0].status, "void")
  assert.equal(connectedReceivableOf(harness.db.invoices[0].metadata).sourceStatus, "rejected")
})

test("a bill rejected before it was ever mirrored creates nothing", async () => {
  start({ bills: [bill({ status: "rejected" })] })
  const result = await sync()

  assert.equal(result.status, "skipped")
  assert.equal(created.length, 0)
})

test("a changed amount before any payment replaces the invoice", async () => {
  start()
  await sync()
  setBill({ total_cents: 12_500 })
  await sync()

  assert.equal(created.length, 2)
  assert.equal(mirrors().length, 1)
  assert.equal(mirrors()[0].total_cents, 12_500)
})

test("a changed amount after a payment is left for a person", async () => {
  start()
  await sync()
  setBill({ status: "partial", paid_cents: 4_000 })
  await sync()
  setBill({ total_cents: 12_500 })
  await sync()

  assert.equal(created.length, 1)
  assert.equal(mirrors()[0].total_cents, 10_000)
  assert.equal(connectedReceivableOf(mirrors()[0].metadata).needsReview, true)
})

test("a paused or ended connection does nothing", async () => {
  for (const status of ["paused", "ended"]) {
    start({ connection: { status } })
    const result = await sync()

    assert.deepEqual(result, { status: "skipped", reason: "connection_inactive" })
    assert.deepEqual(harness.writes(), [])
  }
})

test("a portal token past its own expiry ends the connection and reads nothing", async () => {
  start({ token: { expires_at: "2020-01-01T00:00:00Z" } })
  const result = await sync()

  assert.deepEqual(result, { status: "skipped", reason: "access_lapsed" })
  assert.equal(created.length, 0)
  const connection = harness.db.project_connections[0]
  assert.equal(connection.status, "ended")
  assert.equal(connection.ended_reason, "access_expired")
  assert.ok(connection.ended_at)
  assert.ok(harness.audits.some((audit) => audit.entityType === "project_connection" && audit.after.ended_reason === "access_expired"))
})

test("a revoked or paused portal token is not read, and the connection is left as it is", async () => {
  for (const token of [{ revoked_at: "2026-10-01T00:00:00Z" }, { paused_at: "2026-10-01T00:00:00Z" }]) {
    start({ token })
    const result = await sync()
    assert.deepEqual(result, { status: "skipped", reason: "access_lapsed" })
    assert.equal(created.length, 0)
    assert.equal(harness.db.project_connections[0].status, "active")
  }
})

test("only a portal bill on the linked project and company is read", async () => {
  for (const patch of [
    { metadata: { description: "Typed in by the builder" } },
    { project_id: id(199) },
    { company_id: id(198) },
    { org_id: id(197) },
  ]) {
    start({ bills: [bill(patch)] })
    const result = await sync()

    assert.deepEqual(result, { status: "skipped", reason: "bill_not_found" })
    assert.deepEqual(harness.writes(), [])
  }
})

test("a connection belonging to another org is not served", async () => {
  start()
  const result = await harness.run(() =>
    syncConnectedReceivable(id(555), { connection_id: CONNECTION, source_bill_id: BILL }),
  )

  assert.deepEqual(result, { status: "skipped", reason: "connection_inactive" })
  assert.deepEqual(harness.writes(), [])
})

test("a person cannot edit, void or collect on a mirrored invoice", () => {
  const metadata = {
    connected_receivable: { source_bill_id: BILL, source_org_name: "Acme Builders", source_status: "approved" },
  }

  assert.throws(
    () => assertNotConnectedReceivable(metadata),
    /managed in Acme Builders's portal\. Its status follows what the builder records\./,
  )
  assert.doesNotThrow(() => assertNotConnectedReceivable({ source_type: "manual" }))
  assert.doesNotThrow(() => assertNotConnectedReceivable(null))
})

test("the sync plan never moves money backwards", () => {
  const mirror = { totalCents: 10_000, sourcePaidCents: 4_000 }

  assert.deepEqual(planConnectedSync({ status: "partial", totalCents: 10_000, paidCents: 1_000 }, mirror), {
    create: false,
    voidReason: null,
    paymentDeltaCents: 0,
    needsReview: true,
  })
  assert.equal(planConnectedSync({ status: "paid", totalCents: 10_000, paidCents: 10_000 }, mirror).paymentDeltaCents, 6_000)
})
