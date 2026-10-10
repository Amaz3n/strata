const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness } = require("./support/service")
const { freshRequire } = require("./support/modules")
const { mobileContext } = require("./support/mobile")

const { runIdempotent } = freshRequire("lib/mobile/idempotency.ts")

function harness() {
  const service = createServiceHarness({ permissions: [], tables: { mobile_idempotency_receipts: [] } })
  service.context = mobileContext(service)
  return service
}

function request(key, path = "/api/mobile/v1/projects/p/tasks/t") {
  return new Request(`https://arc.test${path}`, {
    method: "PATCH",
    headers: key ? { "Idempotency-Key": key } : {},
  })
}

/** A mutation that counts how often it really ran. */
function counter() {
  const state = { runs: 0 }
  state.run = async () => ({ applied: ++state.runs })
  return state
}

describe("a mobile mutation sent with an Idempotency-Key", () => {
  test("replays the original result and does not apply the change twice", async () => {
    const service = harness()
    const mutation = counter()
    const body = { status: "done", expected_revision: "r1" }

    const first = await runIdempotent(service.context, request("key-1"), body, mutation.run)
    const replay = await runIdempotent(service.context, request("key-1"), { expected_revision: "r1", status: "done" }, mutation.run)

    assert.deepEqual(first, { data: { applied: 1 }, replayed: false })
    assert.deepEqual(replay, { data: { applied: 1 }, replayed: true })
    assert.equal(mutation.runs, 1)
  })

  test("is a conflict when the same key comes back with a different body or path", async () => {
    const service = harness()
    const mutation = counter()
    await runIdempotent(service.context, request("key-1"), { status: "done" }, mutation.run)

    for (const [req, body] of [
      [request("key-1"), { status: "blocked" }],
      [request("key-1", "/api/mobile/v1/projects/p/tasks/other"), { status: "done" }],
    ]) {
      await assert.rejects(runIdempotent(service.context, req, body, mutation.run), (error) => {
        assert.equal(error.status, 409)
        assert.equal(error.code, "idempotency_key_reuse")
        return true
      })
    }
    assert.equal(mutation.runs, 1)
  })

  test("is refused while the first attempt is still running", async () => {
    const service = harness()
    let release
    const slow = () => new Promise((resolve) => (release = () => resolve({ applied: 1 })))

    const first = runIdempotent(service.context, request("key-1"), { a: 1 }, slow)
    await new Promise((resolve) => setImmediate(resolve))

    await assert.rejects(runIdempotent(service.context, request("key-1"), { a: 1 }, async () => ({})), (error) => error.code === "idempotency_in_progress")
    release()
    assert.equal((await first).replayed, false)
  })

  test("frees the key when the mutation fails, so the retry runs it", async () => {
    const service = harness()
    const mutation = counter()

    await assert.rejects(runIdempotent(service.context, request("key-1"), {}, async () => { throw new Error("db down") }))
    const retry = await runIdempotent(service.context, request("key-1"), {}, mutation.run)

    assert.equal(retry.replayed, false)
    assert.equal(mutation.runs, 1)
  })

  test("belongs to the user who sent it", async () => {
    const service = harness()
    const mutation = counter()
    await runIdempotent(service.context, request("key-1"), {}, mutation.run)
    const other = { ...service.context, user: { ...service.context.user, id: "another-user" } }

    await runIdempotent(other, request("key-1"), {}, mutation.run)

    assert.equal(mutation.runs, 2)
  })

  test("is forgotten once its receipt has expired", async () => {
    const service = harness()
    const mutation = counter()
    await runIdempotent(service.context, request("key-1"), { v: 1 }, mutation.run)
    service.client.from("mobile_idempotency_receipts").update({ expires_at: "2020-01-01T00:00:00Z" }).eq("idempotency_key", "key-1").then(() => {})
    await new Promise((resolve) => setImmediate(resolve))

    const again = await runIdempotent(service.context, request("key-1"), { v: 2 }, mutation.run)

    assert.equal(again.replayed, false)
    assert.equal(mutation.runs, 2)
  })
})

test("a request without the header always runs", async () => {
  const service = harness()
  const mutation = counter()

  await runIdempotent(service.context, request(null), {}, mutation.run)
  await runIdempotent(service.context, request(null), {}, mutation.run)

  assert.equal(mutation.runs, 2)
  assert.deepEqual(service.writes("mobile_idempotency_receipts"), [])
})
