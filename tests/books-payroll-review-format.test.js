require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  {
    formatPayrollReviewCents: format,
  } = require("../lib/services/books/payroll-review-format");
test("operative payroll review amounts preserve signed exact cents without whole-dollar or float rounding", () => {
  for (const [value, expected] of [
    [0, "$0.00"],
    [1, "$0.01"],
    [-1, "−$0.01"],
    [12345, "$123.45"],
    [Number.MAX_SAFE_INTEGER, "$90,071,992,547,409.91"],
    [-Number.MAX_SAFE_INTEGER, "−$90,071,992,547,409.91"],
  ])
    assert.equal(format(value), expected);
  for (const value of [NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => format(value), /exact integer cents/);
});
