"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

const { stubModule, freshRequire } = require("./support/modules")

const packageId = "00000000-0000-4000-8000-000000000001"

const state = { calls: [], denied: false, packageDenied: false, awardTarget: "price_agreement", total: 30 }
stubModule("@/lib/services/context", { requireOrgContext: async () => ({ orgId: "org", userId: "user" }) })
stubModule("@/lib/services/permissions", {
  requirePermission: async (permission) => {
    state.calls.push({ permission })
    if (state.denied) throw new Error("Forbidden")
  },
})
stubModule("@/lib/services/bids", {
  getBidPackage: async (id, org) => {
    state.calls.push({ package: id, org })
    if (state.packageDenied) throw new Error("Outside division")
    return { award_target: state.awardTarget }
  },
})
stubModule("@/lib/services/directory", {
  listDirectoryPage: async (input) => {
    state.calls.push({ directory: input })
    return {
      entries: [{ id: "vendor", name: "Vendor", trade: "Electrical", email: "private@example.com", internal_notes: "private" }],
      page: input.page,
      pageSize: input.pageSize,
      total: state.total,
    }
  },
})
const { searchProductionBidVendors } = freshRequire("lib/services/production-bid-vendors.ts")

function service({ denied = false, packageDenied = false, awardTarget = "price_agreement", total = 30 } = {}) {
  Object.assign(state, { calls: [], denied, packageDenied, awardTarget, total })
  return { search: searchProductionBidVendors, calls: state.calls }
}

test("production vendor search checks permission and package scope before directory reads", async () => {
  for (const opts of [{ denied: true }, { packageDenied: true }, { awardTarget: "commitment" }]) {
    const instance = service(opts)
    await assert.rejects(instance.search({ packageId }))
    assert.equal(instance.calls.some((call) => call.directory), false)
  }
})

test("vendor search pages through the directory with minimal serialized data", async () => {
  const instance = service()
  const first = await instance.search({ packageId, search: " Electrical ", page: 1 })
  assert.equal(first.more, true)
  assert.deepEqual(Object.keys(first.items[0]).sort(), ["detail", "id", "name"])
  const query = instance.calls.find((call) => call.directory).directory
  assert.equal(query.search, "Electrical")
  assert.equal(query.pageSize, 25)
  assert.equal(query.kind, "company")
  assert.equal(query.sort, "name")
  assert.equal(instance.calls[1].org, "org")
  assert.equal((await instance.search({ packageId, page: 2 })).more, false)
})

test("vendor search rejects malformed and unbounded requests before database work", async () => {
  for (const input of [{ packageId: "bad" }, { packageId, page: 0 }, { packageId, search: "a".repeat(201) }]) {
    const instance = service()
    await assert.rejects(instance.search(input))
    assert.equal(instance.calls.length, 0)
  }
})
