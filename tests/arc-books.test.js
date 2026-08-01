require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const {
  postBillPayment,
  postCustomerDeposit,
  postCustomerInvoice,
  postExpense,
  postInvoicePayment,
  postLoanPayment,
  postOwnerActivity,
  postPocAdjustment,
  postVendorBill,
  postYearEndClose,
} = require("../lib/services/books/posting-rules")
const { assertBalancedJournalDraft, assertValidOperatingPosture } = require("../lib/services/books/types")
const { computeProjectPoc } = require("../lib/financials/poc-rules")
const { selectCodingSuggestion } = require("../lib/services/accounting-rules")

function common(overrides = {}) {
  return { id: "00000000-0000-4000-8000-000000000001", date: "2026-06-30", memo: "Fixture", policyVersion: 1, ...overrides }
}

test("Arc Books golden postings are balanced in integer cents", () => {
  const entries = [
    postVendorBill({ ...common(), grossCents: 125000, retainageCents: 12500 }),
    postBillPayment({ ...common(), amountCents: 112500 }),
    postCustomerInvoice({ ...common(), grossCents: 250000, retainageCents: 25000 }),
    postInvoicePayment({ ...common(), amountCents: 225000 }),
    postExpense({ ...common(), amountCents: 3599 }),
    postCustomerDeposit({ ...common(), amountCents: 50000 }),
    postLoanPayment({ ...common(), principalCents: 95000, interestCents: 5000 }),
    postPocAdjustment({ ...common(), adjustmentCents: 44000 }),
    postPocAdjustment({ ...common({ id: "00000000-0000-4000-8000-000000000002" }), adjustmentCents: -12000 }),
    postOwnerActivity({ ...common(), amountCents: 100000, activity: "contribution" }),
    postOwnerActivity({ ...common(), amountCents: 25000, activity: "distribution" }),
    postYearEndClose({
      ...common(),
      incomeAccountBalances: [
        { accountCode: "4000", balanceCents: 500000 },
        { accountCode: "5000", balanceCents: 300000 },
        { accountCode: "6000", balanceCents: 50000 },
      ],
    }),
  ]
  for (const entry of entries) {
    const totals = assertBalancedJournalDraft(entry)
    assert.equal(totals.debitCents, totals.creditCents)
    assert.ok(Number.isSafeInteger(totals.debitCents))
  }
  assert.deepEqual(
    postVendorBill({ ...common(), grossCents: 125000, retainageCents: 12500 }).lines.map((line) => [line.accountCode, line.debitCents, line.creditCents]),
    [
      ["5000", 125000, 0],
      ["2000", 0, 112500],
      ["2010", 0, 12500],
    ],
  )
})

test("POC math preserves the existing WIP result and emits an input hash", () => {
  const result = computeProjectPoc({
    originalContractCents: 1_000_000,
    approvedChangeOrdersCents: 100_000,
    revisedContractCents: 1_100_000,
    actualCostCents: 400_000,
    eacCents: 800_000,
    billedCents: 600_000,
  })
  assert.equal(result.percentComplete, 0.5)
  assert.equal(result.earnedRevenueCents, 550_000)
  assert.equal(result.overUnderCents, 50_000)
  assert.equal(result.costToCompleteCents, 400_000)
  assert.equal(result.forecastGrossProfitCents, 300_000)
  assert.match(result.inputsHash, /^[a-f0-9]{64}$/)
})

test("learned coding prefers memo-specific rules and only auto-applies stable history", () => {
  const base = {
    company_id: "vendor-1",
    match_value: "vendor-1",
    cost_code_id: "cost-code-1",
    budget_line_id: null,
    accounting_coding: { expense_account: { id: "5000", name: "Job costs" } },
    confidence: 0.95,
    correction_count: 0,
    last_corrected_at: null,
  }
  const suggestion = selectCodingSuggestion({
    companyId: "vendor-1",
    memo: "Concrete pour at lot 8",
    now: new Date("2026-08-01T00:00:00Z"),
    rules: [
      { ...base, id: "vendor", match_kind: "vendor", memo_pattern: null, hit_count: 20 },
      { ...base, id: "memo", match_kind: "vendor_memo", memo_pattern: "concrete pour", hit_count: 3 },
    ],
  })
  assert.equal(suggestion.ruleId, "memo")
  assert.equal(suggestion.reason, "vendor_memo")
  assert.equal(suggestion.autoApply, true)

  const corrected = selectCodingSuggestion({
    companyId: "vendor-1",
    now: new Date("2026-08-01T00:00:00Z"),
    rules: [{ ...base, id: "corrected", match_kind: "vendor", memo_pattern: null, hit_count: 9, correction_count: 1, last_corrected_at: "2026-07-31T00:00:00Z" }],
  })
  assert.equal(corrected.autoApply, false)
})

test("ledger authority and external integration posture remain independent but consistent", () => {
  assert.doesNotThrow(() => assertValidOperatingPosture({ ledgerAuthority: "external", arcLedgerMode: "shadow", externalSyncPosture: "normal" }))
  assert.doesNotThrow(() => assertValidOperatingPosture({ ledgerAuthority: "external", arcLedgerMode: "parallel", externalSyncPosture: "normal" }))
  assert.doesNotThrow(() => assertValidOperatingPosture({ ledgerAuthority: "arc", arcLedgerMode: "official", externalSyncPosture: "outbound_mirror" }))
  assert.doesNotThrow(() => assertValidOperatingPosture({ ledgerAuthority: "arc", arcLedgerMode: "official", externalSyncPosture: "disconnected" }))
  assert.throws(() => assertValidOperatingPosture({ ledgerAuthority: "arc", arcLedgerMode: "official", externalSyncPosture: "normal" }), /inconsistent/)
  assert.throws(() => assertValidOperatingPosture({ ledgerAuthority: "external", arcLedgerMode: "official", externalSyncPosture: "normal" }), /inconsistent/)
})

