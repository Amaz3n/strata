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

const respond = (body, status = 200) => async () => new Response(JSON.stringify(body), { status })

async function run(handler, { telemetryDown = false } = {}) {
  const service = createServiceHarness({ tables: { job_runs: [] } })
  if (telemetryDown) service.tamper("job_runs", replies.error("Telemetry database unavailable"), { on: "insert" })
  let outcome
  try {
    outcome = { response: await service.run(() => withCronRun("starts-pipeline", handler)({})) }
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

  test("an unauthorized probe is not a run", async () => {
    const { rows, response } = await run(respond({ error: "Unauthorized" }, 401))
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
