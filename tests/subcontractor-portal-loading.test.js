const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
function load(path, modules = {}) {
  const exports = {}, code = ts.transpileModule(fs.readFileSync(path, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  new Function("exports", "require", code)(exports, name => name === "react/jsx-runtime" ? require(name) : modules[name] ?? new Proxy({}, { get: () => () => { throw Error(`Unexpected module call: ${name}`) } }))
  return exports.default
}
const sections = [["", "Overview"], ["bills/", "Invoices"], ["commitments/", "Contracts"], ["compliance/", "Compliance"], ["daily-logs/", "Daily logs"], ["documents/", "Documents"], ["expenses/", "Submit expense"], ["prequalification/", "Prequalification"], ["punch/", "Punch list"], ["purchase-orders/", "Purchase orders"], ["rfis/", "RFIs"], ["rfqs/", "Request for pricing"], ["submit-invoice/", "Submit invoice"], ["submittals/", "Submittals"], ["subtier-waivers/", "Sub-tier lien waivers"], ["time/", "Submit time"], ["waivers/[billId]/", "Lien waivers"], ["warranty/", "Warranty appointments"]]
for (const [section, title] of sections) {
  test(`subcontractor ${title} does no parameter, data or access work during prefetch`, async () => {
    let reject
    const calls = [], live = new Promise((_, fail) => { reject = fail })
    const page = load(`app/s/[token]/${section}page.tsx`, { "next/server": { connection: () => { calls.push("live"); return live } } })
    const unread = { then() { calls.push("parameter"); throw Error("Unexpected parameter read") } }
    const result = page({ params: unread, searchParams: unread }), failure = Error("Aborted prefetch")
    const rejected = assert.rejects(result, error => error === failure)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(calls, ["live"])
    reject(failure); await rejected
    assert.deepEqual(calls, ["live"])
    assert.equal(load(`app/s/[token]/${section}loading.tsx`)().props.title, title)
  })
  test(`subcontractor ${title} preserves denial before section reads`, async () => {
    const calls = [], page = load(`app/s/[token]/${section}page.tsx`, {
      "next/server": { connection: async () => calls.push("live") },
      "next/navigation": { notFound: () => { throw Error("Not found") } },
      "@/lib/services/portal-access": { assertPortalActionAccess: async (token, options) => { calls.push([token, options]); throw Error("Denied") } },
      "@/lib/services/change-events": { getPortalChangeEventRfq: async token => { calls.push([token, "rfq"]); return null } },
    })
    await assert.rejects(page({ params: Promise.resolve({ token: "fixture-token", billId: "bill" }), searchParams: Promise.resolve({}) }), /Not found/)
    assert.equal(calls[0], "live")
    assert.equal(calls.length, 2)
    assert.equal(calls[1][0], "fixture-token")
    if (section !== "rfqs/") assert.equal(calls[1][1].portalType, "sub")
  })
}

test("vendor account home records authorized access without loading a project", async () => {
  const calls = [], page = load("app/s/[token]/page.tsx", {
    "next/server": { connection: async () => calls.push("live") },
    "@/lib/services/portal-access": {
      assertPortalActionAccess: async (token, options) => { calls.push(["access", token, options]); return { id: "access", org_id: "org", company_id: "company", project_id: null } },
      recordPortalAccess: async id => calls.push(["record", id]),
    },
  })
  const result = await page({ params: Promise.resolve({ token: "fixture-token" }) })
  assert.deepEqual(calls, ["live", ["access", "fixture-token", { portalType: "sub", requireCompany: true }], ["record", "access"]])
  assert.deepEqual(result.props, { token: "fixture-token", orgId: "org", companyId: "company" })
})

test("subcontractor invoices overlap their authorized data and compliance shell reads", async () => {
  let resolveData
  const calls = [], access = { org_id: "org", project_id: "project", company_id: "company", permissions: { can_submit_invoices: false } }
  const page = load("app/s/[token]/bills/page.tsx", {
    "next/server": { connection: async () => calls.push("live") },
    "@/lib/services/portal-access": {
      assertPortalActionAccess: async () => { calls.push("access"); return access },
      loadSubPortalData: scope => { calls.push(["data", scope]); return new Promise(resolve => { resolveData = resolve }) },
      loadSubPortalShellContext: async scope => { calls.push(["shell", scope]); return { blocksPaymentOnCompliance: true, isCompliant: false } },
    },
  })
  const pending = page({ params: Promise.resolve({ token: "fixture-token" }) })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, ["live", "access", ["data", { orgId: "org", projectId: "project", companyId: "company", permissions: access.permissions }], ["shell", { orgId: "org", projectId: "project", companyId: "company", permissions: access.permissions }]])
  resolveData({ commitments: [], bills: [], company: { name: "Fixture vendor" } })
  await pending
})

test("subcontractor documents retain their authorized project and token scope", async () => {
  const calls = [], files = [{ id: "file" }], page = load("app/s/[token]/documents/page.tsx", {
    "next/server": { connection: async () => calls.push("live") },
    "@/lib/services/portal-access": {
      assertPortalActionAccess: async (token, options) => { calls.push(["access", token, options]); return { org_id: "org", project_id: "project", company_id: "company", permissions: { can_download_files: false } } },
      loadSubPortalSharedFiles: async scope => { calls.push(["files", scope]); return files },
    },
  })
  const result = await page({ params: Promise.resolve({ token: "fixture-token" }) })
  assert.deepEqual(calls, ["live", ["access", "fixture-token", { portalType: "sub", requireProject: true, requireCompany: true, permission: "can_view_documents" }], ["files", { orgId: "org", projectId: "project", portalToken: "fixture-token" }]])
  assert.equal(result.props.children[1].props.files, files)
  assert.equal(result.props.children[1].props.canDownload, false)
})

test("vendor warranty retains company scope and optional project narrowing", async () => {
  for (const project of [null, "project"]) {
    const calls = [], visits = [], page = load("app/s/[token]/warranty/page.tsx", {
      "next/server": { connection: async () => calls.push("live") },
      "@/lib/services/portal-access": { assertPortalActionAccess: async (token, options) => { calls.push(["access", token, options]); return { org_id: "org", project_id: project, company_id: "company" } } },
      "@/lib/services/warranty-operations": { listWarrantyVisitsForCompanyPortal: async scope => { calls.push(["visits", scope]); return visits } },
    })
    const result = await page({ params: Promise.resolve({ token: "fixture-token" }) })
    assert.deepEqual(calls, ["live", ["access", "fixture-token", { portalType: "sub", requireCompany: true }], ["visits", { orgId: "org", companyId: "company", projectId: project ?? undefined }]])
    assert.deepEqual(result.props.children[1].props, { token: "fixture-token", initialVisits: visits })
  }
})

test("vendor waiver lookup preserves authorized company, project and bill identity", async () => {
  const calls = [], page = load("app/s/[token]/waivers/[billId]/page.tsx", {
    "next/server": { connection: async () => calls.push("live") },
    "next/navigation": { notFound: () => { throw Error("Not found") } },
    "@/lib/services/portal-access": { assertPortalActionAccess: async (token, options) => { calls.push(["access", token, options]); return { org_id: "org", project_id: "project", company_id: "company" } } },
    "@/lib/services/lien-waivers": { getVendorBillWaiverForPortal: async scope => { calls.push(["waiver", scope]); return null } },
  })
  await assert.rejects(page({ params: Promise.resolve({ token: "fixture-token", billId: "bill" }) }), /Not found/)
  assert.deepEqual(calls, ["live", ["access", "fixture-token", { portalType: "sub", requireProject: true, requireCompany: true, permission: "can_view_bills" }], ["waiver", { orgId: "org", projectId: "project", companyId: "company", billId: "bill" }]])
})
