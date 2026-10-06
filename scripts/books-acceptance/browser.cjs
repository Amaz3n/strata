// Browser acceptance app for an isolated acceptance stack (global DoD 5/6).
// Runs the committed app from a detached worktree inside the workspace, so it
// never shares `.next` with a developer's server and never reads `.env.local`.
// The environment is explicit: the stack's published local keys, freshly
// generated local secrets, and no third-party credentials (email, payments,
// accounting, banking and AI integrations stay unconfigured).
const fs = require("node:fs"),
  path = require("node:path"),
  { randomBytes } = require("node:crypto"),
  { spawn, spawnSync } = require("node:child_process")
const { localJwt } = require("./scenario-kit.cjs")

const repo = path.resolve(__dirname, "../..")

function run(command, args, options) {
  const r = spawnSync(command, args, { encoding: "utf8", ...options })
  if (r.error || r.status !== 0) throw Error(`${command} ${args[0]} failed: ${(r.stderr || r.error?.message || "").trim().slice(-600)}`)
  return r.stdout
}

function browserEnv(api, port) {
  const secret = () => randomBytes(32).toString("hex")
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "development",
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_SUPABASE_URL: api.apiUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: localJwt({ role: "anon" }),
    SUPABASE_SERVICE_ROLE_KEY: localJwt({ role: "service_role" }),
    NEXT_PUBLIC_APP_URL: `http://localhost:${port}`,
    TOKEN_ENCRYPTION_KEY: secret(),
    PROPOSAL_SECRET: secret(),
    BID_PORTAL_SECRET: secret(),
    DOCUMENT_SIGNING_SECRET: secret(),
    PORTAL_ACCESS_SECRET: secret(),
    CRON_SECRET: secret(),
    FINTECH_PAYMENTS_EXECUTION_ENABLED: "false",
  }
}

function startBrowserApp(workspace, port) {
  workspace = path.resolve(workspace)
  const api = JSON.parse(fs.readFileSync(path.join(workspace, "api.json"), "utf8"))
  if (!api.auth) throw Error("Start the stack with `api.cjs --auth` before browser acceptance")
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(api.apiUrl)) throw Error("Browser acceptance requires a loopback acceptance API")
  const app = path.join(workspace, "app")
  if (!fs.existsSync(app)) {
    run("git", ["worktree", "add", "--detach", app, "HEAD"], { cwd: repo })
    run("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], { cwd: app, timeout: 900000, env: { PATH: process.env.PATH, HOME: process.env.HOME } })
  }
  for (const file of [".env", ".env.local", ".env.development", ".env.development.local"])
    if (fs.existsSync(path.join(app, file))) throw Error(`Refusing to start: ${file} exists in the acceptance worktree`)
  const log = fs.openSync(path.join(workspace, "browser-app.log"), "a")
  const child = spawn(path.join(app, "node_modules/.bin/next"), ["dev", "--port", String(port), "--hostname", "localhost"], {
    cwd: app, env: browserEnv(api, port), detached: true, stdio: ["ignore", log, log],
  })
  child.unref()
  const record = { url: `http://localhost:${port}`, pid: child.pid, worktree: app, head: run("git", ["rev-parse", "HEAD"], { cwd: app }).trim(), apiUrl: api.apiUrl, startedAt: new Date().toISOString() }
  fs.writeFileSync(path.join(workspace, "browser.json"), JSON.stringify(record, null, 2) + "\n", { mode: 0o600 })
  return record
}

function stopBrowserApp(workspace) {
  workspace = path.resolve(workspace)
  const file = path.join(workspace, "browser.json")
  if (!fs.existsSync(file)) return
  const { pid, worktree } = JSON.parse(fs.readFileSync(file, "utf8"))
  try { process.kill(-pid) } catch { /* already stopped */ }
  run("git", ["worktree", "remove", "--force", worktree], { cwd: repo })
  fs.rmSync(file)
}

module.exports = { startBrowserApp, stopBrowserApp, browserEnv }
if (require.main === module) {
  try {
    const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1] }
    const workspace = arg("--workspace")
    if (!workspace) throw Error("Use --workspace DIR [--port 3210] [--stop]")
    if (process.argv.includes("--stop")) { stopBrowserApp(workspace); console.log("Browser app stopped and worktree removed.") }
    else { const record = startBrowserApp(workspace, Number(arg("--port") ?? 3210)); console.log(`Browser app starting at ${record.url} (pid ${record.pid}); log in ${workspace}/browser-app.log`) }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
