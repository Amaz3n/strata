const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
function deferred() { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
function fixture({ optionalFailure = false } = {}) {
  const live = deferred(), context = deferred(), divisions = deferred(), calls = []
  const modules = {
    "next/server": { connection: () => { calls.push("live"); return live.promise } },
    "@/lib/services/desk-context": { getAmbientDeskContext: () => { calls.push("context"); return context.promise } },
    "@/lib/services/divisions": { listDivisions: () => { calls.push("divisions"); return optionalFailure ? Promise.reject(Error("Division unavailable")) : divisions.promise } },
    "@/lib/services/permissions": { getCurrentUserPermissions: async () => { calls.push("permissions"); return { permissions: ["community.write"] } } },
    "@/lib/services/community-portfolio": { getCommunityPortfolio: async scope => { calls.push(["portfolio", scope]); return { communities: ["fixture"] } } },
  }
  const exports = {}, code = ts.transpileModule(fs.readFileSync("app/(app)/communities/page.tsx", "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  new Function("exports", "require", code)(exports, name => ["react", "react/jsx-runtime"].includes(name) ? require(name) : modules[name] ?? new Proxy({}, { get: () => () => null }))
  const shell = exports.default({ searchParams: Promise.resolve({ status: "active" }) }), content = shell.props.children.props.children
  return { live, context, divisions, calls, shell, run: () => content.type(content.props) }
}
test("Communities shell precedes live context, roster and permission reads", async () => {
  const f = fixture()
  assert.equal(f.shell.props.title, "Communities")
  assert.deepEqual(f.calls, [])
  const result = f.run(), failure = Error("Aborted prefetch"), rejected = assert.rejects(result, error => error === failure)
  assert.deepEqual(f.calls, ["live"])
  f.live.reject(failure); await rejected
  assert.deepEqual(f.calls, ["live"])
})
test("division and permission reads overlap desk context; scoped portfolio does not wait for roster", async () => {
  const f = fixture(), result = f.run()
  f.live.resolve(); await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.calls, ["live", "context", "divisions", "permissions"])
  f.context.resolve({ divisionId: "division" }); await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.calls.at(-1), ["portfolio", { divisionId: "division", status: "active" }])
  f.divisions.resolve(["roster"])
  const client = await result
  assert.deepEqual(client.props.portfolio, { communities: ["fixture"] })
  assert.deepEqual(client.props.divisions, ["roster"])
  assert.equal(client.props.canWrite, true)
  assert.equal(client.props.status, "active")
})
test("optional division failure preserves portfolio and management permission", async () => {
  const f = fixture({ optionalFailure: true }), result = f.run()
  f.live.resolve(); f.context.resolve({ divisionId: null })
  const client = await result
  assert.deepEqual(client.props.divisions, [])
  assert.equal(client.props.canWrite, true)
  assert.deepEqual(f.calls.at(-1), ["portfolio", { divisionId: null, status: "active" }])
})
test("failed desk context never starts a portfolio query", async () => {
  const f = fixture(), result = f.run(), failure = Error("Context unavailable")
  const rejected = assert.rejects(result, error => error === failure)
  f.live.resolve(); await new Promise(resolve => setImmediate(resolve))
  f.context.reject(failure); await rejected
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === "portfolio"), false)
  f.divisions.resolve([])
})
