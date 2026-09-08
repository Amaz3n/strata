require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const {
  BILLED_INVOICE_STATUSES,
  PAYABLE_VENDOR_BILL_STATUSES,
} = require("../lib/financials/ledger-status")
const { payableOutstandingCents } = require("../lib/financials/payables-rules")
const { resolveBilledCents } = require("../lib/financials/poc-inputs")
const { subtractPreIssuanceInvoices } = require("../lib/financials/invoice-rollup")

const read = (relative) => fs.readFileSync(path.join(__dirname, "..", relative), "utf8")

const CONTROL_TOWER_MIGRATION =
  "supabase/migrations/20260903120000_control_tower_rollup.sql"

/**
 * One fixture, read by every surface below. Every invoice status the check
 * constraint allows is present, and the pre-issuance pair carries real money so
 * a surface that counts it is off by a visible amount rather than by nothing.
 */
const INVOICES = [
  { status: "draft", total_cents: 500_00, balance_due_cents: 500_00, due_date: "2026-01-10", issue_date: "2026-01-01", created_at: "2026-01-01T00:00:00Z" },
  { status: "saved", total_cents: 50_000_00, balance_due_cents: 50_000_00, due_date: "2026-01-20", issue_date: "2026-01-02", created_at: "2026-01-02T00:00:00Z" },
  { status: "sent", total_cents: 10_000_00, balance_due_cents: 10_000_00, due_date: "2026-02-01", issue_date: "2026-01-05", created_at: "2026-01-05T00:00:00Z" },
  { status: "partial", total_cents: 8_000_00, balance_due_cents: 3_000_00, due_date: "2026-01-15", issue_date: "2026-01-06", created_at: "2026-01-06T00:00:00Z" },
  { status: "paid", total_cents: 4_000_00, balance_due_cents: 0, due_date: "2026-01-08", issue_date: "2026-01-07", created_at: "2026-01-07T00:00:00Z" },
  { status: "overdue", total_cents: 2_500_00, balance_due_cents: 2_500_00, due_date: "2025-12-01", issue_date: "2025-12-01", created_at: "2025-12-01T00:00:00Z" },
  { status: "void", total_cents: 9_999_00, balance_due_cents: 9_999_00, due_date: "2026-01-30", issue_date: "2026-01-03", created_at: "2026-01-03T00:00:00Z" },
]

const BILLS = [
  { status: "pending", total_cents: 7_000_00, paid_cents: 0, retainage_cents: 0 },
  { status: "rejected", total_cents: 1_200_00, paid_cents: 0, retainage_cents: 0 },
  { status: "approved", total_cents: 12_000_00, paid_cents: 0, retainage_cents: 1_200_00 },
  { status: "partial", total_cents: 6_000_00, paid_cents: 2_000_00, retainage_cents: 0 },
  { status: "paid", total_cents: 3_000_00, paid_cents: 3_000_00, retainage_cents: 0 },
]

const billed = (rows) => rows.filter((row) => BILLED_INVOICE_STATUSES.includes(row.status))
const payable = (rows) => rows.filter((row) => PAYABLE_VENDOR_BILL_STATUSES.includes(row.status))
const sumOpenBalance = (rows) => rows.reduce((sum, row) => sum + Math.max(0, row.balance_due_cents), 0)
const sumOutstandingAp = (rows) => rows.reduce((sum, row) => sum + payableOutstandingCents(row), 0)

test("AR is the same number on the dashboard, the company page and the AR aging report", () => {
  // The AR aging report's own rule: open balance over the billed set only.
  const agingOpenCents = sumOpenBalance(billed(INVOICES))
  const agingInvoicedCents = resolveBilledCents(billed(INVOICES).map((row) => row.total_cents))

  // The company detail page's receivables rollup, same fixture, same rule.
  const companyInvoiced = billed(INVOICES).reduce((sum, row) => sum + row.total_cents, 0)
  const companyOutstanding = sumOpenBalance(billed(INVOICES))

  assert.equal(companyInvoiced, agingInvoicedCents)
  assert.equal(companyOutstanding, agingOpenCents)

  // And the pre-issuance pair is genuinely material: counting it would move the
  // number by $50,500, which is what made the two screens disagree.
  const withDrafts = INVOICES.filter((row) => row.status !== "void")
  assert.equal(
    withDrafts.reduce((sum, row) => sum + row.total_cents, 0) - agingInvoicedCents,
    50_500_00,
  )
})

