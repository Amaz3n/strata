require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const { cdcDatabase, id } = require("./fixtures/qbo-cdc-database")
const { runtime, load } = require("./fixtures/qbo-cdc-runtime")
const savedFetch = global.fetch
test.before(() => {
  global.fetch = async () => {
    throw new Error("Unstubbed fixture fetch")
  }
})
test.after(() => {
  global.fetch = savedFetch
})

function memory(seed = {}) {
  const rows = structuredClone(seed)
  const calls = []
  let nextId = 900
  const allowed = [
    "books_settings",
    "accounting_reconciliation_runs",
    "accounting_reconciliation_items",
    "disbursements",
    "prime_sov_lines",
    "retainage",
    "projects",
    "accounting_sync_records",
  ]
  const db = {
    rows,
    calls,
    from(table) {
      if (!allowed.includes(table)) throw new Error(`Unstubbed memory table ${table}`)
      const filters = []
      let kind = "read",
        values,
        single = false,
        range
      const q = {
        select() {
          return q
        },
        eq(key, value) {
          filters.push((row) => row[key] === value)
          return q
        },
        in(key, values) {
          filters.push((row) => values.includes(row[key]))
          return q
        },
        neq(key, value) {
          filters.push((row) => row[key] !== value)
          return q
        },
        not() {
          return q
        },
        order() {
          return q
        },
        range(from, to) {
          range = [from, to]
          return q
        },
        limit(n) {
          range = [0, n - 1]
          return q
        },
        maybeSingle() {
          single = true
          return q
        },
        single() {
          single = true
          return q
        },
        insert(input) {
          kind = "insert"
          values = input
          return q
        },
        upsert(input) {
          kind = "upsert"
          values = input
          return q
        },
        update(input) {
          kind = "update"
          values = input
          return q
        },
        then(resolve, reject) {
          return Promise.resolve()
            .then(() => {
              calls.push({ table, kind, values })
              let data = (rows[table] ??= []).filter((row) => filters.every((filter) => filter(row)))
              if (kind === "update") data.forEach((row) => Object.assign(row, values))
              if (kind === "insert" || kind === "upsert")
                data = (Array.isArray(values) ? values : [values]).map((value) => {
                  const existing = kind === "upsert" && rows[table].find((row) => row.id === value.id)
                  if (existing) {
                    Object.assign(existing, value)
                    return existing
                  }
                  const row = { id: id(nextId++), ...structuredClone(value) }
                  rows[table].push(row)
                  return row
                })
              if (range) data = data.slice(range[0], range[1] + 1)
              return { data: single ? (data[0] ?? null) : data, error: null }
            })
            .then(resolve, reject)
        },
      }
      return q
    },
  }
  return db
}

test("actual nightly spine carries durable historic gap across short CDC, expired state, and deliberate disconnect", async (t) => {
  const f = await cdcDatabase(t)
  await f.install()
  await f.db.query(
    "update accounting_connections set settings=settings||jsonb_build_object('qbo_cdc_last_synced_at',$1::text),last_inbound_poll_at=now() where id=$2",
    [new Date(Date.now() - 35 * 86400000).toISOString(), f.connection],
  )
  const r = runtime(f, {
    changeDataCapture: async () => ({ CDCResponse: [{}] }),
    queryRecoveryPage: async () => ({ rows: [], done: true, total: 0 }),
  })
  await r.api.ingestQboCdcChanges({ connectionId: f.connection })
  const store = memory({
    books_settings: [{ org_id: f.org, workspace_enabled: false }],
  })
  const service = {
    from: (table) => (table === "accounting_connections" ? r.db.from(table) : store.from(table)),
  }
  const api = load("lib/services/books/reconciliation.ts", {
    "@/lib/supabase/server": { createServiceSupabaseClient: () => service },
    "@/lib/utils": require("@/lib/utils"),
    "@/lib/services/books/reconciliation-rules": load("lib/services/books/reconciliation-rules.ts"),
    "@/lib/services/books/reconciliation-digest": {},
    "@/lib/services/books/access": {},
    "@/lib/services/audit": {},
    "@/lib/services/context": {},
    "@/lib/services/events": { recordEvent: async () => {} },
    "@/lib/services/books/verifier": {},
    "@/lib/services/reports/reconciliation": {},
  })
  const first = await api.runOrgReconciliation(f.org)
  assert.ok(first.discrepancyCount > 0)
  const gap = store.rows.accounting_reconciliation_items.find((row) => row.category === "connection_cdc_recovery")
  assert.equal(gap.entity_id, f.connection)
  assert.equal(gap.status, "open")
  await r.api.ingestQboCdcChanges({ connectionId: f.connection })
  await api.runOrgReconciliation(f.org)
  assert.equal(store.rows.accounting_reconciliation_items.filter((row) => row.category === "connection_cdc_recovery").length, 1)
  assert.equal(gap.status, "open")
  assert.ok(gap.details.reasons.includes("lost_window"))
  await f.db.query("update accounting_connections set status='expired' where id=$1", [f.connection])
  await api.runOrgReconciliation(f.org)
  assert.equal(gap.status, "open")
  assert.ok(store.rows.accounting_reconciliation_items.some((row) => row.category === "connection_unhealthy" && row.status === "open"))
  await f.db.query("update accounting_connections set status='disconnected' where id=$1", [f.connection])
  await api.runOrgReconciliation(f.org)
  assert.equal(gap.status, "resolved", "deliberate disconnected convention is preserved")
})

