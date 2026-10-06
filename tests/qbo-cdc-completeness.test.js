const test = require("node:test")
const assert = require("node:assert/strict")
const { cdcDatabase, id } = require("./fixtures/qbo-cdc-database")
const { runtime, load } = require("./fixtures/qbo-cdc-runtime")
require("../scripts/register-ts-node-test")
const { parseCdcResponse, parseRecoveryPage, CDC_ENTITIES, CdcResponseError } = require("../lib/integrations/accounting/qbo/cdc")
const savedFetch = global.fetch
const time = new Date(Date.now() - 5000).toISOString()
const row = (Id, extra = {}) => ({
  Id: String(Id),
  MetaData: { LastUpdatedTime: time },
  ...extra,
})
const payload = (entities = {}) => ({
  CDCResponse: [{ QueryResponse: [entities] }],
})
test.before(() => {
  global.fetch = async () => {
    throw new Error("Unstubbed fixture fetch")
  }
})
test.after(() => {
  global.fetch = savedFetch
})

test("typed CDC parser validates every group, counts raw cap before dedupe, and preserves precise deletion identities", () => {
  const checkpoint = new Date().toISOString()
  for (const count of [0, 999, 1000, 1001]) {
    const response = {
      CDCResponse: [
        {
          QueryResponse: [
            {
              Invoice: Array.from({ length: Math.min(count, 500) }, (_, i) => row(i)),
            },
          ],
        },
        {
          QueryResponse: [
            {
              Payment: Array.from({ length: Math.max(count - 500, 0) }, (_, i) => row(i)),
            },
          ],
        },
      ],
    }
    const result = parseCdcResponse(response, CDC_ENTITIES, "realm", checkpoint)
    assert.equal(result.rawCount, count)
    assert.equal(result.complete, count < 1000)
  }
  assert.equal(parseCdcResponse({ CDCResponse: [{}] }, CDC_ENTITIES, "realm", checkpoint).complete, true)
  assert.equal(parseCdcResponse({ CDCResponse: [{ size: 9, QueryResponse: [] }] }, CDC_ENTITIES, "realm", checkpoint).complete, false)
  assert.equal(
    parseCdcResponse(
      payload({
        Invoice: Array.from({ length: 1000 }, () => row("duplicate")),
      }),
      CDC_ENTITIES,
      "realm",
      checkpoint,
    ).complete,
    false,
  )
  const result = parseCdcResponse(
    {
      CDCResponse: [
        {
          QueryResponse: [
            {
              Invoice: [
                row(1, {
                  MetaData: { LastUpdatedTime: "2026-01-01T00:00:00.123456Z" },
                }),
              ],
            },
          ],
        },
        {
          QueryResponse: [
            {
              Invoice: [
                row(1, {
                  status: "Deleted",
                  MetaData: {
                    LastUpdatedTime: "2025-12-31T19:00:00.123457-05:00",
                  },
                }),
              ],
            },
          ],
        },
      ],
    },
    CDC_ENTITIES,
    "realm",
    checkpoint,
  )
  assert.match(result.rows[0].eventId, /\.123456Z$/)
  assert.match(result.rows[1].eventId, /:Delete:2026-01-01T00:00:00\.123457Z$/)
  for (const value of [
    {},
    { CDCResponse: [] },
    { CDCResponse: [{ Fault: {} }] },
    { CDCResponse: [{ QueryResponse: [{ Invoice: { Id: "bad" } }] }] },
    { CDCResponse: [{ QueryResponse: [{ Invoice: [{ Id: "" }] }] }] },
    { CDCResponse: [{ QueryResponse: [], warning: "truncated" }] },
    { CDCResponse: [{ QueryResponse: [{ Fault: {} }] }] },
  ])
    assert.throws(() => parseCdcResponse(value, CDC_ENTITIES, "realm", checkpoint))
  for (const hints of [{ startPosition: 2 }, { maxResults: 0 }, { maxResults: 2 }, { totalCount: 2 }])
    assert.equal(parseCdcResponse(payload({ Invoice: [row(1)], ...hints }), CDC_ENTITIES, "realm", checkpoint).complete, false)
})

