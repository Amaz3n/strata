const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const Module = require("node:module")
const ts = require("typescript")
require("../scripts/register-ts-node-test")

const webhook = require("../lib/integrations/accounting/qbo/webhook")
const TOKEN = "isolated-webhook-fixture-token"
const TIME = "2026-02-12T14:30:00.000Z"
const legacy = (entities = [{ name: "Invoice", id: "77", operation: "Update", lastUpdated: TIME }], realmId = "realm-a") => ({
  eventNotifications: [{ realmId, dataChangeEvent: { entities } }],
})
const cloud = (extra = {}) => ({
  specversion: "1.0", id: "provider-delivery-id", source: "qbo/realm-a",
  type: "qbo.invoice.updated.v1", intuitaccountid: "realm-a", intuitentityid: "77", time: TIME, ...extra,
})

function load(relativePath, stubs) {
  const filename = path.resolve(__dirname, "..", relativePath)
  const mod = new Module(filename, module)
  mod.filename = filename
  mod.paths = module.paths
  mod.require = (name) => {
    if (Object.hasOwn(stubs, name)) return stubs[name]
    // Only the signature parser, crypto, and Next response implementation are
    // real dependencies. Missing stubs fail instead of contacting infrastructure.
    if (["crypto", "next/server", "@/lib/integrations/accounting/qbo/webhook"].includes(name)) return require(name)
    throw new Error(`Unstubbed dependency: ${name}`)
  }
  mod._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename)
  return mod.exports
}

function harness({ seed = [], failAt = 0, rpcResult } = {}) {
  const rows = structuredClone(seed)
  const calls = []
  const logs = []
  let clients = 0
  const db = {
    async rpc(name, args) {
      assert.equal(name, "intake_qbo_webhook_events")
      assert.ok(args.p_events.length <= 200)
      calls.push({ name, args })
      if (calls.length === failAt) return { data: null, error: { message: "fixture storage unavailable" } }
      const staged = structuredClone(rows), inserted = []
      for (const event of args.p_events) {
        let row = staged.find((row) => row.event_id === event.event_id)
        if (!row) {
          row = { ...event, payload_hash: args.p_payload_hash, process_status: "pending", process_error: null, processed_at: null, provider_event_ids: [] }
          delete row.provider_event_id
          staged.push(row)
          inserted.push(event.event_id)
        }
        const ids = new Set(row.provider_event_ids ?? [])
        if (event.provider_event_id) ids.add(event.provider_event_id)
        row.provider_event_ids = [...ids].sort()
      }
      rows.splice(0, rows.length, ...staged)
      return { data: rpcResult !== undefined ? rpcResult : inserted, error: null }
    },
  }
  const api = load("lib/integrations/accounting/qbo/reconcile.ts", {
    "@/lib/supabase/server": { createServiceSupabaseClient: () => { clients += 1; return db } },
    "@/lib/services/accounting-logger": { logQBO: (...args) => logs.push(args) },
    "@/lib/services/accounting-delivery": {},
    "@/lib/integrations/accounting/qbo/cdc-recovery": { recoverQboCdc: async () => { throw new Error("Unexpected CDC in signed intake fixture") } },
    "@/lib/integrations/accounting/qbo/client": {},
    "@/lib/integrations/accounting/qbo/import-rules": {},
    "@/lib/integrations/accounting/local-change": {},
    "@/lib/financials/ledger-status": {},
    "@/lib/services/books/authority": {},
    "@/lib/services/events": {},
    "@/lib/services/invoice-balance": {},
    "@/lib/services/accounting-sync-attempts": {},
    "@/lib/services/invoice-numbers": {},
  })
  const route = load("app/api/qbo/payment-webhook/route.ts", {
    "@/lib/integrations/accounting/registry": { getProvider: (name) => {
      assert.equal(name, "qbo")
      return { receiveWebhook: api.receiveQboWebhook }
    } },
    "@/lib/services/accounting-logger": { logQBO: (...args) => logs.push(args) },
  })
  return {
    rows, calls, logs, get clients() { return clients },
    async deliver(payload, { signature, raw = false, headers = {} } = {}) {
      const rawBody = raw ? payload : JSON.stringify(payload)
      const request = new Request("http://fixture.invalid/api/qbo/payment-webhook", {
        method: "POST", body: rawBody,
        headers: { "intuit-signature": signature ?? webhook.computeIntuitWebhookSignature(rawBody, TOKEN), ...headers },
      })
      const previous = process.env.QBO_WEBHOOK_VERIFIER_TOKEN
      process.env.QBO_WEBHOOK_VERIFIER_TOKEN = TOKEN
      try { return await route.POST(request) }
      finally {
        if (previous === undefined) delete process.env.QBO_WEBHOOK_VERIFIER_TOKEN
        else process.env.QBO_WEBHOOK_VERIFIER_TOKEN = previous
      }
    },
  }
}

