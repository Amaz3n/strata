require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const vm = require("node:vm")
const ts = require("typescript")
const { invoiceFileError, INVOICE_MAX_BYTES } = require("../lib/payables/intake")

function harness(extract, overrides = {}, timers = {}) {
  let row = { id: "bill", org_id: "org", updated_at: "v0", status: "pending", total_cents: 0,
    metadata: { creation_state: "draft", intake: { actor_id: "actor", name: "bill.pdf", stage: "queued" } }, ...overrides }
  let revision = 0
  let writes = 0
  const db = { from(table) {
    assert.equal(table, "vendor_bills")
    let patch; const filters = []
    const query = {
      select() { return query }, update(value) { patch = structuredClone(value); return query },
      eq(key, value) { filters.push([key, value]); return query },
      maybeSingle() { return query },
      then(resolve, reject) {
        return Promise.resolve().then(() => {
          const matched = filters.every(([key, value]) => (key === "metadata->>creation_state" ? row.metadata.creation_state : row[key]) === value)
          if (!matched) return { data: null, error: null }
          if (patch) { row = { ...row, ...patch, updated_at: `v${++revision}` }; writes++ }
          return { data: structuredClone(row), error: null }
        }).then(resolve, reject)
      },
    }
    return query
  } }
  const testModule = { exports: {} }
  const stubs = {
    "server-only": {},
    "@/lib/payables/intake": require("../lib/payables/intake"),
    "@/lib/services/payable-file-duplicates": { payableFileDuplicateWarning: async () => null }, "@/lib/supabase/server": { createServiceSupabaseClient: () => db },
    "@/lib/services/document-extraction": { extractPayableInvoiceFromFile: (_, options) => extract(options, {
      edit: patch => { row = { ...row, ...patch, updated_at: `v${++revision}` } },
    }) },
    "@/lib/services/file-links": { attachFileWithServiceRole: async () => {} },
    "@/lib/storage/files-storage": {}, "@/lib/services/audit": { recordAudit: async () => {} },
  }
  vm.runInNewContext(ts.transpileModule(fs.readFileSync("lib/services/payable-intake.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module: testModule, exports: testModule.exports, require: name => {
    if (!(name in stubs)) throw new Error(`Unexpected dependency ${name}`)
    return stubs[name]
  }, Date, JSON, Error, console, setTimeout: timers.setTimeout ?? setTimeout, clearTimeout })
  return { view: bill => testModule.exports.intakeRow(bill), run: () => testModule.exports.processPayableIntake("bill", "org", {}), row: () => row, writes: () => writes }
}
const invoice = { billable: true, vendorName: "Vendor", vendorId: null, billNumber: "INV-1", totalDollars: 125,
  billDate: "2026-09-07", dueDate: null, lines: [{ description: "Work", amountCents: 12500 }], notes: [], model: "test" }

test("rejects empty, unsupported and oversized uploads before scanning", () => {
  assert.match(invoiceFileError({ size: 0, type: "application/pdf" }), /empty/)
  assert.match(invoiceFileError({ size: INVOICE_MAX_BYTES + 1, type: "application/pdf" }), /20 MB/)
  assert.match(invoiceFileError({ size: 10, type: "text/html" }), /Choose a PDF/)
  assert.equal(invoiceFileError({ size: INVOICE_MAX_BYTES, type: "application/pdf" }), null)
})
test("streamed values remain provisional, and final extraction stays a draft", async () => {
  const h = harness(async options => {
    await options.onPartial({ vendor_name: "Vendor", total: 100 })
    assert.equal(h.row().total_cents, 0)
    assert.equal(h.row().metadata.intake.preview.amount, 10000)
    return invoice
  })
  await h.run()
  assert.equal(h.row().total_cents, 12500)
  assert.equal(h.row().metadata.creation_state, "draft")
  assert.equal(h.row().status, "pending")
  assert.equal(h.row().metadata.intake.stage, "ready")
  const writes = h.writes()
  await h.run()
  assert.equal(h.writes(), writes, "outbox redelivery must not reapply extraction")
})
test("late extraction cannot overwrite a human edit", async () => {
  const h = harness(async (_, { edit }) => { edit({ total_cents: 9900 }); return invoice })
  await h.run()
  assert.equal(h.row().total_cents, 9900)
  assert.equal(h.row().metadata.intake.stage, "failed")
  assert.match(h.row().metadata.intake.error, /edits were kept/)
})
test("failed scans and non-invoices leave an editable draft", async () => {
  for (const extract of [async () => { throw new Error("Provider unavailable") }, async () => ({ ...invoice, billable: false })]) {
    const h = harness(extract)
    await h.run()
    assert.equal(h.row().metadata.intake.stage, "failed")
    assert.equal(h.row().metadata.creation_state, "draft")
    assert.equal(h.row().total_cents, 0)
  }
})
test("an active lease prevents duplicate model calls", async () => {
  let called = false
  const h = harness(async () => { called = true; return invoice }, { metadata: { creation_state: "draft", intake: {
    stage: "reading", lease_until: new Date(Date.now() + 60000).toISOString(),
  } } })
  await assert.rejects(h.run(), /already running/)
  assert.equal(called, false)
})
test("expired leases recover without creating another payable", async () => {
  const h = harness(async () => invoice, { metadata: { creation_state: "draft", intake: {
    stage: "reading", lease_until: new Date(Date.now() - 1000).toISOString(),
  } } })
  await h.run()
  assert.equal(h.row().id, "bill")
  assert.equal(h.row().metadata.intake.stage, "ready")
})

test("expired scans display an actionable failure instead of an endless reading status", () => {
  const h = harness(async () => invoice)
  const row = h.view({ id: "bill", total_cents: 0, metadata: { intake: { name: "bill.pdf", stage: "reading", lease_until: new Date(Date.now() - 1000).toISOString() } } })
  assert.equal(row.stage, "failed")
  assert.match(row.error, /timed out/)
})

test("a stalled extraction fails within its overall deadline and ignores late streaming updates", async () => {
  let partial
  const h = harness(async options => { partial = options.onPartial; return new Promise(() => {}) }, {}, {
    setTimeout: callback => setTimeout(callback, 1),
  })
  await h.run()
  assert.equal(h.row().metadata.intake.stage, "failed")
  assert.match(h.row().metadata.intake.error, /timed out/)
  const writes = h.writes()
  await partial({ vendor_name: "Late vendor", total: 55 })
  assert.equal(h.writes(), writes)
})
