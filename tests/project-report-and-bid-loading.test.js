const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
function load(section, dependencies, params) {
  const exports = {}, leaf = new Proxy({}, { get: () => () => null })
  const source = ts.transpileModule(fs.readFileSync(`app/(app)/projects/[id]/${section}/page.tsx`, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  new Function("exports", "require", source)(exports, name => ["react", "react/jsx-runtime"].includes(name) ? require(name) : (name === "next/server" ? { connection: async () => {} } : dependencies[name]) ?? (name === "next/navigation" ? { notFound: () => { throw new Error("Not found") } } : leaf))
  return query => {
    const shell = exports.default({ params: Promise.resolve(params), searchParams: Promise.resolve(query) })
    return shell.props.children.type(shell.props.children.props)
  }
}
function reportFixture({ savedProject = "project", snapshotProject = "project", permitted = true, missingProject = false } = {}) {
  const saved = deferred(), reads = []
  const definition = { slug: "activity", scopes: ["project"] }
  const content = load("reports/[slug]", {
    "@/app/(app)/projects/[id]/actions": { getProjectAction: async () => missingProject ? null : { id: "project", name: "Fixture" } },
    "@/lib/reports/registry": { getReportDefinition: () => definition },
    "@/lib/services/report-catalog": { resolveProjectReportScope: async () => ({ context: { projectId: "project" } }), canRunReport: () => permitted },
    "@/lib/reports/params": { parseReportParams: (_definition, query) => query },
    "@/lib/services/report-configs": { getSavedReportConfig: id => { reads.push(["config", id]); return saved.promise } },
    "@/lib/services/report-runs": { getReportRun: async id => { reads.push(["snapshot", id]); return { slug: "activity", projectId: snapshotProject, snapshot: { frozen: true }, params: { date: "frozen-date" } } } },
    "@/lib/services/report-workspace": { evaluateReport: async (_definition, context) => { reads.push(["evaluate", context]); return { base: { fresh: true }, context } } },
  }, { id: "project", slug: "activity" })
  return { content, reads, release: () => saved.resolve({ slug: "activity", project_id: savedProject, params: { date: "saved-date" }, division_id: null, community_id: null }) }
}
test("snapshot reads begin while saved report configuration is pending and frozen results do not reevaluate", async () => {
  const f = reportFixture()
  const resultPromise = f.content({ config: "saved", run: "snapshot" })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.reads, [["config", "saved"], ["snapshot", "snapshot"]])
  f.release()
  const view = (await resultPromise).props.children.props.children
  assert.deepEqual(view.props.result, { frozen: true })
  assert.deepEqual(view.props.params, { date: "frozen-date" })
  assert.equal(f.reads.some(read => read[0] === "evaluate"), false)
})
test("cross-project report configurations and snapshots are rejected before evaluation", async () => {
  for (const options of [{ savedProject: "other" }, { snapshotProject: "other" }]) {
    const f = reportFixture(options), resultPromise = f.content({ config: "saved", run: "snapshot" })
    f.release()
    await assert.rejects(resultPromise, /Not found/)
    assert.equal(f.reads.some(read => read[0] === "evaluate"), false)
  }
})
test("missing projects and denied live-report access start no artifact or report reads", async () => {
  for (const options of [{ missingProject: true }, { permitted: false }]) {
    const f = reportFixture(options)
    await assert.rejects(f.content({}), /Not found/)
    assert.deepEqual(f.reads, [])
  }
})
test("live reports preserve their URL parameters and evaluate once", async () => {
  const f = reportFixture()
  const view = (await f.content({ date: "live-date" })).props.children.props.children
  assert.deepEqual(view.props.result, { fresh: true })
  assert.deepEqual(view.props.params, { date: "live-date" })
  assert.equal(f.reads.length, 1)
})
test("bid-package detail reads require a valid project or its linked prospect", async () => {
  for (const [bidPackage, allowed] of [[null, false], [{ id: "package", project_id: "other" }, false], [{ id: "package", project_id: "project" }, true], [{ id: "package", project_id: null, prospect_id: "prospect" }, true]]) {
    const reads = []
    const actions = new Proxy({ getBidPackageAction: async () => bidPackage }, { get: (object, name) => object[name] ?? (async id => { reads.push([name, id]); return [] }) })
    const content = load("bids/[packageId]", {
      "../../actions": { getProjectAction: async () => ({ id: "project", name: "Fixture", prospect_id: "prospect" }), getOrgCompaniesAction: async () => [] },
      "@/app/(app)/bids/actions": actions,
    }, { id: "project", packageId: "package" })
    if (!allowed) { await assert.rejects(content({}), /Not found/); assert.deepEqual(reads, []) }
    else { const client = (await content({})).props.children; assert.equal(client.props.bidPackage.id, "package"); assert.equal(reads.length, 8) }
  }
})
