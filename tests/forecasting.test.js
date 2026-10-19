"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")

require("../scripts/register-ts-node-test")
const { compareForecastSnapshotLines, distributeForecastAcrossMonths } = require("@/lib/financials/forecasting")

test("snapshot variance is estimate at completion against adjusted budget, including codes new to the forecast", () => {
  const variances = compareForecastSnapshotLines(
    [{ cost_code_id: "a", cost_code: "03", adjusted_budget_cents: 10000 }],
    [
      { cost_code_id: "a", cost_code: "03", estimate_at_completion_cents: 13500 },
      { cost_code_id: "b", cost_code: "09", estimate_at_completion_cents: 2500 },
    ],
  ).map((line) => line.variance_cents)

  assert.deepEqual(variances, [3500, 2500])
})

test("time phasing keeps every cent on every curve", () => {
  for (const curve of ["linear", "front_loaded", "back_loaded"]) {
    const phased = distributeForecastAcrossMonths({
      start: "2026-01-15",
      end: "2026-04-02",
      amount_cents: 10001,
      curve,
    })
    const months = Object.values(phased)
    assert.equal(months.length, 4, curve)
    assert.ok(months.every(Number.isInteger), curve)
    assert.equal(
      months.reduce((sum, cents) => sum + cents, 0),
      10001,
      curve,
    )
  }
})
