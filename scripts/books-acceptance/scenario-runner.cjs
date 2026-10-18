// Runs golden scenarios (B00.3). A scenario PASSES only when every subcase in its
// reviewed expected file is implemented and every check in it holds; a missing
// subcase is a failure, never a skip.
const fs = require("node:fs"),
  path = require("node:path")
const { createKit, recorder, loadExpected } = require("./scenario-kit.cjs")

const { IMPLEMENTED: SCENARIO_MODULES, NOT_IMPLEMENTED, NEEDS_STORAGE, LONG_RUNNING, PRODUCTION } = require("./catalog.cjs")

// `only` runs the named subcases for iteration; the rest report SKIPPED, so such a
// run can never read PASSED. `includePending` also runs an open subcase whose check is
// written: NOT_IMPLEMENTED (not built yet), DEFECT_OPEN (a reproduced product defect,
// which fails the verdict until it is fixed) or `blocked` (needs an environment the
// acceptance stack is not, e.g. a production build); it reports PASSED when that is gone.
async function runScenario(id, stackKit, fixtures = {}, only = null, { includePending = false } = {}) {
  // Scenarios memoise their fixtures (organisation, community, staged lots) per kit,
  // so their subcases share them. Each scenario gets a kit of its own identity: an
  // all-scenarios run must not hand one scenario the organisation another has used.
  const kit = { ...stackKit }
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
    if (!run || ((spec.status === "NOT_IMPLEMENTED" || spec.status === "DEFECT_OPEN") && !includePending)) {
      subcases.push({ name, status: run && spec.status === "DEFECT_OPEN" ? "DEFECT_OPEN" : "NOT_IMPLEMENTED", checks: [] })
      continue
    }
    if (spec.blocked && !includePending) {
      subcases.push({ name, status: "BLOCKED", reason: spec.blocked, checks: [] })
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
  const status = subcases.every((s) => s.status === "PASSED") ? "PASSED"
    : subcases.some((s) => s.status === "FAILED") ? "FAILED"
    : subcases.some((s) => s.status === "DEFECT_OPEN") ? "DEFECT_OPEN" : "INCOMPLETE"
  return { scenario: id, status, head: gitHead(), reviewedFrom: expected.reviewedFrom, subcases }
}

function gitHead() {
  const run = require("node:child_process").spawnSync("git", ["rev-parse", "HEAD"], { cwd: __dirname, encoding: "utf8" })
  return run.status === 0 ? run.stdout.trim() : null
}

/** Long-run evidence counts when it is a whole run of that scenario recorded on this commit, or in the last seven days. */
const LONG_RUN_EVIDENCE_DAYS = 7
function longRunEvidence(id, dir) {
  const file = dir && path.join(dir, `${id}.json`)
  if (!file || !fs.existsSync(file)) return { reason: "no long-run evidence supplied (--long-run-evidence DIR)" }
  const evidence = JSON.parse(fs.readFileSync(file, "utf8"))
  if (evidence.scenario !== id || !Array.isArray(evidence.subcases) || evidence.subcases.some((s) => s.status === "SKIPPED"))
    return { reason: `${file} is not a whole run of ${id}` }
  const ageDays = (Date.now() - Date.parse(evidence.finishedAt)) / 86400000
  const head = gitHead()
  if (!(head && evidence.head === head) && !(ageDays >= 0 && ageDays <= LONG_RUN_EVIDENCE_DAYS))
    return { reason: `${file} is stale: recorded ${evidence.finishedAt} at ${evidence.head ?? "an unknown commit"}, not this commit or within ${LONG_RUN_EVIDENCE_DAYS} days` }
  return { evidence, file }
}

/**
 * Every golden scenario in one run: built ones run, the rest are recorded with
 * their disposition. Exits nonzero unless every first-client scenario passes;
 * deferred ones (payroll) are reported but do not count against it. A long-running
 * one runs only with `includeLongRunning`; otherwise its fresh evidence from a run of
 * its own (`longRunEvidenceDir`, see longRunEvidence) stands in for it, and without
 * that it is NOT_RUN, which fails the verdict like any scenario that did not pass.
 */
async function runAll(kit, container, evidenceDir, { includeLongRunning = false, longRunEvidenceDir = null } = {}) {
  const { GOLDEN_SCENARIOS } = require("./runtime.cjs")
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  const summary = []
  for (const id of GOLDEN_SCENARIOS) {
    const startedAt = Date.now()
    const packages = [PRODUCTION[id]?.checklist ?? id]
    const prior = LONG_RUNNING[id] && !includeLongRunning ? longRunEvidence(id, longRunEvidenceDir) : null
    const skipped = !prior ? null
      : prior.evidence ? { ...prior.evidence, disposition: { status: "long_run_evidence", packages, reason: `${LONG_RUNNING[id]} Evidence: ${prior.file}` } }
      : { scenario: id, status: "NOT_RUN", disposition: { status: "long_running", packages, reason: `${LONG_RUNNING[id]} ${prior.reason}` }, subcases: [] }
    const result = { ...(skipped ?? await runScenario(id, kit)), container, finishedAt: new Date().toISOString() }
    fs.writeFileSync(path.join(evidenceDir, `${id}.json`), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 })
    summary.push({ scenario: id, status: result.status, seconds: Math.round((Date.now() - startedAt) / 1000),
      ...(result.disposition ? { disposition: result.disposition.status, packages: result.disposition.packages } : {}),
      open: result.subcases.filter((s) => s.status !== "PASSED").map((s) => s.name) })
    console.log(`${result.status.padEnd(15)} ${id}${result.disposition ? ` (${result.disposition.status}: ${result.disposition.packages.join(", ")})` : ""}`)
  }
  const inScope = summary.filter((row) => row.disposition !== "deferred")
  // A production scenario with open steps is reported, not failed; a failed one, one with
  // an open defect, and a long-running one with no fresh evidence fail the run.
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
      throw Error("Use --container NAME --api-url http://127.0.0.1:PORT (--scenario ID | --all [--include-long-running | --long-run-evidence DIR]) --evidence-dir NEW_DIRECTORY [--only name[,name]] [--include-pending] [--storage-env FILE] [--plaid-env FILE] [--taxbandits-env FILE]")
    const kit = createKit({ container, apiUrl, storageEnv, plaidEnv, taxbanditsEnv })
    if (!scenario) return runAll(kit, container, evidenceDir, {
      includeLongRunning: process.argv.includes("--include-long-running"),
      longRunEvidenceDir: process.argv.includes("--long-run-evidence") ? arg("--long-run-evidence") : null,
    })
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
