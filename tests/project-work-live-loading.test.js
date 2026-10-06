const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
const React = require("react")
const sections = [["bids", "Bids"], ["bids/[packageId]", "Bid package"], ["closeout", "Closeout"], ["closing", "Closing"], ["signatures", "Project Signatures"], ["reports", "Reports"], ["reports/[slug]", "Report"], ["reports/forecast-history", "Forecast History"], ["change-orders", "Change Orders"], ["time/certified-payroll", "Certified payroll"], ["rfis", "RFIs"], ["submittals", "Submittals"], ["daily-logs", "Daily Logs"], ["photos", "Photos"], ["schedule", "Schedule"], ["punch", "Punch"], ["meetings", "Meeting Minutes"], ["safety", "Safety"], ["inspections", "Inspections"], ["decisions", "Decisions"], ["selections", "Selections"], ["expenses", "Expenses"], ["time", "Time"], ["warranty", "Warranty"], ["specs", "Specifications"], ["transmittals", "Transmittals"]]
function elements(element) {
  if (!React.isValidElement(element)) return []
  return [element, ...React.Children.toArray(element.props.children).flatMap(elements), ...elements(element.props.fallback)]
}
for (const [section, title] of sections) {
  test(`project ${title} exposes its shell before parameters and live reads`, async () => {
    let reject
    const calls = [], live = new Promise((_, fail) => { reject = fail }), exports = {}
    const code = ts.transpileModule(fs.readFileSync(`app/(app)/projects/[id]/${section}/page.tsx`, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
    const leaves = new Proxy({}, { get: (_, key) => () => { calls.push(key); throw Error(`Unexpected ${key}`) } })
    new Function("exports", "require", code)(exports, name => ["react", "react/jsx-runtime"].includes(name) ? require(name) : name === "next/server" ? { connection: () => { calls.push("live"); return live } } : leaves)
    const unread = { then() { calls.push("parameter"); throw Error("Unexpected parameter read") } }
    const shell = exports.default({ params: unread, searchParams: unread }), tree = elements(shell)
    assert.ok(tree.some(element => element.props.title === title), `Missing ${title} shell`)
    const suspense = tree.find(element => element.type === React.Suspense)
    assert.ok(suspense)
    assert.deepEqual(calls, [])
    const content = suspense.props.children, result = content.type(content.props), failure = Error("Aborted prefetch")
    const rejected = assert.rejects(result, error => error === failure)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(calls, ["live"])
    reject(failure); await rejected
    assert.deepEqual(calls, ["live"])
  })
}
