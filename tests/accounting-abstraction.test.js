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
  // QBO connection + token machinery lives under the adapter: it is
  // provider-specific by nature, and keeping it in the neutral service both
  // forced eight hardcoded `provider = "qbo"` lookups and closed an import cycle
  // once that service started dispatching through the registry.
  const connections = fs.readFileSync(path.join(__dirname, "../lib/integrations/accounting/qbo/connections.ts"), "utf8")
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

test("D2 has a Patagonia-specific, read-only, fail-closed preflight", () => {
  const fs = require("node:fs")
  const path = require("node:path")
  const preflight = fs.readFileSync(path.join(__dirname, "../docs/production-expansion/08-accounting-d2-preflight.sql"), "utf8")

  assert.match(preflight, /Patagonia Development LLC/)
  assert.match(preflight, /9341456671106880/)
  assert.match(preflight, /blocking_expense_coding/)
  assert.match(preflight, /blocking_bill_coding/)
  assert.match(preflight, /pg_get_functiondef/)
  assert.doesNotMatch(preflight, /\b(?:update|insert|delete|alter|drop|truncate)\s+(?:table\s+)?public\./i)
  assert.doesNotMatch(preflight, /\bcascade\b/i)
})

test("the pending D2 finalizer archives legacy values and never overwrites neutral coding", () => {
  const fs = require("node:fs")
  const path = require("node:path")
  const finalizer = fs.readFileSync(path.join(__dirname, "../supabase/pending-migrations/accounting_d2_lossless_finalizer.sql"), "utf8")

  assert.match(finalizer, /accounting_d2_legacy_archive/)
  assert.match(finalizer, /enable row level security/)
  assert.match(finalizer, /revoke all .* from public, anon, authenticated/)
  assert.match(finalizer, /coalesce\(e\.accounting_coding->'expense_account'/)
  assert.match(finalizer, /coalesce\(b\.accounting_coding->'expense_account'/)
  assert.match(finalizer, /Patagonia active QBO realm identity changed/)
  assert.match(finalizer, /non-null legacy\/neutral expense-account conflicts require disposition/)
  assert.doesNotMatch(finalizer, /drop\s+(?:table|column|view)/i)
  assert.doesNotMatch(finalizer, /\bcascade\b/i)
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
  const connections = fs.readFileSync(path.join(__dirname, "../lib/services/accounting-connections.ts"), "utf8")

  assert.doesNotMatch(sync, /provider: "qbo"/)
  assert.match(sync, /provider\.pushInvoice\(\{ orgId: input\.orgId, connectionId, invoiceId:/)
  assert.doesNotMatch(outbox, /refreshQBOConnectionsDueForKeepalive|processQBOOutbox|QBO_JOB_TYPES/)
  assert.match(outbox, /keepAliveAccountingConnections/)
  assert.match(connections, /listProviders\(\)/)
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

test("expense recoding writes only neutral coding and pending ledger state", () => {
  const fs = require("node:fs")
  const path = require("node:path")
  const actions = fs.readFileSync(path.join(__dirname, "../app/(app)/projects/[id]/expenses/actions.ts"), "utf8")
  const sync = fs.readFileSync(path.join(__dirname, "../lib/services/accounting-sync.ts"), "utf8")
  const workspace = actions.slice(
    actions.indexOf("export async function updateProjectExpenseWorkspaceAction"),
    actions.indexOf("export async function updateProjectExpenseAccountingAction"),
  )
  const accounting = actions.slice(
    actions.indexOf("export async function updateProjectExpenseAccountingAction"),
    actions.indexOf("export async function syncProjectExpenseToQBOAction"),
  )

  for (const body of [workspace, accounting]) {
    assert.match(body, /accounting_coding/)
    assert.match(body, /markAccountingEntityPending/)
    assert.doesNotMatch(body, /qbo_sync_(?:status|error)/)
    assert.doesNotMatch(body, /updateData\.qbo_/)
  }
  assert.match(sync, /export async function markAccountingEntityPending/)
  assert.match(sync, /update\(\{ status: "pending", error_message: null \}\)/)
})

test("vendor-bill recoding writes neutral coding and resolves linked state from the ledger", () => {
  const fs = require("node:fs")
  const path = require("node:path")
  const bills = fs.readFileSync(path.join(__dirname, "../lib/services/vendor-bills.ts"), "utf8")
  const update = bills.slice(
    bills.indexOf("export async function updateVendorBillStatus"),
    bills.indexOf("export async function", bills.indexOf("export async function updateVendorBillStatus") + 1),
  )

  assert.match(update, /accounting_coding = buildAccountingCoding/)
  assert.match(update, /getAccountingSyncState/)
  assert.match(update, /billSyncState\?\.externalId/)
  assert.doesNotMatch(update, /updateData\.qbo_(?:expense|ap)_account/)
  assert.doesNotMatch(update, /updateData\.qbo_(?:sync_status|sync_error|vendor)/)
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


/** Source with comments stripped, so a guard cannot be satisfied or broken by prose. */
function codeOnly(relative) {
  const source = fs.readFileSync(path.join(__dirname, relative), "utf8")
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim()
      return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*")
    })
    .join("\n")
}

test("the both-sides conflict predicate is false immediately after a sync write", () => {
  const {
    arcChangedSinceSync,
    computeLocalFingerprint,
    storedLocalFingerprint,
    LOCAL_FINGERPRINT_KEY,
  } = require("../lib/integrations/accounting/local-change")

  // The old predicate was `updated_at > qbo_synced_at`: a database-trigger
  // timestamp compared against a JS wall clock captured before the write, so it
  // was true by the request latency after EVERY sync. Every genuine
  // QuickBooks-side edit therefore routed to needs_review instead of
  // reconciling. The replacement compares content the sync write never touches.
  const invoice = { subtotal_cents: 1_000_00, tax_cents: 82_50, total_cents: 1_082_50, balance_due_cents: 1_082_50 }
  const stamped = computeLocalFingerprint("invoice", invoice)
  assert.ok(stamped)

  // Sync, then immediately reconcile: no Arc-side change. The sync write only
  // moves `qbo_*` bookkeeping columns and `updated_at`, neither of which is
  // hashed.
  assert.equal(
    arcChangedSinceSync({ storedFingerprint: stamped, currentFingerprint: computeLocalFingerprint("invoice", { ...invoice }) }),
    false,
  )

  // A person repricing the invoice afterwards is the only thing that flips it.
  assert.equal(
    arcChangedSinceSync({
      storedFingerprint: stamped,
      currentFingerprint: computeLocalFingerprint("invoice", { ...invoice, total_cents: 1_200_00 }),
    }),
    true,
  )

  // Never fabricated from missing evidence — a row that predates fingerprinting
  // reports "no proven Arc change" rather than a permanent conflict.
  assert.equal(arcChangedSinceSync({ storedFingerprint: null, currentFingerprint: stamped }), false)
  assert.equal(arcChangedSinceSync({ storedFingerprint: stamped, currentFingerprint: null }), false)

  // Every compared field is covered, for each fingerprinted entity type.
  const bill = { total_cents: 500_00, bill_date: "2026-01-05", due_date: "2026-02-05", qbo_vendor_id: "42", qbo_expense_account_id: "7" }
  for (const [field, next] of [
    ["total_cents", 600_00],
    ["bill_date", "2026-01-06"],
    ["due_date", "2026-02-06"],
    ["qbo_vendor_id", "43"],
    ["qbo_expense_account_id", "8"],
  ]) {
    assert.notEqual(
      computeLocalFingerprint("bill", bill),
      computeLocalFingerprint("bill", { ...bill, [field]: next }),
      `${field} is compared by the conflict check but not covered by the fingerprint`,
    )
  }
  const expense = { amount_cents: 100_00, tax_cents: 0, expense_date: "2026-03-01", qbo_vendor_id: "9", qbo_expense_account_id: "3" }
  assert.notEqual(
    computeLocalFingerprint("project_expense", expense),
    computeLocalFingerprint("project_expense", { ...expense, amount_cents: 101_00 }),
  )

  assert.equal(storedLocalFingerprint({ [LOCAL_FINGERPRINT_KEY]: stamped }), stamped)
  assert.equal(storedLocalFingerprint({}), null)
  assert.equal(storedLocalFingerprint(null), null)

  // And the two-clock comparison is gone from the reconciler entirely.
  const reconcile = fs.readFileSync(path.join(__dirname, "../lib/integrations/accounting/qbo/reconcile.ts"), "utf8")
  assert.doesNotMatch(reconcile, /localUpdatedAt > localSyncedAt/)
  assert.doesNotMatch(reconcile, /qbo_synced_at.*getTime\(\)/)
  assert.equal((reconcile.match(/arcChangedSinceSync\(/g) ?? []).length, 3, "all three conflict checks must use the shared predicate")
})

test("a failed or held sync never overwrites a recorded external id", () => {
  // These functions record STATUS. They used to `upsert` with `external_id: ""`,
  // so retry exhaustion, an enqueue failure, or the cutover freeze — which fires
  // on every enqueue while frozen, including entities already linked in
  // QuickBooks — erased the link. With the legacy column gone, a wiped link
  // means the next push takes the create branch and posts a duplicate invoice or
  // bill into a real customer's books.
  const source = codeOnly("../lib/services/accounting-sync.ts")

  assert.doesNotMatch(source, /upsert\([^)]*external_id: ""/s, "status writes must not upsert an empty external id")
  // The only empty external id left is on the insert branch, which by definition
  // has no existing row to displace.
  const emptyExternalIdWrites = source.match(/external_id: ""/g) ?? []
  assert.equal(emptyExternalIdWrites.length, 1)
  assert.match(source, /\.insert\(\{[^}]*external_id: ""/s)
  assert.match(source, /markAccountingSyncStatus/)

  // The update branch touches status/error/timestamp only.
  const updateBranch = source.match(/\.update\(\{ status: input\.status[^}]*\}\)/s)
  assert.ok(updateBranch, "the existing-row branch must be an update, not an upsert")
  assert.doesNotMatch(updateBranch[0], /external_id/)

  // Both public entry points, and the freeze path that calls one of them.
  assert.match(source, /export async function markAccountingSyncNeedsReview[\s\S]{0,400}markAccountingSyncStatus/)
  assert.match(source, /export async function markAccountingSyncError[\s\S]{0,400}markAccountingSyncStatus/)
  assert.match(source, /cutover_freeze_run_id[\s\S]{0,400}markAccountingSyncNeedsReview/)

  // The adapter's own status writers were already existence-checked; keep them so.
  assert.doesNotMatch(codeOnly("../lib/integrations/accounting/qbo/adapter.ts"), /upsert\([^)]*external_id: ""/s)
})

test("the outbound sync sets are declared once, and never re-typed on the seam", () => {
  const {
    SYNCABLE_INVOICE_STATUSES,
    SYNCABLE_VENDOR_BILL_STATUSES,
    BILLED_INVOICE_STATUSES,
    PAYABLE_VENDOR_BILL_STATUSES,
    isSyncableInvoiceStatus,
    isSyncableVendorBillStatus,
  } = require("../lib/financials/ledger-status")

  // Invoices sync once they are issued — the same set the GL posts from. They used
  // to differ by `saved`, so an autosaved composer draft became AR in a customer's
  // QuickBooks; `saved` is gone from the lifecycle entirely. Vendor bills stay
  // wider than their GL set on purpose. What is not acceptable either way is each
  // push site deciding privately.
  assert.deepEqual([...SYNCABLE_INVOICE_STATUSES], ["sent", "partial", "paid", "overdue"])
  assert.deepEqual([...SYNCABLE_VENDOR_BILL_STATUSES], ["approved", "partial", "paid"])
  assert.ok(!SYNCABLE_INVOICE_STATUSES.includes("saved"))
  assert.ok(!SYNCABLE_INVOICE_STATUSES.includes("draft"))
  assert.deepEqual([...SYNCABLE_INVOICE_STATUSES], [...BILLED_INVOICE_STATUSES])
  for (const status of PAYABLE_VENDOR_BILL_STATUSES) assert.ok(SYNCABLE_VENDOR_BILL_STATUSES.includes(status))

  assert.equal(isSyncableInvoiceStatus("SENT"), true)
  assert.equal(isSyncableInvoiceStatus("saved"), false)
  assert.equal(isSyncableInvoiceStatus("draft"), false)
  assert.equal(isSyncableInvoiceStatus(null), false)
  assert.equal(isSyncableVendorBillStatus("partial"), true)
  assert.equal(isSyncableVendorBillStatus("pending"), false)

  // The declaration must state why it differs and what the consequence is, so
  // the next reader does not "fix" the asymmetry by narrowing one list.
  const ledgerStatus = fs.readFileSync(path.join(__dirname, "../lib/financials/ledger-status.ts"), "utf8")
  assert.match(ledgerStatus, /Widening it is a migration, not an edit/)

  // No module on the accounting-sync seam re-declares either set inline.
  const seam = [
    "../lib/services/accounting-sync.ts",
    "../lib/services/financial-exports.ts",
    "../lib/integrations/accounting/qbo/adapter.ts",
    "../lib/integrations/accounting/qbo/reconcile.ts",
    "../lib/integrations/accounting/qbo/import.ts",
  ]
  for (const relative of seam) {
    const source = fs.readFileSync(path.join(__dirname, relative), "utf8")
    assert.doesNotMatch(source, /\["approved",\s*"partial",\s*"paid"\]/, `${relative} re-declares the payable/sync AP set`)
    assert.doesNotMatch(source, /"sent",\s*"partial",\s*"paid",\s*"overdue"/, `${relative} re-declares the AR set`)
    assert.doesNotMatch(source, /"saved",\s*"sent",\s*"partial"/, `${relative} re-declares the invoice sync set`)
  }

  // The two push predicates read through the import rather than a literal.
  const invoices = fs.readFileSync(path.join(__dirname, "../lib/services/invoices.ts"), "utf8")
  assert.match(invoices, /isSyncableInvoiceStatus/)
  assert.doesNotMatch(invoices, /normalized === "saved" \|\|/)
  const vendorBills = fs.readFileSync(path.join(__dirname, "../lib/services/vendor-bills.ts"), "utf8")
  assert.match(vendorBills, /shouldEnqueueForStatus = isSyncableVendorBillStatus\(finalStatus\)/)
})

test("a payment create that lost its response is adopted, not posted twice", () => {
  const {
    arcTransactionMarker,
    withArcTransactionMarker,
    findAlreadyCreatedQBOTransaction,
  } = require("../lib/integrations/accounting/qbo/sync-safety")

  // QuickBooks accepts no idempotency key, so a create whose response is lost
  // near the function cap is indistinguishable from one that never ran. The
  // marker is what lets the +15m retry recognise its own work.
  assert.equal(arcTransactionMarker("payment", "abc"), "[arc:payment:abc]")
  assert.equal(withArcTransactionMarker(null, "payment", "abc"), "[arc:payment:abc]")
  assert.equal(withArcTransactionMarker("Check 1042", "bill_payment", "xyz"), "Check 1042 [arc:bill_payment:xyz]")
  assert.equal(withArcTransactionMarker("   ", "payment", "abc"), "[arc:payment:abc]")

  return (async () => {
    const calls = []
    const client = {
      async findTransactionByPrivateNote(entity, marker, opts) {
        calls.push({ entity, marker, opts })
        return { Id: "9001", PrivateNote: `Whatever ${marker}` }
      },
    }
    const adopted = await findAlreadyCreatedQBOTransaction({
      client,
      entity: "Payment",
      entityType: "payment",
      entityId: "pay-1",
    })
    assert.equal(adopted, "9001")
    assert.equal(calls[0].entity, "Payment")
    assert.equal(calls[0].marker, "[arc:payment:pay-1]")
    assert.match(calls[0].opts.sinceDate, /^\d{4}-\d{2}-\d{2}$/)

    // Nothing there means nothing to adopt; the create proceeds.
    assert.equal(
      await findAlreadyCreatedQBOTransaction({
        client: { async findTransactionByPrivateNote() { return null } },
        entity: "BillPayment",
        entityType: "bill_payment",
        entityId: "pay-2",
      }),
      null,
    )

    // A failed lookup degrades to the old behaviour; it never invents an id.
    assert.equal(
      await findAlreadyCreatedQBOTransaction({
        client: { async findTransactionByPrivateNote() { throw new Error("timeout") } },
        entity: "Payment",
        entityType: "payment",
        entityId: "pay-3",
      }),
      null,
    )
  })()
})

test("both money-moving creates stamp the marker and look before they create", () => {
  const adapter = fs.readFileSync(path.join(__dirname, "../lib/integrations/accounting/qbo/adapter.ts"), "utf8")

  // Suppression used to be the sync record alone — which is exactly the write a
  // lost response fails to make.
  assert.match(adapter, /createPayment\(\{[\s\S]{0,400}withArcTransactionMarker\(null, "payment", paymentId\)/)
  assert.match(adapter, /createBillPayment\(\{[\s\S]{0,400}withArcTransactionMarker\(payment\.reference, "bill_payment", paymentId\)/)
  // Invoices are money-moving creates too: the push stamps the marker and a
  // retry-after-unknown-outcome adopts its own work instead of duplicating it.
  assert.match(adapter, /PrivateNote: withArcTransactionMarker\(typedInvoice\.title, "invoice", invoiceId\)/)
  // A re-posted period summary doubles a whole month, so the mirror journal
  // carries the marker and adopts as well.
  assert.match(adapter, /withArcTransactionMarker\(`\$\{input\.memo\} \[\$\{input\.reference\}\]`, "period_summary", input\.reference\)/)
  assert.equal((adapter.match(/findAlreadyCreatedQBOTransaction\(\{/g) ?? []).length, 4)
  // The lookup is only paid for on a retry: a sync record with no external id.
  assert.match(adapter, /paymentRetryAfterUnknownOutcome = existingPaymentSync != null/)
  assert.match(adapter, /billPaymentRetryAfterUnknownOutcome = existingSync != null/)
})

test("permanent QuickBooks failures become reviewable work instead of retries", () => {
  const { classifyQboPermanentFailure } = require("../lib/integrations/accounting/qbo/error-rules")

  // Patagonia has had an invoice push failing on this exact fault since June:
  // three retries, then a `failed` outbox row nobody sees, forever.
  const inactive = classifyQboPermanentFailure({
    status: 400,
    faultCode: "610",
    faultDetail: 'Object Not Found : Something you are trying to use has been made inactive. The account "Job Materials" was made inactive.',
  })
  assert.ok(inactive)
  assert.match(inactive.message, /Job Materials/)
  assert.match(inactive.message, /Retrying cannot fix it/)
  assert.match(inactive.message, /active again/)

  const missing = classifyQboPermanentFailure({ status: 400, faultCode: "610", faultDetail: "Object Not Found" })
  assert.ok(missing)
  assert.match(missing.message, /no longer exists/)

  // Transient failures keep their retries.
  assert.equal(classifyQboPermanentFailure({ status: 429, faultCode: null, faultDetail: "Throttled" }), null)
  assert.equal(classifyQboPermanentFailure({ status: 500, faultCode: null, message: "upstream" }), null)

  // The outbox stops retrying and routes to needs_review with the cure attached.
  const route = fs.readFileSync(path.join(__dirname, "../app/api/accounting/process-outbox/route.ts"), "utf8")
  assert.match(route, /const shouldRetry = !permanent && newRetry < MAX_RETRIES/)
  assert.match(route, /markAccountingPushPermanentlyFailed\(\{ orgId: job\.org_id, entityType, entityId, message: permanent\.message \}\)/)

  // A deleted QuickBooks bill payment cannot be re-synced either, so its
  // conflict says what the person is choosing between.
  const reconcile = fs.readFileSync(path.join(__dirname, "../lib/integrations/accounting/qbo/reconcile.ts"), "utf8")
  assert.match(reconcile, /Syncing cannot resolve this/)
})

test("nothing on the neutral seam pins itself to one provider", () => {
  // Sage Intacct is the next adapter, and it should be adapter-only work.
  const syncActions = fs.readFileSync(path.join(__dirname, "../app/(app)/integrations/accounting-sync-actions.ts"), "utf8")
  assert.doesNotMatch(syncActions, /row\.provider === "qbo"/)
  assert.match(syncActions, /capabilities\.supportsImport/)

  const syncState = fs.readFileSync(path.join(__dirname, "../lib/services/accounting-sync-state.ts"), "utf8")
  assert.doesNotMatch(syncState, /source_type === "qbo"/)
  assert.match(syncState, /ACCOUNTING_PROVIDER_KEYS/)

  const target = fs.readFileSync(path.join(__dirname, "../lib/services/accounting-target.ts"), "utf8")
  assert.doesNotMatch(target, /qboCustomerId:/)
  assert.doesNotMatch(target, /qboCustomerName:/)

  // Justified provider pinning stays: the Intuit-registered webhook route is a
  // QBO endpoint by definition.
  const registry = fs.readFileSync(path.join(__dirname, "../lib/integrations/accounting/registry.ts"), "utf8")
  assert.match(registry, /qbo/)
})

test("an imported multi-invoice payment is consumable by the fact spine", () => {
  const { qboImportProviderPaymentId } = require("../lib/integrations/accounting/qbo/import-rules")

  // One `payments` row per allocated invoice, keyed so a re-import adopts the
  // rows it made last time instead of duplicating the cash.
  assert.equal(qboImportProviderPaymentId({ kind: "payment", qboId: "1258", split: false, lineId: "payment" }), "qbo_payment_1258")
  assert.equal(qboImportProviderPaymentId({ kind: "payment", qboId: "1258", split: true, lineId: "201" }), "qbo_payment_1258_201")

  const source = codeOnly("../lib/integrations/accounting/qbo/import.ts")

  // The consolidated shape (one row, `invoice_id: null`, split in
  // `payment_allocations`) can never be classified by the projector's XOR, so
  // the cash never posted while the invoices went to partial/paid.
  assert.doesNotMatch(source, /invoice_id: null/, "an imported payment must always name its invoice")
  assert.doesNotMatch(source, /upsertPaymentAllocation/, "allocations would double-count against invoice_paid_cents")
  assert.match(source, /split: shouldSplit,\s*lineId: application\.qboId/)
  assert.match(source, /adoptConsolidatedQboPayment/)

  // Idempotent: only the unclassified shape is converted, and its allocations go
  // with it so `invoice_paid_cents` cannot count the same money twice.
  assert.match(source, /if \(!consolidated\?\.id \|\| consolidated\.invoice_id \|\| consolidated\.bill_id\) return/)
  assert.match(source, /from\("payment_allocations"\)\s*\.delete\(\)/)
})

test("an imported bill and its imported payments reach the ledger together", () => {
  const source = fs.readFileSync(path.join(__dirname, "../lib/integrations/accounting/qbo/import.ts"), "utf8")

  // `pending` is outside PAYABLE_VENDOR_BILL_STATUSES, so a partly-paid bill
  // landing there posted no AP credit while its BillPayment posted the debit —
  // accounts payable went negative by the amount paid. The approval gate still
  // owns every bill QuickBooks has taken no money against.
  assert.match(source, /const partiallyPaid = !fullyPaid && paidCents > 0/)
  assert.match(source, /const settledInQbo = fullyPaid \|\| partiallyPaid/)
  assert.match(source, /const status = fullyPaid \? "paid" : partiallyPaid \? "partial" : "pending"/)
  assert.match(source, /approved_at: settledInQbo \? nowIso : null/)
  assert.match(source, /if \(settledInQbo\) \{/)

  // The same asymmetry closed from the payment side: a part payment promotes a
  // bill Arc still holds outside the ledger.
  assert.match(source, /const partiallySettles = !fullyPaid && nextPaid > 0 && !isPayableVendorBillStatus\(bill\.status\)/)
  assert.match(source, /if \(fullyPaid \|\| partiallySettles\) \{/)
})

test("the job-cost subledger has one writer, and it voids rather than deletes", () => {
  // Voiding is the subledger's only removal semantics, and it lives in one
  // service. A second writer deleting rows erased the trace that cost was ever
  // posted against the project.
  for (const relative of [
    "../lib/integrations/accounting/qbo/import.ts",
    "../lib/services/vendor-bills.ts",
  ]) {
    const source = fs.readFileSync(path.join(__dirname, relative), "utf8")
    assert.doesNotMatch(
      source,
      /from\("job_cost_entries"\)[\s\S]{0,80}\.delete\(\)/,
      `${relative} deletes job_cost_entries directly`,
    )
    assert.match(source, /voidJobCostEntriesForVendorBill/, `${relative} must route through the subledger service`)
  }
})

// The tests below are source-text assertions, not behavior tests: each guards a
// branch inside a function that is neither exported nor reachable without a
// live Supabase client. They prove the shape of the code, so they cost less
// than they look — treat a failure as "go read the function", not "the bug is
// back".

test("a QuickBooks void arrives as a zeroed Update and routes through the atomic void", () => {
  const source = fs.readFileSync(path.join(__dirname, "../lib/integrations/accounting/qbo/reconcile.ts"), "utf8")

  // QBO sends no Delete for a void. Left on the normal update path the invoice
  // became a live "$0 / sent" row that AR aging kept counting.
  assert.match(source, /const looksVoided =/)
  assert.match(source, /totalCents === 0 &&\s*\n\s*balanceCents === 0 &&/)
  assert.match(source, /Number\(localInvoice\?\.total_cents \?\? 0\) > 0/)
  assert.match(source, /if \(looksVoided\) \{[\s\S]{0,200}rpc\("void_invoice_atomic"/)

  // Both removal paths — the explicit Delete and the zeroed Update — go through
  // the same RPC, so draws, billed costs, and retainage release either way.
  assert.equal(source.match(/rpc\("void_invoice_atomic"/g).length, 2)
})

test("the CDC cursor is clamped to Intuit's 30-day changedSince window", () => {
  const source = fs.readFileSync(path.join(__dirname, "../lib/integrations/accounting/qbo/reconcile.ts"), "utf8")

  // An idle month (paused org, cron outage, a reconnect carrying the old cursor
  // forward) made every poll fail forever: the cursor could never advance to
  // heal itself. Clamping forfeits changes older than the window, which the
  // reconciliation digest reports as drift.
  assert.match(source, /const CDC_MAX_LOOKBACK_DAYS = 29/)
  assert.match(source, /const cdcFloorMs = Date\.now\(\) - CDC_MAX_LOOKBACK_DAYS \* 24 \* 60 \* 60 \* 1000/)
  assert.match(source, /Math\.max\(Number\.isFinite\(rawCursorMs\) \? rawCursorMs : cdcFloorMs, cdcFloorMs\)/)
  // The overlap rewind must not push the request back through the floor again.
  assert.match(source, /new Date\(Math\.max\(cursorMs - CDC_OVERLAP_MINUTES \* 60 \* 1000, cdcFloorMs\)\)/)
  assert.match(source, /qbo_cdc_cursor_clamped/)
})

test("the reclaim sweep charges an attempt and dead-letters an event that keeps crashing", () => {
  const source = fs.readFileSync(path.join(__dirname, "../lib/integrations/accounting/qbo/reconcile.ts"), "utf8")

  // A hard crash (timeout, OOM) bypasses markEventProcessed. Without the
  // increment a poison event cycled processing→retry forever at the head of the
  // oldest-first drain, occupying a batch slot on every run.
  assert.match(source, /const MAX_EVENT_ATTEMPTS = \d+/)
  assert.match(source, /\.eq\("process_status", "processing"\)\s*\n\s*\.lt\("next_attempt_at", nowIso\)/)
  assert.match(source, /const attempts = \(strandedRow\.attempts \?\? 0\) \+ 1/)
  assert.match(source, /const exhausted = attempts >= MAX_EVENT_ATTEMPTS/)
  assert.match(source, /process_status: exhausted \? "error" : "retry"/)
  // The reclaiming update is itself conditional on the row still being claimed,
  // so two overlapping sweeps cannot charge the same crash twice.
  assert.match(source, /\.eq\("id", strandedRow\.id\)\s*\n\s*\.eq\("process_status", "processing"\)/)

  // And the drain only picks up retryable events that are still inside budget.
  assert.match(source, /attempts\.lt\.\$\{MAX_EVENT_ATTEMPTS\}/)
})

test("resolving webhook events after an import is scoped to the entity that was imported", () => {
  const source = fs.readFileSync(path.join(__dirname, "../lib/integrations/accounting/qbo/import.ts"), "utf8")

  // QBO ids are unique per entity type, not globally: importing Invoice 42 must
  // not mark the pending Bill 42 event reconciled.
  assert.match(source, /\.eq\("realm_id", realmId\)\s*\n\s*\.eq\("entity_qbo_id", qboId\)\s*\n\s*\.in\("entity_name", entityNames\)/)
  assert.match(source, /markEventsResolved\(supabase, qboId, ctx\.externalAccountId, \["Invoice"\]\)/)
  assert.match(source, /markEventsResolved\(supabase, qboId, ctx\.externalAccountId, \["Purchase", "Bill"\]\)/)
  // Only unfinished events get swept; a reconciled one is never rewritten.
  assert.match(source, /\.in\("process_status", \["ignored", "pending", "error"\]\)/)
})

test("a deferred accounting push is re-scheduled past the create lease, never completed", () => {
  const source = fs.readFileSync(path.join(__dirname, "../app/api/accounting/process-outbox/route.ts"), "utf8")

  // Another attempt holds the 15-minute create claim. Marking the job completed
  // would lose the push forever.
  assert.match(source, /if \(result\.deferred\) \{/)
  assert.match(source, /const deferRetry = \(job\.retry_count \?\? 0\) \+ 1/)
  assert.match(source, /const giveUp = deferRetry >= MAX_RETRIES/)
  assert.match(source, /status: giveUp \? "failed" : "pending"/)
  // Re-run after the lease has had time to free, not immediately.
  assert.match(source, /run_at: new Date\(Date\.now\(\) \+ 20 \* 60 \* 1000\)\.toISOString\(\)/)
  // The deferred branch must return before the completion write below it.
  assert.match(source, /continue\s*\n\s*\}\s*\n\s*await supabase\.from\("outbox"\)\.update\(\{ status: "completed" \}\)/)
  // A claim that never frees still exhausts the retry budget and surfaces.
  assert.match(source, /markAccountingPushExhausted\(\{/)
})