test("recovery query proof rejects malformed, duplicate and short-but-truncated pages", () => {
  for (const value of [
    {},
    { QueryResponse: { Invoice: [{ Id: "1" }], maxResults: 2, totalCount: 1 } },
    { QueryResponse: { Invoice: [{ Id: "1" }], maxResults: 0, totalCount: 1 } },
    {
      QueryResponse: {
        Invoice: [{ Id: "1" }],
        startPosition: 1,
        maxResults: 1,
        totalCount: 10,
      },
    },
    { QueryResponse: { Invoice: [{ Id: "1" }, { Id: "1" }] } },
    { QueryResponse: { Fault: {} } },
    { QueryResponse: { Invoice: [{ Id: 1 }] } },
  ])
    assert.throws(() => parseRecoveryPage(value, "Invoice", 1, 200))
  assert.equal(parseRecoveryPage({ QueryResponse: {} }, "Invoice", 1, 200).done, true)
  assert.equal(parseRecoveryPage({ QueryResponse: { Invoice: [{ Id: "1" }], totalCount: 1 } }, "Invoice", 1, 200).done, true)
})

test("actual facade and exact SQL retain signed webhook terminal dedupe and truthful new work counts", async (t) => {
  const f = await cdcDatabase(t)
  await f.install()
  const client = {
    changeDataCapture: async () => payload({ Invoice: [row("42")] }),
  }
  const r = runtime(f, client)
  const webhook = require("../lib/integrations/accounting/qbo/webhook")
  const body = JSON.stringify([
    {
      specversion: "1.0",
      type: "qbo.invoice.updated.v1",
      id: "receipt",
      intuitaccountid: "realm",
      intuitentityid: "42",
      time,
    },
  ])
  const signature = webhook.computeIntuitWebhookSignature(body, "fixture-verifier")
  const savedToken = process.env.QBO_WEBHOOK_VERIFIER_TOKEN
  process.env.QBO_WEBHOOK_VERIFIER_TOKEN = "fixture-verifier"
  try {
    const first = await r.api.receiveQboWebhook({
      rawBody: body,
      headers: { "intuit-signature": signature },
    })
    assert.equal(first.inserted, 1)
  } finally {
    if (savedToken === undefined) delete process.env.QBO_WEBHOOK_VERIFIER_TOKEN
    else process.env.QBO_WEBHOOK_VERIFIER_TOKEN = savedToken
  }
  await f.db.exec("update qbo_webhook_events set process_status='completed',attempts=4,process_error='retained',processed_at=now()")
  const result = await r.api.ingestQboCdcChanges({
    connectionId: f.connection,
  })
  assert.equal(result.scanned, 1)
  assert.equal(result.inserted, 0)
  assert.equal(result.recoveryRequired, false)
  const [stored] = await f.queue()
  assert.equal(stored.process_status, "completed")
  assert.equal(stored.attempts, 4)
  assert.deepEqual(stored.provider_event_ids, ["receipt"])
  const settings = await f.settings()
  const claim = r.calls.find((call) => call.rpc === "claim_qbo_cdc_run")
  assert.equal(Date.parse(settings.qbo_cdc_last_synced_at), Date.parse(claim.args.p_checkpoint))
  assert.equal(settings.manual_setting, true)
})

