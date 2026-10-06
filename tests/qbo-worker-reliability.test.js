const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const Module = require("node:module")
const ts = require("typescript")

function load(relativePath, stubs = {}, extra = "") {
  const filename = path.resolve(__dirname, "..", relativePath)
  const mod = new Module(filename, module)
  mod.filename = filename
  mod.paths = module.paths
  mod.require = (name) => {
    if (Object.hasOwn(stubs, name)) return stubs[name]
    if (name === "server-only") return {}
    if (name === "@/lib/integrations/accounting/qbo/cdc") return require("./fixtures/qbo-cdc-runtime").load("lib/integrations/accounting/qbo/cdc.ts")
    if (name === "@/lib/supabase/worker-request-context") return load("lib/supabase/worker-request-context.ts")
    if (["crypto", "node:async_hooks", "next/server"].includes(name)) return require(name)
    throw new Error(`Unstubbed dependency: ${name}`)
  }
  mod._compile(ts.transpileModule(fs.readFileSync(filename, "utf8") + extra, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename)
  return mod.exports
}

async function flush() { for (let i = 0; i < 40; i += 1) await Promise.resolve() }
function clock() {
  let now = Date.UTC(2026, 9, 5)
  const timers = new Map()
  const saved = { now: Date.now, setTimeout, clearTimeout, fetch, timeout: AbortSignal.timeout, random: Math.random }
  global.fetch = async () => { throw new Error("Unstubbed fixture fetch") }
  Date.now = () => now
  global.setTimeout = (callback, delay = 0) => {
    const handle = { unref() { return handle }, ref() { return handle }, refresh() { timers.set(handle, { callback, at: now + delay }); return handle } }
    timers.set(handle, { callback, at: now + delay })
    return handle
  }
  global.clearTimeout = (id) => timers.delete(id)
  AbortSignal.timeout = (delay) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException("Fixture timeout", "TimeoutError")), delay)
    return controller.signal
  }
  Math.random = () => 0
  return {
    get now() { return now },
    async tick(ms) {
      const target = now + ms
      await flush()
      for (;;) {
        const entry = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!entry) break
        now = entry[1].at
        timers.delete(entry[0])
        entry[1].callback()
        await flush()
      }
      now = target
      await flush()
    },
    restore() {
      Date.now = saved.now; global.setTimeout = saved.setTimeout; global.clearTimeout = saved.clearTimeout
      global.fetch = saved.fetch; AbortSignal.timeout = saved.timeout; Math.random = saved.random
    },
  }
}
function pending(signal) {
  assert.ok(signal, "every stalled exchange must have an abort signal")
  return new Promise((_resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Fixture abort"))
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
  })
}
const inertDb = { from() { throw new Error("Unexpected database use") }, rpc() { throw new Error("Unexpected database use") } }
const delivery = load("lib/services/accounting-delivery.ts", { "@/lib/supabase/server": { createServiceSupabaseClient: () => inertDb } })
const transport = load("lib/integrations/accounting/qbo/transport.ts", { "@/lib/services/accounting-delivery": delivery })
function auth(logs = []) {
  const saved = {}
  for (const [key, value] of Object.entries({ QBO_CLIENT_ID: "fixture-client", QBO_CLIENT_SECRET: "fixture-secret", TOKEN_ENCRYPTION_KEY: "f".repeat(32) })) {
    saved[key] = process.env[key]; process.env[key] = value
  }
  try {
    return load("lib/integrations/accounting/qbo/auth.ts", {
      "@/lib/integrations/accounting/qbo/transport": transport,
      "@/lib/integrations/accounting/oauth-state": {},
      "@/lib/integrations/accounting/qbo/config": { qboApiBaseUrl: "https://fixture.invalid" },
      "@/lib/services/accounting-logger": { logQBO: (...args) => logs.push(args) },
    })
  } finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } }
}
const operations = [
  ["exchangeCodeForTokens", ["fixture-code", "realm"]], ["refreshAccessToken", ["fixture-refresh"]],
  ["revokeQBOToken", ["fixture-token"]], ["fetchQBOCompanyInfo", ["fixture-token", "realm"]],
  ["detectInvoiceNumberPattern", ["fixture-token", "realm"]],
]