test("signed legacy and CloudEvents deliveries store the same semantic change once", async () => {
  const h = harness()
  const first = await h.deliver(legacy())
  assert.equal(first.status, 200)
  assert.deepEqual(await first.json(), { received: true, processed: 1 })
  const row = h.rows[0]
  Object.assign(row, { process_status: "reconciled", processed_at: TIME, process_error: null, attempts: 4 })
  const completed = structuredClone(row)
  const repeat = await h.deliver([cloud({ time: "2026-02-12T09:30:00-05:00" })])
  assert.equal(repeat.status, 200)
  assert.deepEqual(await repeat.json(), { received: true, processed: 0 })
  assert.deepEqual(h.rows, [{ ...completed, provider_event_ids: ["provider-delivery-id"] }])
  assert.equal(row.event_id, `realm-a:Invoice:77:Update:${TIME}`)
  assert.equal(row.last_updated, TIME)
  assert.match(row.payload_hash, /^[a-f0-9]{64}$/)
})

test("CloudEvents preserve delivery ID, canonical multiword names, operations and every realm", async () => {
  const names = ["BillPayment", "VendorCredit", "JournalEntry", "Invoice", "Payment", "Purchase", "Customer", "Vendor", "Account", "Item", "Class", "Bill", "Currency", "JournalCode", "Preferences"]
  const operations = ["updated", "created", "deleted", "merged", "voided", "emailed"]
  const canonical = ["Update", "Create", "Delete", "Merge", "Void", "Emailed"]
  const input = names.map((name, index) => cloud({
    id: `delivery-${index}`, type: `qbo.${name.toLowerCase()}.${operations[index % operations.length]}.v1`,
    intuitaccountid: `realm-${index % 2}`, intuitentityid: String(index),
  }))
  const parsed = webhook.extractIntuitEntityEvents(input)
  assert.deepEqual(parsed.map((event) => event.entityName), names)
  parsed.forEach((event, index) => {
    assert.equal(event.operation, canonical[index % operations.length])
    assert.equal(event.providerEventId, `delivery-${index}`)
    assert.equal(event.realmId, `realm-${index % 2}`)
  })
  const h = harness()
  assert.equal((await h.deliver(input)).status, 200)
  assert.equal(h.rows.length, names.length)
  assert.equal(new Set(h.rows.map((row) => row.realm_id)).size, 2)
  assert.deepEqual(h.logs.filter(([, name]) => name === "webhook_event_stored").map(([, , fields]) => fields), parsed.map((event) => ({
    providerEventId: event.providerEventId, eventId: event.eventId, inserted: true,
  })))
})

test("legacy notifications flatten mixed realms and all entities", async () => {
  const h = harness()
  const input = { eventNotifications: [
    ...legacy().eventNotifications,
    ...legacy([{ name: "Payment", id: "99", operation: "Delete", lastUpdated: TIME },
      { name: "BillPayment", id: "88", operation: "Merge", lastUpdated: TIME }], "realm-b").eventNotifications,
  ] }
  assert.equal((await h.deliver(input)).status, 200)
  assert.deepEqual(h.rows.map((row) => [row.realm_id, row.entity_name, row.operation]), [
    ["realm-a", "Invoice", "Update"], ["realm-b", "Payment", "Delete"], ["realm-b", "BillPayment", "Merge"],
  ])
})

