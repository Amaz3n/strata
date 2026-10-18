const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")

function loadModule(file) {
  const exports = {}
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  new Function("exports", "require", code)(exports, name => {
    assert.equal(name, "next/navigation")
    return { redirect: destination => { throw Object.assign(Error("Redirect"), { destination }) } }
  })
  return exports
}
const load = file => loadModule(file).default
const id = "00000000-0000-4000-8000-000000000001"
const company = load("app/(app)/companies/[id]/page.tsx")
const financials = load("app/(app)/projects/[id]/financials/page.tsx")
async function destination(page, tab) {
  let result
  await assert.rejects(page({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ tab }) }), error => {
    result = error.destination
    return typeof result === "string"
  })
  return result
}

test("company tab aliases preserve all supported destinations", async () => {
  for (const tab of ["compliance", "prequalification", "transactions", "commitments", "contacts"]) {
    assert.equal(await destination(company, tab), `/directory/${id}/${tab}`)
  }
})
test("unknown and repeated company tabs land on the account overview", async () => {
  for (const tab of [undefined, "", "unknown", "constructor", "__proto__", "toString", ["compliance", "contacts"]]) {
    assert.equal(await destination(company, tab), `/directory/${id}`)
  }
})
test("financial aliases resolve directly to their current workspaces", async () => {
  const routes = { budget: "financials/budget", receivables: "financials/billing", billing: "financials/billing", payables: "financials/payables", "cost-plus": "financials/cost-inbox", inbox: "financials/cost-inbox", review: "financials/cost-inbox", "trust-center": "reports/reconciliation" }
  for (const [tab, route] of Object.entries(routes)) assert.equal(await destination(financials, tab), `/projects/${id}/${route}`)
})
test("unknown and repeated financial tabs land on billing", async () => {
  for (const tab of [undefined, "", "unknown", "constructor", "__proto__", "toString", ["budget", "payables"]]) {
    assert.equal(await destination(financials, tab), `/projects/${id}/financials/billing`)
  }
})

test("Books compatibility pages retain their final destinations and redirect contracts", () => {
  const destinations = { accountant:"/books/exports",chart:"/settings/accounting/chart-of-accounts",cutover:"/settings/accounting/setup","opening-balances":"/settings/accounting/opening-balances",statements:"/reports?collection=statements" }
  for (const [alias,destination] of Object.entries(destinations)) {
    const page = loadModule(`app/(app)/books/${alias}/page.tsx`)
    assert.equal(page.instant,false)
    assert.throws(() => page.default(), error => error.destination === destination)
  }
})
