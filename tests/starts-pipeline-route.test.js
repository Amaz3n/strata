require("../scripts/register-ts-node-test")
const test = require("node:test"), assert = require("node:assert/strict")
const fs = require("node:fs"), vm = require("node:vm"), ts = require("typescript")
const { createFakeSupabase } = require("./support/fake-supabase")
const { stubModule } = require("./support/starts-harness")
function route({ authorized = true, persistFailed = false, work = async () => ({ processed: 1, failed: 0, remaining: 0 }) } = {}) {
  const db = createFakeSupabase({ job_runs: [] }), callbacks = []
  const from = db.from.bind(db)
  db.from = table => {
    const q = from(table), run = q.run.bind(q)
    q.run = () => persistFailed && table === "job_runs" && q.action === "insert"
      ? { data: null, error: { message: "Telemetry database unavailable" } } : run()
    return q
  }
  stubModule("@/lib/supabase/server", { createServiceSupabaseClient: () => db })
  delete require.cache[require.resolve("@/lib/services/job-runs")]
  const tracker = require("@/lib/services/job-runs"), compiled = { exports: {} }
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require.resolve("../app/api/jobs/starts-pipeline/route.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports: compiled.exports, Date, require(name) {
      if (name === "next/server") return { after: callback => callbacks.push(callback), NextResponse: { json: (body, options) => new Response(JSON.stringify(body), { status: options?.status ?? 200 }) } }
      if (name === "@/lib/services/cron-auth") return { isAuthorizedCronRequest: () => authorized }
      if (name === "@/lib/services/job-runs") return tracker
      if (name === "@/lib/services/starts-pipeline") return { runStartsPipeline: work }
      throw new Error(name)
    },
  })
  return { ...compiled.exports, callbacks, rows: db.store.job_runs }
}
test("accepted starts requests are running, not successful, until the worker finishes", async () => {
  let finish
  const started = new Promise(ready => { finish = null; setImmediate(ready) })
  const h = route({ work: () => new Promise(resolve => { finish = resolve }) })
  assert.equal((await h.POST({})).status, 202)
  assert.equal(h.rows.length, 0)
  const running = h.callbacks[0]()
  await started
  while (!finish) await new Promise(tick => setImmediate(tick))
  assert.equal(h.rows.length, 1)
  assert.equal(h.rows[0].status, "running")
  assert.ok(h.rows[0].deadline_at)
  finish({ processed: 2, failed: 0, remaining: 1 })
  await running
  assert.equal(h.rows.length, 1)
  assert.equal(h.rows[0].status, "success")
  assert.equal(h.rows[0].http_status, 200)
})
test("partial worker failures are recorded as failed runs with queue evidence", async () => {
  const h = route({ work: async () => ({ processed: 2, failed: 1, remaining: 3 }) })
  await h.GET({}); await h.callbacks[0]()
  assert.equal(h.rows[0].status, "failed")
  assert.equal(h.rows[0].http_status, 207)
  assert.match(h.rows[0].error, /"failed":1/)
  assert.match(h.rows[0].error, /"remaining":3/)
})
test("background crashes are recorded and remain visible to the runtime", async () => {
  const h = route({ work: async () => { throw new Error("Starts database unavailable") } })
  await h.GET({})
  await assert.rejects(h.callbacks[0](), /database unavailable/)
  assert.equal(h.rows[0].status, "failed")
  assert.equal(h.rows[0].http_status, null)
  assert.match(h.rows[0].error, /database unavailable/)
})
test("unauthorized starts requests schedule no work or run telemetry", async () => {
  const h = route({ authorized: false })
  assert.equal((await h.GET({})).status, 401)
  assert.equal(h.callbacks.length, 0)
  assert.equal(h.rows.length, 0)
})

test("telemetry persistence failures reach runtime logs without discarding completed worker work", async t => {
  const errors = []
  t.mock.method(console, "error", (...args) => errors.push(args))
  const h = route({ persistFailed: true })
  await h.GET({}); await h.callbacks[0]()
  assert.equal(h.rows.length, 0)
  // Neither the running row nor the outcome could be written; both are logged.
  assert.equal(errors.length, 2)
  for (const error of errors) assert.match(String(error[1]), /Telemetry database unavailable/)
})

test("an abandoned-copy sweep failure is a partial run even when every job succeeded", async () => {
  const h = route({ work: async () => ({ processed: 2, failed: 0, remaining: 0, copyCleanupFailed: 1 }) })
  await h.GET({}); await h.callbacks[0]()
  assert.equal(h.rows[0].status, "failed")
  assert.equal(h.rows[0].http_status, 207)
  assert.match(h.rows[0].error, /"copyCleanupFailed":1/)
})

test("an inert worker that found no schema is a failed run, not a green one", async () => {
  const h = route({ work: async () => ({ processed: 0, failed: 0, remaining: 0, notCutOver: true }) })
  await h.GET({}); await h.callbacks[0]()
  assert.equal(h.rows[0].status, "failed")
  assert.equal(h.rows[0].http_status, 503)
  assert.match(h.rows[0].error, /"notCutOver":true/)
})
