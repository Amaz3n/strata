require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const vm = require("node:vm")
const ts = require("typescript")

// Execute the real loader against a recording database boundary. Enrichment is
// deliberately unavailable: bulk selection must never need it.
function harness({ summaryError = false } = {}) {
  const queries = []
  let exclusionReads = 0
  const supabase = { from(table) {
    const calls = []
    const query = new Proxy({}, { get(_, method) {
      if (method === "then") return (resolve, reject) => {
        const select = calls.find(([name]) => name === "select")?.[1]
        const result = table === "companies" ? { data: [{ id: "vendor-match" }] }
          : table === "projects" ? { data: [{ id: "project-match" }] }
          : table === "orgs" ? { data: null }
          : { data: select?.startsWith("id,company") ? [{ id: "bill-1" }] : [], count: 1,
              error: summaryError && select?.startsWith("id, status") ? { message: "offline" } : null }
        return Promise.resolve(result).then(resolve, reject)
      }
      return (...args) => { calls.push([method, ...args]); return query }
    } })
    queries.push({ table, calls })
    return query
  } }
  const deps = {
    "@/lib/financials/payables-book": require("../lib/financials/payables-book"),
    "@/lib/services/context": { requireOrgContext: async () => ({ supabase, orgId: "org-1", userId: "user-1" }) },
    "@/lib/services/permissions": { requireAnyPermission: async () => {} },
    "@/lib/services/reporting-scope": {
      getReportingExcludedProjectIds: async () => { exclusionReads++; return ["excluded"] },
      applyReportingExclusion: (q, ids) => ids.length ? q.not("project_id", "in", `(${ids.join(",")})`) : q,
      applyProjectIdScope: (q, ids) => ids === null ? q : q.in("project_id", ids),
    },
    "@/lib/services/payable-run-items": { listActivePayableRunItems: async () => [{ bill_id: "claimed", run_id: "run-1" }] },
    "@/lib/financials/payables-queues": { ACTIVE_PAYABLE_RUN_ITEM_STATUSES: [], PAYABLE_QUEUES: [], parsePayableQueue: (value) => value ?? "approval" },
    "@/lib/services/vendor-bills": { vendorBillSelect: "full-bill", hydrateVendorBills: () => { throw new Error("Unexpected enrichment") } },
  }
  const testModule = { exports: {} }
  const code = ts.transpileModule(fs.readFileSync("lib/services/org-payables.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
  vm.runInNewContext(code, { module: testModule, exports: testModule.exports, require: (name) => deps[name] ?? {}, Date, Set, Map })
  return { load: testModule.exports.loadOrgPayablesDesk, queries, exclusionReads: () => exclusionReads }
}

test("project bulk selection uses vendor search, due filter, scope and a single capped IDs query", async () => {
  const h = harness()
  const result = await h.load(["project-1"], { projectScope: true, selectionOnly: true, tab: "ready", search: "Acme", due: "overdue" })
  assert.equal(result.selectionIds.join(), "bill-1")
  assert.equal(h.exclusionReads(), 0)
  const bills = h.queries.filter((q) => q.table === "vendor_bills")
  assert.equal(bills.length, 1)
  const calls = JSON.stringify(bills[0].calls)
  for (const expected of ['"org_id","org-1"', '"project_id",["project-1"]', 'company_id.in.(vendor-match)', '"lt","due_date"', '"range",0,499', '(claimed)']) assert.ok(calls.includes(expected), expected)
})

test("portfolio selection preserves reporting exclusions and in-flight membership", async () => {
  const h = harness()
  await h.load(["community-project"], { selectionOnly: true, tab: "inflight" })
  assert.equal(h.exclusionReads(), 1)
  const calls = JSON.stringify(h.queries)
  assert.ok(calls.includes('(excluded)'))
  assert.ok(calls.includes('"in","id",["claimed"]'))
})

test("invalid pagination cannot create an infinite database range", async () => {
  const h = harness({ summaryError: true })
  await assert.rejects(h.load(null, { page: Infinity, pageSize: Infinity }), /Failed to load payable totals: offline/)
  assert.ok(JSON.stringify(h.queries).includes('"range",0,49'))
})


test("each active band has its own bounded server sort and pagination, with paid history deferred", async () => {
  const h = harness()
  await assert.rejects(h.load(["project-1"], { banded: true, projectScope: true, sort: "amount", direction: "desc", bandPages: { approval: 3 } }), /Unexpected enrichment/)
  const pages = h.queries.filter((q) => q.table === "vendor_bills" && q.calls.some(([name]) => name === "range"))
  assert.equal(pages.length, 5)
  assert.equal(pages.filter((q) => JSON.stringify(q.calls).includes('"range",50,74')).length, 1)
  for (const q of pages) {
    const text = JSON.stringify(q.calls)
    assert.ok(text.includes('"order","total_cents",{"ascending":false'))
    assert.ok(text.includes('"order","id",{"ascending":true'))
    assert.ok(text.includes('"project_id",["project-1"]'))
  }
})

test("banded matching selection covers open lifecycle states without pulling paid history", async () => {
  const h = harness()
  await h.load(null, { banded: true, selectionOnly: true })
  const calls = JSON.stringify(h.queries)
  assert.ok(calls.includes('"neq","status","paid"'))
  assert.ok(!calls.includes('"eq","status","pending"'))
})
