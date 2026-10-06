require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const { invoiceRevenueBasis, allocateInvoiceRevenue } = require("../lib/services/books/invoice-revenue-rules")
const { draftFromFact, hashableFactPayload } = require("../lib/services/books/fact-drafts")
const { postReceivableAdjustment } = require("../lib/services/books/posting-rules")
const common = { id: "00000000-0000-4000-8000-000000000001", date: "2026-09-30", memo: "Test", projectionVersion: 1, policyVersion: 1 }
const amounts = draft => Object.fromEntries(draft.lines.map(line => [line.accountCode, line.debitCents - line.creditCents]))
const income = [{ account_code: "4010", amount_cents: 8000, dimensions: { cost_code_id: "design" } }, { account_code: "4020", amount_cents: 2000 }]

test("standalone invoices earn selected income and tax while project billing stays deferred", () => {
  assert.equal(invoiceRevenueBasis(null), "on_invoice")
  assert.equal(invoiceRevenueBasis("project"), "percentage_of_completion")
  assert.equal(invoiceRevenueBasis("project", "closing"), "closing")
  const payload = { total_cents: 10700, tax_cents: 700, revenue_basis: invoiceRevenueBasis(null), revenue_lines: income }
  const draft = draftFromFact({ sourceType: "invoice", sourceId: common.id, accountingDate: common.date, sourceVersion: 1, projectionVersion: 1, policyVersion: 1, payload })
  assert.deepEqual(amounts(draft), { 1100: 10700, 4010: -8000, 4020: -2000, 2250: -700 })
  assert.deepEqual(draft.lines.find(line => line.accountCode === "4010").dimensions, { cost_code_id: "design" })
  assert.deepEqual(hashableFactPayload("invoice", payload).revenue_lines, income)
  assert.throws(() => draftFromFact({ sourceType: "invoice", sourceId: common.id, accountingDate: common.date, sourceVersion: 1, projectionVersion: 1, policyVersion: 1, payload: { ...payload, total_cents: 10800 } }), /allocations/)
})

test("partial credits reverse original accounts and tax; writeoffs preserve income", () => {
  const draft = postReceivableAdjustment({ ...common, amountCents: 5350, taxCents: 350, adjustmentType: "credit_memo", revenueBasis: "on_invoice", revenueLines: allocateInvoiceRevenue(5000, income) })
  assert.deepEqual(amounts(draft), { 4010: 4000, 4020: 1000, 2250: 350, 1100: -5350 })
  const writeoff = postReceivableAdjustment({ ...common, amountCents: 5350, adjustmentType: "write_off", revenueBasis: "on_invoice" })
  assert.equal(writeoff.lines.length, 2)
  assert.equal(writeoff.lines.some(line => line.accountCode === "4000"), false)
})

test("partial credit apportionment preserves every cent, signed discounts, and dimensions", () => {
  const lines = [{ account_code: "4010", amount_cents: 101, dimensions: { cost_code_id: "labor" } }, { account_code: "4020", amount_cents: 101 }, { account_code: "4090", amount_cents: -2 }]
  for (let amount = -200; amount <= 200; amount++) {
    const result = allocateInvoiceRevenue(amount, lines)
    assert.equal(result.reduce((sum, line) => sum + line.amount_cents, 0), amount)
    assert.deepEqual(result[0].dimensions, lines[0].dimensions)
  }
  assert.deepEqual(allocateInvoiceRevenue(100, lines).map(line => line.amount_cents), [51, 50, -1])
  assert.throws(() => allocateInvoiceRevenue(1, [{ account_code: "4010", amount_cents: 0 }]), /zero invoice/)
})
