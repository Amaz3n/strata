require("../scripts/register-ts-node-test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const vm = require("node:vm")
const ts = require("typescript")
const test = require("node:test")
const division = "00000000-0000-4000-8000-000000000001"
const community = "00000000-0000-4000-8000-000000000002"

function harness({ scope = { assignedOnly: false, divisionIds: [] }, denied = false, errorTable = null, responses = [], rows = [] } = {}) {
  const calls = []
  const context = { orgId: "org", userId: "buyer", supabase: { from(table) {
    const call = { table, filters: [] }; calls.push(call)
    const query = {
      select(columns, options) { call.columns = columns; call.options = options; return query },
      eq(...args) { call.filters.push(["eq", ...args]); return query }, neq(...args) { call.filters.push(["neq", ...args]); return query },
      ilike(...args) { call.filters.push(["ilike", ...args]); return query },
      in(...args) { call.filters.push(["in", ...args]); return query }, or(...args) { call.filters.push(["or", ...args]); return query },
      order(...args) { call.filters.push(["order", ...args]); return query }, range(from, to) { call.range = [from, to]; return query },
      then(resolve, reject) { return Promise.resolve({ data: table === "bid_packages" ? rows : responses.slice(call.range[0], call.range[1] + 1), count: 1203, error: errorTable === table ? { message: "database unavailable" } : null }).then(resolve, reject) },
    }
    return query
  } } }
  const stubs = {
    zod: require("zod"), "@/lib/land/scope": require("../lib/land/scope"), "@/lib/land/paging": require("../lib/land/paging"),
    "@/lib/services/context": { requireOrgContext: async () => context },
    "@/lib/services/authorization": { getDivisionAccessForUser: async () => scope },
    "@/lib/services/permissions": { requirePermission: async () => { if (denied) throw new Error("Forbidden") } },
  }
  const compiled = { exports: {} }
  const source = fs.readFileSync(require.resolve("../lib/services/production-bid-queue.ts"), "utf8")
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: compiled.exports, require: (id) => { assert.ok(stubs[id], id); return stubs[id] } })
  return { calls, run: compiled.exports.listProductionBidQueue }
}
const row = { id: "package", title: "Framing", status: "open", due_at: null, community: { name: "Oak" }, plan: { name: "A" }, invites: [{ count: 25 }] }

test("queue selects only production packages before applying stable pagination", async () => {
  const { run, calls } = harness({ rows: [row] })
  const result = await run({ page: 3, pageSize: 50, communityId: community })
  assert.equal(result.count, 1203)
  assert.deepEqual(calls[0].range, [100, 149])
  assert.ok(calls[0].filters.some(([op, key, value]) => op === "eq" && key === "award_target" && value === "price_agreement"))
  assert.ok(calls[0].filters.some(([op, key, value]) => op === "eq" && key === "community_id" && value === community))
  assert.equal(result.items[0].jobName, "Oak — A")
  assert.equal(result.items[0].invites, 25)
})

test("assigned division scope filters both parents without loading org ID rosters", async () => {
  const { run, calls } = harness({ scope: { assignedOnly: true, divisionIds: [division] } })
  await run()
  assert.equal(calls.length, 1)
  assert.ok(calls[0].filters.some(([op, key, values]) => op === "in" && key === "community.division_id" && values[0] === division))
  assert.ok(calls[0].filters.some(([op, expression]) => op === "or" && expression.includes("plan.not.is.null")))
})

test("forbidden and empty division access never read bid rows", async () => {
  const forbidden = harness({ denied: true })
  await assert.rejects(forbidden.run(), /Forbidden/)
  assert.equal(forbidden.calls.length, 0)
  const empty = harness({ scope: { assignedOnly: true, divisionIds: [] } })
  assert.equal((await empty.run()).count, 0)
  assert.equal(empty.calls.length, 0)
})

test("response totals read beyond the default database cap and stay within visible packages", async () => {
  const { run, calls } = harness({ rows: [row], responses: Array.from({ length: 1203 }, () => ({ invite: { bid_package_id: "package" } })) })
  const result = await run()
  assert.equal(result.items[0].responses, 1203)
  const reads = calls.filter((call) => call.table === "bid_submissions")
  assert.equal(reads.length, 3)
  assert.ok(reads.every((call) => call.filters.some(([op, key, ids]) => op === "in" && key === "invite.bid_package_id" && ids.length === 1 && ids[0] === "package")))
})

test("database failures cannot become empty queues or zero response totals", async () => {
  for (const errorTable of ["bid_packages", "bid_submissions"]) {
    const { run } = harness({ errorTable, rows: [row] })
    await assert.rejects(run(), /database unavailable/)
  }
})


test("search and explicit status filtering happen before pagination, including cancelled history", async () => {
  const { run, calls } = harness()
  await run({ search: "Framing_50%", status: "cancelled" })
  assert.ok(calls[0].filters.some(([op, key, value]) => op === "eq" && key === "status" && value === "cancelled"))
  assert.equal(calls[0].filters.some(([op, key]) => op === "neq" && key === "status"), false)
  assert.ok(calls[0].filters.some(([op, key, value]) => op === "ilike" && key === "title" && value === "%Framing\\_50\\%%"))
})
