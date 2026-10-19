"use strict"

/**
 * The builder's own lien waiver on an invoice (`lib/services/invoice-waiver-workflow.ts`):
 * prepare a draft, sign or record it, share it, release it against real funds,
 * and keep every document exactly as signed.
 *
 * Boundaries replaced: file storage and PDF filing (`storeGeneratedPdf` files a
 * row and keeps the bytes in memory), the invoice's payment activity (its own
 * service), the documents service used to open native signing, and the
 * auto-send that follows a physical upload (tests/invoice-waiver-auto-send.test.js).
 */

const assert = require("node:assert/strict")
const test = require("node:test")
const { createHash, randomUUID } = require("node:crypto")
const { PDFDocument } = require("pdf-lib")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

const INVOICE = id(1)
const PROJECT = id(2)
const OTHER_INVOICE = id(3)

/** What the boundaries hold for the current test. */
let world
const objects = () => world.objects

stubModule("@/lib/storage/files-storage", {
  downloadFilesObject: async ({ path }) => {
    assert.ok(world.objects.has(path), `no stored object at ${path}`)
    return world.objects.get(path)
  },
})
stubModule("@/lib/services/generated-documents", {
  storeGeneratedPdf: async (input) => {
    const fileId = randomUUID()
    const storagePath = `${input.orgId}/${fileId}.pdf`
    world.objects.set(storagePath, Buffer.from(input.pdf))
    world.service.db.files.unshift({
      id: fileId,
      org_id: input.orgId,
      project_id: input.projectId,
      storage_path: storagePath,
      folder_path: input.folderPath,
      metadata: input.metadata ?? {},
      archived_at: null,
      created_at: new Date().toISOString(),
    })
    return { fileId, storagePath }
  },
})
stubModule("@/lib/services/payments", {
  getInvoicePaymentActivity: async () => ({ payments: world.payments, reversals: world.reversals }),
})
stubModule("@/lib/services/documents", {
  createDocument: async (input) => {
    const documentId = randomUUID()
    world.documents.push(input)
    world.service.db.documents.push({ id: documentId, org_id: ORG, status: "draft", metadata: input.metadata })
    return { id: documentId }
  },
  replaceDocumentFields: async ({ fields }) => {
    world.fields = fields
  },
})
stubModule("@/lib/services/invoice-waiver-auto-send", {
  sendInvoiceAfterWaiverSignature: async (...args) => {
    world.autoSends.push(args)
  },
})

const workflow = freshRequire("lib/services/invoice-waiver-workflow.ts")

const WRITER = ["invoice.read", "invoice.write", "invoice.send", "project.read"]

function setup({ permissions = WRITER, invoice = {} } = {}) {
  const service = createServiceHarness({
    permissions,
    tables: {
      projects: [{ id: PROJECT, org_id: ORG }],
      invoices: [
        {
          id: INVOICE,
          org_id: ORG,
          project_id: PROJECT,
          invoice_number: "QA-1",
          status: "sent",
          currency: "usd",
          total_cents: 50000,
          balance_due_cents: 50000,
          updated_at: "2026-09-01T00:00:00+00:00",
          metadata: {},
          ...invoice,
        },
      ],
      invoice_lien_waivers: [],
      files: [],
      documents: [],
      app_users: [],
    },
  })
  world = { service, objects: new Map(), payments: [], reversals: [], documents: [], autoSends: [] }
  return service
}

async function pdfFile(text = "SIGNED OUTSIDE ARC - ORIGINAL BYTES") {
  const pdf = await PDFDocument.create()
  pdf.addPage().drawText(text)
  const bytes = Buffer.from(await pdf.save())
  return { bytes, file: { size: bytes.length, arrayBuffer: async () => bytes } }
}

const preparation = (overrides = {}) => ({
  request_id: randomUUID(),
  invoice_id: INVOICE,
  source: "upload",
  waiver_type: "conditional_progress",
  amount_cents: 25000,
  through_date: "2026-08-31",
  claimant_name: "Builder LLC",
  customer_name: "Customer LLC",
  owner_name: "Owner LLC",
  property_description: "100 Example Lane, Lot 1",
  jurisdiction: "FL",
  signer_name: "External Signer",
  signer_title: "President",
  signed_date: "2026-09-01",
  ...overrides,
})