test("all five auth/metadata exchanges abort stalled headers and bodies without retry", async (t) => {
  for (const [operation, args] of operations) for (const phase of ["headers", "body"]) await t.test(`${operation} ${phase}`, async () => {
    const time = clock(), logs = [], api = auth(logs), calls = []
    try {
      global.fetch = async (_url, init) => {
        calls.push(init)
        if (phase === "headers") return pending(init.signal)
        return { ok: true, status: 200, headers: new Headers({ intuit_tid: "fixture-tid" }), json: () => pending(init.signal), text: () => pending(init.signal) }
      }
      const promise = api[operation](...args)
      const completion = operation === "fetchQBOCompanyInfo" ? promise.then((value) => assert.equal(value, null)) : assert.rejects(promise, (error) => {
        assert.ok(error instanceof transport.QBOTransportError)
        assert.equal(error.reason, "timeout"); assert.equal(error.started, true)
        if (phase === "body") assert.equal(error.intuitTid, "fixture-tid")
        return true
      })
      await flush()
      await time.tick(9_999); assert.equal(calls[0].signal.aborted, false)
      await time.tick(1); await completion
      assert.equal(calls.length, 1); assert.equal(calls[0].signal.aborted, true)
      if (operation === "fetchQBOCompanyInfo") assert.equal(logs[0][2].reason, "timeout")
    } finally { time.restore() }
  })
})

test("earliest inherited deadline aborts body and exhausted auth makes zero fetches", async () => {
  const time = clock(), api = auth(), calls = []
  try {
    global.fetch = async (_url, init) => { calls.push(init); return { ok: true, status: 200, headers: new Headers(), json: () => pending(init.signal) } }
    const rejection = assert.rejects(delivery.withAccountingDeadline(time.now + 25, () => api.refreshAccessToken("fixture")), (error) => error.reason === "deadline" && error.started)
    await time.tick(25); await rejection; assert.equal(calls.length, 1)
    for (const [operation, args] of operations) {
      if (operation === "fetchQBOCompanyInfo") assert.equal(await delivery.withAccountingDeadline(time.now, () => api[operation](...args)), null)
      else await assert.rejects(delivery.withAccountingDeadline(time.now, () => api[operation](...args)), (error) => error.reason === "deadline" && !error.started)
    }
    assert.equal(calls.length, 1)
  } finally { time.restore() }
})

test("OAuth errors expose only allowlisted code, operation, status and Intuit ID", async () => {
  const time = clock(), api = auth()
  try {
    global.fetch = async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "fixture-secret-token must not appear", arbitrary: "fixture-private-body" }), { status: 400, headers: { intuit_tid: "fixture-tid" } })
    await assert.rejects(api.refreshAccessToken("fixture-refresh"), (error) => {
      assert.equal(error.oauthCode, "invalid_grant"); assert.equal(error.status, 400); assert.equal(error.intuitTid, "fixture-tid")
      assert.equal(error.operation, "token refresh"); assert.doesNotMatch(error.message, /fixture-secret|fixture-private/)
      return true
    })
    global.fetch = async () => new Response(JSON.stringify({ error: "fixture-private-body" }), { status: 400 })
    await assert.rejects(api.exchangeCodeForTokens("code", "realm"), (error) => error.oauthCode === null && !error.message.includes("fixture-private-body"))
  } finally { time.restore() }
})

