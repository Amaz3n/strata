"use strict"

/**
 * `withCronRun` in `lib/services/job-runs.ts` — what a background job's
 * telemetry row says happened. A row is written when the work finished, with
 * the result it actually had: a partial failure is not green, a crash is
 * recorded and still reaches the runtime, and a telemetry outage never hides
 * or undoes the job's own outcome.
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, replies } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { withCronRun } = freshRequire("lib/services/job-runs.ts")
const { assessCronJob, cronAlertKind } = freshRequire("lib/ops/cron-health.ts")

const respond = (body, status = 200) => async () => new Response(JSON.stringify(body), { status })

async function run(handler, { telemetryDown = false, existing = [], request = {} } = {}) {
  const service = createServiceHarness({ tables: { job_runs: existing } })
  if (telemetryDown) service.tamper("job_runs", replies.error("Telemetry database unavailable"), { on: "insert" })
  let outcome
  try {
    outcome = { response: await service.run(() => withCronRun("starts-pipeline", () => handler(service.db.job_runs))(request)) }
  } catch (error) {
    outcome = { error }
  }
  return { rows: service.db.job_runs, ...outcome }
}

describe("withCronRun", () => {
  test("a finished job is recorded as a success with the response it returned", async () => {
    const { rows, response } = await run(respond({ ok: true }))
    assert.equal(response.status, 200)
    assert.deepEqual(rows.map((row) => [row.job_name, row.status, row.http_status, row.error]), [["starts-pipeline", "success", 200, null]])
    assert.ok(rows[0].finished_at >= rows[0].started_at)
  })

  test("a partial failure is a failed run that keeps its evidence, not a green one", async () => {
    const { rows } = await run(respond({ ok: false, processed: 2, failed: 1, remaining: 3 }, 207))
    assert.deepEqual(rows.map((row) => [row.status, row.http_status]), [["failed", 207]])
    assert.match(rows[0].error, /"failed":1/)
    assert.match(rows[0].error, /"remaining":3/)
  })

  test("a crash is recorded with its message and still reaches the caller", async () => {
    const { rows, error } = await run(async () => {
      throw new Error("Starts database unavailable")
    })
    assert.match(error.message, /Starts database unavailable/)
    assert.deepEqual(rows.map((row) => [row.status, row.http_status, row.error]), [["failed", null, "Starts database unavailable"]])
  })

  test("a late finish does not overwrite a run already closed as timed out", async () => {
    const { rows, response } = await run(async (jobRuns) => {
      jobRuns[0].status = "timed_out"
      return new Response("{}", { status: 200 })
    })
    assert.equal(response.status, 200)
    assert.deepEqual(rows.map((row) => row.status), ["timed_out"])
  })

  test("an unauthorized probe is not a run and writes nothing", async (t) => {
    const saved = process.env.CRON_SECRET
    process.env.CRON_SECRET = "fixture-secret"
    t.after(() => {
      if (saved === undefined) delete process.env.CRON_SECRET
      else process.env.CRON_SECRET = saved
    })
    const { rows, response } = await run(respond({ error: "Unauthorized" }, 401), { request: { headers: new Headers({ authorization: "Bearer wrong" }) } })
    assert.equal(response.status, 401)
    assert.deepEqual(rows, [])
  })

  test("a telemetry outage is logged and cannot change what the job returned", async (t) => {
    const logged = []
    t.mock.method(console, "error", (...args) => logged.push(args))

    const finished = await run(respond({ ok: true }), { telemetryDown: true })
    assert.equal(finished.response.status, 200)
    assert.match(String(logged[0][1]), /Telemetry database unavailable/)

    const crashed = await run(async () => {
      throw new Error("Job crashed")
    }, { telemetryDown: true })
    assert.match(crashed.error.message, /Job crashed/)
  })
})

describe("a run that never reports", () => {
  test("the run is recorded as running with a deadline before the work starts", async () => {
    let seen
    const { rows } = await run(async (during) => {
      seen = during.map((row) => ({ status: row.status, deadline: row.deadline_at, started: row.started_at }))
      return new Response("{}", { status: 200 })
    })
    assert.equal(seen.length, 1)
    assert.equal(seen[0].status, "running")
    assert.ok(Date.parse(seen[0].deadline) > Date.parse(seen[0].started))
    assert.deepEqual(rows.map((row) => row.status), ["success"])
  })

  test("a running row past its deadline is reconciled to timed_out, a live one is left alone", async () => {
    const past = new Date(Date.now() - 60 * 60_000).toISOString()
    const future = new Date(Date.now() + 60 * 60_000).toISOString()
    const { rows } = await run(respond({ ok: true }), { existing: [
      { id: "dead", job_name: "starts-pipeline", status: "running", started_at: past, deadline_at: past },
      { id: "live", job_name: "starts-pipeline", status: "running", started_at: past, deadline_at: future },
    ] })
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]))
    assert.equal(byId.dead.status, "timed_out")
    assert.match(byId.dead.error, /deadline/)
    assert.equal(byId.live.status, "running")
  })

  test("timed out and not started are different states, and both alert", () => {
    const now = Date.parse("2026-10-17T12:00:00Z")
    const hour = 60 * 60_000
    const at = (ms) => new Date(now - ms).toISOString()
    const facts = (overrides) => ({ inFlight: null, lastFinished: null, timedOutInWindow: 0, lastSuccessAt: null, ...overrides })
    const finished = (status, ms) => ({ status, startedAt: at(ms), durationMs: 1000, error: null })
    const deadRun = assessCronJob(facts({ inFlight: { startedAt: at(2 * hour), deadlineAt: at(hour) }, lastFinished: finished("success", 3 * hour), lastSuccessAt: at(3 * hour) }), 6 * hour, now)
    const reconciled = assessCronJob(facts({ lastFinished: finished("timed_out", 2 * hour), timedOutInWindow: 1, lastSuccessAt: at(3 * hour) }), 6 * hour, now)
    const silent = assessCronJob(facts({ lastFinished: finished("success", 8 * hour), lastSuccessAt: at(8 * hour) }), 6 * hour, now)
    const never = assessCronJob(facts({}), 6 * hour, now)
    const working = assessCronJob(facts({ inFlight: { startedAt: at(1000), deadlineAt: at(-hour) }, lastFinished: finished("success", hour), lastSuccessAt: at(hour) }), 6 * hour, now)
    assert.deepEqual([deadRun.state, reconciled.state, silent.state, never.state, working.state], ["timed-out", "timed-out", "not-started", "no-data", "running"])
    assert.deepEqual([deadRun, reconciled, silent, never, working].map(cronAlertKind), ["cron_timed_out", "cron_timed_out", "cron_not_started", "cron_not_started", null])
  })

  test("a run in flight inside its deadline does not hide a job whose runs keep dying or failing", () => {
    // drawings-pipeline: every minute, a 15-minute deadline, so one run is nearly always in flight.
    const now = Date.parse("2026-10-17T12:00:00Z")
    const minute = 60_000
    const at = (ms) => new Date(now - ms).toISOString()
    const window = 3 * minute
    const inFlight = { startedAt: at(minute), deadlineAt: at(-14 * minute) }
    const base = { inFlight, timedOutInWindow: 0, lastSuccessAt: at(40 * minute) }
    const dying = assessCronJob({ ...base, lastFinished: { status: "success", startedAt: at(40 * minute), durationMs: 1, error: null }, timedOutInWindow: 2 }, window, now)
    const failing = assessCronJob({ ...base, lastFinished: { status: "failed", startedAt: at(2 * minute), durationMs: 1, error: "boom" } }, window, now)
    const stalled = assessCronJob({ ...base, lastFinished: { status: "success", startedAt: at(40 * minute), durationMs: 1, error: null } }, window, now)
    const healthy = assessCronJob({ ...base, lastFinished: { status: "success", startedAt: at(2 * minute), durationMs: 1, error: null }, lastSuccessAt: at(2 * minute) }, window, now)
    assert.deepEqual([dying, failing, stalled, healthy].map(cronAlertKind), ["cron_timed_out", "cron_failing", "cron_not_started", null])
    assert.equal(healthy.state, "running")
  })
})