const TEMPLATE_FIELDS = [
  { id: "signature", key: "signer_name", page: 0, x: 0.1, y: 0.5, width: 0.4, height: 0.05 },
  { id: "date", key: "signed_date", page: 0, x: 0.1, y: 0.6, width: 0.4, height: 0.05 },
]
const companyTemplate = (overrides = {}) => ({
  name: "Company progress",
  waiver_type: "conditional_progress",
  scope: "company",
  preferred: true,
  fields: TEMPLATE_FIELDS,
  ...overrides,
})

const run = (work) => world.service.run(work)
const waiverRow = (waiverId) => world.service.db.invoice_lien_waivers.find((row) => row.id === waiverId)

/** A signed, recorded upload covering $250 of the invoice. */
async function signedUpload() {
  const { bytes, file } = await pdfFile()
  const draft = await run(() => workflow.prepareInvoiceWaiver(preparation(), file))
  const signed = await run(() => workflow.finalizeInvoiceWaiver(INVOICE, draft.id, true, false))
  return { bytes, file, draft, signed }
}

// ---------------------------------------------------------------------------
// Preparing
// ---------------------------------------------------------------------------

test("an uploaded waiver is kept byte for byte as an unshared draft, and a retry returns it", async () => {
  setup()
  const { bytes, file } = await pdfFile()
  const input = preparation()

  const draft = await run(() => workflow.prepareInvoiceWaiver(input, file))
  assert.equal(draft.metadata.workflow.lifecycle, "draft")
  assert.equal(draft.metadata.workflow.shared, false)
  assert.deepEqual(objects().get(draft.metadata.workflow.document_path), bytes)

  const retry = await run(() => workflow.prepareInvoiceWaiver(input, file))
  assert.equal(retry.id, draft.id)
  assert.equal(world.service.db.invoice_lien_waivers.length, 1)
})

test("only US-dollar invoices can be waived, in either case, and nothing is filed for the rest", async () => {
  const { file } = await pdfFile()
  for (const currency of ["usd", "USD"]) {
    setup({ invoice: { currency } })
    await run(() => workflow.prepareInvoiceWaiver(preparation(), file))
  }
  for (const currency of ["eur", null, ""]) {
    setup({ invoice: { currency } })
    await assert.rejects(run(() => workflow.prepareInvoiceWaiver(preparation(), file)), /supports USD/)
    assert.equal(objects().size, 0, String(currency))
  }
})

test("a waiver cannot be prepared without invoice write access, and nothing is stored", async () => {
  setup({ permissions: ["invoice.read", "project.read"] })
  const { file } = await pdfFile()
  await assert.rejects(run(() => workflow.prepareInvoiceWaiver(preparation(), file)), /Missing permission: invoice.write/)
  assert.equal(objects().size, 0)
  assert.deepEqual(world.service.writes("invoice_lien_waivers"), [])
})

test("a waiver action that sends needs invoice send access, not just write access", async () => {
  setup({ permissions: ["invoice.read", "invoice.write", "project.read"] })
  await assert.rejects(run(() => workflow.invoiceWaiverContext(INVOICE, "invoice.send")), /Missing permission: invoice.send/)
  world.service.grant(WRITER)
  const context = await run(() => workflow.invoiceWaiverContext(INVOICE, "invoice.send"))
  assert.equal(context.invoice.id, INVOICE)
})

test("a corrected draft voids the one it replaces and reuses the original upload", async () => {
  setup()
  const { bytes, file } = await pdfFile()
  const stale = await run(() => workflow.prepareInvoiceWaiver(preparation(), file))
  const corrected = await run(() =>
    workflow.prepareInvoiceWaiver(preparation({ replaces_draft_id: stale.id, signer_title: "Company President" })),
  )
  assert.equal(waiverRow(stale.id).status, "void")
  assert.deepEqual(objects().get(corrected.metadata.workflow.document_path), bytes)
})

test("a waiver is only found through its own invoice", async () => {
  setup()
  const { draft } = await signedUpload()
  await assert.rejects(run(() => workflow.getInvoiceWaiverRecord(OTHER_INVOICE, draft.id)), /Invoice not found/)
})

// ---------------------------------------------------------------------------
// Signing and recording
// ---------------------------------------------------------------------------

