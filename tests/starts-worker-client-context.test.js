const assert = require("node:assert/strict")
const test = require("node:test")

const { freshRequire } = require("./support/modules")

// Read once when the module loads; nothing here talks to a real project.
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.example.test"
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key"
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"

const server = freshRequire("lib/supabase/server.ts")
const scope = require("@/lib/supabase/service-client-context")

const TOKEN_A = "00000000-0000-4000-8000-000000000001"
const TOKEN_B = "00000000-0000-4000-8000-000000000002"

/** The headers PostgREST would actually receive from the client `build` returns. The client is built under the stub because the shared client binds the global fetch when it is created. */
async function sentHeaders(build) {
  const original = globalThis.fetch
  let headers
  globalThis.fetch = async (_url, init) => {
    headers = Object.fromEntries(new Headers(init.headers))
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
  }
  try {
    await build().from("start_packages").select("id")
  } finally {
    globalThis.fetch = original
  }
  return headers
}

test("a worker client sends its claim and the shared service client sends none", async () => {
  const worker = await sentHeaders(() => server.createStartsWorkerSupabaseClient(7, TOKEN_A))
  assert.equal(worker["x-starts-job-id"], "7")
  assert.equal(worker["x-starts-claim-token"], TOKEN_A)

  const shared = await sentHeaders(() => server.createServiceSupabaseClient())
  assert.equal(shared["x-starts-claim-token"], undefined)
})

test("concurrent worker scopes each keep their own client across awaits", async () => {
  const shared = server.createServiceSupabaseClient()
  const a = server.createStartsWorkerSupabaseClient(1, TOKEN_A)
  const b = server.createStartsWorkerSupabaseClient(2, TOKEN_B)
  let release
  const gate = new Promise((resolve) => (release = resolve))

  const first = scope.runWithServiceSupabaseClient(a, async () => {
    await gate
    return server.createServiceSupabaseClient()
  })
  const second = scope.runWithServiceSupabaseClient(b, async () => {
    await new Promise((resolve) => setImmediate(resolve))
    const seen = server.createServiceSupabaseClient()
    release()
    return seen
  })

  assert.equal(server.createServiceSupabaseClient(), shared)
  assert.deepEqual(await Promise.all([first, second]), [a, b])
  assert.equal(server.createServiceSupabaseClient(), shared)
})

test("a nested scope restores the outer worker and a failed job leaks nothing", async () => {
  const shared = server.createServiceSupabaseClient()
  const a = server.createStartsWorkerSupabaseClient(1, TOKEN_A)
  const b = server.createStartsWorkerSupabaseClient(2, TOKEN_B)

  await assert.rejects(
    scope.runWithServiceSupabaseClient(a, async () => {
      await scope.runWithServiceSupabaseClient(b, async () => {
        assert.equal(server.createServiceSupabaseClient(), b)
      })
      assert.equal(server.createServiceSupabaseClient(), a)
      throw new Error("Worker stopped")
    }),
    /Worker stopped/,
  )
  assert.equal(server.createServiceSupabaseClient(), shared)
})

test("a worker client cannot be built from a bad job id or an injectable token", () => {
  for (const jobId of [0, -1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => server.createStartsWorkerSupabaseClient(jobId, TOKEN_A), /Invalid starts worker/)
  }
  for (const token of ["", "invalid", `${TOKEN_A}\r\nInjected: true`]) {
    assert.throws(() => server.createStartsWorkerSupabaseClient(1, token), /Invalid starts claim token/)
  }
})

test("the starts pipeline runs instantiation and land transfer inside the worker's client", async () => {
  const { buildHarness, succeedingInstantiation } = require("./support/starts-harness")
  const seen = []
  const harness = buildHarness({
    purchasing: false,
    instantiate: async (input) => {
      seen.push(scope.getScopedServiceSupabaseClient())
      return succeedingInstantiation()(input)
    },
    transferLandAtStart: async () => {
      seen.push(scope.getScopedServiceSupabaseClient())
    },
  })
  const { runStartsPipeline } = freshRequire("@/lib/services/starts-pipeline")

  await runStartsPipeline({ deadlineMs: Date.now() + 5000 })

  assert.ok(seen.length > 0)
  assert.ok(seen.every((client) => client === harness.supabase))
  assert.equal(scope.getScopedServiceSupabaseClient(), undefined)
})
