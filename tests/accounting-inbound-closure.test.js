const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const Module = require("node:module")
const ts = require("typescript")

function database(seed = {}, failure) {
  const rows = structuredClone(seed)
  const calls = []
  const db = {
    rows,
    calls,
    from(table) {
      let filters = [],
        operation = "select",
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
        update(value) {
          operation = "update"
          values = value
          return q
        },
        upsert(value) {
          operation = "upsert"
          values = value
          return q
        },
        then(resolve, reject) {
          return Promise.resolve()
            .then(() => {
              calls.push({ table, operation, values })
              const error = failure?.(table, operation)
              if (error) return { data: null, error: { message: error } }
              let selected = (rows[table] ?? []).filter((row) => filters.every((filter) => filter(row)))
              if (operation === "update") selected.forEach((row) => Object.assign(row, values))
              if (operation === "upsert") {
                const existing = (rows[table] ?? []).find((row) =>
                  values.entity_id
                    ? row.entity_id === values.entity_id && row.connection_id === values.connection_id
                    : row.event_id === values.event_id,
                )
                if (existing) Object.assign(existing, values)
                else (rows[table] ??= []).push(structuredClone(values))
                selected = [values]
              }
              if (range) selected = selected.slice(range[0], range[1] + 1)
              return { data: single ? (selected[0] ?? null) : selected, error: null }
            })
            .then(resolve, reject)
        },
      }
      return q
    },
    async rpc(name, args) {
      calls.push({ rpc: name, args })
      if (name === "replace_invoice_lines_atomic") {
        Object.assign(
          rows.invoices.find((row) => row.id === args.p_invoice_id),
          args.p_invoice_update,
        )
        rows.invoice_lines = args.p_lines
      }
      return { data: true, error: null }
    },
  }
  return db
}

function load(relativePath, db, overrides = {}) {
  const filename = path.resolve(__dirname, "..", relativePath)
  let source = fs.readFileSync(filename, "utf8")
  if (relativePath.endsWith("reconcile.ts"))
    source += "\nexport const testing = { reconcilePaymentFacts, reconcileProjectExpenseFromQbo }\n"
  if (relativePath.endsWith("connections.ts")) source += "\nexport const testing = { refreshConnectionTokens }\n"
  const collector = async (fetch) => {
    const result = await fetch(0, 999)
    if (result.error) throw new Error(result.error.message)
    return result.data ?? []
  }
  const stubs = {
    "@/lib/services/accounting-delivery": { withAccountingDeliveryGroup: async (_identities, _deadline, work) => work() },
    "@/lib/supabase/server": { createServiceSupabaseClient: () => db },
    "@/lib/services/accounting-logger": { logQBO() {} },
    "@/lib/services/events": { recordEvent: async () => {} },
    "@/lib/services/books/authority": { resolveLedgerAuthority: async () => "external" },
    "@/lib/integrations/accounting/local-change": {
      storedLocalFingerprint: () => "old",
      computeLocalFingerprint: () => "new",
      arcChangedSinceSync: () => true,
      stampLocalFingerprint: async () => {},
    },
    "@/lib/financials/ledger-status": { isPayableVendorBillStatus: (status) => ["approved", "paid", "partial"].includes(status) },
    "@/lib/services/invoice-balance": { recalcInvoiceBalanceAndStatus: async () => {} },
    "@/lib/services/accounting-sync-attempts": { recordAccountingSyncAttempt: async () => {} },
    "@/lib/services/invoice-numbers": { rememberAccountingInvoiceNumberCursor: async () => {} },
    "@/lib/integrations/accounting/qbo/webhook": {
      verifyIntuitWebhookSignature: () => true,
      extractIntuitEntityEvents: (payload) => payload.events,
      normalizeEventTimestamp: (value) => (Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : "unknown-time"),
    },
    "@/lib/integrations/accounting/qbo/import-rules": {
      collectPaginatedRows: collector,
      qboPurchaseIsCredit: () => false,
      extractLinkedQboAmounts: (remote, type) =>
        remote.Line.flatMap((line) =>
          line.LinkedTxn.filter((txn) => txn.TxnType.toLowerCase() === type).map((txn) => ({
            qboId: txn.TxnId,
            amountCents: Math.round(line.Amount * 100),
          })),
        ),
    },
    "@/lib/services/accounting-enqueue": {},
    ...overrides,
  }
  const mod = new Module(filename, module)
  mod.filename = filename
  mod.paths = module.paths
  mod.require = (name) => (name in stubs ? stubs[name] : require(name))
  mod._compile(
    ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    filename,
  )
  return mod.exports
}

