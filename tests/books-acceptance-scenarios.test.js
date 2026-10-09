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

test("a subcase that needs an outside sandbox is blocked, not skipped, when the run was not given it", async () => {
  let ran = false
  const run = (kit) => runScenario("UNIT-01", kit, {
    expected: expected({ main: { cents: 1 }, sandbox: { requires: "plaid" } }),
    scenario: scenario({ main: async (_kit, spec, check) => { check.equal("main", 1, 1) }, sandbox: async (_kit, _spec, check) => { ran = true; check.equal("sandbox", 1, 1) } }),
  })
  const without = await run({})
  assert.equal(without.status, "INCOMPLETE")
  assert.deepEqual(without.subcases.map((s) => s.status), ["PASSED", "BLOCKED"])
  assert.equal(ran, false)
  assert.equal((await run({ plaid: { env: "sandbox" } })).status, "PASSED")
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
  const result = await runScenario("STORE-01", {})
  assert.ok(GOLDEN_SCENARIOS.includes("STORE-01"))
  assert.equal(result.status, "NOT_IMPLEMENTED")
})

test("the catalog verifier reports unknown scenarios, unsaved evidence and altered evidence", () => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path")
  const { verifyCatalog } = require("../scripts/books-acceptance/verify-catalog.cjs")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-"))
  fs.writeFileSync(path.join(dir, "kept.json"), "{}")
  const relative = path.relative(path.join(__dirname, ".."), path.join(dir, "kept.json"))
  const item = (id, extra) => ({ id, title: id, status: "LOCALLY_VERIFIED", scenario_ids: ["BILL-01"], evidence: [{}], ...extra })
  const trackerPath = path.join(dir, "tracker.json")
  fs.writeFileSync(trackerPath, JSON.stringify({ items: [
    item("B02.1", { scenario_ids: ["NOPE-01"], evidence: [{ evidence_dir: "docs" }] }),
    item("B02.2"),
    item("B03.1", { evidence: [{ artifact_paths_and_hashes: [`${relative} sha256:${"0".repeat(64)}`] }] }),
    { id: "B13.1", title: "payroll", status: "PARTIAL" }, { id: "B14.3", title: "x", status: "PARTIAL" }, { id: "B14.4", title: "x", status: "PARTIAL" },
    { id: "B15.1", title: "x", status: "PARTIAL" }, { id: "B15.2", title: "x", status: "PARTIAL" }, { id: "B15.3", title: "x", status: "PARTIAL" },
    { id: "B03.3", title: "x", status: "PARTIAL" }, { id: "B06.4", title: "x", status: "PARTIAL" }, { id: "B01.2", title: "x", status: "PARTIAL" },
  ] }))
  const { findings } = verifyCatalog({ trackerPath, evidenceRoot: dir })
  assert.deepEqual(findings, ["B02.1 names unknown scenario NOPE-01", "B02.2 is verified without saved evidence", `B03.1 evidence ${relative} no longer matches its recorded hash`])
})
