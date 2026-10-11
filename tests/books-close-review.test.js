require("../scripts/register-ts-node-test");
const test = require("node:test");
const assert = require("node:assert/strict");
const { closeReviewState } = require("../lib/services/books/close-review");
const check = (values = {}) => ({ period_id: "september", blocking: true, status: "passed", evidence: {}, ...values });
test("unreviewed periods cannot appear ready, including when only inapplicable checks exist", () => {
  assert.equal(closeReviewState([], "september").ready, false);
  assert.equal(closeReviewState([check({ evidence: { applicable: false } })], "september").ready, false);
});
test("advisories remain visible without blocking a verified period", () => {
  const state = closeReviewState([check(), check({ status: "warning", blocking: false })], "september");
  assert.equal(state.ready, true);
  assert.equal(state.attention.length, 1);
  assert.equal(state.passed, 1);
});
test("failed or unfinished required controls prevent closing", () => {
  for (const status of ["failed", "warning", "pending"]) {
    assert.equal(closeReviewState([check({ status })], "september").ready, false);
  }
});
test("other periods and disconnected-provider checks cannot contaminate readiness", () => {
  const state = closeReviewState([check(), check({ status: "failed", period_id: "august" }), check({ status: "failed", evidence: { applicable: false } })], "september");
  assert.equal(state.ready, true);
  assert.equal(state.rows.length, 1);
});

const { createServiceHarness, id } = require("./support/service");
const { stubModule, freshRequire } = require("./support/modules");

const PERIOD = id(70);
const tieOut = (code, differenceCents = 0) => ({ code, label: code, status: differenceCents ? "failed" : "passed", ledgerCents: 1000, subledgerCents: 1000 - differenceCents, differenceCents });
const TIE_OUT_CODES = ["trial_balance", "job_cost_control", "ar_control", "ap_control", "retainage_receivable_control", "retainage_payable_control", "customer_deposits_control", "debt_register_control", "fixed_assets_control", "accumulated_depreciation_control", "land_inventory_control", "completed_homes_control", "warranty_reserve_control", "impairment_control", "intercompany_control", "cash_control"];
let tieOuts = [];

stubModule("@/lib/services/books/verifier", { runLedgerTieOuts: async () => tieOuts });
stubModule("@/lib/services/poc", { loadPocPositionsAsOf: async () => new Map() });
stubModule("@/lib/services/books/wip-project-scope", { loadWipScopesForPeriod: async () => [] });
stubModule("@/lib/services/books/revenue-policies", { loadUnreviewedRevenuePolicies: async () => [] });
stubModule("@/lib/services/books/module", { getBooksModuleSettings: async () => ({ settings: { external_sync_posture: "disconnected", active_policy_version: 1 } }) });
const { runBooksCloseChecklist, reopenAccountingPeriod } = freshRequire("lib/services/books/period-close.ts");

test("a production inventory, warranty, impairment or intercompany discrepancy makes the period unready to close", async () => {
  const production = ["land_inventory_control", "completed_homes_control", "warranty_reserve_control", "impairment_control", "intercompany_control"];
  const run = async () => {
    const service = createServiceHarness({
      permissions: ["books.close", "books.read"],
      rpc: { books_account_positions: () => ({ data: [], error: null }) },
      tables: { accounting_periods: [{ id: PERIOD, org_id: require("./support/service").ORG, period_start: "2026-10-01", period_end: "2026-10-31", fiscal_year: 2026, fiscal_period: 10, status: "open" }] },
    });
    const checklist = await service.run(() => runBooksCloseChecklist(PERIOD));
    return closeReviewState(checklist.checks.map((row) => ({ ...row, period_id: PERIOD })), PERIOD);
  };

  tieOuts = TIE_OUT_CODES.map((code) => tieOut(code));
  const clean = await run();
  assert.deepEqual(clean.blockers.filter((row) => production.includes(row.code)), []);

  for (const code of production) {
    tieOuts = TIE_OUT_CODES.map((name) => tieOut(name, name === code ? 100 : 0));
    const review = await run();
    assert.equal(review.ready, false, code);
    assert.deepEqual(review.blockers.filter((row) => production.includes(row.code)).map((row) => row.code), [code]);
  }
});

test("reopening a closed period records who and why, keeps its close digest, and never goes underneath a later close", async () => {
  const { ORG } = require("./support/service");
  const AUGUST = id(71);
  const periods = (septemberStatus, augustStatus = "closed") => [
    { id: AUGUST, org_id: ORG, period_start: "2026-08-01", period_end: "2026-08-31", fiscal_year: 2026, fiscal_period: 8, status: augustStatus, close_digest: "august-digest" },
    { id: PERIOD, org_id: ORG, period_start: "2026-09-01", period_end: "2026-09-30", fiscal_year: 2026, fiscal_period: 9, status: septemberStatus, close_digest: "september-digest" },
  ];
  const harness = (rows) => createServiceHarness({
    permissions: ["books.reopen", "books.read"],
    tables: { accounting_periods: rows },
    rpc: { books_touch_blocked_sources: () => ({ data: null, error: null }) },
  });

  const later = harness(periods("closed"));
  await assert.rejects(later.run(() => reopenAccountingPeriod({ periodId: AUGUST, reason: "Correct a misposted sale" })), /Reopen the period ending 2026-09-30 first/);
  assert.equal(later.db.accounting_periods.find((row) => row.id === AUGUST).status, "closed");

  const open = harness(periods("open"));
  await assert.rejects(open.run(() => reopenAccountingPeriod({ periodId: PERIOD, reason: "Correct a misposted sale" })), /Only a closed accounting period/);
  await assert.rejects(open.run(() => reopenAccountingPeriod({ periodId: AUGUST, reason: "too short" })), /substantive reopen reason/);

  const newest = harness(periods("closed"));
  await newest.run(() => reopenAccountingPeriod({ periodId: PERIOD, reason: "  Correct a misposted sale  " }));
  const reopened = newest.db.accounting_periods.find((row) => row.id === PERIOD);
  assert.equal(reopened.status, "reopened");
  assert.equal(reopened.reopen_reason, "Correct a misposted sale");
  assert.equal(reopened.reopened_by, newest.userId);
  assert.equal(reopened.close_digest, "september-digest");
  assert.deepEqual(newest.events.map((event) => [event.eventType, event.payload.prior_digest]), [["books.period_reopened", "september-digest"]]);
});
