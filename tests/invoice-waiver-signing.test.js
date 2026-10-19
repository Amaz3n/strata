"use strict"

/**
 * Completing a natively signed invoice waiver (`completeInvoiceWaiverFromSigning`):
 * the executed artifact is bound exactly, retries are harmless, and a waiver
 * whose invoice changed while it was out for signature is held for review
 * instead of shared.
 */

const assert = require("node:assert/strict")
const test = require("node:test")
const { createHash } = require("node:crypto")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

const EXECUTED = Buffer.from("EXACT EXECUTED PDF INCLUDING AUDIT CERTIFICATE")
const autoSends = []
stubModule("@/lib/storage/files-storage", { downloadFilesObject: async () => EXECUTED })
stubModule("@/lib/services/invoice-waiver-auto-send", {
  sendInvoiceAfterWaiverSignature: async (...args) => {
    autoSends.push(args)
  },
})

const { completeInvoiceWaiverFromSigning } = freshRequire("lib/services/invoice-waiver-signing.ts")

const INVOICE = id(1)
const WAIVER = id(2)
const DOCUMENT = id(3)
const EXECUTED_FILE = id(4)
const ENVELOPE = id(5)

function setup({ workflow = {}, document = {}, envelope = {}, invoiceUpdatedAt = "revision1" } = {}) {
  autoSends.length = 0
  return createServiceHarness({
    tables: {
      invoices: [{ id: INVOICE, org_id: ORG, status: "sent", updated_at: invoiceUpdatedAt, invoice_number: "INV-1" }],
      invoice_lien_waivers: [
        {
          id: WAIVER,
          org_id: ORG,
          invoice_id: INVOICE,
          status: "pending_payment",
          amount_cents: 2500,
          updated_at: "2026-09-01T00:00:00+00:00",
          metadata: {
            workflow: {
              version: 2,
              lifecycle: "draft",
              source: "template",
              input: { waiver_type: "conditional_progress" },
              shared: false,
              sharing_requested: true,
              document_path: "draft.pdf",
              invoice_revision: "revision1",
              signing_document_id: DOCUMENT,
              ...workflow,
            },
          },
        },
      ],
      documents: [
        {
          id: DOCUMENT,
          org_id: ORG,
          status: "signed",
          executed_file_id: EXECUTED_FILE,
          metadata: { invoice_lien_waiver_id: WAIVER },
          ...document,
        },
      ],
      files: [{ id: EXECUTED_FILE, org_id: ORG, storage_path: "executed.pdf" }],
      envelopes: [
        { id: ENVELOPE, org_id: ORG, document_id: DOCUMENT, status: "executed", executed_at: "2026-09-07T12:00:00Z", ...envelope },
      ],
      payments: [],
      payment_allocations: [],
      payment_reversals: [],
    },
  })
}

const complete = (service) =>
  completeInvoiceWaiverFromSigning({
    supabase: service.client,
    orgId: ORG,
    documentId: DOCUMENT,
    envelopeId: ENVELOPE,
    executedFileId: EXECUTED_FILE,
  })
const flowOf = (service) => service.db.invoice_lien_waivers[0].metadata.workflow

test("completion binds the exact executed artifact, shares as requested and hands off to delivery", async () => {
  const service = setup()
  await complete(service)

  const flow = flowOf(service)
  assert.equal(flow.lifecycle, "signed")
  assert.equal(flow.document_path, "executed.pdf")
  assert.equal(flow.file_id, EXECUTED_FILE)
  assert.equal(flow.sha256, createHash("sha256").update(EXECUTED).digest("hex"))
  assert.equal(flow.signed_at, "2026-09-07T12:00:00Z")
  assert.equal(flow.shared, true)
  assert.equal(autoSends.length, 1)
})

test("a retried completion changes nothing and only retries delivery", async () => {
  const service = setup()
  await complete(service)
  const writes = service.writes("invoice_lien_waivers").length

  await complete(service)
  assert.equal(service.writes("invoice_lien_waivers").length, writes)
  assert.equal(autoSends.length, 2)
})

test("a waiver whose invoice changed during signing is signed but held for review, not shared", async () => {
  const service = setup({ invoiceUpdatedAt: "revision2" })
  await complete(service)

  const flow = flowOf(service)
  assert.equal(flow.lifecycle, "signed")
  assert.equal(flow.needs_review, true)
  assert.equal(flow.shared, false)
})

test("an unfinished signing or a mismatched document completes nothing", async () => {
  const cases = {
    "a document not yet signed": setup({ document: { status: "sent" } }),
    "a different executed file": setup({ document: { executed_file_id: id(99) } }),
    "an envelope not executed": setup({ envelope: { status: "sent" } }),
    "a waiver signing another document": setup({ workflow: { signing_document_id: id(98) } }),
  }
  for (const [name, service] of Object.entries(cases)) {
    await assert.rejects(complete(service), undefined, name)
    assert.deepEqual(service.writes(), [], name)
    assert.equal(flowOf(service).lifecycle, "draft", name)
  }
  assert.equal(autoSends.length, 0)
})
