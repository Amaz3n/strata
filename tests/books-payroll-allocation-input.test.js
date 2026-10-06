require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  payrollAllocationInputCents: parse,
  payrollAllocationInputText: format,
} = require("../lib/services/books/payroll-allocation-input");
test("allocation dollars retain exact integer cents including zero and the safe-integer boundary", () => {
  for (const cents of [0, 1, 29, 100, 24000, Number.MAX_SAFE_INTEGER])
    assert.equal(parse(format(cents)), cents);
  assert.equal(parse(" 0.29 "), 29);
  assert.equal(parse("1.2"), 120);
});
test("allocation money rejects rounding, sign changes, exponent/currency notation and out-of-range cents", () => {
  for (const input of [
    "",
    "-1",
    "+1",
    "0.001",
    "1e3",
    "$1",
    "1,000",
    "00.2",
    "90071992547409.92",
    "x".repeat(25),
  ])
    assert.throws(() => parse(input));
  for (const amount of [-1, 0.1, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => format(amount));
});

test("signed prior-event claims preserve exact cents and reject zero, rounded, exponent and ambiguous signs", () => {
  const {
    payrollClaimInputCents,
  } = require("../lib/services/books/payroll-allocation-input");
  assert.equal(payrollClaimInputCents("-180.01"), -18001);
  assert.equal(payrollClaimInputCents("180.01"), 18001);
  assert.equal(
    payrollClaimInputCents("-90071992547409.91"),
    -Number.MAX_SAFE_INTEGER,
  );
  for (const value of [
    "0",
    "-0.00",
    "+1",
    "--1",
    "1.001",
    "1e2",
    "1,000",
    "90071992547409.92",
  ])
    assert.throws(() => payrollClaimInputCents(value));
});