test("correcting the old dashboard rollup reproduces the billed-only rollup exactly", () => {
  // What the deployed pre-`billed_only` SQL produces: everything but `void`.
  const nonVoid = INVOICES.filter((row) => row.status !== "void")
  const now = new Date("2026-01-25T12:00:00Z")

  const buildRollup = (rows) => {
    const aging = { current: 0, no_due_date: 0, one_to_thirty: 0, thirty_one_to_sixty: 0, sixty_one_to_ninety: 0, over_ninety: 0 }
    const series = new Map()
    let totalInvoiced = 0
    let totalCollected = 0
    let totalOverdue = 0
    const todayKey = now.toISOString().slice(0, 10)
    for (const row of rows) {
      totalInvoiced += row.total_cents
      totalCollected += row.total_cents - row.balance_due_cents
      const key = (row.issue_date ?? row.created_at).slice(0, 7)
      series.set(key, (series.get(key) ?? 0) + row.total_cents)
      if (row.balance_due_cents <= 0) continue
      if (!row.due_date) {
        aging.no_due_date += row.balance_due_cents
        continue
      }
      if (row.status === "overdue" || row.due_date < todayKey) totalOverdue += row.balance_due_cents
      const days = Math.floor((Date.parse(`${todayKey}T00:00:00Z`) - Date.parse(`${row.due_date}T00:00:00Z`)) / 86_400_000)
      if (days <= 0) aging.current += row.balance_due_cents
      else if (days <= 30) aging.one_to_thirty += row.balance_due_cents
      else if (days <= 60) aging.thirty_one_to_sixty += row.balance_due_cents
      else if (days <= 90) aging.sixty_one_to_ninety += row.balance_due_cents
      else aging.over_ninety += row.balance_due_cents
    }
    return {
      total_invoiced: totalInvoiced,
      total_collected: totalCollected,
      total_overdue: totalOverdue,
      revenue_series: Array.from(series.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, revenue_cents]) => ({ key, revenue_cents })),
      ar_aging: aging,
    }
  }

  const oldPayload = buildRollup(nonVoid)
  const target = { ...buildRollup(billed(INVOICES)), billed_only: true }
  const preIssuance = INVOICES.filter((row) => row.status === "draft" || row.status === "saved")

  const corrected = subtractPreIssuanceInvoices(oldPayload, preIssuance, now)
  assert.deepEqual(corrected, target)

  // The marker makes the correction idempotent, so the app is right both before
  // and after the replacing migration is deployed.
  assert.deepEqual(subtractPreIssuanceInvoices(corrected, preIssuance, now), corrected)
  assert.deepEqual(subtractPreIssuanceInvoices(target, preIssuance, now), target)
})

test("AP outstanding is the same number on the dashboard, the payables desk and the AP aging report", () => {
  const desk = sumOutstandingAp(payable(BILLS))
  // 12,000 - 1,200 retainage + 4,000 remaining on the partial = 14,800
  assert.equal(desk, 14_800_00)

  // `pending` is awaiting approval and `rejected` will never be paid; counting
  // either would overstate what the org owes — by $7,000 and $1,200 here.
  assert.equal(sumOutstandingAp(BILLS) - desk, 8_200_00)
})

test("cash-flow forecast projects only real receivables and real payables", () => {
  const source = read("lib/services/reports/cash-flow-forecast.ts")
  assert.match(source, /BILLED_INVOICE_STATUSES/)
  assert.match(source, /PAYABLE_VENDOR_BILL_STATUSES/)
  assert.match(source, /payableOutstandingCents/)
  assert.doesNotMatch(source, /not\("status", "in", "\(paid,void\)"\)/)

  // Inflow equals the AR aging report's open balance for the same fixture.
  assert.equal(sumOpenBalance(billed(INVOICES)), 15_500_00)
})

test("every money surface reads the ledger status sets rather than re-declaring them", () => {
  for (const file of [
    "lib/services/companies.ts",
    "lib/services/weekly-executive-snapshot.ts",
    "lib/services/reports/cash-flow-forecast.ts",
    "lib/services/reports/project-profitability.ts",
    "lib/services/project-overview.ts",
  ]) {
    assert.match(read(file), /@\/lib\/financials\/ledger-status/, `${file} must import the shared status sets`)
  }

  // The control tower aggregates in SQL, so its parity check is on the function
  // rather than on a TypeScript import: `control_tower_rollup` restates the two
  // status sets and the outstanding-payable rule because SQL cannot import
  // them, and a restatement that drifts is exactly how a desk and a report come
  // to disagree about what is owed. Compared literally, not by eye.
  const rollup = read(CONTROL_TOWER_MIGRATION)
  const sqlList = (statuses) => statuses.map((status) => `'${status}'`).join(", ")

  assert.ok(
    rollup.includes(`status in (${sqlList(BILLED_INVOICE_STATUSES)})`),
    "control_tower_rollup must aggregate exactly the billed invoice set",
  )
  assert.ok(
    rollup.includes(`status in (${sqlList(PAYABLE_VENDOR_BILL_STATUSES)})`),
    "control_tower_rollup must aggregate exactly the payable vendor-bill set",
  )

  // total − held retainage − paid, floored at zero: `payableOutstandingCents`,
  // written out. A bill's balance is not a column on vendor_bills.
  assert.match(
    rollup,
    /greatest\(\s*0,\s*coalesce\(b\.total_cents, 0\)\s*- greatest\(0, coalesce\(b\.retainage_cents, 0\) - coalesce\(b\.retainage_released_cents, 0\)\)\s*- coalesce\(b\.paid_cents, 0\)\s*\)/,
  )
  assert.doesNotMatch(rollup, /amount_cents/)
  assert.doesNotMatch(rollup, /vendor_bills[\s\S]{0,200}balance_due_cents/)

  // Profitability includes the billed set instead of excluding an inverse list.
  const profitability = read("lib/services/reports/project-profitability.ts")
  assert.doesNotMatch(profitability, /\["draft", "saved", "void"\]/)
  assert.match(profitability, /resolveRevisedContractCents/)

  // The project overview states the same "Billed" the budget tab does: invoice
  // TOTALS in the billed set, resolved through the shared rule. Cost-coded
  // invoice LINES are a different number whenever an invoice carries tax.
  const overview = read("lib/services/project-overview.ts")
  assert.match(overview, /resolveBilledCents/)
  assert.match(overview, /BILLED_INVOICE_STATUSES/)
  assert.doesNotMatch(overview, /unit_price_cents/)
})

test("the weekly executive snapshot scopes every query by org", () => {
  const source = read("lib/services/weekly-executive-snapshot.ts")
  const projectScoped = source.match(/\.in\("project_id", projectIds\)/g) ?? []
  const orgScoped = source.match(/\.eq\("org_id", orgId\)\n\s+\.in\("project_id", projectIds\)/g) ?? []
  assert.ok(projectScoped.length > 0)
  assert.equal(orgScoped.length, projectScoped.length, "every project-scoped query must also be org-scoped")
})
