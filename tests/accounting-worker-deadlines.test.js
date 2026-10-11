const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const Module = require("node:module")
const ts = require("typescript")
const { createClient } = require("@supabase/supabase-js")

function load(file, stubs = {}, extra = "") {
  const filename = path.resolve(__dirname, "..", file)
  const mod = new Module(filename, module)
  mod.filename = filename
  mod.paths = module.paths
  mod.require = (name) => {
    if (Object.hasOwn(stubs, name)) return stubs[name]
    if (name === "server-only") return {}
    if (name === "@/lib/observability/correlation") return { correlatedFetch: (fetchRequest = globalThis.fetch) => fetchRequest, correlationId: async () => "worker-test" }
    if (["@/lib/integrations/accounting/qbo/cdc", "@/lib/integrations/accounting/qbo/cdc-recovery", "@/lib/integrations/accounting/qbo/webhook"].includes(name)) return require("./fixtures/qbo-cdc-runtime").load(`${name.slice(2)}.ts`, stubs)
    if (
      [
        "node:async_hooks",
        "crypto",
        "next/server",
        "@supabase/supabase-js",
        "@supabase/ssr",
      ].includes(name)
    )
      return require(name)
    throw new Error(`Unstubbed worker dependency: ${name}`)
  }
  mod._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8") + extra, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    filename,
  )
  return mod.exports
}
async function flush() {
  for (let i = 0; i < 100; i += 1) await Promise.resolve()
}
function clock() {
  let now = Date.UTC(2026, 9, 5)
  const timers = new Map()
  const saved = {
    now: Date.now,
    setTimeout,
    clearTimeout,
    fetch,
    timeout: AbortSignal.timeout,
  }
  Date.now = () => now
  global.fetch = async () => {
    throw new Error("Unstubbed network forbidden")
  }
  global.setTimeout = (callback, delay = 0) => {
    const handle = {
      ref() {
        return handle
      },
      unref() {
        return handle
      },
      refresh() {
        timers.set(handle, { callback, at: now + delay })
        return handle
      },
    }
    timers.set(handle, { callback, at: now + delay })
    return handle
  }
  global.clearTimeout = (handle) => timers.delete(handle)
  AbortSignal.timeout = (delay) => {
    const controller = new AbortController()
    setTimeout(
      () =>
        controller.abort(new DOMException("Fixture timeout", "TimeoutError")),
      delay,
    )
    return controller.signal
  }
  return {
    get now() {
      return now
    },
    async tick(ms) {
      const target = now + ms
      await flush()
      for (;;) {
        const entry = [...timers]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0]
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
      Date.now = saved.now
      global.setTimeout = saved.setTimeout
      global.clearTimeout = saved.clearTimeout
      global.fetch = saved.fetch
      AbortSignal.timeout = saved.timeout
    },
  }
}
function pending(signal) {
  assert.ok(signal, "request must carry a finite signal")
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason)
    else
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      })
  })
}
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })
}
function stalledBody(onCancel = () => {}) {
  return new Response(new ReadableStream({ cancel: onCancel }), {
    headers: { "content-type": "application/json" },
  })
}
function fixture(cookies = [], missingEnv = false) {
  const context = load("lib/supabase/worker-request-context.ts")
  const clients = load("lib/supabase/service-client-context.ts")
  const saved = {}
  for (const [name, value] of Object.entries({
    NEXT_PUBLIC_SUPABASE_URL: "https://workerfixture.supabase.invalid",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
  })) {
    saved[name] = process.env[name]
    if (missingEnv) delete process.env[name]
    else process.env[name] = value
  }
  const cookieWrites = []
  let server
  try {
    server = load("lib/supabase/server.ts", {
      "@/lib/supabase/worker-request-context": context,
      "@/lib/supabase/service-client-context": clients,
      react: { cache: (work) => work },
      "next/headers": {
        cookies: async () => ({
          getAll: () => cookies,
          set: (...args) => cookieWrites.push(args),
        }),
        headers: async () => new Headers(),
      },
      "next/navigation": { unstable_rethrow() {} },
    })
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
  const common = {
    "@/lib/supabase/server": server,
    "@/lib/supabase/worker-request-context": context,
  }
  const delivery = load("lib/services/accounting-delivery.ts", common)
  common["@/lib/services/accounting-delivery"] = delivery
  const jobs = load("lib/services/job-runs.ts", common)
  const wrapper = load("lib/services/accounting-worker.ts", {
    ...common,
    "@/lib/services/job-runs": jobs,
    "@/lib/services/cron-auth": {
      isAuthorizedCronRequest: (request) => request.authorized !== false,
    },
    "@/lib/supabase/service-client-context": clients,
  })
  const run = (deadline, work, finalDeadline = deadline + 5_000) =>
    context.runWithWorkerDatabaseScope(
      {
        deadline: () => delivery.accountingDeliveryDeadline() ?? deadline,
        finalDeadline,
      },
      () =>
        delivery.withAccountingDeadline(deadline, () =>
          clients.runWithServiceSupabaseClient(
            server.createAccountingWorkerSupabaseClient(),
            work,
          ),
        ),
    )
  return {
    context,
    clients,
    server,
    common,
    delivery,
    wrapper,
    run,
    cookieWrites,
  }
}
const identity = {
  orgId: "org",
  connectionId: "connection",
  entityType: "invoice",
  entityId: "invoice",
}

test("actual SDK nested requests compose caller/tenant deadlines, cancel stalled bodies, and never retry timeout", async (t) => {
  for (const phase of ["headers", "body", "caller", "tenant"])
    await t.test(phase, async () => {
      const time = clock(),
        f = fixture(),
        calls = [],
        caller = new AbortController()
      let cancelled = false
      try {
        global.fetch = async (url, init) => {
          calls.push({ url: String(url), init })
          return phase === "headers"
            ? pending(init.signal)
            : stalledBody(() => {
                cancelled = true
              })
        }
        const operation = f.run(time.now + 85_000, () => {
          const query = () =>
            f.server
              .createServiceSupabaseClient()
              .from("books_settings")
              .select("ledger_authority")
              .abortSignal(caller.signal)
          return phase === "tenant"
            ? f.delivery.withAccountingDeadline(
                time.now + 17,
                async () => await query(),
              )
            : Promise.resolve(query())
        })
        await flush()
        if (phase === "caller") caller.abort(new Error("Fixture caller abort"))
        else await time.tick(phase === "tenant" ? 17 : 10_000)
        const result = await operation
        assert.ok(result.error)
        assert.equal(calls.length, 1)
        assert.equal(calls[0].init.signal.aborted, true)
        if (phase !== "headers") assert.equal(cancelled, true)
      } finally {
        time.restore()
      }
    })
})

test("expired worker and delivery claim dispatch zero SQL, including already-aborted caller", async () => {
  const time = clock(),
    f = fixture(),
    calls = []
  try {
    global.fetch = async (url) => {
      calls.push(url)
      throw new Error("Unexpected HTTP")
    }
    await assert.rejects(
      f.run(time.now - 1, () =>
        f.delivery.withAccountingDelivery(
          identity,
          time.now + 85_000,
          async () => {},
        ),
      ),
      (error) => error.reason === "deadline",
    )
    const result = await f.run(
      time.now - 1,
      async () =>
        await f.server.createServiceSupabaseClient().rpc("claim_jobs"),
    )
    assert.ok(result.error)
    const caller = new AbortController()
    caller.abort()
    await f.run(
      time.now + 85_000,
      async () =>
        await f.server
          .createServiceSupabaseClient()
          .rpc("claim_jobs")
          .abortSignal(caller.signal),
    )
    assert.equal(calls.length, 0)
  } finally {
    time.restore()
  }
})

test("early owned state does not expire later in-budget identity persistence and release", async () => {
  const time = clock(),
    f = fixture(),
    calls = []
  try {
    global.fetch = async (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(init.body),
        signal: init.signal,
      })
      return json(
        String(url).endsWith("claim_accounting_delivery")
          ? "owned-token"
          : true,
      )
    }
    const result = f.run(time.now + 85_000, () =>
      f.delivery.withAccountingDelivery(
        identity,
        time.now + 85_000,
        async () => {
          await f.delivery.persistAccountingDelivery({
            ...identity,
            provider: "qbo",
            status: "pending",
          })
          await time.tick(6_000)
          await f.delivery.persistAccountingDelivery({
            ...identity,
            provider: "qbo",
            externalId: "remote-id",
          })
          return "delivered"
        },
      ),
    )
    assert.deepEqual(await result, { deferred: false, result: "delivered" })
    assert.equal(calls.length, 4)
    assert.equal(calls[2].body.p_external_id, "remote-id")
    assert.ok(calls.every((call) => call.signal))
  } finally {
    time.restore()
  }
})