test("successful exchanged tokens survive optional company metadata failure and stalled consumption", async () => {
  for (const bodyStall of [false, true]) {
    const time = clock(), logs = [], api = auth(logs)
    try {
      global.fetch = async (url, init) => url.includes("bearer")
        ? new Response(JSON.stringify({ access_token: "fixture-access", refresh_token: "fixture-new-refresh", expires_in: 3600 }))
        : bodyStall ? { ok: true, status: 200, headers: new Headers(), json: () => pending(init.signal) }
          : new Response("fixture arbitrary error body", { status: 500, headers: { intuit_tid: "fixture-tid" } })
      const captured = []
      const state = { provider: "qbo", orgId: "org", userId: "user", connectionId: null }
      const callback = load("app/api/integrations/qbo/callback/route.ts", {
        "next/headers": { cookies: async () => ({ get: () => ({ value: "fixture-state" }) }) },
        "@/lib/integrations/accounting/qbo/auth": { ...api, verifyQBOOAuthState: () => state },
        "@/lib/integrations/accounting/qbo/connections": { upsertQBOConnection: async (input) => captured.push(input) },
        "@/lib/services/context": { requireOrgContext: async () => ({ userId: "user" }) },
        "@/lib/services/permissions": { requirePermission: async () => {} },
        "@/lib/services/accounting-connections": {},
        "@/lib/integrations/accounting/oauth-state": { accountingOAuthCookieName: () => "fixture-cookie" },
        "@/lib/services/accounting-logger": { logQBO() {} },
      })
      const url = "http://fixture.invalid/api/integrations/qbo/callback?code=fixture-code&state=fixture-state&realmId=realm"
      const response = callback.GET({ url, nextUrl: new URL(url), cookies: { get: () => ({ value: "fixture-state" }) } })
      if (bodyStall) await time.tick(10_000)
      const result = await response
      assert.equal(result.status, 307)
      assert.match(result.headers.get("location"), /success=qbo_connected/)
      assert.equal(captured.length, 1)
      assert.equal(captured[0].accessToken, "fixture-access")
      assert.equal(captured[0].refreshToken, "fixture-new-refresh")
      assert.equal(captured[0].companyName, null)
      assert.equal(logs.length, 1); assert.equal(logs[0][1], "company_info_unavailable")
    } finally { time.restore() }
  }
})