test("combined cap recovers through all sub-cap entity calls at pre-request checkpoint", async (t) => {
  const f = await cdcDatabase(t)
  await f.install()
  const requests = []
  const invoices = Array.from({ length: 500 }, (_, i) => row(`i${i}`))
  const payments = Array.from({ length: 500 }, (_, i) => row(`p${i}`))
  const r = runtime(f, {
    changeDataCapture: async (entities, since) => {
      requests.push({ entities, since })
      return payload(
        Object.fromEntries(
          entities
            .filter((entity) => entity === "Invoice" || entity === "Payment")
            .map((entity) => [entity, entity === "Invoice" ? invoices : payments]),
        ),
      )
    },
  })
  const result = await r.api.ingestQboCdcChanges({
    connectionId: f.connection,
  })
  assert.equal(result.scanned, 2000)
  assert.equal(result.inserted, 1000)
  assert.equal(result.recoveryRequired, false)
  assert.equal(requests.length, 8)
  assert.deepEqual(
    requests.slice(1).map((request) => request.entities[0]),
    CDC_ENTITIES,
  )
  assert.equal((await f.queue()).length, 1000)
  assert.equal(
    Date.parse((await f.settings()).qbo_cdc_last_synced_at),
    Date.parse(r.calls.find((call) => call.rpc === "claim_qbo_cdc_run").args.p_checkpoint),
  )
})

test("in-request edits remain eligible next overlap without forcing a quiet-company recovery", async (t) => {
  const f = await cdcDatabase(t)
  await f.install()
  const starts = [],
    inputs = []
  const r = runtime(f, {
    changeDataCapture: async (_entities, since) => {
      inputs.push(since)
      const claim = r.calls.filter((call) => call.rpc === "claim_qbo_cdc_run").at(-1)
      starts.push(Date.parse(claim.args.p_checkpoint))
      return payload({
        Invoice: [
          row("in-flight", {
            MetaData: {
              LastUpdatedTime: new Date(starts[0] + 100).toISOString(),
            },
          }),
        ],
      })
    },
  })
  const first = await r.api.ingestQboCdcChanges({ connectionId: f.connection })
  assert.equal(first.recoveryRequired, false)
  assert.equal(Date.parse((await f.settings()).qbo_cdc_last_synced_at), starts[0])
  const second = await r.api.ingestQboCdcChanges({
    connectionId: f.connection,
  })
  assert.equal(second.inserted, 0)
  assert.equal(Date.parse(inputs[1]), starts[0] - 5 * 60000)
  assert.ok(Date.parse(inputs[1]) < starts[0] + 100)
})

test("invalid, future and lost-window checkpoints preserve original evidence and still collect current observations", async (t) => {
  for (const original of [
    "2026-09-31T12:00:00.000Z",
    "2026-09-01",
    "2026-09-01T12:00:00",
    "not-a-date",
    new Date(Date.now() + 86400000).toISOString(),
    new Date(Date.now() - 35 * 86400000).toISOString(),
  ])
    await t.test(original, async (t) => {
      const f = await cdcDatabase(t)
      await f.install()
      await f.db.query(
        "update accounting_connections set settings=settings||jsonb_build_object('qbo_cdc_last_synced_at',$1::text) where id=$2",
        [original, f.connection],
      )
      const requests = []
      const r = runtime(f, {
        changeDataCapture: async (_entities, since) => {
          requests.push(since)
          return payload()
        },
        queryRecoveryPage: async () => ({ rows: [], done: true, total: 0 }),
      })
      const result = await r.api.ingestQboCdcChanges({
        connectionId: f.connection,
      })
      assert.equal(result.recoveryRequired, true)
      const settings = await f.settings()
      assert.equal(settings.qbo_cdc_last_synced_at, original)
      assert.equal(settings.qbo_cdc_recovery.original_boundary, original)
      assert.equal(settings.qbo_cdc_recovery.status, "required")
      const claim = r.calls.find((call) => call.rpc === "claim_qbo_cdc_run")
      assert.ok(Date.parse(requests[0]) <= Date.parse(claim.args.p_checkpoint))
      assert.ok(Date.parse(requests[0]) >= Date.parse(claim.args.p_checkpoint) - 29 * 86400000)
      const expected =
        original === "2026-09-31T12:00:00.000Z" || !original.includes("T") || !original.endsWith("Z")
          ? "invalid_cursor"
          : Date.parse(original) > Date.now()
            ? "future_cursor"
            : "lost_window"
      assert.ok(result.recoveryReasons.includes(expected))
    })
})

