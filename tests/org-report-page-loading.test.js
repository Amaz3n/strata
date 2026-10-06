const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
const React = require("react")
function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function load(file, modules = {}) {
  const exports = {}, leaf = new Proxy({}, { get: () => () => null })
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  new Function("exports", "require", code)(exports, name => ["react", "react/jsx-runtime"].includes(name) ? require(name) : modules[name] ?? leaf)
  return exports.default
}
for (const [file, title] of [["app/(app)/reports/page.tsx", "Reports"], ["app/(app)/reports/[slug]/page.tsx", "Report"]]) {
  test(`${title} renders its destination title before URL or data promises resolve`, () => {
    const shell = load(file)({ params: new Promise(() => {}), searchParams: new Promise(() => {}) })
    assert.equal(shell.type, React.Suspense)
    assert.equal(shell.props.fallback.props.title, title)
    assert.equal(shell.props.fallback.props.fullBleed, true)
  })
}
function fixture({ definition = { slug: "report", scopes: ["org"] }, search = { config: "config", run: "run" }, allowed = true } = {}) {
  const calls = [], connected = deferred(), saved = deferred(), snapshot = deferred(), scope = deferred()
  const page = load("app/(app)/reports/[slug]/page.tsx", {
    "next/server": { connection: () => connected.promise },
    "next/navigation": { notFound: () => { throw new Error("404") } },
    "@/lib/reports/registry": { getReportDefinition: () => definition },
    "@/lib/services/report-catalog": { resolveOrgReportScope: () => { calls.push("scope"); return scope.promise }, canRunReport: () => allowed },
    "@/lib/services/report-configs": { getSavedReportConfig: id => { calls.push(["saved", id]); return saved.promise } },
    "@/lib/services/report-runs": { getReportRun: id => { calls.push(["snapshot", id]); return snapshot.promise } },
    "@/lib/reports/params": { parseReportParams: (_definition, params) => params },
    "@/lib/services/report-workspace": { evaluateReport: async (_definition, context) => { calls.push("live"); return { base: { rows: [] }, context } } },
  })
  const shell = page({ params: Promise.resolve({ slug: "report" }), searchParams: Promise.resolve(search) })
  return { calls, connected, saved, snapshot, scope, result: shell.props.children.type(shell.props.children.props) }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
test("report library prefetch waits for a live connection before catalog or history reads", async () => {
  const connected = deferred(), calls = []
  const page = load("app/(app)/reports/page.tsx", {
    "next/server": { connection: () => connected.promise },
    "@/lib/services/report-catalog": { resolveOrgReportScope: async () => { calls.push("scope"); return {context:{posture:"residential"}} }, catalogFor: () => [] },
    "@/lib/services/report-runs": { listReportRuns: async () => { calls.push("runs"); return [] } },
    "@/lib/services/report-configs": { listSavedReportConfigs: async () => { calls.push("saved"); return [] } },
  })
  const shell = page(), result = shell.props.children.type(shell.props.children.props)
  await tick()
  assert.deepEqual(calls, [])
  connected.resolve()
  await result
  assert.deepEqual(calls, ["scope", "runs", "saved"])
})
const savedData = { id: "config", slug: "report", project_id: null, params: { period: "current" } }
const snapshotData = { id: "run", slug: "report", scope: "org", params: { period: "historical" }, snapshot: { rows: [{ value: 100 }] } }
async function releaseScope(f) {
  f.connected.resolve()
  await tick()
  f.scope.resolve({ context: { scope: "org" } })
  await tick()
}
test("org report saved settings and snapshots start together after the live connection and scope checks", async () => {
  const f = fixture()
  assert.deepEqual(f.calls, [])
  f.connected.resolve()
  await tick()
  assert.deepEqual(f.calls, ["scope"])
  f.scope.resolve({ context: { scope: "org" } })
  await tick()
  assert.deepEqual(f.calls, ["scope", ["saved", "config"], ["snapshot", "run"]])
  f.snapshot.resolve(snapshotData)
  f.saved.resolve(savedData)
  const view = (await f.result).props.children.props.children
  assert.deepEqual(view.props.result, snapshotData.snapshot)
  assert.deepEqual(view.props.params, snapshotData.params)
  assert.equal(view.props.saved.id, "config")
  assert.equal(f.calls.includes("live"), false)
})
for (const invalid of [{...snapshotData,slug:"other"}, {...snapshotData,scope:"project"}, null]) {
  test(`org report rejects ${invalid ? invalid.slug === "other" ? "another report" : "a project snapshot" : "a missing snapshot"} before evaluation`, async () => {
    const f = fixture()
    const rejected = assert.rejects(f.result, /404/)
    await releaseScope(f)
    f.saved.resolve(savedData); f.snapshot.resolve(invalid)
    await rejected
    assert.equal(f.calls.includes("live"), false)
  })
}
test("org report rejects saved settings for another project before evaluation", async () => {
  const f = fixture(), rejected = assert.rejects(f.result, /404/)
  await releaseScope(f)
  f.saved.resolve({...savedData,project_id:"other"}); f.snapshot.resolve(snapshotData)
  await rejected
  assert.equal(f.calls.includes("live"), false)
})
test("org report keeps read failures rather than replacing a snapshot with live numbers", async () => {
  const f = fixture(), failure = new Error("Snapshot unavailable")
  const rejected = assert.rejects(f.result, error => error === failure)
  await releaseScope(f)
  f.snapshot.reject(failure); f.saved.resolve(savedData)
  await rejected
  assert.equal(f.calls.includes("live"), false)
})
test("org report live execution still enforces catalog permission before evaluation", async () => {
  const f = fixture({search:{},allowed:false}), rejected = assert.rejects(f.result, /404/)
  await releaseScope(f)
  await rejected
  assert.deepEqual(f.calls, ["scope"])
})
test("org reports without snapshots evaluate live data without fetching saved records", async () => {
  const f = fixture({search:{period:"current"}})
  await releaseScope(f)
  const view = (await f.result).props.children.props.children
  assert.deepEqual(view.props.params, {period:"current"})
  assert.deepEqual(f.calls, ["scope", "live"])
})
