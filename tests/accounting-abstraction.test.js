require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { accountingPushBlockReason, selectAccountingMap } = require("../lib/services/accounting-rules")

test("accounting target precedence and same-connection dimension inheritance are deterministic", () => {
  const selected = selectAccountingMap([
    { id: "org", connection_id: "books-a", scope: "org_default", dimensions: { class: { id: "class-org", name: "All" } } },
    { id: "division", connection_id: "books-a", scope: "division", dimensions: { customer: { id: "customer-division", name: "Division customer" } } },
    { id: "community", connection_id: "books-b", scope: "community", dimensions: { class: { id: "class-community", name: "Community" } } },
    { id: "project", connection_id: "books-a", scope: "project", dimensions: { customer: { id: "customer-project", name: "Project customer" } } },
  ])

  assert.equal(selected.winner.id, "project")
  assert.deepEqual(selected.dimensions, {
    class: { id: "class-org", name: "All" },
    customer: { id: "customer-project", name: "Project customer" },
  })
})

test("accounting target resolution supports community, division, default, and unconnected modes", () => {
  assert.equal(selectAccountingMap([]), null)
  assert.equal(selectAccountingMap([{ id: "org", connection_id: "a", scope: "org_default", dimensions: {} }]).winner.id, "org")
  assert.equal(selectAccountingMap([{ id: "division", connection_id: "a", scope: "division", dimensions: {} }, { id: "org", connection_id: "a", scope: "org_default", dimensions: {} }]).winner.id, "division")
  assert.equal(selectAccountingMap([{ id: "community", connection_id: "a", scope: "community", dimensions: {} }, { id: "division", connection_id: "a", scope: "division", dimensions: {} }]).winner.id, "community")
})

test("accounting push orchestration silently skips unconnected and inbound-only records", () => {
  assert.equal(accountingPushBlockReason({ hasTarget: false, healthy: false, enabled: true }), "unconnected")
  assert.equal(accountingPushBlockReason({ hasTarget: true, healthy: true, pushable: false, enabled: true }), "inbound_only")
  assert.equal(accountingPushBlockReason({ hasTarget: true, healthy: true, enabled: false }), "disabled")
})

test("accounting push orchestration refuses unhealthy or re-homed transactions", () => {
  assert.equal(accountingPushBlockReason({ hasTarget: true, healthy: false, enabled: true }), "connection_unhealthy")
  assert.equal(accountingPushBlockReason({ hasTarget: true, healthy: true, existingConnectionId: "a", targetConnectionId: "b", enabled: true }), "connection_mismatch")
  assert.equal(accountingPushBlockReason({ hasTarget: true, healthy: true, existingConnectionId: "a", targetConnectionId: "a", enabled: true }), null)
})

test("counterparty links are scoped per accounting connection", () => {
  const fs = require("node:fs")
  const path = require("node:path")
  const migration = fs.readFileSync(
    path.join(__dirname, "../supabase/migrations/20260719020641_accounting_counterparty_links.sql"),
    "utf8",
  )
  const companies = fs.readFileSync(path.join(__dirname, "../lib/services/companies.ts"), "utf8")

  assert.match(migration, /unique \(org_id, connection_id, role, entity_type, entity_id\)/)
  assert.match(companies, /from\("accounting_counterparty_links"\)/)
  assert.match(companies, /onConflict: "org_id,connection_id,role,entity_type,entity_id"/)
})

