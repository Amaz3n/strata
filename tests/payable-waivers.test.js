"use strict"

/**
 * A trade's lien waiver for the builder's payables (lib/services/payable-waivers.ts):
 * what a waiver request may claim, and how a natively signed waiver is bound
 * to its executed artifact. Coverage math is tests/payable-waiver-coverage.test.js.
 */

const assert = require("node:assert/strict")
const test = require("node:test")
const { createHash } = require("node:crypto")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

const EXECUTED = Buffer.from("executed artifact")
stubModule("@/lib/storage/files-storage", { downloadFilesObject: async () => EXECUTED })

const { payableWaiverInputSchema, completePayableWaiverFromSigning } = freshRequire("lib/services/payable-waivers.ts")

const REQUEST = id(1)
const BILL = id(2)
const TEMPLATE = id(3)
const DOCUMENT = id(4)
const ENVELOPE = id(5)
const EXECUTED_FILE = id(6)
const WAIVER = id(7)

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

const request = (overrides = {}) => ({
  request_id: REQUEST,
  allocations: [{ bill_id: BILL, amount_cents: 50000 }],
  source: "template",
  template_id: TEMPLATE,
  waiver_type: "conditional_progress",
  through_date: "2026-08-31",
  claimant_name: "Trade LLC",
  customer_name: "Builder LLC",
  owner_name: "Property Owner",
  property_description: "123 Property Street",
  project_name: "Lot 4",
  jurisdiction: "FL",
  signer_name: "Trade Signer",
  signer_title: "President",
  signer_email: "trade@example.com",
  ...overrides,
})
const accepts = (overrides) => payableWaiverInputSchema.safeParse(request(overrides)).success

test("a waiver is one of four explicit kinds, and final or unconditional ones need their own attestations", () => {
  assert.equal(accepts({}), true)
  for (const waiver_type of ["conditional", "unconditional", "final"]) {
    assert.equal(accepts({ waiver_type }), false, waiver_type)
  }
  assert.equal(accepts({ waiver_type: "conditional_final" }), false, "a final waiver needs the final attestation")
  assert.equal(accepts({ waiver_type: "unconditional_progress" }), false, "an unconditional waiver needs proof of receipt")
  assert.equal(accepts({ waiver_type: "unconditional_final", final_confirmed: true, received_confirmed: true }), true)
})

test("a request cannot double-count a bill, skip the signed date of an upload, or claim an invalid amount", () => {
  assert.equal(accepts({ allocations: [request().allocations[0], request().allocations[0]] }), false)
  assert.equal(accepts({ source: "upload" }), false)
  for (const amount_cents of [-1, 0, 0.1, NaN, 2147483648]) {
    assert.equal(accepts({ allocations: [{ bill_id: BILL, amount_cents }] }), false, String(amount_cents))
  }
})

// ---------------------------------------------------------------------------
// Native signing completion
// ---------------------------------------------------------------------------

function setup({ document = {}, envelope = {}, waiver = {} } = {}) {
  return createServiceHarness({
    tables: {
      documents: [
        {
          id: DOCUMENT,
          org_id: ORG,
          status: "signed",
          executed_file_id: EXECUTED_FILE,
          metadata: { payable_waiver_request_id: REQUEST },
          ...document,
        },
      ],
      envelopes: [
        { id: ENVELOPE, org_id: ORG, document_id: DOCUMENT, status: "executed", executed_at: "2026-09-01T00:00:00Z", ...envelope },
      ],
      files: [{ id: EXECUTED_FILE, org_id: ORG, storage_path: "executed.pdf" }],
      lien_waivers: [
        {
          id: WAIVER,
          org_id: ORG,
          status: "requested",
          signed_file_id: null,
          updated_at: "2026-08-31T00:00:00+00:00",
          metadata: { request_id: REQUEST, document_id: DOCUMENT, review: { status: "accepted" } },
          ...waiver,
        },
      ],
    },
  })
}

const complete = (service) =>
  completePayableWaiverFromSigning({
    supabase: service.client,
    orgId: ORG,
    documentId: DOCUMENT,
    envelopeId: ENVELOPE,
    executedFileId: EXECUTED_FILE,
  })

test("completion binds the exact executed file and leaves the human coverage review pending", async () => {
  const service = setup()
  await complete(service)

  const [waiver] = service.db.lien_waivers
  assert.equal(waiver.status, "signed")
  assert.equal(waiver.signed_file_id, EXECUTED_FILE)
  assert.equal(waiver.signed_at, "2026-09-01T00:00:00Z")
  assert.equal(waiver.metadata.sha256, createHash("sha256").update(EXECUTED).digest("hex"))
  assert.deepEqual(waiver.metadata.review, { status: "pending" })
})

test("a repeated completion cannot reset a review a person already made", async () => {
  const service = setup({ waiver: { signed_file_id: EXECUTED_FILE } })
  await complete(service)
  assert.deepEqual(service.writes(), [])
  assert.deepEqual(service.db.lien_waivers[0].metadata.review, { status: "accepted" })
})

test("the wrong artifact, a different document, an unexecuted envelope, or a replaced file all fail closed", async () => {
  const cases = {
    "another executed file": setup({ document: { executed_file_id: id(90) } }),
    "a waiver for another document": setup({ waiver: { metadata: { request_id: REQUEST, document_id: id(91) } } }),
    "an envelope still out for signature": setup({ envelope: { status: "sent" } }),
    "a waiver already bound to a different file": setup({ waiver: { signed_file_id: id(92) } }),
  }
  for (const [name, service] of Object.entries(cases)) {
    await assert.rejects(complete(service), undefined, name)
    assert.deepEqual(service.writes(), [], name)
  }
})
