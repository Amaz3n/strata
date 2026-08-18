const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const root = path.resolve(__dirname, "..")
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8")

test("QBO invoice sync never creates Products/Services as a side effect", () => {
  const client = read("lib/integrations/accounting/qbo/client.ts")
  const adapter = read("lib/integrations/accounting/qbo/adapter.ts")

  assert.doesNotMatch(client, /POST["'],\s*["']item["']/)
  assert.doesNotMatch(adapter, /getDefaultServiceItem/)
  assert.match(adapter, /getInvoiceItemById/)
  assert.match(adapter, /QBOInvoiceItemResolutionError/)
})

test("invoice item resolution preserves an existing item before configured fallbacks", () => {
  const adapter = read("lib/integrations/accounting/qbo/adapter.ts")
  const preservation = adapter.indexOf("metadataItem ?? savedItem ?? mappedItem ?? defaultInvoiceItem")

  assert.ok(preservation >= 0, "expected preserved item -> saved link -> mapped item -> default order")
  assert.match(adapter, /if \(!item\.active\)/)
  assert.match(adapter, /accountMatches\.length === 1/)
})

test("QBO invoice import stores item identity as item metadata and remains inbound-only", () => {
  const importer = read("lib/integrations/accounting/qbo/import.ts")

  assert.match(importer, /qbo_item_id: line\.qbo_item_id/)
  assert.match(importer, /qbo_item_name: line\.qbo_item_name/)
  assert.doesNotMatch(importer, /qbo_income_account_id: line\.qbo_item_id/)
  assert.match(importer, /pushable: false/)
  assert.match(importer, /ownership: "inbound"/)
})

test("QBO invoice sync honors the invoice-only switch and inbound ownership", () => {
  const adapter = read("lib/integrations/accounting/qbo/adapter.ts")

  assert.match(adapter, /connectionSettings\.sync_invoices === false/)
  assert.match(adapter, /imported_from_qbo === true/)
  assert.match(adapter, /accounting_push_adopted !== true/)
})

test("provider invoice-line links keep item identity separate from account coding", () => {
  const migration = read("supabase/migrations/20260817090000_accounting_invoice_item_safety.sql")

  assert.match(migration, /external_item_id text not null/)
  assert.match(migration, /external_income_account_id text/)
  assert.match(migration, /enable row level security/)
  assert.match(migration, /grant all on public\.accounting_invoice_line_links to service_role/)
})

test("invoice-item setup only accepts existing active QBO items", () => {
  const service = read("lib/services/accounting-invoice-items.ts")
  const actions = read("app/(app)/settings/integrations/invoice-item-actions.ts")

  assert.match(service, /getInvoiceItemById/)
  assert.match(service, /if \(!item\.active\)/)
  assert.doesNotMatch(service, /create.*Item/i)
  assert.match(actions, /requirePermission\("org\.admin"/)
  assert.match(actions, /updateInvoiceSyncEnabledAction/)
  assert.match(actions, /adoptImportedInvoiceForOutboundAction/)
  assert.match(actions, /pushable: true/)
})
