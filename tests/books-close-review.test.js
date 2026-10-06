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
