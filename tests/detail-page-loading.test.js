const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
const React = require("react")

function load(path, modules = {}) {
  const exports = {}, leaves = new Proxy({}, { get: () => () => null })
  const code = ts.transpileModule(fs.readFileSync(`app/(app)/${path}/page.tsx`, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  new Function("exports", "require", code)(exports, name => ["react", "react/jsx-runtime"].includes(name) ? require(name) : modules[name] ?? leaves)
  return exports.default
}
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const cases = [
  ["payables/payment-runs/[id]", "Payment run", "Payables"],
  ["purchasing/bids/[packageId]", "Bid package", "Purchasing"],
  ["sales/[dealId]", "Sales deal", "Sales"],
  ["design-studio/sheet/[projectId]", "Selections", "Design Studio"],
]
for (const [path, title, parent] of cases) {
  test(`${title} publishes a neutral destination before route or identity reads`, async () => {
    const live = deferred(), calls = []
    const page = load(path, { "next/server": { connection: () => { calls.push("connection"); return live.promise } } })
    const shell = page({ params: new Promise(() => {}) })
    assert.equal(shell.type, React.Suspense)
    assert.equal(shell.props.fallback.props.title, title)
    assert.equal(shell.props.fallback.props.breadcrumbs[0].label, parent)
    assert.equal(shell.props.fallback.props.breadcrumbs.at(-1).label, title)
    assert.deepEqual(calls, [])
    shell.props.children.type(shell.props.children.props)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(calls, ["connection"])
  })
}

test("purchasing bid packages retain permission and award-target guards before auxiliary reads", async () => {
  for (const denied of [true, false]) {
    const live = deferred(), calls = [], failure = new Error("Forbidden")
    const actions = new Proxy({ getBidPackageAction: async id => { calls.push(["package", id]); return { id, award_target: "commitment" } } }, { get: (target, key) => target[key] ?? (() => { calls.push(["auxiliary", key]); return Promise.resolve([]) }) })
    const page = load("purchasing/bids/[packageId]", {
      "next/server": { connection: () => live.promise },
      "next/navigation": { notFound: () => { throw new Error("404") } },
      "@/lib/services/context": { requireOrgContext: async () => { calls.push("context"); return { orgId: "org" } } },
      "@/lib/services/permissions": { requirePermission: async (name, context) => { calls.push(["permission", name, context.orgId]); if (denied) throw failure } },
      "@/app/(app)/bids/actions": actions,
    })
    const shell = page({ params: Promise.resolve({ packageId: "package" }) }), content = shell.props.children
    const result = content.type(content.props), rejected = denied ? assert.rejects(result, error => error === failure) : assert.rejects(result, /404/)
    await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(calls, [])
    live.resolve(); await rejected
    assert.deepEqual(calls, denied ? ["context", ["permission", "bid.read", "org"]] : ["context", ["permission", "bid.read", "org"], ["package", "package"]])
  }
})

test("selection-sheet read failures stay errors and missing sheets stay 404s", async () => {
  for (const missing of [true, false]) {
    const live = deferred(), calls = [], failure = new Error("Sheet unavailable")
    const page = load("design-studio/sheet/[projectId]", {
      "next/server": { connection: () => live.promise },
      "next/navigation": { notFound: () => { throw new Error("404") } },
      "@/lib/services/design-studio": { getSelectionSheet: async id => { calls.push(id); if (!missing) throw failure; return null } },
    })
    const content = page({ params: Promise.resolve({ projectId: "project" }) }).props.children
    const result = content.type(content.props), rejected = missing ? assert.rejects(result, /404/) : assert.rejects(result, error => error === failure)
    await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(calls, [])
    live.resolve(); await rejected
    assert.deepEqual(calls, ["project"])
  }
})

test("payment-run access denial does not start payment, organization or service-role reads", async () => {
  const live = deferred(), calls = [], failure = new Error("Forbidden")
  const page = load("payables/payment-runs/[id]", {
    "next/server": { connection: () => live.promise },
    "@/lib/auth/guards": { requireAnyPermissionGuard: async permissions => { calls.push(["permission", permissions]); throw failure } },
    "@/lib/services/payment-runs": { listPaymentRuns: () => { calls.push("runs"); return Promise.resolve([]) } },
    "@/lib/services/context": { requireOrgContext: () => { calls.push("context"); return Promise.resolve({}) } },
    "@/lib/supabase/server": { createServiceSupabaseClient: () => { calls.push("service client"); return {} } },
  })
  const content = page({ params: Promise.resolve({ id: "run" }) }).props.children
  const rejected = assert.rejects(content.type(content.props), error => error === failure)
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(calls, [])
  live.resolve(); await rejected
  assert.deepEqual(calls, [["permission", ["payment.release", "payment.approve_run", "payment.reconcile", "payment.manage_rail"]]])
})

test("sales detail retains parallel reads and requests owners without unused project counts", async () => {
  const live = deferred(), detail = deferred(), calls = []
  const page = load("sales/[dealId]", {
    "next/server": { connection: () => live.promise },
    "next/navigation": { notFound: () => { throw new Error("404") } },
    "@/lib/services/sales-deals": { getSalesDealDetail: id => { calls.push(["detail", id]); return detail.promise } },
    "@/lib/services/desk-context": { getAmbientDeskContext: async () => { calls.push("ambient"); return {} } },
    "@/lib/services/team": { listTeamMembers: async (...args) => { calls.push(["team", ...args]); throw new Error("Optional roster unavailable") } },
  })
  const content = page({ params: Promise.resolve({ dealId: "prospect%3Aid" }) }).props.children
  const rejected = assert.rejects(content.type(content.props), /404/)
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(calls, [])
  live.resolve(); await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, [["detail", "prospect:id"], "ambient", ["team", undefined, { includeProjectCounts: false }]])
  detail.resolve(null); await rejected
})
