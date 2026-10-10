// Runs golden scenarios (B00.3). A scenario PASSES only when every subcase in its
// reviewed expected file is implemented and every check in it holds; a missing
// subcase is a failure, never a skip.
const fs = require("node:fs"),
  path = require("node:path")
const { createKit, recorder, loadExpected } = require("./scenario-kit.cjs")

const { IMPLEMENTED: SCENARIO_MODULES, NOT_IMPLEMENTED, NEEDS_STORAGE, PRODUCTION } = require("./catalog.cjs")

// `only` runs the named subcases for iteration; the rest report SKIPPED, so such a
// run can never read PASSED. `includePending` also runs an open subcase whose check is
// written (one waiting on a product defect): it reports PASSED when the defect is gone.
async function runScenario(id, kit, fixtures = {}, only = null, { includePending = false } = {}) {
  if (!fixtures.scenario && NEEDS_STORAGE[id] && !kit.storage) return { scenario: id, status: "NOT_IMPLEMENTED", disposition: NEEDS_STORAGE[id], subcases: [] }
  if (!fixtures.scenario && !SCENARIO_MODULES[id]) return { scenario: id, status: "NOT_IMPLEMENTED", ...(NOT_IMPLEMENTED[id] ? { disposition: NOT_IMPLEMENTED[id] } : {}), subcases: [] }
  const scenario = fixtures.scenario ?? require(SCENARIO_MODULES[id]),
    expected = fixtures.expected ?? loadExpected(id)
  const subcases = []
  for (const [name, spec] of Object.entries(expected.subcases)) {
    const run = scenario.subcases[name]
    if (only && !only.includes(name)) {
      subcases.push({ name, status: "SKIPPED", checks: [] })
      continue
    }
    if (!run || (spec.status === "NOT_IMPLEMENTED" && !includePending)) {
      subcases.push({ name, status: "NOT_IMPLEMENTED", checks: [] })
      continue
    }
    // A subcase that needs an outside sandbox (`requires`) is blocked, never
    // skipped, when the run was not given it; the scenario stays INCOMPLETE.
    if (spec.requires && !kit[spec.requires]) {
      subcases.push({ name, status: "BLOCKED", reason: `needs --${spec.requires}-env`, checks: [] })
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

/**
 * Every golden scenario in one run: built ones run, the rest are recorded with
 * their disposition. Exits nonzero unless every first-client scenario passes;
 * deferred ones (payroll) are reported but do not count against it.
 */
async function runAll(kit, container, evidenceDir) {
  const { GOLDEN_SCENARIOS } = require("./runtime.cjs")
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  const summary = []
  for (const id of GOLDEN_SCENARIOS) {
    const startedAt = Date.now()
    const result = { ...(await runScenario(id, kit)), container, finishedAt: new Date().toISOString() }
    fs.writeFileSync(path.join(evidenceDir, `${id}.json`), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 })
    summary.push({ scenario: id, status: result.status, seconds: Math.round((Date.now() - startedAt) / 1000),
      ...(result.disposition ? { disposition: result.disposition.status, packages: result.disposition.packages } : {}),
      open: result.subcases.filter((s) => s.status !== "PASSED").map((s) => s.name) })
    console.log(`${result.status.padEnd(15)} ${id}${result.disposition ? ` (${result.disposition.status}: ${result.disposition.packages.join(", ")})` : ""}`)
  }
  const inScope = summary.filter((row) => row.disposition !== "deferred")
  // A production scenario with open steps is reported, not failed; a failed one fails the run.
  const production = inScope.filter((row) => PRODUCTION[row.scenario] && row.status === "INCOMPLETE")
  const verdict = inScope.every((row) => row.status === "PASSED" || production.includes(row)) ? "PASSED" : "INCOMPLETE"
  fs.writeFileSync(path.join(evidenceDir, "summary.json"), JSON.stringify({ verdict, finishedAt: new Date().toISOString(), container, scenarios: summary }, null, 2) + "\n", { mode: 0o600 })
  console.log(`All scenarios: ${verdict} (${inScope.filter((row) => row.status === "PASSED").length} of ${inScope.length} scenarios pass${production.length ? `; open by design: ${production.map((row) => row.scenario).join(", ")}` : ""})`)
  if (verdict !== "PASSED") process.exitCode = 1
}

module.exports = { runScenario, SCENARIO_MODULES }

if (require.main === module) {
  const arg = (name) => process.argv[process.argv.indexOf(name) + 1]
  ;(async () => {
    const container = arg("--container"),
      apiUrl = arg("--api-url"),
      scenario = process.argv.includes("--all") ? null : arg("--scenario"),
      evidenceDir = arg("--evidence-dir"),
      storageEnv = process.argv.includes("--storage-env") ? arg("--storage-env") : null,
      plaidEnv = process.argv.includes("--plaid-env") ? arg("--plaid-env") : null,
      taxbanditsEnv = process.argv.includes("--taxbandits-env") ? arg("--taxbandits-env") : null
    if (!container || !apiUrl || (!scenario && !process.argv.includes("--all")) || !evidenceDir || fs.existsSync(evidenceDir))
      throw Error("Use --container NAME --api-url http://127.0.0.1:PORT (--scenario ID | --all) --evidence-dir NEW_DIRECTORY [--only name[,name]] [--include-pending] [--storage-env FILE] [--plaid-env FILE] [--taxbandits-env FILE]")
    const kit = createKit({ container, apiUrl, storageEnv, plaidEnv, taxbanditsEnv })
    if (!scenario) return runAll(kit, container, evidenceDir)
    const only = process.argv.includes("--only") ? arg("--only").split(",") : null
    const result = { ...(await runScenario(scenario, kit, {}, only, { includePending: process.argv.includes("--include-pending") })), container, finishedAt: new Date().toISOString() }
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
