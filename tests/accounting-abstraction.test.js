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
