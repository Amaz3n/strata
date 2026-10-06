require("../scripts/register-ts-node-test");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  estimateDraftTotals,
  draftMoneyLine,
} = require("../lib/financials/estimate-draft");
const {
  DEFAULT_ESTIMATE_COMMERCIAL,
} = require("../lib/financials/estimate-commercial");
const c = DEFAULT_ESTIMATE_COMMERCIAL;
const line = (extra = {}) => ({
  item_type: "line",
  quantity: 1,
  unit_cost: 100,
  markup_pct: "",
  is_optional: false,
  ...extra,
});
test("draft cents rounding matches saved lines including fractional quantity and overrides", () => {
  const result = estimateDraftTotals(
    [line({ quantity: 1.5, unit_cost: 10.01 }), line({ markup_pct: 0 })],
    10,
    5,
    c,
  );
  assert.equal(result.total, 116.52);
  assert.equal(result.contingencyTotal, 5.83);
  assert.equal(result.grandTotal, 122.35);
});
test("blank quantity defaults to one, explicit zero stays zero", () => {
  assert.equal(draftMoneyLine(line({ quantity: "" }), 0, c).quantity, 1);
  assert.equal(
    estimateDraftTotals([line({ quantity: 0 })], 20, 10, c).grandTotal,
    0,
  );
});
test("groups and options stay out of base while allowances remain priced", () => {
  const result = estimateDraftTotals(
    [
      line(),
      line({ item_type: "group" }),
      line({ is_optional: true, unit_cost: -20 }),
    ],
    10,
    10,
    c,
  );
  assert.equal(result.grandTotal, 121);
  assert.equal(result.optionalTotal, -22);
});
test("fixed builder fee is included once with line markup suppressed", () => {
  const result = estimateDraftTotals(
    [line({ markup_pct: 50 }), line()],
    20,
    10,
    { ...c, billing_model: "cost_plus_fixed_fee", fixed_fee_cents: 5000 },
  );
  assert.equal(result.total, 250);
  assert.equal(result.costTotal, 200);
  assert.equal(result.grandTotal, 275);
});

test("worksheet tax is retained in live draft totals", () => {
  const result = estimateDraftTotals([line()], 10, 5, c, 10);
  assert.equal(result.total, 110);
  assert.equal(result.contingencyTotal, 5.5);
  assert.equal(result.grandTotal, 127.05);
});