test("100 acquired leases share final cleanup cutoff and cannot start provider work during SQL grace", async () => {
  const time = clock(),
    f = fixture(),
    calls = []
  try {
    global.fetch = async (url, init) => {
      calls.push({ url: String(url), at: time.now, signal: init.signal })
      return String(url).endsWith("release_accounting_delivery")
        ? pending(init.signal)
        : json("owned-token")
    }
    const start = time.now
    const transport = load(
      "lib/integrations/accounting/qbo/transport.ts",
      f.common,
    )
    const identities = Array.from({ length: 100 }, (_, n) => ({
      ...identity,
      entityId: String(n),
    }))
    let entered, finish
    const acquired = new Promise((resolve) => {
      entered = resolve
    })
    const gate = new Promise((resolve) => {
      finish = resolve
    })
    const result = f.run(start + 85_000, () =>
      f.delivery.withAccountingDeliveryGroup(
        identities,
        start + 85_000,
        async () => {
          entered()
          await gate
          await f.context.withWorkerDatabasePersistence(
            f.context.workerPersistenceDeadline(),
            async () => {
              assert.equal(
                f.delivery.accountingDeliveryDeadline(),
                start + 85_000,
              )
              const before = calls.length
              await assert.rejects(
                transport.withQboResponse(
                  "fixture create",
                  "https://provider.invalid/create",
                  { method: "POST" },
                  async () => true,
                ),
                (error) => error.reason === "deadline" && !error.started,
              )
              assert.equal(calls.length, before)
              await assert.rejects(
                f.delivery.withAccountingDelivery(
                  identity,
                  start + 90_000,
                  async () => {},
                ),
                (error) => error.reason === "deadline",
              )
            },
          )
        },
      ),
    )
    const failure = assert.rejects(result, /release accounting delivery/)
    await acquired
    await time.tick(85_000)
    finish()
    await flush()
    await time.tick(5_000)
    await failure
    assert.equal(
      calls.filter((call) => call.url.endsWith("claim_accounting_delivery"))
        .length,
      100,
    )
    assert.equal(
      calls.filter((call) => call.url.endsWith("release_accounting_delivery"))
        .length,
      1,
    )
    assert.equal(calls.at(-1).signal.aborted, true)
    assert.equal(calls.at(-1).at, start + 85_000)
  } finally {
    time.restore()
  }
})