test("malformed combined and poison entity responses durably rotate later CDC types and resumable enumeration", async (t) => {
  const f = await cdcDatabase(t)
  await f.install()
  const cdcCalls = [],
    pages = []
  const r = runtime(f, {
    changeDataCapture: async (entities, since) => {
      cdcCalls.push({ entities, since })
      return entities.length > 1 || entities[0] === "Invoice" ? {} : payload(entities[0] === "Bill" ? { Bill: [row("healthy")] } : {})
    },
    queryRecoveryPage: async (entity, start) => {
      pages.push({ entity, start })
      return entity === "Invoice"
        ? Promise.reject(new CdcResponseError("Invalid QBO recovery query envelope"))
        : {
            rows: entity === "Payment" ? [row("candidate")] : [],
            done: true,
            total: null,
          }
    },
    readRecoveryEntity: async () => {
      throw new Error("Unexpected direct read")
    },
  })
  const first = await r.api.ingestQboCdcChanges({ connectionId: f.connection })
  assert.equal(first.recoveryRequired, true)
  assert.ok(first.recoveryReasons.includes("malformed_response"))
  assert.ok((await f.queue()).some((record) => record.entity_qbo_id === "healthy"))
  for (let attempt = 0; attempt < 4; attempt += 1) await r.api.ingestQboCdcChanges({ connectionId: f.connection })
  assert.equal(cdcCalls.filter((call) => call.entities.length > 1).length, 1, "bad combined envelope is not replayed forever")
  assert.ok(
    pages.some((page) => page.entity === "Payment"),
    "poison Invoice page cannot starve later enumeration",
  )
  assert.ok((await f.candidates()).some((candidate) => candidate.external_id === "candidate"))
  assert.equal((await f.settings()).qbo_cdc_recovery.status, "required")
})

test("permanently saturated single entity keeps newer edits eligible while historic gap and query progress survive", async (t) => {
  const f = await cdcDatabase(t)
  await f.install()
  const requests = [],
    pages = []
  let cycle = 0
  const r = runtime(f, {
    changeDataCapture: async (entities, since) => {
      requests.push({ entities, since })
      const include = entities.includes("Invoice")
      const current = cycle ? "new-change" : "cap-old"
      return payload(include ? { Invoice: Array.from({ length: 1000 }, () => row(current)) } : {})
    },
    queryRecoveryPage: async (entity, start) => {
      pages.push({ entity, start })
      return {
        rows: entity === "Invoice" ? [row("candidate-new")] : [],
        done: true,
        total: null,
      }
    },
    readRecoveryEntity: async () => {
      throw new Error("Unexpected direct read")
    },
  })
  const first = await r.api.ingestQboCdcChanges({ connectionId: f.connection })
  const settings = await f.settings()
  const boundary = Date.parse(settings.qbo_cdc_observation_start)
  cycle = 1
  const second = await r.api.ingestQboCdcChanges({
    connectionId: f.connection,
  })
  assert.equal(first.recoveryRequired, true)
  assert.equal(second.recoveryRequired, true)
  assert.ok(requests.slice(8).every((request) => Date.parse(request.since) === boundary - 5 * 60000))
  assert.ok((await f.queue()).some((record) => record.entity_qbo_id === "new-change"))
  assert.ok(pages.length > 0)
  assert.equal((await f.settings()).qbo_cdc_last_synced_at, undefined)
  assert.equal((await f.settings()).qbo_cdc_recovery.run_id, first.runId)
})

