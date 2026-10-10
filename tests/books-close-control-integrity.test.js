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

const { createServiceHarness } = require("./support/service")
const { freshRequire } = require("./support/modules")
const { runLedgerTieOuts } = freshRequire("lib/services/books/verifier.ts")

const COMPANY_A = "00000000-0000-4000-8000-0000000000a1"
const COMPANY_B = "00000000-0000-4000-8000-0000000000b2"
const emptyInventory = {
  land: { ledgerCents: 0, subledgerCents: 0, exceptions: [] },
  completedHomes: { ledgerCents: 0, heldCents: 0, homes: [], exceptions: [] },
  warrantyReserve: { ledgerCents: 0, subledgerCents: 0 },
}

function tieOuts({ inventory = emptyInventory, impairment = { ledgerCents: 0, subledgerCents: 0 }, positions = [] } = {}) {
  const service = createServiceHarness({
    tables: {},
    rpc: {
      books_ledger_balances: () => ({ data: [], error: null }),
      books_home_inventory_controls: () => ({ data: inventory, error: null }),
      books_job_cost_subledger_cents: () => ({ data: 0, error: null }),
      books_impairment_control: () => ({ data: impairment, error: null }),
      books_intercompany_positions: () => ({ data: positions, error: null }),
    },
  })
  return service.run(() => runLedgerTieOuts(service.orgId, "2026-10-31"))
}

const production = ["land_inventory_control", "completed_homes_control", "warranty_reserve_control", "impairment_control", "intercompany_control"]
const statuses = (rows) => Object.fromEntries(rows.filter((row) => production.includes(row.code)).map((row) => [row.code, row.status]))

test("land, completed homes, warranty reserve, impairment and intercompany each fail the close on their own discrepancy", async () => {
  assert.deepEqual(statuses(await tieOuts()), Object.fromEntries(production.map((code) => [code, "passed"])))

  const failing = {
    land_inventory_control: { inventory: { ...emptyInventory, land: { ledgerCents: 900, subledgerCents: 1000, exceptions: [{ lotId: "lot", lotNumber: "7", ledgerCents: 900, basisCents: 1000 }] } } },
    completed_homes_control: { inventory: { ...emptyInventory, completedHomes: { ledgerCents: 500, heldCents: 0, homes: [], exceptions: [{ projectId: "home", cents: 500 }] } } },
    warranty_reserve_control: { inventory: { ...emptyInventory, warrantyReserve: { ledgerCents: 100, subledgerCents: 90 } } },
    impairment_control: { impairment: { ledgerCents: 700, subledgerCents: 0 } },
    intercompany_control: { positions: [{ entityId: COMPANY_A, counterpartyId: COMPANY_B, dueFromCents: 1000, dueToCents: 0 }, { entityId: COMPANY_B, counterpartyId: COMPANY_A, dueFromCents: 0, dueToCents: 900 }] },
  }
  for (const [code, scenario] of Object.entries(failing)) {
    const rows = await tieOuts(scenario)
    assert.deepEqual(
      Object.entries(statuses(rows)).filter(([, status]) => status === "failed").map(([name]) => name),
      [code],
      code,
    )
    const checks = [{ code, status: "failed", blocking: true, period_id: "period", evidence: {} }]
    assert.equal(closeReviewState(checks, "period").ready, false, code)
  }
})
