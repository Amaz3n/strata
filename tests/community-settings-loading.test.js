const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
function fixture({ failureAt, failure, delayed = false } = {}) {
  const calls = [], gates = Array.from({ length: 5 }, deferred)
  const data = [{ id: "community" }, [{ id: "division" }], { permissions: ["community.write"] }, [{ id: "assignment" }], [
    { status: "active", user: { id: "one", full_name: "Active member" } },
    { status: "inactive", user: { id: "two", full_name: "Former member" } },
  ]]
  const reader = index => async (...args) => {
    calls.push([index, args])
    if (failureAt === index) throw failure
    return delayed ? gates[index].promise : data[index]
  }
  const modules = {
    "next/navigation": { notFound: () => { throw new Error("404") } },
    "@/lib/services/communities": { getCommunity: reader(0) },
    "@/lib/services/divisions": { listDivisions: reader(1) },
    "@/lib/services/permissions": { getCurrentUserPermissions: reader(2) },
    "@/lib/services/community-assignments": { listCommunityAssignments: reader(3) },
    "@/lib/services/team": { listTeamMembers: reader(4) },
  }
  const code = ts.transpileModule(fs.readFileSync("app/(app)/communities/[id]/settings/page.tsx", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const exports = {}, leaves = new Proxy({}, { get: () => () => null })
  new Function("exports", "require", code)(exports, name => name === "react/jsx-runtime" ? require(name) : (name === "next/server" ? { connection: async () => {} } : modules[name]) ?? leaves)
  return { page: exports.default, calls, gates, data }
}

test("community settings waits for its URL and starts all required reads together", async () => {
  const f = fixture({ delayed: true }), params = deferred()
  const result = f.page({ params: params.promise })
  assert.deepEqual(f.calls, [])
  params.resolve({ id: "community" })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.calls.map(([index]) => index), [0, 1, 2, 3, 4])
  assert.deepEqual(f.calls[0][1], ["community"])
  assert.deepEqual(f.calls[3][1], ["community"])
  assert.deepEqual(f.calls[4][1], [undefined, { includeProjectCounts: false }])
  f.gates.forEach((gate, index) => gate.resolve(f.data[index]))
  const tree = await result
  const [settings, team] = tree.props.children
  assert.equal(settings.props.canWrite, true)
  assert.equal(settings.props.community.id, "community")
  assert.equal(team.props.communityId, "community")
  assert.deepEqual(team.props.assignments, f.data[3])
  assert.deepEqual(team.props.members, [{ id: "one", name: "Active member" }])
})

for (const [index, name] of ["community", "divisions", "permissions", "assignments", "team"].entries()) {
  test(`community settings retains a failed ${name} read instead of rendering missing or empty configuration`, async () => {
    const failure = new Error(`${name} unavailable`)
    const f = fixture({ failureAt: index, failure })
    await assert.rejects(f.page({ params: Promise.resolve({ id: "community" }) }), error => error === failure)
  })
}

test("community settings still returns a 404 for an inaccessible or missing community", async () => {
  const f = fixture({ failureAt: 0, failure: new Error("Community not found") })
  await assert.rejects(f.page({ params: Promise.resolve({ id: "community" }) }), /404/)
})