test("signed malformed and unsupported payloads fail before any database use", async (t) => {
  const payloads = [null, {}, { otherNotifications: [cloud()] }, { eventNotifications: {} },
    { eventNotifications: [null] }, { eventNotifications: [{ realmId: "realm" }] },
    legacy([{}]), legacy(undefined, ""), legacy([{ name: "Invoice", id: 77, operation: "Update", lastUpdated: TIME }]),
    legacy([{ name: "UnknownThing", id: "77", operation: "Update", lastUpdated: TIME }]),
    legacy([{ name: "Invoice", id: "77", operation: "UnknownOperation", lastUpdated: TIME }]),
    [cloud({ id: "" })], [cloud({ intuitentityid: "" })], [cloud({ intuitaccountid: null })],
    [cloud({ intuitaccountid: "realm:a" })], [cloud({ intuitentityid: " 77" })],
    [cloud({ type: "qbo.invoice.updated.v2" })], [cloud({ type: "qbo.constructor.updated.v1" })],
    [cloud({ type: "qbo.mystery.updated.v1" })], [cloud({ specversion: "0.3" })], [cloud({ specversion: undefined })],
    ...["not-a-date", "2026-02-30T00:00:00Z", "2026-01-01", "2026-01-01T24:00:00Z", "2026-01-01T00:00:00", "2026-01-01T00:00:00+25:00"].map((time) => [cloud({ time })]),
    // Whole-delivery validation rejects even when the first event is usable.
    [cloud(), cloud({ intuitentityid: null })],
  ]
  for (const [index, payload] of payloads.entries()) await t.test(`payload ${index}`, async () => {
    const h = harness()
    assert.equal((await h.deliver(payload)).status, 400)
    assert.equal(h.clients, 0)
    assert.equal(h.calls.length, 0)
  })
  for (const rawBody of ["", "{broken"]) {
    const h = harness()
    assert.equal((await h.deliver(rawBody, { raw: true })).status, 400)
    assert.equal(h.clients, 0)
  }
})

test("explicit empty legacy notifications and CloudEvents are authenticated noops", async () => {
  for (const input of [[], { eventNotifications: [] }, legacy([])]) {
    const h = harness()
    const result = await h.deliver(input)
    assert.equal(result.status, 200)
    assert.deepEqual(await result.json(), { received: true, processed: 0 })
    assert.equal(h.clients, 0)
  }
})

test("signature failure precedes parsing and storage, including legacy bypass headers", async () => {
  for (const signature of ["bad", "", webhook.computeIntuitWebhookSignature("different body", TOKEN)]) {
    const h = harness()
    assert.equal((await h.deliver("{broken", { raw: true, signature, headers: { "x-qbo-webhook-secret": TOKEN } })).status, 401)
    assert.equal(h.clients, 0)
    assert.equal(h.calls.length, 0)
  }
})

test("storage failure prevents acknowledgment and a partial batch delivery retries without resets", async () => {
  const h = harness({ failAt: 2 })
  const input = Array.from({ length: 201 }, (_, index) => cloud({ id: `delivery-${index}`, intuitentityid: String(index) }))
  const failed = await h.deliver(input)
  assert.equal(failed.status, 503)
  assert.deepEqual(await failed.json(), { error: "Webhook storage unavailable" })
  assert.equal(h.rows.length, 200)
  Object.assign(h.rows[0], { process_status: "ignored", processed_at: TIME, attempts: 4, process_error: "retained" })
  const first = structuredClone(h.rows[0])
  const retry = await h.deliver(input)
  assert.equal(retry.status, 200)
  assert.deepEqual(await retry.json(), { received: true, processed: 1 })
  assert.equal(h.rows.length, 201)
  assert.deepEqual(h.rows[0], first)
})

test("distinct delivery IDs and duplicate semantic events merge durable metadata without extra work", async () => {
  const h = harness()
  const first = await h.deliver([cloud({ id: "delivery-a" }), cloud({ id: "delivery-b" }), cloud({ id: "delivery-a" })])
  assert.deepEqual(await first.json(), { received: true, processed: 1 })
  assert.equal(h.rows.length, 1)
  assert.deepEqual(h.rows[0].provider_event_ids, ["delivery-a", "delivery-b"])
  assert.equal(h.calls.length, 1)
  const snapshot = structuredClone(h.rows)
  assert.deepEqual(await (await h.deliver([cloud({ id: "delivery-b" })])).json(), { received: true, processed: 0 })
  assert.deepEqual(h.rows, snapshot)
})

