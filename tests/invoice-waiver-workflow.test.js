require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const { PDFDocument } = require("pdf-lib")
const { prepareWaiverSchema, templateInputSchema, isWaiverPublic, availableWaiverPayments, waiverThroughDate, preferredWaiverTemplate } = require("../lib/lien-waivers/invoice-waiver")
const { inspectWaiverPdf, renderCustomInvoiceWaiver } = require("../lib/pdfs/invoice-waiver-document")
const { normalizeWaiverSuggestions } = require("../lib/lien-waivers/waiver-extraction")

const input = {
  request_id: randomUUID(), invoice_id: randomUUID(), source: "arc", waiver_type: "conditional_progress",
  amount_cents: 2500000, through_date: "2026-08-31", claimant_name: "Example Builder LLC", customer_name: "Example Customer",
  owner_name: "Example Owner", property_description: "100 Example Lane, Lot 12", jurisdiction: "CA", exceptions: "",
  signer_name: "Alex Example", signer_title: "President", final_confirmed: false, received_confirmed: false,
}

test("due date is never used as covered work; billing period takes precedence", () => {
  assert.equal(waiverThroughDate({ due_date: "2026-09-30", issue_date: "2026-09-01" }), "")
  assert.equal(waiverThroughDate({ metadata: { billing_period_end: "2026-08-30" } }, "2026-08-31"), "2026-08-31")
})
test("rejects zero money, impossible dates, and undocumented final/unconditional releases", () => {
  assert.equal(prepareWaiverSchema.safeParse(input).success, true)
  for (const change of [{ amount_cents: 0 }, { through_date: "2026-02-30" }, { waiver_type: "conditional_final" }, { waiver_type: "unconditional_progress" }, { source: "upload" }]) {
    assert.equal(prepareWaiverSchema.safeParse({ ...input, ...change }).success, false, JSON.stringify(change))
  }
  assert.equal(prepareWaiverSchema.safeParse({ ...input, waiver_type: "unconditional_final", final_confirmed: true, received_confirmed: true, payment_id: randomUUID() }).success, true)
})
test("portal requires signed, explicitly shared workflows even if invoice payment marks a draft released", () => {
  const waiver = { waiver_type: "conditional_progress", status: "released" }
  assert.equal(isWaiverPublic(waiver), true, "legacy documents remain accessible")
  for (const [lifecycle, shared, expected] of [["draft", true, false], ["signed", false, false], ["signed", true, true]]) {
    assert.equal(isWaiverPublic({ ...waiver, metadata: { workflow: { version: 2, lifecycle, shared } } }), expected)
  }
  assert.equal(isWaiverPublic({ ...waiver, status: "void" }), false)
  assert.equal(isWaiverPublic({ ...waiver, metadata: { workflow: { version: 3, lifecycle: "draft" } } }), false)
  assert.equal(isWaiverPublic({ waiver_type: "unconditional_progress", status: "pending_payment" }), false)
})
test("payment matching subtracts returns and pending disputes, ignores failed/reversed returns and duplicate payment rows", () => {
  const payment = { id: "one", amount_cents: 25000, status: "succeeded" }
  const reversals = [
    { payment_id: "one", amount_cents: 4000, status: "pending" },
    { payment_id: "one", amount_cents: 3000, status: "succeeded" },
    { payment_id: "one", amount_cents: 9000, status: "failed" },
    { payment_id: "one", amount_cents: 9000, status: "reversed" },
  ]
  assert.equal(availableWaiverPayments([payment, payment], reversals).length, 1)
  assert.equal(availableWaiverPayments([payment], reversals)[0].available_cents, 18000)
  assert.equal(availableWaiverPayments([{ ...payment, status: "processing" }], []).length, 0)
})
test("project defaults override company defaults only for the matching waiver type", () => {
  const base = { preferred: true, waiver_type: "conditional_progress", created_at: "2026-09-01" }
  const company = { ...base, id: "company", project_id: null }
  const project = { ...base, id: "project", project_id: "p", created_at: "2026-08-01" }
  assert.equal(preferredWaiverTemplate([company, project], "conditional_progress").id, "project")
  assert.equal(preferredWaiverTemplate([company, project], "conditional_final"), undefined)
})
test("templates require signature/date positions and bounded fields", () => {
  const field = { id: "sig", key: "signer_name", page: 0, x: 0.1, y: 0.5, width: 0.4, height: 0.04 }
  const base = { name: "Company form", scope: "company", preferred: true, waiver_type: "conditional_progress" }
  assert.equal(templateInputSchema.safeParse({ ...base, fields: [field] }).success, false)
  assert.equal(templateInputSchema.safeParse({ ...base, fields: [field, { ...field, id: "date", key: "signed_date", y: 0.6 }] }).success, true)
  assert.equal(templateInputSchema.safeParse({ ...base, fields: [{ ...field, x: 0.9 }] }).success, false)
})
test("document suggestions preserve dollar units, reject guessed dates, and cannot approve or share", () => {
  const raw = { is_waiver: true, amount_dollars: 1234.56, through_date: "2026-02-30", signed_date: "2026-08-31",
    signer_name: "  Printed Signer  ", waiver_type: "unconditional_final", shared: true, received_confirmed: true, final_confirmed: true }
  const suggested = normalizeWaiverSuggestions(raw)
  assert.equal(suggested.amount_cents, 123456)
  assert.equal(suggested.through_date, undefined)
  assert.equal(suggested.signed_date, "2026-08-31")
  assert.equal(suggested.signer_name, "Printed Signer")
  assert.equal(suggested.received_confirmed, undefined)
  assert.equal(suggested.final_confirmed, undefined)
  assert.equal(suggested.shared, undefined)
  assert.deepEqual(normalizeWaiverSuggestions({ ...raw, is_waiver: false }), {})
})
test("custom form rendering preserves the source, produces readable output and refuses clipped values", async () => {
  const source = await PDFDocument.create(); source.addPage([612, 792]).drawText("COMPANY APPROVED WAIVER", { x: 60, y: 730, size: 14 })
  const bytes = await source.save(); const original = Buffer.from(bytes)
  const fields = [{ id: "a", key: "amount", page: 0, x: 0.1, y: 0.3, width: 0.4, height: 0.04 },
    { id: "s", key: "signer_name", page: 0, x: 0.1, y: 0.5, width: 0.4, height: 0.04 },
    { id: "d", key: "signed_date", page: 0, x: 0.1, y: 0.6, width: 0.4, height: 0.04 }]
  const preview = await renderCustomInvoiceWaiver(bytes, fields, input, "INV-1")
  const signed = await renderCustomInvoiceWaiver(bytes, fields, input, "INV-1", "2026-09-07T12:00:00Z")
  assert.deepEqual(Buffer.from(bytes), original)
  assert.notDeepEqual(preview, signed)
  assert.equal((await PDFDocument.load(signed)).getPageCount(), 1)
  await assert.rejects(renderCustomInvoiceWaiver(bytes, [{ ...fields[0], width: 0.001 }], input, "INV-1"), /too small/)
  await assert.rejects(renderCustomInvoiceWaiver(bytes, fields, { ...input, exceptions: "Retainage" }, "INV-1"), /exceptions field/)
  await assert.rejects(inspectWaiverPdf(Buffer.from("not a pdf")), /valid PDF/)
})
