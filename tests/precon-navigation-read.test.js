const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
const React = require("react")

const dealId = "00000000-0000-4000-8000-000000000001"
function load(file, modules) {
  const exports = {}
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText
  const leaf = new Proxy({ __esModule: true, default: () => null }, { get: (target, key) => target[key] ?? (() => null) })
  new Function("exports", "require", code)(exports, name =>
    ["react", "react/jsx-runtime", "zod"].includes(name) ? require(name) : modules[name] ?? leaf,
  )
  return exports
}
function fixture({ prospect = { id: dealId, status: "qualified" }, project = { id: "project", phase: "precon" }, deniedOrg = false, deniedProject = false, projectError = null } = {}) {
  const calls = []
  function client(kind) {
    return { from(table) {
      calls.push([kind, "from", table])
      const query = {}
      for (const method of ["select", "eq"]) query[method] = (...args) => { calls.push([kind, method, ...args]); return query }
      query.maybeSingle = async () => ({ data: table === "prospects" ? prospect : project, error: table === "projects" ? projectError : null })
      return query
    } }
  }
  const service = load("lib/services/precon-workspace.ts", {
    "@/lib/services/context": { requireOrgContext: async () => ({ orgId: "org", userId: "user", supabase: client("session") }) },
    "@/lib/services/permissions": { requireAnyPermission: async permissions => { calls.push(["org-permission", permissions]); if (deniedOrg) throw new Error("Forbidden org") } },
    "@/lib/services/authorization": { requireAuthorization: async context => { calls.push(["project-permission", context.permission, context.projectId]); if (deniedProject) throw new Error("Forbidden project") } },
    "@/lib/supabase/server": { createServiceSupabaseClient: () => client("service") },
  })
  return { read: service.getPreconProjectId, calls }
}

test("precon navigation resolves only scoped prospect and project identities", async () => {
  const { read, calls } = fixture()
  assert.equal(await read(dealId), "project")
  assert.deepEqual(calls.filter(call => call[1] === "from"), [["session", "from", "prospects"], ["service", "from", "projects"]])
  for (const expected of [
    ["session", "select", "id, status"], ["session", "eq", "org_id", "org"], ["session", "eq", "id", dealId],
    ["service", "select", "id, phase"], ["service", "eq", "org_id", "org"], ["service", "eq", "prospect_id", dealId],
    ["project-permission", "project.read", "project"],
  ]) assert.ok(calls.some(call => JSON.stringify(call) === JSON.stringify(expected)))
})
test("precon navigation rejects org access before querying and validates project access", async () => {
  const org = fixture({ deniedOrg: true })
  await assert.rejects(org.read(dealId), /Forbidden org/)
  assert.equal(org.calls.some(call => call[1] === "from"), false)
  const project = fixture({ deniedProject: true })
  await assert.rejects(project.read(dealId), /Forbidden project/)
  assert.ok(project.calls.some(call => call[0] === "project-permission"))
})
test("an unlinked deal redirects without treating an inaccessible linked project as unlinked", async () => {
  assert.equal(await fixture({ project: null }).read(dealId), null)
  await assert.rejects(fixture({ deniedProject: true }).read(dealId), /Forbidden project/)
  await assert.rejects(fixture({ projectError: { message: "Database unavailable" } }).read(dealId), /Database unavailable/)
})
test("missing and invalid deal identities cannot resolve a project", async () => {
  await assert.rejects(fixture({ prospect: null }).read(dealId), /Prospect not found/)
  const invalid = fixture()
  await assert.rejects(invalid.read("invalid"))
  assert.equal(invalid.calls.length, 0)
})
for (const section of ["files", "plans"]) {
  test(`deal ${section} preserves the query promise and waits for the authorized project lookup`, async () => {
    let projectId = "project", denied = false, reads = 0
    const route = load(`app/(app)/pipeline/[dealId]/${section}/page.tsx`, {
      "@/lib/services/precon-workspace": { getPreconProjectId: async id => { assert.equal(id, dealId); reads++; if (denied) throw new Error("Forbidden"); return projectId } },
      "next/navigation": { redirect: href => { throw new Error(`Redirect: ${href}`) } },
    }).default
    const searchParams = new Promise(() => {})
    function child() {
      const shell = route({ params: Promise.resolve({ dealId }), searchParams })
      assert.equal(shell.type, React.Suspense)
      return shell.props.children
    }
    const element = child()
    assert.equal(reads, 0, "the shell does not start authorized data reads")
    const result = await element.type(element.props)
    assert.deepEqual(await result.props.params, { id: "project" })
    assert.equal(result.props.prospectId, dealId)
    assert.equal(result.props.searchParams, searchParams, "query resolution remains inside the downstream boundary")
    projectId = null
    const unlinked = child()
    await assert.rejects(unlinked.type(unlinked.props), error => error.message === `Redirect: /pipeline/${dealId}`)
    denied = true
    const forbidden = child()
    await assert.rejects(forbidden.type(forbidden.props), /Forbidden/)
  })
}
