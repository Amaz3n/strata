const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
const { redirect, notFound } = require("next/navigation")
const { unstable_rethrow } = require("next/dist/client/components/unstable-rethrow")
const { DynamicServerError } = require("next/dist/client/components/hooks-server-context")

function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function fixture({ failOptional = false, failure, failingRead } = {}) {
  const calls = [], connection = deferred(), context = deferred(), projects = deferred(), invoices = deferred()
  const modules = {
    "next/server": { connection: () => connection.promise },
    "next/navigation": { unstable_rethrow },
    "@/lib/services/context": { requireOrgContext: () => { calls.push("context"); return context.promise } },
    "@/lib/services/projects": { listBillingDeskProjects: (...args) => { calls.push(["projects", args[0]]); return projects.promise } },
    "@/lib/services/invoices": { listInvoicePage: options => { calls.push(["invoices", options.orgId]); return invoices.promise } },
    "@/lib/services/billing-book": {
      getOrgBillingSummary: async id => { calls.push(["summary", id]); if (failOptional) throw new Error("Summary unavailable"); return { outstandingCents: 100 } },
      getReceivablesAccountingMode: async () => { calls.push("accounting"); return { ledger: "books" } },
    },
    "@/lib/services/org-billing-desk": { loadOrgBillingDeskData: async ids => { calls.push(["opportunities", ids]); if (failOptional) throw new Error("Opportunities unavailable"); return { readyToBill: [] } } },
    "@/lib/services/financial-accounting": { getFinancialAccountingModesForProjects: async (id, ids) => { calls.push(["projectAccounting", id, ids]); if (failOptional) throw new Error("Accounting unavailable"); return { project: { ledger: "books" } } } },
    "@/lib/services/owner-billing-packages": { listOrgOwnerBillingPackageSummaries: async id => { calls.push(["packages", id]); return [] } },
    "@/lib/services/books/ui-access": { getBooksUiAccess: async () => { calls.push("access"); return { adjust: false } } },
    "@/lib/receivables/policy": { getOrgReceivablesPolicy: () => ({ workspaceLabel: "Client receivables" }), getReceivablesPosturePolicy: () => ({}) },
  }
  const optionalReads = {
    summary: ["@/lib/services/billing-book", "getOrgBillingSummary"],
    accounting: ["@/lib/services/billing-book", "getReceivablesAccountingMode"],
    opportunities: ["@/lib/services/org-billing-desk", "loadOrgBillingDeskData"],
    projectAccounting: ["@/lib/services/financial-accounting", "getFinancialAccountingModesForProjects"],
    packages: ["@/lib/services/owner-billing-packages", "listOrgOwnerBillingPackageSummaries"],
  }
  if (optionalReads[failingRead]) {
    const [moduleName, exportName] = optionalReads[failingRead]
    modules[moduleName][exportName] = async () => { throw failure }
  }
  const query = {}
  for (const method of ["select", "eq"]) query[method] = () => query
  query.maybeSingle = async () => { calls.push("org"); return { data: { name: "Builder" } } }
  const orgContext = { orgId: "org", productTier: "residential", supabase: { from: () => query } }
  const exports = {}, leaf = new Proxy({}, { get: () => () => ({}) })
  const source = fs.readFileSync("components/invoices/org-billing-workspace.tsx", "utf8")
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  new Function("exports", "require", code)(exports, name => name === "react/jsx-runtime" ? require(name) : modules[name] ?? leaf)
  return { calls, connection, context, projects, invoices, orgContext, result: exports.OrgBillingWorkspace() }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test("billing defers all organization and financial reads until a live connection", async () => {
  const f = fixture()
  await tick()
  assert.deepEqual(f.calls, [])
  f.connection.resolve()
  await tick()
  assert.deepEqual(f.calls, ["context"])
  f.context.resolve(f.orgContext)
  f.projects.resolve([])
  f.invoices.resolve({ invoices: [], totalCount: 0 })
  await f.result
})

test("billing starts independent reads before projects, and project-dependent reads before invoices finish", async () => {
  const f = fixture()
  f.connection.resolve(); f.context.resolve(f.orgContext)
  await tick()
  for (const name of ["projects", "invoices", "summary", "packages", "accounting", "access", "org"]) {
    assert.ok(f.calls.some(call => (Array.isArray(call) ? call[0] : call) === name), name)
  }
  assert.ok(!f.calls.some(call => Array.isArray(call) && call[0] === "opportunities"))
  f.projects.resolve([{ id: "project", property_type: "single_family" }])
  await tick()
  assert.ok(f.calls.some(call => JSON.stringify(call) === JSON.stringify(["opportunities", ["project"]])))
  assert.ok(f.calls.some(call => JSON.stringify(call) === JSON.stringify(["projectAccounting", "org", ["project"]])))
  f.invoices.resolve({ invoices: [{ id: "invoice" }], totalCount: 1 })
  const page = await f.result, book = page.props.children
  assert.equal(page.props.title, "Client receivables")
  assert.deepEqual(book.props.initialRows, [{ id: "invoice" }])
  assert.deepEqual(book.props.accountingByProject, { project: { ledger: "books" } })
  assert.equal(book.props.canManageDeposits, false)
})

test("billing retains explicit optional-read errors and accounting fallback", async () => {
  const f = fixture({ failOptional: true })
  f.connection.resolve(); f.context.resolve(f.orgContext)
  f.projects.resolve([{ id: "project" }]); f.invoices.reject(new Error("Invoices unavailable"))
  const book = (await f.result).props.children
  assert.deepEqual(book.props.loadErrors, ["Invoices: Invoices unavailable", "Receivables totals: Summary unavailable", "Ready to bill: Opportunities unavailable"])
  assert.deepEqual(book.props.initialRows, [])
  assert.deepEqual(book.props.accountingByProject, {})
})

test("billing keeps a project-list failure rather than returning an unscoped desk", async () => {
  const f = fixture(), failure = new Error("Projects unavailable")
  const rejected = assert.rejects(f.result, error => error === failure)
  f.connection.resolve(); f.context.resolve(f.orgContext)
  f.projects.reject(failure); f.invoices.resolve({ invoices: [], totalCount: 0 })
  await rejected
  assert.ok(!f.calls.some(call => Array.isArray(call) && ["opportunities", "projectAccounting"].includes(call[0])))
})

function thrown(callback) {
  try { callback() } catch (error) { return error }
  throw new Error("Expected a framework signal")
}

for (const failingRead of ["invoices", "summary", "opportunities", "packages", "accounting", "projectAccounting"]) {
  test(`billing ${failingRead} fallback preserves Next.js control flow`, async () => {
    const redirectError = thrown(() => redirect("/auth/signin"))
    for (const failure of [redirectError, thrown(notFound), new DynamicServerError("Interrupted rendering"), new Error("Wrapped", { cause: redirectError })]) {
      const f = fixture({ failingRead, failure })
      const rejected = assert.rejects(f.result, error => error === failure || error === failure.cause)
      f.connection.resolve(); f.context.resolve(f.orgContext)
      f.projects.resolve([{ id: "project" }])
      if (failingRead === "invoices") f.invoices.reject(failure)
      else f.invoices.resolve({ invoices: [], totalCount: 0 })
      await rejected
    }
  })
}

test("billing keeps package and ledger failures recoverable", async () => {
  for (const failingRead of ["packages", "accounting"]) {
    const f = fixture({ failingRead, failure: new Error("Temporarily unavailable") })
    f.connection.resolve(); f.context.resolve(f.orgContext)
    f.projects.resolve([]); f.invoices.resolve({ invoices: [], totalCount: 0 })
    const book = (await f.result).props.children
    if (failingRead === "packages") {
      assert.deepEqual(book.props.ownerBillingPackages, [])
      assert.deepEqual(book.props.loadErrors, ["Backup packages: Temporarily unavailable"])
    } else {
      assert.deepEqual(book.props.accounting, { ledger: "unavailable", external: null })
      assert.deepEqual(book.props.loadErrors, [])
    }
  }
})
