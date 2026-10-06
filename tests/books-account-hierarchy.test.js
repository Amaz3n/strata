require("../scripts/register-ts-node-test")
const assert = require("node:assert/strict")
const test = require("node:test")
const { accountHierarchy, assertAccountParent } = require("../lib/services/books/account-hierarchy")

const account = (id, code, name, parent_id = null) => ({ id, code, name, parent_id })

test("subaccounts stay with their parent regardless of their account code", () => {
  const rows = accountHierarchy([
    account("travel", "6200", "Travel"),
    account("air", "100", "Airfare", "travel"),
    account("intl", "101", "International", "air"),
    account("rent", "6000", "Rent"),
  ])
  assert.deepEqual(rows.map(({ account, depth, path }) => [account.id, depth, path]), [
    ["rent", 0, "Rent"], ["travel", 0, "Travel"],
    ["air", 1, "Travel / Airfare"], ["intl", 2, "Travel / Airfare / International"],
  ])
  // Search can retain the full context even when the parent is filtered out.
  assert.equal(rows.filter(({ account }) => account.name === "Airfare")[0].path, "Travel / Airfare")
})

test("legacy missing parents and cycles never hide or duplicate accounts", () => {
  const rows = accountHierarchy([
    account("a", "1", "A", "b"), account("b", "2", "B", "a"),
    account("orphan", "3", "Orphan", "missing"), account("self", "4", "Self", "self"),
  ])
  assert.equal(rows.length, 4)
  assert.equal(new Set(rows.map(({ account }) => account.id)).size, 4)
})

test("subaccount parent validation rejects cross-organization, inactive, missing, and mismatched parents", () => {
  const parent = { org_id: "org-a", account_type: "expense", active: true }
  assert.doesNotThrow(() => assertAccountParent(parent, "org-a", "expense"))
  assert.throws(() => assertAccountParent(parent, "org-b", "expense"), /organization/)
  assert.throws(() => assertAccountParent(null, "org-a", "expense"), /not found/)
  assert.throws(() => assertAccountParent({ ...parent, active: false }, "org-a", "expense"), /active/)
  assert.throws(() => assertAccountParent(parent, "org-a", "income"), /same account type/)
})