function database(seed = [], { failure, stall, latency, jobs = [] } = {}) {
  const rows = structuredClone(seed), calls = [], updates = []
  function query(table, rpc, args) {
    let operation = rpc ? "rpc" : "select", values, single = false, signal
    const filters = []
    const q = {
      select() { return q }, eq(key, value) { filters.push((row) => row[key] === value); return q },
      in() { return q }, or() { return q }, order() { return q }, limit() { return q },
      abortSignal(value) { signal = value; return q },
      maybeSingle() { single = true; return q },
      update(value) { operation = "update"; values = value; return q },
      async then(resolve, reject) {
        try {
          const call = { table, rpc, args, operation, values, signal }; calls.push(call)
          if (stall?.(call)) {
            try { await pending(signal) } catch { return resolve({ data: null, error: { message: "fixture query aborted" } }) }
          }
          if (latency) await latency(call)
          const message = failure?.(call)
          if (message) return resolve({ data: null, error: { message } })
          if (rpc) return resolve({ data: rpc === "claim_jobs" ? structuredClone(jobs) : [], error: null })
          const selected = rows.filter((row) => filters.every((filter) => filter(row)))
          if (operation === "update") { selected.forEach((row) => Object.assign(row, values)); updates.push(call) }
          const data = structuredClone(selected)
          resolve({ data: single ? data[0] ?? null : data, error: null })
        } catch (error) { reject(error) }
      },
    }
    return q
  }
  return { rows, calls, updates, from: (table) => query(table), rpc: (name, args) => query(null, name, args) }
}
const credential = (id) => ({ id, org_id: "org", provider: "qbo", external_account_id: `realm-${id}`, status: "active", access_token: "fixture-access", refresh_token: `fixture-refresh-${id}`, token_expires_at: "2020-01-01T00:00:00Z", refresh_token_expires_at: null, refresh_failure_count: 0 })
function connections(db, authentication) {
  return load("lib/integrations/accounting/qbo/connections.ts", {
    "@/lib/supabase/server": { createServiceSupabaseClient: () => db },
    "@/lib/services/accounting-delivery": delivery,
    "@/lib/integrations/accounting/qbo/transport": transport,
    "@/lib/integrations/accounting/qbo/auth": { ...authentication, getQBOClientId: () => "fixture-client", decryptToken: (token) => token, encryptToken: (token) => `encrypted:${token}` },
    "@/lib/services/accounting-logger": { logQBO() {} }, "@/lib/services/events": { recordEvent: async () => {} },
    "@/lib/services/accounting-enqueue": { requeueAccountingSyncAfterReconnect: async () => ({ failed: 0 }) },
  }, "\nexport const testing = { refreshConnectionTokens }\n")
}
function keepaliveService(providers) {
  return load("lib/services/accounting-connections.ts", {
    "@/lib/services/accounting-delivery": delivery,
    "@/lib/integrations/accounting/registry": { listProviders: () => providers },
    ...Object.fromEntries(["permissions", "context", "events", "audit", "accounting-logger", "accounting-enqueue"].map((name) => [`@/lib/services/${name}`, {}])),
    "@/lib/integrations/accounting/settings": {}, "@/lib/supabase/server": {},
    "@/lib/services/accounting-job-types": {}, "@/lib/integrations/accounting/file/formats": {},
  })
}
const request = () => ({ nextUrl: new URL("http://fixture.invalid") })
function cdcRoute(db, provider) {
  return load("app/api/accounting/process-changes/route.ts", {
    "@/lib/supabase/server": { createServiceSupabaseClient: () => db },
    "@/lib/services/accounting-delivery": delivery,
    "@/lib/integrations/accounting/registry": { listProviders: () => [provider], getProvider: () => provider, isAccountingProviderKey: (key) => key === "qbo" },
    "@/lib/services/cron-auth": { isAuthorizedCronRequest: () => true },
    "@/lib/services/accounting-logger": { logAccounting() {} },
    "@/lib/services/accounting-worker": { withAccountingWorkerCron: (_name, work) => work },
  })
}
function outboxRoute(db, maintenance, push = async () => ({})) {
  return load("app/api/accounting/process-outbox/route.ts", {
    "@/lib/supabase/server": { createServiceSupabaseClient: () => db },
    "@/lib/services/accounting-delivery": delivery,
    "@/lib/services/accounting-connections": { keepAliveAccountingConnections: maintenance },
    "@/lib/services/accounting-sync": { ACCOUNTING_JOB_TYPES: ["accounting_push_invoice"], processAccountingPush: push },
    "@/lib/services/cron-auth": { isAuthorizedCronRequest: () => true },
    "@/lib/services/accounting-logger": { logAccounting() {} },
    "@/lib/services/accounting-worker": { withAccountingWorkerCron: (_name, work) => work },
  })
}

function client() {
  return load("lib/integrations/accounting/qbo/client.ts", {
    "@/lib/services/accounting-delivery": delivery,
    "@/lib/integrations/accounting/qbo/transport": transport,
    "@/lib/integrations/accounting/qbo/connections": {},
    "@/lib/services/accounting-logger": { logQBO() {} },
    "@/lib/integrations/accounting/qbo/config": { qboCompanyBaseUrl: "https://fixture.invalid", qboEnvironmentLabel: "fixture" },
    "@/lib/integrations/accounting/qbo/query": {}, "@/lib/integrations/accounting/qbo/account-utils": {}, "@/lib/integrations/accounting/qbo/error-rules": {},
  }).QBOClient
}
function cdcProvider(onFetch) {
  const Client = client()
  return { key: "qbo", capabilities: { supportsCDC: true }, async ingestChanges({ connectionId }) {
    assert.equal(this.key, "qbo", "provider method receiver is preserved")
    onFetch?.(connectionId)
    return new Client("fixture-access", connectionId).request("GET", "cdc")
  } }
}