const mapping = (extra = {}) => ({
  entity_id: "invoice",
  entity_type: "invoice",
  external_id: "42",
  external_version: "7",
  status: "needs_review",
  org_id: "org",
  connection_id: "connection",
  metadata: {},
  ...extra,
})
const invoice = {
  Id: "42",
  SyncToken: "7",
  TotalAmt: 125,
  Balance: 125,
  TxnDate: "2026-09-01",
  Line: [{ Amount: 125, Description: "Revised", DetailType: "SalesItemLineDetail", SalesItemLineDetail: { Qty: 1, UnitPrice: 125 } }],
}

test("take remote applies a version already observed by a real conflict", async () => {
  const db = database({ accounting_sync_records: [mapping()], invoices: [{ id: "invoice", org_id: "org", total_cents: 10000 }] })
  const api = load("lib/integrations/accounting/qbo/reconcile.ts", db, {
    "@/lib/integrations/accounting/qbo/client": { QBOClient: { forConnection: async () => ({ getInvoiceById: async () => invoice }) } },
  })
  const result = await api.forceReconcileFromQbo({ orgId: "org", connectionId: "connection", entityType: "invoice", externalId: "42" })
  assert.equal(result.reconciled, true)
  assert.equal(db.rows.invoices[0].total_cents, 12500)
  assert.equal(db.rows.invoice_lines[0].description, "Revised")
  assert.equal(db.rows.accounting_sync_records[0].status, "synced")
  assert.equal(db.rows.accounting_sync_records[0].external_version, "7")
})

test("take remote rejects records whose conflict has already been resolved", async () => {
  const db = database({ accounting_sync_records: [mapping({ status: "synced" })] })
  let providerCalls = 0
  const api = load("lib/integrations/accounting/qbo/reconcile.ts", db, {
    "@/lib/integrations/accounting/qbo/client": {
      QBOClient: {
        forConnection: async () => {
          providerCalls++
          return {}
        },
      },
    },
  })
  const result = await api.forceReconcileFromQbo({ orgId: "org", connectionId: "connection", entityType: "invoice", externalId: "42" })
  assert.equal(result.reconciled, false)
  assert.equal(providerCalls, 0)
})

test("a webhook storage failure rejects acknowledgment so delivery can retry", async () => {
  const db = database({}, (table) => (table === "qbo_webhook_events" ? "database unavailable" : null))
  const api = load("lib/integrations/accounting/qbo/reconcile.ts", db, { "@/lib/integrations/accounting/qbo/client": {} })
  await assert.rejects(
    api.receiveQboWebhook({
      rawBody: JSON.stringify({
        events: [{ eventId: "e", realmId: "realm", entityName: "Invoice", entityId: "42", lastUpdated: "unknown-time" }],
      }),
      headers: {},
    }),
    /database unavailable/,
  )
})

test("transient mapping read failure remains retryable instead of an unmatched event", async () => {
  const db = database({}, (table) => (table === "accounting_sync_records" ? "transient read failure" : null))
  const api = load("lib/integrations/accounting/qbo/reconcile.ts", db, { "@/lib/integrations/accounting/qbo/client": {} })
  await assert.rejects(
    api.reconcileInvoiceFromQbo({ supabase: db, client: {}, orgId: "org", connectionId: "connection", qboInvoiceId: "42" }),
    /transient read failure/,
  )
})

test("split purchase reconciliation marks the entire group without overwriting allocations", async () => {
  const db = database({
    accounting_sync_records: [
      mapping({ entity_type: "project_expense", entity_id: "e1" }),
      mapping({ entity_type: "project_expense", entity_id: "e2" }),
    ],
    project_expenses: [
      { id: "e1", amount_cents: 4000 },
      { id: "e2", amount_cents: 6000 },
    ],
  })
  const api = load("lib/integrations/accounting/qbo/reconcile.ts", db, { "@/lib/integrations/accounting/qbo/client": {} })
  await api.testing.reconcileProjectExpenseFromQbo({
    supabase: db,
    client: { getPurchaseById: async () => ({ SyncToken: "8", TotalAmt: 120 }) },
    orgId: "org",
    connectionId: "connection",
    qboId: "42",
    entityName: "purchase",
  })
  assert.deepEqual(
    db.rows.project_expenses.map((row) => row.amount_cents),
    [4000, 6000],
  )
  assert.ok(db.rows.accounting_sync_records.every((row) => row.status === "needs_review" && row.error_message.includes("split purchase")))
})

