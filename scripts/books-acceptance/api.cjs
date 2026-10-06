// Starts PostgREST + Kong for a REPLAYED acceptance workspace so golden
// scenarios can run Arc's real services. The database volume is kept (stop
// without --no-backup), the isolation marker is re-verified afterwards, and
// every other Supabase service stays off. The CLI binds services to 0.0.0.0
// with its published development keys, so stop the stack when finished.
const fs = require("node:fs"),
  path = require("node:path"),
  { spawnSync } = require("node:child_process")
const { CLI_VERSION } = require("./bootstrap.cjs")

const EXCLUDED = "gotrue,realtime,storage-api,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor"
// Browser acceptance signs real users in, so it keeps the local auth service.
const EXCLUDED_WITH_AUTH = EXCLUDED.replace("gotrue,", "")

function startApi(workspace, { run = spawnSync, auth = false } = {}) {
  const excluded = auth ? EXCLUDED_WITH_AUTH : EXCLUDED
  workspace = path.resolve(workspace)
  const job = JSON.parse(fs.readFileSync(path.join(workspace, "bootstrap.json"), "utf8"))
  if (job.status !== "REPLAYED" || !/^supabase_db_arc-books-acceptance-[a-z0-9]+$/.test(job.container))
    throw Error("API start requires a REPLAYED acceptance workspace")
  const env = { PATH: process.env.PATH, HOME: process.env.HOME }
  const cli = (args, timeout) => {
    const r = run("pnpm", ["dlx", `supabase@${CLI_VERSION}`, ...args, "--workdir", workspace], { encoding: "utf8", env, cwd: workspace, timeout, killSignal: "SIGKILL" })
    if (r.error || r.status !== 0) throw Error(`supabase ${args[0]} failed: ${(r.stderr || r.error?.message || "").trim().slice(-400)}`)
  }
  const configPath = path.join(workspace, "supabase/config.toml")
  fs.writeFileSync(configPath, fs.readFileSync(configPath, "utf8").replace("[api]\nenabled=false", "[api]\nenabled=true"))
  cli(["stop"], 120000)
  cli(["start", "-x", excluded], 600000)
  const marker = run("docker", ["exec", "-i", job.container, "psql", "-X", "-A", "-t", "-q", "-U", "postgres", "-d", "postgres", "-c", "select instance_id from books_acceptance.environment;"], { encoding: "utf8" })
  if ((marker.stdout ?? "").trim() !== job.instanceId) throw Error("Isolation marker changed across the API restart")
  const apiUrl = `http://127.0.0.1:${job.port + 2}`
  fs.writeFileSync(path.join(workspace, "api.json"), JSON.stringify({ apiUrl, container: job.container, instanceId: job.instanceId, excluded: excluded.split(","), auth, startedAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 })
  return { apiUrl, container: job.container }
}

module.exports = { startApi }
if (require.main === module) {
  try {
    const i = process.argv.indexOf("--workspace")
    if (i < 0 || !process.argv[i + 1]) throw Error("Use --workspace REPLAYED_DIRECTORY")
    const { apiUrl, container } = startApi(process.argv[i + 1], { auth: process.argv.includes("--auth") })
    console.log(`API ready: ${apiUrl} for ${container}. Run scenarios with scripts/books-acceptance/scenario-runner.cjs; stop the stack when finished.`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