test("concurrent worker clients and earliest tenant budgets remain isolated", async () => {
  const time = clock(),
    f = fixture(),
    calls = []
  try {
    global.fetch = async (url, init) => {
      calls.push({ url: String(url), signal: init.signal })
      return pending(init.signal)
    }
    const short = f.run(
      time.now + 13,
      async () =>
        await f.server.createServiceSupabaseClient().from("short").select(),
    )
    const long = f.run(
      time.now + 29,
      async () =>
        await f.server.createServiceSupabaseClient().from("long").select(),
    )
    await flush()
    await time.tick(13)
    assert.ok((await short).error)
    assert.equal(calls[0].signal.aborted, true)
    assert.equal(calls[1].signal.aborted, false)
    await time.tick(16)
    assert.ok((await long).error)
    assert.equal(calls[1].signal.aborted, true)
  } finally {
    time.restore()
  }
})

function cdc(f, providerCalls) {
  const authority = load("lib/services/books/authority.ts", f.common)
  return load("lib/integrations/accounting/qbo/reconcile.ts", {
    ...f.common,
    "@/lib/services/books/authority": authority,
    "@/lib/integrations/accounting/qbo/client": {
      QBOClient: {
        forConnection: async () => ({
          changeDataCapture: async () => {
            providerCalls.push("cdc")
            return {
              CDCResponse: [
                {
                  QueryResponse: [
                    {
                      Invoice: [
                        {
                          Id: "remote",
                          MetaData: {
                            LastUpdatedTime: "2026-10-05T00:00:00.000Z",
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            }
          },
        }),
      },
    },
    ...Object.fromEntries(
      [
        "@/lib/integrations/accounting/qbo/import-rules",
        "@/lib/integrations/accounting/local-change",
        "@/lib/financials/ledger-status",
        "@/lib/services/accounting-logger",
        "@/lib/services/events",
        "@/lib/services/invoice-balance",
        "@/lib/services/accounting-sync-attempts",
        "@/lib/services/invoice-numbers",
      ].map((name) => [
        name,
        name.endsWith("accounting-logger") ? { logQBO() {} } : {},
      ]),
    ),
  })
}

test("actual nested CDC connection, authority, run claim and atomic intake/cursor HTTP bodies are bounded", async (t) => {
  for (const phase of [
    "accounting_connections",
    "books_settings",
    "claim_qbo_cdc_run",
    "persist_qbo_cdc_progress",
    "success",
  ])
    await t.test(phase, async () => {
      const time = clock(),
        f = fixture(),
        calls = [],
        providers = [],
        api = cdc(f, providers)
      let reached
      const dispatched = new Promise((resolve) => {
        reached = resolve
      })
      try {
        global.fetch = async (url, init) => {
          const name = new URL(url).pathname.split("/").at(-1)
          calls.push({ name, signal: init.signal })
          if (name === phase) {
            reached()
            return stalledBody()
          }
          if (name === "accounting_connections")
            return json([
              {
                id: "connection",
                org_id: "org",
                external_account_id: "realm",
                settings: {},
              },
            ])
          if (name === "books_settings")
            return json([{ ledger_authority: "external" }])
          const run = { id: "00000000-0000-4000-8000-000000000001", org_id: "org", connection_id: "connection", realm_id: "realm", original_boundary: null, changed_since: new Date(time.now - 86400000).toISOString(), checkpoint: new Date(time.now).toISOString(), reasons: [], status: "open", progress: {}, combined_attempted: false, next_entity: 0, mapped_after: null, mapped_done: false, version: 0, lease_token: "00000000-0000-4000-8000-000000000002" }
          if (name === "claim_qbo_cdc_run") return json(run)
          if (name === "persist_qbo_cdc_progress") {
            const args = JSON.parse(init.body)
            return json({ run: { ...run, status: "complete", lease_token: null, version: 1 }, inserted_ids: args.p_change.events.map(event => event.event_id), summary: { status: "complete" } })
          }
          throw new Error(`Unexpected CDC query ${name}`)
        }
        const operation = f.run(time.now + 85_000, () =>
          f.delivery.withAccountingDeadline(time.now + 7, () =>
            api.ingestQboCdcChanges({ connectionId: "connection" }),
          ),
        )
        if (phase === "success") {
          const result = await operation
          assert.equal(result.scanned, 1)
          assert.equal(result.inserted, 1)
          assert.equal(result.recoveryRequired, false)
        }
        else {
          const failure = assert.rejects(operation)
          await dispatched
          await time.tick(7)
          await failure
          assert.equal(calls.at(-1).signal.aborted, true)
          if (phase !== "persist_qbo_cdc_progress")
            assert.equal(
              calls.some((call) => call.name === "persist_qbo_cdc_progress"),
              false,
            )
        }
        assert.ok(calls.every((call) => call.signal))
        assert.equal(
          providers.length,
          ["accounting_connections", "books_settings", "claim_qbo_cdc_run"].includes(phase) ? 0 : 1,
        )
      } finally {
        time.restore()
      }
    })
})

function events(f, membership, after = [], overrides = {}) {
  return load("lib/services/events.ts", {
    ...f.common,
    "@/lib/auth/context": { requireOrgMembership: membership },
    "@/lib/observability/after-response": {
      afterResponse: (_event, callback) => after.push(callback),
    },
    ...Object.fromEntries(
      [
        "@/lib/services/immutable-record",
        "@/lib/services/context",
        "@/lib/services/notifications",
        "@/lib/services/authorization",
        "@/lib/payments/payable-notification-audience",
        "@/lib/payments/payment-run-approval-policy",
        "@/lib/payments/payment-run-notification-copy",
        "@/lib/payments/operations-monitor",
        "@/lib/services/payment-approver-roster",
      ].map((name) => [name, {}]),
    ),
    ...overrides,
  })
}

function credentialService(f, refresh, eventApi) {
  return load(
    "lib/integrations/accounting/qbo/connections.ts",
    {
      ...f.common,
      "@/lib/integrations/accounting/qbo/transport": {
        QBOTransportError: class QBOTransportError extends Error {},
      },
      "@/lib/integrations/accounting/qbo/auth": {
        getQBOClientId: () => "fixture-client",
        encryptToken: (value) => `encrypted:${value}`,
        decryptToken: (value) => value,
        refreshAccessToken: refresh,
      },
      "@/lib/services/events": eventApi,
      "@/lib/services/accounting-enqueue": {},
      "@/lib/services/accounting-logger": { logQBO() {} },
    },
    "\nexport const testing = { refreshConnectionTokens }\n",
  )
}
const connection = {
  id: "connection",
  org_id: "org",
  external_account_id: "realm",
  client_id: "fixture-client",
  access_token: "fixture-access",
  refresh_token: "fixture-refresh",
  refresh_failure_count: 0,
  token_expires_at: null,
}

test("credential expiry records real nested event under one fixed bounded allowance", async () => {
  const time = clock(),
    f = fixture(),
    calls = []
  try {
    global.fetch = async (url, init) => {
      const name = new URL(url).pathname.split("/").at(-1)
      calls.push({ name, body: init.body, signal: init.signal })
      if (name === "accounting_connections")
        return json({ id: "connection", org_id: "org" })
      if (name === "events") return stalledBody()
      throw new Error(`Unexpected credential query ${name}`)
    }
    const eventApi = events(f, async () => {
      throw new Error("No cron user")
    })
    const api = credentialService(
      f,
      async () => {
        throw new Error("invalid_grant")
      },
      eventApi,
    )
    const operation = f.run(time.now + 85_000, () =>
      api.testing.refreshConnectionTokens(
        f.server.createServiceSupabaseClient(),
        connection,
        { force: true, source: "keepalive" },
      ),
    )
    await time.tick(5_000)
    assert.equal(await operation, null)
    assert.deepEqual(
      calls.map((call) => call.name),
      ["accounting_connections", "events"],
    )
    assert.equal(JSON.parse(calls[0].body).status, "expired")
    assert.equal(calls[1].signal.aborted, true)
  } finally {
    time.restore()
  }
})

test("returned rotated credentials share five-second retry/CAS grace capped by final worker cutoff", async () => {
  const time = clock(),
    f = fixture(),
    calls = []
  try {
    const start = time.now
    let reached
    const dispatched = new Promise((resolve) => {
      reached = resolve
    })
    global.fetch = async (url, init) => {
      calls.push({ url: String(url), body: init.body, signal: init.signal })
      reached()
      return pending(init.signal)
    }
    const api = credentialService(
      f,
      async () => {
        await time.tick(84_999)
        return {
          access_token: "fresh-access",
          refresh_token: "fresh-refresh",
          expires_in: 3600,
        }
      },
      {},
    )
    const operation = f.run(start + 85_000, () =>
      api.testing.refreshConnectionTokens(
        f.server.createServiceSupabaseClient(),
        connection,
        { force: true, source: "keepalive" },
      ),
    )
    await dispatched
    await time.tick(5_000)
    assert.deepEqual(await operation, {
      token: "fresh-access",
      realmId: "realm",
      persisted: false,
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].signal.aborted, true)
    assert.equal(JSON.parse(calls[0].body).refresh_failure_count, 0)
  } finally {
    time.restore()
  }
})

test("actual withCronRun successful, partial and thrown handlers bound telemetry header/body and prune paths", async (t) => {
  for (const mode of ["headers", "success", "partial", "throw", "prune"])
    await t.test(mode, async () => {
      const time = clock(),
        f = fixture(),
        calls = []
      let reached
      const dispatched = new Promise((resolve) => {
        reached = resolve
      })
      try {
        global.fetch = async (url, init) => {
          calls.push({
            url: String(url),
            method: init.method,
            signal: init.signal,
          })
          if (mode === "prune" && init.method === "POST") return json(null)
          reached()
          return mode === "headers" ? pending(init.signal) : stalledBody()
        }
        const handler = async () => {
          await time.tick(85_000)
          if (mode === "throw") throw new Error("Fixture handler error")
          return json({ result: mode }, mode === "partial" ? 207 : 200)
        }
        const operation = f.wrapper.withAccountingWorkerCron(
          "fixture-accounting",
          handler,
        )({})
        await dispatched
        await time.tick(5_000)
        const response = await operation
        assert.equal(response.status, 503)
        assert.equal(calls.at(-1).signal.aborted, true)
        assert.equal(calls.length, mode === "prune" ? 2 : 1)
      } finally {
        time.restore()
      }
    })
})

test("unauthorized accounting wrapper keeps401 with zero service initialization or HTTP", async () => {
  const time = clock(),
    f = fixture([], true),
    calls = []
  try {
    global.fetch = async (url) => {
      calls.push(url)
      throw new Error("Unexpected HTTP")
    }
    const response = await f.wrapper.withAccountingWorkerCron(
      "fixture",
      async () => json({ error: "Unauthorized" }, 401),
    )({ authorized: false })
    assert.equal(response.status, 401)
    assert.equal(calls.length, 0)
  } finally {
    time.restore()
  }
})

test("expired SSR cookie refresh cannot extend the full cron response or delete the legitimate session", async () => {
  const time = clock(),
    calls = []
  const jwt = `${Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub: "fixture-user", exp: Math.floor(time.now / 1000) - 60 })).toString("base64url")}.fixture-signature`
  const session = {
    access_token: jwt,
    refresh_token: "synthetic-session-refresh",
    token_type: "bearer",
    expires_at: Math.floor(time.now / 1000) - 60,
    expires_in: 3600,
    user: { id: "fixture-user" },
  }
  const cookies = [
    {
      name: "sb-workerfixture-auth-token",
      value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`,
    },
  ]
  const f = fixture(cookies)
  let reached
  const dispatched = new Promise((resolve) => {
    reached = resolve
  })
  const originalError = console.error
  const logs = []
  console.error = (...args) => logs.push(args)
  try {
    global.fetch = async (url, init) => {
      calls.push({ url: String(url), signal: init.signal, at: time.now })
      assert.match(String(url), /\/auth\/v1\/token\?grant_type=refresh_token/)
      reached()
      return stalledBody()
    }
    const eventApi = events(f, async () => {
      const userClient = await f.server.createServerSupabaseClient()
      const result = await userClient.auth.getUser()
      if (result.error) throw result.error
      return { user: result.data.user, orgId: "org" }
    })
    const start = time.now
    let startedHandler, continueHandler
    const handlerReady = new Promise((resolve) => {
      startedHandler = resolve
    })
    const handlerGate = new Promise((resolve) => {
      continueHandler = resolve
    })
    const operation = f.wrapper.withAccountingWorkerCron(
      "expired-session-cron",
      async () => {
        startedHandler()
        await handlerGate
        await eventApi.recordEvent({
          orgId: "org",
          eventType: "accounting_connection_expired",
          channel: "notification",
        })
        return json({ done: true })
      },
    )({})
    await handlerReady
    await time.tick(84_000)
    continueHandler()
    for (let i = 0; i < 10 && !calls.length; i += 1) await time.tick(0)
    assert.equal(
      calls.length,
      1,
      "expired SSR cookie must dispatch actual Auth refresh",
    )
    await dispatched
    await time.tick(6_000)
    const response = await operation
    assert.equal(response.status, 503)
    assert.equal(time.now, start + 90_000)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].signal.aborted, true)
    assert.equal(f.cookieWrites.length, 0)
    // Observe the SDK's local retries to completion: every attempted retry is
    // rejected before HTTP, and no deadline is represented as credential401.
    await time.tick(30_000)
    assert.equal(calls.length, 1)
    assert.equal(f.cookieWrites.length, 0)
    assert.ok(logs.length > 0)
  } finally {
    console.error = originalError
    time.restore()
  }
})

function actualExhaustedService(f, eventApi) {
  return load("lib/services/accounting-sync.ts", {
    ...f.common,
    "@/lib/services/accounting-target": {
      resolveAccountingTarget: async () => ({
        connection: { id: "connection", provider: "qbo" },
      }),
    },
    "@/lib/services/events": eventApi,
    ...Object.fromEntries(
      [
        "@/lib/integrations/accounting/local-change",
        "@/lib/services/outbox",
        "@/lib/integrations/accounting/registry",
        "@/lib/services/accounting-rules",
        "@/lib/services/books/authority",
        "@/lib/services/accounting-sync-attempts",
        "@/lib/services/accounting-logger",
        "@/lib/services/audit",
        "@/lib/services/accounting-enqueue",
        "@/lib/services/accounting-job-types",
      ].map((name) => [name, {}]),
    ),
  })
}

test("actual exhausted-state services and owned outbox completion use bounded SQL grace without provider calls", async (t) => {
  for (const stalled of [false, true])
    await t.test(
      stalled ? "interrupted nested state" : "durable nested state",
      async () => {
        const time = clock(),
          f = fixture(),
          calls = [],
          after = []
        const eventApi = events(
          f,
          async () => {
            throw new Error("No cron user")
          },
          after,
        )
        const actual = actualExhaustedService(f, eventApi)
        let reached
        const dispatched = new Promise((resolve) => {
          reached = resolve
        })
        try {
          global.fetch = async (url, init) => {
            const name = new URL(url).pathname.split("/").at(-1)
            calls.push({ name, method: init.method, signal: init.signal })
            if (name === "reap_stale_outbox_jobs")
              return json([{ requeued: 0 }])
            if (name === "reconcile_accounting_exhausted_jobs")
              return json(null)
            if (name === "claim_jobs")
              return json([
                {
                  id: 1,
                  org_id: "org",
                  job_type: "accounting_push_invoice",
                  retry_count: 2,
                  payload: { invoice_id: "invoice" },
                },
              ])
            if (name === "outbox") return json(null)
            if (name === "invoices") return json([{ project_id: "project" }])
            if (name === "accounting_sync_records") {
              if (stalled) {
                reached()
                return stalledBody()
              }
              return json(
                init.method === "GET" ? [{ id: "sync-record" }] : null,
              )
            }
            if (name === "events")
              return json({
                id: "event",
                created_at: "2026-10-05T00:00:00.000Z",
              })
            if (name === "job_runs") return json(null)
            throw new Error(`Unexpected outbound HTTP ${name}`)
          }
          const route = load("app/api/accounting/process-outbox/route.ts", {
            ...f.common,
            "@/lib/services/accounting-worker": f.wrapper,
            "@/lib/services/cron-auth": { isAuthorizedCronRequest: () => true },
            "@/lib/services/accounting-connections": {
              keepAliveAccountingConnections: async () => ({
                scanned: 0,
                refreshed: 0,
                failed: 0,
              }),
            },
            "@/lib/services/accounting-logger": { logAccounting() {} },
            "@/lib/services/accounting-sync": {
              ...actual,
              ACCOUNTING_JOB_TYPES: ["accounting_push_invoice"],
              processAccountingPush: async () => {
                await time.tick(85_000)
                throw new Error("Fixture exhausted delivery")
              },
            },
          })
          const operation = route.GET({})
          if (stalled) {
            await dispatched
            await time.tick(5_000)
            assert.equal((await operation).status, 503)
            assert.equal(calls.at(-1).signal.aborted, true)
            assert.equal(
              calls.some((call) => call.name === "events"),
              false,
            )
          } else {
            assert.equal((await operation).status, 207)
            assert.ok(
              calls.some(
                (call) =>
                  call.name === "accounting_sync_records" &&
                  call.method === "PATCH",
              ),
            )
            assert.ok(calls.some((call) => call.name === "events"))
          }
          assert.ok(calls.every((call) => call.signal))
          assert.equal(
            calls.filter((call) => call.name === "claim_jobs").length,
            1,
          )
        } finally {
          time.restore()
        }
      },
    )
})

test("both actual cron entrypoints preserve401 without service environment", async (t) => {
  for (const name of ["process-changes", "process-outbox"])
    await t.test(name, async () => {
      const time = clock(),
        f = fixture([], true),
        calls = []
      try {
        global.fetch = async (url) => {
          calls.push(url)
          throw new Error("Unexpected HTTP")
        }
        const route = load(`app/api/accounting/${name}/route.ts`, {
          ...f.common,
          "@/lib/services/accounting-worker": f.wrapper,
          "@/lib/services/cron-auth": {
            isAuthorizedCronRequest: (request) => request.authorized !== false,
          },
          "@/lib/services/accounting-logger": {},
          "@/lib/services/accounting-sync": { ACCOUNTING_JOB_TYPES: [] },
          "@/lib/services/accounting-connections": {},
          "@/lib/integrations/accounting/registry": {},
        })
        assert.equal((await route.GET({ authorized: false })).status, 401)
        assert.equal(calls.length, 0)
      } finally {
        time.restore()
      }
    })
})

test("initially exhausted actual accounting cron routes issue zero claims, provider or telemetry HTTP", async (t) => {
  for (const name of ["process-changes", "process-outbox"])
    await t.test(name, async () => {
      const time = clock(),
        f = fixture(),
        calls = []
      const originalError = console.error
      console.error = () => {}
      try {
        global.fetch = async (url) => {
          calls.push(url)
          throw new Error("Unexpected HTTP")
        }
        const route = load(`app/api/accounting/${name}/route.ts`, {
          ...f.common,
          "@/lib/services/accounting-worker": f.wrapper,
          "@/lib/services/cron-auth": { isAuthorizedCronRequest: () => true },
          "@/lib/services/accounting-logger": {},
          "@/lib/services/accounting-sync": { ACCOUNTING_JOB_TYPES: [] },
          "@/lib/services/accounting-connections": {
            keepAliveAccountingConnections: async () => ({
              scanned: 0,
              refreshed: 0,
              failed: 0,
              budgetExhausted: true,
            }),
          },
          "@/lib/integrations/accounting/registry": {},
        })
        const response = await f.delivery.withAccountingDeadline(
          time.now - 100,
          () => route.GET({}),
        )
        assert.equal(response.status, 207)
        assert.equal(calls.length, 0)
      } finally {
        console.error = originalError
        time.restore()
      }
    })
})

test("identity allowance begins once at84s and cannot replenish on86s persistence or cleanup", async () => {
  const time = clock(),
    f = fixture(),
    calls = []
  let reached, firstDone, continueWork
  const firstRequest = new Promise((resolve) => {
    reached = resolve
  })
  const firstPersisted = new Promise((resolve) => {
    firstDone = resolve
  })
  const gate = new Promise((resolve) => {
    continueWork = resolve
  })
  try {
    const start = time.now
    global.fetch = async (url, init) => {
      calls.push({
        name: new URL(url).pathname.split("/").at(-1),
        at: time.now,
        signal: init.signal,
      })
      if (calls.at(-1).name === "claim_accounting_delivery")
        return json("owned-token")
      if (calls.length === 2) return json(true)
      reached()
      return pending(init.signal)
    }
    const operation = f.run(start + 85_000, () =>
      f.delivery.withAccountingDelivery(identity, start + 85_000, async () => {
        await time.tick(84_000)
        await f.delivery.persistAccountingDelivery({
          ...identity,
          provider: "qbo",
          externalId: "remote-id",
        })
        firstDone()
        await gate
        await f.delivery.persistAccountingDelivery({
          ...identity,
          provider: "qbo",
          externalId: "remote-id",
          status: "synced",
        })
      }),
    )
    const failure = assert.rejects(operation, /release accounting delivery/)
    await firstPersisted
    await time.tick(2_000)
    continueWork()
    await firstRequest
    await time.tick(3_000)
    await failure
    assert.equal(time.now, start + 89_000)
    assert.deepEqual(
      calls.map((call) => call.name),
      [
        "claim_accounting_delivery",
        "persist_accounting_delivery",
        "persist_accounting_delivery",
      ],
    )
    assert.equal(calls.at(-1).signal.aborted, true)
  } finally {
    time.restore()
  }
})

test("actual expired SSR refresh abort at10s cannot replay the ambiguous Auth POST inside the remaining worker budget", async () => {
  const time = clock(),
    calls = []
  const jwt = `${Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url")}.${Buffer.from(JSON.stringify({ exp: Math.floor(time.now / 1000) - 60 })).toString("base64url")}.fixture`
  const session = {
    access_token: jwt,
    refresh_token: "synthetic-refresh",
    expires_at: Math.floor(time.now / 1000) - 60,
    expires_in: 3600,
    token_type: "bearer",
    user: { id: "fixture-user" },
  }
  const f = fixture([
    {
      name: "sb-workerfixture-auth-token",
      value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`,
    },
  ])
  let reached
  const dispatched = new Promise((resolve) => {
    reached = resolve
  })
  const savedError = console.error
  console.error = () => {}
  try {
    global.fetch = async (url, init) => {
      calls.push({ url: String(url), signal: init.signal })
      reached()
      return stalledBody()
    }
    const operation = f.run(time.now + 85_000, async () =>
      (await f.server.createServerSupabaseClient()).auth.getUser(),
    )
    for (let i = 0; i < 10 && !calls.length; i += 1) await time.tick(0)
    await dispatched
    await time.tick(30_000)
    const result = await operation
    assert.equal(result.error.name, "AuthRetryableFetchError")
    assert.equal(calls.length, 1)
    assert.equal(calls[0].signal.aborted, true)
    assert.equal(f.cookieWrites.length, 0)
  } finally {
    console.error = savedError
    time.restore()
  }
})

test("actual afterResponse notification callback retains the worker cutoff through the Next-style ALS snapshot", async () => {
  const time = clock(),
    f = fixture(),
    callbacks = [],
    calls = [],
    logs = []
  const { AsyncResource } = require("node:async_hooks")
  try {
    const after = load("lib/observability/after-response.ts", {
      "next/server": {
        after: (callback) => callbacks.push(AsyncResource.bind(callback)),
      },
      "@/lib/logging/logger": {
        logger: { error: (...args) => logs.push(args) },
      },
    })
    const eventApi = events(
      f,
      async () => {
        throw new Error("No cron user")
      },
      [],
      {
        "@/lib/observability/after-response": after,
        "@/lib/services/notifications": {
          NotificationService: class {
            createAndQueue() {
              throw new Error("Unexpected notification write")
            }
          },
        },
      },
    )
    global.fetch = async (url, init) => {
      const name = new URL(url).pathname.split("/").at(-1)
      calls.push({ name, signal: init.signal })
      if (name === "events")
        return json({ id: "event", created_at: "2026-10-05T00:00:00.000Z" })
      if (name === "job_runs") return json(null)
      throw new Error(`Unexpected fanout HTTP ${name}`)
    }
    const response = await f.wrapper.withAccountingWorkerCron(
      "event-cron",
      async () => {
        await eventApi.recordEvent({
          orgId: "org",
          eventType: "accounting_connection_expired",
          channel: "notification",
        })
        return json({ ok: true })
      },
    )({})
    assert.equal(response.status, 200)
    assert.equal(callbacks.length, 1)
    const before = calls.length
    await time.tick(90_000)
    await callbacks[0]()
    assert.equal(calls.length, before)
    assert.equal(logs.length, 0)
  } finally {
    time.restore()
  }
})

test("retained worker clients cannot borrow another worker's persistence allowance", async () => {
  const time = clock(),
    f = fixture(),
    calls = []
  let retained
  try {
    global.fetch = async (url) => {
      calls.push(url)
      return json([])
    }
    await f.run(time.now + 85_000, async () => {
      retained = f.server.createServiceSupabaseClient()
    })
    const result = await f.run(time.now + 85_000, () =>
      f.context.withWorkerDatabasePersistence(
        time.now + 90_000,
        async () => await retained.from("books_settings").select(),
      ),
    )
    assert.ok(result.error)
    assert.match(result.error.message, /outside its owning scope/)
    assert.equal(calls.length, 0)
  } finally {
    time.restore()
  }
})
