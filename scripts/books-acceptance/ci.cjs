#!/usr/bin/env node
// One acceptance run from nothing (B15.3): a fresh isolated Supabase stack from
// the repository's migrations, its API, every golden scenario, the evidence, and
// the stack stopped and its volume removed afterwards, pass or fail. CI runs
// exactly this; so can anyone with Docker.
//   node scripts/books-acceptance/ci.cjs --workspace NEW_DIR --db-port PORT --evidence-dir NEW_DIR [--storage-env FILE] [--plaid-env FILE] [--taxbandits-env FILE] [--long-run-evidence DIR] [--core]
// Long-running scenarios (catalog LONG_RUNNING) are not run here; without fresh evidence
// from a run of their own (--long-run-evidence) they are NOT_RUN and the run fails.
// --core is the pull-request gate: what waits only on the outside (long runs, real
// storage, sandboxes it was not given) is reported as not run instead of failing.
const { spawnSync } = require("node:child_process")
const path = require("node:path")
const { stage, execute, CLI_VERSION } = require("./bootstrap.cjs")
const { startApi } = require("./api.cjs")

const args = process.argv.slice(2)
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null)
const workspace = arg("--workspace"), port = Number(arg("--db-port")), evidenceDir = arg("--evidence-dir"), storageEnv = arg("--storage-env"), plaidEnv = arg("--plaid-env"), taxbanditsEnv = arg("--taxbandits-env"), longRunEvidence = arg("--long-run-evidence"), core = args.includes("--core")
if (!workspace || !Number.isInteger(port) || !evidenceDir)
  throw Error("Use --workspace NEW_DIR --db-port PORT --evidence-dir NEW_DIR [--storage-env FILE] [--plaid-env FILE] [--taxbandits-env FILE] [--long-run-evidence DIR] [--core]")

const job = stage(workspace, port)
let status = 1
try {
  execute(job)
  const { apiUrl, container } = startApi(workspace)
  // --expose-gc lets STORE-01 measure live memory while it archives a large document.
  const run = spawnSync(process.execPath, ["--expose-gc", path.join(__dirname, "scenario-runner.cjs"), "--container", container, "--api-url", apiUrl, "--all",
    "--evidence-dir", evidenceDir, ...(storageEnv ? ["--storage-env", storageEnv] : []), ...(plaidEnv ? ["--plaid-env", plaidEnv] : []), ...(taxbanditsEnv ? ["--taxbandits-env", taxbanditsEnv] : []),
    ...(longRunEvidence ? ["--long-run-evidence", path.resolve(longRunEvidence)] : []), ...(core ? ["--core"] : [])], { stdio: "inherit" })
  status = run.status ?? 1
} finally {
  // The CLI binds the stack to 0.0.0.0 with published development keys.
  spawnSync("pnpm", ["dlx", `supabase@${CLI_VERSION}`, "stop", "--no-backup", "--workdir", path.resolve(workspace)], { stdio: "inherit", cwd: path.resolve(workspace) })
}
process.exitCode = status