test("CDC aborts a hung company within its slice and permits the next company", async () => {
  const time = clock(), db = database([credential("first"), credential("second")]), fetched = []
  try {
    global.fetch = async (url, init) => url.includes("/first/") ? pending(init.signal) : new Response(JSON.stringify({ scanned: 2, inserted: 1 }))
    const response = cdcRoute(db, cdcProvider((id) => fetched.push(id))).GET(request())
    await time.tick(10_000)
    const result = await response
    assert.equal(result.status, 207)
    assert.deepEqual(await result.json(), { connections: 2, scanned: 2, inserted: 1, failedConnections: 1, attempted: 2, deferred: 0, budgetExhausted: false, errorWriteFailures: 0, recoveryRequired: 0, recoveryDeferred: 0, recoveryRuns: [] })
    assert.deepEqual(fetched, ["first", "second"])
    assert.ok(db.rows.every((row) => row.last_inbound_poll_at))
    assert.ok(db.rows[0].last_error)
    assert.ok(db.rows.every((row) => row.settings === undefined), "worker never advances the provider cursor")
  } finally { time.restore() }
})

test("CDC stops starts at overall85s, rotates attempted companies, and leaves later companies due", async () => {
  const time = clock(), db = database(Array.from({ length: 10 }, (_, index) => credential(String(index)))), fetched = []
  try {
    global.fetch = async (_url, init) => pending(init.signal)
    const response = cdcRoute(db, cdcProvider((id) => fetched.push(id))).GET(request())
    await time.tick(85_000)
    const result = await response, body = await result.json()
    assert.equal(result.status, 207); assert.equal(body.attempted, 9); assert.equal(body.deferred, 1)
    assert.equal(body.failedConnections, 9); assert.equal(body.budgetExhausted, true)
    assert.equal(body.errorWriteFailures, 1); assert.equal(fetched.length, 9)
    assert.equal(db.rows[9].last_inbound_poll_at, undefined); assert.equal(db.rows[9].last_error, undefined)
  } finally { time.restore() }
})

test("worker-owned CDC selection, rotation and error-write stalls abort with visible failures", async (t) => {
  for (const phase of ["select", "rotate", "error-write"]) await t.test(phase, async () => {
    const time = clock(), db = database([credential("first")], {
      stall: (call) => phase === "select" ? call.operation === "select" : phase === "rotate" ? call.values?.last_inbound_poll_at : Boolean(call.values?.last_error),
    })
    try {
      const provider = cdcProvider()
      provider.ingestChanges = async () => { throw new Error("fixture provider failure") }
      const response = cdcRoute(db, provider).GET(request())
      await time.tick(10_000)
      const result = await response, body = await result.json()
      assert.equal(result.status, phase === "select" ? 500 : 207)
      if (phase !== "select") assert.equal(body.failedConnections, 1)
      if (phase === "error-write") assert.equal(body.errorWriteFailures, 1)
    } finally { time.restore() }
  })
})

test("keepalive aborts one refresh then refreshes another independently within20s", async () => {
  const time = clock(), db = database([credential("first"), credential("second")]), api = auth(), calls = []
  try {
    global.fetch = async (_url, init) => {
      calls.push(init)
      if (String(init.body).includes("fixture-refresh-first")) return pending(init.signal)
      return new Response(JSON.stringify({ access_token: "fixture-new-access", refresh_token: "fixture-new-refresh", expires_in: 3600 }))
    }
    const response = connections(db, api).refreshQBOConnectionsDueForKeepalive()
    await time.tick(10_000)
    assert.deepEqual(await response, { scanned: 2, refreshed: 1, failed: 1, attempted: 2, deferred: 0, budgetExhausted: false })
    assert.equal(calls.length, 2); assert.equal(db.rows[0].refresh_failure_count, 1)
    assert.equal(db.rows[0].status, "active"); assert.equal(db.rows[1].refresh_token, "encrypted:fixture-new-refresh")
  } finally { time.restore() }
})

test("keepalive stops later credentials after its budget and leaves them eligible", async () => {
  const time = clock(), db = database([credential("first"), credential("second"), credential("third")]), api = auth(), calls = []
  try {
    global.fetch = async (_url, init) => { calls.push(init); return pending(init.signal) }
    const response = connections(db, api).refreshQBOConnectionsDueForKeepalive()
    await time.tick(20_000)
    assert.deepEqual(await response, { scanned: 3, refreshed: 0, failed: 2, attempted: 2, deferred: 1, budgetExhausted: true })
    assert.equal(calls.length, 2); assert.equal(db.rows[2].refresh_failure_count, 0)
    assert.equal(db.rows[2].refresh_token, "fixture-refresh-third"); assert.equal(db.rows[2].status, "active")
    assert.equal(db.rows[2].refresh_token_expires_at, null)
  } finally { time.restore() }
})

