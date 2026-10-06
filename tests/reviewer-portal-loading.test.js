const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
function load(path, modules) {
  const exports = {}, code = ts.transpileModule(fs.readFileSync(path, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  new Function("exports", "require", code)(exports, name => name === "react/jsx-runtime" ? require(name) : modules[name] ?? new Proxy({}, { get: () => () => null }))
  return exports
}
for (const [section, title] of [["", "Overview"], ["drawings/", "Drawings"], ["rfis/", "RFIs"], ["submittals/", "Submittals"]]) {
  test(`reviewer ${title} starts no parameter, access or data work during prefetch`, async () => {
    let reject
    const calls = [], live = new Promise((_, fail) => { reject = fail })
    const page = load(`app/r/[token]/${section}page.tsx`, { "next/server": { connection: () => { calls.push("live"); return live } } }).default
    const result = page({ params: { then() { calls.push("token"); throw Error("Unexpected token read") } } }), failure = Error("Aborted prefetch")
    const rejected = assert.rejects(result, error => error === failure)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(calls, ["live"])
    reject(failure); await rejected
    assert.deepEqual(calls, ["live"])
    assert.equal(load(`app/r/[token]/${section}loading.tsx`, {}).default().props.title, title)
  })
}
test("reviewer access-only loader does not fetch the shared portal payload", async () => {
  for (const denied of [false, true]) {
    const calls = [], access = { org_id: "org", project_id: "project", contact_id: "contact", company_id: "company", reviewer_role: "architect", scoped_rfi_id: "rfi" }
    const loaders = load("app/r/[token]/load-reviewer.ts", {
      "next/navigation": { notFound: () => { throw Error("Not found") } },
      "@/lib/services/portal-access": {
        assertPortalActionAccess: async (token, options) => { calls.push(["access", token, options]); if (denied) throw Error("Denied"); return access },
        loadReviewerPortalData: async scope => { calls.push(["data", scope]); return { rfis: [] } },
      },
    })
    if (denied) await assert.rejects(loaders.loadReviewerPortalAccess("token"), /Not found/)
    else assert.equal(await loaders.loadReviewerPortalAccess("token"), access)
    assert.deepEqual(calls, [["access", "token", { portalType: "reviewer", requireProject: true }]])
    if (!denied) {
      const result = await loaders.loadReviewerPortalPage("token")
      assert.deepEqual(result.data, { rfis: [] })
      assert.deepEqual(calls.at(-1), ["data", { orgId: "org", projectId: "project", contactId: "contact", companyId: "company", reviewerRole: "architect", scopedRfiId: "rfi" }])
    }
  }
})
test("Submittals checks reviewer permission and contact before loading its scoped queue", async () => {
  for (const scenario of ["allowed", "denied", "no-contact"]) {
    const calls = [], access = { org_id: "org", project_id: "project", contact_id: scenario === "no-contact" ? null : "contact", permissions: { can_review_submittals: scenario !== "denied" } }
    const page = load("app/r/[token]/submittals/page.tsx", {
      "next/server": { connection: async () => {} },
      "next/navigation": { notFound: () => { throw Error("Not found") } },
      "../load-reviewer": { loadReviewerPortalAccess: async token => { calls.push(["access", token]); return access }, loadReviewerPortalPage: () => { throw Error("Unexpected shared payload read") } },
      "@/lib/services/submittals": { listReviewStepsForReviewer: async scope => { calls.push(["queue", scope]); return [] } },
    }).default
    const result = page({ params: Promise.resolve({ token: "token" }) })
    if (scenario === "allowed") {
      const rendered = await result
      assert.deepEqual(rendered.props.children[1].props.initialQueue, [])
      assert.deepEqual(calls, [["access", "token"], ["queue", { orgId: "org", projectId: "project", contactId: "contact" }]])
    } else { await assert.rejects(result, /Not found/); assert.deepEqual(calls, [["access", "token"]]) }
  }
})
test("Drawings preserves view and download permissions without fetching reviewer records", async () => {
  for (const canView of [true, false]) {
    const calls = [], page = load("app/r/[token]/drawings/page.tsx", {
      "next/server": { connection: async () => {} },
      "next/navigation": { notFound: () => { throw Error("Not found") } },
      "../load-reviewer": { loadReviewerPortalAccess: async token => { calls.push(token); return { permissions: { can_view_documents: canView, can_download_files: false } } }, loadReviewerPortalPage: () => { throw Error("Unexpected shared payload read") } },
    }).default
    const result = page({ params: Promise.resolve({ token: "token" }) })
    if (canView) { const rendered = await result; assert.equal(rendered.props.children[1].props.canDownload, false) }
    else await assert.rejects(result, /Not found/)
    assert.deepEqual(calls, ["token"])
  }
})
