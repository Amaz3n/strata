require("../scripts/register-ts-node-test")
const assert = require("node:assert/strict")
const test = require("node:test")
const fs = require("node:fs")
const vm = require("node:vm")
const ts = require("typescript")
function service({ denied = false, packageDenied = false, rows = [], failPage = false, failAddenda = false } = {}) {
  const calls = []
  const db = { from(table) {
    let from = 0, to = rows.length
    const filters = []
    const query = { select(value) { filters.push(["select",value]); return query }, eq(key,value) { filters.push([key,value]); return query }, in() { return query }, not() { return query }, order() { return query }, limit() { return query }, range(a,b) { from=a; to=b; return query }, then(resolve,reject) {
      calls.push({ table, from, to, filters })
      return Promise.resolve({ data: table === "bid_submissions" ? rows.slice(from,to+1) : [{ issued_at: "2026-01-02T00:00:00Z" }], error: (table === "bid_addenda" && failAddenda) || (table === "bid_submissions" && failPage && from > 0) ? { message: "offline" } : null }).then(resolve,reject)
    } }; return query
  } }
  const compiled = { exports: {} }
  const code = ts.transpileModule(fs.readFileSync(require.resolve("../lib/services/bid-intelligence.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(code, { exports: compiled.exports, require(name) {
    if (name === "@/lib/services/authorization") return {}
    if (name === "zod") return require("zod")
    if (name === "@/lib/services/bid-intelligence-visibility") return {}
    if (name === "@/lib/services/context") return { requireOrgContext: async () => ({ supabase: db, orgId: "org", userId: "user" }) }
    if (name === "@/lib/services/permissions") return { requirePermission: async (permission) => { assert.equal(permission,"bid.read"); if (denied) throw new Error("Forbidden") } }
    if (name === "@/lib/services/bids") return { getBidPackage: async (id,org) => { assert.equal(org,"org"); if (packageDenied) throw new Error("Outside division") } }
    if (name === "@/lib/land/paging") return require("../lib/land/paging")
    throw new Error(name)
  } })
  return { get: () => compiled.exports.getPackageIntelligence("package"), calls }
}
const row = (id,total) => ({ id: String(id), total_cents: total, submitted_at: "2026-01-01T00:00:00Z" })
test("package intelligence authorizes before reading comparison data", async () => {
  for (const options of [{ denied: true }, { packageDenied: true }]) {
    const instance = service(options)
    await assert.rejects(instance.get())
    assert.equal(instance.calls.length,0)
  }
})
test("comparison includes all pages and uses the average of the two middle bids", async () => {
  const rows = Array.from({ length: 1000 }, (_,i) => row(i,i < 500 ? 100 : 300))
  const instance = service({ rows })
  const result = await instance.get()
  assert.equal(result.sample_size,1000)
  assert.equal(result.median_cents,200)
  assert.equal(result.signals[999].deviation_from_median_pct,50)
  assert.equal(result.signals[0].is_low_outlier,true)
  assert.equal(result.signals[0].is_stale_vs_addenda,true)
  assert.equal(instance.calls.filter((call) => call.table === "bid_submissions").length,3)
  for (const call of instance.calls) {
    assert.ok(call.filters.some(([key,value]) => key === "org_id" && value === "org"))
    if (call.table === "bid_submissions") assert.ok(call.filters.some(([key,value]) => key === "invite.bid_package_id" && value === "package"))
  }
})
test("comparison fails closed on partial reads, addenda failure and invalid cents", async () => {
  await assert.rejects(service({ rows: Array.from({length:501},(_,i) => row(i,100)), failPage:true }).get(),/offline/)
  await assert.rejects(service({ failAddenda:true }).get(),/offline/)
  for (const amount of [-1, 1.5, Number.MAX_SAFE_INTEGER+1]) await assert.rejects(service({ rows:[row(1,amount)] }).get(),/invalid/)
  assert.equal((await service().get()).median_cents,null)
})
