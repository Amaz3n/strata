const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
const React = require("react")
const sections = [["documents", "Documents"], ["drawings", "Drawings"]]
function elements(element) {
  if (!React.isValidElement(element)) return []
  return [element, ...React.Children.toArray(element.props.children).flatMap(elements), ...elements(element.props.fallback)]
}
for (const [section, title] of sections) {
  test(`project ${title} exposes its shell before parameters and live reads`, async () => {
    let reject
    const calls = [], live = new Promise((_, fail) => { reject = fail }), exports = {}
    const code = ts.transpileModule(fs.readFileSync(`components/${section}/project-${section}-page.tsx`, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
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
