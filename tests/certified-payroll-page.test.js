const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
const React = require("react")

function fixture({ publicWork = true, missing = false } = {}) {
  const reads = [], reports = [{ id: "first" }, { id: "second" }]
  const dependencies = {
    "@/app/(app)/projects/[id]/actions": { getProjectAction: async id => missing ? null : ({ id, name: "Fixture project", is_public_work: publicWork }) },
    "@/lib/services/certified-payroll": {
      listWageDeterminations: async id => { reads.push(["determinations", id]); return [] },
      listWageClassifications: async id => { reads.push(["classifications", id]); return [] },
      listPayrollWorkerProfiles: async () => { reads.push(["workers"]); return [] },
      listCertifiedPayrollReports: async id => { reads.push(["reports", id]); return reports },
      getCertifiedPayrollReport: async id => { reads.push(["detail", id]); return { id } },
    },
    "next/navigation": { notFound: () => { throw new Error("Not found") } },
  }
  const exports = {}
  const source = ts.transpileModule(fs.readFileSync("app/(app)/projects/[id]/time/certified-payroll/page.tsx", "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const leaf = new Proxy({}, { get: () => () => null })
  new Function("exports", "require", source)(exports, name =>
    ["react", "react/jsx-runtime"].includes(name) ? require(name) : dependencies[name] ?? leaf,
  )
  function content(query = {}) {
    const shell = exports.default({ params: Promise.resolve({ id: "project" }), searchParams: Promise.resolve(query) })
    assert.equal(shell.type, React.Suspense)
    assert.equal(shell.props.fallback.props.title, "Certified payroll")
    return shell.props.children.type(shell.props.children.props)
  }
  return { content, reads }
}

test("payroll selection uses a report from the current project and keys its review by identity", async () => {
  for (const [report, expected] of [["second", "second"], ["other-project-report", "first"], [undefined, "first"]]) {
    const { content, reads } = fixture()
    const result = await content({ report })
    const client = result.props.children
    assert.equal(client.key, `project:${expected}`)
    assert.equal(client.props.initialSelected.id, expected)
    assert.deepEqual(reads.filter(read => read[0] === "detail"), [["detail", expected]])
    assert.equal(reads.length, 5)
  }
})
test("projects without public work return their setup explanation without payroll queries", async () => {
  const { content, reads } = fixture({ publicWork: false })
  const result = await content()
  assert.equal(result.props.title, "Certified payroll")
  assert.deepEqual(reads, [])
})
test("a missing project does not start payroll queries", async () => {
  const { content, reads } = fixture({ missing: true })
  await assert.rejects(content(), /Not found/)
  assert.deepEqual(reads, [])
})
