require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const {
  landByCompany,
  requireLedgerTieOut,
  retainageCloseChecks,
  tieByCompany,
  tieOutCloseCheck,
  withCompanies,
} = require("../lib/services/books/close-control-rules")
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

const { createServiceHarness, id } = require("./support/service")
const { freshRequire } = require("./support/modules")
const { runLedgerTieOuts } = freshRequire("lib/services/books/verifier.ts")

const COMPANY_A = "00000000-0000-4000-8000-0000000000a1"
const COMPANY_B = "00000000-0000-4000-8000-0000000000b2"
const emptyInventory = {
  land: { ledgerCents: 0, subledgerCents: 0, exceptions: [], holdings: [] },
  completedHomes: { ledgerCents: 0, heldCents: 0, homes: [], exceptions: [], holdings: [] },
  warrantyReserve: { ledgerCents: 0, subledgerCents: 0, recoveryLedgerCents: 0, recoverySubledgerCents: 0 },
}

function tieOuts({ inventory = emptyInventory, impairment = { ledgerCents: 0, subledgerCents: 0 }, positions = [], tables = {}, balances = [] } = {}) {
  const service = createServiceHarness({
    tables,
    rpc: {
      books_ledger_balances: () => ({ data: balances, error: null }),
      books_home_inventory_controls: () => ({ data: inventory, error: null }),
      books_job_cost_subledger_by_project: () => ({ data: [], error: null }),
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
    land_inventory_control: { inventory: { ...emptyInventory, land: { ledgerCents: 900, subledgerCents: 1000, exceptions: [{ lotId: "lot", lotNumber: "7", ledgerCents: 900, basisCents: 1000 }], holdings: [] } } },
    completed_homes_control: { inventory: { ...emptyInventory, completedHomes: { ledgerCents: 500, heldCents: 0, homes: [], exceptions: [{ projectId: "home", cents: 500 }], holdings: [] } } },
    warranty_reserve_control: { inventory: { ...emptyInventory, warrantyReserve: { ledgerCents: 100, subledgerCents: 90, recoveryLedgerCents: 0, recoverySubledgerCents: 0 } } },
    warranty_reserve_control_recovery: { code: "warranty_reserve_control", inventory: { ...emptyInventory, warrantyReserve: { ledgerCents: 0, subledgerCents: 0, recoveryLedgerCents: 250, recoverySubledgerCents: 0 } } },
    impairment_control: { impairment: { ledgerCents: 700, subledgerCents: 0 } },
    intercompany_control: { positions: [{ entityId: COMPANY_A, counterpartyId: COMPANY_B, dueFromCents: 1000, dueToCents: 0 }, { entityId: COMPANY_B, counterpartyId: COMPANY_A, dueFromCents: 0, dueToCents: 900 }] },
  }
  for (const [name, { code = name, ...scenario }] of Object.entries(failing)) {
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

// Two companies: the builder (primary) and its land company.
const BUILDER = COMPANY_A
const LAND_CO = COMPANY_B
const companies = [
  { id: BUILDER, name: "Harbor Homes", isPrimary: true },
  { id: LAND_CO, name: "Harbor Land LLC", isPrimary: false },
]

test("a company out of balance blocks the close by name even when the org total nets to zero", () => {
  // Org-wide the AR ledger (1,500) equals the open invoices (1,500); each company is 500 off.
  const orgWide = result("ar_control")
  const rows = tieByCompany(
    companies,
    new Map([[BUILDER, 500], [LAND_CO, 1_000]]),
    new Map([[BUILDER, 1_000], [LAND_CO, 500]]),
  )
  const control = withCompanies(orgWide, companies, rows)
  assert.equal(control.status, "failed")
  assert.equal(control.differenceCents, 0)

  const check = tieOutCloseCheck(control)
  assert.equal(check.issueCount, 2)
  assert.deepEqual(check.evidence.out_of_balance_companies, ["Harbor Homes", "Harbor Land LLC"])
  assert.deepEqual(
    check.evidence.companies.map(({ name, difference_cents }) => [name, difference_cents]),
    [["Harbor Homes", -500], ["Harbor Land LLC", 500]],
  )
  const review = closeReviewState([{ ...check, period_id: "period" }], "period")
  assert.equal(review.ready, false)
  assert.deepEqual(review.blockers.map((row) => row.code), ["ar_control"])
})

test("a single-company org keeps the org-wide control exactly as it was", () => {
  const orgWide = result("ar_control", 100)
  const only = [companies[0]]
  assert.equal(withCompanies(orgWide, only, tieByCompany(only, new Map([[BUILDER, 10_000]]), new Map([[BUILDER, 9_900]]))), orgWide)
  assert.deepEqual(tieOutCloseCheck(result("ap_control")).evidence, { ledger_cents: 10000, subledger_cents: 10000, difference_cents: 0 })
})

test("a lot's land basis belongs on one company's books", () => {
  const lot = { lotId: "lot-7", lotNumber: "7", basisCents: 1_000 }
  // Held whole by the land company: tied in every company.
  const held = landByCompany([{ ...lot, ledger: [{ legalEntityId: LAND_CO, cents: 1_000 }] }], null, BUILDER)
  assert.deepEqual(tieByCompany(companies, held.ledger, held.subledger, held.exceptions).map((row) => row.status), ["passed", "passed"])

  // Split between the companies: the lot's total still equals its basis, but neither company ties.
  const split = landByCompany([{ ...lot, ledger: [{ legalEntityId: BUILDER, cents: 400 }, { legalEntityId: LAND_CO, cents: 600 }] }], null, BUILDER)
  const rows = tieByCompany(companies, split.ledger, split.subledger, split.exceptions)
  assert.deepEqual(rows.map((row) => [row.name, row.status, row.differenceCents]), [["Harbor Homes", "failed", -600], ["Harbor Land LLC", "failed", 600]])

  // A land account the land company owns decides, even where the basis was posted elsewhere.
  const owned = landByCompany([{ ...lot, ledger: [{ legalEntityId: BUILDER, cents: 1_000 }] }], LAND_CO, BUILDER)
  assert.deepEqual(tieByCompany(companies, owned.ledger, owned.subledger, owned.exceptions).map((row) => row.differenceCents), [1_000, -1_000])
})

const HOME_A = id(101)
const HOME_B = id(102)
const ACCOUNTS = {
  cash: id(201),
  landCash: id(202),
  receivable: id(203),
  revenue: id(204),
}

/** Each company's books, as `books_ledger_balances` returns them. */
const line = (accountId, legalEntityId, debitCents, creditCents, projectId = null) => ({
  account_id: accountId, project_id: projectId, contract_id: null, warranty_reserve_adjustment: false,
  legal_entity_id: legalEntityId, intercompany: false, debit_cents: debitCents, credit_cents: creditCents,
})

function twoCompanyBooks(orgId, { builderReceivable, landReceivable, landCashOnBuilderBooks = 0 }) {
  const account = (accountId, code, accountType, subtype, normal, legalEntityId = null) => ({
    id: accountId, org_id: orgId, code, name: code, account_type: accountType, subtype, normal_balance: normal, cash_flow_category: null, legal_entity_id: legalEntityId,
  })
  const invoice = (n, projectId, totalCents) => ({ id: id(n), org_id: orgId, project_id: projectId, total_cents: totalCents, status: "sent", issue_date: "2026-10-01", metadata: {} })
  return {
    tables: {
      books_legal_entities: companies.map((company) => ({ id: company.id, org_id: orgId, name: company.name, is_primary: company.isPrimary })),
      projects: [{ id: HOME_A, org_id: orgId, legal_entity_id: null }, { id: HOME_B, org_id: orgId, legal_entity_id: LAND_CO }],
      gl_accounts: [
        account(ACCOUNTS.cash, "1000", "asset", "cash", "debit"),
        account(ACCOUNTS.landCash, "1010", "asset", "cash", "debit", LAND_CO),
        account(ACCOUNTS.receivable, "1100", "asset", "accounts_receivable", "debit"),
        account(ACCOUNTS.revenue, "4000", "income", "construction_revenue", "credit"),
      ],
      // 1,000 open on the builder's home, 500 on the land company's.
      invoices: [invoice(301, HOME_A, 1_000), invoice(302, HOME_B, 500)],
    },
    balances: [
      line(ACCOUNTS.receivable, BUILDER, builderReceivable, 0, HOME_A),
      line(ACCOUNTS.revenue, BUILDER, 0, builderReceivable, HOME_A),
      line(ACCOUNTS.receivable, LAND_CO, landReceivable, 0, HOME_B),
      line(ACCOUNTS.revenue, LAND_CO, 0, landReceivable, HOME_B),
      line(ACCOUNTS.landCash, LAND_CO, 2_000, 0),
      line(ACCOUNTS.landCash, BUILDER, landCashOnBuilderBooks, 0),
      line(ACCOUNTS.revenue, LAND_CO, 0, 2_000),
      line(ACCOUNTS.revenue, BUILDER, 0, landCashOnBuilderBooks),
    ],
  }
}

const control = (rows, code) => rows.find((row) => row.code === code)

test("two companies whose books tie on their own pass AR and cash for each company", async () => {
  const rows = await tieOuts(twoCompanyBooks(id(900001), { builderReceivable: 1_000, landReceivable: 500 }))
  for (const code of ["ar_control", "cash_control"]) {
    assert.equal(control(rows, code).status, "passed", code)
    assert.deepEqual(control(rows, code).companies.map((row) => [row.name, row.status]), [["Harbor Homes", "passed"], ["Harbor Land LLC", "passed"]], code)
  }
})

test("receivables and cash booked to the wrong company fail even when the org total ties", async () => {
  const rows = await tieOuts(twoCompanyBooks(id(900001), { builderReceivable: 500, landReceivable: 1_000, landCashOnBuilderBooks: 300 }))
  const ar = control(rows, "ar_control")
  assert.equal(ar.differenceCents, 0)
  assert.equal(ar.status, "failed")
  assert.deepEqual(ar.companies.map((row) => [row.name, row.ledgerCents, row.subledgerCents]), [["Harbor Homes", 500, 1_000], ["Harbor Land LLC", 1_000, 500]])
  const blocked = closeReviewState([{ ...tieOutCloseCheck(ar), period_id: "period" }], "period")
  assert.equal(blocked.ready, false)
  assert.deepEqual(blocked.blockers[0].evidence.out_of_balance_companies, ["Harbor Homes", "Harbor Land LLC"])

  // The land company's bank balance on the builder's books is the builder's exception.
  const cash = control(rows, "cash_control")
  assert.equal(cash.status, "failed")
  assert.deepEqual(tieOutCloseCheck(cash).evidence.out_of_balance_companies, ["Harbor Homes", "Harbor Land LLC"])
  assert.deepEqual(cash.companies[0].exceptions, [{ accountId: ACCOUNTS.landCash, code: "1010", cents: 300 }])
})
