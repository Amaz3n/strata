// Independent database sessions for race checks. Each script runs in its own psql
// process, so it is its own Postgres backend (its own connection and transaction), and
// a barrier releases them together: a holder session takes an advisory lock, every
// session queues behind it, and the holder lets go only once all of them are waiting.
// Service-level races need no barrier: two `kit.as(...)` calls started in one tick are
// two API requests, which PostgREST serves from two sessions (the RACE-01 pattern).
const { spawn } = require("node:child_process")

const BARRIER_KEY = 7_420_113

function psql(kit, text, user = "postgres") {
  return new Promise((resolve) => {
    const child = spawn("docker", ["exec", "-i", kit.container, "psql", "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", "postgres"], { stdio: ["pipe", "pipe", "pipe"] })
    let stdout = "", stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("close", (code) => resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() }))
    child.stdin.end(text)
  })
}

/** SQL that makes a session act as an authenticated member (row-level security and auth.uid() are real). */
function asMember(actor) {
  const claims = JSON.stringify({ sub: actor.userId, role: "authenticated", aud: "authenticated" })
  return `set role authenticated; select set_config('request.jwt.claims', '${claims.replace(/'/g, "''")}', false);`
}

/**
 * Runs every script in its own session, all released together. Each script is plain SQL
 * (statements separated by semicolons; wrap in begin/commit for a transaction). Resolves
 * to one `{ ok, stdout, stderr }` per script, in order; a script that raises reports ok:false.
 */
async function race(kit, scripts, { user = "postgres", key = BARRIER_KEY + Math.floor(Math.random() * 1000) } = {}) {
  const holder = psql(kit, `select pg_advisory_lock(${key}); select pg_sleep(30);`, "supabase_admin")
  // Wait for the holder to own the lock before the others queue behind it.
  for (let i = 0; i < 100; i += 1) {
    if (Number(kit.sql(`select count(*) from pg_locks where locktype='advisory' and granted and objid=${key}`)) === 1) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const sessions = scripts.map((script) => psql(kit, `\\o /dev/null\nselect pg_advisory_lock_shared(${key}); select pg_advisory_unlock_shared(${key});\n\\o\n${script}`, user))
  for (let i = 0; i < 200; i += 1) {
    if (Number(kit.sql(`select count(*) from pg_locks where locktype='advisory' and not granted and objid=${key}`)) >= scripts.length) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  kit.sql(`select pg_terminate_backend(pid) from pg_locks where locktype='advisory' and granted and objid=${key} and mode='ExclusiveLock'`, "supabase_admin")
  await holder
  return Promise.all(sessions)
}

module.exports = { race, psql, asMember }