test("token persistence preserves the refresh-token CAS and retries exactly once", async () => {
  const time = clock(), api = auth()
  let persistCalls = 0
  const db = database([credential("first")], { failure: (call) => call.values?.refresh_token && ++persistCalls === 1 ? "fixture persistence blip" : null })
  try {
    global.fetch = async () => new Response(JSON.stringify({ access_token: "fixture-new-access", refresh_token: "fixture-new-refresh", expires_in: 3600 }))
    const result = await connections(db, api).refreshQBOConnectionsDueForKeepalive()
    assert.equal(result.refreshed, 1); assert.equal(result.failed, 0); assert.equal(persistCalls, 2)
    assert.equal(db.rows[0].refresh_token, "encrypted:fixture-new-refresh"); assert.equal(db.rows[0].refresh_failure_count, 0)
  } finally { time.restore() }
})

test("already-rotated tokens have bounded shared persistence grace and report failed maintenance", async () => {
  const time = clock(), api = auth(), db = database([credential("first")], { stall: (call) => Boolean(call.values?.refresh_token) })
  try {
    global.fetch = async () => new Response(JSON.stringify({ access_token: "fixture-new-access", refresh_token: "fixture-new-refresh", expires_in: 3600 }))
    const promise = delivery.withAccountingDeadline(time.now + 1, () => connections(db, api).refreshQBOConnectionsDueForKeepalive())
    await time.tick(5_000)
    const result = await promise
    assert.equal(result.failed, 1); assert.equal(result.refreshed, 0)
    assert.equal(db.calls.filter((call) => call.values?.refresh_token).length, 1)
    assert.equal(db.rows[0].status, "active"); assert.equal(db.rows[0].refresh_failure_count, 0)
  } finally { time.restore() }
})

test("exhausted invocation starts no worker selection, claim, token lookup or auth fetch", async () => {
  const time = clock(), db = database([credential("first")]), api = auth()
  try {
    global.fetch = async () => { throw new Error("Must not fetch") }
    const provider = cdcProvider(() => assert.fail("Must not invoke provider"))
    const cdc = await delivery.withAccountingDeadline(time.now, () => cdcRoute(db, provider).GET(request()))
    const maintenance = keepaliveService([{ key: "qbo", keepAliveConnections: () => assert.fail("Must not refresh") }])
    const outbox = await delivery.withAccountingDeadline(time.now, () => outboxRoute(db, maintenance.keepAliveAccountingConnections).GET(request()))
    assert.equal(cdc.status, 207); assert.equal(outbox.status, 207)
    assert.equal((await cdc.json()).budgetExhausted, true); assert.equal((await outbox.json()).budgetExhausted, true)
    await assert.rejects(delivery.withAccountingDeadline(time.now, () => connections(db, api).getQBOAccessTokenForConnection("first")), (error) => error.reason === "deadline" && !error.started)
    assert.equal(db.calls.length, 0)
  } finally { time.restore() }
})

const job = (id) => ({ id, org_id: "org", job_type: "accounting_push_invoice", payload: { invoice_id: `invoice-${id}` }, retry_count: 0 })
test("keepalive lookup failure cannot be green with an empty or populated outbox", async () => {
  for (const jobs of [[], [job(1)]]) {
    const time = clock(), db = database([credential("first")], { failure: (call) => call.operation === "select" ? "fixture lookup unavailable" : null, jobs }), api = auth()
    let delivered = 0
    try {
      const maintenance = keepaliveService([{ key: "qbo", keepAliveConnections: connections(db, api).refreshQBOConnectionsDueForKeepalive }])
      const result = await outboxRoute(db, maintenance.keepAliveAccountingConnections, async () => { delivered += 1; return {} }).GET(request())
      const body = await result.json()
      assert.equal(result.status, 207); assert.equal(body.ok, false); assert.equal(body.keepalive.failed, 1)
      assert.match(body.keepalive.error, /lookup unavailable/); assert.equal(body.processed, jobs.length); assert.equal(delivered, jobs.length)
    } finally { time.restore() }
  }
})

