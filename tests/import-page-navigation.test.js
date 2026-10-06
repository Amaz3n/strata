require("../scripts/register-ts-node-test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
const React = require("react")

function fixture(productTier = "residential") {
  let resolveList
  const calls = []
  const list = new Promise(resolve => { resolveList = resolve })
  const dependencies = {
    "@/lib/validation/import-navigation": require("../lib/validation/import-navigation"),
    "@/lib/services/context": { requireOrgContext: async (_org, options) => { calls.push(["context", options]); return { orgId: "org-one", productTier } } },
    "@/lib/product-tier": { getProjectPosture: () => "residential" },
    "@/lib/services/import-definitions": { IMPORTER_KEYS: ["contacts", "plan_library", "open_wip"], IMPORTER_DEFINITIONS: { plan_library: { label: "Plan library", columns: [] }, contacts: { label: "Contacts", description: "Fixture importer", columns: [] } } },
    "@/lib/services/imports": {
      listImportBatches: input => { calls.push(["list", input]); return list },
      getImportBatch: async (id, options, access) => { calls.push(["detail", id, options, access]); return { batch: { id }, rows: [], total: 0 } },
    },
    "next/navigation": { notFound: () => { throw new Error("Not found") } },
  }
  const exports = {}
  const code = ts.transpileModule(fs.readFileSync("app/(app)/settings/imports/[importer]/page.tsx", "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const leaves = new Proxy({}, { get: () => () => null })
  new Function("exports", "require", code)(exports, name =>
    ["react", "react/jsx-runtime"].includes(name) ? require(name) : dependencies[name] ?? leaves,
  )
  function content(importer, query = {}) {
    const shell = exports.default({ params: Promise.resolve({ importer }), searchParams: Promise.resolve(query) })
    assert.equal(shell.type, React.Suspense)
    return shell.props.children.type(shell.props.children.props)
  }
  return { content, calls, resolveList }
}

test("selected import batch starts while its list read is still pending", async () => {
  const { content, calls, resolveList } = fixture()
  const pending = content("contacts", { batch: "batch-one" })
  await new Promise(setImmediate)
  assert.ok(calls.some(call => call[0] === "detail"), "the batch detail must not wait for the list")
  assert.deepEqual(calls.find(call => call[0] === "detail"), ["detail", "batch-one", { limit: 500, page: 1, status: "all" }, { expectedImporter: "contacts" }])
  resolveList({ batches: [] })
  const result = await pending
  assert.equal(result.props.children.props.orgId, "org-one", "organization changes reset the client import session")
  assert.equal(result.props.children.props.detail.batch.id, "batch-one")
})
test("the upload route avoids a batch detail query", async () => {
  const { content, calls, resolveList } = fixture()
  const pending = content("contacts")
  resolveList({ batches: [] })
  const result = await pending
  assert.equal(result.props.children.props.detail, null)
  assert.equal(calls.some(call => call[0] === "detail"), false)
})
test("unknown and platform-only importers cannot start import queries", async () => {
  for (const importer of ["unknown", "open_wip"]) {
    const { content, calls } = fixture()
    await assert.rejects(content(importer, { batch: "batch-one" }), /Not found/)
    assert.equal(calls.some(call => ["list", "detail"].includes(call[0])), false)
  }
})

for (const tier of ["residential", "commercial", "production"]) test(`${tier} default does not 404 a permitted production importer`, async () => {
  const h = fixture(tier), pending = h.content("plan_library")
  h.resolveList({ batches: [] })
  const result = await pending
  assert.equal(result.props.children.props.importer, "plan_library")
  assert.ok(h.calls.some(call => call[0] === "list" && call[1].importer === "plan_library"))
})

test('selected row status and both independent page numbers reach canonical service reads', async () => {
  const h = fixture(), pending = h.content('contacts', { batch: 'batch-one', batchPage: '3', rowPage: '20', rowStatus: 'error' })
  await new Promise(setImmediate)
  assert.deepEqual(h.calls.find(call => call[0] === 'detail'), ['detail', 'batch-one', { limit: 500, page: 20, status: 'error' }, { expectedImporter: 'contacts' }])
  assert.deepEqual(h.calls.find(call => call[0] === 'list'), ['list', { importer: 'contacts', limit: 25, page: 3 }])
  h.resolveList({ batches: [], total: 60, page: 3, limit: 25 })
  const result = await pending
  assert.equal(result.props.children.props.batchPagination.page, 3)
})
