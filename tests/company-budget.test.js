require("../scripts/register-ts-node-test");
const assert = require("node:assert/strict");
const test = require("node:test");
const { parseBudgetCents, spreadAnnualBudget } = require("../lib/financials/company-budget");
test("annual allocations conserve cents, including sub-dollar budgets", () => {
  for (const amount of [0, 1, 11, 12, 10001, 123456789]) {
    const months = spreadAnnualBudget(amount);
    assert.equal(months.length, 12);
    assert.equal(months.reduce((a, b) => a + b, 0), amount);
    assert.ok(Math.max(...months) - Math.min(...months) <= 1);
  }
  assert.throws(() => spreadAnnualBudget(-1));
  assert.throws(() => spreadAnnualBudget(1.5));
});
test("dollar input preserves decimals and rejects invalid financial amounts", () => {
  assert.equal(parseBudgetCents("100.01"), 10001);
  assert.equal(parseBudgetCents("0.29"), 29);
  assert.equal(parseBudgetCents(""), 0);
  for (const input of ["-1", "1.001", "1e5", "NaN", "Infinity", "abc", "99999999999999999"]) assert.ok(Number.isNaN(parseBudgetCents(input)), input);
});
