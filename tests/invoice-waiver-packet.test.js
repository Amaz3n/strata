"use strict"

/**
 * An invoice can carry the builder's own lien waiver as a packet
 * (`lib/services/invoice-waiver-packet.ts`). The packet may only go out with a
 * waiver that was signed for exactly this invoice's money; anything else is
 * held back.
 */

const assert = require("node:assert/strict")
const test = require("node:test")

const { createServiceHarness, replies, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { invoiceWaiverContentHash: hash } = require("@/lib/lien-waivers/invoice-content")
const { assertInvoiceWaiverPacketReady, setInvoiceWaiverPacket } = freshRequire("lib/services/invoice-waiver-packet.ts")

const INVOICE = id(1)
const PROJECT = id(2)
const WAIVER = id(3)
const SIGNER = id(4)
const DOCUMENT = id(5)
const ENVELOPE = id(6)
const SEEN = "2026-09-01T00:00:00+00:00"

function invoice(packet = { enabled: true, waiver_id: WAIVER }, overrides = {}) {
  return {
    id: INVOICE,
    org_id: ORG,
    project_id: PROJECT,
    invoice_number: "1",
    status: "draft",
    total_cents: 2500,
    updated_at: SEEN,
    metadata: { waiver_packet: packet, lines: [{ description: "Work", quantity: 1, unit_price_cents: 2500 }] },
    ...overrides,
  }
}

function waiver(workflow = {}, overrides = {}) {
  return {
    id: WAIVER,
    org_id: ORG,
    invoice_id: INVOICE,
    status: "pending_payment",
    amount_cents: 2500,
    updated_at: SEEN,
    metadata: {
      workflow: {
        version: 2,
        lifecycle: "signed",
        source: "template",
        shared: true,
        document_path: "signed.pdf",
        invoice_content_hash: hash(invoice()),
        ...workflow,
      },
    },
    ...overrides,
  }
}

function harness(tables = {}) {
  return createServiceHarness({
    permissions: ["invoice.write", "invoice.read", "project.read"],
    tables: {
      projects: [{ id: PROJECT, org_id: ORG }],
      invoices: [invoice()],
      invoice_lien_waivers: [waiver()],
      documents: [{ id: DOCUMENT, org_id: ORG, metadata: { waiver_signer_id: SIGNER } }],
      envelopes: [{ id: ENVELOPE, org_id: ORG, document_id: DOCUMENT, status: "sent" }],
      ...tables,
    },
  })
}

const ready = (service, target = invoice()) => assertInvoiceWaiverPacketReady(service.client, ORG, target)

test("the waiver's fingerprint ignores delivery and row identity but not the money or the work", () => {
  const base = invoice()
  const delivered = {
    ...base,
    status: "sent",
    updated_at: "later",
    metadata: { ...base.metadata, lines: [{ ...base.metadata.lines[0], id: "new-row" }] },
  }
  assert.equal(hash(base), hash(delivered))
  assert.notEqual(hash(base), hash({ ...base, total_cents: 2000 }))
  assert.notEqual(hash(base), hash({ ...base, notes: "Payment covers framing" }))
  assert.notEqual(
    hash(base),
    hash({ ...base, metadata: { ...base.metadata, lines: [{ description: "Different work", quantity: 1, unit_price_cents: 2500 }] } }),
  )
})

test("an invoice without a packet needs no waiver", async () => {
  await ready(harness({ invoice_lien_waivers: [] }), invoice({}))
})

test("a packet goes out only with the selected, signed, shared waiver for this exact invoice", async () => {
  await ready(harness())

  const refusals = {
    "no waiver": [],
    "an unsigned waiver": [waiver({ lifecycle: "draft" })],
    "an unshared waiver": [waiver({ shared: false })],
    "a waiver needing review": [waiver({ needs_review: true })],
    "a waiver for an earlier version of the invoice": [waiver({ invoice_content_hash: "stale" })],
    "a different waiver than the one selected": [waiver({}, { id: id(99) })],
    "a waiver for more than the invoice": [waiver({}, { amount_cents: 3000 })],
  }
  for (const [name, rows] of Object.entries(refusals)) {
    await assert.rejects(ready(harness({ invoice_lien_waivers: rows })), /Finish signing/, name)
  }
})

test("a waiver sent separately for signature needs its signer's live request and a current fingerprint", async () => {
  const packet = { enabled: true, waiver_id: WAIVER, delivery_mode: "separate_signature", signer_id: SIGNER, envelope_id: ENVELOPE }
  const target = invoice(packet)
  const pending = waiver({ lifecycle: "draft", shared: false, signing_document_id: DOCUMENT, invoice_content_hash: hash(target) })
  const withEnvelope = (status) => ({ invoice_lien_waivers: [pending], envelopes: [{ id: ENVELOPE, org_id: ORG, document_id: DOCUMENT, status }] })

  await ready(harness(withEnvelope("sent")), target)
  await ready(harness(withEnvelope("executed")), target)

  await assert.rejects(ready(harness(withEnvelope("draft")), target), /selected signer/)
  const otherSigner = { ...withEnvelope("sent"), documents: [{ id: DOCUMENT, org_id: ORG, metadata: { waiver_signer_id: id(98) } }] }
  await assert.rejects(ready(harness(otherSigner), target), /selected signer/)

  const stale = waiver({ lifecycle: "draft", shared: false, signing_document_id: DOCUMENT, invoice_content_hash: "stale" })
  await assert.rejects(ready(harness({ invoice_lien_waivers: [stale] }), target), /waiver changed/)
})

test("including an unsigned waiver asks for it to be shared once signed, without publishing it", async () => {
  // Imported wording is long; it must never ride in a filter (the request URL).
  const wording = "Imported wording ".repeat(2000)
  const draft = waiver({ lifecycle: "draft", shared: false })
  draft.metadata.template = wording
  const service = harness({ invoice_lien_waivers: [draft], invoices: [invoice({ enabled: false })] })
  const filters = []
  service.tamper("invoice_lien_waivers", (result, query) => {
    filters.push(...Object.values(query.where).map(String))
    return result
  })

  await service.run(() => setInvoiceWaiverPacket(INVOICE, true, WAIVER))

  const [saved] = service.db.invoice_lien_waivers
  assert.equal(saved.metadata.template, wording)
  assert.equal(saved.metadata.workflow.sharing_requested, true)
  assert.equal(saved.metadata.workflow.shared, false)
  assert.equal(service.db.invoices[0].metadata.waiver_packet.waiver_id, WAIVER)
  assert.equal(service.db.invoices[0].metadata.waiver_packet.enabled, true)
  assert.ok(filters.every((value) => value.length < 100))
})

test("a waiver that changed underneath the packet, or a failed save, leaves the invoice alone", async () => {
  const raced = harness()
  raced.tamper("invoice_lien_waivers", replies.missing(), { on: "update" })
  await assert.rejects(raced.run(() => setInvoiceWaiverPacket(INVOICE, false)), /waiver changed/)
  assert.equal(raced.db.invoices[0].metadata.waiver_packet.enabled, true)

  const failed = harness()
  failed.tamper("invoice_lien_waivers", replies.error(), { on: "update" })
  await assert.rejects(failed.run(() => setInvoiceWaiverPacket(INVOICE, false)), /Could not save the waiver packet/)
  assert.equal(failed.writes("invoices").length, 0)
})

test("a waiver from another invoice cannot be selected", async () => {
  const service = harness()
  await assert.rejects(service.run(() => setInvoiceWaiverPacket(INVOICE, true, id(97))), /does not belong/)
  assert.deepEqual(service.writes(), [])
})
