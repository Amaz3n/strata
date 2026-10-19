"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")

require("../scripts/register-ts-node-test")
const { buildApprovedCostInvoiceIdempotencyKey } = require("@/lib/financials/approved-cost-rules")

test("the approved-cost invoice idempotency key ignores cost order but not the invoice's facts", () => {
  const preview = { lines: [], totals: { cost_cents: 12000, markup_cents: 2400, billable_cents: 14400 } }
  const base = {
    orgId: "org-1",
    projectId: "project-1",
    invoiceNumber: "INV-100",
    costIds: ["cost-2", "cost-1"],
    preview,
    reservationId: "reservation-1",
  }
  const key = buildApprovedCostInvoiceIdempotencyKey(base)

  assert.match(key, /^approved_cost_invoice:[a-f0-9]{48}$/)
  assert.equal(buildApprovedCostInvoiceIdempotencyKey({ ...base, costIds: ["cost-1", "cost-2"] }), key)
  for (const change of [
    { preview: { ...preview, totals: { ...preview.totals, billable_cents: 14500 } } },
    { reservationId: "reservation-2" },
    { costIds: ["cost-1"] },
  ]) {
    assert.notEqual(buildApprovedCostInvoiceIdempotencyKey({ ...base, ...change }), key, JSON.stringify(change))
  }
})
