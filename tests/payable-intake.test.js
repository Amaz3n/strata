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
stubModule("@/lib/storage/files-storage", { downloadFilesObject: async () => Buffer.from("%PDF"), uploadFilesObject: async () => {} })
stubModule("@/lib/services/payable-duplicate-check", { findDuplicatePayable: async () => null })
stubModule("@/lib/services/books/coding-rules", { suggestCodingForService: async () => null })
const notified = []
stubModule("@/lib/services/notifications", {
  NotificationService: class {
    async createAndQueue(input) {
      notified.push(input.title)
      return id(1)
    }
  },
})

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

test("a supplier bill files to the one job its text names, by name or street address", () => {
  const { matchBillToJob } = require("@/lib/financials/bill-job-match")
  const jobs = [
    { id: "smith", name: "Smith Residence", address: "412 Oak Street, Austin, TX" },
    { id: "lake", name: "Lakeview Remodel", address: "9 Harbor Lane, Austin, TX" },
    { id: "short", name: "Job 12", address: null },
  ]
  assert.equal(matchBillToJob({ texts: ["Lumber for the Smith job"], jobs }).jobId, "smith")
  assert.equal(matchBillToJob({ texts: [null, "Delivered to 412 Oak St"], jobs }).jobId, "smith")
  assert.equal(matchBillToJob({ texts: ["Ship to 9 Harbor Ln"], jobs }).jobId, "lake")
  const ambiguous = matchBillToJob({ texts: ["Smith job and Lakeview remodel framing"], jobs })
  assert.equal(ambiguous.jobId, null)
  assert.match(ambiguous.reason, /more than one/)
  assert.equal(matchBillToJob({ texts: ["Remodel project residence house job 12"], jobs }).jobId, null)
  assert.equal(matchBillToJob({ texts: ["Order 4120 Oak"], jobs }).jobId, null)
  assert.equal(matchBillToJob({ texts: [], jobs }).jobId, null)
})

test("a supplier's own name is never a job reference, and a lone shared word is not a distinctive match", () => {
  const { matchBillToJob } = require("@/lib/financials/bill-job-match")
  const jobs = [{ id: "smith", name: "Smith Residence", address: null }, { id: "harbor", name: "Harbor View Remodel", address: null }]
  const supplier = (name) => ({ texts: [`Invoice from ${name}`, "Assorted materials"], jobs, ignoring: [name] })
  assert.equal(matchBillToJob(supplier("Smith Lumber & Supply")).jobId, null)
  assert.equal(matchBillToJob(supplier("Harbor View Hardware")).jobId, null)
  // Without the supplier excluded, a bare "Smith" is still not enough; it needs the word of a job beside it.
  assert.equal(matchBillToJob({ texts: ["Smith Lumber & Supply invoice 44"], jobs }).jobId, null)
  assert.equal(matchBillToJob({ texts: ["Smith job, 2x4 studs"], jobs }).jobId, "smith")
  assert.equal(matchBillToJob({ texts: ["Deck lumber for Harbor View"], jobs }).jobId, "harbor")
})

// A supply house has no commitment to route by, so a trade company's emailed bill is filed to the job it names.
// Builders keep the old behaviour: no commitment, no project.
const emailedBill = async ({ kind, vendorName, subject, description, jobs }) => {
  const { processInboundBillEmail } = freshRequire("lib/services/payables-email-ingest.ts")
  const service = createServiceHarness({
    tables: {
      org_settings: [{ org_id: ORG, settings: kind === "trade" ? { business_profile: { kind: "trade", specialty: "Electrical" } } : {} }],
      memberships: [{ org_id: ORG, user_id: ACTOR, status: "active" }],
      projects: jobs.map((job, index) => ({ id: id(700 + index), org_id: ORG, phase: "delivery", status: "active", location: null, ...job })),
      contacts: [],
      companies: [],
      commitments: [],
      files: [],
      vendor_bills: [],
    },
  })
  extract = async () => ({ ...INVOICE, vendorName, description, lines: [{ description, amountCents: 12500 }] })
  process.env.RESEND_API_KEY = "test"
  const realFetch = global.fetch
  global.fetch = async (url) => {
    const path = String(url)
    const body = path.endsWith("/attachments")
      ? { data: [{ filename: "bill.pdf", content_type: "application/pdf", download_url: "https://files.test/bill.pdf" }] }
      : { from: `${vendorName} <ar@${vendorName.split(" ")[0].toLowerCase()}lumber.example>`, subject }
    return path.startsWith("https://files.test")
      ? new Response(Buffer.from("%PDF"))
      : new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
  }
  notified.length = 0
  try {
    const result = await service.run(() => processInboundBillEmail({ orgId: ORG, emailId: "em_1" }))
    return { result, service }
  } finally {
    global.fetch = realFetch
  }
}

test("a trade company's supply-house bill files to the job it names, never to a job named like the supplier", async () => {
  const jobs = [{ name: "Smith Residence" }, { name: "Harbor View Remodel" }]
  const named = await emailedBill({ kind: "trade", vendorName: "Acme Supply", subject: "Invoice 88", description: "Conduit for the Smith Residence panel", jobs })
  assert.equal(named.result.status, "created")
  assert.equal(named.result.projectId, id(700))
  assert.equal(named.service.db.vendor_bills[0].metadata.routed_by, "job_reference")

  for (const [vendorName, job] of [["Smith Lumber & Supply", jobs[0]], ["Harbor View Hardware", jobs[1]]]) {
    const supplier = await emailedBill({ kind: "trade", vendorName, subject: `Invoice from ${vendorName}`, description: "Assorted materials", jobs })
    assert.equal(supplier.result.status, "unrouted", job.name)
  }
})

test("a builder's emailed bill with no commitment still needs a project, whatever the bill's text says", async () => {
  const builder = await emailedBill({ kind: "builder", vendorName: "Acme Supply", subject: "Invoice 88", description: "Conduit for the Smith Residence panel", jobs: [{ name: "Smith Residence" }] })
  assert.equal(builder.result.status, "unrouted")
  assert.deepEqual(builder.service.db.vendor_bills, [])
  assert.ok(notified.includes("Emailed bill needs a project"))
})
