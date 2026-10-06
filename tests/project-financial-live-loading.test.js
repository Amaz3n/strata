const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
const React = require("react")
const sections = [["billing", "Billing"], ["budget", "Budget"], ["cost-inbox", "Cost Inbox"], ["payables", "Payables"], ["inventory", "Inventory accounting"], ["tm-tickets", "T&M Tickets"], ["payables/waivers", "Payables · Waivers"]]
function elements(element) {
  if (!React.isValidElement(element)) return []
  if (typeof element.type === "function" && element.type.name.endsWith("Skeleton")) return elements(element.type(element.props))
  return [element, ...React.Children.toArray(element.props.children).flatMap(elements), ...elements(element.props.fallback)]
}
for (const [section, title] of sections) {
  test(`project ${title} exposes its shell before parameters and live reads`, async () => {
    let reject
    const calls = [], live = new Promise((_, fail) => { reject = fail }), exports = {}
    const code = ts.transpileModule(fs.readFileSync(`app/(app)/projects/[id]/financials/${section}/page.tsx`, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
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

function loadContent(section, props, modules) {
  const exports = {}, code = ts.transpileModule(fs.readFileSync(`app/(app)/projects/[id]/financials/${section}/page.tsx`, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const leaves = new Proxy({}, { get: () => () => { throw Error("Unexpected private read") } })
  new Function("exports", "require", code)(exports, name => ["react", "react/jsx-runtime"].includes(name) ? require(name) : modules[name] ?? leaves)
  const child = exports.default(props).props.children
  return child.type(child.props)
}

test("project inventory denies adjustment access before inventory reads", async () => {
  const calls = [], result = loadContent("inventory", { params: Promise.resolve({ id: "project" }) }, {
    "next/server": { connection: async () => calls.push("live") },
    "next/navigation": { notFound: () => { throw Error("Not found") } },
    "@/lib/services/books/ui-access": { getBooksUiAccess: async () => { calls.push("access"); return { adjust: false } } },
  })
  await assert.rejects(result, /Not found/)
  assert.deepEqual(calls, ["live", "access"])
})

test("project waivers preserve scoped pagination while commitments load independently", async () => {
  let resolveRegister
  const calls = [], commitments = [], register = {}, pending = loadContent("payables/waivers", {
    params: Promise.resolve({ id: "project" }), searchParams: Promise.resolve({ periodEnd: "2026-10-01", page: "2", q: "Fixture search", status: "received" }),
  }, {
    "next/server": { connection: async () => calls.push("live") },
    "@/lib/services/commitments": { listProjectCommitments: async id => { calls.push(["commitments", id]); return commitments } },
    "@/lib/services/waiver-register": { getProjectWaiverRegister: (...args) => { calls.push(["register", ...args]); return new Promise(resolve => { resolveRegister = resolve }) } },
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, ["live", ["register", "project", "2026-10-01", undefined, { page: 2, search: "Fixture search", status: "received" }], ["commitments", "project"]])
  resolveRegister(register)
  const result = await pending
  assert.deepEqual(result.props.children.props, { projectId: "project", register, commitments })
})