test("failed intake or candidate persistence cannot advance a cursor/page, and exhausted invocation starts no provider work", async (t) => {
  const f = await cdcDatabase(t)
  await f.install()
  const r = runtime(
    f,
    { changeDataCapture: async () => payload({ Invoice: [row("stored")] }) },
    {
      failure: (call) => (call.rpc === "persist_qbo_cdc_progress" ? "synthetic storage failure" : null),
    },
  )
  await assert.rejects(r.api.ingestQboCdcChanges({ connectionId: f.connection }), /storage failure/)
  assert.equal((await f.queue()).length, 0)
  assert.equal((await f.settings()).qbo_cdc_last_synced_at, undefined)
  const empty = runtime(
    f,
    {
      changeDataCapture: async () => {
        throw new Error("Unexpected provider")
      },
    },
    { deadline: () => Date.now() - 1 },
  )
  const result = await empty.api.ingestQboCdcChanges({
    connectionId: f.connection,
  })
  assert.equal(result.deferred, true)
  assert.equal(empty.calls.filter((call) => call.rpc).length, 0)
})

test("actual QBO request/query/read methods reject false empties and confirm absence only through supported direct faults", async () => {
  const inert = {
    from() {
      throw new Error("Unexpected DB")
    },
    rpc() {
      throw new Error("Unexpected DB")
    },
  }
  const delivery = load("lib/services/accounting-delivery.ts", {
    "@/lib/supabase/server": { createServiceSupabaseClient: () => inert },
  })
  const transport = load("lib/integrations/accounting/qbo/transport.ts", {
    "@/lib/services/accounting-delivery": delivery,
  })
  const { QBOClient } = load("lib/integrations/accounting/qbo/client.ts", {
    "@/lib/services/accounting-delivery": delivery,
    "@/lib/integrations/accounting/qbo/transport": transport,
    "@/lib/integrations/accounting/qbo/connections": {},
    "@/lib/services/accounting-logger": { logQBO() {} },
    "@/lib/integrations/accounting/qbo/config": {
      qboCompanyBaseUrl: "https://provider-fixture.invalid",
      qboEnvironmentLabel: "fixture",
    },
  })
  const client = new QBOClient("synthetic-access", "realm")
  const calls = []
  let response = {},
    status = 200
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, signal: init.signal })
    return new Response(JSON.stringify(response), {
      status,
      headers: { "content-type": "application/json" },
    })
  }
  try {
    assert.deepEqual(await client.listTransactionsForImport("Invoice"), [], "pre-fix permissive importer is not a proof source")
    await assert.rejects(client.queryRecoveryPage("Invoice", 1, 200), /envelope|response/)
    assert.equal(await client.getInvoiceById("42"), null, "old optional reader is not absence evidence")
    await assert.rejects(client.readRecoveryEntity("Invoice", "42"), /recovery read entity/)
    response = {
      QueryResponse: {
        Invoice: [row("42")],
        startPosition: 1,
        maxResults: 1,
        totalCount: 10,
      },
    }
    await assert.rejects(client.queryRecoveryPage("Invoice", 1, 200), /Contradictory/)
    response = { Invoice: row("wrong") }
    await assert.rejects(client.readRecoveryEntity("Invoice", "42"), /Mismatched/)
    response = {
      Fault: {
        type: "ValidationFault",
        Error: [{ code: "610", Message: "Object Not Found" }],
      },
    }
    status = 400
    assert.equal(await client.readRecoveryEntity("Invoice", "42"), null)
    response = {
      Fault: {
        type: "ValidationFault",
        Error: [{ code: "5010", Message: "Stale Object" }],
      },
    }
    await assert.rejects(client.readRecoveryEntity("Invoice", "42"))
    assert.ok(calls.every((call) => call.signal && call.method === "GET"))
    assert.ok(calls.some((call) => decodeURIComponent(call.url).includes("SELECT * FROM Invoice STARTPOSITION 1 MAXRESULTS 200")))
    assert.ok(calls.every((call) => !call.url.includes("changedUntil")))
  } finally {
    global.fetch = async () => {
      throw new Error("Unstubbed fixture fetch")
    }
  }
})