test("recording an uploaded waiver needs consent, and records the uploader without calling them the signer", async () => {
  setup()
  const { bytes, file } = await pdfFile()
  const draft = await run(() => workflow.prepareInvoiceWaiver(preparation(), file))
  await assert.rejects(run(() => workflow.finalizeInvoiceWaiver(INVOICE, draft.id, false, true)), /Confirm/)

  const signed = await run(() => workflow.finalizeInvoiceWaiver(INVOICE, draft.id, true, false))
  const flow = signed.metadata.workflow
  assert.equal(flow.lifecycle, "signed")
  assert.equal(flow.signed_by, undefined)
  assert.equal(flow.recorded_by, world.service.userId)
  assert.equal(flow.signed_at.slice(0, 10), "2026-09-01")
  assert.equal(flow.document_path, draft.metadata.workflow.document_path)
  assert.deepEqual(objects().get(flow.document_path), bytes)

  const retry = await run(() => workflow.finalizeInvoiceWaiver(INVOICE, draft.id, true, true))
  assert.equal(retry.metadata.workflow.shared, false, "a retry cannot change who sees it")
})

test("a draft prepared before the invoice changed cannot be signed", async () => {
  setup()
  const { file } = await pdfFile()
  const draft = await run(() => workflow.prepareInvoiceWaiver(preparation(), file))
  world.service.db.invoices[0].updated_at = "2026-09-02T00:00:00+00:00"
  await assert.rejects(run(() => workflow.finalizeInvoiceWaiver(INVOICE, draft.id, true, true)), /invoice changed/)
})

test("a signed waiver can be shared", async () => {
  setup()
  const { draft } = await signedUpload()
  const shared = await run(() => workflow.updateInvoiceWaiverSharing(INVOICE, draft.id, true))
  assert.equal(shared.metadata.workflow.shared, true)
})

// ---------------------------------------------------------------------------
// Releasing against funds
// ---------------------------------------------------------------------------

test("a waiver is released only against payments that still cover it", async () => {
  setup()
  const { bytes, draft, signed } = await signedUpload()
  const paymentId = randomUUID()
  const match = (ids) => run(() => workflow.matchInvoiceWaiverPayment(INVOICE, draft.id, ids, true))

  world.payments = [{ id: paymentId, amount_cents: 20000, status: "succeeded" }]
  await assert.rejects(match(paymentId), /no longer covers/, "short payment")

  world.payments = [{ id: paymentId, amount_cents: 30000, status: "succeeded" }]
  world.reversals = [{ payment_id: paymentId, amount_cents: 10000, status: "pending" }]
  await assert.rejects(match(paymentId), /no longer covers/, "a pending return reduces what the payment covers")

  world.reversals = []
  const released = await match(paymentId)
  assert.equal(released.status, "released")
  assert.equal(released.metadata.workflow.sha256, signed.metadata.workflow.sha256)
  assert.deepEqual(objects().get(released.metadata.workflow.document_path), bytes)
})

test("two payments together can cover a waiver, but one payment listed twice cannot", async () => {
  setup()
  const { draft } = await signedUpload()
  const [first, second] = [randomUUID(), randomUUID()]
  world.payments = [
    { id: first, amount_cents: 10000, status: "succeeded" },
    { id: second, amount_cents: 15000, status: "succeeded" },
  ]
  const match = (ids) => run(() => workflow.matchInvoiceWaiverPayment(INVOICE, draft.id, ids, true))

  await assert.rejects(match([first, first]), /no longer covers/)
  const split = await match([first, second])
  assert.deepEqual(split.metadata.workflow.payment_ids, [first, second])
})

// ---------------------------------------------------------------------------
// Company templates
// ---------------------------------------------------------------------------

test("company templates need an org admin, and a revision keeps the original version", async () => {
  setup()
  const { file } = await pdfFile("COMPANY TEMPLATE")
  await assert.rejects(
    run(() => workflow.saveInvoiceWaiverTemplate(INVOICE, companyTemplate(), file)),
    /Missing permission: org.admin/,
  )

  world.service.grant([...WRITER, "org.admin"])
  const [first] = await run(() => workflow.saveInvoiceWaiverTemplate(INVOICE, companyTemplate(), file))
  assert.equal(first.version, 1)
  const revised = await run(() =>
    workflow.saveInvoiceWaiverTemplate(INVOICE, companyTemplate({ family_id: first.family_id }), file),
  )
  assert.deepEqual(
    revised.map((template) => template.version),
    [2],
  )
  assert.equal(world.service.db.files.filter((row) => row.metadata.waiver_template).length, 2)
})

