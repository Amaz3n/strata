"use strict"

/**
 * Reading a vendor invoice into a draft bill (`processPayableIntake`,
 * lib/services/payable-intake.ts) and the upload rules in front of it
 * (lib/payables/intake.ts).
 *
 * A scan only ever fills a DRAFT, it never overwrites a person's edit, and a
 * stuck or failed scan leaves an editable draft rather than a spinner.
 * Replaced boundaries: the model extraction, storage, and file linking.
 */

const assert = require("node:assert/strict")
const test = require("node:test")

const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

const { invoiceFileError, payableIntakeError, INVOICE_MAX_BYTES } = require("@/lib/payables/intake")

let extract
stubModule("@/lib/services/document-extraction", {
  extractPayableInvoiceFromFile: (_file, options) => extract(options),
})
stubModule("@/lib/services/file-links", { attachFileWithServiceRole: async () => {} })
stubModule("@/lib/storage/files-storage", { downloadFilesObject: async () => Buffer.from("%PDF") })

const { intakeRow, processPayableIntake } = freshRequire("lib/services/payable-intake.ts")

const BILL = id(1)
const PDF = new File([Buffer.from("%PDF")], "bill.pdf", { type: "application/pdf" })

const INVOICE = {
  billable: true,
  vendorName: "Vendor",
  vendorId: null,
  billNumber: "INV-1",
  totalDollars: 125,
  billDate: "2026-09-07",
  dueDate: null,
  lines: [{ description: "Work", amountCents: 12500 }],
  notes: [],
  model: "test",
}

function setup(intake = {}) {
  return createServiceHarness({
    tables: {
      vendor_bills: [
        {
          id: BILL,
          org_id: ORG,
          status: "pending",
          total_cents: 0,
          updated_at: "2026-09-07T00:00:00+00:00",
          metadata: { creation_state: "draft", intake: { actor_id: ACTOR, name: "bill.pdf", stage: "queued", ...intake } },
        },
      ],
    },
  })
}

const bill = (service) => service.db.vendor_bills[0]
const run = (service) => service.run(() => processPayableIntake(BILL, ORG, PDF))
const later = (ms) => new Date(Date.now() + ms).toISOString()

test("empty, unsupported and oversized uploads are refused before any scan", () => {
  assert.match(invoiceFileError({ size: 0, type: "application/pdf" }), /empty/)
  assert.match(invoiceFileError({ size: INVOICE_MAX_BYTES + 1, type: "application/pdf" }), /20 MB/)
  assert.match(invoiceFileError({ size: 10, type: "text/html" }), /Choose a PDF/)
  assert.equal(invoiceFileError({ size: INVOICE_MAX_BYTES, type: "application/pdf" }), null)
})

test("a scan error keeps its cause but never a credential", () => {
  assert.equal(payableIntakeError(new Error("The PDF is password protected")), "The PDF is password protected")
  assert.equal(payableIntakeError({ message: "Storage unavailable" }), "Storage unavailable")
  assert.doesNotMatch(payableIntakeError(new Error("Invalid Bearer secret-token key=sk-secret123")), /secret-token|sk-secret123/)
})

test("streamed values are only a preview; the finished scan fills the draft and stays a draft", async () => {
  const service = setup()
  extract = async (options) => {
    await options.onPartial({ vendor_name: "Vendor", total: 100 })
    assert.equal(bill(service).total_cents, 0)
    assert.equal(bill(service).metadata.intake.preview.amount, 10000)
    return INVOICE
  }
  await run(service)

  assert.equal(bill(service).total_cents, 12500)
  assert.equal(bill(service).bill_number, "INV-1")
  assert.equal(bill(service).status, "pending")
  assert.equal(bill(service).metadata.creation_state, "draft")
  assert.equal(bill(service).metadata.intake.stage, "ready")
  assert.equal(service.audits.length, 1)

  const writes = service.writes().length
  await run(service)
  assert.equal(service.writes().length, writes, "a redelivered job does not apply the scan again")
})

test("a scan that finishes after a person edited the draft keeps the person's edit", async () => {
  const service = setup()
  extract = async () => {
    Object.assign(bill(service), { total_cents: 9900, updated_at: "2026-09-07T01:00:00+00:00" })
    return INVOICE
  }
  await run(service)

  assert.equal(bill(service).total_cents, 9900)
  assert.equal(bill(service).metadata.intake.stage, "failed")
  assert.match(bill(service).metadata.intake.error, /edits were kept/)
})

test("a failed scan or a document that is not an invoice leaves an editable draft", async () => {
  for (const failure of [
    async () => {
      throw new Error("Provider unavailable")
    },
    async () => ({ ...INVOICE, billable: false }),
  ]) {
    const service = setup()
    extract = failure
    await run(service)
    assert.equal(bill(service).metadata.intake.stage, "failed")
    assert.equal(bill(service).metadata.creation_state, "draft")
    assert.equal(bill(service).total_cents, 0)
  }
})

test("a running scan holds a lease, and an expired lease is taken over without a second bill", async () => {
  const running = setup({ stage: "reading", lease_until: later(60_000) })
  let called = false
  extract = async () => {
    called = true
    return INVOICE
  }
  await assert.rejects(run(running), /already running/)
  assert.equal(called, false)

  const abandoned = setup({ stage: "reading", lease_until: later(-1000) })
  await run(abandoned)
  assert.equal(abandoned.db.vendor_bills.length, 1)
  assert.equal(bill(abandoned).metadata.intake.stage, "ready")
})

test("an abandoned scan shows as a failure to retry, not an endless reading state", () => {
  const row = intakeRow({
    id: BILL,
    total_cents: 0,
    metadata: { intake: { name: "bill.pdf", stage: "reading", lease_until: later(-1000) } },
  })
  assert.equal(row.stage, "failed")
  assert.match(row.error, /timed out/)
})

test("a stalled scan fails at its deadline and ignores anything it streams afterwards", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const service = setup()
  let stream
  let started
  const scanning = new Promise((resolve) => {
    started = resolve
  })
  extract = (options) => {
    stream = options.onPartial
    started()
    return new Promise(() => {})
  }

  const done = run(service)
  await scanning
  t.mock.timers.tick(110_000)
  await done

  assert.equal(bill(service).metadata.intake.stage, "failed")
  assert.match(bill(service).metadata.intake.error, /timed out/)
  const writes = service.writes().length
  await stream({ vendor_name: "Late vendor", total: 55 })
  assert.equal(service.writes().length, writes)
})
