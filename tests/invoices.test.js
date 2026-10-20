"use strict"

/**
 * Issuing an invoice (`issueInvoiceWithContext`, lib/services/invoices.ts):
 * the invoice is issued in the request, the customer email follows it, and an
 * invoice that carries a waiver only issues while that waiver still matches
 * what the customer is being billed.
 *
 * Replaced boundaries: the email provider (`mailer`), the accounting sync
 * enqueue, the outbox (so a test can choose whether a durable job exists), and
 * Next's `after()` (so a test decides when "after the response" happens).
 */

const assert = require("node:assert/strict")
const test = require("node:test")
const { AsyncResource } = require("node:async_hooks")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

let world

// Like Next, the callback keeps the request's async context (org, actor, client).
stubModule("next/server", {
  after: (callback) => {
    world.afterResponse.push(AsyncResource.bind(callback))
  },
})
stubModule("@/lib/services/mailer", {
  sendEmail: async (message) => {
    if (world.emailFails) throw new Error("provider unavailable")
    world.emails.push(message)
  },
  renderEmailTemplate: async () => "<html></html>",
  getOrgSenderEmail: () => "billing@example.test",
  escapeHtml: (value) => value,
  renderStandardEmailLayout: () => "<html></html>",
})
stubModule("@/lib/services/accounting-sync", { enqueueInvoiceSync: async () => {} })
stubModule("@/lib/services/outbox", {
  enqueueOutboxJob: async () => world.enqueue,
  completeOutboxJob: async (jobId) => {
    if (jobId !== undefined) world.completed.push(jobId)
  },
})

const { invoiceWaiverContentHash } = require("@/lib/lien-waivers/invoice-content")
const { issueInvoiceWithContext } = freshRequire("lib/services/invoices.ts")

const INVOICE = id(1)
const PROJECT = id(2)
const WAIVER = id(3)
const SIGNER = id(4)
const DOCUMENT = id(5)
const ENVELOPE = id(6)
const QUEUED = { enqueued: true, id: "job-1" }

function invoiceRow(overrides = {}) {
  return {
    id: INVOICE,
    org_id: ORG,
    project_id: PROJECT,
    invoice_number: "1042",
    title: "Work",
    status: "draft",
    notes: "",
    total_cents: 10000,
    subtotal_cents: 10000,
    tax_cents: 0,
    approval_status: "not_required",
    sent_to_emails: [],
    metadata: { lines: [{ description: "Work", quantity: 1, unit_price_cents: 10000 }] },
    ...overrides,
  }
}

function setup({ invoice = invoiceRow(), waivers = [], enqueue = QUEUED, emailFails = false } = {}) {
  const service = createServiceHarness({
    permissions: ["invoice.send", "invoice.read", "project.read"],
    tables: {
      orgs: [{ id: ORG, name: "Builder", slug: "builder" }],
      projects: [{ id: PROJECT, org_id: ORG, name: "Lot 12", property_type: "residential" }],
      invoices: [invoice],
      invoice_lien_waivers: waivers,
      invoice_deliveries: [],
      documents: [{ id: DOCUMENT, org_id: ORG, metadata: { waiver_signer_id: SIGNER } }],
      envelopes: [{ id: ENVELOPE, org_id: ORG, document_id: DOCUMENT, status: "sent" }],
    },
  })
  world = { service, afterResponse: [], emails: [], completed: [], enqueue, emailFails }
  return service
}

const issue = (service) =>
  service.run(() =>
    issueInvoiceWithContext(
      { supabase: service.client, orgId: ORG, userId: service.userId, productTier: "residential" },
      { invoiceId: INVOICE, recipients: ["customer@example.test"] },
    ),
  )
const afterResponse = () => Promise.all(world.afterResponse.map((callback) => callback()))

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

test("with a durable job queued, the invoice issues now and the email follows the response", async () => {
  const service = setup()
  await issue(service)

  assert.equal(service.db.invoices[0].status, "sent")
  assert.ok(service.db.invoices[0].issued_snapshot)
  assert.equal(world.emails.length, 0)

  await afterResponse()
  assert.deepEqual(world.emails.map((email) => email.to), [["customer@example.test"]])
  assert.deepEqual(world.completed, ["job-1"])
})

test("an email failure after the response leaves the queued job for its retry", async () => {
  const service = setup({ emailFails: true })
  await issue(service)
  await afterResponse()

  assert.equal(service.db.invoices[0].status, "sent")
  assert.equal(service.db.invoices[0].delivery_status, "failed")
  assert.deepEqual(world.completed, [])
})

test("without a durable job, the email is sent before returning and its failure is reported", async () => {
  const sent = setup({ enqueue: { enqueued: false, reason: "error" } })
  await issue(sent)
  assert.equal(world.emails.length, 1)

  const failed = setup({ enqueue: { enqueued: false, reason: "error" }, emailFails: true })
  await assert.rejects(issue(failed), /provider unavailable/)
})

// ---------------------------------------------------------------------------
// The waiver packet
// ---------------------------------------------------------------------------

