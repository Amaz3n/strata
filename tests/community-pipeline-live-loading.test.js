const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
const React = require("react")
const paths = ["communities/[id]", "communities/[id]/land", "communities/[id]/offering", "communities/[id]/settings", "pipeline/[dealId]/files", "pipeline/[dealId]/plans", "pipeline/[dealId]/quotes/[packageId]", "safety", "directory", "settings"]
function boundary(element) {
  if (!React.isValidElement(element)) return null
  if (element.type === React.Suspense) return element
  for (const child of React.Children.toArray(element.props.children)) { const found = boundary(child); if (found) return found }
}
for (const path of paths) {
  test(`${path} starts no parameter or service work before a live navigation`, async () => {
    let reject
    const calls = [], live = new Promise((_, fail) => { reject = fail }), exports = {}
    const code = ts.transpileModule(fs.readFileSync(`app/(app)/${path}/page.tsx`, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
    const leaves = new Proxy({}, { get: (_, key) => () => { calls.push(key); throw Error(`Unexpected ${key}`) } })
    new Function("exports", "require", code)(exports, name => ["react", "react/jsx-runtime"].includes(name) ? require(name) : name === "next/server" ? { connection: () => { calls.push("live"); return live } } : leaves)
    const unread = { then() { calls.push("parameter"); throw Error("Unexpected parameter read") } }
    let result = exports.default({ params: unread, searchParams: unread })
    if (React.isValidElement(result)) {
      const suspense = boundary(result)
      assert.ok(suspense)
      assert.deepEqual(calls, [])
      const child = suspense.props.children
      result = child.type(child.props)
    } else assert.ok(fs.existsSync(`app/(app)/${path}/loading.tsx`))
    const failure = Error("Aborted prefetch"), rejected = assert.rejects(result, error => error === failure)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(calls, ["live"])
    reject(failure); await rejected
    assert.deepEqual(calls, ["live"])
  })
}
