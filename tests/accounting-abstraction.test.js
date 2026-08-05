require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
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
  assert.match(importer, /const claimSupabase = createServiceSupabaseClient\(\)/)
  assert.match(importer, /claimSupabase\.rpc\("accounting_claim_import"/)
  assert.match(importer, /claimSupabase\.rpc\("accounting_finish_import"/)
  assert.doesNotMatch(importer, /(?<!claimSupabase\.)rpc\("accounting_(?:claim|finish)_import"/)
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
  const panel = [
    "../components/integrations/accounting-connection-sheet.tsx",
    "../components/integrations/accounting-routing-dialog.tsx",
  ].map((file) => fs.readFileSync(path.join(__dirname, file), "utf8")).join("\n")
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

// ---------------------------------------------------------------------------
// File-based accounting targets.
//
// Sage 300 CRE, Foundation and Viewpoint import AP through a delimited file
// rather than an API, so the "push" for those targets is a rendered batch. The
// rendering is pure, which is how it gets tested without a database.
// ---------------------------------------------------------------------------

const {
  BATCH_FORMATS,
  isAccountingBatchFormat,
  renderAccountingBatch,
} = require("../lib/integrations/accounting/file/formats")

function billLine(overrides = {}) {
  return {
    entityType: "bill",
    direction: "post",
    amountCents: 1_234_56,
    currency: "usd",
    postedAt: "2026-08-04T00:00:00.000Z",
    memo: "Vendor invoice 8891",
    payload: {
      arc_reference: "bill-1",
      vendor_name: "Southeast Lumber Supply",
      document_number: "8891",
      due_date: "2026-09-03",
      job_name: "Lot 44 — Maple",
      cost_code: "06-1000",
      cost_type: "Material",
    },
    ...overrides,
  }
}

test("every batch format renders a header plus one row per line", () => {
  for (const key of Object.keys(BATCH_FORMATS)) {
    const rendered = renderAccountingBatch(key, [billLine(), billLine({ payload: { ...billLine().payload, arc_reference: "bill-2" } })])
    const rows = rendered.split("\r\n")
    assert.equal(rows.length, 3, `${key} should render a header and two rows`)
    assert.equal(rows[0].split(",").length, BATCH_FORMATS[key].columns.length)
  }
})

test("money renders from integer cents with no floating point in the path", () => {
  // 1234.56 is not representable in binary floating point; rendering it through
  // division would be exactly the bug integer cents exists to prevent.
  const rendered = renderAccountingBatch("generic", [billLine({ amountCents: 1_234_56 })])
  assert.match(rendered, /(^|,)1234\.56(,|$)/m)
  assert.match(renderAccountingBatch("generic", [billLine({ amountCents: 5 })]), /(^|,)0\.05(,|$)/m)
  assert.match(renderAccountingBatch("generic", [billLine({ amountCents: 100 })]), /(^|,)1\.00(,|$)/m)
})

test("a reversal renders negative so the import reads it as a debit memo", () => {
  const rendered = renderAccountingBatch("sage300", [billLine({ direction: "reverse" })])
  assert.match(rendered, /-1234\.56/)
})

test("batch rendering escapes separators rather than corrupting a row", () => {
  const rendered = renderAccountingBatch("generic", [
    billLine({ memo: 'Paid "in full", per contract', payload: { ...billLine().payload, vendor_name: "Smith, Jones & Co" } }),
  ])
  const rows = rendered.split("\r\n")
  assert.equal(rows.length, 2)
  assert.match(rows[1], /"Smith, Jones & Co"/)
  assert.match(rows[1], /"Paid ""in full"", per contract"/)
})

test("batch dates are bare calendar dates, never ISO instants", () => {
  // These importers reject a timestamp, and a timezone-shifted date posts a
  // vendor invoice into the wrong period.
  const rendered = renderAccountingBatch("viewpoint", [billLine()])
  assert.match(rendered, /2026-08-04/)
  assert.doesNotMatch(rendered, /T00:00:00/)
})

test("batch formats emit no column Arc cannot populate", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../lib/integrations/accounting/file/formats.ts"), "utf8")
  // companies has no vendor_code and projects has no job_number, so a column fed
  // by either would be blank on every row and read as a mapping that exists.
  assert.doesNotMatch(source, /vendor_code/)
  assert.doesNotMatch(source, /job_code/)
  assert.doesNotMatch(source, /gl_account/)
})

test("the format registry and its guard agree", () => {
  for (const key of Object.keys(BATCH_FORMATS)) assert.ok(isAccountingBatchFormat(key))
  assert.equal(isAccountingBatchFormat("sage100"), false)
  assert.equal(isAccountingBatchFormat(null), false)
})

test("only self-serve providers are offered in the add-connection menu", () => {
  const { ACCOUNTING_PROVIDERS, ACCOUNTING_PROVIDER_KEYS, CONNECTABLE_ACCOUNTING_PROVIDER_KEYS } =
    require("../lib/integrations/accounting/catalog")

  // A `configured` provider has no remote system to authorize against, so
  // offering it in an OAuth menu is a button that can only fail.
  for (const key of CONNECTABLE_ACCOUNTING_PROVIDER_KEYS) {
    assert.equal(ACCOUNTING_PROVIDERS[key].connectFlow, "oauth", `${key} is offered but cannot be connected`)
  }
  assert.ok(CONNECTABLE_ACCOUNTING_PROVIDER_KEYS.length < ACCOUNTING_PROVIDER_KEYS.length)
  assert.equal(ACCOUNTING_PROVIDERS.file.connectFlow, "configured")

  // Every declared logo has to exist, or the UI renders a broken image.
  for (const key of ACCOUNTING_PROVIDER_KEYS) {
    const logoUrl = ACCOUNTING_PROVIDERS[key].logoUrl
    if (logoUrl === null) continue
    assert.ok(
      fs.existsSync(path.resolve(__dirname, "../public", logoUrl.replace(/^\//, ""))),
      `${key} declares ${logoUrl}, which does not exist in public/`,
    )
  }
})

test("the integrations panel renders a fallback for providers with no logo", () => {
  for (const file of [
    "../components/integrations/integrations-panel.tsx",
    "../components/integrations/accounting-connection-sheet.tsx",
  ]) {
    const source = fs.readFileSync(path.resolve(__dirname, file), "utf8")
    assert.match(source, /logoUrl \?/, `${file} must branch on a null logo rather than rendering it`)
  }
})
