const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
const React = require("react")

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function fixture({ denied = false } = {}) {
  const reads = []
  const bugs = deferred(), owners = deferred(), events = deferred()
  const services = {
    requirePlatformBugOwner: async () => { if (denied) throw new Error("Denied") },
    listPlatformBugs: () => { reads.push("bugs"); return bugs.promise },
    listPlatformBugOwners: () => { reads.push("owners"); return owners.promise },
    listPlatformBugContextOptions: async () => { reads.push("context"); return { orgs: [] } },
    listPlatformBugEvents: ids => { reads.push(["events", ids]); return events.promise },
    listPlatformBugAiReviews: async ids => { reads.push(["reviews", ids]); return ["review"] },
    listPlatformBugAiFixes: async ids => { reads.push(["fixes", ids]); return ["fix"] },
  }
  const exports = {}
  const source = ts.transpileModule(fs.readFileSync("app/(app)/platform/bugs/page.tsx", "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const leaf = new Proxy({}, { get: () => () => null })
  new Function("exports", "require", source)(exports, name => {
    if (["react", "react/jsx-runtime"].includes(name)) return require(name)
    if (name === "next/server") return { connection: async () => {} }
    if (name === "@/lib/services/platform-bugs") return services
    if (name === "next/navigation") return { redirect: path => { throw new Error(`Redirect: ${path}`) } }
    return leaf
  })
  const shell = exports.default()
  return { reads, bugs, owners, events, shell, content: () => shell.props.children.type() }
}

test("issue history starts together without waiting for owner options or activity", async () => {
  const f = fixture()
  const resultPromise = f.content()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.reads, ["bugs", "owners", "context"])
  f.bugs.resolve([{ id: "one" }, { id: "two" }])
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.reads.slice(3), [
    ["events", ["one", "two"]], ["reviews", ["one", "two"]], ["fixes", ["one", "two"]],
  ])
  f.owners.resolve(["owner"])
  f.events.resolve(["event"])
  const result = await resultPromise
  const client = result.props.children.props.children
  assert.deepEqual(client.props.initialEvents, ["event"])
  assert.deepEqual(client.props.initialAiReviews, ["review"])
  assert.deepEqual(client.props.initialAiFixes, ["fix"])
  assert.deepEqual(client.props.owners, ["owner"])
})

test("denied platform access redirects before starting any issue reads", async () => {
  const f = fixture({ denied: true })
  await assert.rejects(f.content(), /Redirect: \/unauthorized/)
  assert.deepEqual(f.reads, [])
})

test("the issues destination title is available before authorization or data resolves", () => {
  const f = fixture()
  assert.equal(f.shell.type, React.Suspense)
  assert.equal(f.shell.props.fallback.props.title, "Platform Issues")
  assert.deepEqual(f.reads, [])
})
