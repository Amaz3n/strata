const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { getBooksWorkspace } = freshRequire("lib/services/books/workspace.ts")

const TRANSACTION = id(1)

function harness() {
  return createServiceHarness({
    permissions: ["books.read"],
    tables: {
      books_settings: [{ id: id(2), org_id: ORG, workspace_enabled: true }],
      bank_transactions: [
        {
          id: TRANSACTION,
          org_id: ORG,
          lifecycle_status: "posted",
          excluded: false,
          amount_cents: 10000,
          transaction_date: "2026-10-01",
          matches: [],
        },
      ],
    },
  })
}

test("the desktop banking section leaves the transaction register unread", async () => {
  const service = harness()
  const workspace = await service.run(() => getBooksWorkspace(undefined, "banking", { includeTransactions: false }))
  assert.deepEqual(workspace.bankTransactions, [])
  assert.deepEqual(service.reads("bank_transactions"), [])
})

test("the banking section lists posted transactions and the unmatched ones by default", async () => {
  const workspace = await harness().run(() => getBooksWorkspace(undefined, "banking"))
  assert.deepEqual(workspace.bankTransactions.map((row) => row.id), [TRANSACTION])
  assert.deepEqual(workspace.unmatchedTransactions.map((row) => row.id), [TRANSACTION])
})
