"use strict"

/**
 * `QBOClient.getLastInvoiceNumber` (lib/integrations/accounting/qbo/client.ts):
 * QuickBooks' highest invoice number is not its newest one — imported and
 * backdated invoices carry high numbers — so every page is read and numbers
 * are compared numerically.
 */

const assert = require("node:assert/strict")
const test = require("node:test")

require("../scripts/register-ts-node-test")
const { QBOClient, pickHighestDocNumber } = require("@/lib/integrations/accounting/qbo/client")

/** A transport answering QBO's invoice query from `pages`, one page per request. */
function transport(pages) {
  const queries = []
  return {
    queries,
    async request(_method, path) {
      queries.push(decodeURIComponent(path))
      return { QueryResponse: { Invoice: pages[queries.length - 1] ?? [] } }
    },
  }
}

test("the highest number is found past the newest page", async () => {
  const fullPage = Array.from({ length: 1000 }, (_, n) => ({ DocNumber: `INV-${n + 1}` }))
  const client = transport([fullPage, [{ DocNumber: "INV-9000" }]])

  assert.equal(await QBOClient.prototype.getLastInvoiceNumber.call(client), "INV-9000")
  assert.equal(client.queries.length, 2)
})

test("an empty QuickBooks company starts from zero", async () => {
  assert.equal(await QBOClient.prototype.getLastInvoiceNumber.call(transport([[]])), "0")
})

test("document numbers compare by their numeric suffix, not as text", () => {
  assert.equal(pickHighestDocNumber(["INV-100", "INV-99"]), "INV-100")
  assert.equal(pickHighestDocNumber([null, undefined, "7"]), "7")
})
