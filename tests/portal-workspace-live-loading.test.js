const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")

const cases = [
  ["selections", "Choose your finishes", "can_submit_selections", "loadSelectionsAction"],
  ["decisions", "Your decisions", "can_submit_selections", "loadPortalDecisionsAction"],
  ["punch-list", "Punch list", "can_create_punch_items", "loadPunchItemsAction"],
  ["warranty", "Warranty", "can_view_warranty", null],
]
function load(path, dependencies) {
  const exports = {}
  const code = ts.transpileModule(fs.readFileSync(path, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  new Function("exports", "require", code)(exports, name => name === "react/jsx-runtime" ? require(name) : dependencies[name] ?? new Proxy({}, { get: () => () => null }))
  return exports.default
}
for (const [section, title, permission, action] of cases) {
  test(`${title} waits for a live request before reading portal parameters or permissions`, async () => {
    let reject
    const live = new Promise((_, fail) => { reject = fail }), calls = []
    const page = load(`app/p/[token]/${section}/page.tsx`, {
      "next/server": { connection: () => { calls.push("live"); return live } },
      "@/lib/services/portal-access": { assertPortalActionAccess: () => { calls.push("access"); throw Error("Unexpected access") } },
    })
    const params = { then() { calls.push("params"); throw Error("Unexpected params") } }
    const result = page({ params }), failure = Error("Aborted prefetch")
    const rejected = assert.rejects(result, error => error === failure)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(calls, ["live"])
    reject(failure); await rejected
    assert.deepEqual(calls, ["live"])
    assert.equal(load(`app/p/[token]/${section}/loading.tsx`, {})().props.title, title)
  })
  test(`${title} keeps token permissions ahead of scoped reads`, async () => {
    for (const denied of [false, true]) {
      const reads = []
      const page = load(`app/p/[token]/${section}/page.tsx`, {
        "next/server": { connection: async () => {} },
        "next/navigation": { notFound: () => { throw Error("Not found") }, unstable_rethrow: require("next/navigation").unstable_rethrow },
        "@/lib/services/portal-access": { assertPortalActionAccess: async (token, options) => {
          reads.push(["access", token, options]); if (denied) throw Error("Denied")
          return { org_id: "org", project_id: "project" }
        } },
        "./actions": action ? { [action]: async token => { reads.push(["data", token]); return [] } } : {},
        "@/lib/services/warranty": Object.fromEntries(["listWarrantyRequestsForPortal", "getProjectWarrantyCoverageForPortal", "listWarrantyVisitsForBuyerPortal"].map(name => [name, async (...scope) => { reads.push([name, ...scope]); return [] }])),
      })
      const result = page({ params: Promise.resolve({ token: "fixture-token" }) })
      if (denied) await assert.rejects(result, /Not found/)
      else await result
      assert.deepEqual(reads[0], ["access", "fixture-token", { portalType: "client", requireProject: true, permission }])
      if (denied) assert.equal(reads.length, 1)
      else if (action) assert.deepEqual(reads[1], ["data", "fixture-token"])
      else {
        assert.equal(reads.length, 4)
        for (const read of reads.slice(1)) assert.deepEqual(read.slice(1), ["org", "project"])
      }
    }
  })
}
