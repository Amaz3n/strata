const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")

function load(file, modules) {
  const exports = {}
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  new Function("exports", "require", code)(exports, name => {
    if (name === "server-only") return {}
    if (name === "react") return require("react")
    if (modules[name]) return modules[name]
    throw Error(`Unexpected dependency: ${name}`)
  })
  return exports
}

for (const failure of ["permission", "disabled"]) {
  test(`Books workspace stops ${failure} access before creating a financial reader`, async () => {
    const calls = []
    const { getBooksWorkspace } = load("lib/services/books/workspace.ts", {
      "@/lib/services/context": { requireOrgContext: async () => { calls.push("context"); return { orgId:"org",userId:"user",supabase:{} } } },
      "@/lib/services/books/access": { requireBooksAuthorization: async input => { calls.push(["permission",input.permission,input.orgId,input.userId]); if (failure === "permission") throw Error("Forbidden") } },
      "@/lib/services/books/module": { requireBooksWorkspaceEnabled: async orgId => { calls.push(["module",orgId]); throw Error("Books disabled") } },
      "@/lib/supabase/server": { createServiceSupabaseClient: () => { calls.push("financial reader"); throw Error("Unexpected financial reader") } },
      "@/lib/services/permissions": { getUserPermissions: () => { throw Error("Unexpected permission expansion") } },
    })
    await assert.rejects(getBooksWorkspace(), failure === "permission" ? /Forbidden/ : /Books disabled/)
    assert.deepEqual(calls, ["context",["permission","books.read","org","user"],...(failure === "disabled" ? [["module","org"]] : [])])
  })
}

test("Books assets controls deny a disabled workspace before authorizing its UI", async () => {
  const calls = []
  const { getBooksUiAccess } = load("lib/services/books/ui-access.ts", {
    "@/lib/services/context": { requireOrgContext: async () => ({orgId:"org"}) },
    "@/lib/services/books/module": { isBooksWorkspaceEnabled: async orgId => { calls.push(["module",orgId]); return false } },
    "@/lib/services/authorization": { authorize: () => { throw Error("Unexpected authorization") } },
  })
  assert.deepEqual(await getBooksUiAccess(), {read:false,adjust:false,manage:false})
  assert.deepEqual(calls, [["module","org"]])
})
