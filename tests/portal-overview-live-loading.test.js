const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
function load(path, modules) {
  const exports = {}, code = ts.transpileModule(fs.readFileSync(path, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  new Function("exports", "require", code)(exports, name => name === "react/jsx-runtime" ? require(name) : modules[name] ?? new Proxy({}, { get: () => () => null }))
  return exports.default
}
for (const [section, title] of [["", "Overview"], ["photos/", "Photos"], ["roadmap/", "Roadmap"], ["actions/", "Approvals"], ["about/", "Project team"], ["documents/", "Documents"], ["invoices/", "Invoices"], ["invoices/[id]/", "Invoice"], ["pay-applications/", "Pay applications"], ["pay-applications/[id]/", "Pay application"], ["model/", "Your home in 3D"], ["change-orders/[id]/", "Change order"]]) {
  test(`${title} waits for a live request before token reads or access recording`, async () => {
    let reject
    const calls = [], live = new Promise((_, fail) => { reject = fail })
    const page = load(`app/p/[token]/${section}page.tsx`, {
      "next/server": { connection: () => { calls.push("live"); return live } },
      "./load-portal": { loadClientPortalPage: () => { calls.push("data"); return null } },
      "../load-portal": { loadClientPortalPage: () => { calls.push("data"); return null }, loadClientPortalPhotosPage: () => { calls.push("photos"); return null }, loadClientPortalActionsPage: () => { calls.push("approvals"); return null } },
      "@/lib/services/portal-access": { recordPortalAccess: () => { calls.push("record"); return null } },
    })
    const result = page({ params: { then() { calls.push("token"); throw Error("Unexpected token read") } } }), failure = Error("Aborted prefetch")
    const rejected = assert.rejects(result, error => error === failure)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(calls, ["live"])
    reject(failure); await rejected
    assert.deepEqual(calls, ["live"])
    assert.equal(load(`app/p/[token]/${section}loading.tsx`, {})().props.title, title)
  })
}
test("Overview records the loaded access identity only on a live request", async () => {
  const calls = [], payload = { overview: "fixture" }, page = load("app/p/[token]/page.tsx", {
    "next/server": { connection: async () => { calls.push("live") } },
    "./load-portal": { loadClientPortalPage: async token => { calls.push(["load", token]); return { access: { id: "access", permissions: { can_pay_invoices: false } }, data: payload } } },
    "@/lib/services/portal-access": { recordPortalAccess: async id => { calls.push(["record", id]) } },
  })
  const client = await page({ params: Promise.resolve({ token: "fixture-token" }) })
  assert.deepEqual(calls, ["live", ["load", "fixture-token"], ["record", "access"]])
  assert.equal(client.props.data, payload)
  assert.equal(client.props.canPayInvoices, false)
})
test("Overview failed authorization never records portal access", async () => {
  const calls = [], failure = Error("Denied"), page = load("app/p/[token]/page.tsx", {
    "next/server": { connection: async () => {} },
    "./load-portal": { loadClientPortalPage: async () => { throw failure } },
    "@/lib/services/portal-access": { recordPortalAccess: async () => { calls.push("record") } },
  })
  await assert.rejects(page({ params: Promise.resolve({ token: "fixture-token" }) }), error => error === failure)
  assert.deepEqual(calls, [])
})
test("unavailable or private change orders never create a view-recording client", async () => {
  for (const scenario of ["denied", "missing", "private"]) {
    const calls = [], page = load("app/p/[token]/change-orders/[id]/page.tsx", {
      "next/server": { connection: async () => {} },
      "next/navigation": { notFound: () => { throw Error("Not found") }, unstable_rethrow: require("next/navigation").unstable_rethrow },
      "@/lib/services/portal-access": { assertPortalActionAccess: async (token, options) => {
        calls.push(["access", token, options]); if (scenario === "denied") throw Error("Denied")
        return { org_id: "org", project_id: "project" }
      } },
      "@/lib/services/change-orders": { getChangeOrderForPortal: async (...scope) => { calls.push(["order", ...scope]); return scenario === "missing" ? null : { id: "order", client_visible: false } } },
      "@/lib/supabase/server": { createServiceSupabaseClient: () => { calls.push("view-client"); throw Error("Unexpected view recording") } },
    })
    await assert.rejects(page({ params: Promise.resolve({ token: "token", id: "order" }) }), /Not found/)
    assert.deepEqual(calls[0], ["access", "token", { portalType: "client", requireProject: true, permission: "can_approve_change_orders" }])
    assert.equal(calls.includes("view-client"), false)
    if (scenario !== "denied") assert.deepEqual(calls[1], ["order", "order", "org", "project"])
  }
})
