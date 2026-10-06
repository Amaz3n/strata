require("../scripts/register-ts-node-test")
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm"), ts = require("typescript")
const scope = require("../lib/supabase/service-client-context")
const TOKEN_A = "00000000-0000-4000-8000-000000000001", TOKEN_B = "00000000-0000-4000-8000-000000000002"
function server() {
  const clients = [], compiled = { exports: {} }
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require.resolve("../lib/supabase/server.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports: compiled.exports, process: { env: { NEXT_PUBLIC_SUPABASE_URL: "https://example.test", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fake-anon", SUPABASE_SERVICE_ROLE_KEY: "fake-service" } }, require(name) {
      if (name === "server-only" || name === "next/headers" || name === "next/navigation" || name === "@supabase/ssr") return {}
      if (name === "react") return { cache: fn => fn }
      if (name === "@/lib/supabase/service-client-context") return scope
      if (name === "@supabase/supabase-js") return { createClient: (_url, _key, options) => { const client = { options }; clients.push(client); return client } }
      throw new Error(name)
    },
  })
  return { ...compiled.exports, clients }
}
test("concurrent worker scopes retain isolated headers through nested asynchronous services", async () => {
  const api = server(), normal = api.createServiceSupabaseClient()
  const a = api.createStartsWorkerSupabaseClient(1, TOKEN_A), b = api.createStartsWorkerSupabaseClient(2, TOKEN_B)
  let release
  const gate = new Promise(resolve => { release = resolve })
  const first = scope.runWithServiceSupabaseClient(a, async () => {
    assert.equal(api.createServiceSupabaseClient(), a)
    await gate
    assert.equal(api.createServiceSupabaseClient(), a)
    return api.createServiceSupabaseClient().options.global.headers
  })
  const second = scope.runWithServiceSupabaseClient(b, async () => {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(api.createServiceSupabaseClient(), b)
    release()
    return api.createServiceSupabaseClient().options.global.headers
  })
  assert.equal(api.createServiceSupabaseClient(), normal)
  const [firstHeaders, secondHeaders] = await Promise.all([first, second])
  assert.equal(firstHeaders["x-starts-claim-token"], TOKEN_A)
  assert.equal(secondHeaders["x-starts-claim-token"], TOKEN_B)
  assert.equal(api.createServiceSupabaseClient(), normal)
  assert.equal(normal.options.global, undefined)
})
test("nested scopes restore the outer worker and thrown work cannot leak headers", async () => {
  const api = server(), normal = api.createServiceSupabaseClient(), a = api.createStartsWorkerSupabaseClient(1, TOKEN_A), b = api.createStartsWorkerSupabaseClient(2, TOKEN_B)
  await assert.rejects(scope.runWithServiceSupabaseClient(a, async () => {
    await scope.runWithServiceSupabaseClient(b, async () => { assert.equal(api.createServiceSupabaseClient(), b) })
    assert.equal(api.createServiceSupabaseClient(), a)
    throw new Error("Worker stopped")
  }), /Worker stopped/)
  assert.equal(scope.getScopedServiceSupabaseClient(), undefined)
  assert.equal(api.createServiceSupabaseClient(), normal)
})
test("invalid identifiers or tokens cannot create a worker client", () => {
  const api = server()
  for (const id of [0, -1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => api.createStartsWorkerSupabaseClient(id, TOKEN_A), /Invalid starts worker/)
  for (const token of ["", "invalid", `${TOKEN_A}\r\nInjected: true`]) assert.throws(() => api.createStartsWorkerSupabaseClient(1, token), /Invalid starts claim token/)
  assert.equal(api.clients.length, 0)
})

test("starts execution carries its client through instantiation and inventory services", async () => {
  const { buildHarness, succeedingInstantiation } = require("./support/starts-harness")
  let h, checks = 0
  h = buildHarness({ purchasing: false, instantiate: async input => {
    assert.equal(scope.getScopedServiceSupabaseClient(), h.supabase)
    checks += 1
    return succeedingInstantiation()(input)
  }, transferLandAtStart: async () => {
    assert.equal(scope.getScopedServiceSupabaseClient(), h.supabase)
    checks += 1
  } })
  delete require.cache[require.resolve("@/lib/services/starts-pipeline")]
  delete require.cache[require.resolve("@/lib/services/starts")]
  await require("@/lib/services/starts-pipeline").runStartsPipeline({ deadlineMs: Date.now() + 5000 })
  assert.equal(checks, 5)
  assert.equal(scope.getScopedServiceSupabaseClient(), undefined)
})
