const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
const { redirect, notFound } = require("next/navigation")
const { unstable_rethrow } = require("next/dist/client/components/unstable-rethrow")
const { DynamicServerError } = require("next/dist/client/components/hooks-server-context")

function thrownBy(callback) {
  try { callback() } catch (error) { return error }
  throw Error("Expected Next.js control-flow error")
}

function loadData(failure) {
  const exports = {}
  const code = ts.transpileModule(fs.readFileSync("app/(app)/directory/[id]/page-data.ts", "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  new Function("exports", "require", code)(exports, name => {
    if (name === "react") return require(name)
    if (name === "next/navigation") return { unstable_rethrow }
    if (name === "@/lib/services/context") return { requireOrgContext: async () => ({ supabase: {}, orgId: "fixture-org" }) }
    return new Proxy({}, { get: () => async () => { throw failure } })
  })
  return exports
}

const cases = [
  ["loadCostCodesEnabledForProjects", ["fixture-project"], {}],
  ["loadPaymentReadiness", "fixture-company", null],
  ["loadPrequalificationGlance", "fixture-company", null],
  ["loadClientReceivables", "fixture-company", null],
  ["loadContactReceivables", "fixture-contact", null],
  ["loadContactAssignments", "fixture-contact", { schedule: [], tasks: [], limit: 0, scheduleTruncated: false, tasksTruncated: false }],
  ["loadVendorIntelligence", "fixture-company", { scorecard: null, taxReadiness: null }],
]

for (const [name, argument, fallback] of cases) {
  test(`${name} preserves optional-data fallbacks without swallowing Next.js control flow`, async () => {
    assert.deepEqual(await loadData(Error("Fixture service unavailable"))[name](argument), fallback)
    const redirectError = thrownBy(() => redirect("/auth/signin"))
    for (const failure of [redirectError, thrownBy(notFound), new DynamicServerError("Interrupted fixture prerender"), Error("Wrapped redirect", { cause: redirectError })]) {
      await assert.rejects(loadData(failure)[name](argument), error => error === failure || error === failure.cause)
    }
  })
}

async function renderTab(tab, failedService, failure) {
  const exports = {}, id = "11111111-1111-4111-8111-111111111111"
  const account = { kind: "company", company: { id, contacts: [] }, name: "Fixture company", canEdit: true }
  const services = {
    loadDirectoryParty: async () => account,
    loadVendorCompanyHeader: async () => account,
    registerDirectoryTabCache: () => {},
    listProjectSummariesAction: async () => [],
    listCompanyContactAccess: async () => new Map(),
    listComplianceDocumentTypes: async () => [],
    getComplianceHeldPayables: async () => ({ heldCents: 0, billCount: 0 }),
    getComplianceRules: async () => null,
    getCurrentUserPermissions: async () => ({ permissions: [] }),
    loadComplianceStatus: async () => ({ enrollment: "unenrolled" }),
    getPrequalificationPackage: async () => ({ applications: [] }),
    getCompanyCommitmentRegister: async () => ({ rows: [], rollup: {}, exceptions: [], pagination: {}, facets: {} }),
    listProjects: async () => [],
    listCostCodes: async () => [],
    [failedService]: async () => { throw failure },
  }
  const code = ts.transpileModule(fs.readFileSync(`app/(app)/directory/[id]/${tab}/page.tsx`, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  new Function("exports", "require", code)(exports, name => {
    if (["react", "react/jsx-runtime", "zod"].includes(name)) return require(name)
    if (name === "next/navigation") return { redirect, notFound, unstable_rethrow }
    return new Proxy({}, { get: (_, property) => services[property] ?? (() => { throw Error(`Unexpected call: ${name}.${String(property)}`) }) })
  })
  const shell = exports.default({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) })
  assert.equal(shell.type, require("react").Suspense)
  const content = await shell.props.children.type(shell.props.children.props)
  return content.type(content.props)
}

for (const [tab, service, prop, fallback] of [
  ["contacts", "listCompanyContactAccess", "accessByContactId", {}],
  ["prequalification", "listComplianceDocumentTypes", "documentTypes", []],
  ["compliance", "listComplianceDocumentTypes", "documentTypes", []],
  ["compliance", "getComplianceHeldPayables", "heldCents", 0],
  ["compliance", "getComplianceRules", "blocksPayment", true],
  ["commitments", "listProjects", "projects", []],
  ["commitments", "listCostCodes", "costCodes", []],
]) {
  test(`${tab} preserves the ${service} fallback and propagates Next.js control flow`, async () => {
    const result = await renderTab(tab, service, Error("Fixture service unavailable"))
    assert.deepEqual(result.props[prop], fallback)
    for (const failure of [thrownBy(() => redirect("/auth/signin")), thrownBy(notFound), new DynamicServerError("Interrupted fixture prerender")]) {
      await assert.rejects(renderTab(tab, service, failure), error => error === failure)
    }
  })
}
