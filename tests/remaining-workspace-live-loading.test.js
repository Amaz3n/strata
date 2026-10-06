const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
const React = require("react")
const cases = [
  ["emails/preview", "Email Preview", "desk"],
  ["starts", "Starts", "desk"],
  ["billing/receive-payment", "Receive payment", "desk"],
  ["plans", "Plans", "desk"],
  ["plans/[id]", "Plan details", "desk"],
  ["payables/waivers", "Payables · Waivers", "desk"],
  ["schedule/trades", "Trade look-aheads", "desk"],
  ["warranty/accounting", "Warranty accounting", "books"],
  ["whats-new", "What's New", "desk"],
  ["platform/bugs", "Platform Issues", "desk"],
  ["design-studio", "Design Studio", "desk"],
  ["design-studio/catalog", "Option catalog", "desk"],
  ["design-studio/rules", "Cutoff rules", "desk"],
  ["estimates", "Estimates", "desk"],
  ["signatures", "Signatures", "desk"],
  ["admin/analytics", "Analytics", "guard"],
  ["settings/divisions", "Divisions", "roster"],
  ["billing/deposits", "Customer deposits", "books"],
  ["books/assets", "Assets & loans", "books"],
]
function boundary(element) {
  if (element.type === React.Suspense) return element
  for (const child of React.Children.toArray(element.props.children)) {
    if (React.isValidElement(child)) { const found = boundary(child); if (found) return found }
  }
}
function loadPage(path, modules) {
  const exports = {}, code = ts.transpileModule(fs.readFileSync(`app/(app)/${path}/page.tsx`, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  new Function("exports", "require", code)(exports, name => ["react", "react/jsx-runtime"].includes(name) ? require(name) : modules[name] ?? new Proxy({}, { get: () => () => { throw Error(`Unexpected module call: ${name}`) } }))
  return exports.default
}
for (const [path, title, kind] of cases) {
  test(`${title} exposes a shell without starting live reads`, async () => {
    let reject
    const calls = [], live = new Promise((_, fail) => { reject = fail })
    const leaves = new Proxy({}, { get: (_, key) => (...args) => { calls.push([key, args]); return null } })
    const exports = {}, code = ts.transpileModule(fs.readFileSync(`app/(app)/${path}/page.tsx`, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
    new Function("exports", "require", code)(exports, name => ["react", "react/jsx-runtime"].includes(name) ? require(name) : name === "next/server" ? { connection: () => { calls.push("live"); return live } } : leaves)
    const shell = exports.default({ searchParams: new Promise(() => {}) }), suspense = boundary(shell)
    assert.ok(suspense)
    const layout = shell.type === React.Suspense ? suspense.props.fallback : shell
    assert.equal(layout.props.title, title)
    if (kind !== "desk") assert.ok(layout.props.breadcrumbs.length >= 2)
    assert.deepEqual(calls, [])
    const content = suspense.props.children, result = content.type(content.props), failure = Error("Aborted prefetch")
    const rejected = assert.rejects(result, error => error === failure)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(calls, ["live"])
    reject(failure); await rejected
    assert.deepEqual(calls, ["live"])
  })
  if (kind !== "roster" && kind !== "desk") test(`${title} rejects unauthorized requests before rendering protected content`, async () => {
    const calls = [], forbidden = Error("Forbidden"), exports = {}
    const code = ts.transpileModule(fs.readFileSync(`app/(app)/${path}/page.tsx`, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
    const modules = {
      "next/server": { connection: async () => {} },
      "next/navigation": { notFound: () => { throw forbidden } },
      "@/lib/auth/guards": { requireAnyPermissionGuard: async permissions => { calls.push(permissions); throw forbidden } },
      "@/lib/services/books/ui-access": { getBooksUiAccess: async () => { calls.push("access"); return { adjust: false } } },
    }
    const leaves = new Proxy({}, { get: (_, key) => () => { calls.push(key); return null } })
    new Function("exports", "require", code)(exports, name => ["react", "react/jsx-runtime"].includes(name) ? require(name) : modules[name] ?? leaves)
    const child = boundary(exports.default()).props.children
    await assert.rejects(child.type(child.props), error => error === forbidden)
    assert.deepEqual(calls, kind === "guard" ? [["billing.manage", "platform.billing.manage"]] : ["access"])
  })
}

test("plan library overlaps independent reads while scope is pending", async () => {
  let resolveAmbient
  const calls = [], page = loadPage("plans", {
    "next/server": { connection: async () => calls.push("live") },
    "@/lib/services/desk-context": { getAmbientDeskContext: () => { calls.push("scope"); return new Promise(resolve => { resolveAmbient = resolve }) } },
    "@/lib/services/divisions": { listDivisions: async () => { calls.push("divisions"); return [] } },
    "@/lib/services/permissions": { getCurrentUserPermissions: async () => { calls.push("permissions"); return { permissions: ["plan.read"] } } },
    "@/lib/services/communities": { listCommunities: async scope => { calls.push(["communities", scope]); return [] } },
    "@/lib/services/house-plans": { getPlanLadder: async scope => { calls.push(["ladder", scope]); return { rungs: [{ released_version_id: "edition" }] } } },
    "@/lib/services/floorplan-models": { listFloorplanModelStatuses: async ids => { calls.push(["models", ids]); return new Map() } },
  })
  const content = boundary(page()).props.children, pending = content.type(content.props)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, ["live", "scope", "divisions", "permissions"])
  resolveAmbient({ divisionId: "division", communityId: "community" })
  const result = await pending
  assert.deepEqual(calls.slice(4), [["ladder", { divisionId: "division", communityId: "community" }], ["communities", { divisionId: "division" }], ["models", ["edition"]]])
  assert.equal(result.props.canWrite, false)
})

test("receive payment preserves reviewed party filtering on live reads", async () => {
  const id = "00000000-0000-4000-8000-000000000001"
  for (const [query, filter] of [[{ partyType: "company", partyId: id }, { partyType: "company", partyId: id }], [{ partyType: "company" }, {}], [{ partyType: "foreign", partyId: id }, {}]]) {
    const calls = [], workspace = {}, page = loadPage("billing/receive-payment", {
      "zod": require("zod"),
      "next/server": { connection: async () => calls.push("live") },
      "@/lib/services/payments": { getReceivePaymentWorkspace: async input => { calls.push(input); return workspace } },
    })
    const child = boundary(page({ searchParams: Promise.resolve(query) })).props.children
    const result = await child.type(child.props)
    assert.deepEqual(calls, ["live", filter])
    assert.equal(result.props.children.props.workspace, workspace)
  }
})