test("typed malformed mapped read rotates durable investigation while later identity is recovered", async (t) => {
  const f = await cdcDatabase(t)
  await f.install()
  await f.db.query(
    "update accounting_connections set settings=settings||jsonb_build_object('qbo_cdc_last_synced_at',$1::text) where id=$2",
    [new Date(Date.now() - 35 * 86400000).toISOString(), f.connection],
  )
  for (const [mapping, external] of [
    [301, "poison"],
    [302, "healthy"],
  ]) {
    await f.db.query(
      "insert into accounting_sync_records(id,org_id,connection_id,provider,entity_type,entity_id,external_id,metadata) values($1,$2,$3,'qbo','invoice',$4,$5,'{\"external_entity_type\":\"Invoice\"}')",
      [id(mapping), f.org, f.connection, id(mapping + 100), external],
    )
  }
  const reads = []
  const r = runtime(f, {
    changeDataCapture: async () => payload(),
    queryRecoveryPage: async () => ({ rows: [], done: true, total: 0 }),
    readRecoveryEntity: async (_entity, external) => {
      reads.push(external)
      if (external === "poison") throw new CdcResponseError("Mismatched QBO recovery entity identity")
      return row(external)
    },
  })
  let result
  for (let invocation = 0; invocation < 12; invocation++) result = await r.api.ingestQboCdcChanges({ connectionId: f.connection })
  assert.deepEqual(reads, ["poison", "healthy"])
  assert.equal(result.recoveryRequired, true)
  assert.equal(result.currentScanComplete, false)
  const events = await f.queue()
  assert.equal(events.find((event) => event.entity_qbo_id === "poison").process_status, "investigation")
  assert.equal(events.find((event) => event.entity_qbo_id === "healthy").process_status, "pending")
  const gap = (await f.settings()).qbo_cdc_recovery
  assert.equal(gap.mapped_failure_count, 1)
  assert.equal(gap.mapped_failures[0].mapping_id, id(301))
  assert.equal(gap.status, "required")
  assert.equal((await f.settings()).qbo_cdc_last_synced_at, gap.original_boundary)
})

test("mapped auth/transport failure retains identity retry eligibility without investigation or Delete", async (t) => {
  const f = await cdcDatabase(t)
  await f.install()
  await f.db.query(
    "update accounting_connections set settings=settings||jsonb_build_object('qbo_cdc_last_synced_at',$1::text) where id=$2",
    [new Date(Date.now() - 35 * 86400000).toISOString(), f.connection],
  )
  await f.db.query(
    "insert into accounting_sync_records(id,org_id,connection_id,provider,entity_type,entity_id,external_id) values($1,$2,$3,'qbo','invoice',$4,'retryable')",
    [id(301), f.org, f.connection, id(401)],
  )
  let fail = true
  const reads = []
  const r = runtime(f, {
    changeDataCapture: async () => payload(),
    queryRecoveryPage: async () => ({ rows: [], done: true, total: 0 }),
    readRecoveryEntity: async (_entity, external) => {
      reads.push(external)
      if (fail) throw new Error("Synthetic transport unavailable")
      return row(external)
    },
  })
  let rejected = false
  for (let n = 0; n < 12 && !rejected; n++)
    try {
      await r.api.ingestQboCdcChanges({ connectionId: f.connection })
    } catch (error) {
      assert.match(error.message, /transport unavailable/)
      rejected = true
    }
  assert.equal(rejected, true)
  assert.equal((await f.queue()).length, 0)
  const before = (await f.db.query("select mapped_after,mapped_failure_count from qbo_cdc_runs")).rows[0]
  assert.equal(before.mapped_after, null)
  assert.equal(before.mapped_failure_count, 0)
  await f.db.exec("update qbo_cdc_runs set lease_until=now()-interval '1 second'")
  fail = false
  await r.api.ingestQboCdcChanges({ connectionId: f.connection })
  assert.deepEqual(reads, ["retryable", "retryable"])
  assert.equal((await f.queue())[0].operation, "Update")
  assert.equal((await f.queue())[0].process_status, "pending")
})

