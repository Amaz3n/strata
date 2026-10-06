const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
const React = require("react")

const cases = [
  ["warranty/page.tsx", null, "Warranty"],
  ["takeoff/page.tsx", null, "Takeoff"],
  ["imports/page.tsx", null, "Data imports"],
  ["starts/page.tsx", null, "Start gate settings"],
  ["cost-coding/page.tsx", "CostCodesSection", "Cost codes"],
  ["cost-coding/billing-rates-section.tsx", "BillingRatesSection", "Billing rates"],
  ["cost-coding/markup-rules-section.tsx", "MarkupRulesSection", "Markup rules"],
]

for (const [path, name, title] of cases) {
  test(`${title} defers settings, permission and roster reads until request time`, async () => {
    let reject
    const live = new Promise((_, fail) => { reject = fail })
    const calls = [], exports = {}
    const modules = { "next/server": { connection: () => { calls.push("live"); return live } } }
    const leaves = new Proxy({}, { get: (_, key) => (...args) => { calls.push([key, args]); return null } })
    let source = fs.readFileSync(`app/(app)/settings/${path}`, "utf8")
    if (name === "CostCodesSection") source += "\nexport { CostCodesSection }\n"
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
    new Function("exports", "require", code)(exports, moduleName => ["react", "react/jsx-runtime"].includes(moduleName) ? require(moduleName) : modules[moduleName] ?? leaves)
    let result
    if (name) result = exports[name]()
    else {
      const shell = exports.default()
      assert.equal(shell.type, React.Suspense)
      assert.equal(shell.props.fallback.props.title, title)
      assert.deepEqual(calls, [], "rendering the destination shell starts no live reads")
      result = shell.props.children.type(shell.props.children.props)
    }
    const failure = new Error("Request aborted"), rejected = assert.rejects(result, error => error === failure)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(calls, ["live"])
    reject(failure); await rejected
    assert.deepEqual(calls, ["live"], "an aborted request does not start settings or permission work")
  })
}
