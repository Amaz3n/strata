require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const { computePayApplicationCertification } = require("../lib/financials/pay-app-certification")
const { resolvePayApplicationDeferrals } = require("../lib/financials/pay-app-deferrals")

const lines = [
  { prime_sov_line_id: "concrete", maximum_deferrable_cents: 7000 },
  { prime_sov_line_id: "steel", maximum_deferrable_cents: 3000 },
]

test("partial certification preserves the request and derives the receivable from explained line deferrals", () => {
  assert.deepEqual(computePayApplicationCertification(9000, lines, [
    { prime_sov_line_id: "concrete", deferred_cents: 2500, reason: "Awaiting inspection" },
  ]), { requestedCents: 9000, deferredCents: 2500, certifiedCents: 6500 })
})

test("certification rejects duplicate, foreign, excessive, unexplained, and full-payment deferrals", () => {
  assert.throws(() => computePayApplicationCertification(9000, lines, [
    { prime_sov_line_id: "concrete", deferred_cents: 100, reason: "Hold" },
    { prime_sov_line_id: "concrete", deferred_cents: 100, reason: "Hold" },
  ]), /one deferral/)
  assert.throws(() => computePayApplicationCertification(9000, lines, [
    { prime_sov_line_id: "unknown", deferred_cents: 100, reason: "Hold" },
  ]), /does not belong/)
  assert.throws(() => computePayApplicationCertification(9000, lines, [
    { prime_sov_line_id: "steel", deferred_cents: 3001, reason: "Hold" },
  ]), /exceeds/)
  assert.throws(() => computePayApplicationCertification(9000, lines, [
    { prime_sov_line_id: "concrete", deferred_cents: 7000, reason: "x" },
  ]), /Explain/)
  assert.throws(() => computePayApplicationCertification(9000, lines, [
    { prime_sov_line_id: "concrete", deferred_cents: 7000, reason: "No work accepted" },
    { prime_sov_line_id: "steel", deferred_cents: 2000, reason: "No work accepted" },
  ]), /Return the application/)
})

test("owner money entry is exact to cents and rejects exponent and fractional-cent notation", () => {
  const displayLines = [{ id: "concrete", description: "Concrete", maxCents: 7000 }]
  assert.deepEqual(resolvePayApplicationDeferrals(displayLines, {
    concrete: { amount: "25.05", reason: "Awaiting inspection" },
  }, 9000), {
    deferrals: [{ prime_sov_line_id: "concrete", deferred_cents: 2505, reason: "Awaiting inspection" }],
    deferredCents: 2505,
    certifiedCents: 6495,
    error: null,
  })
  assert.match(resolvePayApplicationDeferrals(displayLines, {
    concrete: { amount: "1e2", reason: "Awaiting inspection" },
  }, 9000).error, /valid dollar amount/)
  assert.match(resolvePayApplicationDeferrals(displayLines, {
    concrete: { amount: "1.001", reason: "Awaiting inspection" },
  }, 9000).error, /valid dollar amount/)
})
