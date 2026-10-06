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

function fixture(detail, { modelFailure = false } = {}) {
  const plan = deferred(), permissions = deferred(), reads = []
  const optionalServices = new Proxy({}, { get: () => async () => [] })
  const dependencies = {
    "next/server": { connection: async () => {} },
    "next/navigation": { notFound: () => { throw new Error("Not found") } },
    "@/lib/services/desk-context": { getAmbientDeskContext: async () => ({ divisionId: "division", communityId: "community" }) },
    "@/lib/services/permissions": { getCurrentUserPermissions: () => permissions.promise },
    "@/lib/services/house-plans": new Proxy({
      getHousePlan: () => plan.promise,
      getPlanLadder: scope => { reads.push(["ladder", scope]); return plan.promise },
    }, { get: (object, name) => object[name] ?? (async () => []) }),
    "@/lib/services/floorplan-models": { listFloorplanModelStatuses: async ids => {
      reads.push(["models", ids])
      if (modelFailure) throw new Error("Model unavailable")
      return new Map([["edition", { id: "model" }]])
    } },
  }
  const source = ts.transpileModule(fs.readFileSync(detail ? "app/(app)/plans/[id]/page.tsx" : "app/(app)/plans/page.tsx", "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const exports = {}, leaf = new Proxy({}, { get: () => () => null })
  new Function("exports", "require", source)(exports, name => {
    if (["react", "react/jsx-runtime"].includes(name)) return require(name)
    return dependencies[name] ?? (name.startsWith("@/lib/services/") ? optionalServices : leaf)
  })
  const shell = exports.default({ params: Promise.resolve({ id: "plan" }) })
  const suspense = detail ? shell : shell.props.children
  assert.equal(suspense.type, React.Suspense)
  return { plan, permissions, reads, shell, content: () => suspense.props.children.type(suspense.props.children.props) }
}

test("plan library model statuses start while permissions are pending and exclude unreleased editions", async () => {
  const f = fixture(false)
  const resultPromise = f.content()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.reads, [["ladder", { divisionId: "division", communityId: "community" }]])
  f.plan.resolve({ rungs: [{ released_version_id: "edition" }, { released_version_id: null }] })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.reads.at(-1), ["models", ["edition"]])
  f.permissions.resolve({ permissions: ["plan.write"] })
  const result = await resultPromise
  assert.equal(result.props.canWrite, true)
  assert.equal(result.props.floorplanModels.get("edition").id, "model")
})

test("plan details load edition status before unrelated permissions resolve", async () => {
  const f = fixture(true)
  assert.equal(f.shell.props.fallback.props.title, "Plan details")
  const resultPromise = f.content()
  await new Promise(resolve => setImmediate(resolve))
  f.plan.resolve({ id: "plan", code: "P", name: "Fixture", versions: [{ id: "edition" }, { id: "draft" }] })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.reads, [["models", ["edition", "draft"]]])
  f.permissions.resolve({ permissions: ["plan.release"] })
  const client = (await resultPromise).props.children
  assert.equal(client.props.canWrite, false)
  assert.equal(client.props.canRelease, true)
  assert.equal(client.props.floorplanModels.get("edition").id, "model")
})

test("missing or failed plan reads never start model status queries", async () => {
  for (const message of ["House plan not found", "Database unavailable"]) {
    const f = fixture(true)
    const resultPromise = f.content()
    await new Promise(resolve => setImmediate(resolve))
    f.plan.reject(new Error(message))
    f.permissions.resolve({ permissions: [] })
    await assert.rejects(resultPromise, message === "House plan not found" ? /Not found/ : /Database unavailable/)
    assert.deepEqual(f.reads, [])
  }
})

test("model status outages retain the plan workbench with its existing empty-status fallback", async t => {
  t.mock.method(console, "error", () => {})
  for (const detail of [false, true]) {
    const f = fixture(detail, { modelFailure: true })
    const resultPromise = f.content()
    f.plan.resolve(detail ? { code: "P", name: "Fixture", versions: [{ id: "edition" }] } : { rungs: [{ released_version_id: "edition" }] })
    f.permissions.resolve({ permissions: [] })
    const result = await resultPromise
    const client = detail ? result.props.children : result
    assert.equal(client.props.floorplanModels.size, 0)
  }
})
