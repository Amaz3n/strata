require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const { receivableRetainageAsOf, payableRetainageAsOf } = require("../lib/services/books/retainage-history")

test("receivable retainage follows billing and release dates rather than current hold status", () => {
  const invoice = { status: "paid", issue_date: "2026-09-01" }
  const release = { status: "paid", issue_date: "2026-10-01" }
  const rows = [{ amount_cents: 1000, invoice, release }, { amount_cents: 500, invoice: { ...invoice, status: "draft" }, release: null }]
  assert.equal(receivableRetainageAsOf(rows, "2026-09-30"), 1000)
  assert.equal(receivableRetainageAsOf(rows, "2026-10-31"), 0)
  release.status = "void"
  release.metadata = { voided_at: "2026-11-01T00:00:00Z" }
  assert.equal(receivableRetainageAsOf(rows, "2026-10-31"), 0)
  assert.equal(receivableRetainageAsOf(rows, "2026-11-30"), 1000)
})

test("payable retainage releases affect only their accounting period and preserve over-release discrepancies", () => {
  const rows = [
    { status: "paid", bill_date: "2026-09-01", total_cents: 10000, retainage_cents: 1000 },
    { status: "paid", bill_date: "2026-10-01", total_cents: 1200, retainage_cents: 0, metadata: { source: "retainage_release" } },
  ]
  assert.equal(payableRetainageAsOf(rows, "2026-09-30"), 1000)
  assert.equal(payableRetainageAsOf(rows, "2026-10-31"), -200)
})
