require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const Module = require("node:module")
const { randomUUID } = require("node:crypto")
const orgId = randomUUID(), userId = randomUUID()
let enabled = true, allowed = true
const rows = [], audits = [], reads = []
const service = {
  from(table) {
    assert.equal(table, "gl_accounts")
    const filters = []
    let inserted
    const query = {
      select() { return query },
      eq(key, value) { filters.push([key, value]); return query },
      insert(value) { inserted = { ...value, id: randomUUID() }; return query },
      async maybeSingle() {
        reads.push(filters)
        return { data: rows.find(row => filters.every(([key, value]) => row[key] === value)) ?? null, error: null }
      },
      async single() { rows.push(inserted); return { data: { id: inserted.id }, error: null } },
    }
    return query
  },
}
const stubs = {
  "@/lib/supabase/server": { createServiceSupabaseClient: () => service },
  "@/lib/services/context": { requireOrgContext: async () => ({ orgId, userId, supabase: service }) },
  "@/lib/services/books/module": { requireBooksWorkspaceEnabled: async () => { if (!enabled) throw new Error("Books disabled") } },
  "@/lib/services/books/access": { requireBooksAuthorization: async ({ permission }) => { assert.equal(permission, "books.manage"); if (!allowed) throw new Error("Forbidden") } },
  "@/lib/services/audit": { recordAudit: async (audit) => { audits.push(audit) } },
}
const originalLoad = Module._load
Module._load = function (request, ...args) { return stubs[request] ?? originalLoad.call(this, request, ...args) }
let createGlAccount
try { ({ createGlAccount } = require("../lib/services/books/chart-management")) } finally { Module._load = originalLoad }
const draft = { code: "6110", name: "Office supplies", accountType: "expense", subtype: "other_expense", normalBalance: "debit" }

test("account creation persists parent links and audits them, including nested subaccounts", async () => {
  const parentId = randomUUID()
  rows.push({ id: parentId, org_id: orgId, account_type: "expense", active: true })
  const child = await createGlAccount({ ...draft, parentId })
  assert.equal(rows.find(row => row.id === child.id).parent_id, parentId)
  assert.equal(audits.at(-1).after.parentId, parentId)
  const grandchild = await createGlAccount({ ...draft, code: "6111", parentId: child.id })
  assert.equal(rows.find(row => row.id === grandchild.id).parent_id, child.id)
  assert.ok(reads.every(filters => filters.some(([key, value]) => key === "org_id" && value === orgId)))
  const standalone = await createGlAccount({ ...draft, code: "6112" })
  assert.equal(rows.find(row => row.id === standalone.id).parent_id, null)
})

test("unauthorized or invalid parent selections cannot create accounts", async () => {
  const before = rows.length
  allowed = false
  await assert.rejects(createGlAccount(draft), /Forbidden/)
  allowed = true; enabled = false
  await assert.rejects(createGlAccount(draft), /disabled/)
  enabled = true
  for (const [overrides, message] of [
    [{ org_id: randomUUID() }, /not found/],
    [{ account_type: "asset" }, /same account type/],
    [{ active: false }, /active/],
  ]) {
    const parentId = randomUUID()
    rows.push({ id: parentId, org_id: orgId, account_type: "expense", active: true, ...overrides })
    await assert.rejects(createGlAccount({ ...draft, parentId }), message)
    rows.pop()
  }
  await assert.rejects(createGlAccount({ ...draft, parentId: randomUUID() }), /not found/)
  assert.equal(rows.length, before)
})
