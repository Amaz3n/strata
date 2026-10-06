const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
const React = require("react")
function load(path, modules, calls) {
  const exports = {}, code = ts.transpileModule(fs.readFileSync(path, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const leaves = new Proxy({}, { get: (_, key) => (...args) => { calls.push([key, args]); return null } })
  new Function("exports", "require", code)(exports, name => ["react", "react/jsx-runtime"].includes(name) ? require(name) : modules[name] ?? leaves)
  return exports.default
}
const platform = "app/(app)/platform/page.tsx"
for (const path of [platform, "app/(app)/projects/[id]/correspondence/page.tsx"]) {
  test(`${path} exposes a shell before parameters, access and live reads`, async () => {
    let reject
    const calls = [], live = new Promise((_, fail) => { reject = fail })
    const page = load(path, { "next/server": { connection: () => { calls.push("live"); return live } } }, calls)
    const pending = { then() { calls.push("parameters"); throw Error("Unexpected parameters") } }
    const shell = page({ params: pending, searchParams: pending })
    assert.deepEqual(calls, [])
    const suspense = path === platform ? shell.props.children.props.children : shell
    assert.equal(suspense.type, React.Suspense)
    assert.ok(suspense.props.fallback)
    if (path === platform) assert.equal(shell.props.title, "Platform")
    const content = suspense.props.children, result = content.type(content.props), failure = Error("Aborted prefetch")
    const rejected = assert.rejects(result, error => error === failure)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(calls, ["live"])
    reject(failure); await rejected
    assert.deepEqual(calls, ["live"])
  })
}
test("Platform denial redirects without starting admin statistics", async () => {
  const calls = [], denied = Error("Redirected"), page = load(platform, {
    "next/server": { connection: async () => {} },
    "next/navigation": { redirect: path => { calls.push(["redirect", path]); throw denied } },
    "@/lib/services/platform-access": { getCurrentPlatformAccess: async () => { calls.push("access"); return { canAccessPlatform: false } } },
    "@/lib/services/admin": { getAdminStats: async () => { calls.push("statistics"); return {} } },
  }, calls)
  const content = page().props.children.props.children.props.children
  await assert.rejects(content.type(content.props), error => error === denied)
  assert.deepEqual(calls, ["access", ["redirect", "/unauthorized"]])
})
test("Platform authorized statistics preserve the displayed scope", async () => {
  const calls = [], stats = { totalOrgs: 4, newOrgsThisMonth: 1, activeSubscriptions: 3, trialingSubscriptions: 2 }
  const page = load(platform, {
    "next/server": { connection: async () => {} },
    "@/lib/services/platform-access": { getCurrentPlatformAccess: async () => { calls.push("access"); return { canAccessPlatform: true, roles: ["operator"] } } },
    "@/lib/services/admin": { getAdminStats: async () => { calls.push("statistics"); return stats } },
  }, calls)
  const content = page().props.children.props.children.props.children, client = await content.type(content.props)
  assert.deepEqual(calls, ["access", "statistics"])
  assert.deepEqual(client.props.stats, stats)
  assert.deepEqual(client.props.roles, ["operator"])
})
