require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const Module = require("node:module")
const { randomUUID } = require("node:crypto")
const { PDFDocument } = require("pdf-lib")

test("waiver service preserves uploaded bytes, isolates scope, signs deliberately, and matches real funds", async () => {
  const orgId = randomUUID(), userId = randomUUID(), invoiceId = randomUUID(), projectId = randomUUID()
  const db = { invoices: [{ id: invoiceId, org_id: orgId, project_id: projectId, invoice_number: "QA-1", status: "sent", currency: "usd", total_cents: 50000, balance_due_cents: 50000, updated_at: "2026-09-01" }], invoice_lien_waivers: [], files: [] }
  const objects = new Map(), audits = [], permissions = []
  let allowed = true, admin = false, payments = [], reversals = []
  const value = (row, key) => key.split(/->>?/).reduce((r, k) => r?.[k], row)
  function query(table) {
    let filters = [], operation = null, single = false
    const q = {
      select: () => q, eq: (key, expected) => { filters.push((r) => key === "metadata" ? JSON.stringify(r[key]) === expected : value(r, key) === expected); return q },
      neq: (key, expected) => { filters.push((r) => value(r, key) !== expected); return q },
      is: (key, expected) => { filters.push((r) => (value(r, key) ?? null) === expected); return q },
      or: () => q, order: () => q, limit: () => q,
      insert: (row) => { operation = { kind: "insert", row }; return q },
      update: (row) => { operation = { kind: "update", row }; return q },
      single: () => { single = true; return q }, maybeSingle: () => { single = true; return q },
      then: (resolve, reject) => Promise.resolve().then(() => {
        let rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)))
        if (operation?.kind === "insert") {
          const row = { created_at: new Date().toISOString(), ...structuredClone(operation.row) }
          if (db[table].some((r) => r.id === row.id)) return { data: null, error: { code: "23505" } }
          db[table].push(row); rows = [row]
        }
        if (operation?.kind === "update") rows.forEach((r) => Object.assign(r, structuredClone(operation.row)))
        return { data: structuredClone(single ? rows[0] ?? null : rows), error: null }
      }).then(resolve, reject),
    }
    return q
  }
  const supabase = { from: query }
  const stubs = {
    "@/lib/services/context": { requireOrgContext: async () => ({ orgId, userId, supabase }) },
    "@/lib/services/authorization": { requireAuthorization: async (request) => { permissions.push(request); if (!allowed || request.permission === "org.admin" && !admin) throw new Error("Not authorized") }, authorize: async () => ({ allowed: admin }) },
    "@/lib/services/payments": { getInvoicePaymentActivity: async () => ({ payments, reversals }) },
    "@/lib/services/audit": { recordAudit: async (entry) => audits.push(entry) },
    "@/lib/storage/files-storage": { downloadFilesObject: async ({ path }) => { assert.ok(objects.has(path)); return objects.get(path) } },
    "@/lib/services/generated-documents": { storeGeneratedPdf: async (input) => {
      const fileId = randomUUID(), storagePath = `${input.orgId}/${fileId}.pdf`
      objects.set(storagePath, Buffer.from(input.pdf))
      db.files.unshift({ id: fileId, org_id: orgId, project_id: input.projectId, storage_path: storagePath, folder_path: input.folderPath, metadata: input.metadata ?? {}, archived_at: null, created_at: new Date().toISOString() })
      return { fileId, storagePath }
    } },
  }
  const originalLoad = Module._load
  Module._load = function (request, ...args) { return stubs[request] ?? originalLoad.call(this, request, ...args) }
  let service
  try { service = require("../lib/services/invoice-waiver-workflow") } finally { Module._load = originalLoad }
  const pdf = await PDFDocument.create(); pdf.addPage().drawText("SIGNED OUTSIDE ARC - ORIGINAL BYTES")
  const bytes = Buffer.from(await pdf.save())
  const file = { size: bytes.length, arrayBuffer: async () => bytes }
  const input = { request_id: randomUUID(), invoice_id: invoiceId, source: "upload", waiver_type: "conditional_progress", amount_cents: 25000,
    through_date: "2026-08-31", claimant_name: "Builder LLC", customer_name: "Customer LLC", owner_name: "Owner LLC",
    property_description: "100 Example Lane, Lot 1", jurisdiction: "FL", signer_name: "External Signer", signer_title: "President", signed_date: "2026-09-01" }
  const draft = await service.prepareInvoiceWaiver(input, file)
  assert.equal(draft.metadata.workflow.lifecycle, "draft")
  assert.equal(draft.metadata.workflow.shared, false)
  assert.deepEqual(objects.get(draft.metadata.workflow.document_path), bytes)
  // Stored lowercase USD and uppercase ISO codes must both reach preparation.
  db.invoices[0].currency = "USD"
  const retry = await service.prepareInvoiceWaiver(input, file)
  assert.equal(retry.id, draft.id); assert.equal(db.invoice_lien_waivers.length, 1)
  const storedBeforeCurrencyCheck = objects.size
  for (const currency of ["eur", null, ""]) {
    db.invoices[0].currency = currency
    await assert.rejects(service.prepareInvoiceWaiver({ ...input, request_id: randomUUID() }, file), /supports USD/)
  }
  assert.equal(objects.size, storedBeforeCurrencyCheck, "unsupported currency must not create a PDF")
  db.invoices[0].currency = "usd"
  await assert.rejects(service.finalizeInvoiceWaiver(invoiceId, draft.id, false, true), /Confirm/)
  const signed = await service.finalizeInvoiceWaiver(invoiceId, draft.id, true, false)
  assert.equal(signed.metadata.workflow.lifecycle, "signed")
  assert.equal(signed.metadata.workflow.signed_by, undefined, "uploader is not the signer")
  assert.equal(signed.metadata.workflow.recorded_by, userId)
  assert.equal(signed.metadata.workflow.signed_at.slice(0, 10), "2026-09-01")
  assert.equal(signed.metadata.workflow.document_path, draft.metadata.workflow.document_path)
  assert.deepEqual(objects.get(signed.metadata.workflow.document_path), bytes)
  assert.equal((await service.finalizeInvoiceWaiver(invoiceId, draft.id, true, true)).metadata.workflow.shared, false, "retry cannot change delivery")
  const shared = await service.updateInvoiceWaiverSharing(invoiceId, draft.id, true)
  assert.equal(shared.metadata.workflow.shared, true)
  const paymentId = randomUUID()
  payments = [{ id: paymentId, amount_cents: 20000, status: "succeeded" }]
  await assert.rejects(service.matchInvoiceWaiverPayment(invoiceId, draft.id, paymentId, true), /no longer covers/)
  payments[0].amount_cents = 30000
  reversals = [{ payment_id: paymentId, amount_cents: 10000, status: "pending" }]
  await assert.rejects(service.matchInvoiceWaiverPayment(invoiceId, draft.id, paymentId, true), /no longer covers/)
  reversals = []
  const matched = await service.matchInvoiceWaiverPayment(invoiceId, draft.id, paymentId, true)
  assert.equal(matched.status, "released")
  assert.equal(matched.metadata.workflow.sha256, signed.metadata.workflow.sha256)
  assert.deepEqual(objects.get(matched.metadata.workflow.document_path), bytes)
  const secondPaymentId = randomUUID()
  payments = [{ id: paymentId, amount_cents: 10000, status: "succeeded" }, { id: secondPaymentId, amount_cents: 15000, status: "succeeded" }]
  const splitMatched = await service.matchInvoiceWaiverPayment(invoiceId, draft.id, [paymentId, secondPaymentId], true)
  assert.deepEqual(splitMatched.metadata.workflow.payment_ids, [paymentId, secondPaymentId])
  await assert.rejects(service.matchInvoiceWaiverPayment(invoiceId, draft.id, [paymentId, paymentId], true), /no longer covers/, "duplicate payment IDs cannot inflate coverage")
  const stale = await service.prepareInvoiceWaiver({ ...input, request_id: randomUUID() }, file)
  const corrected = await service.prepareInvoiceWaiver({ ...input, request_id: randomUUID(), replaces_draft_id: stale.id, signer_title: "Company President" })
  assert.equal(db.invoice_lien_waivers.find((row) => row.id === stale.id).status, "void")
  assert.deepEqual(objects.get(corrected.metadata.workflow.document_path), bytes, "metadata corrections reuse the exact original upload")
  db.invoices[0].updated_at = "2026-09-02"
  await assert.rejects(service.finalizeInvoiceWaiver(invoiceId, corrected.id, true, true), /invoice changed/)
  const otherInvoice = randomUUID()
  await assert.rejects(service.getInvoiceWaiverRecord(otherInvoice, draft.id), /Invoice not found/)
  allowed = false
  const count = objects.size
  await assert.rejects(service.prepareInvoiceWaiver({ ...input, request_id: randomUUID() }, file), /Not authorized/)
  assert.equal(objects.size, count, "permission denial precedes storage")
  allowed = true
  const fields = [{ id: "signature", key: "signer_name", page: 0, x: .1, y: .5, width: .4, height: .05 }, { id: "date", key: "signed_date", page: 0, x: .1, y: .6, width: .4, height: .05 }]
  const template = { name: "Company progress", waiver_type: "conditional_progress", scope: "company", preferred: true, fields }
  await assert.rejects(service.saveInvoiceWaiverTemplate(invoiceId, template, file), /Not authorized/)
  admin = true
  const templates = await service.saveInvoiceWaiverTemplate(invoiceId, template, file)
  assert.equal(templates[0].version, 1)
  const revised = await service.saveInvoiceWaiverTemplate(invoiceId, { ...template, family_id: templates[0].family_id }, file)
  assert.equal(revised.length, 1); assert.equal(revised[0].version, 2)
  assert.equal(db.files.filter((f) => f.metadata.waiver_template).length, 2, "original template version retained")
  const custom = await service.prepareInvoiceWaiver({ ...input, request_id: randomUUID(), source: "template", template_id: revised[0].id }, undefined)
  const executed = await service.finalizeInvoiceWaiver(invoiceId, custom.id, true, false)
  assert.equal(executed.metadata.workflow.signed_by, userId)
  assert.notEqual(executed.metadata.workflow.document_path, custom.metadata.workflow.document_path)
  assert.notEqual(executed.metadata.workflow.sha256, custom.metadata.workflow.sha256)
  assert.ok(audits.some((a) => a.after.sha256 && a.after.consent))
  assert.ok(permissions.some((p) => p.projectId === projectId && p.permission === "invoice.write"))
})