/** A waiver fingerprinted against `invoice` — signed by the builder, or awaiting another signer. */
function packetFor(invoice, separate) {
  const packet = separate
    ? { enabled: true, waiver_id: WAIVER, delivery_mode: "separate_signature", signer_id: SIGNER, envelope_id: ENVELOPE }
    : { enabled: true, waiver_id: WAIVER }
  const withPacket = { ...invoice, metadata: { ...invoice.metadata, waiver_packet: packet } }
  const waiver = {
    id: WAIVER,
    org_id: ORG,
    invoice_id: INVOICE,
    status: "pending_payment",
    amount_cents: 10000,
    metadata: {
      workflow: {
        version: 2,
        lifecycle: separate ? "draft" : "signed",
        shared: !separate,
        signing_document_id: DOCUMENT,
        invoice_content_hash: invoiceWaiverContentHash(withPacket),
      },
    },
  }
  return { invoice: withPacket, waivers: [waiver] }
}

test("an invoice issues with its waiver whatever its notes, and not once the notes change after signing", async () => {
  for (const separate of [false, true]) {
    for (const notes of ["", "Payment covers framing through September"]) {
      const name = `${separate ? "another signer" : "self signed"}, ${notes ? "written" : "empty"} notes`
      const fixture = packetFor(invoiceRow({ notes }), separate)

      const service = setup(fixture)
      await issue(service)
      assert.equal(service.db.invoices[0].status, "sent", name)

      const changed = setup({ ...fixture, invoice: { ...fixture.invoice, notes: "Changed after signing" } })
      await assert.rejects(issue(changed), /waiver|signing|signature/i, name)
      assert.equal(changed.db.invoices[0].status, "draft", name)
      await afterResponse()
      assert.equal(world.emails.length, 0, name)
    }
  }
})

// ---------------------------------------------------------------------------
// Retainage on creation
// ---------------------------------------------------------------------------

const { createInvoice } = freshRequire("lib/services/invoices.ts")

/** The lines createInvoice sends to create_invoice_atomic for a $500 manual invoice on a job holding 10% retainage. */
async function retainageLinesFor(metadata) {
  const lines = []
  const service = createServiceHarness({
    permissions: ["invoice.write", "invoice.read", "project.read"],
    tables: {
      orgs: [{ id: ORG, name: "Builder", slug: "builder", product_tier: "residential" }],
      projects: [{ id: PROJECT, org_id: ORG, name: "Lot 12", property_type: "residential", retainage_percent: 10 }],
      contracts: [{ id: id(20), org_id: ORG, project_id: PROJECT, status: "active", total_cents: 1_000_000, retainage_percent: 10, created_at: "2026-01-01T00:00:00Z" }],
      invoices: [],
    },
    rpc: {
      create_invoice_atomic: ({ p_invoice, p_lines }) => {
        lines.push(...p_lines)
        return { data: { invoice: { id: INVOICE, org_id: ORG, ...p_invoice }, lines: p_lines }, error: null }
      },
    },
  })
  await service.run(() =>
    createInvoice({
      orgId: ORG,
      input: {
        project_id: PROJECT,
        invoice_number: "1042",
        title: "Work",
        issue: false,
        tax_rate: 0,
        source_type: "manual",
        lines: [{ description: "Work", quantity: 1, unit: "ea", unit_cost: 500, taxable: false }],
        ...(metadata ? { metadata } : {}),
      },
    }),
  )
  return lines
}

test("the builder's own invoice still withholds the job's retainage", async () => {
  const lines = await retainageLinesFor(null)
  assert.equal(lines.length, 2)
  assert.deepEqual(lines.map((line) => line.unit_price_cents).sort((a, b) => a - b), [-5000, 50000])
})

test("a mirrored builder bill carries no retainage line, on a job that holds retainage", async () => {
  const lines = await retainageLinesFor({ connected_receivable: { source_bill_id: id(30), source_org_name: "Acme Builders" } })
  assert.deepEqual(lines.map((line) => line.unit_price_cents), [50000])
})

// ---------------------------------------------------------------------------
// A mirrored invoice follows the builder; nothing here acts on it by hand
// ---------------------------------------------------------------------------

const { createReceivableAdjustment, voidReceivableAdjustment } = freshRequire("lib/services/receivable-adjustments.ts")
const { ensureInvoiceToken } = freshRequire("lib/services/invoices.ts")

const ADJUSTMENT = id(40)

function mirrorSetup() {
  return createServiceHarness({
    permissions: ["invoice.write", "invoice.send", "invoice.read", "project.read"],
    tables: {
      orgs: [{ id: ORG, name: "Sub", slug: "sub" }],
      projects: [{ id: PROJECT, org_id: ORG, name: "Oak Street", property_type: "residential" }],
      invoices: [invoiceRow({ status: "sent", token: null, metadata: { connected_receivable: { source_bill_id: id(30), source_org_name: "Acme Builders" } } })],
      receivable_adjustments: [{ id: ADJUSTMENT, org_id: ORG, project_id: PROJECT, invoice_id: INVOICE, adjustment_type: "credit_memo", status: "posted" }],
    },
  })
}

test("a share link, a credit memo and a void of one are refused on a mirrored invoice", async () => {
  const service = mirrorSetup()
  const refusal = /managed in Acme Builders's portal/

  await assert.rejects(service.run(() => ensureInvoiceToken(INVOICE)), refusal)
  await assert.rejects(
    service.run(() => createReceivableAdjustment({ invoiceId: INVOICE, adjustmentType: "credit_memo", amountCents: 1000, effectiveDate: "2026-10-19", reason: "Goodwill" })),
    refusal,
  )
  await assert.rejects(service.run(() => voidReceivableAdjustment(ADJUSTMENT)), refusal)
  assert.deepEqual(service.writes(), [])
})
