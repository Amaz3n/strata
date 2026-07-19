require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { createOrUpdateQBOEntity, resolveQBOSyncTarget } = require("../lib/integrations/accounting/qbo/sync-safety")

test("QBO adapter backfills a missing SyncToken before update", async () => {
  let reads = 0
  const client = { getInvoiceById: async (id) => { reads += 1; return { Id: id, SyncToken: "7" } } }
  const target = await resolveQBOSyncTarget({ client, entityType: "invoice", qboId: "invoice-1" })
  assert.deepEqual(target, { mode: "update", id: "invoice-1", syncToken: "7" })
  assert.equal(reads, 1)
})

test("QBO adapter refuses deleted records unless explicit recreation is allowed", async () => {
  const client = { getInvoiceById: async () => null }
  await assert.rejects(() => resolveQBOSyncTarget({ client, entityType: "invoice", qboId: "deleted" }), /deleted in QuickBooks/i)
  assert.deepEqual(await resolveQBOSyncTarget({ client, entityType: "invoice", qboId: "deleted", allowRecreateDeleted: true }), { mode: "create" })
})

test("QBO adapter retries stale SyncToken fault 5010 exactly once", async () => {
  let updates = 0
  let reads = 0
  const client = { getInvoiceById: async () => { reads += 1; return { Id: "invoice-1", SyncToken: "2" } } }
  const result = await createOrUpdateQBOEntity({
    client,
    entityType: "invoice",
    qboId: "invoice-1",
    cachedSyncToken: "1",
    payload: { DocNumber: "100" },
    create: async () => { throw new Error("create should not run") },
    update: async (payload) => {
      updates += 1
      if (updates === 1) throw { faultCode: "5010", qboError: { Fault: { type: "ValidationFault", Error: [{ code: "5010", Message: "Stale Object Error" }] } } }
      return payload
    },
  })
  assert.equal(updates, 2)
  assert.equal(reads, 1)
  assert.equal(result.SyncToken, "2")
})

test("QBO customer lookups retain the SELECT-star complex-column safeguard", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "../lib/integrations/accounting/qbo/client.ts"), "utf8")
  const customerLookup = source.slice(source.indexOf("async findCustomerByName"), source.indexOf("async createCustomer", source.indexOf("async findCustomerByName")))
  assert.match(customerLookup, /SELECT \* FROM Customer/)
  assert.doesNotMatch(customerLookup, /BillAddr|PrimaryEmailAddr/)
})