test("active QBO connection without a client is a visible cron failure, while inactive/Arc no-ops remain", async (t) => {
  const f = await cdcDatabase(t)
  await f.install()
  const r = runtime(f, null)
  await assert.rejects(r.api.ingestQboCdcChanges({ connectionId: f.connection }), /client is unavailable/)
  assert.equal(r.calls.filter((call) => call.rpc).length, 0)
  const writes = []
  const db = {
    from() {
      let mutation
      const q = {
        select() {
          return q
        },
        eq() {
          return q
        },
        in() {
          return q
        },
        order() {
          return q
        },
        limit() {
          return q
        },
        abortSignal() {
          return q
        },
        update(value) {
          mutation = value
          return q
        },
        then(resolve, reject) {
          return Promise.resolve({ data: mutation ? null : [{ id: f.connection, org_id: f.org, provider: "qbo" }], error: null })
            .then((result) => {
              if (mutation) writes.push(mutation)
              return result
            })
            .then(resolve, reject)
        },
      }
      return q
    },
  }
  const provider = { key: "qbo", capabilities: { supportsCDC: true }, ingestChanges: r.api.ingestQboCdcChanges }
  const route = load("app/api/accounting/process-changes/route.ts", {
    "@/lib/supabase/server": { createServiceSupabaseClient: () => db },
    "@/lib/services/accounting-delivery": {
      accountingDeliveryDeadline: () => undefined,
      withAccountingDeadline: (_deadline, work) => work(),
    },
    "@/lib/services/accounting-worker": { withAccountingWorkerCron: (_name, work) => work },
    "@/lib/services/cron-auth": { isAuthorizedCronRequest: () => true },
    "@/lib/integrations/accounting/registry": {
      listProviders: () => [provider],
      getProvider: () => provider,
      isAccountingProviderKey: (key) => key === "qbo",
    },
    "@/lib/services/accounting-logger": { logAccounting() {} },
  })
  const response = await route.GET({ nextUrl: new URL("http://fixture.invalid") })
  assert.equal(response.status, 207)
  assert.equal((await response.json()).failedConnections, 1)
  assert.ok(writes.some((write) => write.last_error?.includes("client is unavailable")))
  assert.equal(r.calls.filter((call) => call.rpc).length, 0)
  assert.equal((await f.queue()).length, 0)
  assert.equal((await f.settings()).qbo_cdc_last_synced_at, undefined)
  const arc = load("lib/integrations/accounting/qbo/reconcile.ts", {
    ...r.stubs,
    "@/lib/services/books/authority": { resolveLedgerAuthority: async () => "arc" },
  })
  assert.equal((await arc.ingestQboCdcChanges({ connectionId: f.connection })).deferred, false)
  await f.db.query("update accounting_connections set status='expired' where id=$1", [f.connection])
  assert.equal((await r.api.ingestQboCdcChanges({ connectionId: f.connection })).scanned, 0)
})

test("documented top-level time is accepted but unknown warning/truncation envelopes cannot prove completeness", () => {
  assert.equal(parseCdcResponse({ CDCResponse: [{}], time }, CDC_ENTITIES, "realm", time).complete, true)
  assert.equal(parseRecoveryPage({ QueryResponse: {}, time }, "Invoice", 1, 200).done, true)
  for (const extra of [{ Warning: [] }, { truncated: true }, { foreign: {} }]) {
    assert.throws(() => parseCdcResponse({ CDCResponse: [{}], ...extra }, CDC_ENTITIES, "realm", time), CdcResponseError)
    assert.throws(() => parseRecoveryPage({ QueryResponse: {}, ...extra }, "Invoice", 1, 200), CdcResponseError)
  }
})

