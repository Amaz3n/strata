require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const {
  assertApprovedCostInvoiceBillingModelAllowed,
  isCostDrivenBillingModel,
  shouldExposeOpenBookCostDetail,
} = require("../lib/financials/billing-model")
const { assertCostSourceCanEnterBillableLedger } = require("../lib/financials/billable-ledger-rules")
const { buildApprovedCostInvoiceIdempotencyKey } = require("../lib/financials/approved-cost-rules")
const { summarizeJobCostEntriesByCostCode } = require("../lib/financials/job-cost-rules")
const {
  assertBillingPeriodStatusAllowsEdit,
  assertBillingPeriodStatusAllowsInvoice,
} = require("../lib/financials/billing-period-rules")
const {
  qboSyncAttentionReason,
  qboSyncStatusNeedsAttention,
  resolveLocalFinancialTruthAmount,
} = require("../lib/financials/portfolio-control")

test("fixed-price projects cannot create approved-cost invoices", () => {
  assert.throws(
    () => assertApprovedCostInvoiceBillingModelAllowed("fixed_price"),
    /Fixed-price projects cannot create approved-cost invoices/,
  )

  for (const model of ["cost_plus_percent", "cost_plus_fixed_fee", "cost_plus_gmp", "time_and_materials"]) {
    assert.equal(isCostDrivenBillingModel(model), true)
    assert.doesNotThrow(() => assertApprovedCostInvoiceBillingModelAllowed(model))
  }
})

test("cost-driven projects can promote approved sources into the billable ledger", () => {
  assert.doesNotThrow(() =>
    assertCostSourceCanEnterBillableLedger({
      billingModel: "cost_plus_gmp",
      sourceType: "vendor_bill_line",
      sourceStatus: "approved",
    }),
  )
  assert.doesNotThrow(() =>
    assertCostSourceCanEnterBillableLedger({
      billingModel: "cost_plus_percent",
      sourceType: "project_expense",
      sourceStatus: "approved",
    }),
  )
  assert.doesNotThrow(() =>
    assertCostSourceCanEnterBillableLedger({
      billingModel: "time_and_materials",
      sourceType: "time_entry",
      sourceStatus: "pm_approved",
      clientCostApprovalRequired: false,
    }),
  )
  assert.doesNotThrow(() =>
    assertCostSourceCanEnterBillableLedger({
      billingModel: "cost_plus_gmp",
      sourceType: "time_entry",
      sourceStatus: "client_approved",
      clientCostApprovalRequired: true,
    }),
  )

  assert.throws(
    () =>
      assertCostSourceCanEnterBillableLedger({
        billingModel: "cost_plus_gmp",
        sourceType: "vendor_bill_line",
        sourceStatus: "pending",
      }),
    /Vendor bill must be approved/,
  )
  assert.throws(
    () =>
      assertCostSourceCanEnterBillableLedger({
        billingModel: "fixed_price",
        sourceType: "project_expense",
        sourceStatus: "approved",
      }),
    /Only cost-driven projects/,
  )
})

test("approved-cost invoice idempotency key is stable, sorted, and sensitive to invoice facts", () => {
  const preview = {
    lines: [],
    totals: {
      cost_cents: 12000,
      markup_cents: 2400,
      billable_cents: 14400,
    },
  }
  const base = {
    orgId: "org-1",
    projectId: "project-1",
    invoiceNumber: "INV-100",
    costIds: ["cost-2", "cost-1"],
    preview,
    reservationId: "reservation-1",
  }

  const first = buildApprovedCostInvoiceIdempotencyKey(base)
  const sortedDifferently = buildApprovedCostInvoiceIdempotencyKey({ ...base, costIds: ["cost-1", "cost-2"] })
  const changedTotal = buildApprovedCostInvoiceIdempotencyKey({
    ...base,
    preview: { ...preview, totals: { ...preview.totals, billable_cents: 14500 } },
  })
  const changedReservation = buildApprovedCostInvoiceIdempotencyKey({ ...base, reservationId: "reservation-2" })

  assert.equal(first, sortedDifferently)
  assert.notEqual(first, changedTotal)
  assert.notEqual(first, changedReservation)
  assert.match(first, /^approved_cost_invoice:[a-f0-9]{48}$/)
})

