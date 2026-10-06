const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")

function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function fixture() {
  const ambient = deferred(), configs = deferred(), fingerprint = deferred(), reads = [], exports = {}
  const dependencies = {
    "@/lib/services/desk-context": { getAmbientDeskContext: () => { reads.push("ambient"); return ambient.promise } },
    "@/lib/services/report-configs": { listSavedReportConfigs: () => { reads.push("configs"); return configs.promise } },
    "@/app/(app)/reports/actions": { reportFingerprint: result => { reads.push(["fingerprint", result]); return fingerprint.promise } },
    "@/components/reports/report-workspace": { ReportWorkspace: () => null },
  }
  const source = ts.transpileModule(fs.readFileSync("components/reports/report-view.tsx", "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  new Function("exports", "require", source)(exports, name => name === "react/jsx-runtime" ? require(name) : dependencies[name])
  return { render: exports.ReportView, reads, ambient, configs, fingerprint, release: () => {
    ambient.resolve({ divisions: [{ id: "division", name: "Division" }], communities: [{ id: "community", name: "Community" }] })
    configs.resolve([{ id: "saved", name: "Saved report", slug: "activity" }, { id: "packet", name: "Packet", slug: "report-packet" }])
    fingerprint.resolve("fresh-fingerprint")
  } }
}
const props = { definition: { slug: "report-packet", title: "Packet", params: [] }, context: { scope: "project", projectId: "project-one" }, params: { date: "2026-10-03" }, result: { tables: [] } }

test("report view starts desk, packet configuration and fingerprint reads together", async () => {
  const f = fixture(), result = f.render(props)
  assert.deepEqual(f.reads, ["ambient", "configs", ["fingerprint", props.result]])
  f.release()
  const workspace = await result
  assert.equal(workspace.props.base, props.result)
  assert.equal(workspace.props.fingerprint, "fresh-fingerprint")
  assert.deepEqual(workspace.props.packetReports, [{ id: "saved", name: "Saved report" }])
  assert.deepEqual(workspace.props.lenses.divisions, [{ id: "division", name: "Division" }])
})

test("report workspace identity changes across project and ambient scopes, configurations and snapshots", async () => {
  const f = fixture()
  f.release()
  const original = await f.render(props)
  for (const change of [
    { context: { scope: "project", projectId: "project-two" } },
    { context: { scope: "org" } },
    { context: { ...props.context, divisionId: "division" } },
    { context: { ...props.context, communityId: "community" } },
    { saved: { id: "saved", name: "Saved", owned: true } },
    { snapshot: { id: "snapshot" } },
    { params: { date: "2026-10-04" } },
  ]) assert.notEqual((await f.render({ ...props, ...change })).key, original.key)
  assert.equal((await f.render({ ...props, context: { ...props.context }, params: { ...props.params } })).key, original.key)
})

test("frozen packets and ordinary reports do not load editable packet configurations", async () => {
  for (const change of [{ snapshot: { id: "snapshot" } }, { definition: { slug: "activity", title: "Activity", params: [] } }]) {
    const f = fixture(), result = f.render({ ...props, ...change })
    assert.equal(f.reads.includes("configs"), false)
    f.release()
    assert.deepEqual((await result).props.packetReports, [])
  }
})
