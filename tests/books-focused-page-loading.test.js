const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
const React = require("react")
function load(file, dependencies = {}, exportName = "default") {
  const exports = {}, leaf = new Proxy({}, { get: () => () => null })
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  new Function("exports", "require", code)(exports, name => ["react", "react/jsx-runtime"].includes(name) ? require(name) : dependencies[name] ?? (name === "next/navigation" ? { notFound: () => { throw new Error("Not found") } } : leaf))
  return exports[exportName]
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function fixture() {
  const connection = deferred(), reads = []
  const workspace = {
    settings: { ledger_authority: "arc" }, capabilities: { adjust: true }, asOf: "2026-10-03",
    bankAccounts: [{ id: "bank-one" }, { id: "bank-two" }],
    bankTransactions: [{ bank_account_id: "bank-one" }, { bank_account_id: "bank-two" }],
    unmatchedTransactions: [{ bank_account_id: "bank-one" }], bankReconciliations: [{ bank_account_id: "bank-one" }],
    periods: [{ id: "period-one" }, { id: "period-two" }], closeItems: [{ period_id: "period-one" }], reconciliationItems: [],
  }
  const page = load("app/(app)/books/_components/books-section-page.tsx", {
    "next/server": { connection: () => connection.promise },
    "@/lib/services/books/workspace": { getBooksWorkspace: async (...args) => { reads.push(args); return workspace } },
  }, "BooksSectionPage")
  return { page, connection, reads }
}
test("focused banking routes render a title without reading URL parameters or financial data", async () => {
  const f = fixture(), route = deferred()
  const shell = f.page({ section: "banking", routeParams: route.promise })
  assert.equal(shell.type, React.Suspense)
  assert.equal(shell.props.fallback.props.title, "Banking")
  const resultPromise = shell.props.children.type(shell.props.children.props)
  assert.deepEqual(f.reads, [])
  f.connection.resolve()
  await Promise.resolve()
  assert.deepEqual(f.reads, [[undefined, "banking", { includeTransactions: false }]])
  route.resolve({ accountId: "bank-one" })
  const client = (await resultPromise).props.children[1]
  assert.equal(client.props.reconciliationAccountId, "bank-one")
  assert.deepEqual(client.props.workspace.bankAccounts, [{ id: "bank-one" }])
  assert.deepEqual(client.props.workspace.bankTransactions, [{ bank_account_id: "bank-one" }])
})
test("focused routes reject account and period IDs outside their fresh workspace", async () => {
  for (const [section, routeParams] of [["banking", { accountId: "other-org" }], ["close", { periodId: "other-org" }]]) {
    const f = fixture(), shell = f.page({ section, routeParams: Promise.resolve(routeParams) })
    const resultPromise = shell.props.children.type(shell.props.children.props)
    f.connection.resolve()
    await assert.rejects(resultPromise, /Not found/)
  }
})
test("close routes preserve period selection and existing direct focused-page props still work", async () => {
  for (const props of [{ section: "close", routeParams: Promise.resolve({ periodId: "period-one" }) }, { section: "close", periodId: "period-one" }]) {
    const f = fixture(), shell = f.page(props)
    const resultPromise = shell.props.children.type(shell.props.children.props)
    f.connection.resolve()
    const client = (await resultPromise).props.children[1]
    assert.equal(client.props.periodId, "period-one")
  }
})
test("banking, close, and overhead entries synchronously forward to the shared live-data boundary", () => {
  for (const [path, section] of [["banking/[accountId]/reconcile", "banking"], ["close/[periodId]", "close"], ["overhead", "overhead"]]) {
    const params = new Promise(() => {})
    const shell = load(`app/(app)/books/${path}/page.tsx`)({ params })
    assert.ok(React.isValidElement(shell))
    assert.equal(shell.props.section, section)
    if (section !== "overhead") assert.equal(shell.props.routeParams, params)
  }
})
test("assets and deposits return titled shells and preserve the adjustment permission gate", async () => {
  for (const [path, title] of [["app/(app)/books/assets/page.tsx", "Assets & loans"], ["app/(app)/billing/deposits/page.tsx", "Customer deposits"]]) {
    const page = load(path, { "@/lib/services/books/ui-access": { getBooksUiAccess: async () => ({ adjust: false }) } })
    const shell = page()
    assert.equal(shell.type, React.Suspense)
    assert.equal(shell.props.fallback.props.title, title)
    await assert.rejects(shell.props.children.type(), /Not found/)
  }
})
