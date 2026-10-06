const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
const React = require("react")
const adminPath = "admin/customers/[orgId]/onboarding/import/[importer]"
function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function load(path, modules = {}) {
  const exports = {}, leaf = new Proxy({}, { get: () => () => null })
  const code = ts.transpileModule(fs.readFileSync(`app/(app)/${path}/page.tsx`, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  new Function("exports", "require", code)(exports, name => ["react", "react/jsx-runtime"].includes(name) ? require(name) : modules[name] ?? leaf)
  return exports.default
}
for (const [path, title] of [[adminPath, "Data import"], ["settings/imports/[importer]", "Data import"], ["admin/customers/[orgId]/onboarding", "Production onboarding"]]) {
  test(`${path} renders a neutral title before route, auth or organization reads`, async () => {
    const live = deferred(), calls = []
    const page = load(path, { "next/server": { connection: () => { calls.push("live"); return live.promise } } })
    const shell = page({ params: new Promise(() => {}), searchParams: new Promise(() => {}) })
    assert.equal(shell.type, React.Suspense)
    assert.equal(shell.props.fallback.props.title, title)
    assert.deepEqual(calls, [])
    shell.props.children.type(shell.props.children.props)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(calls, ["live"])
  })
}
function fixture({ importer = "houses", batch = "batch" } = {}) {
  const live = deferred(), onboarding = deferred(), history = deferred(), detail = deferred(), calls = []
  const page = load(adminPath, {
    "next/server": { connection: () => live.promise },
    "next/navigation": { notFound: () => { throw new Error("404") } },
    "@/lib/services/import-definitions": { IMPORTER_KEYS: ["houses"], IMPORTER_DEFINITIONS: { houses: { label: "Homes", columns: [], fileKinds: [] } } },
    "@/lib/services/onboarding": { getOnboardingRun: id => { calls.push(["onboarding", id]); return onboarding.promise } },
    "@/lib/services/imports": {
      listImportBatches: (...args) => { calls.push(["history", ...args]); return history.promise },
      getImportBatch: (...args) => { calls.push(["detail", ...args]); return detail.promise },
    },
  })
  const content = page({ params: Promise.resolve({ orgId: "org", importer }), searchParams: Promise.resolve({ batch }) }).props.children
  return { live, onboarding, history, detail, calls, result: content.type(content.props) }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
test("admin selected batch starts after onboarding validation while scoped history is still pending", async () => {
  const f = fixture()
  await tick(); assert.deepEqual(f.calls, [])
  f.live.resolve(); await tick()
  assert.deepEqual(f.calls, [["onboarding", "org"], ["history", { importer: "houses", limit: 25 }, { platformOrgId: "org" }]])
  f.onboarding.resolve({ org: { name: "Builder" }, run: { id: "run" } }); await tick()
  assert.deepEqual(f.calls.at(-1), ["detail", "batch", { limit: 500 }, { platformOrgId: "org" }])
  f.detail.resolve({ id: "batch" }); f.history.resolve({ batches: [{ id: "batch" }] })
  const workspace = (await f.result).props.children
  assert.equal(workspace.props.orgId, "org")
  assert.equal(workspace.props.onboardingRunId, "run")
  assert.equal(workspace.props.detail.id, "batch")
})
test("missing onboarding run does not start the selected-batch read", async () => {
  const f = fixture(), rejected = assert.rejects(f.result, /404/)
  f.live.resolve(); f.onboarding.resolve({ run: null }); f.history.resolve({ batches: [] })
  await rejected
  assert.ok(!f.calls.some(call => call[0] === "detail"))
})
test("invalid importer starts no onboarding or batch reads", async () => {
  const f = fixture({ importer: "invalid" }), rejected = assert.rejects(f.result, /404/)
  f.live.resolve(); await rejected
  assert.deepEqual(f.calls, [])
})
test("no selected batch skips detail and preserves scoped history", async () => {
  const f = fixture({ batch: null })
  f.live.resolve(); f.onboarding.resolve({ org: { name: "Builder" }, run: { id: "run" } }); f.history.resolve({ batches: [] })
  await tick()
  assert.ok(!f.calls.some(call => call[0] === "detail"))
  const workspace = (await f.result).props.children
  assert.equal(workspace.props.detail, null)
  assert.deepEqual(workspace.props.batches, [])
})
for (const read of ["onboarding", "history", "detail"]) {
  test(`admin importer preserves ${read} failures`, async () => {
    const f = fixture(), failure = new Error(`${read} unavailable`), rejected = assert.rejects(f.result, error => error === failure)
    f.live.resolve()
    if (read === "onboarding") f.onboarding.reject(failure)
    else f.onboarding.resolve({ org: { name: "Builder" }, run: { id: "run" } })
    if (read === "history") f.history.reject(failure)
    else f.history.resolve({ batches: [] })
    if (read === "detail") f.detail.reject(failure)
    else f.detail.resolve(null)
    await rejected
  })
}
