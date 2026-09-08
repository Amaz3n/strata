require("../scripts/register-ts-node-test");
const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === "@/lib/supabase/server") return { createServiceSupabaseClient() { throw new Error("Unexpected database read with supplied snapshot"); } };
  return originalLoad.call(this, name, ...args);
};
const { buildBalanceSheet, buildProfitAndLoss, buildTrialBalance } = require("../lib/services/books/statements");
Module._load = originalLoad;
const account = (id, code, type, normal) => ({ id, code, name: code, account_type: type, normal_balance: normal, subtype: "other", cash_flow_category: null });
const entry = (id, date, kind = "operational", reversal = null) => ({ id, entry_date: date, entry_kind: kind, memo: id, source_type: null, reversal_of_entry_id: reversal });
const line = (entryId, accountId, debit, credit) => ({ id: `${entryId}-${accountId}`, entry_id: entryId, account_id: accountId, debit_cents: debit, credit_cents: credit, project_id: null, company_id: null, description: null });
test("contra assets and distributions reduce assets/equity while trial balance keeps account direction", async () => {
  const snapshot = { accounts: [account("cash", "1000", "asset", "debit"), account("dep", "1590", "asset", "credit"), account("equity", "3000", "equity", "credit"), account("draw", "3020", "equity", "debit")], entries: [entry("e", "2026-01-01")], lines: [line("e", "cash", 100000, 0), line("e", "dep", 0, 10000), line("e", "equity", 0, 110000), line("e", "draw", 20000, 0)] };
  const bs = await buildBalanceSheet("org", "2026-12-31", snapshot);
  assert.equal(bs.assetCents, 90000);
  assert.equal(bs.equityCents, 90000);
  assert.equal(bs.differenceCents, 0);
  assert.equal((await buildTrialBalance("org", "2026-12-31", snapshot)).rows.find(r => r.code === "1590").balanceCents, 10000);
});
test("dated reversal retains the original before reversal and nets to zero afterwards", async () => {
  const snapshot = { accounts: [account("cash", "1000", "asset", "debit"), account("cost", "6000", "expense", "debit")], entries: [entry("original", "2026-01-01"), entry("reversal", "2026-02-01", "reversal", "original")], lines: [line("original", "cost", 10000, 0), line("original", "cash", 0, 10000), line("reversal", "cost", 0, 10000), line("reversal", "cash", 10000, 0)] };
  assert.equal((await buildProfitAndLoss("org", "2026-01-01", "2026-01-31", snapshot)).expenseCents, 10000);
  assert.equal((await buildProfitAndLoss("org", "2026-01-01", "2026-02-28", snapshot)).expenseCents, 0);
});
test("closing and its reversal do not erase operating results or add next-year revenue", async () => {
  const snapshot = { accounts: [account("income", "4000", "income", "credit"), account("cash", "1000", "asset", "debit"), account("retained", "3010", "equity", "credit")], entries: [entry("sale", "2026-01-01"), entry("close", "2026-12-31", "closing"), entry("undo", "2027-01-01", "reversal", "close")], lines: [line("sale", "income", 0, 10000), line("sale", "cash", 10000, 0), line("close", "income", 10000, 0), line("close", "retained", 0, 10000), line("undo", "income", 0, 10000), line("undo", "retained", 10000, 0)] };
  assert.equal((await buildProfitAndLoss("org", "2026-01-01", "2026-12-31", snapshot)).revenueCents, 10000);
  assert.equal((await buildProfitAndLoss("org", "2027-01-01", "2027-12-31", snapshot)).revenueCents, 0);
  assert.equal((await buildBalanceSheet("org", "2026-12-31", snapshot)).differenceCents, 0);
});
const { factTransitionIdentity } = require("../lib/services/books/fact-identity");
const { booksDigest } = require("../lib/services/books/hash");
test("fact identities distinguish A-B-A and date changes without migrating unchanged legacy facts", () => {
  const base = { orgId: "org", sourceType: "expense", sourceId: "source", accountingDate: "2026-01-01", payload: { amount: 100 } };
  const a = factTransitionIdentity({ ...base, previous: null });
  const priorA = { source_version: a.sourceVersion, payload_hash: a.payloadHash, accounting_date: base.accountingDate };
  assert.deepEqual(factTransitionIdentity({ ...base, previous: priorA }), a);
  const b = factTransitionIdentity({ ...base, payload: { amount: 200 }, previous: priorA });
  const repeatedA = factTransitionIdentity({ ...base, previous: { source_version: b.sourceVersion, payload_hash: b.payloadHash, accounting_date: base.accountingDate } });
  assert.equal(repeatedA.sourceVersion, 3);
  assert.notEqual(repeatedA.idempotencyKey, a.idempotencyKey);
  assert.equal(factTransitionIdentity({ ...base, accountingDate: "2026-02-01", previous: priorA }).sourceVersion, 2);
  const legacy = factTransitionIdentity({ ...base, previous: { source_version: 7, payload_hash: booksDigest(base.payload), accounting_date: base.accountingDate } });
  assert.equal(legacy.sourceVersion, 7);
  assert.equal(legacy.payloadHash, booksDigest(base.payload));
});
const { fiscalYearRange, fiscalYearRangeEndingOn } = require("../lib/services/books/fiscal-calendar");
test("fiscal calendars span calendar years and leap days", () => {
  assert.deepEqual(fiscalYearRangeEndingOn("2027-06-30", 7), fiscalYearRange(2026, 7));
  assert.equal(fiscalYearRange(2023, 3).endDate, "2024-02-29");
  assert.equal(fiscalYearRange(2026, 7).months[6], "2027-01-01");
  assert.throws(() => fiscalYearRange(2026, 13));
});
test("contract debit positions are assets without offsetting another project's liabilities", async () => {
  const snapshot = { accounts: [account("ca", "1150", "asset", "debit"), account("cl", "2350", "liability", "credit"), account("income", "4000", "income", "credit"), account("ar", "1100", "asset", "debit")], entries: [entry("a", "2026-01-01"), entry("b", "2026-01-01")], lines: [line("a", "cl", 10000, 0), line("a", "income", 0, 10000), line("b", "cl", 0, 15000), line("b", "ar", 15000, 0)].map(l => ({ ...l, project_id: l.entry_id })) };
  const bs = await buildBalanceSheet("org", "2026-12-31", snapshot);
  assert.equal(bs.rows.find(r => r.code === "1150").balanceCents, 10000);
  assert.equal(bs.rows.find(r => r.code === "2350").balanceCents, 15000);
  assert.equal(bs.differenceCents, 0);
});
const { buildCashFlowStatement, buildCashBasisStatement } = require("../lib/services/books/statements");
test("depreciation consumes no cash and disposal proceeds are wholly investing", async () => {
  const cash = { ...account("cash", "1000", "asset", "debit"), cash_flow_category: "cash" };
  const snapshot = { accounts: [cash, { ...account("asset", "1500", "asset", "debit"), cash_flow_category: "investing" }, { ...account("dep", "1590", "asset", "credit"), cash_flow_category: "investing" }, { ...account("cost", "6500", "expense", "debit"), cash_flow_category: "operating" }, { ...account("gain", "4900", "income", "credit"), cash_flow_category: "operating" }], entries: [entry("depreciate", "2026-01-01"), { ...entry("sale", "2026-01-02"), source_type: "books_fixed_asset" }], lines: [line("depreciate", "cost", 10000, 0), line("depreciate", "dep", 0, 10000), line("sale", "cash", 100000, 0), line("sale", "dep", 10000, 0), line("sale", "asset", 0, 90000), line("sale", "gain", 0, 20000)] };
  const cf = await buildCashFlowStatement("org", "2026-01-01", "2026-01-31", snapshot);
  assert.equal(cf.investingCents, 100000); assert.equal(cf.operatingCents, 0);
  const operating = await buildCashBasisStatement("org", "2026-01-01", "2026-01-31", snapshot);
  assert.equal(operating.cashPaidCents, 0); assert.equal(operating.cashReceiptsCents, 0);
});
const { clearingSupportMatches, clearingLedgerDigest } = require("../lib/services/books/clearing-support-rules");
test("clearing schedules must support every cent and ledger changes invalidate their digest", () => {
  const balance = [{ code: "2200", balanceCents: 10000 }];
  const evidence = { code: "2200", amountCents: 10000, expectedSettlementDate: "2026-02-02", explanation: "January payroll paid next month", evidenceUrl: "https://example.com/report" };
  assert.equal(clearingSupportMatches(balance, [evidence], "2026-01-31"), true);
  assert.equal(clearingSupportMatches(balance, [{ ...evidence, amountCents: 9999 }], "2026-01-31"), false);
  assert.equal(clearingSupportMatches(balance, [{ ...evidence, expectedSettlementDate: "2026-01-30" }], "2026-01-31"), false);
  const rows = [{ id: "line", entry_id: "entry", account_id: "account", debit_cents: 0, credit_cents: 10000 }];
  assert.notEqual(clearingLedgerDigest(rows), clearingLedgerDigest([...rows, { ...rows[0], id: "new", credit_cents: 100 }]));
});
const { hashableFactPayload } = require("../lib/services/books/fact-drafts");
test("native funding recoding changes economic identity for payments, fees, expenses and reversals", () => {
  for (const [source, key] of [["bill_payment", "cash_account_code"], ["ap_fee_charge", "cash_account_code"], ["expense", "payment_account_code"], ["payment_reversal", "cash_account_code"]]) {
    assert.notDeepEqual(hashableFactPayload(source, { amount_cents: 100, [key]: "1000" }), hashableFactPayload(source, { amount_cents: 100, [key]: "1001" }));
  }
});
const { invoiceTaxBases } = require("../lib/services/books/tax-summary-rules");
test("tax bases separate exempt and unknown lines, allocate discounts and exclude retainage holds", () => {
  const base = { quantity: 1, unit_price_cents: 10000, description: "Work", unit: "ea" };
  assert.deepEqual(invoiceTaxBases([{ ...base, metadata: { taxable: true } }, { ...base, metadata: { taxable: false } }], 2000), { taxableSalesCents: 9000, exemptSalesCents: 9000, unclassifiedSalesCents: 0 });
  assert.deepEqual(invoiceTaxBases([{ ...base, metadata: {} }], 0), { taxableSalesCents: 0, exemptSalesCents: 0, unclassifiedSalesCents: 10000 });
});
const { inventoryCostAccount, allocateInventoryCost } = require("../lib/services/books/inventory-rules");
test("owned inventory policy keeps contract costs and pre-adoption history intact", () => {
  const policy = { enabled: true, effectiveOn: "2026-03-01", completedOn: "2026-05-01", soldOn: "2026-06-01" };
  assert.equal(inventoryCostAccount(undefined, "2026-04-01", "5030"), "5030");
  assert.equal(inventoryCostAccount(policy, "2026-02-28", "5030"), "5030");
  assert.equal(inventoryCostAccount(policy, "2026-04-01", "5030"), "1160");
  assert.equal(inventoryCostAccount(policy, "2026-05-10", "5030"), "1170");
  assert.equal(inventoryCostAccount(policy, "2026-06-10", "5030"), "5030");
  assert.deepEqual(allocateInventoryCost(100, [{id:"b",weight:1},{id:"a",weight:1},{id:"c",weight:1}]), [{id:"a",amountCents:34},{id:"b",amountCents:33},{id:"c",amountCents:33}]);
});
const { preserveLegacyDimensionPayload } = require('../lib/services/books/fact-drafts');
test('dimension rollout preserves unchanged historical facts and enriches the next economic revision',()=>{
 const old={total_cents:10000,tax_cents:0,retainage_cents:0,project_id:'project',revenue_basis:'cost_to_cost'};
 const previous={accounting_date:'2026-01-01',payload_hash:booksDigest(hashableFactPayload('invoice',old)),payload:old};
 const enriched={...old,project_dimensions:{project:{division_id:'division'}}};
 assert.deepEqual(preserveLegacyDimensionPayload('invoice','2026-01-01',enriched,previous),old);
 assert.deepEqual(preserveLegacyDimensionPayload('invoice','2026-02-01',enriched,previous),enriched);
 const revised={...enriched,total_cents:12000};
 assert.deepEqual(preserveLegacyDimensionPayload('invoice','2026-01-01',revised,previous),revised);
});