test("stalled keepalive selection and outbox claim abort explicitly", async (t) => {
  for (const phase of ["keepalive", "claim"]) await t.test(phase, async () => {
    const time = clock(), db = database(phase === "keepalive" ? [credential("first")] : [], { stall: (call) => phase === "keepalive" ? call.operation === "select" : call.rpc === "claim_jobs" }), api = auth()
    try {
      const maintenance = keepaliveService([{ key: "qbo", keepAliveConnections: connections(db, api).refreshQBOConnectionsDueForKeepalive }])
      const response = outboxRoute(db, maintenance.keepAliveAccountingConnections).GET(request())
      await time.tick(10_000)
      const result = await response
      assert.equal(result.status, phase === "keepalive" ? 207 : 500)
      const body = await result.json()
      if (phase === "keepalive") assert.equal(body.keepalive.failed, 1)
      else assert.match(body.error, /claim_jobs.*aborted/)
    } finally { time.restore() }
  })
})

test("outbox gives keepalive20s, continues delivery, then releases owned unstarted jobs", async () => {
  const time = clock(), db = database([], { jobs: [job(1), job(2)] }), budgets = [], pushes = []
  try {
    const maintenance = async () => {
      budgets.push(delivery.accountingDeliveryDeadline() - Date.now())
      await new Promise((resolve) => setTimeout(resolve, 20_000))
      return { scanned: 1, refreshed: 0, failed: 1, attempted: 1, deferred: 1, budgetExhausted: true }
    }
    const result = outboxRoute(db, maintenance, async (input) => {
      pushes.push(input)
      assert.equal(input.deadline - Date.now(), 65_000)
      await new Promise((resolve) => setTimeout(resolve, 65_000))
      return {}
    }).GET(request())
    await time.tick(85_000)
    const response = await result, body = await response.json()
    assert.deepEqual(budgets, [20_000]); assert.equal(pushes.length, 1)
    assert.equal(response.status, 207); assert.equal(body.processed, 1); assert.equal(body.deferred, 1); assert.equal(body.budgetExhausted, true)
    const updates = db.calls.filter((call) => call.table === "outbox").map((call) => call.values.status)
    assert.deepEqual(updates, ["completed", "pending"])
  } finally { time.restore() }
})

test("Retry-After seconds and HTTP dates never send before the provider interval", async (t) => {
  for (const format of ["seconds", "date"]) await t.test(format, async () => {
    const time = clock(), Client = client(), calls = []
    try {
      const retry = format === "seconds" ? "120" : new Date(time.now + 120_000).toUTCString()
      global.fetch = async () => { calls.push(Date.now()); return calls.length === 1 ? new Response("", { status: 429, headers: { "retry-after": retry, intuit_tid: "fixture-throttle-tid" } }) : new Response(JSON.stringify({ ok: true })) }
      const response = delivery.withAccountingDeadline(time.now + 200_000, () => new Client("fixture-access", "realm").request("GET", "query"))
      await time.tick(60_000); assert.equal(calls.length, 1)
      await time.tick(59_999); assert.equal(calls.length, 1)
      await time.tick(1); assert.deepEqual(await response, { ok: true })
      assert.equal(calls.length, 2); assert.equal(calls[1] - calls[0], 120_000)
    } finally { time.restore() }
  })
})

test("insufficient Retry-After budget returns typed throttle without sleep or early retry", async () => {
  const time = clock(), Client = client()
  let calls = 0
  try {
    global.fetch = async () => { calls += 1; return new Response("", { status: 429, headers: { "retry-after": "120", intuit_tid: "fixture-throttle-tid" } }) }
    await assert.rejects(delivery.withAccountingDeadline(time.now + 85_000, () => new Client("fixture-access", "realm").request("POST", "invoice", {})), (error) => {
      assert.ok(error instanceof delivery.AccountingDeliveryError); assert.equal(error.retryable, true)
      assert.equal(error.reason, "throttle"); assert.equal(error.status, 429); assert.equal(error.intuitTid, "fixture-throttle-tid")
      return true
    })
    assert.equal(calls, 1)
  } finally { time.restore() }
})

