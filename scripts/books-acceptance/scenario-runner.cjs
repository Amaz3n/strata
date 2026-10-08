// Runs golden scenarios (B00.3). A scenario PASSES only when every subcase in its
// reviewed expected file is implemented and every check in it holds; a missing
// subcase is a failure, never a skip.
const fs = require("node:fs"),
  path = require("node:path")
const { createKit, recorder, loadExpected } = require("./scenario-kit.cjs")

const SCENARIO_MODULES = { "BILL-01": "./scenarios/bill-01.cjs", "WIP-01": "./scenarios/wip-01.cjs", "YEAR-01": "./scenarios/year-01.cjs", "CLOSE-01": "./scenarios/close-01.cjs", "BANK-01": "./scenarios/bank-01.cjs", "STATUS-01": "./scenarios/status-01.cjs", "RACE-01": "./scenarios/race-01.cjs", "CAP-01": "./scenarios/cap-01.cjs", "DIM-01": "./scenarios/dim-01.cjs", "HIST-01": "./scenarios/hist-01.cjs", "REV-01": "./scenarios/rev-01.cjs", "HOME-01": "./scenarios/home-01.cjs", "LOSS-01": "./scenarios/loss-01.cjs", "ENTITY-01": "./scenarios/entity-01.cjs", "CASH-01": "./scenarios/cash-01.cjs", "TAX-01": "./scenarios/tax-01.cjs" }

// `only` runs the named subcases for iteration; the rest report SKIPPED, so such a
// run can never read PASSED.
async function runScenario(id, kit, fixtures = {}, only = null) {
  if (!fixtures.scenario && !SCENARIO_MODULES[id]) return { scenario: id, status: "NOT_IMPLEMENTED", subcases: [] }
  const scenario = fixtures.scenario ?? require(SCENARIO_MODULES[id]),
    expected = fixtures.expected ?? loadExpected(id)
  const subcases = []
  for (const [name, spec] of Object.entries(expected.subcases)) {
    const run = scenario.subcases[name]
    if (only && !only.includes(name)) {
      subcases.push({ name, status: "SKIPPED", checks: [] })
      continue
    }
    if (!run || spec.status === "NOT_IMPLEMENTED") {
      subcases.push({ name, status: "NOT_IMPLEMENTED", checks: [] })
      continue
    }
    const check = recorder(),
      startedAt = new Date().toISOString()
    try {
      const identities = await run(kit, spec, check)
      const failed = check.checks.filter((c) => !c.pass)
      subcases.push({ name, status: failed.length || !check.checks.length ? "FAILED" : "PASSED", identities, checks: check.checks, startedAt })
    } catch (error) {
      subcases.push({ name, status: "FAILED", error: error.message, stack: String(error.stack ?? "").split("\n").slice(1, 12).map((l) => l.trim()), checks: check.checks, startedAt })
    }
  }
  const status = subcases.every((s) => s.status === "PASSED") ? "PASSED" : subcases.some((s) => s.status === "FAILED") ? "FAILED" : "INCOMPLETE"
  return { scenario: id, status, reviewedFrom: expected.reviewedFrom, subcases }
}

module.exports = { runScenario, SCENARIO_MODULES }

if (require.main === module) {
  const arg = (name) => process.argv[process.argv.indexOf(name) + 1]
  ;(async () => {
    const container = arg("--container"),
      apiUrl = arg("--api-url"),
      scenario = arg("--scenario"),
      evidenceDir = arg("--evidence-dir")
    if (!container || !apiUrl || !scenario || !evidenceDir || fs.existsSync(evidenceDir))
      throw Error("Use --container NAME --api-url http://127.0.0.1:PORT --scenario ID --evidence-dir NEW_DIRECTORY")
    const kit = createKit({ container, apiUrl })
    const only = process.argv.includes("--only") ? arg("--only").split(",") : null
    const result = { ...(await runScenario(scenario, kit, {}, only)), container, finishedAt: new Date().toISOString() }
    fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(evidenceDir, `${scenario}.json`), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 })
    for (const s of result.subcases) console.log(`${s.status.padEnd(15)} ${s.name}${s.error ? ` — ${s.error}` : ""}${s.checks?.some((c) => !c.pass) ? ` — ${s.checks.filter((c) => !c.pass).map((c) => c.label).join("; ")}` : ""}`)
    console.log(`${scenario}: ${result.status}`)
    if (result.status !== "PASSED") process.exitCode = 1
  })().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
