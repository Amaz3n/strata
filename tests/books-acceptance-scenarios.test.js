const test = require("node:test"),
  assert = require("node:assert/strict")
const { runScenario } = require("../scripts/books-acceptance/scenario-runner.cjs")

const expected = (subcases) => ({ reviewedFrom: "unit fixture", subcases })
const scenario = (subcases) => ({ id: "UNIT-01", subcases })

test("incorrect accounting fails the scenario with the exact difference", async () => {
  const result = await runScenario("UNIT-01", {}, {
    expected: expected({ main: { cents: 100 } }),
    scenario: scenario({ main: async (_kit, spec, check) => { check.equal("revenue", spec.cents, 99) } }),
  })
  assert.equal(result.status, "FAILED")
  assert.deepEqual(result.subcases[0].checks[0], { label: "revenue", pass: false, expected: 100, observed: 99 })
})

test("a required subcase that is not implemented keeps the scenario from passing", async () => {
  const result = await runScenario("UNIT-01", {}, {
    expected: expected({ main: { cents: 100 }, later: { status: "NOT_IMPLEMENTED" } }),
    scenario: scenario({ main: async (_kit, spec, check) => { check.equal("revenue", spec.cents, 100) } }),
  })
  assert.equal(result.status, "INCOMPLETE")
  assert.deepEqual(result.subcases.map((s) => s.status), ["PASSED", "NOT_IMPLEMENTED"])
})

test("a subcase that asserts nothing or throws cannot pass", async () => {
  const silent = await runScenario("UNIT-01", {}, { expected: expected({ main: {} }), scenario: scenario({ main: async () => {} }) })
  assert.equal(silent.status, "FAILED")
  const thrown = await runScenario("UNIT-01", {}, {
    expected: expected({ main: {} }),
    scenario: scenario({ main: async (_kit, _spec, check) => { check.equal("first", 1, 1); throw new Error("close blocked") } }),
  })
  assert.equal(thrown.status, "FAILED")
  assert.equal(thrown.subcases[0].error, "close blocked")
})

test("every golden scenario is either registered as implemented or reported as not implemented", async () => {
  const { GOLDEN_SCENARIOS } = require("../scripts/books-acceptance/runtime.cjs")
  const result = await runScenario("CONSOL-01", {})
  assert.ok(GOLDEN_SCENARIOS.includes("CONSOL-01"))
  assert.equal(result.status, "NOT_IMPLEMENTED")
})
