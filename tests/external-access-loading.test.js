const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
const React = require("react")
const { redirect } = require("next/navigation")

function load(connection, workspace) {
  const exports = {}, calls = []
  const code = ts.transpileModule(fs.readFileSync("app/access/page.tsx", "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const modules = {
    "next/server": { connection: () => { calls.push("live"); return connection() } },
    "next/navigation": { redirect },
    "@/lib/services/external-portal-auth": { getExternalPortalWorkspaceContext: async () => { calls.push("workspace"); return workspace } },
  }
  new Function("exports", "require", code)(exports, name => ["react", "react/jsx-runtime"].includes(name) ? require(name) : modules[name] ?? new Proxy({}, { get: () => () => { throw Error(`Unexpected call: ${name}`) } }))
  return { ...exports, calls }
}
function elements(element) {
  return React.isValidElement(element) ? [element, ...React.Children.toArray(element.props.children).flatMap(elements)] : []
}
function render(page) {
  const shell = page.default()
  assert.equal(shell.type, React.Suspense)
  return shell.props.children.type(shell.props.children.props)
}

test("external access publishes its instant shell without reading the session during prefetch", async () => {
  let reject
  const live = new Promise((_, fail) => { reject = fail })
  const page = load(() => live, null), shell = page.default()
  assert.equal(page.instant, true)
  assert.equal(shell.type, React.Suspense)
  assert.equal(elements(shell.props.fallback).find(element => element.type === "h1").props.children, "Opening your workspace")
  assert.deepEqual(page.calls, [])
  const failure = Error("Interrupted prefetch"), result = render(page)
  const rejected = assert.rejects(result, error => error === failure)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(page.calls, ["live"])
  reject(failure)
  await rejected
  assert.deepEqual(page.calls, ["live"])
})

test("external access redirects an absent session to sign in after the live boundary", async () => {
  const page = load(async () => {}, null)
  await assert.rejects(render(page), error => error.digest === "NEXT_REDIRECT;replace;/auth/signin;307;")
  assert.deepEqual(page.calls, ["live", "workspace"])
})

test("external access chooses the most recently visited portal without changing the service result", async () => {
  const items = [
    { href: "/s/never-visited", last_accessed_at: null },
    { href: "/p/older", last_accessed_at: "2026-10-01T12:00:00Z" },
    { href: "/s/latest", last_accessed_at: "2026-10-03T12:00:00Z" },
  ]
  const page = load(async () => {}, { items })
  await assert.rejects(render(page), error => error.digest === "NEXT_REDIRECT;replace;/s/latest;307;")
  assert.deepEqual(items.map(item => item.href), ["/s/never-visited", "/p/older", "/s/latest"])
})

test("external accounts with no workspaces retain their identity and account controls", async () => {
  for (const full_name of ["Fixture person", ""]) {
    const page = load(async () => {}, { items: [], identity: { full_name, email: "fixture@example.test" } })
    const result = await render(page), nodes = elements(result)
    assert.equal(nodes.find(element => element.type === "h1").props.children, "No active workspaces")
    assert.ok(nodes.some(element => React.Children.toArray(element.props.children).includes(full_name || "fixture@example.test")))
    assert.ok(nodes.some(element => element.props.href === "/auth/signin"))
    assert.deepEqual(page.metadata.robots, { index: false, follow: false })
  }
})