test("uncertain POST failure is never blindly retried; default GET backoff remains bounded", async () => {
  const time = clock(), Client = client(), calls = []
  try {
    global.fetch = async (_url, init) => { calls.push(init.method); throw new Error("fixture network uncertainty") }
    await assert.rejects(new Client("fixture-access", "realm").request("POST", "invoice", {}), /uncertainty/)
    assert.deepEqual(calls, ["POST"])
    calls.length = 0
    const rejected = assert.rejects(delivery.withAccountingDeadline(time.now + 20_000, () => new Client("fixture-access", "realm").request("GET", "query")), /uncertainty/)
    await time.tick(5_250); await rejected
    assert.deepEqual(calls, ["GET", "GET", "GET", "GET"])
  } finally { time.restore() }
})


test("CAS-miss latest credential read shares remaining persistence grace", async () => {
  const time = clock(), api = auth()
  const db = database([credential("first")], {
    latency: (call) => call.values?.refresh_token ? new Promise((resolve) => setTimeout(resolve, 4_900)) : undefined,
    stall: (call) => call.operation === "select" && db.calls.some((prior) => prior.values?.refresh_token),
  })
  try {
    global.fetch = async () => {
      db.rows[0].refresh_token = "fixture-newer-credentials"
      return new Response(JSON.stringify({ access_token: "fixture-new-access", refresh_token: "fixture-new-refresh", expires_in: 3600 }))
    }
    const promise = connections(db, api).refreshQBOConnectionsDueForKeepalive()
    await time.tick(5_000)
    const result = await promise
    assert.equal(result.failed, 1); assert.equal(result.refreshed, 0)
    assert.equal(db.calls.filter((call) => call.operation === "select").length, 2)
    assert.equal(db.rows[0].refresh_token, "fixture-newer-credentials")
    assert.equal(db.rows[0].refresh_failure_count, 0); assert.equal(db.rows[0].status, "active")
  } finally { time.restore() }
})

test("last attempted refresh reports actual budget exhaustion without later deferred rows", async () => {
  const time = clock(), api = auth(), db = database([credential("first")])
  try {
    global.fetch = async (_url, init) => pending(init.signal)
    const response = delivery.withAccountingDeadline(time.now + 10_000, () => connections(db, api).refreshQBOConnectionsDueForKeepalive())
    await time.tick(10_000)
    const result = await response
    assert.equal(result.budgetExhausted, true); assert.equal(result.deferred, 0); assert.equal(result.attempted, 1)
  } finally { time.restore() }
})

test("429 absent, empty, invalid, zero, past and short Retry-After wait at least60s", async (t) => {
  for (const value of [undefined, "", "malformed", "0", "-1", "Wed, 01 Jan 2020 00:00:00 GMT", "1"]) await t.test(String(value), async () => {
    const time = clock(), Client = client(), calls = []
    try {
      global.fetch = async () => {
        calls.push(Date.now())
        return calls.length % 2 === 1 ? new Response("", { status: 429, headers: value === undefined ? {} : { "retry-after": value } }) : new Response(JSON.stringify({ ok: true }))
      }
      const response = delivery.withAccountingDeadline(time.now + 85_000, () => new Client("fixture-access", "realm").request("GET", "query"))
      await time.tick(59_999); assert.equal(calls.length, 1)
      await time.tick(1); assert.deepEqual(await response, { ok: true })
      assert.equal(calls[1] - calls[0], 60_000)
      await assert.rejects(delivery.withAccountingDeadline(time.now + 30_000, () => new Client("fixture-access", "realm").request("GET", "query")), (error) => error.reason === "throttle" && error.status === 429 && error.retryable)
      assert.equal(calls.length, 3)
    } finally { time.restore() }
  })
})
