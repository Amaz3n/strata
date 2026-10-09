#!/usr/bin/env node
// One acceptance run from nothing (B15.3): a fresh isolated Supabase stack from
// the repository's migrations, its API, every golden scenario, the evidence, and
// the stack stopped and its volume removed afterwards, pass or fail. CI runs
// exactly this; so can anyone with Docker.
//   node scripts/books-acceptance/ci.cjs --workspace NEW_DIR --db-port PORT --evidence-dir NEW_DIR [--storage-env FILE] [--plaid-env FILE]
const { spawnSync } = require("node:child_process")
const path = require("node:path")
const { stage, execute, CLI_VERSION } = require("./bootstrap.cjs")
const { startApi } = require("./api.cjs")

const args = process.argv.slice(2)
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null)
const workspace = arg("--workspace"), port = Number(arg("--db-port")), evidenceDir = arg("--evidence-dir"), storageEnv = arg("--storage-env"), plaidEnv = arg("--plaid-env")
if (!workspace || !Number.isInteger(port) || !evidenceDir)
  throw Error("Use --workspace NEW_DIR --db-port PORT --evidence-dir NEW_DIR [--storage-env FILE] [--plaid-env FILE]")

const job = stage(workspace, port)
let status = 1
try {
  execute(job)
  const { apiUrl, container } = startApi(workspace)
  const run = spawnSync(process.execPath, [path.join(__dirname, "scenario-runner.cjs"), "--container", container, "--api-url", apiUrl, "--all",
    "--evidence-dir", evidenceDir, ...(storageEnv ? ["--storage-env", storageEnv] : []), ...(plaidEnv ? ["--plaid-env", plaidEnv] : [])], { stdio: "inherit" })
  status = run.status ?? 1
} finally {
  // The CLI binds the stack to 0.0.0.0 with published development keys.
  spawnSync("pnpm", ["dlx", `supabase@${CLI_VERSION}`, "stop", "--no-backup", "--workdir", path.resolve(workspace)], { stdio: "inherit", cwd: path.resolve(workspace) })
}
process.exitCode = status
