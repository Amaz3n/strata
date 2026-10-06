const assert = require("node:assert/strict")
const fs = require("node:fs")
const vm = require("node:vm")
const ts = require("typescript")
const test = require("node:test")

function access(assignedOnly, divisionIds, rows) {
  const calls = []
  const compiled = { exports: {} }
  const source = fs.readFileSync(require.resolve("../lib/services/production-bid-access.ts"), "utf8")
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports: compiled.exports, require: () => ({ getDivisionAccessForUser: async () => ({ assignedOnly, divisionIds }) }),
  })
  const context = { orgId: "org", userId: "user", supabase: { from(table) {
    const query = { select() { return query }, eq(key, value) { calls.push([table, key, value]); return query }, async maybeSingle() { return { data: rows[table], error: null } } }
    return query
  } } }
  return { run: (scope) => compiled.exports.assertProductionBidAccess(scope, context), calls }
}

test("production bids reject community and plan parents outside assigned divisions", async () => {
  for (const [key, table] of [["community_id", "communities"], ["house_plan_id", "house_plans"]]) {
    const { run } = access(true, ["a"], { [table]: { id: "parent", division_id: "b" } })
    await assert.rejects(run({ [key]: "parent" }), /outside your division access/)
  }
})
test("both parents must pass, and lookups are organization scoped", async () => {
  const { run, calls } = access(true, ["a"], { communities: { id: "c", division_id: "a" }, house_plans: { id: "p", division_id: null } })
  await run({ community_id: "c", house_plan_id: "p" })
  assert.equal(calls.filter(([, key, value]) => key === "org_id" && value === "org").length, 2)
})
test("unassigned communities and missing parents fail closed", async () => {
  const { run } = access(true, [], { communities: { id: "c", division_id: null } })
  await assert.rejects(run({ community_id: "c" }), /outside your division access/)
  await assert.rejects(run({ house_plan_id: "missing" }), /not found/)
})