test("Books migration enforces immutable balanced journals and service-only posting", () => {
  const migration = fs.readFileSync(path.join(__dirname, "../supabase/migrations/20260801143926_books_accounting_foundation.sql"), "utf8")
  assert.match(migration, /create constraint trigger journal_lines_balanced/i)
  assert.match(migration, /Posted journal entries are immutable/i)
  assert.match(migration, /books_guard_closed_period/i)
  assert.match(migration, /revoke all on function public\.post_books_journal_entry[\s\S]*from public, anon, authenticated/i)
  assert.match(migration, /create policy[\s\S]*has_org_permission/i)
  assert.match(migration, /rollback_books_cutover/i)
  assert.match(migration, /final_sync_marker/i)
  assert.match(migration, /books_exports[\s\S]*downloaded_at/i)
  assert.match(migration, /\(null, 2026, '1099-NEC'[\s\S]*200000/i)
  assert.doesNotMatch(migration, /access_token\s+text/i)
})

test("POC journals are review-only month-boundary exports", () => {
  const source = fs.readFileSync(path.join(__dirname, "../lib/services/accounting-export.ts"), "utf8")
  assert.match(source, /row\.as_of < monthStart/)
  assert.match(source, /1150 Contract assets/)
  assert.match(source, /2350 Contract liabilities/)
  assert.match(source, /review_only: true/)
  const reports = fs.readFileSync(path.join(__dirname, "../lib/reports/definitions/financial.ts"), "utf8")
  assert.match(reports, /slug: "books-poc-journal"/)
  assert.match(reports, /never posts or pushes a journal/)
})

test("Arc-authoritative mode blocks ordinary sync and QBO inbound mutation without removing integrations", () => {
  const sync = fs.readFileSync(path.join(__dirname, "../lib/services/accounting-sync.ts"), "utf8")
  const qboInbound = fs.readFileSync(path.join(__dirname, "../lib/integrations/accounting/qbo/reconcile.ts"), "utf8")
  const cutover = fs.readFileSync(path.join(__dirname, "../lib/services/books/cutover.ts"), "utf8")
  assert.match(sync, /ledger_authority === "external"/)
  assert.match(qboInbound, /Arc is authoritative; external changes are drift-only/)
  assert.match(cutover, /targetPosture: "outbound_mirror" \| "disconnected"/)
  assert.match(cutover, /getProvider\(connection\.data\.provider\)\.capabilities\.supportsJournalEntryPush/)
})

test("Plaid feed code preserves webhook verification and transaction revision history", () => {
  const plaid = fs.readFileSync(path.join(__dirname, "../lib/integrations/banking/plaid.ts"), "utf8")
  const feeds = fs.readFileSync(path.join(__dirname, "../lib/services/books/bank-feeds.ts"), "utf8")
  assert.match(plaid, /request_body_sha256/)
  assert.match(plaid, /transactions\/sync/)
  assert.match(feeds, /bank_transaction_revisions/)
  assert.match(feeds, /pending_posted/)
  assert.match(feeds, /payloadHash/)
})

test("bank reconciliation watermark exists and remains derived from closed statements", () => {
  const migration = fs.readFileSync(path.join(__dirname, "../supabase/migrations/20260801184601_bank_account_reconciliation_watermark.sql"), "utf8")
  const workspace = fs.readFileSync(path.join(__dirname, "../lib/services/books/workspace.ts"), "utf8")
  assert.match(migration, /add column if not exists last_reconciled_on date/i)
  assert.match(migration, /max\(reconciliation\.statement_end\)/i)
  assert.match(migration, /reconciliation\.status = 'closed'/i)
  assert.match(migration, /after insert or update or delete on public\.bank_reconciliations/i)
  assert.match(workspace, /last_reconciled_on/)
  assert.match(workspace, /display_name:label/)
  assert.doesNotMatch(workspace, /provider, display_name, status/)
})

test("Arc Books is opt-in without disabling external accounting integrations", () => {
  const migration = fs.readFileSync(path.join(__dirname, "../supabase/migrations/20260801211117_books_workspace_opt_in.sql"), "utf8")
  const moduleService = fs.readFileSync(path.join(__dirname, "../lib/services/books/module.ts"), "utf8")
  const accountingSync = fs.readFileSync(path.join(__dirname, "../lib/services/accounting-sync.ts"), "utf8")
  const booksLayout = fs.readFileSync(path.join(__dirname, "../app/(app)/books/layout.tsx"), "utf8")

  assert.match(migration, /workspace_enabled boolean not null default false/i)
  assert.match(migration, /ledger_authority <> 'arc' or workspace_enabled/i)
  assert.match(moduleService, /arc_ledger_mode: "disabled"/)
  assert.match(moduleService, /external_sync_posture/)
  assert.match(booksLayout, /settings\?tab=accounting/)
  assert.doesNotMatch(accountingSync, /workspace_enabled/)
})

test("Books exposes focused accounting workspaces instead of one tab-only page", () => {
  const client = fs.readFileSync(path.join(__dirname, "../app/(app)/books/books-client.tsx"), "utf8")
  for (const route of [
    "/books/transactions",
    "/books/banking",
    "/books/chart",
    "/books/ledger",
    "/books/close",
    "/books/opening-balances",
    "/books/accountant",
    "/books/cutover",
  ]) assert.match(client, new RegExp(route.replaceAll("/", "\\/")))
  assert.match(client, /\/books\/banking\/\$\{account\.id\}\/reconcile/)
  assert.match(client, /\/books\/close\/\$\{period\.id\}/)
})