test("named 40 repeated/40 different semantic events use one intake request instead of 80", async () => {
  const h = harness()
  const input = Array.from({ length: 40 }, (_, i) => cloud({ id: `repeat-${i}` })).concat(Array.from({ length: 40 }, (_, i) => cloud({ id: `different-${i}`, intuitentityid: String(100 + i) })))
  assert.deepEqual(await (await h.deliver(input)).json(), { received: true, processed: 41 })
  assert.equal(h.calls.length, 1)
  assert.equal(h.rows.length, 41)
  assert.equal(h.rows.find(row => row.entity_qbo_id === "77").provider_event_ids.length, 40)
})

test("ISO normalization retains submillisecond changes and canonical offsets", () => {
  const [first] = webhook.extractIntuitEntityEvents([cloud({ time: "2026-02-12T09:30:00.123456-05:00" })])
  const [same] = webhook.extractIntuitEntityEvents([cloud({ time: "2026-02-12T14:30:00.1234560Z" })])
  const [next] = webhook.extractIntuitEntityEvents([cloud({ time: "2026-02-12T14:30:00.123457Z" })])
  assert.equal(first.lastUpdated, "2026-02-12T14:30:00.123456Z")
  assert.equal(first.eventId, same.eventId)
  assert.notEqual(first.eventId, next.eventId)
})


test("signed legacy additional provider entities and Void/Emailed retain canonical semantics", async () => {
  const h = harness()
  const input = legacy([
    { name: "Currency", id: "USD", operation: "Update", lastUpdated: TIME },
    { name: "JournalCode", id: "1", operation: "Create", lastUpdated: TIME },
    { name: "Preferences", id: "2", operation: "Update", lastUpdated: TIME },
    { name: "Invoice", id: "78", operation: "Void", lastUpdated: TIME },
    { name: "Invoice", id: "79", operation: "Emailed", lastUpdated: TIME },
  ])
  assert.equal((await h.deliver(input)).status, 200)
  assert.deepEqual(h.rows.map((row) => [row.entity_name, row.operation]), [
    ["Currency", "Update"], ["JournalCode", "Create"], ["Preferences", "Update"], ["Invoice", "Void"], ["Invoice", "Emailed"],
  ])
})

test("signed out-of-order changes remain distinct and redelivery preserves terminal state", async () => {
  const h = harness()
  const newer = [cloud({ id: "newer-delivery", time: "2026-02-12T14:31:00Z" })]
  const older = [cloud({ id: "older-delivery" })]
  assert.equal((await h.deliver(newer)).status, 200)
  Object.assign(h.rows[0], { process_status: "reconciled", processed_at: "2026-02-12T14:32:00Z" })
  const reconciled = structuredClone(h.rows[0])
  assert.equal((await h.deliver(older)).status, 200)
  assert.equal(h.rows.length, 2)
  assert.equal(h.rows[1].last_updated, TIME)
  assert.equal(h.rows[1].process_status, "pending")
  assert.notEqual(h.rows[0].event_id, h.rows[1].event_id)
  const repeat = await h.deliver(newer)
  assert.equal(repeat.status, 200)
  assert.deepEqual(await repeat.json(), { received: true, processed: 0 })
  assert.deepEqual(h.rows[0], reconciled)
})
test("signed boundary rejects nonarray, unknown or duplicate intake result IDs without a successful processed count", async () => {
  const id=`realm-a:Invoice:77:Update:${TIME}`
  for(const rpcResult of [null,{},["unknown-event"],[id,id]]) {
    const h=harness({rpcResult})
    const response=await h.deliver([cloud()])
    assert.equal(response.status,503)
    assert.deepEqual(await response.json(),{error:"Webhook storage unavailable"})
  }
})
test("malformed event after a full batch is rejected before all persistence",async()=>{
  const h=harness()
  const payload=Array.from({length:200},(_,i)=>cloud({id:`delivery-${i}`,intuitentityid:String(i)})).concat([cloud({intuitentityid:null})])
  assert.equal((await h.deliver(payload)).status,400)
  assert.equal(h.calls.length,0)
  assert.equal(h.clients,0)
})