for (const change of ["amount", "allocation", "delete"])
  test(`remote payment ${change} preserves cash and creates a visible conflict`, async () => {
    const db = database({
      accounting_sync_records: [
        mapping({ entity_type: "payment", entity_id: "payment" }),
        mapping({ external_id: "remote-invoice", status: "synced" }),
      ],
      payments: [{ id: "payment", org_id: "org", invoice_id: "invoice", amount_cents: 10000, status: "succeeded" }],
    })
    const before = structuredClone(db.rows.payments)
    const api = load("lib/integrations/accounting/qbo/reconcile.ts", db, { "@/lib/integrations/accounting/qbo/client": {} })
    await api.testing.reconcilePaymentFacts({
      supabase: db,
      orgId: "org",
      connectionId: "connection",
      entityType: "payment",
      externalId: "42",
      operation: change === "delete" ? "Delete" : "Update",
      remote: {
        TotalAmt: change === "amount" ? 110 : 100,
        Line: [{ Amount: 100, LinkedTxn: [{ TxnId: change === "allocation" ? "other-invoice" : "remote-invoice", TxnType: "Invoice" }] }],
      },
    })
    assert.deepEqual(db.rows.payments, before)
    assert.equal(db.rows.accounting_sync_records[0].status, "needs_review")
  })

test("delayed token refresh failure cannot expire credentials written by reconnect", async () => {
  const old = {
    id: "connection",
    org_id: "org",
    external_account_id: "realm",
    access_token: "old-access",
    refresh_token: "old-refresh",
    status: "active",
  }
  const db = database({
    accounting_connections: [
      { ...old, access_token: "new-access", refresh_token: "new-refresh", refresh_failure_count: 0, last_error: null },
    ],
  })
  const api = load("lib/integrations/accounting/qbo/connections.ts", db, {
    "@/lib/integrations/accounting/qbo/auth": {
      getQBOClientId: () => "client",
      decryptToken: (value) => value,
      refreshAccessToken: async () => {
        throw new Error("invalid_grant")
      },
    },
  })
  const result = await api.testing.refreshConnectionTokens(db, old, { force: true, source: "manual" })
  assert.deepEqual(result, { token: "new-access", realmId: "realm" })
  assert.equal(db.rows.accounting_connections[0].status, "active")
  assert.equal(db.rows.accounting_connections[0].last_error, null)
  assert.equal(db.rows.accounting_connections[0].refresh_failure_count, 0)
})

test("missing CDC timestamps are durably queued without a RangeError and permit cursor persistence", async () => {
  const db = database({
    accounting_connections: [{ id: "connection", org_id: "org", external_account_id: "realm", status: "active", settings: {} }],
  })
  const api = load("lib/integrations/accounting/qbo/reconcile.ts", db, {
    "@/lib/integrations/accounting/qbo/client": {
      QBOClient: {
        forConnection: async () => ({
          changeDataCapture: async () => ({ CDCResponse: [{ QueryResponse: [{ Invoice: [{ Id: "42" }] }] }] }),
        }),
      },
    },
  })
  assert.deepEqual(await api.ingestQboCdcChanges({ connectionId: "connection" }), { scanned: 1, inserted: 1 })
  assert.equal(db.rows.qbo_webhook_events[0].last_updated, null)
  assert.ok(db.calls.some((call) => call.rpc === "update_qbo_cdc_cursor"))
})

test("split purchase compares every allocation before accepting a metadata-only remote revision", async () => {
  const db = database({
    accounting_sync_records: [
      mapping({ entity_type: "project_expense", entity_id: "e1", status: "synced", metadata: { source: "purchase_split" } }),
      mapping({ entity_type: "project_expense", entity_id: "e2", status: "synced", metadata: { source: "purchase_split" } }),
    ],
    project_expenses: [
      {
        id: "e1",
        org_id: "org",
        amount_cents: 4000,
        expense_date: "2026-09-01",
        metadata: { qbo_purchase_line_id: "one" },
        accounting_coding: { expense_account: { id: "account" } },
      },
      {
        id: "e2",
        org_id: "org",
        amount_cents: 6000,
        expense_date: "2026-09-01",
        metadata: { qbo_purchase_line_id: "two" },
        accounting_coding: { expense_account: { id: "account" } },
      },
    ],
  })
  const api = load("lib/integrations/accounting/qbo/reconcile.ts", db, { "@/lib/integrations/accounting/qbo/client": {} })
  const result = await api.testing.reconcileProjectExpenseFromQbo({
    supabase: db,
    client: {
      getPurchaseById: async () => ({
        SyncToken: "8",
        TotalAmt: 100,
        TxnDate: "2026-09-01",
        Line: [
          { Id: "one", Amount: 40, AccountBasedExpenseLineDetail: { AccountRef: { value: "account" } } },
          { Id: "two", Amount: 60, AccountBasedExpenseLineDetail: { AccountRef: { value: "account" } } },
        ],
      }),
    },
    orgId: "org",
    connectionId: "connection",
    qboId: "42",
    entityName: "purchase",
  })
  assert.equal(result.reconciled, true)
  assert.ok(db.rows.accounting_sync_records.every((row) => row.status === "synced" && row.external_version === "8"))
  assert.deepEqual(
    db.rows.project_expenses.map((row) => row.amount_cents),
    [4000, 6000],
  )
})

