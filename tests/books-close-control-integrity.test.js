require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const { requireLedgerTieOut, retainageCloseChecks } = require("../lib/services/books/close-control-rules")
const { closeReviewState } = require("../lib/services/books/close-review")

const result = (code, differenceCents = 0) => ({ code, label: code, status: differenceCents ? "failed" : "passed", ledgerCents: 10000, subledgerCents: 10000 - differenceCents, differenceCents })

test("either retainage discrepancy prevents close even when other controls pass", () => {
  for (const side of ["retainage_receivable_control", "retainage_payable_control"]) {
    const rows = ["retainage_receivable_control", "retainage_payable_control"].map(code => result(code, code === side ? 100 : 0))
    const checks = retainageCloseChecks(rows).map(row => ({ ...row, period_id: "period" }))
    const review = closeReviewState(checks, "period")
    assert.equal(review.ready, false)
    assert.deepEqual(review.blockers.map(row => row.code), [side])
    assert.equal(review.blockers[0].evidence.difference_cents, 100)
  }
})

test("missing or ambiguous control evidence cannot silently become a passing check", () => {
  assert.throws(() => requireLedgerTieOut([], "ar_control"), /exactly one/)
  assert.throws(() => requireLedgerTieOut([result("ar_control"), result("ar_control")], "ar_control"), /exactly one/)
  assert.throws(() => retainageCloseChecks([result("retainage_payable_control")]), /retainage_receivable_control/)
  assert.equal(requireLedgerTieOut([result("ar_control")], "ar_control").status, "passed")
})