test("signing a template waiver in Arc files a new signed document and audits the consent", async () => {
  setup()
  world.service.grant([...WRITER, "org.admin"])
  const { file } = await pdfFile("COMPANY TEMPLATE")
  const [template] = await run(() => workflow.saveInvoiceWaiverTemplate(INVOICE, companyTemplate(), file))

  const draft = await run(() =>
    workflow.prepareInvoiceWaiver(preparation({ source: "template", template_id: template.id, signed_date: undefined })),
  )
  const executed = await run(() => workflow.finalizeInvoiceWaiver(INVOICE, draft.id, true, false))

  assert.equal(executed.metadata.workflow.signed_by, world.service.userId)
  assert.notEqual(executed.metadata.workflow.document_path, draft.metadata.workflow.document_path)
  assert.notEqual(executed.metadata.workflow.sha256, draft.metadata.workflow.sha256)
  const signedFile = objects().get(executed.metadata.workflow.document_path)
  assert.equal(createHash("sha256").update(signedFile).digest("hex"), executed.metadata.workflow.sha256)
  assert.ok(world.service.audits.some((audit) => audit.after?.sha256 && audit.after?.consent))
})

test("native signing opens one signing document per waiver and does not share it early", async () => {
  setup()
  world.service.grant([...WRITER, "org.admin"])
  const { file } = await pdfFile("COMPANY TEMPLATE")
  const [template] = await run(() => workflow.saveInvoiceWaiverTemplate(INVOICE, companyTemplate(), file))
  const draft = await run(() =>
    workflow.prepareInvoiceWaiver(preparation({ source: "template", template_id: template.id, signed_date: undefined })),
  )

  const first = await run(() => workflow.startInvoiceWaiverSigning(INVOICE, draft.id, true))
  const again = await run(() => workflow.startInvoiceWaiverSigning(INVOICE, draft.id, true))

  assert.equal(again.documentId, first.documentId)
  assert.equal(world.documents.length, 1)
  assert.equal(world.documents[0].source_entity_id, draft.id)
  assert.equal(world.documents[0].source_file_id, draft.metadata.workflow.file_id)
  assert.deepEqual(
    world.fields.map((field) => field.field_type),
    ["signature", "date"],
  )
  assert.equal(first.waiver.metadata.workflow.shared, false)
  assert.equal(first.waiver.metadata.workflow.sharing_requested, true)
})

// ---------------------------------------------------------------------------
// Physical signing
// ---------------------------------------------------------------------------

test("an executed paper waiver is filed unmodified, confirmed by the uploader, and delivered once", async () => {
  setup()
  world.service.grant([...WRITER, "org.admin"])
  const template = await pdfFile("COMPANY TEMPLATE")
  const [saved] = await run(() => workflow.saveInvoiceWaiverTemplate(INVOICE, companyTemplate(), template.file))
  const physical = await run(() =>
    workflow.prepareInvoiceWaiver(
      preparation({ source: "template", template_id: saved.id, signed_date: undefined, execution_method: "physical" }),
    ),
  )
  world.service.db.invoices[0].metadata = {
    waiver_packet: { enabled: true, waiver_id: physical.id, delivery_mode: "after_physical_execution" },
  }
  const { bytes, file } = await pdfFile("EXECUTED SCAN")
  const upload = (candidate, confirmed) =>
    run(() => workflow.uploadExecutedInvoiceWaiver(INVOICE, physical.id, candidate, confirmed))

  await assert.rejects(upload(file, false), /Confirm/)
  await assert.rejects(upload({ size: 3, arrayBuffer: async () => Buffer.from("bad") }, true))
  assert.equal(world.autoSends.length, 0)

  const uploaded = await upload(file, true)
  assert.equal(uploaded.metadata.workflow.lifecycle, "signed")
  assert.equal(uploaded.metadata.physical_execution.original_file_id, physical.metadata.workflow.file_id)
  assert.equal(uploaded.metadata.physical_execution.confirmed_by, world.service.userId)
  assert.deepEqual(objects().get(uploaded.metadata.workflow.document_path), bytes)
  assert.equal(world.autoSends.length, 1)

  const stored = objects().size
  await upload(file, true)
  assert.equal(objects().size, stored, "a delivery retry does not replace the executed PDF")
})