test("force resolution revalidates conflict state after acquiring delivery ownership", async () => {
  const db = database({ accounting_sync_records: [mapping()] })
  let remoteReads = 0
  const api = load("lib/integrations/accounting/qbo/reconcile.ts", db, {
    "@/lib/integrations/accounting/qbo/client": {
      QBOClient: {
        forConnection: async () => ({
          getInvoiceById: async () => {
            remoteReads++
            return invoice
          },
        }),
      },
    },
    "@/lib/services/accounting-delivery": {
      withAccountingDeliveryGroup: async (_identities, _deadline, work) => {
        db.rows.accounting_sync_records[0].status = "synced"
        return work()
      },
    },
  })
  const result = await api.forceReconcileFromQbo({ orgId: "org", connectionId: "connection", entityType: "invoice", externalId: "42" })
  assert.equal(result.reconciled, false)
  assert.equal(remoteReads, 0)
})

test("the shared import service dispatches a second provider without QBO transport", async () => {
  const orgId = "29000000-0000-0000-0000-000000000001"
  const connectionId = "39000000-0000-0000-0000-000000000001"
  const db = database()
  const calls = []
  const provider = {
    capabilities: { supportsImport: true },
    previewImport: async (input) => {
      calls.push(["preview", input])
      return { connected: true, records: [] }
    },
    applyImport: async (input) => {
      calls.push(["apply", input])
      return { imported: 1, failed: 0, skipped: 0, errors: [] }
    },
  }
  const api = load("lib/services/accounting-import.ts", db, {
    "@/lib/services/context": { requireOrgContext: async () => ({ orgId, userId: "user", supabase: db }) },
    "@/lib/services/permissions": { requirePermission: async () => {} },
    "@/lib/services/accounting-connections": {
      requireAccountingConnectionForOrg: async () => ({ id: connectionId, provider: "test-ledger" }),
    },
    "@/lib/integrations/accounting/registry": { getProvider: () => provider },
    "@/lib/services/audit": { recordAudit: async () => {} },
  })
  await api.previewAccountingImport({ connectionId })
  const result = await api.applyAccountingImport({ connectionId, items: [{ externalId: "test-payment", entityType: "payment" }] })
  assert.equal(result.imported, 1)
  assert.equal(calls[0][1].orgId, orgId)
  assert.equal(calls[1][1].items[0].externalId, "test-payment")
})

test("shared import authorization denies a viewer before provider dispatch", async () => {
  let calls = 0
  const db = database()
  const api = load("lib/services/accounting-import.ts", db, {
    "@/lib/services/context": { requireOrgContext: async () => ({ orgId: "org", userId: "viewer", supabase: db }) },
    "@/lib/services/permissions": {
      requirePermission: async () => {
        throw new Error("Permission denied")
      },
    },
    "@/lib/services/accounting-connections": {},
    "@/lib/integrations/accounting/registry": {
      getProvider: () => {
        calls++
        return {}
      },
    },
    "@/lib/services/audit": {},
  })
  await assert.rejects(
    api.applyAccountingImport({
      connectionId: "39000000-0000-0000-0000-000000000001",
      items: [{ externalId: "42", entityType: "payment" }],
    }),
    /Permission denied/,
  )
  assert.equal(calls, 0)
})

test("OAuth attempts bind provider, user, connection, company and expiry independently", () => {
  const before = process.env.TOKEN_ENCRYPTION_KEY
  process.env.TOKEN_ENCRYPTION_KEY = "test-only-secret-not-production"
  try {
    const api = load("lib/integrations/accounting/oauth-state.ts", database())
    const input = {
      provider: "qbo",
      orgId: "29000000-0000-0000-0000-000000000001",
      userId: "19000000-0000-0000-0000-000000000001",
      connectionId: "39000000-0000-0000-0000-000000000001",
      expectedAccountId: "realm",
    }
    const first = api.createAccountingOAuthState(input),
      second = api.createAccountingOAuthState(input)
    const verified = api.verifyAccountingOAuthState(first, "qbo")
    assert.equal(verified.connectionId, input.connectionId)
    assert.equal(verified.userId, input.userId)
    assert.equal(verified.expectedAccountId, "realm")
    assert.ok(verified.expiresAt > Date.now())
    assert.equal(api.verifyAccountingOAuthState(first, "other-provider"), null)
    assert.equal(api.verifyAccountingOAuthState(first + "tampered", "qbo"), null)
    assert.notEqual(api.accountingOAuthCookieName(verified), api.accountingOAuthCookieName(api.verifyAccountingOAuthState(second, "qbo")))
  } finally {
    if (before === undefined) delete process.env.TOKEN_ENCRYPTION_KEY
    else process.env.TOKEN_ENCRYPTION_KEY = before
  }
})