test("actual authorized candidate listing is bounded/keyset, company scoped and denies restricted readers before service reads", async (t) => {
  const f = await cdcDatabase(t)
  await f.install()
  const run = await f.claim({ reasons: ["lost_window"] })
  const candidates = ["one", "two", "three"].map((external_id) => ({
    entity_name: "Invoice",
    external_id,
    revision: "a".repeat(64),
    document_number: external_id,
    transaction_date: null,
    last_updated: null,
  }))
  await f.persist(run, { candidates, release: true })
  const r = runtime(f, {})
  let scope = { projectMembershipRequired: false, divisionIds: null },
    denied = false,
    provider = "qbo",
    human = true
  const permissions = []
  const api = load("lib/services/accounting-import.ts", {
    "@/lib/services/context": {
      requireOrgContext: async () => {
        if (!human) throw new Error("Authentication required")
        return { orgId: f.org, userId: id(800), supabase: r.db }
      },
    },
    "@/lib/services/permissions": {
      requirePermission: async (permission) => {
        permissions.push(permission)
        if (denied) throw new Error("Forbidden")
      },
    },
    "@/lib/services/accounting-connections": {
      requireAccountingConnectionForOrg: async (connection, org) => {
        assert.equal(connection, f.connection)
        assert.equal(org, f.org)
        return { id: connection, provider, external_account_id: "realm" }
      },
    },
    "@/lib/services/authorization": {
      getProjectReadScopeForUser: async () => scope,
    },
    "@/lib/integrations/accounting/registry": {
      getProvider: () => ({
        capabilities: { supportsImport: true },
        previewImport: async () => {},
        applyImport: async () => {
          throw new Error("Unexpected financial dispatch")
        },
      }),
    },
    "@/lib/services/audit": {},
    "@/lib/services/events": {},
    "@/lib/supabase/server": { createServiceSupabaseClient: () => r.db },
  })
  const first = await api.listAccountingRecoveryCandidates({
    connectionId: f.connection,
    limit: 2,
  })
  const second = await api.listAccountingRecoveryCandidates({
    connectionId: f.connection,
    limit: 2,
    afterId: first.nextAfterId,
  })
  assert.equal(first.candidates.length, 2)
  assert.equal(second.candidates.length, 1)
  assert.equal(new Set([...first.candidates, ...second.candidates].map((row) => row.id)).size, 3)
  assert.equal(second.nextAfterId, null)
  assert.deepEqual(permissions, ["bill.read", "bill.read"])
  assert.ok(r.calls.every((call) => call.table !== "qbo_cdc_candidates" || !call.columns.includes("*")))
  for (const restricted of [
    { projectMembershipRequired: true, divisionIds: null },
    { projectMembershipRequired: false, divisionIds: [id(801)] },
  ]) {
    scope = restricted
    const before = r.calls.length
    await assert.rejects(api.listAccountingRecoveryCandidates({ connectionId: f.connection }), /organization-wide/)
    assert.equal(r.calls.length, before)
  }
  scope = { projectMembershipRequired: false, divisionIds: null }
  denied = true
  await assert.rejects(api.listAccountingRecoveryCandidates({ connectionId: f.connection }), /Forbidden/)
  denied = false
  provider = "file"
  await assert.rejects(api.listAccountingRecoveryCandidates({ connectionId: f.connection }), /provider/)
  provider = "qbo"
  human = false
  await assert.rejects(api.listAccountingRecoveryCandidates({ connectionId: f.connection }), /Authentication/)
  await assert.rejects(
    api.listAccountingRecoveryCandidates({
      connectionId: f.connection,
      limit: 201,
    }),
  )
})
