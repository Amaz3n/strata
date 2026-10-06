const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function load(file, modules) {
  const exports = {}, leaf = new Proxy({}, { get: () => () => null })
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  new Function("exports", "require", code)(exports, name => ["react", "react/jsx-runtime"].includes(name) ? require(name) : (name === "next/server" ? { connection: async () => {} } : modules[name]) ?? leaf)
  return exports.default
}
const tick = () => new Promise(resolve => setImmediate(resolve))
function payrollFixture({ project = { id: "project", name: "Fixture", is_public_work: true }, report } = {}) {
  const calls = [], reports = deferred(), wages = deferred()
  const page = load("app/(app)/projects/[id]/time/certified-payroll/page.tsx", {
    "next/navigation": { notFound: () => { throw new Error("404") } },
    "@/app/(app)/projects/[id]/actions": { getProjectAction: async () => project },
    "@/lib/services/certified-payroll": {
      listWageDeterminations: async id => { calls.push(["wages", id]); return wages.promise },
      listWageClassifications: async id => { calls.push(["classifications", id]); return [] },
      listPayrollWorkerProfiles: async () => { calls.push(["workers"]); return [] },
      listCertifiedPayrollReports: async id => { calls.push(["reports", id]); return reports.promise },
      getCertifiedPayrollReport: async id => { calls.push(["detail", id]); return { id } },
    },
  })
  const shell = page({ params: Promise.resolve({ id: "project" }), searchParams: Promise.resolve({ report }) })
  return { calls, reports, wages, result: shell.props.children.type(shell.props.children.props) }
}
for (const [report, expected] of [["two", "two"], ["foreign", "one"], [undefined, "one"]]) {
  test(`certified payroll starts the scoped ${report ?? "default"} report before wage reads finish`, async () => {
    const f = payrollFixture({ report })
    await tick()
    assert.equal(f.calls.length, 4)
    f.reports.resolve([{ id: "one" }, { id: "two" }])
    await tick()
    assert.deepEqual(f.calls.at(-1), ["detail", expected])
    f.wages.resolve([])
    const tree = await f.result
    assert.equal(tree.props.children.props.initialSelected.id, expected)
    assert.equal(tree.props.children.key, `project:${expected}`)
  })
}
test("empty payroll registers do not request a report detail", async () => {
  const f = payrollFixture()
  f.reports.resolve([]); f.wages.resolve([])
  const tree = await f.result
  assert.equal(tree.props.children.props.initialSelected, null)
  assert.equal(f.calls.some(([name]) => name === "detail"), false)
})
for (const project of [null, { id: "project", is_public_work: false }]) {
  test(`payroll detail reads remain behind the ${project ? "public-work" : "project"} guard`, async () => {
    const f = payrollFixture({ project })
    if (!project) await assert.rejects(f.result, /404/)
    else await f.result
    assert.deepEqual(f.calls, [])
  })
}
test("payroll register failures retain the original error and never request a detail", async () => {
  const f = payrollFixture(), failure = new Error("Reports unavailable")
  const rejected = assert.rejects(f.result, error => error === failure)
  f.reports.reject(failure); f.wages.resolve([])
  await rejected
  assert.equal(f.calls.some(([name]) => name === "detail"), false)
})
for (const enabled of [true, false]) {
  test(`change-order registers load while the ${enabled ? "enabled" : "disabled"} cost-code setting is pending`, async () => {
    const calls = [], setting = deferred()
    const page = load("app/(app)/projects/[id]/change-orders/page.tsx", {
      "../actions": { getProjectAction: async () => ({ id: "project", name: "Fixture" }) },
      "@/app/(app)/change-orders/actions": { listChangeOrdersAction: async id => { calls.push(["orders", id]); return [] } },
      "@/lib/services/change-events": { listChangeEvents: async id => { calls.push(["events", id]); return [] } },
      "@/lib/services/orgs": { getOrgBilling: async () => { calls.push(["billing"]); return null } },
      "@/lib/services/context": { requireOrgContext: async () => ({ supabase: {}, orgId: "org" }) },
      "@/lib/financials/cost-codes-enabled": { getOrgCostCodesEnabled: () => setting.promise, resolveCostCodesEnabled: (_project, org) => org },
      "@/lib/services/cost-codes": { listCostCodes: async () => { calls.push(["codes"]); return [{ id: "code" }] } },
      "@/lib/services/budgets": { listProjectBudgetLines: async id => { calls.push(["budget", id]); return [{ id: "line" }] } },
    })
    const shell = page({ params: Promise.resolve({ id: "project" }), searchParams: Promise.resolve({}) })
    const route = await shell.props.children[1].props.children.type(shell.props.children[1].props.children.props)
    const result = route.type(route.props)
    await tick()
    assert.deepEqual(calls, [["orders", "project"], ["events", "project"], ["billing"]])
    setting.resolve(enabled)
    const tree = await result
    const client = tree.props.children[2].props.children
    assert.equal(client.props.costCodesEnabled, enabled)
    assert.deepEqual(client.props.costCodes, enabled ? [{ id: "code" }] : [])
    assert.deepEqual(client.props.budgetLines, enabled ? [] : [{ id: "line" }])
    assert.deepEqual(calls.at(-1), enabled ? ["codes"] : ["budget", "project"])
  })
}