test("malformed enumeration rows cannot starve healthy mapped recovery across bounded phase turns", async (t) => {
  for (const bad of [{ MetaData: 42 }, { status: "Unsupported" }])
    await t.test(JSON.stringify(bad), async (t) => {
      const f = await cdcDatabase(t)
      await f.install()
      await f.db.query(
        "update accounting_connections set settings=settings||jsonb_build_object('qbo_cdc_last_synced_at',$1::text) where id=$2",
        [new Date(Date.now() - 35 * 86400000).toISOString(), f.connection],
      )
      await f.db.query(
        "insert into accounting_sync_records(id,org_id,connection_id,provider,entity_type,entity_id,external_id) values($1,$2,$3,'qbo','invoice',$4,'healthy')",
        [id(301), f.org, f.connection, id(401)],
      )
      const reads = [],
        pages = []
      const r = runtime(f, {
        changeDataCapture: async () => payload(),
        queryRecoveryPage: async (entity) => {
          pages.push(entity)
          return { rows: entity === "Invoice" ? [{ Id: "poison", ...bad }] : [], done: true, total: null }
        },
        readRecoveryEntity: async (_entity, external) => {
          reads.push(external)
          return row(external)
        },
      })
      let outcome
      for (let n = 0; n < 12; n++) outcome = await r.api.ingestQboCdcChanges({ connectionId: f.connection })
      assert.deepEqual(reads, ["healthy"])
      assert.ok(pages.includes("Invoice"))
      assert.equal(outcome.recoveryRequired, true)
      assert.equal(outcome.currentScanComplete, false)
      const stored = (await f.db.query("select progress,mapped_after,mapped_done from qbo_cdc_runs")).rows[0]
      assert.equal(stored.progress.Invoice.enumeration_position, undefined)
      assert.notEqual(stored.progress.Invoice.enumeration_done, true)
      assert.equal(stored.mapped_after, id(301))
      assert.equal(stored.mapped_done, true)
      assert.equal((await f.queue())[0].entity_qbo_id, "healthy")
      assert.ok((await f.settings()).qbo_cdc_recovery.reasons.includes("malformed_response"))
    })
})

test("unclassified mappings remain an incomplete current scan while later supported mappings are reached", async (t) => {
  const f = await cdcDatabase(t)
  await f.install()
  await f.db.query(
    "update accounting_connections set settings=settings||jsonb_build_object('qbo_cdc_last_synced_at',$1::text) where id=$2",
    [new Date(Date.now() - 35 * 86400000).toISOString(), f.connection],
  )
  for (const [n, external, namespace] of [
    [301, "unknown", "Unsupported"],
    [302, "known", "Invoice"],
  ])
    await f.db.query(
      "insert into accounting_sync_records(id,org_id,connection_id,provider,entity_type,entity_id,external_id,metadata) values($1,$2,$3,'qbo','invoice',$4,$5,$6)",
      [id(n), f.org, f.connection, id(n + 100), external, JSON.stringify({ external_entity_type: namespace })],
    )
  const reads = []
  const r = runtime(f, {
    changeDataCapture: async () => payload(),
    queryRecoveryPage: async () => ({ rows: [], done: true, total: 0 }),
    readRecoveryEntity: async (_entity, external) => {
      reads.push(external)
      return row(external)
    },
  })
  let result
  for (let n = 0; n < 16; n++) result = await r.api.ingestQboCdcChanges({ connectionId: f.connection })
  assert.deepEqual(reads, ["known"])
  assert.equal(result.recoveryRequired, true)
  assert.equal(result.currentScanComplete, false)
  assert.equal(result.deferred, true)
  assert.ok(result.recoveryReasons.includes("unclassified_mapping"))
})