test("accounting identities and imports are atomically scoped to one connection", () => {
  const fs = require("node:fs")
  const path = require("node:path")
  const migration = fs.readFileSync(path.join(__dirname, "../supabase/migrations/20260724010343_accounting_abstraction_hardening.sql"), "utf8")
  const importer = fs.readFileSync(path.join(__dirname, "../lib/integrations/accounting/qbo/import.ts"), "utf8")
  const reconciler = fs.readFileSync(path.join(__dirname, "../lib/integrations/accounting/qbo/reconcile.ts"), "utf8")

  assert.match(migration, /accounting_sync_records \(org_id, connection_id, entity_type, entity_id\)/)
  assert.match(migration, /create table if not exists public\.accounting_import_claims/)
  assert.match(migration, /unique \(connection_id, external_entity_type, external_id\)/)
  assert.match(importer, /rpc\("accounting_claim_import"/)
  assert.match(importer, /rpc\("accounting_finish_import"/)
  assert.match(importer, /\.eq\("connection_id", connectionId\)/)
  assert.match(reconciler, /resolveLocalSyncMapping\(params\.supabase, params\.orgId, params\.connectionId/)
})

test("QBO reconnects preserve identity and outbound lookups stay connection-scoped", () => {
  const fs = require("node:fs")
  const path = require("node:path")
  const connections = fs.readFileSync(path.join(__dirname, "../lib/services/accounting-connections.ts"), "utf8")
  const adapter = fs.readFileSync(path.join(__dirname, "../lib/integrations/accounting/qbo/adapter.ts"), "utf8")
  const pushFunctions = [
    "syncInvoiceToQBO",
    "syncPaymentToQBO",
    "syncProjectExpenseToQBO",
    "syncVendorBillToQBO",
    "syncBillPaymentToQBO",
  ]

  assert.match(connections, /\.eq\("external_account_id", input\.realmId\)/)
  assert.match(connections, /existingConnection[\s\S]*?\.update\(connectionPayload\)/)

  for (const [index, functionName] of pushFunctions.entries()) {
    const start = adapter.indexOf(`export async function ${functionName}`)
    const nextName = pushFunctions[index + 1]
    const end = nextName ? adapter.indexOf(`export async function ${nextName}`, start) : adapter.indexOf("async function upsertSyncRecord", start)
    const body = adapter.slice(start, end)
    assert.match(body, /resolveHealthConnectionId\(orgId, options\?\.connectionId\)/, `${functionName} does not resolve a connection identity`)
    assert.match(body, /\.eq\("connection_id", resolvedConnectionId\)/, `${functionName} reads an unscoped sync identity`)
  }
})

test("accounting hardening preserves old-code compatibility through deployment", () => {
  const fs = require("node:fs")
  const path = require("node:path")
  const hardening = fs.readFileSync(path.join(__dirname, "../supabase/migrations/20260724010343_accounting_abstraction_hardening.sql"), "utf8")
  const completion = fs.readFileSync(path.join(__dirname, "../supabase/migrations/20260724010430_accounting_neutral_backfill_completion.sql"), "utf8")
  const coding = fs.readFileSync(path.join(__dirname, "../lib/services/accounting-coding.ts"), "utf8")

  assert.doesNotMatch(hardening, /drop index if exists public\.accounting_sync_records_entity_idx/)
  assert.doesNotMatch(hardening, /drop column if exists credentials/)
  assert.match(hardening, /accounting_sync_records_connection_entity_idx/)
  assert.match(completion, /accounting_coding->'vendor'/)
  assert.match(completion, /accounting_coding->'class'/)
  assert.match(completion, /legacy_review_state_preserved_at/)
  assert.match(coding, /typed\?\.counterparty \?\? typed\?\.vendor/)
})

test("routing guards, settings, and CDC scheduling are provider-aware", () => {
  const fs = require("node:fs")
  const path = require("node:path")
  const target = fs.readFileSync(path.join(__dirname, "../lib/services/accounting-target.ts"), "utf8")
  const panel = fs.readFileSync(path.join(__dirname, "../components/integrations/accounting-connections-panel.tsx"), "utf8")
  const cdc = fs.readFileSync(path.join(__dirname, "../app/api/accounting/process-changes/route.ts"), "utf8")

  assert.match(target, /countSyncedTransactionsForScope/)
  assert.match(target, /capabilities\.dimensions/)
  assert.match(target, /This routing scope has/)
  assert.match(panel, /getAccountingConnectionConfigurationAction/)
  assert.match(panel, /capabilities\.dimensions/)
  assert.match(panel, /updateAccountingConnectionSettingsAction/)
  assert.match(cdc, /order\("last_inbound_poll_at", \{ ascending: true, nullsFirst: true \}\)/)
  assert.match(cdc, /update\(\{ last_inbound_poll_at:/)
})

test("shared accounting orchestration does not hard-code the QBO provider", () => {
  const fs = require("node:fs")
  const path = require("node:path")
  const sync = fs.readFileSync(path.join(__dirname, "../lib/services/accounting-sync.ts"), "utf8")
  const outbox = fs.readFileSync(path.join(__dirname, "../app/api/accounting/process-outbox/route.ts"), "utf8")
  const maintenance = fs.readFileSync(path.join(__dirname, "../lib/services/accounting-connection-maintenance.ts"), "utf8")

  assert.doesNotMatch(sync, /provider: "qbo"/)
  assert.match(sync, /provider\.pushInvoice\(\{ orgId: input\.orgId, connectionId, invoiceId:/)
  assert.doesNotMatch(outbox, /refreshQBOConnectionsDueForKeepalive|processQBOOutbox|QBO_JOB_TYPES/)
  assert.match(outbox, /keepAliveAccountingConnections/)
  assert.match(maintenance, /listProviders\(\)/)
})

test("application accounting workflows depend on the provider seam", () => {
  const fs = require("node:fs")
  const path = require("node:path")
  const applicationFiles = [
    "../app/(app)/projects/actions.ts",
    "../app/(app)/companies/actions.ts",
    "../app/(app)/projects/[id]/expenses/actions.ts",
    "../app/(app)/projects/[id]/payables/actions.ts",
    "../app/(app)/invoices/actions.ts",
    "../lib/services/invoice-numbers.ts",
  ]
  for (const file of applicationFiles) {
    const source = fs.readFileSync(path.join(__dirname, file), "utf8")
    assert.doesNotMatch(source, /QBOClient/, `${file} bypasses the accounting provider seam`)
  }
})
