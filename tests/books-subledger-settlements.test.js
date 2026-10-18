require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const { database } = require("./helpers/report-database")
const { accountingCutoff, loadSubledgerSettlements } = require("../lib/services/books/subledger-settlements")

test("accounting cutoff validates dates and rolls over UTC years", () => {
  assert.equal(accountingCutoff("2026-12-31"), "2027-01-01T00:00:00.000Z")
  assert.throws(() => accountingCutoff("2026-02-30"), /Invalid accounting date/)
  assert.throws(() => accountingCutoff("09/30/2026"), /Invalid accounting date/)
})

for (const side of ["receivable", "payable"]) test(`${side} settlement reconstruction uses dates, deduplicates payment paths, and exhausts pages`, async () => {
  const key = side === "receivable" ? "invoice_id" : "bill_id"
  const paid = { org_id: "org", status: "refunded", received_at: "2026-09-01T00:00:00Z" }
  const allocations = Array.from({ length: 1201 }, (_, i) => ({ id: String(i).padStart(5, "0"), org_id: "org", payment_id: `p-${i}`, [key]: "document", amount_cents: 100, payment: paid }))
  const db = database({
    payment_allocations: allocations,
    payments: [
      { ...paid, id: "p-0", [key]: "document", amount_cents: 100 },
      { ...paid, id: "direct", [key]: "document", amount_cents: 200 },
      { ...paid, id: "late", [key]: "document", amount_cents: 999, received_at: "2026-10-01T00:00:00Z" },
      { ...paid, id: "pending", [key]: "document", amount_cents: 999, status: "pending" },
      { ...paid, id: "other-org", org_id: "other", [key]: "document", amount_cents: 999 },
    ],
    payment_reversals: [
      { id: "r1", org_id: "org", [key]: "document", amount_cents: 50, status: "succeeded", occurred_at: "2026-09-30T23:59:59Z" },
      { id: "r2", org_id: "org", [key]: "document", amount_cents: 999, status: "pending", occurred_at: "2026-09-30T23:59:59Z" },
      { id: "r3", org_id: "org", [key]: "document", amount_cents: 999, status: "succeeded", occurred_at: "2026-10-01T00:00:00Z" },
    ],
    receivable_adjustments: [
      { id: "a1", org_id: "org", invoice_id: "document", amount_cents: 100, status: "posted", effective_date: "2026-09-30" },
      { id: "a2", org_id: "org", invoice_id: "document", amount_cents: 200, status: "void", effective_date: "2026-09-30", voided_at: "2026-10-01T00:00:00Z" },
      { id: "a3", org_id: "org", invoice_id: "document", amount_cents: 999, status: "void", effective_date: "2026-09-30", voided_at: "2026-09-30T00:00:00Z" },
    ],
  })
  const balances = await loadSubledgerSettlements(db, "org", side, ["document"], "2026-09-30")
  assert.equal(balances.get("document"), 120250 + (side === "receivable" ? 300 : 0))
})
