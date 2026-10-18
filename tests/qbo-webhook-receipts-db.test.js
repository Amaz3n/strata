const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const Module = require("node:module")
const ts = require("typescript")
const { PGlite } = require("@electric-sql/pglite")
require("../scripts/register-ts-node-test")
const webhook = require("../lib/integrations/accounting/qbo/webhook")
const savedFetch = global.fetch
test.before(() => {
  global.fetch = async () => {
    throw new Error("Unstubbed fixture fetch")
  }
})
test.after(() => {
  global.fetch = savedFetch
})
const migration = fs.readFileSync(
  "supabase/migrations/20261005040538_qbo_webhook_provider_receipts.sql",
  "utf8",
)
const snapshot = fs.readFileSync(
  "supabase/migrations/20260517092101_remote_schema.sql",
  "utf8",
)
const retries = fs.readFileSync(
  "supabase/migrations/20260715200002_qbo_inbound_reconcile_retry.sql",
  "utf8",
)
const TIME = "2026-02-12T14:30:00.000Z",
  HASH = "a".repeat(64)
const event = (extra = {}) => ({
  event_id: `realm:Invoice:77:Update:${TIME}`,
  realm_id: "realm",
  entity_name: "Invoice",
  entity_qbo_id: "77",
  operation: "Update",
  last_updated: TIME,
  ...extra,
})
async function database(t) {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create function auth.role() returns text language sql as $$select current_user::text$$;
    grant usage on schema public,auth to anon,authenticated,service_role;`)
  await db.exec(
    snapshot.match(
      /CREATE TABLE IF NOT EXISTS "public"\."qbo_webhook_events" \([\s\S]*?\n\);/,
    )[0],
  )
  for (const sql of snapshot.matchAll(
    /ALTER TABLE ONLY "public"\."qbo_webhook_events"[\s\S]*?;/g,
  ))
    await db.exec(sql[0])
  await db.exec(
    snapshot.match(
      /ALTER TABLE "public"\."qbo_webhook_events" ENABLE ROW LEVEL SECURITY;/,
    )[0],
  )
  await db.exec(
    snapshot.match(/CREATE POLICY "qbo_webhook_events_access"[^;]*;/)[0],
  )
  for (const sql of snapshot.matchAll(
    /GRANT ALL ON TABLE "public"\."qbo_webhook_events"[^;]*;/g,
  ))
    await db.exec(sql[0])
  await db.exec(
    retries.match(/alter table public\.qbo_webhook_events[\s\S]*?;/)[0],
  )
  await db.exec(
    retries.match(
      /create index if not exists qbo_webhook_events_retry_idx[\s\S]*?;/,
    )[0],
  )
  await db.exec(
    "grant update(payload_hash),select(payload_hash) on qbo_webhook_events to authenticated; grant update(process_error) on qbo_webhook_events to public",
  )
  assert.equal(
    (
      await db.query(
        "select to_regprocedure('public.intake_qbo_webhook_events(jsonb,text)') routine",
      )
    ).rows[0].routine,
    null,
  )
  const f = {
    db,
    install: () => db.exec(migration),
    async role(role, fn) {
      await db.exec(`set role ${role}`)
      try {
        return await fn()
      } finally {
        await db.exec("reset role")
      }
    },
    async intake(events, hash = HASH) {
      return (
        await db.query("select intake_qbo_webhook_events($1,$2) ids", [
          JSON.stringify(events),
          hash,
        ])
      ).rows[0].ids
    },
    async rows() {
      return (
        await db.query("select * from qbo_webhook_events order by event_id")
      ).rows
    },
  }
  return f
}
test("exact additive SQL retains previous intake, denies actual application mutations and RPC execution", async (t) => {
  const f = await database(t),
    { db } = f
  await f.install()
  for (const role of ["anon", "authenticated"])
    await f.role(role, async () => {
      assert.equal(
        (
          await db.query(
            "select has_function_privilege(current_user,'public.intake_qbo_webhook_events(jsonb,text)','execute') permitted",
          )
        ).rows[0].permitted,
        false,
      )
      for (const sql of [
        "insert into qbo_webhook_events(event_id,payload_hash) values('forged','hash')",
        "update qbo_webhook_events set payload_hash='forged'",
        "update qbo_webhook_events set process_error='forged'",
        "update qbo_webhook_events set provider_event_ids='{forged}'",
        "delete from qbo_webhook_events",
      "truncate qbo_webhook_events",
        "select * from qbo_webhook_events",
        "select intake_qbo_webhook_events('[]','" + HASH + "')",
      ])
        await assert.rejects(db.exec(sql), /permission denied/)
    })
  await f.role("service_role", async () => {
    // Previous CDC/legacy insert contract remains compatible after SQL rollout.
    await db.query(
      "insert into qbo_webhook_events(event_id,payload_hash,realm_id,entity_name,entity_qbo_id,operation,last_updated) values($1,$2,'realm','Invoice','77','Update',$3) on conflict(event_id) do nothing",
      [event().event_id, HASH, TIME],
    )
    assert.deepEqual((await f.rows())[0].provider_event_ids, [])
    assert.deepEqual(
      await f.intake([event({ provider_event_id: "provider-a" })]),
      [],
    )
  })
  assert.deepEqual((await f.rows())[0].provider_event_ids, ["provider-a"])
  await f.install()
  await f.role("authenticated", () =>
    assert.rejects(f.intake([]), /permission denied/),
  )
  await f.role("service_role", async () =>
    assert.deepEqual(
      await f.intake([event({ provider_event_id: "provider-b" })]),
      [],
    ),
  )
  assert.deepEqual((await f.rows())[0].provider_event_ids, [
    "provider-a",
    "provider-b",
  ])
})
test("inside-batch duplicates and distinct provider IDs retain one semantic row and every terminal field", async (t) => {
  const f = await database(t),
    { db } = f
  await f.install()
  assert.deepEqual(
    await f.intake([
      event({ provider_event_id: "provider-b" }),
      event({ provider_event_id: "provider-a" }),
      event({ provider_event_id: "provider-a" }),
    ]),
    [event().event_id],
  )
  await db.exec(
    "update qbo_webhook_events set process_status='reconciled',attempts=7,process_error='retained error',processed_at='2026-02-12T14:31:00Z',next_attempt_at='2026-02-12T15:00:00Z'",
  )
  const [before] = await f.rows()
  assert.deepEqual(
    await f.intake([
      event({ provider_event_id: "provider-c" }),
      event({ provider_event_id: "provider-b" }),
      event(),
    ]),
    [],
  )
  assert.deepEqual(await f.rows(), [
    {
      ...before,
      provider_event_ids: ["provider-a", "provider-b", "provider-c"],
    },
  ])
  // PGlite serializes these promises; this is a replay test, not MVCC contention.
  await Promise.all([
    f.intake([event({ provider_event_id: "provider-d" })]),
    f.intake([event({ provider_event_id: "provider-e" })]),
  ])
  assert.deepEqual(await f.rows(), [
    {
      ...before,
      provider_event_ids: [
        "provider-a",
        "provider-b",
        "provider-c",
        "provider-d",
        "provider-e",
      ],
    },
  ])
})
test("whole SQL batch validation and metadata failure roll back work and receipts, then replay recovers", async (t) => {
  const f = await database(t),
    { db } = f
  await f.install()
  await f.intake([event()])
  await db.exec(
    "update qbo_webhook_events set process_status='ignored',attempts=3,processed_at=now()",
  )
  const before = await f.rows()
  for (const invalid of [
    event({ provider_event_id: null }),
    event({ entity_qbo_id: " 77" }),
    event({ operation: "Bogus" }),
    event({ last_updated: "broken" }),
    event({ event_id: "wrong" }),
  ]) {
    await assert.rejects(
      f.intake([event({ provider_event_id: "valid-first" }), invalid]),
      /Invalid/,
    )
    assert.deepEqual(await f.rows(), before)
  }
  await assert.rejects(
    f.intake(Array.from({ length: 201 }, () => event())),
    /Invalid webhook intake batch/,
  )
  await db.exec(`create function reject_receipt() returns trigger language plpgsql as $$begin if 'reject-metadata'=any(new.provider_event_ids) then raise exception 'Fixture metadata unavailable'; end if; return new; end$$;
    create trigger reject_receipt before update of provider_event_ids on qbo_webhook_events for each row execute function reject_receipt();`)
  const newEvent = event({
    realm_id: "aaa",
    entity_qbo_id: "88",
    event_id: `aaa:Invoice:88:Update:${TIME}`,
    provider_event_id: "new-receipt",
  })
  await assert.rejects(
    f.intake([newEvent, event({ provider_event_id: "reject-metadata" })]),
    /Fixture metadata unavailable/,
  )
  assert.deepEqual(await f.rows(), before)
  await db.exec("drop trigger reject_receipt on qbo_webhook_events")
  assert.deepEqual(
    await f.intake([newEvent, event({ provider_event_id: "reject-metadata" })]),
    [newEvent.event_id],
  )
  const existing = (await f.rows()).find(
    (row) => row.event_id === event().event_id,
  )
  assert.deepEqual(existing, {
    ...before[0],
    provider_event_ids: ["reject-metadata"],
  })
})
// Exact webhook intake from isolated baseline b76eb3a; other module seams
// remain the real current code. This preserves an executable negative baseline.
const originalB76Intake = [
  "export async function receiveQboWebhook(input: {",
  "  rawBody: string",
  "  headers: Record<string, string | null>",
  "}): Promise<{ received: number; inserted: number } | null> {",
  '  const signature = input.headers["intuit-signature"] ?? null',
  "  const isValid = verifyIntuitWebhookSignature({",
  "    payload: input.rawBody,",
  "    signatureHeader: signature,",
  "    verifierToken: process.env.QBO_WEBHOOK_VERIFIER_TOKEN,",
  "  })",
  "  if (!isValid) {",
  '    logQBO("warn", "webhook_invalid_signature", { hasSignature: Boolean(signature) })',
  "    return null",
  "  }",
  "",
  "  let payload: unknown",
  "  try {",
  "    payload = JSON.parse(input.rawBody)",
  "  } catch {",
  '    throw new IntuitWebhookPayloadError("Invalid webhook JSON")',
  "  }",
  "  const events = extractIntuitEntityEvents(payload)",
  "  if (!events.length) return { received: 0, inserted: 0 }",
  "  const supabase = createServiceSupabaseClient()",
  '  const payloadHash = createHash("sha256").update(input.rawBody).digest("hex")',
  "  let inserted = 0",
  "  for (const event of events) {",
  "    // ignoreDuplicates: a redelivered event must not reset an already-processed row to pending.",
  "    const { data, error } = await checkedDatabase(",
  '      supabase.from("qbo_webhook_events").upsert(',
  "        {",
  "          event_id: event.eventId,",
  "          payload_hash: payloadHash,",
  "          realm_id: event.realmId,",
  "          entity_name: event.entityName,",
  "          entity_qbo_id: event.entityId,",
  "          operation: event.operation,",
  "          last_updated: Number.isFinite(Date.parse(event.lastUpdated)) ? new Date(event.lastUpdated).toISOString() : null,",
  "          received_at: new Date().toISOString(),",
  '          process_status: "pending",',
  "          process_error: null,",
  "          processed_at: null,",
  "        },",
  "        {",
  '          onConflict: "event_id",',
  "          ignoreDuplicates: true,",
  "        },",
  '      ).select("event_id"),',
  "    )",
  "    if (!error) {",
  "      inserted += data?.length ?? 0",
  "      if (event.providerEventId) {",
  '        logQBO("info", "webhook_event_stored", {',
  "          providerEventId: event.providerEventId,",
  "          eventId: event.eventId,",
  "          inserted: Boolean(data?.length),",
  "        })",
  "      }",
  "    } else {",
  "      // A duplicate is silently ignored by the upsert; reaching here is a real",
  "      // insert failure and must not be indistinguishable from one.",
  "      throw new Error(`Webhook event was not durably stored: ${error.message}`)",
  "    }",
  "  }",
  "  return { received: events.length, inserted }",
  "}",
].join("\n")

function load(relativePath, stubs, intakeOverride) {
  const filename = path.resolve(__dirname, "..", relativePath),
    mod = new Module(filename, module)
  mod.filename = filename
  mod.paths = module.paths
  mod.require = (name) => {
    if (Object.hasOwn(stubs, name)) return stubs[name]
    if (name === "crypto") return require("node:crypto")
    if (name === "next/server") return require(name)
    throw new Error(`Unstubbed receipt dependency: ${name}`)
  }
  let source = fs.readFileSync(filename, "utf8")
  if (intakeOverride) {
    const start = source.indexOf("export async function receiveQboWebhook"),
      end = source.indexOf("\n/**", start)
    source = source.slice(0, start) + intakeOverride + "\n" + source.slice(end)
  }
  mod._compile(
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    filename,
  )
  return mod.exports
}
test("original b76 signed HTTP loses provider receipts; current exact SQL requires durable metadata", async (t) => {
  const { cdcDatabase } = require("./fixtures/qbo-cdc-database")
  const { runtime } = require("./fixtures/qbo-cdc-runtime")
  const f = await cdcDatabase(t), { db } = f
  f.rows = f.queue
  f.intake = async (events, hash) => (await db.query("select intake_qbo_webhook_events($1,$2) result", [JSON.stringify(events), hash])).rows[0].result
  await f.install()
  const calls = []
  const client = {
    from(table) {
      if (table === "accounting_connections") {
        return {
          select() {
            return this
          },
          eq() {
            return this
          },
          maybeSingle: async () => ({
            data: {
              id: "connection",
              org_id: "org",
              external_account_id: "realm",
              settings: {},
            },
            error: null,
          }),
        }
      }
      assert.equal(table, "qbo_webhook_events")
      return {
        upsert(value, options) {
          assert.deepEqual(options, {
            onConflict: "event_id",
            ignoreDuplicates: true,
          })
          const query = {
            select(columns) {
              assert.equal(columns, "event_id")
              return query
            },
            then(resolve, reject) {
              calls.push({ kind: "upsert" })
              return f
                .role("service_role", () =>
                  db.query(
                    "insert into qbo_webhook_events(event_id,payload_hash,realm_id,entity_name,entity_qbo_id,operation,last_updated,received_at,process_status) values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(event_id) do nothing returning event_id",
                    [
                      value.event_id,
                      value.payload_hash,
                      value.realm_id,
                      value.entity_name,
                      value.entity_qbo_id,
                      value.operation,
                      value.last_updated,
                      value.received_at,
                      value.process_status,
                    ],
                  ),
                )
                .then((result) => ({ data: result.rows, error: null }))
                .then(resolve, reject)
            },
          }
          return query
        },
      }
    },
    async rpc(name, args) {
      if (name === "update_qbo_cdc_cursor") return { data: null, error: null }
      assert.equal(name, "intake_qbo_webhook_events")
      calls.push(args)
      try {
        return {
          data: await f.role("service_role", () =>
            f.intake(args.p_events, args.p_payload_hash),
          ),
          error: null,
        }
      } catch (error) {
        return { data: null, error: { message: error.message } }
      }
    },
  }
  const stubs = {
    "@/lib/supabase/server": { createServiceSupabaseClient: () => client },
    "@/lib/services/accounting-logger": { logQBO: () => {} },
    "@/lib/integrations/accounting/qbo/webhook": webhook,
    "@/lib/integrations/accounting/qbo/cdc-recovery": { recoverQboCdc: async () => { throw new Error("Unexpected CDC in signed intake fixture") } },
  }
  for (const name of [
    "@/lib/services/accounting-delivery",
    "@/lib/integrations/accounting/qbo/client",
    "@/lib/integrations/accounting/qbo/import-rules",
    "@/lib/integrations/accounting/local-change",
    "@/lib/financials/ledger-status",
    "@/lib/services/books/authority",
    "@/lib/services/events",
    "@/lib/services/invoice-balance",
    "@/lib/services/accounting-sync-attempts",
    "@/lib/services/invoice-numbers",
  ])
    stubs[name] = {}
  stubs["@/lib/services/books/authority"] = {
    resolveLedgerAuthority: async () => "external",
  }
  stubs["@/lib/integrations/accounting/qbo/client"] = {
    QBOClient: {
      forConnection: async () => ({
        changeDataCapture: async () => ({
          CDCResponse: [
            {
              QueryResponse: [
                {
                  Invoice: [{ Id: "77", MetaData: { LastUpdatedTime: TIME } }],
                },
              ],
            },
          ],
        }),
      }),
    },
  }
  const api = load("lib/integrations/accounting/qbo/reconcile.ts", stubs)
  const cdc = runtime(f, await stubs["@/lib/integrations/accounting/qbo/client"].QBOClient.forConnection())
  const cdcResult = await cdc.api.ingestQboCdcChanges({ connectionId: f.connection })
  assert.equal(cdcResult.scanned, 1)
  assert.equal(cdcResult.inserted, 1)
  assert.equal(cdcResult.recoveryRequired, false)
  await db.exec(
    "update qbo_webhook_events set process_status='reconciled',attempts=4,process_error='retained',processed_at=now()",
  )
  const before = (await f.rows())[0]

  const route = load("app/api/qbo/payment-webhook/route.ts", {
    "@/lib/integrations/accounting/qbo/webhook": webhook,
    "@/lib/integrations/accounting/registry": {
      getProvider: () => ({ receiveWebhook: api.receiveQboWebhook }),
    },
    "@/lib/services/accounting-logger": { logQBO: () => {} },
  })
  const originalApi = load(
    "lib/integrations/accounting/qbo/reconcile.ts",
    stubs,
    originalB76Intake,
  )
  const originalRoute = load("app/api/qbo/payment-webhook/route.ts", {
    "@/lib/integrations/accounting/qbo/webhook": webhook,
    "@/lib/integrations/accounting/registry": {
      getProvider: () => ({ receiveWebhook: originalApi.receiveQboWebhook }),
    },
    "@/lib/services/accounting-logger": { logQBO: () => {} },
  })
  const previous = process.env.QBO_WEBHOOK_VERIFIER_TOKEN,
    token = "synthetic-receipt-token"
  global.fetch = async () => {
    throw new Error("Unstubbed fixture fetch")
  }
  process.env.QBO_WEBHOOK_VERIFIER_TOKEN = token
  t.after(() => {
    if (previous === undefined) delete process.env.QBO_WEBHOOK_VERIFIER_TOKEN
    else process.env.QBO_WEBHOOK_VERIFIER_TOKEN = previous
  })
  async function deliver(payload, signature, activeRoute = route) {
    const body = JSON.stringify(payload)
    return activeRoute.POST(
      new Request("https://fixture.invalid/webhook", {
        method: "POST",
        body,
        headers: {
          "intuit-signature":
            signature ?? webhook.computeIntuitWebhookSignature(body, token),
        },
      }),
    )
  }
  const cloud = (id) => ({
    specversion: "1.0",
    id,
    type: "qbo.invoice.updated.v1",
    intuitaccountid: "realm",
    intuitentityid: "77",
    time: TIME,
  })
  const originalResponse = await deliver(
    [cloud("provider-http")],
    undefined,
    originalRoute,
  )
  assert.equal(originalResponse.status, 200)
  assert.deepEqual(await originalResponse.json(), {
    received: true,
    processed: 0,
  })
  assert.deepEqual(await f.rows(), [before])
  assert.deepEqual((await f.rows())[0].provider_event_ids, [])
  await db.exec(
    `create function reject_receipt() returns trigger language plpgsql as $$begin raise exception 'Fixture metadata unavailable'; end$$; create trigger reject_receipt before update of provider_event_ids on qbo_webhook_events for each row execute function reject_receipt()`,
  )
  assert.equal((await deliver([cloud("provider-http")])).status, 503)
  assert.deepEqual(await f.rows(), [before])
  await db.exec("drop trigger reject_receipt on qbo_webhook_events")
  const response = await deliver([
    cloud("provider-http"),
    cloud("provider-other"),
    cloud("provider-http"),
  ])
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { received: true, processed: 0 })
  assert.deepEqual(await f.rows(), [
    { ...before, provider_event_ids: ["provider-http", "provider-other"] },
  ])
  const persisted = await f.rows(),
    dispatches = calls.length
  assert.equal((await deliver([])).status, 200)
  assert.equal(
    (await deliver([cloud("valid"), { ...cloud("bad"), intuitentityid: null }]))
      .status,
    400,
  )
  assert.equal((await deliver([cloud("wrong-signature")], "bad")).status, 401)
  assert.equal(calls.length, dispatches)
  assert.deepEqual(await f.rows(), persisted)
  await t.test(
    "named 40 repeated/40 different fixture measures actual original/current intake DB dispatches",
    async () => {
      const input = Array.from({ length: 40 }, (_, i) =>
        cloud(`repeat-${i}`),
      ).concat(
        Array.from({ length: 40 }, (_, i) => ({
          ...cloud(`different-${i}`),
          intuitentityid: String(100 + i),
        })),
      )
      await db.exec("delete from qbo_webhook_events")
      const oldStart = calls.length
      const oldResponse = await deliver(input, undefined, originalRoute)
      assert.equal(oldResponse.status, 200)
      assert.deepEqual(await oldResponse.json(), {
        received: true,
        processed: 41,
      })
      const oldDispatches = calls.length - oldStart
      assert.equal(oldDispatches, 80)
      assert.ok(
        (await f.rows()).every((row) => row.provider_event_ids.length === 0),
      )
      await db.exec("delete from qbo_webhook_events")
      const currentStart = calls.length
      const currentResponse = await deliver(input)
      assert.equal(currentResponse.status, 200)
      assert.deepEqual(await currentResponse.json(), {
        received: true,
        processed: 41,
      })
      const currentDispatches = calls.length - currentStart
      assert.equal(currentDispatches, 1)
      assert.equal(
        (await f.rows()).find((row) => row.entity_qbo_id === "77")
          .provider_event_ids.length,
        40,
      )
      t.diagnostic(
        `actual intake DB dispatches: original=${oldDispatches}, current=${currentDispatches}; semantic work=41`,
      )
    },
  )
})
test("identical legacy/provider replay performs zero metadata writes, while identity conflicts fail", async (t) => {
  const f = await database(t),
    { db } = f
  await f.install()
  await f.intake([event({ provider_event_id: "provider-a" })])
  const before = await f.rows()
  await db.exec(
    `create function reject_noop_write() returns trigger language plpgsql as $$begin raise exception 'Unexpected receipt write'; end$$; create trigger reject_noop_write before update on qbo_webhook_events for each row execute function reject_noop_write()`,
  )
  assert.deepEqual(
    await f.intake([event(), event({ provider_event_id: "provider-a" })]),
    [],
  )
  assert.deepEqual(await f.rows(), before)
  await db.exec("drop trigger reject_noop_write on qbo_webhook_events")
  await db.exec("update qbo_webhook_events set entity_qbo_id='different'")
  await assert.rejects(
    f.intake([event({ provider_event_id: "provider-a" })]),
    /identity conflict/,
  )
  await db.exec(
    "delete from qbo_webhook_events; create function suppress_work() returns trigger language plpgsql as $$begin return null; end$$; create trigger suppress_work before insert on qbo_webhook_events for each row execute function suppress_work()",
  )
  await assert.rejects(
    f.intake([event({ provider_event_id: "provider-a" })]),
    /missing durable event/,
  )
  assert.deepEqual(await f.rows(), [])
})
test("exact SQL preserves distinct normalized high-precision IDs and original millisecond queue projection", async (t) => {
  const f = await database(t)
  await f.install()
  const parsed = webhook.extractIntuitEntityEvents(
    ["123456", "123457", "123999999"].map((fraction, i) => ({
      specversion: "1.0",
      id: `precision-${i}`,
      type: "qbo.invoice.updated.v1",
      intuitaccountid: "realm",
      intuitentityid: "77",
      time: `2026-02-12T09:30:00.${fraction}-05:00`,
    })),
  )
  const wire = parsed.map((e) => ({
    event_id: e.eventId,
    realm_id: e.realmId,
    entity_name: e.entityName,
    entity_qbo_id: e.entityId,
    operation: e.operation,
    last_updated: e.lastUpdated,
    provider_event_id: e.providerEventId,
  }))
  assert.deepEqual(
    await f.role("service_role", () => f.intake(wire)),
    parsed.map((e) => e.eventId).sort(),
  )
  const before = await f.rows()
  assert.equal(before.length, 3)
  assert.equal(new Set(before.map((row) => row.event_id)).size, 3)
  for (const row of before)
    assert.equal(
      new Date(row.last_updated).toISOString(),
      "2026-02-12T14:30:00.123Z",
    )
  assert.deepEqual(
    await f.intake([
      { ...wire[0], provider_event_id: "precision-replay" },
      wire[0],
    ]),
    [],
  )
  const after = await f.rows()
  assert.deepEqual(
    after,
    before.map((row) =>
      row.event_id === wire[0].event_id
        ? { ...row, provider_event_ids: ["precision-0", "precision-replay"] }
        : row,
    ),
  )
})