test("approved-cost invoice creation remains routed through the atomic RPC", () => {
  const source = fs.readFileSync(path.join(__dirname, "../lib/services/approved-cost-invoicing.ts"), "utf8")

  assert.match(source, /rpc\("create_invoice_from_billable_costs_atomic"/)
  assert.match(source, /p_idempotency_key:\s*idempotencyKey/)
  assert.match(source, /Approved-cost invoice includes duplicate costs/)
})

test("budget actuals include vendor bills, expenses, and time exactly once", () => {
  const actuals = summarizeJobCostEntriesByCostCode([
    {
      org_id: "org-1",
      cost_code_id: "03-100",
      source_type: "vendor_bill_line",
      source_id: "bill-line-1",
      cost_cents: 10000,
      status: "posted",
      is_billable: true,
    },
    {
      org_id: "org-1",
      cost_code_id: "03-100",
      source_type: "vendor_bill_line",
      source_id: "bill-line-1",
      cost_cents: 10000,
      status: "posted",
      is_billable: true,
    },
    {
      org_id: "org-1",
      cost_code_id: "03-100",
      source_type: "project_expense",
      source_id: "expense-1",
      cost_cents: 2500,
      status: "posted",
      is_billable: true,
    },
    {
      org_id: "org-1",
      cost_code_id: "03-100",
      source_type: "time_entry",
      source_id: "time-1",
      cost_cents: 6400,
      status: "posted",
      is_billable: false,
    },
  ])

  assert.deepEqual(actuals, [
    {
      cost_code_id: "03-100",
      actual_cents: 18900,
      billable_actual_cents: 12500,
      non_billable_actual_cents: 6400,
      entry_count: 3,
    },
  ])
})

test("voided vendor bill actuals are ignored and reversal rows reduce actuals", () => {
  const actuals = summarizeJobCostEntriesByCostCode([
    {
      org_id: "org-1",
      cost_code_id: "04-200",
      source_type: "vendor_bill_line",
      source_id: "bill-line-voided",
      cost_cents: 18000,
      status: "voided",
      is_billable: true,
    },
    {
      org_id: "org-1",
      cost_code_id: "04-200",
      source_type: "manual_adjustment",
      source_id: "reversal-1",
      cost_cents: -7000,
      status: "posted",
      is_billable: true,
    },
    {
      org_id: "org-1",
      cost_code_id: "04-200",
      source_type: "vendor_bill_line",
      source_id: "replacement-line",
      cost_cents: 12000,
      status: "posted",
      is_billable: true,
    },
  ])

  assert.deepEqual(actuals, [
    {
      cost_code_id: "04-200",
      actual_cents: 5000,
      billable_actual_cents: 5000,
      non_billable_actual_cents: 0,
      entry_count: 2,
    },
  ])
})

test("owner portal open-book detail respects open_book=false", () => {
  assert.equal(shouldExposeOpenBookCostDetail(false), false)
  assert.equal(shouldExposeOpenBookCostDetail(true), true)
  assert.equal(shouldExposeOpenBookCostDetail(null), true)
  assert.equal(shouldExposeOpenBookCostDetail(undefined), true)
})

test("QBO sync errors surface exceptions without replacing local financial truth", () => {
  assert.equal(qboSyncStatusNeedsAttention("error"), true)
  assert.equal(qboSyncStatusNeedsAttention("pending"), true)
  assert.equal(qboSyncStatusNeedsAttention("synced"), false)

  const balance = resolveLocalFinancialTruthAmount({
    total_cents: 50000,
    paid_cents: 20000,
    balance_due_cents: 30000,
  })
  assert.equal(balance, 30000)
  assert.equal(qboSyncAttentionReason("error", "Invoice"), "Invoice sync failed")
  assert.equal(qboSyncAttentionReason("pending", "Invoice"), "Invoice sync pending")
})

test("closed billing periods block invoice creation and in-place edits", () => {
  for (const status of ["open", "reviewing", "reopened"]) {
    assert.doesNotThrow(() => assertBillingPeriodStatusAllowsInvoice({ name: "May 2026", status }))
    assert.doesNotThrow(() => assertBillingPeriodStatusAllowsEdit({ name: "May 2026", status }, "Vendor bill"))
  }

  for (const status of ["closed", "invoiced"]) {
    assert.throws(
      () => assertBillingPeriodStatusAllowsInvoice({ name: "May 2026", status }),
      /reopen it before creating another approved-cost invoice/,
    )
    assert.throws(
      () => assertBillingPeriodStatusAllowsEdit({ name: "May 2026", status }, "Vendor bill"),
      /handle it as a late-cost adjustment/,
    )
  }
})
