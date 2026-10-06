const assert = require("node:assert/strict")
const test = require("node:test")
const fs = require("node:fs")
const vm = require("node:vm")
const ts = require("typescript")
const packageId = "00000000-0000-4000-8000-000000000001"

function service({ denied = false, packageDenied = false, awardTarget = "price_agreement", total = 30 } = {}) {
  const calls = []
  const dependencies = {
    zod: require("zod"),
    "@/lib/services/context": { requireOrgContext: async () => ({ orgId: "org", userId: "user" }) },
    "@/lib/services/permissions": { requirePermission: async (permission) => { calls.push({ permission }); if (denied) throw new Error("Forbidden") } },
    "@/lib/services/bids": { getBidPackage: async (id, org) => { calls.push({ package: id, org }); if (packageDenied) throw new Error("Outside division"); return { award_target: awardTarget } } },
    "@/lib/services/directory": { listDirectoryPage: async (input) => { calls.push({ directory: input }); return { entries: [{ id: "vendor", name: "Vendor", trade: "Electrical", email: "private@example.com", internal_notes: "private" }], page: input.page, pageSize: input.pageSize, total } } },
  }
  const compiled = { exports: {} }
  const code = ts.transpileModule(fs.readFileSync(require.resolve("../lib/services/production-bid-vendors.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(code, { module: compiled, exports: compiled.exports, require(id) { assert.ok(dependencies[id], id); return dependencies[id] } })
  return { search: compiled.exports.searchProductionBidVendors, calls }
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
